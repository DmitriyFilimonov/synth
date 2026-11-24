import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAMPLE_RATE } from '../consts';
import { computeUsefulZone } from '../optimize/evaluate';
import type { ArgCreateSynth } from '../synth';
import { fitQuadratureBlock } from './block-pursuit';
import { refitClippedQuadratureAtom } from './joint-projection-oracle';
import {
  canonicalizeLocalizedFitBoundary,
  evaluateLocalizedCandidates,
  finalizeLocalizedCandidate,
  fitFromTwoCoefficients,
  groupFromLocalizedAtom,
  LOCALIZED_CONTINUATION_GATE,
  LOCALIZED_TRANSIENT_LIMITS,
  localizedContinuationGate,
  localizedHighGuardRejectionReasons,
  localizedProposalRejectionReasons,
  prepareLocalizedContext,
  rankLocalizedHighSlots,
  runLocalizedTransientExperiment,
  validHighSweep,
  type LocalizedAtomDescription,
} from './localized-transient';
import {
  clonePatch,
  createInitialState,
  measureMetrics,
  renderForTarget,
  renderGroup,
  unitGroup,
  type QuadratureFit,
} from './quadrature-refit';

function description(
  overrides: Partial<LocalizedAtomDescription> = {},
): LocalizedAtomDescription {
  const supportSamples = 882;
  return {
    frequency: 3000,
    freqStart: 9000,
    duration: supportSamples / SAMPLE_RATE,
    slope: 1.4,
    oscDuration: 0.03,
    oscSlope: 0.8,
    window: 'attack',
    localGain: 0,
    peakMagnitude: 1,
    sweepTemplateIndex: null,
    delaySamples: 221,
    attackSamples: 22,
    supportSamples,
    cellRegion: 'attack',
    ...overrides,
  };
}

function fit(level: number, phase: number): QuadratureFit {
  return {
    sineCoefficient: level * Math.cos(phase),
    cosineCoefficient: level * Math.sin(phase),
    startLevel: level,
    phase,
  };
}

function silentBaseWithLow(): ArgCreateSynth {
  return {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 80,
          freqStart: 80,
          duration: 0.4,
          slope: 1,
          phase: 0.2,
        },
        ampEnv: {
          startLevel: 0.3,
          endLevel: 0.01,
          duration: 0.4,
          slope: 1,
        },
      },
      {
        osc: {
          on: false,
          freqBase: 6000,
          freqStart: 6000,
          duration: 0.005,
          slope: 1,
          phase: 0,
        },
        ampEnv: {
          startLevel: 0.001,
          endLevel: 0.001,
          duration: 0.005,
          slope: 2,
        },
      },
    ],
  };
}

test('group validates integer times and never clamps frequencies', () => {
  for (const value of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () =>
        groupFromLocalizedAtom(
          description({ delaySamples: value }),
          fit(0.2, 0.4),
        ),
      /delaySamples/,
    );
  }
  assert.throws(
    () =>
      groupFromLocalizedAtom(
        description({ supportSamples: 0, duration: 0 }),
        fit(0.2, 0.4),
      ),
    /supportSamples/,
  );
  assert.throws(
    () =>
      groupFromLocalizedAtom(
        description({ frequency: 30001 }),
        fit(0.2, 0.4),
      ),
    /frequency/,
  );
  assert.throws(
    () =>
      groupFromLocalizedAtom(
        description({ freqStart: 9000, duration: 0.01 }),
        fit(0.2, 0.4),
      ),
    /description.duration/,
  );
});

test('high sweep admits 16000 Hz boundary and rejects either frequency above it', () => {
  const boundary = LOCALIZED_TRANSIENT_LIMITS.maxHighHz;
  assert.equal(boundary, 16000);
  assert.equal(
    validHighSweep(
      description({ frequency: boundary, freqStart: boundary }),
    ),
    true,
  );
  assert.equal(
    validHighSweep(
      description({
        frequency: boundary,
        freqStart: boundary + 0.001,
      }),
    ),
    false,
  );
  assert.equal(
    validHighSweep(
      description({
        frequency: boundary + 0.001,
        freqStart: boundary,
      }),
    ),
    false,
  );
});

test('zero onset and zero sweep controls preserve the pre-support atom', () => {
  const control = description({
    frequency: 6000,
    freqStart: 6000,
    delaySamples: 0,
    attackSamples: 0,
  });
  const group = groupFromLocalizedAtom(control, fit(0.2, 0.4));
  assert.equal(group.osc.delay, 0);
  assert.equal(group.osc.freqStart, group.osc.freqBase);
  assert.equal(group.ampEnv.attack, 0);
  assert.equal(group.ampEnv.hardStop, true);
  const legacyEquivalent = clonePatch({ oscillators: [group] })
    .oscillators[0];
  assert.ok(legacyEquivalent);
  delete legacyEquivalent.osc.delay;
  delete legacyEquivalent.ampEnv.attack;
  delete legacyEquivalent.ampEnv.hardStop;
  const actual = renderGroup(
    group,
    control.supportSamples,
    'integral',
  );
  const expected = renderGroup(
    legacyEquivalent,
    control.supportSamples,
    'integral',
  );
  assert.deepEqual(actual, expected);
});

test('bounded fit recovers high chirp 9000 to 3000 with onset, attack, level and phase', () => {
  const shape = description();
  const source: ArgCreateSynth = {
    oscillators: [groupFromLocalizedAtom(shape, fit(0.22, 1.3))],
  };
  const target = renderForTarget(source, 4096, 'integral');
  const template = groupFromLocalizedAtom(shape, fit(1, 0));
  const basis = [
    renderGroup(unitGroup(template, 0), target.length, 'integral'),
    renderGroup(
      unitGroup(template, Math.PI / 2),
      target.length,
      'integral',
    ),
  ];
  const fits = fitQuadratureBlock({
    basis,
    target,
    rawWithout: new Float64Array(target.length),
  });
  const fitted = fits?.[0];
  assert.ok(fitted);
  const patch: ArgCreateSynth = {
    oscillators: [groupFromLocalizedAtom(shape, fitted)],
  };
  const samples = renderForTarget(patch, target.length, 'integral');
  const metrics = measureMetrics(
    samples,
    Array.from(target),
    SAMPLE_RATE,
    computeUsefulZone(Array.from(target), SAMPLE_RATE),
  );
  assert.ok(metrics.globalSuppressionPercent > 99);
  assert.ok(Math.abs(fitted.startLevel - 0.22) < 1e-3);
  assert.ok(
    Math.abs(
      Math.atan2(
        Math.sin(fitted.phase - 1.3),
        Math.cos(fitted.phase - 1.3),
      ),
    ) < 1e-3,
  );
  assert.deepEqual(
    patch.oscillators[0]?.osc.delay,
    221 / SAMPLE_RATE,
  );
  assert.equal(patch.oscillators[0]?.ampEnv.attack, 22 / SAMPLE_RATE);
});

test('raw and refit canonicalize one-ulp max boundary without a substantive clamp', () => {
  const basis = [
    Float64Array.from([1, 0]),
    Float64Array.from([0, 1]),
  ];
  const rawAngle = (2 * Math.PI * 7) / 128;
  const rawTarget = [
    2 * Math.cos(rawAngle) * 32767,
    2 * Math.sin(rawAngle) * 32767,
  ];
  const raw = fitQuadratureBlock({
    basis,
    target: rawTarget,
    rawWithout: new Float64Array(2),
  })?.[0];
  assert.ok(raw);
  assert.equal(raw.startLevel, 1.0000000000000002);
  const canonicalRaw = canonicalizeLocalizedFitBoundary(raw);
  assert.ok(canonicalRaw);
  assert.equal(canonicalRaw.startLevel, 1);
  assert.ok(
    Math.abs(
      Math.hypot(
        canonicalRaw.sineCoefficient,
        canonicalRaw.cosineCoefficient,
      ) - 1,
    ) <= Number.EPSILON,
  );
  assert.doesNotThrow(() =>
    groupFromLocalizedAtom(description(), canonicalRaw),
  );

  const refitAngle = (2 * Math.PI * 77) / 128;
  const cosine = Math.cos(refitAngle);
  const sine = Math.sin(refitAngle);
  const refit = refitClippedQuadratureAtom({
    basis,
    target: [cosine, sine],
    fixedOffset: [0, 0],
    initialCoefficients: [2 * cosine, 2 * sine],
    maxIterations: 1,
  });
  assert.equal(
    Math.hypot(
      refit.objective.coefficients[0] ?? 0,
      refit.objective.coefficients[1] ?? 0,
    ),
    1.0000000000000002,
  );
  const canonicalRefit = fitFromTwoCoefficients(
    refit.objective.coefficients,
  );
  assert.ok(canonicalRefit);
  assert.equal(canonicalRefit.startLevel, 1);
  assert.ok(
    Math.abs(
      Math.hypot(
        canonicalRefit.sineCoefficient,
        canonicalRefit.cosineCoefficient,
      ) - 1,
    ) <= Number.EPSILON,
  );
  assert.doesNotThrow(() =>
    groupFromLocalizedAtom(description(), canonicalRefit),
  );
  assert.equal(fitFromTwoCoefficients([1.000000000001, 0]), null);
});

test('high guard rejects global growth when selected high RSS grows', () => {
  const before = { selectedCellRss: 2, totalHighRss: 5 };
  const after = { selectedCellRss: 2.1, totalHighRss: 4.9 };
  assert.deepEqual(
    localizedHighGuardRejectionReasons({ before, after }),
    ['selected high cell RSS не уменьшился'],
  );
  const reasons = localizedProposalRejectionReasons({
    baseline: {
      globalSuppressionPercent: 80,
      windowedSuppressionPercent: 85,
    },
    metrics: {
      globalSuppressionPercent: 81,
      windowedSuppressionPercent: 85,
    },
    before,
    after,
  });
  assert.ok(!reasons.includes('global не вырос'));
  assert.ok(reasons.includes('selected high cell RSS не уменьшился'));
});

test('slot ranking never replaces a low oscillator with the localized atom', () => {
  const low: ArgCreateSynth = {
    oscillators: [
      groupFromLocalizedAtom(
        description({ frequency: 3000, freqStart: 3000 }),
        fit(0.1, 0.2),
      ),
    ],
  };
  const lowGroup = low.oscillators[0];
  assert.ok(lowGroup);
  lowGroup.osc.freqBase = 80;
  lowGroup.osc.freqStart = 80;
  lowGroup.osc.delay = 0;
  lowGroup.ampEnv.attack = 0;
  lowGroup.ampEnv.hardStop = false;
  lowGroup.ampEnv.duration = 0.2;
  low.oscillators.push(
    {
      osc: {
        on: true,
        freqBase: 4000,
        freqStart: 4000,
        duration: 0.02,
        slope: 1,
        phase: 0.3,
      },
      ampEnv: {
        startLevel: 0.05,
        endLevel: 0.001,
        duration: 0.02,
        slope: 1,
      },
    },
    {
      osc: {
        on: false,
        freqBase: 5000,
        freqStart: 5000,
        duration: 0.02,
        slope: 1,
        phase: 0,
      },
      ampEnv: {
        startLevel: 0.001,
        endLevel: 0.001,
        duration: 0.02,
        slope: 1,
      },
    },
  );
  const target = renderForTarget(low, 4096, 'integral');
  const values = Array.from(target);
  const state = createInitialState({
    patch: low,
    target: values,
    sampleRate: SAMPLE_RATE,
    phaseModel: 'integral',
    usefulZone: computeUsefulZone(values, SAMPLE_RATE),
  });
  const contributions = low.oscillators.map((group) =>
    group.osc.on
      ? renderGroup(group, target.length, 'integral')
      : null,
  );
  const choices = rankLocalizedHighSlots({
    state,
    contributions,
    target: values,
  });
  assert.deepEqual(
    choices.map((choice) => choice.slot),
    [2, 1],
  );
  assert.ok(!choices.some((choice) => choice.slot === 0));
});

test('exact base falls back with identical patch/WAV and zero exact cost', () => {
  const patch: ArgCreateSynth = {
    oscillators: [
      groupFromLocalizedAtom(description(), fit(0.22, 1.3)),
    ],
  };
  const target = renderForTarget(patch, 4096, 'integral');
  const snapshot = structuredClone(patch);
  const result = runLocalizedTransientExperiment({
    patch,
    target,
    phaseModel: 'integral',
  });
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.patch, snapshot);
  assert.deepEqual(result.samples, target);
  assert.deepEqual(patch, snapshot);
  assert.equal(result.cost.exactEvaluations, 0);
  assert.equal(result.saved.globalDelta, 0);
  assert.equal(result.q4Pass, null);
});

test('nonempty search with every exact proposal rejected returns the source', () => {
  const patch = silentBaseWithLow();
  const targetPatch = clonePatch(patch);
  const targetShape = description({
    frequency: 6000,
    freqStart: 6000,
    duration: 221 / SAMPLE_RATE,
    oscDuration: 221 / SAMPLE_RATE,
    oscSlope: 1,
    delaySamples: 220,
    supportSamples: 221,
  });
  targetPatch.oscillators[1] = groupFromLocalizedAtom(
    targetShape,
    fit(0.18, 0.7),
  );
  const target = renderForTarget(targetPatch, 4096, 'integral');
  const prepared = prepareLocalizedContext({
    patch,
    target,
    phaseModel: 'integral',
  });
  const wrongShape = description({
    frequency: 1000,
    freqStart: 1000,
    duration: 44 / SAMPLE_RATE,
    oscDuration: 44 / SAMPLE_RATE,
    oscSlope: 1,
    window: 'early',
    delaySamples: 220,
    attackSamples: 0,
    supportSamples: 44,
    cellRegion: 'early',
  });
  const evaluated = evaluateLocalizedCandidates({
    context: prepared.context,
    slots: prepared.slots.slice(0, 1),
    descriptions: [wrongShape],
    cost: prepared.cost,
  });
  assert.ok(prepared.selectedCells.length > 0);
  assert.equal(evaluated.attempts.length, 1);
  assert.ok(prepared.cost.exactEvaluations > 0);
  assert.equal(evaluated.winner, null);
  assert.ok(
    evaluated.attempts.every(
      (attempt) =>
        attempt.raw?.accepted === false &&
        attempt.refit?.accepted === false,
    ),
  );
  const result = finalizeLocalizedCandidate({
    ...evaluated,
    context: prepared.context,
    baselineTimeBands: prepared.context.baselineTimeBands,
    baselineClipping: prepared.baselineClipping,
    selectedCells: prepared.selectedCells,
    slots: prepared.slots.slice(0, 1),
    cost: prepared.cost,
  });
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.patch, patch);
  assert.deepEqual(result.samples, prepared.context.state.samples);
  assert.equal(result.cost.canonicalFinalRenders, 0);
});

test('synthetic search saves one high atom and respects exact/canonical guards', () => {
  const base = silentBaseWithLow();
  const highShape = description({
    frequency: 6000,
    freqStart: 6000,
    duration: 221 / SAMPLE_RATE,
    slope: 2,
    oscDuration: 221 / SAMPLE_RATE,
    oscSlope: 1,
    delaySamples: 220,
    attackSamples: 22,
    supportSamples: 221,
  });
  const targetPatch = clonePatch(base);
  targetPatch.oscillators[1] = groupFromLocalizedAtom(
    highShape,
    fit(0.18, 0.7),
  );
  const target = renderForTarget(targetPatch, 4096, 'integral');
  const result = runLocalizedTransientExperiment({
    patch: base,
    target,
    phaseModel: 'integral',
  });
  assert.equal(result.status, 'refined');
  assert.equal(result.saved.status, 'refined');
  assert.ok(result.saved.globalDelta > 0);
  assert.ok(result.saved.windowedDelta >= -0.05);
  assert.ok(result.proposedRaw !== null);
  assert.ok(result.proposedRefit !== null);
  assert.ok(result.cost.rawExactEvaluations <= 4);
  assert.ok(result.cost.clipRefitEvaluations <= 4);
  assert.ok(result.cost.exactEvaluations <= 16);
  assert.ok(result.patch.oscillators.length <= 50);
  assert.ok(result.saved.high !== null);
  assert.ok(
    result.saved.high.selectedCellRssAfter <
      result.saved.high.selectedCellRssBefore,
  );
  assert.ok(
    result.saved.high.totalHighRssAfter <
      result.saved.high.totalHighRssBefore,
  );
  assert.deepEqual(
    result.samples,
    renderForTarget(result.patch, target.length, 'integral'),
  );
});

test('two high cells and two free slots never exceed sixteen exact evaluations', () => {
  const base = silentBaseWithLow();
  const off = base.oscillators[1];
  assert.ok(off);
  base.oscillators.push(structuredClone(off));
  const targetPatch = clonePatch(base);
  const attackShape = description({
    frequency: 6000,
    freqStart: 6000,
    duration: 221 / SAMPLE_RATE,
    slope: 2,
    oscDuration: 221 / SAMPLE_RATE,
    oscSlope: 1,
    delaySamples: 220,
    attackSamples: 22,
    supportSamples: 221,
    cellRegion: 'attack',
  });
  const earlyShape = description({
    frequency: 4000,
    freqStart: 4000,
    duration: 221 / SAMPLE_RATE,
    slope: 2,
    oscDuration: 221 / SAMPLE_RATE,
    oscSlope: 1,
    window: 'early',
    delaySamples: 1323,
    attackSamples: 22,
    supportSamples: 221,
    cellRegion: 'early',
  });
  targetPatch.oscillators[1] = groupFromLocalizedAtom(
    attackShape,
    fit(0.14, 0.7),
  );
  targetPatch.oscillators[2] = groupFromLocalizedAtom(
    earlyShape,
    fit(0.12, 1.1),
  );
  const target = renderForTarget(targetPatch, 4096, 'integral');
  const result = runLocalizedTransientExperiment({
    patch: base,
    target,
    phaseModel: 'integral',
  });
  assert.equal(result.selectedCells.length, 2);
  assert.deepEqual(
    new Set(result.selectedCells.map((cell) => cell.region)),
    new Set(['attack', 'early']),
  );
  assert.equal(result.slots.length, 2);
  assert.ok(result.cost.exactEvaluations <= 16);
  assert.ok(result.cost.rawExactEvaluations <= 8);
  assert.ok(result.cost.clipRefitEvaluations <= 8);
  for (const choice of result.slots) {
    assert.ok(
      result.attempts.filter(
        (attempt) => attempt.slot === choice.slot,
      ).length <= 4,
    );
  }
});

test('canonical rejection after accepted exact keeps first-winner fallback semantics', () => {
  const base = silentBaseWithLow();
  const shape = description({
    frequency: 3000,
    freqStart: 9000,
    delaySamples: 220,
  });
  const targetPatch = clonePatch(base);
  targetPatch.oscillators[1] = groupFromLocalizedAtom(
    shape,
    fit(0.18, 0.7),
  );
  const target = renderForTarget(targetPatch, 4096, 'integral');
  const prepared = prepareLocalizedContext({
    patch: base,
    target,
    phaseModel: 'integral',
  });
  const second = description({
    ...shape,
    duration: 441 / SAMPLE_RATE,
    supportSamples: 441,
  });
  const evaluated = evaluateLocalizedCandidates({
    context: prepared.context,
    slots: prepared.slots.slice(0, 1),
    descriptions: [shape, second],
    cost: prepared.cost,
  });
  assert.ok(evaluated.winner);
  assert.equal(evaluated.winner.audit.accepted, true);
  const acceptedCount = evaluated.attempts
    .flatMap((attempt) => [attempt.raw, attempt.refit])
    .filter((proposal) => proposal?.accepted === true).length;
  assert.ok(acceptedCount > 1);
  const result = finalizeLocalizedCandidate({
    ...evaluated,
    context: { ...prepared.context, phaseModel: 'legacy' },
    baselineTimeBands: prepared.context.baselineTimeBands,
    baselineClipping: prepared.baselineClipping,
    selectedCells: prepared.selectedCells,
    slots: prepared.slots.slice(0, 1),
    cost: prepared.cost,
  });
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.patch, base);
  assert.deepEqual(result.samples, prepared.context.state.samples);
  assert.equal(result.saved.kind, null);
  assert.ok(
    result.saved.rejectionReasons.some((reason) =>
      reason.startsWith('canonical:'),
    ),
  );
  assert.equal(result.cost.canonicalFinalRenders, 1);
  assert.equal(result.attempts.length, 2);
});

test('continuation gate uses only saved mean, two improvements, J floor and high guards', () => {
  const passing = [1, 1, 0, 0].map((savedGlobalDelta) => ({
    status:
      savedGlobalDelta > 0
        ? ('refined' as const)
        : ('unchanged' as const),
    savedGlobalDelta,
    savedWindowed: 80,
    baselineWindowed: 80,
    acceptedHighGuard: true,
  }));
  const gate = localizedContinuationGate(passing);
  assert.equal(gate.pass, true);
  assert.equal(gate.meanSavedGlobalDelta, 0.5);
  assert.equal(
    LOCALIZED_CONTINUATION_GATE.minMeanSavedGlobalDelta,
    0.5,
  );
  assert.equal(
    localizedContinuationGate(
      passing.map((run) => ({ ...run, savedGlobalDelta: 0.49 })),
    ).pass,
    false,
  );
  assert.equal(
    localizedContinuationGate(
      passing.map((run, index) =>
        index === 0 ? { ...run, acceptedHighGuard: false } : run,
      ),
    ).pass,
    false,
  );
  assert.equal(
    localizedContinuationGate(
      passing.map((run, index) =>
        index === 0
          ? { ...run, savedWindowed: 79.94, baselineWindowed: 80 }
          : run,
      ),
    ).pass,
    false,
  );
});
