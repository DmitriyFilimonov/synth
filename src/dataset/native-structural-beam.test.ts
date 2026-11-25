import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  assertNativeStructuralEvaluationWork,
  estimateStructuralCandidateWork,
  passesNativeStructuralGuard,
  runNativeStructuralBeam,
  runNativeStructuralBeamWithWidthControl,
  type NativeStructuralBeamOptions,
  type NativeStructuralBeamResult,
  type NativeStructuralCanonicalAssert,
  type NativeStructuralNode,
  type NativeStructuralProposal,
  type NativeStructuralProposeResult,
} from './native-structural-beam';
import { renderForTarget, renderGroup } from './quadrature-refit';
import {
  patchFromStructuralCandidate,
  type StructuralAtomShape,
} from './structural-atom';

type Group = ArgCreateSynth['oscillators'][number];

const SCALE = MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
const TWO_PI = 2 * Math.PI;

/** Создаёт полную native-форму без скрытых default-полей. */
function shape(frequency: number, variant = 0): StructuralAtomShape {
  return {
    freqBase: frequency,
    freqStart: variant % 3 === 0 ? frequency : frequency * 1.17,
    oscDuration: 0.014 + variant * 0.001,
    oscSlope: 0.8 + variant * 0.03,
    ampDuration: 0.04 + variant * 0.002,
    ampEndLevel: 0.03 + variant * 0.004,
    ampSlope: 0.9 + variant * 0.04,
    delaySamples: 0,
    attackSamples: 0,
    hardStop: false,
  };
}

/** Off-слот несёт optional-поля, включая явные нули и false. */
function offGroup(index: number): Group {
  return {
    osc: {
      on: false,
      freqBase: 211 + index,
      freqStart: 503 + index,
      duration: 0.021 + index * 0.0001,
      slope: 1.4,
      phase: 0.37 + index * 0.01,
      ...(index % 4 === 0
        ? { delay: 0 }
        : index % 4 === 1
          ? { delay: 3 / SAMPLE_RATE }
          : {}),
    },
    ampEnv: {
      startLevel: 0.02,
      ...(index % 5 === 0 ? {} : { endLevel: 0.04 }),
      duration: 0.032 + index * 0.0001,
      slope: 1.1,
      ...(index % 6 === 0
        ? { attack: 0 }
        : index % 6 === 1
          ? { attack: 2 / SAMPLE_RATE }
          : {}),
      ...(index % 7 === 0
        ? { hardStop: false }
        : index % 7 === 1
          ? { hardStop: true }
          : {}),
    },
  };
}

/** Пятьдесят off-слотов проверяют сохранение полей вне candidate. */
function offSource(): ArgCreateSynth {
  return {
    oscillators: Array.from({ length: 50 }, (_, index) =>
      offGroup(index),
    ),
  };
}

/** Переводит level/phase в пару solver и квантует известный ответ заранее. */
function coefficients(
  level: number,
  phase: number,
  quantize = false,
): [number, number] {
  const pair: [number, number] = [
    level * Math.cos(phase),
    level * Math.sin(phase),
  ];
  if (!quantize) {
    return pair;
  }
  return pair.map((value) => Math.round(value * SCALE) / SCALE) as [
    number,
    number,
  ];
}

/** Истинные и испорченные линейные коэффициенты known-answer fixture. */
function fixtureCoefficients(atomCount: number): {
  truth: number[];
  corrupt: number[];
} {
  const truth = Array.from({ length: atomCount }, (_, atom) =>
    coefficients(
      0.013 + 0.002 * (atom % 5),
      (0.21 + atom * 0.618) % TWO_PI,
      true,
    ),
  ).flat();
  const corrupt = Array.from({ length: atomCount }, (_, atom) =>
    coefficients(
      0.022 + 0.001 * (atom % 4),
      (2.17 + atom * 0.83) % TWO_PI,
    ),
  ).flat();
  return { truth, corrupt };
}

/** Набор различимых форм с независимыми sweep/envelopes. */
function fixtureShapes(atomCount: number): StructuralAtomShape[] {
  const frequencies = [73, 137, 239, 331, 479];
  return Array.from({ length: atomCount }, (_, atom) =>
    shape(frequencies[atom] ?? 100 + atom * 31, atom),
  );
}

/** Готовит native target и source, который отличается только fit. */
function coefficientFixture(
  atomCount: number,
  phaseModel: PhaseModel,
  sampleCount: number,
): {
  source: ArgCreateSynth;
  truth: ArgCreateSynth;
  target: Int16Array;
  proposal: NativeStructuralProposal;
  options: NativeStructuralBeamOptions;
} {
  const slots = Array.from(
    { length: atomCount },
    (_, index) => index,
  );
  const shapes = fixtureShapes(atomCount);
  const known = fixtureCoefficients(atomCount);
  const empty = offSource();
  const truth = patchFromStructuralCandidate(empty, {
    slots,
    shapes,
    coefficients: known.truth,
  });
  const source = patchFromStructuralCandidate(empty, {
    slots,
    shapes,
    coefficients: known.corrupt,
  });
  const target = renderForTarget(truth, sampleCount, phaseModel);
  const proposal = { slots, shapes };
  const maxInner = 8;
  const maxBacktracks = 16;
  const options: NativeStructuralBeamOptions = {
    patch: source,
    target,
    phaseModel,
    beamWidth: 2,
    maxDepth: 1,
    maxGroupSize: atomCount,
    workBudget: estimateStructuralCandidateWork({
      sampleCount,
      atomCount,
      maxInner,
      maxBacktracks,
    }),
    maxInner,
    maxBacktracks,
    propose: (parent) => (parent.depth === 0 ? [proposal] : []),
  };
  return { source, truth, target, proposal, options };
}

/** Независимый global по фактическому canonical PCM. */
function globalSuppression(
  target: Int16Array,
  samples: Int16Array,
): number {
  let targetSquares = 0;
  let residualSquares = 0;
  for (let index = 0; index < target.length; index += 1) {
    const targetValue = target[index] ?? 0;
    const residual = targetValue - (samples[index] ?? 0);
    targetSquares += targetValue * targetValue;
    residualSquares += residual * residual;
  }
  assert.ok(targetSquares > 0);
  return 100 * (1 - Math.sqrt(residualSquares / targetSquares));
}

/** Измеряет known-answer ошибку без подмены canonical PCM solver-метрикой. */
function maxAbsoluteError(
  actual: Int16Array,
  expected: Int16Array,
): number {
  assert.equal(actual.length, expected.length);
  let maximum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    maximum = Math.max(
      maximum,
      Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)),
    );
  }
  return maximum;
}

/** Проверяет, что selected shape сохранился, а менялись только level/phase. */
function assertOnlyFitChanged(before: Group, after: Group): void {
  const normalized = structuredClone(after);
  normalized.osc.phase = before.osc.phase;
  normalized.ampEnv.startLevel = before.ampEnv.startLevel;
  assert.deepEqual(normalized, before);
}

/** Обычный активный тон для guard и width fixtures. */
function tone(frequency: number, level = 0.2, phase = 0.3): Group {
  return {
    osc: {
      on: true,
      freqBase: frequency,
      freqStart: frequency,
      duration: 0.018,
      slope: 1.1,
      phase,
    },
    ampEnv: {
      startLevel: level,
      endLevel: 0.04,
      duration: 0.045,
      slope: 1.2,
    },
  };
}

/** Извлекает полную форму tone без чтения коэффициентов в proposal. */
function shapeFromTone(group: Group): StructuralAtomShape {
  return {
    freqBase: group.osc.freqBase,
    freqStart: group.osc.freqStart,
    oscDuration: group.osc.duration,
    oscSlope: group.osc.slope,
    ampDuration: group.ampEnv.duration,
    ampEndLevel: group.ampEnv.endLevel ?? 0.001,
    ampSlope: group.ampEnv.slope,
    delaySamples: 0,
    attackSamples: 0,
    hardStop: false,
  };
}

for (const [atomCount, phaseModel] of [
  [4, 'legacy'],
  [5, 'integral'],
] as const) {
  test(`native beam jointly restores K=${atomCount} and saves canonical ${phaseModel} PCM`, () => {
    const sampleCount = 4096;
    const fixture = coefficientFixture(
      atomCount,
      phaseModel,
      sampleCount,
    );
    const sourceSnapshot = structuredClone(fixture.source);
    const proposalSnapshot = structuredClone(fixture.proposal);
    const result = runNativeStructuralBeam(fixture.options);

    assert.equal(
      result.status,
      'refined',
      result.rejectionReason ?? '',
    );
    assert.equal(result.bestAny.groupSize, atomCount);
    assert.equal(result.evaluated.length, 1);
    assert.ok(result.proposed !== null);
    assert.ok(
      maxAbsoluteError(result.samples, fixture.target) <= 1,
      JSON.stringify(result.metrics),
    );
    assert.ok(
      result.metrics.globalSuppressionPercent > 99,
      JSON.stringify(result.metrics),
    );
    assert.equal(
      result.metrics.globalSuppressionPercent,
      globalSuppression(fixture.target, result.samples),
    );
    assert.deepEqual(result.proposed.metrics, result.metrics);
    assertPatchMatchesWav(
      result.patch,
      result.samples,
      phaseModel,
      SAMPLE_RATE,
      sampleCount,
    );
    for (let slot = 0; slot < atomCount; slot += 1) {
      const before = fixture.truth.oscillators[slot];
      const after = result.patch.oscillators[slot];
      assert.ok(before !== undefined);
      assert.ok(after !== undefined);
      assertOnlyFitChanged(before, after);
    }
    for (let slot = atomCount; slot < 50; slot += 1) {
      assert.deepEqual(
        result.patch.oscillators[slot],
        fixture.source.oscillators[slot],
      );
    }
    assert.deepEqual(fixture.source, sourceSnapshot);
    assert.deepEqual(fixture.proposal, proposalSnapshot);
    assert.ok(result.work.used <= fixture.options.workBudget);
    assert.equal(
      result.work.unused,
      fixture.options.workBudget - result.work.used,
    );
    assert.equal(result.finalizationSampleWork, 5 * sampleCount);
  });
}

test('fixedOffset subtracts selected delayed atoms once and preserves untouched native fields', () => {
  const phaseModel: PhaseModel = 'integral';
  const background = tone(61, 0.07, 0.4);
  background.osc.delay = 7 / SAMPLE_RATE;
  background.ampEnv.attack = 3 / SAMPLE_RATE;
  const secondBackground = tone(311, 0.025, 1.2);
  const base: ArgCreateSynth = {
    oscillators: [
      background,
      offGroup(1),
      offGroup(2),
      secondBackground,
      offGroup(4),
    ],
  };
  const slots = [1, 2];
  const shapes: StructuralAtomShape[] = [
    {
      ...shape(83, 1),
      delaySamples: 17,
      attackSamples: 5,
      hardStop: true,
    },
    {
      ...shape(197, 2),
      delaySamples: 3,
      attackSamples: 11,
      hardStop: false,
    },
  ];
  const known = fixtureCoefficients(2);
  const truth = patchFromStructuralCandidate(base, {
    slots,
    shapes,
    coefficients: known.truth,
  });
  const source = patchFromStructuralCandidate(base, {
    slots,
    shapes,
    coefficients: known.corrupt,
  });
  const sourceSnapshot = structuredClone(source);
  const sampleCount = 4096;
  const target = renderForTarget(truth, sampleCount, phaseModel);
  const maxInner = 8;
  const maxBacktracks = 16;
  const result = runNativeStructuralBeam({
    patch: source,
    target,
    phaseModel,
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 2,
    workBudget: estimateStructuralCandidateWork({
      sampleCount,
      atomCount: 2,
      maxInner,
      maxBacktracks,
    }),
    maxInner,
    maxBacktracks,
    propose: () => [{ slots, shapes }],
  });

  assert.equal(
    result.status,
    'refined',
    result.rejectionReason ?? '',
  );
  assert.ok(
    maxAbsoluteError(result.samples, target) <= 1,
    JSON.stringify(result.metrics),
  );
  assert.equal(result.history.length, 1);
  const history = result.history[0];
  assert.ok(history !== undefined);
  const expectedOffset = new Float64Array(result.root.value.rawSum);
  const rootContributions = result.root.value.contributions;
  assert.ok(rootContributions !== null);
  for (const slot of slots) {
    const previous: Float64Array | null | undefined =
      rootContributions[slot];
    assert.ok(previous !== null && previous !== undefined);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      expectedOffset[sample] =
        (expectedOffset[sample] ?? 0) - (previous[sample] ?? 0);
    }
  }
  assert.deepEqual(history.fixedOffset, expectedOffset);
  assert.notEqual(
    history.fixedOffset.every((value) => value === 0),
    true,
  );
  for (const slot of [0, 3, 4]) {
    assert.deepEqual(
      result.patch.oscillators[slot],
      source.oscillators[slot],
    );
  }
  for (let atom = 0; atom < slots.length; atom += 1) {
    const slot = slots[atom];
    const selectedShape = shapes[atom];
    assert.ok(slot !== undefined && selectedShape !== undefined);
    const group = result.patch.oscillators[slot];
    assert.ok(group !== undefined);
    assert.equal(
      group.osc.delay,
      selectedShape.delaySamples / SAMPLE_RATE,
    );
    assert.equal(
      group.ampEnv.attack,
      selectedShape.attackSamples / SAMPLE_RATE,
    );
    assert.equal(
      group.ampEnv.hardStop ?? false,
      selectedShape.hardStop,
    );
  }
  assert.deepEqual(source, sourceSnapshot);
});

test('native append evaluates slot==parent length and preserves every source group', () => {
  const source: ArgCreateSynth = {
    oscillators: [tone(61, 0.08, 0.4), offGroup(4)],
  };
  const snapshot = structuredClone(source);
  const appendedShape: StructuralAtomShape = {
    ...shape(179, 2),
    delaySamples: 2,
    attackSamples: 3,
    hardStop: true,
  };
  const known = fixtureCoefficients(1);
  const truth = patchFromStructuralCandidate(source, {
    slots: [2],
    shapes: [appendedShape],
    coefficients: known.truth,
  });
  const sampleCount = 2048;
  const target = renderForTarget(truth, sampleCount, 'integral');
  const maxInner = 8;
  const maxBacktracks = 16;
  const result = runNativeStructuralBeam({
    patch: source,
    target,
    phaseModel: 'integral',
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 1,
    workBudget: estimateStructuralCandidateWork({
      sampleCount,
      atomCount: 1,
      maxInner,
      maxBacktracks,
    }),
    maxInner,
    maxBacktracks,
    propose: () => [{ slots: [2], shapes: [appendedShape] }],
  });

  assert.equal(
    result.status,
    'refined',
    result.rejectionReason ?? '',
  );
  assert.equal(result.evaluated.length, 1);
  const node = result.evaluated[0];
  assert.ok(node !== undefined);
  const evaluation = node.value.evaluation;
  assert.ok(evaluation !== null);
  assert.equal(node.value.patch.oscillators.length, 3);
  assert.equal(result.patch.oscillators.length, 3);
  assert.ok(maxAbsoluteError(result.samples, target) <= 1);
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    'integral',
    SAMPLE_RATE,
    sampleCount,
  );
  for (let slot = 0; slot < source.oscillators.length; slot += 1) {
    assert.deepEqual(
      node.value.patch.oscillators[slot],
      source.oscillators[slot],
    );
    assert.deepEqual(
      result.patch.oscillators[slot],
      source.oscillators[slot],
    );
  }
  const appended = result.patch.oscillators[2];
  assert.ok(appended !== undefined);
  assert.equal(appended.osc.on, true);
  assert.equal(appended.osc.freqBase, appendedShape.freqBase);
  assert.equal(appended.osc.freqStart, appendedShape.freqStart);
  assert.equal(appended.osc.delay, 2 / SAMPLE_RATE);
  assert.equal(appended.ampEnv.attack, 3 / SAMPLE_RATE);
  assert.equal(appended.ampEnv.hardStop, true);
  assert.deepEqual(evaluation.fixedOffset, result.root.value.rawSum);
  assert.equal(evaluation.sampleWork.basis, 2 * sampleCount);
  assert.equal(
    evaluation.sampleWork.offset,
    evaluation.solver.work.objectiveEvaluations * sampleCount,
  );
  assert.equal(
    evaluation.canonicalWork.selectedContributionRenders,
    sampleCount,
  );
  assert.equal(
    node.cost,
    evaluation.sampleWork.total + evaluation.canonicalWork.total,
  );
  assert.deepEqual(
    evaluation.sampleWork,
    evaluation.solver.work.sampleWork,
  );
  assert.deepEqual(
    evaluation.denseWork,
    evaluation.solver.work.denseWork,
  );
  assert.deepEqual(result.denseWork, evaluation.denseWork);
  assert.ok(node.cost <= node.estimatedWork);
  assert.equal(result.work.used, node.cost);
  assert.equal(result.finalizationSampleWork, 5 * sampleCount);
  assert.deepEqual(source, snapshot);
});

test('an appended gap is rejected before basis and solver work', () => {
  const source: ArgCreateSynth = {
    oscillators: [tone(61, 0.08, 0.4), offGroup(4)],
  };
  const snapshot = structuredClone(source);
  const sampleCount = 4;
  const target = renderForTarget(source, sampleCount, 'legacy');
  let assertions = 0;
  let proposals = 0;
  const assertCanonical: NativeStructuralCanonicalAssert = (
    patch,
    expected,
    phaseModel,
    sampleRate,
    renderSampleCount,
  ) => {
    assertions += 1;
    assertPatchMatchesWav(
      patch,
      expected,
      phaseModel,
      sampleRate,
      renderSampleCount,
    );
  };
  const unsupportedShape: StructuralAtomShape = {
    ...shape(179),
    delaySamples: 8,
  };

  assert.throws(
    () =>
      runNativeStructuralBeam({
        patch: source,
        target,
        beamWidth: 1,
        maxDepth: 1,
        maxGroupSize: 1,
        workBudget: estimateStructuralCandidateWork({
          sampleCount,
          atomCount: 1,
          maxInner: 1,
          maxBacktracks: 1,
        }),
        maxInner: 1,
        maxBacktracks: 1,
        assertCanonical,
        propose: () => {
          proposals += 1;
          return [{ slots: [3], shapes: [unsupportedShape] }];
        },
      }),
    /Appended native structural slots must not contain gaps/,
  );
  assert.equal(proposals, 1);
  // Остался только root assert. При запуске solver delayed shape дал бы
  // Zero-support structural atom вместо раннего gap error.
  assert.equal(assertions, 1);
  assert.deepEqual(source, snapshot);
});

test('a candidate worse than exact root stays proposed but saved returns source', () => {
  const source: ArgCreateSynth = {
    oscillators: [tone(73, 0.2, 0.4)],
  };
  const sourceGroup = source.oscillators[0];
  assert.ok(sourceGroup !== undefined);
  const snapshot = structuredClone(source);
  const sampleCount = 1024;
  const target = renderForTarget(source, sampleCount, 'legacy');
  const wrongShape = {
    ...shapeFromTone(sourceGroup),
    freqBase: 91,
    freqStart: 117,
  };
  const maxInner = 4;
  const maxBacktracks = 8;
  const result = runNativeStructuralBeam({
    patch: source,
    target,
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 1,
    workBudget: estimateStructuralCandidateWork({
      sampleCount,
      atomCount: 1,
      maxInner,
      maxBacktracks,
    }),
    maxInner,
    maxBacktracks,
    propose: () => [{ slots: [0], shapes: [wrongShape] }],
  });

  assert.equal(result.status, 'unchanged');
  assert.equal(result.rejectionReason, 'Canonical global не вырос');
  assert.equal(result.bestAny, result.root);
  assert.deepEqual(result.bestPath, [result.root]);
  assert.ok(result.proposed !== null);
  assert.equal(result.proposed.depth, 1);
  assert.ok(
    result.proposed.metrics.globalSuppressionPercent <=
      result.baseline.globalSuppressionPercent,
  );
  assert.deepEqual(result.patch, snapshot);
  assert.deepEqual(result.samples, target);
  assert.deepEqual(source, snapshot);
  assert.equal(result.finalizationSampleWork, 0);
});

test('native J-floor fallback keeps source and exposes global-only proposed gain', () => {
  const truth: ArgCreateSynth = {
    oscillators: [tone(73, 0.4, 0.37)],
  };
  const truthGroup = truth.oscillators[0];
  assert.ok(truthGroup !== undefined);
  truthGroup.ampEnv.endLevel = 1;
  const source = structuredClone(truth);
  const sourceGroup = source.oscillators[0];
  assert.ok(sourceGroup !== undefined);
  sourceGroup.ampEnv.startLevel = 0.16;
  sourceGroup.osc.phase = 2.2;
  const snapshot = structuredClone(source);
  const sampleCount = 1024;
  const target = renderForTarget(truth, sampleCount, 'legacy');
  const maxInner = 8;
  const maxBacktracks = 16;
  const result = runNativeStructuralBeam({
    patch: source,
    target,
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 1,
    workBudget: estimateStructuralCandidateWork({
      sampleCount,
      atomCount: 1,
      maxInner,
      maxBacktracks,
    }),
    maxInner,
    maxBacktracks,
    propose: () => [
      { slots: [0], shapes: [shapeFromTone(truthGroup)] },
    ],
  });

  assert.equal(result.status, 'unchanged');
  assert.equal(
    result.rejectionReason,
    'Canonical J ниже initial−0.05',
  );
  assert.ok(result.proposed !== null);
  assert.ok(
    result.proposed.metrics.globalSuppressionPercent >
      result.baseline.globalSuppressionPercent,
  );
  assert.ok(
    result.proposed.metrics.windowedSuppressionPercent <
      result.baseline.windowedSuppressionPercent - 0.05,
  );
  assert.deepEqual(result.patch, snapshot);
  assert.deepEqual(
    result.samples,
    renderForTarget(source, sampleCount, 'legacy'),
  );
  assert.deepEqual(source, snapshot);
});

test('a final canonical mismatch rejects saved and retains pre-guard proposed', () => {
  const fixture = coefficientFixture(1, 'legacy', 1024);
  const snapshot = structuredClone(fixture.source);
  let assertions = 0;
  const assertCanonical: NativeStructuralCanonicalAssert = (
    patch,
    expected,
    phaseModel,
    sampleRate,
    renderSampleCount,
  ) => {
    assertions += 1;
    if (assertions === 3) {
      throw new Error('synthetic canonical mismatch');
    }
    assertPatchMatchesWav(
      patch,
      expected,
      phaseModel,
      sampleRate,
      renderSampleCount,
    );
  };
  const result = runNativeStructuralBeam({
    ...fixture.options,
    assertCanonical,
  });

  assert.equal(assertions, 3);
  assert.equal(result.status, 'unchanged');
  assert.equal(
    result.rejectionReason,
    'Canonical patch/WAV не совпали',
  );
  assert.equal(result.canonicalError, 'synthetic canonical mismatch');
  assert.ok(result.proposed !== null);
  assert.ok(
    maxAbsoluteError(result.proposed.samples, fixture.target) <= 1,
  );
  assert.deepEqual(result.patch, snapshot);
  assert.deepEqual(
    result.samples,
    renderForTarget(fixture.source, 1024, 'legacy'),
  );
  assert.equal(result.finalizationSampleWork, 5 * 1024);
});

test('guard thresholds and actual-above-estimate failure are explicit', () => {
  const baseline = {
    globalSuppressionPercent: 80,
    windowedSuppressionPercent: 82,
  };
  assert.equal(
    passesNativeStructuralGuard(baseline, {
      globalSuppressionPercent: 90,
      windowedSuppressionPercent: 81.94,
    }),
    false,
  );
  assert.equal(
    passesNativeStructuralGuard(baseline, {
      globalSuppressionPercent: 90,
      windowedSuppressionPercent: 81.95,
    }),
    true,
  );
  assert.equal(
    passesNativeStructuralGuard(baseline, {
      globalSuppressionPercent: 80 + 1e-10,
      windowedSuppressionPercent: 82,
    }),
    false,
  );
  assert.doesNotThrow(() =>
    assertNativeStructuralEvaluationWork({
      candidateKey: 'known',
      cost: 10,
      estimatedWork: 10,
    }),
  );
  assert.throws(
    () =>
      assertNativeStructuralEvaluationWork({
        candidateKey: 'over',
        cost: 11,
        estimatedWork: 10,
      }),
    /exceeded estimate: 11 > 10/,
  );
});

/** Маленький K2 fixture с maxInner=0 и двумя active selected slots. */
function knownCountFixture(): {
  source: ArgCreateSynth;
  target: Int16Array;
  options: NativeStructuralBeamOptions;
} {
  const sampleCount = 3;
  const shapes = [shape(73), shape(131, 1)];
  const slots = [0, 1];
  const known = fixtureCoefficients(2);
  const source = patchFromStructuralCandidate(offSource(), {
    slots,
    shapes,
    coefficients: known.truth,
  });
  const target = renderForTarget(source, sampleCount, 'legacy');
  const options: NativeStructuralBeamOptions = {
    patch: source,
    target,
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 2,
    workBudget: estimateStructuralCandidateWork({
      sampleCount,
      atomCount: 2,
      maxInner: 0,
      maxBacktracks: 0,
    }),
    maxInner: 0,
    maxBacktracks: 0,
    propose: () => [{ slots, shapes }],
  };
  return { source, target, options };
}

test('small native K2 has an exact full basis+solver+canonical work count', () => {
  const fixture = knownCountFixture();
  const result = runNativeStructuralBeam(fixture.options);
  assert.equal(result.evaluated.length, 1);
  const node = result.evaluated[0];
  assert.ok(node !== undefined);
  const evaluation = node.value.evaluation;
  assert.ok(evaluation !== null);

  assert.deepEqual(evaluation.sampleWork, {
    validation: 39,
    basis: 12,
    mixing: 12,
    quantize: 3,
    metric: 3,
    gram: 0,
    mask: 3,
    offset: 9,
    total: 81,
  });
  assert.deepEqual(evaluation.canonicalWork, {
    fixedOffsetCopy: 3,
    parentContributionRenders: 0,
    selectedContributionRenders: 6,
    rawSumAssembly: 9,
    canonicalRender: 3,
    canonicalAssertion: 6,
    canonicalMetrics: 6,
    total: 33,
  });
  assert.equal(node.estimatedWork, 114);
  assert.equal(node.cost, 114);
  assert.equal(result.work.used, 114);
  assert.equal(result.work.unused, 0);
  assert.equal(evaluation.solver.work.normalEquationBuilds, 0);
  assert.equal(evaluation.solver.work.objectiveEvaluations, 1);
  assert.ok(
    Object.values(evaluation.denseWork).every((value) => value === 0),
  );
  assert.equal(result.finalizationSampleWork, 0);
});

/** Native clipping fixture с accepted mask change и rejected backtracks. */
function backtrackingWorkFixture(): {
  options: NativeStructuralBeamOptions;
  sampleCount: number;
} {
  const sampleCount = 128;
  const background = tone(311, 0.8, 0.4);
  background.ampEnv.endLevel = 1;
  const base: ArgCreateSynth = {
    oscillators: [background, offGroup(1), offGroup(2)],
  };
  const shapes = [50, 51].map(
    (frequency, index): StructuralAtomShape => ({
      ...shape(frequency, index),
      oscDuration: 0.018,
      oscSlope: 1.1,
      ampDuration: 0.045,
      ampEndLevel: 1,
      ampSlope: 1.2,
    }),
  );
  const initialLevels = [0.720696445181966, 0.6392708899453283];
  const targetLevels = [0.48033789109811187, 0.022214071079157294];
  const initialPhases = [5.902386838766316, 0.6464114968791941];
  const targetPhases = [5.512173690833855, 5.387478905938408];
  const initialCoefficients = initialLevels.flatMap((level, atom) =>
    coefficients(level, initialPhases[atom] ?? 0),
  );
  const targetCoefficients = targetLevels.flatMap((level, atom) =>
    coefficients(level, targetPhases[atom] ?? 0),
  );
  const slots = [1, 2];
  const source = patchFromStructuralCandidate(base, {
    slots,
    shapes,
    coefficients: initialCoefficients,
  });
  const truth = patchFromStructuralCandidate(base, {
    slots,
    shapes,
    coefficients: targetCoefficients,
  });
  const target = renderForTarget(truth, sampleCount, 'legacy');
  const maxInner = 3;
  const maxBacktracks = 4;
  return {
    sampleCount,
    options: {
      patch: source,
      target,
      beamWidth: 1,
      maxDepth: 1,
      maxGroupSize: 2,
      workBudget: estimateStructuralCandidateWork({
        sampleCount,
        atomCount: 2,
        maxInner,
        maxBacktracks,
      }),
      maxInner,
      maxBacktracks,
      propose: () => [{ slots, shapes }],
    },
  };
}

test('native backtracking and mask changes satisfy the provable inner upper bound', () => {
  const fixture = backtrackingWorkFixture();
  const sampleCount = fixture.sampleCount;
  const result = runNativeStructuralBeam(fixture.options);
  const node = result.evaluated[0];
  assert.ok(node !== undefined);
  const evaluation = node.value.evaluation;
  assert.ok(evaluation !== null);
  const solverWork = evaluation.solver.work;

  assert.equal(solverWork.normalEquationBuilds, 2);
  assert.equal(solverWork.objectiveEvaluations, 7);
  assert.equal(solverWork.acceptedIterations, 1);
  assert.equal(solverWork.backtracks, 5);
  assert.equal(solverWork.maskChanges, 30);
  assert.equal(evaluation.solver.stopReason, 'quantized-plateau');
  assert.equal(evaluation.solver.history.length, 1);
  assert.equal(evaluation.solver.history[0]?.maskChanges, 30);

  const atomCount = 2;
  const columns = 2 * atomCount;
  const objectives = solverWork.objectiveEvaluations;
  const expectedSampleWork = {
    validation: (3 + 5 * atomCount) * sampleCount,
    basis: columns * sampleCount,
    mixing: columns * objectives * sampleCount,
    quantize: objectives * sampleCount,
    metric: objectives * sampleCount,
    gram:
      (solverWork.normEvaluations + solverWork.gramDotProducts) *
      sampleCount,
    mask: (objectives + solverWork.acceptedIterations) * sampleCount,
    // Два старых active selected slots плюс offset каждой objective-пробы.
    offset: (atomCount + objectives) * sampleCount,
    total: 0,
  };
  expectedSampleWork.total =
    expectedSampleWork.validation +
    expectedSampleWork.basis +
    expectedSampleWork.mixing +
    expectedSampleWork.quantize +
    expectedSampleWork.metric +
    expectedSampleWork.gram +
    expectedSampleWork.mask +
    expectedSampleWork.offset;
  assert.deepEqual(evaluation.sampleWork, expectedSampleWork);
  assert.deepEqual(evaluation.sampleWork, solverWork.sampleWork);
  assert.equal(evaluation.sampleWork.total, 14336);
  assert.equal(evaluation.canonicalWork.total, 1408);
  assert.equal(node.cost, 15744);
  assert.equal(
    node.cost,
    evaluation.sampleWork.total + evaluation.canonicalWork.total,
  );

  const maxInner = fixture.options.maxInner ?? 0;
  const maxBacktracks = fixture.options.maxBacktracks ?? 0;
  const gramUpper = 2 * columns + (columns * (columns + 1)) / 2;
  const innerUpper =
    gramUpper + (maxBacktracks + 1) * (columns + 4) + 1;
  const expectedEstimate =
    sampleCount * (12 * atomCount + 14 + maxInner * innerUpper);
  assert.equal(expectedEstimate, 27520);
  assert.equal(node.estimatedWork, expectedEstimate);
  assert.ok(node.cost <= node.estimatedWork);
  assert.doesNotThrow(() =>
    assertNativeStructuralEvaluationWork({
      candidateKey: node.candidateKey ?? '',
      cost: node.cost,
      estimatedWork: node.estimatedWork,
    }),
  );
  assert.equal(result.work.used, node.cost);
  assert.equal(result.work.unused, expectedEstimate - node.cost);
  assert.deepEqual(evaluation.denseWork, solverWork.denseWork);
  assert.deepEqual(result.denseWork, solverWork.denseWork);
  assert.deepEqual(result.denseWork, {
    gramCellUpdates: 40,
    jacobiMatrixEntries: 88,
    jacobiOffDiagonalScans: 60,
    jacobiRotations: 45,
    jacobiRotationElementUpdates: 900,
    pseudoInverseEntries: 72,
  });
  assert.equal(result.status, 'refined');
  assert.equal(result.finalizationSampleWork, 5 * sampleCount);
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    'legacy',
    SAMPLE_RATE,
    sampleCount,
  );
});

/** Три K2 proposals имеют stable lexical order по первой частоте 100/110/120. */
function budgetFixture(): {
  source: ArgCreateSynth;
  target: Int16Array;
  proposals: NativeStructuralProposal[];
  sampleCount: number;
  slots: number[];
} {
  const sampleCount = 64;
  const slots = [0, 1];
  const trueShapes = [shape(100), shape(200, 1)];
  const known = fixtureCoefficients(2);
  const truth = patchFromStructuralCandidate(offSource(), {
    slots,
    shapes: trueShapes,
    coefficients: known.truth,
  });
  const source = patchFromStructuralCandidate(offSource(), {
    slots,
    shapes: trueShapes,
    coefficients: known.corrupt,
  });
  const target = renderForTarget(truth, sampleCount, 'legacy');
  const proposals: NativeStructuralProposal[] = [
    { slots, shapes: trueShapes },
    {
      slots,
      shapes: [shape(110), shape(210, 1)],
    },
    {
      slots,
      shapes: [shape(120), shape(220, 1)],
    },
  ];
  return { source, target, proposals, sampleCount, slots };
}

test('actual cost below estimate releases W and an oversized estimate skips evaluator', () => {
  const fixture = budgetFixture();
  const maxInner = 8;
  const maxBacktracks = 12;
  const estimate = estimateStructuralCandidateWork({
    sampleCount: fixture.sampleCount,
    atomCount: 2,
    maxInner,
    maxBacktracks,
  });
  const common = {
    patch: fixture.source,
    target: fixture.target,
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 2,
    maxInner,
    maxBacktracks,
  } as const;
  const probe = runNativeStructuralBeam({
    ...common,
    workBudget: estimate,
    propose: () => [fixture.proposals[0] as NativeStructuralProposal],
  });
  const first = probe.evaluated[0];
  assert.ok(first !== undefined);
  assert.ok(first.cost < estimate);
  const workBudget = first.cost + estimate;
  const result = runNativeStructuralBeam({
    ...common,
    workBudget,
    propose: () => [
      fixture.proposals[2] as NativeStructuralProposal,
      fixture.proposals[1] as NativeStructuralProposal,
      fixture.proposals[0] as NativeStructuralProposal,
    ],
  });

  assert.equal(result.evaluated.length, 2);
  assert.deepEqual(
    result.evaluated.map(
      (node) => node.value.evaluation?.proposal.shapes[0]?.freqBase,
    ),
    [100, 110],
  );
  assert.equal(result.evaluated[0]?.cost, first.cost);
  const second = result.evaluated[1];
  assert.ok(second !== undefined);
  assert.ok(second.cost > 0 && second.cost < estimate);
  assert.equal(result.work.budget, workBudget);
  assert.equal(result.work.used, first.cost + second.cost);
  assert.equal(result.work.unused, workBudget - result.work.used);
  assert.ok(result.work.used <= workBudget);
  assert.deepEqual(result.work.skippedBudget, [
    {
      parentKey: 'native-root',
      candidateKey: result.skips.budget[0]?.candidateKey ?? '',
      depth: 1,
      estimatedWork: estimate,
      remainingWork: estimate - second.cost,
    },
  ]);
  assert.equal(result.history.length, 2);
  assert.notEqual(result.bestAny.candidateKey, null);
});

/** Честный native fixture: вторая retained-ветвь совместно решает оба атома. */
function widthControlFixture(): {
  source: ArgCreateSynth;
  truth: ArgCreateSynth;
  target: Int16Array;
  options: NativeStructuralBeamOptions;
  sampleCount: number;
} {
  const sampleCount = 2048;
  const trueGroups = [tone(73, 0.35, 0.2), tone(137, 0.03, 1.1)];
  const truth: ArgCreateSynth = {
    oscillators: [...structuredClone(trueGroups), offGroup(9)],
  };
  const source: ArgCreateSynth = {
    oscillators: [...structuredClone(trueGroups), offGroup(9)],
  };
  for (const group of source.oscillators.slice(0, 2)) {
    group.ampEnv.startLevel = 0.002;
    group.osc.phase += 2.1;
  }
  const target = renderForTarget(truth, sampleCount, 'legacy');
  const firstShape = shapeFromTone(trueGroups[0] as Group);
  const secondShape = shapeFromTone(trueGroups[1] as Group);
  const wrongSecond = {
    ...secondShape,
    freqBase: 191,
    freqStart: 223,
  };
  const maxInner = 8;
  const maxBacktracks = 12;
  const estimateOne = estimateStructuralCandidateWork({
    sampleCount,
    atomCount: 1,
    maxInner,
    maxBacktracks,
  });
  const estimateTwo = estimateStructuralCandidateWork({
    sampleCount,
    atomCount: 2,
    maxInner,
    maxBacktracks,
  });
  const options: NativeStructuralBeamOptions = {
    patch: source,
    target,
    beamWidth: 2,
    maxDepth: 2,
    maxGroupSize: 2,
    workBudget: 2 * estimateOne + 2 * estimateTwo,
    maxInner,
    maxBacktracks,
    propose: (parent) => {
      if (parent.depth === 0) {
        return [
          { slots: [0], shapes: [firstShape] },
          { slots: [1], shapes: [secondShape] },
        ];
      }
      if (parent.evaluation?.proposal.slots[0] === 0) {
        return [{ slots: [0, 1], shapes: [firstShape, wrongSecond] }];
      }
      return [{ slots: [0, 1], shapes: [firstShape, secondShape] }];
    },
  };
  return { source, truth, target, options, sampleCount };
}

test('shared-root width control finds better canonical native PCM with beam width 2', () => {
  const fixture = widthControlFixture();
  const sourceSnapshot = structuredClone(fixture.source);
  const control = runNativeStructuralBeamWithWidthControl(
    fixture.options,
  );
  const { beam, width1 } = control;

  assert.equal(beam.root.value, width1.root.value);
  assert.deepEqual(beam.root.value.patch, fixture.source);
  assert.equal(beam.work.budget, fixture.options.workBudget);
  assert.equal(width1.work.budget, fixture.options.workBudget);
  for (const result of [beam, width1]) {
    assert.ok(result.work.used <= fixture.options.workBudget);
    assert.equal(
      result.work.unused,
      fixture.options.workBudget - result.work.used,
    );
    assert.ok(result.proposed !== null);
    assert.deepEqual(
      result.patch.oscillators[2],
      fixture.source.oscillators[2],
    );
    assertPatchMatchesWav(
      result.patch,
      result.samples,
      'legacy',
      SAMPLE_RATE,
      fixture.sampleCount,
    );
  }
  assert.equal(width1.evaluated.length, 3);
  assert.equal(beam.evaluated.length, 4);
  assert.equal(beam.status, 'refined');
  assert.equal(width1.status, 'refined');
  assert.ok(maxAbsoluteError(beam.samples, fixture.target) <= 1);
  assert.ok(beam.metrics.globalSuppressionPercent > 99.99);
  assert.ok(
    width1.metrics.globalSuppressionPercent <
      beam.metrics.globalSuppressionPercent,
    JSON.stringify({ narrow: width1.metrics, wide: beam.metrics }),
  );
  assert.notDeepEqual(width1.samples, fixture.target);
  assert.equal(beam.bestAny.groupSize, 2);
  assert.equal(beam.bestAny.depth, 2);
  assert.deepEqual(fixture.source, sourceSnapshot);
});

test('repeated native runs preserve patch, PCM, path and all counters', () => {
  const firstFixture = coefficientFixture(2, 'integral', 1024);
  const secondFixture = coefficientFixture(2, 'integral', 1024);
  const first = runNativeStructuralBeam(firstFixture.options);
  const second = runNativeStructuralBeam(secondFixture.options);

  assert.deepEqual(first, second);
  assert.deepEqual(first.patch, second.patch);
  assert.deepEqual(first.samples, second.samples);
  assert.deepEqual(
    first.path.map((node) => node.nodeKey),
    second.path.map((node) => node.nodeKey),
  );
  assert.deepEqual(first.work, second.work);
  assert.deepEqual(first.denseWork, second.denseWork);
  assert.deepEqual(firstFixture.source, secondFixture.source);
});

test('native evaluator accepts K=50 without a hidden K1/K2 cap and keeps 50 slots', () => {
  const atomCount = 50;
  const sampleCount = 4;
  const slots = Array.from(
    { length: atomCount },
    (_, index) => index,
  );
  const shapes = Array.from({ length: atomCount }, (_, index) => {
    const atomShape = shape(40 + index * 17, index % 5);
    atomShape.freqStart = atomShape.freqBase;
    return atomShape;
  });
  const known = fixtureCoefficients(atomCount);
  const source = offSource();
  const sourceSnapshot = structuredClone(source);
  const truth = patchFromStructuralCandidate(source, {
    slots,
    shapes,
    coefficients: known.truth,
  });
  const target = renderForTarget(truth, sampleCount, 'legacy');
  const result = runNativeStructuralBeam({
    patch: source,
    target,
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 50,
    workBudget: estimateStructuralCandidateWork({
      sampleCount,
      atomCount,
      maxInner: 0,
      maxBacktracks: 0,
    }),
    maxInner: 0,
    maxBacktracks: 0,
    propose: () => [{ slots, shapes }],
  });

  assert.equal(result.evaluated.length, 1);
  assert.equal(result.evaluated[0]?.groupSize, 50);
  assert.equal(
    result.evaluated[0]?.value.patch.oscillators.length,
    50,
  );
  assert.ok(
    result.evaluated[0]?.value.patch.oscillators.every(
      (group) => group.osc.on,
    ),
  );
  assert.equal(
    result.evaluated[0]?.value.evaluation?.solver.diagnostics,
    null,
  );
  assert.deepEqual(result.skips.groupSize, []);
  assert.ok(result.proposed !== null);
  assert.ok(result.work.used <= result.work.budget);
  assert.equal(
    result.work.unused,
    result.work.budget - result.work.used,
  );
  assert.deepEqual(source, sourceSnapshot);
});

test('native measured propose reaches generic W without changing finalization', () => {
  const sampleCount = 256;
  const fixture = coefficientFixture(1, 'legacy', sampleCount);
  const result = runNativeStructuralBeam({
    patch: fixture.source,
    target: fixture.target,
    phaseModel: fixture.options.phaseModel,
    beamWidth: fixture.options.beamWidth,
    maxDepth: fixture.options.maxDepth,
    maxGroupSize: fixture.options.maxGroupSize,
    workBudget: fixture.options.workBudget + 2,
    maxInner: fixture.options.maxInner,
    maxBacktracks: fixture.options.maxBacktracks,
    estimateExpansion: () => 3,
    propose: () => ({
      candidates: [fixture.proposal],
      cost: 2,
    }),
  });

  const node = result.evaluated[0];
  assert.ok(node !== undefined);
  assert.equal(result.status, 'refined');
  assert.equal(result.expansionWork, 2);
  assert.equal(result.evaluatorWork, node.cost);
  assert.equal(result.work.used, node.cost + 2);
  assert.equal(
    result.work.unused,
    result.work.budget - result.work.used,
  );
  assert.deepEqual(result.expansions, [
    {
      parentKey: 'native-root',
      depth: 1,
      estimatedWork: 3,
      cost: 2,
      candidateKeys: [node.candidateKey],
    },
  ]);
  assert.deepEqual(result.skippedExpansionBudget, []);
  assert.equal(
    result.skips.expansionBudget,
    result.skippedExpansionBudget,
  );
  assert.deepEqual(
    result.denseWork,
    node.value.evaluation?.denseWork,
  );
  assert.equal(result.finalizationSampleWork, 5 * sampleCount);
});

test('width control creates independent stateful sessions with equal initial budget', () => {
  const fixture = widthControlFixture();
  const statelessPropose = fixture.options.propose;
  assert.ok(statelessPropose !== undefined);
  const expansionCost = 7;
  const sessionBudget = 3 * expansionCost;
  const sessions: {
    calls: number;
    cost: number;
    remaining: number;
  }[] = [];
  const callOrder: string[] = [];
  const control = runNativeStructuralBeamWithWidthControl({
    patch: fixture.source,
    target: fixture.target,
    beamWidth: fixture.options.beamWidth,
    maxDepth: fixture.options.maxDepth,
    maxGroupSize: fixture.options.maxGroupSize,
    workBudget: fixture.options.workBudget + sessionBudget,
    maxInner: fixture.options.maxInner,
    maxBacktracks: fixture.options.maxBacktracks,
    createProposerSession: () => {
      const sessionIndex = sessions.length;
      const audit = { calls: 0, cost: 0, remaining: sessionBudget };
      sessions.push(audit);
      return {
        estimateExpansion: (parent): number => {
          callOrder.push(
            `S${sessionIndex}:estimate:${parent.nodeKey}`,
          );
          return expansionCost;
        },
        propose: (parent): NativeStructuralProposeResult => {
          assert.ok(audit.remaining >= expansionCost);
          audit.calls += 1;
          audit.cost += expansionCost;
          audit.remaining -= expansionCost;
          callOrder.push(
            `S${sessionIndex}:propose:${parent.nodeKey}`,
          );
          const proposals = statelessPropose(parent);
          if (!Array.isArray(proposals)) {
            throw new Error('Expected the legacy proposal array');
          }
          return { candidates: proposals, cost: expansionCost };
        },
      };
    },
  });
  const { beam, width1 } = control;

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], { calls: 3, cost: 21, remaining: 0 });
  assert.deepEqual(sessions[1], { calls: 2, cost: 14, remaining: 7 });
  assert.deepEqual(callOrder.slice(0, 2), [
    'S0:estimate:native-root',
    'S0:propose:native-root',
  ]);
  assert.deepEqual(
    callOrder.filter((event) => event.startsWith('S1:')).slice(0, 2),
    ['S1:estimate:native-root', 'S1:propose:native-root'],
  );
  assert.equal(
    callOrder.filter((event) => event.startsWith('S0:')).length,
    6,
  );
  assert.equal(
    callOrder.filter((event) => event.startsWith('S1:')).length,
    4,
  );

  assert.equal(beam.root.value, width1.root.value);
  assert.equal(beam.work.budget, fixture.options.workBudget + 21);
  assert.equal(width1.work.budget, beam.work.budget);
  assert.equal(beam.expansions.length, 3);
  assert.equal(width1.expansions.length, 2);
  assert.equal(beam.expansionWork, 21);
  assert.equal(width1.expansionWork, 14);
  assert.equal(beam.evaluated.length, 4);
  assert.equal(width1.evaluated.length, 3);
  assert.notEqual(beam.expansions, width1.expansions);
  assert.notEqual(beam.work, width1.work);
  for (const result of [beam, width1]) {
    const evaluatorWork = result.history.reduce(
      (sum, entry) => sum + entry.cost,
      0,
    );
    assert.equal(result.evaluatorWork, evaluatorWork);
    assert.equal(
      result.work.used,
      result.evaluatorWork + result.expansionWork,
    );
    assert.equal(
      result.work.unused,
      result.work.budget - result.work.used,
    );
    assert.ok(result.work.used <= result.work.budget);
    assert.deepEqual(result.skippedExpansionBudget, []);
    assert.equal(result.status, 'refined');
    assert.equal(
      result.finalizationSampleWork,
      5 * fixture.sampleCount,
    );
    for (const expansion of result.expansions) {
      assert.equal(expansion.estimatedWork, expansionCost);
      assert.equal(expansion.cost, expansionCost);
    }
  }
});

/** Независимо повторяет прежнюю fixed-offset сумму без retained solo-cache. */
function assertNativeMemoryLayout(
  result: NativeStructuralBeamResult,
  sampleCount: number,
  phaseModel: PhaseModel,
): void {
  assert.ok(result.root.value.contributions !== null);
  assert.ok(
    result.evaluated.every(
      (node) => node.value.contributions === null,
    ),
  );
  const nodesByKey = new Map<string, NativeStructuralNode>([
    [result.root.nodeKey, result.root],
    ...result.evaluated.map(
      (node): [string, NativeStructuralNode] => [node.nodeKey, node],
    ),
  ]);
  const expectedSums = new Map<string, Float64Array>();
  const rootRaw = new Float64Array(sampleCount);
  for (const group of result.root.value.patch.oscillators) {
    if (!group.osc.on) {
      continue;
    }
    const contribution = renderGroup(group, sampleCount, phaseModel);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      rootRaw[sample] =
        (rootRaw[sample] ?? 0) + (contribution[sample] ?? 0);
    }
  }
  assert.deepEqual(result.root.value.rawSum, rootRaw);
  expectedSums.set(result.root.nodeKey, rootRaw);

  for (const [index, node] of result.evaluated.entries()) {
    const evaluation = node.value.evaluation;
    assert.ok(evaluation !== null);
    const parentKey = node.parentKey;
    assert.ok(parentKey !== null);
    const parent = nodesByKey.get(parentKey);
    assert.ok(parent !== undefined);
    const parentRaw = expectedSums.get(parentKey);
    assert.ok(parentRaw !== undefined);
    const expectedOffset = new Float64Array(parentRaw);
    let activeParentSlots = 0;
    for (const slot of evaluation.proposal.slots) {
      const previousGroup = parent.value.patch.oscillators[slot];
      if (previousGroup?.osc.on !== true) {
        continue;
      }
      const previous = renderGroup(
        previousGroup,
        sampleCount,
        phaseModel,
      );
      for (let sample = 0; sample < sampleCount; sample += 1) {
        expectedOffset[sample] =
          (expectedOffset[sample] ?? 0) - (previous[sample] ?? 0);
      }
      activeParentSlots += 1;
    }
    assert.deepEqual(evaluation.fixedOffset, expectedOffset);

    const expectedRaw = new Float64Array(expectedOffset);
    for (const slot of evaluation.proposal.slots) {
      const group = node.value.patch.oscillators[slot];
      assert.ok(group !== undefined && group.osc.on);
      const contribution = renderGroup(
        group,
        sampleCount,
        phaseModel,
      );
      for (let sample = 0; sample < sampleCount; sample += 1) {
        expectedRaw[sample] =
          (expectedRaw[sample] ?? 0) + (contribution[sample] ?? 0);
      }
    }
    assert.deepEqual(node.value.rawSum, expectedRaw);
    expectedSums.set(node.nodeKey, expectedRaw);

    const missingParentCache = parent.value.contributions === null;
    assert.equal(
      evaluation.canonicalWork.parentContributionRenders,
      missingParentCache ? activeParentSlots * sampleCount : 0,
    );
    const baseEstimate = estimateStructuralCandidateWork({
      sampleCount,
      atomCount: evaluation.proposal.slots.length,
      maxInner: 0,
      maxBacktracks: 0,
    });
    assert.equal(
      node.estimatedWork,
      baseEstimate +
        (missingParentCache
          ? evaluation.proposal.slots.length * sampleCount
          : 0),
    );
    const canonicalWork = evaluation.canonicalWork;
    assert.equal(
      canonicalWork.total,
      canonicalWork.fixedOffsetCopy +
        canonicalWork.parentContributionRenders +
        canonicalWork.selectedContributionRenders +
        canonicalWork.rawSumAssembly +
        canonicalWork.canonicalRender +
        canonicalWork.canonicalAssertion +
        canonicalWork.canonicalMetrics,
    );
    assert.equal(
      node.cost,
      evaluation.sampleWork.total + canonicalWork.total,
    );
    assert.ok(node.cost <= node.estimatedWork);
    const canonicalSamples = renderForTarget(
      node.value.patch,
      sampleCount,
      phaseModel,
    );
    assert.deepEqual(node.value.samples, canonicalSamples);
    assertPatchMatchesWav(
      node.value.patch,
      node.value.samples,
      phaseModel,
      SAMPLE_RATE,
      sampleCount,
    );

    const history = result.history[index];
    assert.ok(history !== undefined);
    assert.equal(history.fixedOffset, evaluation.fixedOffset);
    assert.equal(history.solver, evaluation.solver);
    assert.equal('contributions' in history, false);
  }

  assert.ok(result.proposed !== null);
  const proposedNode = nodesByKey.get(result.proposed.nodeKey);
  assert.ok(proposedNode !== undefined);
  assert.deepEqual(result.proposed.patch, proposedNode.value.patch);
  assert.deepEqual(
    result.proposed.samples,
    proposedNode.value.samples,
  );
  assert.deepEqual(
    result.samples,
    renderForTarget(result.patch, sampleCount, phaseModel),
  );
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    phaseModel,
    SAMPLE_RATE,
    sampleCount,
  );
  assert.equal(result.expansionWork, 0);
  assert.equal(result.evaluatorWork, result.work.used);
  assert.equal(
    result.evaluatorWork,
    result.history.reduce((sum, entry) => sum + entry.cost, 0),
  );
  assert.ok(result.work.used <= result.work.budget);
  assert.equal(
    result.work.unused,
    result.work.budget - result.work.used,
  );
  assert.deepEqual(result.skips.budget, []);
}

test('evaluated nodes release solo caches without changing sums, PCM, W or width control', (t) => {
  const sampleCount = 2048;
  const atomCount = 2;
  const phaseModel: PhaseModel = 'legacy';
  const source: ArgCreateSynth = {
    oscillators: Array.from({ length: 50 }, (_, index) =>
      tone(
        45 + index * 11,
        0.004 + (index % 4) * 0.001,
        (index * 0.37) % TWO_PI,
      ),
    ),
  };
  const target = renderForTarget(source, sampleCount, phaseModel);
  const baseEstimate = estimateStructuralCandidateWork({
    sampleCount,
    atomCount,
    maxInner: 0,
    maxBacktracks: 0,
  });
  const workBudget =
    3 * baseEstimate + 12 * (baseEstimate + atomCount * sampleCount);
  const rssBefore = process.memoryUsage().rss;
  const control = runNativeStructuralBeamWithWidthControl({
    patch: source,
    target,
    phaseModel,
    beamWidth: 2,
    maxDepth: 3,
    maxGroupSize: atomCount,
    workBudget,
    maxInner: 0,
    maxBacktracks: 0,
    propose: (parent) => {
      const firstSlot = (parent.depth * 3) % 47;
      const slots = [firstSlot, firstSlot + 1];
      return [0, 1, 2].map((variant) => ({
        slots,
        shapes: slots.map((slot, atom) =>
          shape(
            65 + slot * 9 + variant * 17 + atom * 3,
            parent.depth + variant + atom,
          ),
        ),
      }));
    },
  });

  assert.equal(control.beam.root.value, control.width1.root.value);
  assert.equal(control.beam.root.value.contributions?.length, 50);
  assert.equal(control.beam.evaluated.length, 15);
  assert.equal(control.width1.evaluated.length, 9);
  assert.equal(control.beam.work.used, workBudget);
  assert.equal(
    control.width1.work.used,
    3 * baseEstimate + 6 * (baseEstimate + atomCount * sampleCount),
  );
  for (const [result, deepCandidates] of [
    [control.beam, 12],
    [control.width1, 6],
  ] as const) {
    assert.equal(
      result.history.reduce(
        (sum, entry) =>
          sum + entry.canonicalWork.parentContributionRenders,
        0,
      ),
      deepCandidates * atomCount * sampleCount,
    );
  }
  assertNativeMemoryLayout(control.beam, sampleCount, phaseModel);
  assertNativeMemoryLayout(control.width1, sampleCount, phaseModel);
  const rssAfter = process.memoryUsage().rss;
  t.diagnostic(
    `bounded 50-atom fixture retained 24 evaluated nodes; ` +
      `RSS ${(rssAfter / 2 ** 20).toFixed(1)} MiB ` +
      `(delta ${((rssAfter - rssBefore) / 2 ** 20).toFixed(1)} MiB); ` +
      'диагностика без абсолютного RSS-порога',
  );
});
