import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import {
  runNativeStructuralBeam,
  type NativeStructuralParent,
  type NativeStructuralProposal,
} from './native-structural-beam';
import { renderForTarget, renderGroup } from './quadrature-refit';
import {
  createResidualStructuralProposer,
  createResidualStructuralProposerSession,
  DEFAULT_RESIDUAL_STRUCTURAL_SHAPE_VARIANTS,
  type ResidualStructuralProposerOptions,
  type ResidualStructuralProposerSession,
  type ResidualStructuralProposerSnapshot,
  type ResidualStructuralShapeVariant,
  type ResidualStructuralWorkBreakdown,
} from './residual-structural-proposer';
import {
  patchFromStructuralCandidate,
  type StructuralAtomShape,
} from './structural-atom';

type Group = ArgCreateSynth['oscillators'][number];

const TWO_PI = 2 * Math.PI;
const SCALE = MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
const BASE_VARIANT: ResidualStructuralShapeVariant = {
  freqStartRatio: 1,
  oscDuration: 0.018,
  oscSlope: 0.8,
  ampDuration: 0.04,
  ampEndLevel: 0.02,
  ampSlope: 1.1,
  delaySamples: 0,
  attackSamples: 0,
  hardStop: false,
};

/** Создаёт полный on/off group без optional-полей. */
function group(frequency: number, level: number, on = true): Group {
  return {
    osc: {
      on,
      freqBase: frequency,
      freqStart: frequency,
      duration: 0.018,
      slope: 1,
      phase: 0.3,
    },
    ampEnv: {
      startLevel: level,
      endLevel: 0.02,
      duration: 0.08,
      slope: 1.1,
    },
  };
}

/** Строит canonical parent; proposer не использует его metrics. */
function parentFor(
  patch: ArgCreateSynth,
  sampleCount: number,
  phaseModel: PhaseModel = 'legacy',
): NativeStructuralParent {
  const samples = renderForTarget(patch, sampleCount, phaseModel);
  const contributions = patch.oscillators.map((oscillator) =>
    oscillator.osc.on
      ? renderGroup(oscillator, sampleCount, phaseModel)
      : null,
  );
  const rawSum = new Float64Array(sampleCount);
  for (const contribution of contributions) {
    if (contribution === null) {
      continue;
    }
    for (let index = 0; index < sampleCount; index += 1) {
      rawSum[index] =
        (rawSum[index] ?? 0) + (contribution[index] ?? 0);
    }
  }
  return {
    patch,
    samples,
    metrics: {
      globalSuppressionPercent: 0,
      windowedSuppressionPercent: 0,
    },
    rawSum,
    contributions,
    evaluation: null,
    depth: 0,
    nodeKey: 'residual-test-parent',
    candidateKey: null,
  };
}

/** Создаёт canonical silent parent с append slot 0. */
function silentParent(sampleCount: number): NativeStructuralParent {
  return parentFor({ oscillators: [] }, sampleCount);
}

/** Синтезирует integer PCM известных тонов без Math.random. */
function knownTones(
  sampleCount: number,
  tones: readonly {
    frequency: number;
    level: number;
    phase?: number;
  }[],
): Int16Array {
  return Int16Array.from({ length: sampleCount }, (_, index) => {
    let value = 0;
    for (const tone of tones) {
      value +=
        tone.level *
        Math.sin(
          (TWO_PI * tone.frequency * index) / SAMPLE_RATE +
            (tone.phase ?? 0),
        );
    }
    return Math.round(value);
  });
}

/** Добавляет known residual к canonical parent PCM с одним Int16 quantization. */
function targetWithResidual(
  parent: NativeStructuralParent,
  tones: readonly {
    frequency: number;
    level: number;
    phase?: number;
  }[],
): Int16Array {
  const addition = knownTones(parent.samples.length, tones);
  return Int16Array.from(parent.samples, (value, index) =>
    Math.max(-32768, Math.min(32767, value + (addition[index] ?? 0))),
  );
}

/** Возвращает полную known-answer форму с независимыми полями по индексу. */
function knownShape(index: number): StructuralAtomShape {
  const frequency = 60 + index * 131;
  return {
    freqBase: frequency,
    freqStart: frequency * (index % 2 === 0 ? 1 : 1.04),
    oscDuration: 0.012 + index * 0.0002,
    oscSlope: 0.6 + (index % 4) * 0.2,
    ampDuration: 0.035 + index * 0.0003,
    ampEndLevel: 0.01 + (index % 3) * 0.005,
    ampSlope: 0.7 + (index % 5) * 0.15,
    delaySamples: index % 7,
    attackSamples: index % 3,
    hardStop: index % 2 === 0,
  };
}

/** Проверяет, что cumulative total не скрывает ни одну категорию. */
function assertLedgerSum(
  snapshot: ResidualStructuralProposerSnapshot,
): void {
  const categories: Exclude<
    keyof ResidualStructuralWorkBreakdown,
    'total'
  >[] = ['residual', 'window', 'fft', 'peaks', 'shapes', 'slots'];
  const sum = categories.reduce(
    (total, category) => total + snapshot.categories[category],
    0,
  );
  assert.equal(snapshot.categories.total, sum);
  assert.equal(snapshot.cost, sum);
}

/** Общие опции одного полного окна с одной формой для коротких тестов. */
function singleWindowOptions(
  target: Int16Array,
  start = 0,
  end = target.length,
): ResidualStructuralProposerOptions {
  return {
    target,
    usefulZone: { start: 0, end: target.length },
    windows: [{ name: 'explicit', start, end }],
    maxPeaksPerWindow: 4,
    relativePeakThreshold: 0,
    shapeVariants: [BASE_VARIANT],
    weakActiveSlotCount: 0,
  };
}

/** Создаёт небольшой валидный вход для изолированной проверки опций. */
function validOptions(): ResidualStructuralProposerOptions {
  return singleWindowOptions(new Int16Array(64));
}

/** Меняет только проверяемую опцию и сохраняет остальной вход валидным. */
function withOptions(
  changes: Partial<ResidualStructuralProposerOptions>,
): ResidualStructuralProposerOptions {
  return { ...validOptions(), ...changes };
}

/** Требует отказа в normalizeOptions, до создания session и её ledger. */
function assertOptionsFailBeforeSession(
  options: ResidualStructuralProposerOptions,
  message: RegExp,
): void {
  let partialSession: ResidualStructuralProposerSession | null = null;
  assert.throws(() => {
    partialSession = createResidualStructuralProposerSession(options);
  }, message);
  assert.equal(partialSession, null);
}

test('option validation rejects invalid PCM, sample rate and phase before analysis', () => {
  const cases: [ResidualStructuralProposerOptions, RegExp][] = [
    [withOptions({ target: [] }), /must not be empty/],
    [withOptions({ target: [0, 1.5] }), /Int16 PCM/],
    [withOptions({ target: [32768] }), /Int16 PCM/],
    [withOptions({ target: [-32769] }), /Int16 PCM/],
    [withOptions({ sampleRate: 48000 }), /sample rate/],
    [withOptions({ sampleRate: Number.NaN }), /sample rate/],
    [
      withOptions({ phaseModel: 'invalid' as PhaseModel }),
      /phase model/,
    ],
  ];
  for (const [options, message] of cases) {
    assertOptionsFailBeforeSession(options, message);
  }
});

test('option validation rejects invalid zones, windows and frequency ranges', () => {
  const cases: [ResidualStructuralProposerOptions, RegExp][] = [
    [
      withOptions({ usefulZone: { start: 40, end: 20 } }),
      /must not precede/,
    ],
    [
      withOptions({ usefulZone: { start: 0, end: 65 } }),
      /usefulZone.end/,
    ],
    [
      withOptions({
        windows: [{ name: '', start: 0, end: 64 }],
      }),
      /window name/,
    ],
    [
      withOptions({
        windows: [{ name: 'bad', start: -1, end: 64 }],
      }),
      /window.start/,
    ],
    [
      withOptions({
        windows: [{ name: 'bad', start: 0, end: 65 }],
      }),
      /window.end/,
    ],
    [
      withOptions({
        windows: [{ name: 'bad', start: 10, end: 10 }],
      }),
      /must follow start/,
    ],
    [withOptions({ minFrequency: 19 }), /minFrequency/],
    [withOptions({ maxFrequency: 16001 }), /maxFrequency/],
    [
      withOptions({ minFrequency: 1000, maxFrequency: 999 }),
      /must not be below/,
    ],
    [withOptions({ minFrequency: Number.NaN }), /minFrequency/],
  ];
  for (const [options, message] of cases) {
    assertOptionsFailBeforeSession(options, message);
  }
});

test('option validation rejects invalid peak and group limits before analysis', () => {
  const cases: [ResidualStructuralProposerOptions, RegExp][] = [
    [withOptions({ maxPeaksPerWindow: 0 }), /maxPeaksPerWindow/],
    [withOptions({ maxPeaksPerWindow: 1.5 }), /maxPeaksPerWindow/],
    [withOptions({ maxPeaksPerWindow: 51 }), /maxPeaksPerWindow/],
    [
      withOptions({ relativePeakThreshold: -0.01 }),
      /relativePeakThreshold/,
    ],
    [
      withOptions({ relativePeakThreshold: 1.01 }),
      /relativePeakThreshold/,
    ],
    [
      withOptions({ relativePeakThreshold: Number.NaN }),
      /relativePeakThreshold/,
    ],
    [withOptions({ maxGroupSize: 0 }), /maxGroupSize/],
    [withOptions({ maxGroupSize: 51 }), /maxGroupSize/],
    [withOptions({ maxGroupSize: 1.5 }), /maxGroupSize/],
    [withOptions({ weakActiveSlotCount: -1 }), /weakActiveSlotCount/],
    [withOptions({ weakActiveSlotCount: 51 }), /weakActiveSlotCount/],
    [
      withOptions({ weakActiveSlotCount: 1.5 }),
      /weakActiveSlotCount/,
    ],
  ];
  for (const [options, message] of cases) {
    assertOptionsFailBeforeSession(options, message);
  }
});

test('option validation covers every structural shape variant field', () => {
  const cases: {
    field: string;
    variant: ResidualStructuralShapeVariant;
  }[] = [
    {
      field: 'freqStartRatio',
      variant: { ...BASE_VARIANT, freqStartRatio: 0 },
    },
    {
      field: 'freqStartRatio',
      variant: { ...BASE_VARIANT, freqStartRatio: Infinity },
    },
    {
      field: 'oscDuration',
      variant: { ...BASE_VARIANT, oscDuration: 0 },
    },
    {
      field: 'oscDuration',
      variant: { ...BASE_VARIANT, oscDuration: 0.51 },
    },
    {
      field: 'oscSlope',
      variant: { ...BASE_VARIANT, oscSlope: 0.1 },
    },
    {
      field: 'oscSlope',
      variant: { ...BASE_VARIANT, oscSlope: 2.1 },
    },
    {
      field: 'ampDuration',
      variant: { ...BASE_VARIANT, ampDuration: 0 },
    },
    {
      field: 'ampDuration',
      variant: { ...BASE_VARIANT, ampDuration: 0.51 },
    },
    {
      field: 'ampEndLevel',
      variant: { ...BASE_VARIANT, ampEndLevel: 0 },
    },
    {
      field: 'ampEndLevel',
      variant: { ...BASE_VARIANT, ampEndLevel: 1.1 },
    },
    {
      field: 'ampSlope',
      variant: { ...BASE_VARIANT, ampSlope: 0.1 },
    },
    {
      field: 'ampSlope',
      variant: { ...BASE_VARIANT, ampSlope: Number.NaN },
    },
    {
      field: 'delaySamples',
      variant: { ...BASE_VARIANT, delaySamples: -1 },
    },
    {
      field: 'delaySamples',
      variant: { ...BASE_VARIANT, delaySamples: 0.5 },
    },
    {
      field: 'delaySamples',
      variant: {
        ...BASE_VARIANT,
        delaySamples: 0.5 * SAMPLE_RATE + 1,
      },
    },
    {
      field: 'attackSamples',
      variant: { ...BASE_VARIANT, attackSamples: -1 },
    },
    {
      field: 'attackSamples',
      variant: { ...BASE_VARIANT, attackSamples: 0.5 },
    },
    {
      field: 'attackSamples',
      variant: {
        ...BASE_VARIANT,
        attackSamples: 0.5 * SAMPLE_RATE + 1,
      },
    },
    {
      field: 'hardStop',
      variant: {
        ...BASE_VARIANT,
        hardStop: 1 as unknown as boolean,
      },
    },
  ];
  for (const entry of cases) {
    assertOptionsFailBeforeSession(
      withOptions({ shapeVariants: [entry.variant] }),
      new RegExp(entry.field),
    );
  }
});

test('valid session setup performs no unreported proposer analysis', () => {
  const session =
    createResidualStructuralProposerSession(validOptions());
  assert.deepEqual(session.snapshot(), {
    calls: 0,
    cost: 0,
    categories: {
      residual: 0,
      window: 0,
      fft: 0,
      peaks: 0,
      shapes: 0,
      slots: 0,
      total: 0,
    },
  });
});

test('residual FFT proposes close and high known tones, not only the low peak', () => {
  const sampleCount = 16384;
  const binWidth = SAMPLE_RATE / sampleCount;
  const expected = [40 * binWidth, 44 * binWidth, 5000 * binWidth];
  const target = knownTones(sampleCount, [
    { frequency: expected[0] ?? 0, level: 1200, phase: 0.2 },
    { frequency: expected[1] ?? 0, level: 900, phase: 1.1 },
    { frequency: expected[2] ?? 0, level: 1000, phase: 0.7 },
  ]);
  const session = createResidualStructuralProposerSession({
    ...singleWindowOptions(target),
    maxPeaksPerWindow: 4,
  });
  const result = session.propose(silentParent(sampleCount));
  assert.ok(!Array.isArray(result));
  if (Array.isArray(result)) {
    return;
  }
  const frequencies = result.candidates.map(
    (proposal) => proposal.shapes[0]?.freqBase ?? 0,
  );
  for (const frequency of expected) {
    assert.ok(
      frequencies.some(
        (candidate) => Math.abs(candidate - frequency) <= binWidth,
      ),
      `missing ${frequency} Hz in ${frequencies.join(', ')}`,
    );
  }
  assert.ok(frequencies.some((frequency) => frequency > 10000));
  assert.ok(result.cost > 0);
  assert.ok(
    session.estimateExpansion(silentParent(sampleCount)) >=
      result.cost,
  );
  assertLedgerSum(session.snapshot());
});

test('windows and variants create independent onset/durations and automatic groups', () => {
  const sampleCount = 8192;
  const patch: ArgCreateSynth = {
    oscillators: [
      group(53, 0.12),
      group(173, 0.002),
      group(307, 0.07),
    ],
  };
  const baseParent = parentFor(patch, sampleCount);
  const target = targetWithResidual(baseParent, [
    { frequency: 431, level: 800, phase: 0.2 },
    { frequency: 977, level: 700, phase: 0.5 },
    { frequency: 12003, level: 650, phase: 1.2 },
  ]);
  const parent = parentFor(patch, sampleCount);
  const session = createResidualStructuralProposerSession({
    target,
    usefulZone: { start: 0, end: sampleCount },
    windows: [
      { name: 'aligned', start: 0, end: 4096 },
      { name: 'shifted', start: 37, end: sampleCount },
    ],
    maxPeaksPerWindow: 3,
    relativePeakThreshold: 0,
    shapeVariants: DEFAULT_RESIDUAL_STRUCTURAL_SHAPE_VARIANTS,
    weakActiveSlotCount: 2,
  });
  const result = session.propose(parent);
  assert.ok(!Array.isArray(result));
  if (Array.isArray(result)) {
    return;
  }
  const shapes = result.candidates.flatMap((proposal) => [
    ...proposal.shapes,
  ]);
  assert.ok(
    new Set(shapes.map((shape) => shape.ampDuration)).size > 1,
  );
  assert.ok(new Set(shapes.map((shape) => shape.ampSlope)).size > 1);
  assert.ok(shapes.some((shape) => shape.delaySamples === 0));
  assert.ok(shapes.some((shape) => shape.delaySamples >= 37));
  const triple = result.candidates.find(
    (proposal) => proposal.shapes.length === 3,
  );
  assert.ok(triple !== undefined);
  assert.equal(
    new Set(triple.shapes.map((shape) => shape.delaySamples)).size,
    3,
  );
  assert.equal(
    new Set(triple.shapes.map((shape) => shape.ampDuration)).size,
    3,
  );
  assert.equal(new Set(triple.slots).size, triple.slots.length);
  const snapshot = session.snapshot();
  for (const category of [
    'residual',
    'window',
    'fft',
    'peaks',
    'shapes',
    'slots',
  ] as const) {
    assert.ok(snapshot.categories[category] > 0, category);
  }
  assertLedgerSum(snapshot);
});

test('injected K=20 remains a group and is not rejected by automatic group settings', () => {
  const sampleCount = 256;
  const proposal: NativeStructuralProposal = {
    slots: Array.from({ length: 20 }, (_, index) => index),
    shapes: Array.from({ length: 20 }, (_, index) =>
      knownShape(index),
    ),
  };
  const session = createResidualStructuralProposerSession({
    target: new Int16Array(sampleCount),
    usefulZone: { start: 0, end: sampleCount },
    windows: [],
    shapeVariants: [],
    maxGroupSize: 1,
    injectedCandidates: [proposal],
  });
  const result = session.propose(silentParent(sampleCount));
  assert.ok(!Array.isArray(result));
  if (Array.isArray(result)) {
    return;
  }
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.shapes.length, 20);
  assert.deepEqual(result.candidates[0], proposal);
  assert.notEqual(result.candidates[0], proposal);
  assert.ok(result.cost > 0);
});

test('off precedes append and active slots use measured weakest leave-one-out', () => {
  const sampleCount = 2048;
  const offPatch: ArgCreateSynth = {
    oscillators: [
      group(71, 0.1),
      group(211, 0.02, false),
      group(353, 0.03),
    ],
  };
  const offBase = parentFor(offPatch, sampleCount);
  const offTarget = targetWithResidual(offBase, [
    { frequency: 5000, level: 500 },
  ]);
  const offParent = parentFor(offPatch, sampleCount);
  // Неверный rawSum не должен попасть в quantized residual или slot metric.
  offParent.rawSum.fill(1e9);
  const parentSnapshot = structuredClone(offParent);
  const targetSnapshot = new Int16Array(offTarget);
  const offSession = createResidualStructuralProposerSession({
    ...singleWindowOptions(offTarget),
    maxPeaksPerWindow: 1,
    weakActiveSlotCount: 1,
  });
  const offResult = offSession.propose(offParent);
  assert.ok(!Array.isArray(offResult));
  if (Array.isArray(offResult)) {
    return;
  }
  assert.ok(offResult.candidates.length > 0);
  assert.deepEqual(offResult.candidates[0]?.slots, [1]);
  assert.ok(
    offResult.candidates.every((proposal) => proposal.slots[0] !== 3),
  );
  assert.deepEqual(offParent, parentSnapshot);
  assert.deepEqual(offTarget, targetSnapshot);

  const fullPatch: ArgCreateSynth = {
    oscillators: Array.from({ length: 50 }, (_, index) =>
      group(
        50 + index * 37,
        index === 1 ? 0.002 : index === 0 ? 0.2 : 0.04,
      ),
    ),
  };
  const fullBase = parentFor(fullPatch, 1024);
  const fullTarget = targetWithResidual(fullBase, [
    { frequency: 6000, level: 600 },
  ]);
  const fullParent = parentFor(fullPatch, 1024);
  const weakSession = createResidualStructuralProposerSession({
    ...singleWindowOptions(fullTarget),
    maxPeaksPerWindow: 1,
    weakActiveSlotCount: 1,
  });
  const weakResult = weakSession.propose(fullParent);
  assert.ok(!Array.isArray(weakResult));
  if (Array.isArray(weakResult)) {
    return;
  }
  assert.ok(weakResult.candidates.length > 0);
  assert.ok(
    weakResult.candidates.every(
      (proposal) => proposal.slots[0] === 1,
    ),
  );
});

test('duplicate, gap and slot 50 injected proposals fail inside proposer', () => {
  const sampleCount = 128;
  const parent = parentFor(
    { oscillators: [group(80, 0.02, false)] },
    sampleCount,
  );
  const cases: {
    proposal: NativeStructuralProposal;
    message: RegExp;
  }[] = [
    {
      proposal: {
        slots: [0, 0],
        shapes: [knownShape(0), knownShape(1)],
      },
      message: /duplicate/,
    },
    {
      proposal: { slots: [2], shapes: [knownShape(0)] },
      message: /gaps/,
    },
    {
      proposal: { slots: [50], shapes: [knownShape(0)] },
      message: /slot/,
    },
  ];
  for (const entry of cases) {
    const session = createResidualStructuralProposerSession({
      target: new Int16Array(sampleCount),
      usefulZone: { start: 0, end: sampleCount },
      windows: [],
      shapeVariants: [],
      injectedCandidates: [entry.proposal],
    });
    assert.throws(() => session.propose(parent), entry.message);
  }
});

test('empty residual returns no fake candidates but charges actual analysis', () => {
  const sampleCount = 1000;
  const target = new Int16Array(sampleCount);
  const parent = silentParent(sampleCount);
  const session = createResidualStructuralProposerSession({
    ...singleWindowOptions(target, 13, sampleCount),
    injectedCandidates: [],
  });
  const estimate = session.estimateExpansion(parent);
  const result = session.propose(parent);
  assert.ok(!Array.isArray(result));
  if (Array.isArray(result)) {
    return;
  }
  assert.deepEqual(result.candidates, []);
  assert.ok(result.cost > 0);
  assert.ok(estimate >= result.cost);
  const snapshot = session.snapshot();
  assert.equal(snapshot.calls, 1);
  assert.equal(snapshot.cost, result.cost);
  assert.equal(snapshot.categories.residual, sampleCount);
  assert.ok(snapshot.categories.window > 0);
  assert.ok(snapshot.categories.fft > 0);
  assert.ok(snapshot.categories.peaks > 0);
  assert.equal(snapshot.categories.shapes, 0);
  assert.equal(snapshot.categories.slots, 0);
  assertLedgerSum(snapshot);
});

test('aligned, unaligned and last-fold calls keep estimate >= deterministic cost', () => {
  const cases = [
    { sampleCount: 1, start: 0, end: 1 },
    { sampleCount: 1024, start: 0, end: 1024 },
    { sampleCount: 1000, start: 13, end: 1000 },
    { sampleCount: 1500, start: 777, end: 1500 },
  ];
  for (const entry of cases) {
    const target = knownTones(entry.sampleCount, [
      { frequency: 117, level: 500 },
      { frequency: 7001, level: 350 },
    ]);
    const options = singleWindowOptions(
      target,
      entry.start,
      entry.end,
    );
    const first = createResidualStructuralProposerSession(options);
    const second = createResidualStructuralProposerSession(options);
    const firstParent = silentParent(entry.sampleCount);
    const secondParent = silentParent(entry.sampleCount);
    const estimates = [
      first.estimateExpansion(firstParent),
      first.estimateExpansion(firstParent),
    ];
    assert.equal(estimates[0], estimates[1]);
    const firstResult = first.propose(firstParent);
    const secondResult = second.propose(secondParent);
    assert.deepEqual(firstResult, secondResult);
    assert.ok(!Array.isArray(firstResult));
    if (Array.isArray(firstResult)) {
      continue;
    }
    const estimate = estimates[0] ?? 0;
    assert.ok(firstResult.cost <= estimate);
    const repeated = first.propose(firstParent);
    assert.deepEqual(repeated, firstResult);
    assert.equal(first.snapshot().calls, 2);
    assert.equal(first.snapshot().cost, 2 * firstResult.cost);
    assert.equal(second.snapshot().calls, 1);
    assertLedgerSum(first.snapshot());
    assertLedgerSum(second.snapshot());
  }
});

test('automatic useful zone measures its scan and supplies attack, early and full', () => {
  const sampleCount = 1200;
  const target = new Int16Array(sampleCount);
  const tones = knownTones(sampleCount, [
    { frequency: 331, level: 500 },
    { frequency: 9001, level: 300 },
  ]);
  for (let index = 11; index < sampleCount - 17; index += 1) {
    target[index] = tones[index] ?? 0;
  }
  const parent = silentParent(sampleCount);
  const session = createResidualStructuralProposerSession({
    target,
    maxPeaksPerWindow: 2,
    relativePeakThreshold: 0,
    shapeVariants: [BASE_VARIANT],
    weakActiveSlotCount: 0,
  });
  const estimate = session.estimateExpansion(parent);
  const result = session.propose(parent);
  assert.ok(result.candidates.length > 0);
  assert.ok(result.cost <= estimate);
  assert.ok(
    result.candidates.every((proposal) =>
      proposal.shapes.every((shape) => shape.delaySamples === 11),
    ),
  );
  const snapshot = session.snapshot();
  assert.ok(snapshot.categories.window >= sampleCount);
  assert.ok(snapshot.categories.shapes > 0);
  assertLedgerSum(snapshot);
});

test('independent sessions start equally and extra calls do not share counters', () => {
  const sampleCount = 512;
  const target = knownTones(sampleCount, [
    { frequency: 997, level: 700 },
  ]);
  const factory = createResidualStructuralProposer(
    singleWindowOptions(target),
  );
  const first = factory();
  const second = factory();
  const firstParent = silentParent(sampleCount);
  const secondParent = silentParent(sampleCount);
  const firstStart = first.propose(firstParent);
  const secondStart = second.propose(secondParent);
  assert.deepEqual(firstStart, secondStart);
  assert.deepEqual(first.snapshot(), second.snapshot());
  const secondSnapshot = second.snapshot();
  first.propose(firstParent);
  assert.deepEqual(second.snapshot(), secondSnapshot);
  assert.equal(first.snapshot().calls, 2);
  assert.equal(second.snapshot().calls, 1);
  assert.deepEqual(second.propose(secondParent), secondStart);
  const mutableSnapshot = second.snapshot();
  mutableSnapshot.categories.residual = 0;
  assert.ok(second.snapshot().categories.residual > 0);
});

test('native measured session drives the real evaluator and preserves zero optional fields', () => {
  const sampleCount = 4096;
  const phaseModel: PhaseModel = 'integral';
  const shape: StructuralAtomShape = {
    ...knownShape(2),
    delaySamples: 0,
    attackSamples: 0,
    hardStop: false,
  };
  const truth = patchFromStructuralCandidate(
    { oscillators: [] },
    {
      slots: [0],
      shapes: [shape],
      coefficients: [
        Math.round(0.04 * Math.cos(0.3) * SCALE) / SCALE,
        Math.round(0.04 * Math.sin(0.3) * SCALE) / SCALE,
      ],
    },
  );
  const target = renderForTarget(truth, sampleCount, phaseModel);
  const factory = createResidualStructuralProposer({
    target,
    phaseModel,
    usefulZone: { start: 0, end: sampleCount },
    windows: [],
    shapeVariants: [],
    injectedCandidates: [{ slots: [0], shapes: [shape] }],
  });
  const sessions: ResidualStructuralProposerSession[] = [];
  const result = runNativeStructuralBeam({
    patch: { oscillators: [] },
    target,
    phaseModel,
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 1,
    workBudget: 100000000,
    maxInner: 8,
    maxBacktracks: 16,
    createProposerSession: () => {
      const session = factory();
      sessions.push(session);
      return session;
    },
  });

  assert.equal(sessions.length, 1);
  const session = sessions[0];
  assert.ok(session !== undefined);
  assert.equal(
    result.status,
    'refined',
    result.rejectionReason ?? '',
  );
  assert.equal(result.evaluated.length, 1);
  assert.ok(result.metrics.globalSuppressionPercent > 99);
  assert.equal(result.expansionWork, session.snapshot().cost);
  assert.ok(result.expansionWork > 0);
  assert.equal(session.snapshot().calls, 1);
  assert.equal(
    result.work.used,
    result.evaluatorWork + result.expansionWork,
  );
  assert.equal(result.expansions.length, 1);
  const expansion = result.expansions[0];
  assert.ok(expansion !== undefined);
  assert.ok(expansion.cost <= expansion.estimatedWork);
  const selected = result.patch.oscillators[0];
  assert.ok(selected !== undefined);
  assert.equal('delay' in selected.osc, false);
  assert.equal('attack' in selected.ampEnv, false);
  assert.equal('hardStop' in selected.ampEnv, false);
  assertLedgerSum(session.snapshot());
});

test('automatic FFT shape improves a known target through the native evaluator without injections', () => {
  const sampleCount = 4096;
  const phaseModel: PhaseModel = 'integral';
  const frequency = SAMPLE_RATE / 4;
  const exactLevel = 1000 / SCALE;
  const variant: ResidualStructuralShapeVariant = {
    ...BASE_VARIANT,
    freqStartRatio: 1,
    ampDuration: sampleCount / SAMPLE_RATE,
    ampEndLevel: 1,
  };
  const shape: StructuralAtomShape = {
    freqBase: frequency,
    freqStart: frequency,
    oscDuration: variant.oscDuration,
    oscSlope: variant.oscSlope,
    ampDuration: variant.ampDuration,
    ampEndLevel: variant.ampEndLevel,
    ampSlope: variant.ampSlope,
    delaySamples: variant.delaySamples,
    attackSamples: variant.attackSamples,
    hardStop: variant.hardStop,
  };
  const truth = patchFromStructuralCandidate(
    { oscillators: [] },
    {
      slots: [0],
      shapes: [shape],
      coefficients: [exactLevel, 0],
    },
  );
  const target = renderForTarget(truth, sampleCount, phaseModel);
  const factory = createResidualStructuralProposer({
    target,
    phaseModel,
    usefulZone: { start: 0, end: sampleCount },
    windows: [{ name: 'full', start: 0, end: sampleCount }],
    maxPeaksPerWindow: 1,
    relativePeakThreshold: 0,
    shapeVariants: [variant],
    maxGroupSize: 1,
    weakActiveSlotCount: 0,
  });
  const sessions: ResidualStructuralProposerSession[] = [];
  const result = runNativeStructuralBeam({
    patch: { oscillators: [] },
    target,
    phaseModel,
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 1,
    workBudget: 100000000,
    maxInner: 8,
    maxBacktracks: 16,
    createProposerSession: () => {
      const session = factory();
      sessions.push(session);
      return session;
    },
  });

  assert.equal(sessions.length, 1);
  const session = sessions[0];
  assert.ok(session !== undefined);
  assert.equal(
    result.status,
    'refined',
    result.rejectionReason ?? '',
  );
  assert.equal(result.evaluated.length, 1);
  assert.ok(result.metrics.globalSuppressionPercent > 99);
  assert.ok(
    result.metrics.globalSuppressionPercent >
      result.baseline.globalSuppressionPercent,
  );
  assert.equal(result.expansionWork, session.snapshot().cost);
  assert.ok(session.snapshot().categories.fft > 0);
  assert.ok(session.snapshot().categories.peaks > 0);
  assert.ok(session.snapshot().categories.shapes > 0);
  const evaluated = result.history[0];
  assert.ok(evaluated !== undefined);
  assert.deepEqual(evaluated.proposal.slots, [0]);
  const proposedShape = evaluated.proposal.shapes[0];
  assert.ok(proposedShape !== undefined);
  assert.ok(
    Math.abs(proposedShape.freqBase - frequency) <= 1e-9,
    `expected ${frequency}, received ${proposedShape.freqBase}`,
  );
  assert.ok(Math.abs(proposedShape.freqStart - frequency) <= 1e-9);
  assert.deepEqual(
    { ...proposedShape, freqBase: frequency, freqStart: frequency },
    shape,
  );
  assert.ok(
    result.samples.every(
      (value, index) => Math.abs(value - (target[index] ?? 0)) <= 1,
    ),
  );
  assertLedgerSum(session.snapshot());
});
