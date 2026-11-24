import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAMPLE_RATE } from '../consts';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { assertPatchMatchesWav } from './beat-transfer-run';
import { FULL_PATCH_OUTER_BOUNDS } from './full-patch-jacobian';
import {
  canonicalFullPatchOuterValue,
  FULL_PATCH_FINALIZATION_SAMPLE_PASSES,
  passesFullPatchCanonicalGuard,
  projectFullPatchKaufmanColumns,
  runFullPatchVariableProjection,
  solveFullPatchClipAwareBasis,
  type FullPatchVpResult,
} from './full-patch-vp';
import { quantizeRaw, renderForTarget } from './quadrature-refit';

type Group = ArgCreateSynth['oscillators'][number];

/** Создаёт активный затухающий тон в явных физических нормах. */
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

/** Рендерит точное число canonical PCM-отсчётов. */
function render(
  patch: ArgCreateSynth,
  sampleCount: number,
  phaseModel: PhaseModel = 'integral',
): Int16Array {
  return renderForTarget(patch, sampleCount, phaseModel);
}

/** Проверяет все поля, которые full-patch VP обязан сохранить. */
function assertImmutableFields(
  before: ArgCreateSynth,
  after: ArgCreateSynth,
): void {
  assert.equal(after.oscillators.length, before.oscillators.length);
  for (let index = 0; index < before.oscillators.length; index += 1) {
    const source = before.oscillators[index];
    const candidate = after.oscillators[index];
    assert.ok(source !== undefined);
    assert.ok(candidate !== undefined);
    if (!source.osc.on) {
      assert.deepEqual(candidate, source);
      continue;
    }
    assert.deepEqual(candidate.osc.on, source.osc.on);
    assert.deepEqual(candidate.osc.delay, source.osc.delay);
    assert.deepEqual(candidate.ampEnv.attack, source.ampEnv.attack);
    assert.deepEqual(
      candidate.ampEnv.hardStop,
      source.ampEnv.hardStop,
    );
  }
}

/** Проверяет конечность всей численной диагностики и границы уровней. */
function assertFiniteResult(result: FullPatchVpResult): void {
  for (const group of result.patch.oscillators) {
    assert.ok(Number.isFinite(group.ampEnv.startLevel));
    assert.ok(group.ampEnv.startLevel >= 0.001);
    assert.ok(group.ampEnv.startLevel <= 1);
    assert.ok(Number.isFinite(group.osc.phase));
  }
  for (const iteration of result.history) {
    assert.ok(Number.isFinite(iteration.lambda));
    assert.ok(Number.isFinite(iteration.rssBefore));
    assert.ok(
      iteration.rssAfter === null ||
        Number.isFinite(iteration.rssAfter),
    );
    assert.ok(
      iteration.inner?.diagnostics?.eigenvalues.every(
        Number.isFinite,
      ) ?? true,
    );
  }
  assert.ok(Number.isFinite(result.cost.sampleWork.total));
}

/** Возвращает mixed patch с тремя разными механизмами и off-слотом. */
function threeAtomTruth(): ArgCreateSynth {
  const constant = tone(63, 0.24, 0.37);
  constant.ampEnv.duration = 0.061;
  constant.ampEnv.endLevel = 0.025;
  const swept = tone(87, 0.17, 1.43);
  swept.osc.freqStart = 238;
  swept.osc.duration = 0.017;
  swept.osc.slope = 1.25;
  swept.ampEnv.duration = 0.043;
  swept.ampEnv.endLevel = 0.035;
  swept.ampEnv.slope = 0.9;
  const localized = tone(1370, 0.13, 2.1);
  localized.osc.freqStart = 920;
  localized.osc.duration = 0.006;
  localized.osc.slope = 0.8;
  localized.osc.delay = 173 / SAMPLE_RATE;
  localized.ampEnv.attack = 19 / SAMPLE_RATE;
  localized.ampEnv.duration = 0.0047;
  localized.ampEnv.endLevel = 0.02;
  localized.ampEnv.slope = 1.4;
  localized.ampEnv.hardStop = true;
  const off = tone(4321, 0.19, 2.8);
  off.osc.on = false;
  off.osc.delay = 0.013;
  off.ampEnv.attack = 0.002;
  off.ampEnv.hardStop = true;
  return { oscillators: [constant, swept, localized, off] };
}

/** Детерминированно портит только разрешённые формы и квадратуры. */
function corruptThreeAtomPatch(
  source: ArgCreateSynth,
): ArgCreateSynth {
  const patch = structuredClone(source);
  const factors = [
    [1.015, 0.985, 1.03, 0.98, 1.02, 1.04, 0.97],
    [0.93, 1.08, 0.87, 1.14, 0.89, 1.12, 1.09],
    [1.04, 0.95, 1.09, 0.91, 1.11, 0.86, 1.07],
  ];
  for (let active = 0; active < 3; active += 1) {
    const group = patch.oscillators[active];
    const factor = factors[active];
    assert.ok(group !== undefined);
    assert.ok(factor !== undefined);
    group.osc.freqBase *= factor[0] ?? 1;
    group.osc.freqStart *= factor[1] ?? 1;
    group.osc.slope *= factor[2] ?? 1;
    group.osc.duration *= factor[3] ?? 1;
    group.ampEnv.duration *= factor[4] ?? 1;
    group.ampEnv.endLevel =
      (group.ampEnv.endLevel ?? 0.001) * (factor[5] ?? 1);
    group.ampEnv.slope *= factor[6] ?? 1;
    group.ampEnv.startLevel *= 0.8 + active * 0.05;
    group.osc.phase =
      (group.osc.phase + 1.1 + active * 0.4) % (2 * Math.PI);
  }
  return patch;
}

test('joint inner solve recovers a constant tone in both phase models', () => {
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const truth: ArgCreateSynth = {
      oscillators: [tone(73, 0.4, 0.37)],
    };
    const truthGroup = truth.oscillators[0];
    assert.ok(truthGroup !== undefined);
    truthGroup.ampEnv.endLevel = 1;
    const initial = structuredClone(truth);
    const group = initial.oscillators[0];
    assert.ok(group !== undefined);
    group.ampEnv.startLevel = 0.16;
    group.osc.phase = 2.2;
    const snapshot = structuredClone(initial);
    const result = runFullPatchVariableProjection({
      patch: initial,
      target: render(truth, 1056, phaseModel),
      phaseModel,
      maxOuter: 0,
      maxInner: 8,
      maxBacktracks: 16,
    });
    assert.equal(result.status, 'refined', phaseModel);
    assert.ok(
      result.metrics.globalSuppressionPercent > 99.99,
      phaseModel,
    );
    assert.equal(result.history.length, 0);
    assert.deepEqual(initial, snapshot);
    const target = render(truth, 1056, phaseModel);
    const maxError = Math.max(
      ...Array.from(result.samples, (value, index) =>
        Math.abs(value - (target[index] ?? 0)),
      ),
    );
    assert.ok(maxError <= 1, `${phaseModel}: ${maxError} LSB`);
    assert.deepEqual(
      result.samples,
      render(result.patch, 1056, phaseModel),
    );
  }
});

test('three corrupted atoms recover constant, swept and delayed localized forms', () => {
  const truth = threeAtomTruth();
  const initial = corruptThreeAtomPatch(truth);
  const snapshot = structuredClone(initial);
  const sampleCount = 4092;
  const target = render(truth, sampleCount);
  const result = runFullPatchVariableProjection({
    patch: initial,
    target,
    phaseModel: 'integral',
    maxOuter: 72,
    maxInner: 10,
    maxBacktracks: 18,
  });
  assert.equal(
    result.status,
    'refined',
    result.rejectionReason ?? 'not refined',
  );
  assert.ok(
    result.metrics.globalSuppressionPercent > 99.5,
    JSON.stringify({
      metrics: result.metrics,
      proposed: result.proposed?.metrics,
      history: result.history.length,
      accepted: result.history.filter((entry) => entry.accepted)
        .length,
      patch: result.proposed?.patch,
    }),
  );
  const recoveredAfterRejection = result.history.some(
    (entry, index) => {
      const next = result.history[index + 1];
      return (
        !entry.accepted &&
        next !== undefined &&
        next.lambda > entry.lambda &&
        result.history
          .slice(index + 1)
          .some((later) => later.accepted)
      );
    },
  );
  assert.ok(recoveredAfterRejection);
  assertImmutableFields(initial, result.patch);
  assert.deepEqual(initial, snapshot);
  assert.deepEqual(
    result.patch.oscillators[3],
    truth.oscillators[3],
    JSON.stringify({
      actual: result.patch.oscillators[3],
      expected: truth.oscillators[3],
    }),
  );
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    'integral',
    SAMPLE_RATE,
    sampleCount,
  );
  assert.ok(result.proposed !== null);
  assert.equal(result.proposed.canonicalValid, true);
  assert.ok(result.proposed.outerIteration !== null);
  const baselineSamples = render(initial, sampleCount);
  let initialRss = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const error =
      (baselineSamples[index] ?? 0) - (target[index] ?? 0);
    initialRss += error * error;
  }
  assert.ok(result.proposed.clippedPcmRss < initialRss);
});

test('clip trap selects PCM optimum 1.5 instead of raw optimum 1.1', () => {
  const shape = Float64Array.from([1, 0.5]);
  const zero = new Float64Array(2);
  const result = solveFullPatchClipAwareBasis({
    basis: [shape, zero, shape, zero],
    target: [1, 0.75],
    initialCoefficients: [0.55, 0, 0.55, 0],
    maxInner: 6,
    maxBacktracks: 12,
  });
  assert.equal(result.audit.success, true, result.audit.stopReason);
  const sine =
    (result.coefficients[0] ?? 0) + (result.coefficients[2] ?? 0);
  assert.ok(Math.abs(sine - 1.5) < 1e-4, `sine=${sine}`);
  assert.ok(Math.abs((result.raw[0] ?? 0) - 1.5) < 1e-4);
  assert.ok(Math.abs((result.raw[1] ?? 0) - 0.75) < 1e-4);
  assert.ok((result.audit.diagnostics?.effectiveRank ?? 0) < 4);
  assert.ok(result.audit.maskRecomputations > 1);
  assert.equal(result.saturatedSamples, 1);
  assert.equal(result.clippedPcmRss, 0);
  assert.deepEqual(result.samples, quantizeRaw([1, 0.75]));
});

test('Kaufman projection removes the coefficient subspace and honors bounds', () => {
  const basis = [
    Float64Array.from([1, 0]),
    Float64Array.from([0, 0]),
  ];
  const fixedCoefficientColumn = Float64Array.from([1, 1]);
  const projected = projectFullPatchKaufmanColumns({
    basis,
    coefficients: [0.2, 0],
    columns: [fixedCoefficientColumn],
  });
  assert.equal(projected.coefficientRank, 1);
  assert.equal(projected.activeRadialBounds, 0);
  assert.deepEqual(Array.from(projected.columns[0] ?? []), [0, 1]);
  assert.notDeepEqual(projected.columns[0], fixedCoefficientColumn);

  const bounded = projectFullPatchKaufmanColumns({
    basis,
    coefficients: [1, 0],
    columns: [fixedCoefficientColumn],
  });
  assert.equal(bounded.coefficientRank, 0);
  assert.equal(bounded.activeRadialBounds, 1);
  assert.deepEqual(bounded.columns[0], fixedCoefficientColumn);
});

test('radial tangent diagnostics do not invent quadrature metadata', () => {
  const projected = projectFullPatchKaufmanColumns({
    basis: [Float64Array.from([1, 0]), Float64Array.from([0, 0])],
    coefficients: [1, 0],
    columns: [Float64Array.from([1, 1])],
  });
  assert.equal(projected.activeRadialBounds, 1);
  assert.equal(projected.coefficientRank, 0);
  assert.deepEqual(projected.diagnostics?.droppedQuadratures, []);
});

test('duplicate, zero-support and near-collinear bases stay finite', () => {
  const first = tone(91, 0.12, 0.2);
  const duplicate = structuredClone(first);
  const near = structuredClone(first);
  near.osc.freqBase *= 1 + 1e-6;
  near.osc.freqStart *= 1 + 1e-6;
  const unsupported = tone(700, 0.1, 1.1);
  unsupported.osc.delay = 0.01;
  const patch: ArgCreateSynth = {
    oscillators: [first, duplicate, near, unsupported],
  };
  const target = render(patch, 96, 'legacy');
  for (let index = 0; index < 3; index += 1) {
    const group = patch.oscillators[index];
    assert.ok(group !== undefined);
    group.ampEnv.startLevel *= 0.4 + index * 0.1;
    group.osc.phase += 0.8 + index * 0.3;
  }
  const result = runFullPatchVariableProjection({
    patch,
    target,
    phaseModel: 'legacy',
    maxOuter: 2,
    maxInner: 4,
    maxBacktracks: 4,
  });
  assertFiniteResult(result);
  assert.equal(result.patch.oscillators[3]?.osc.delay, 0.01);
  assert.ok(
    result.initialInner !== null &&
      result.initialInner.diagnostics !== null,
  );
  assert.ok(result.initialInner.diagnostics.effectiveRank < 8);
});

test('nonzero stationary initial fit still permits an outer LM step', () => {
  const truth: ArgCreateSynth = { oscillators: [tone(73, 0.3, 0.4)] };
  const initial = structuredClone(truth);
  const group = initial.oscillators[0];
  assert.ok(group !== undefined);
  group.osc.freqBase = 74;
  group.osc.freqStart = 74;
  const result = runFullPatchVariableProjection({
    patch: initial,
    target: render(truth, 1056, 'integral'),
    phaseModel: 'integral',
    maxOuter: 24,
    maxInner: 6,
    maxBacktracks: 12,
  });
  assert.ok(result.initialInner !== null);
  assert.equal(result.initialInner.success, true);
  assert.ok(result.initialInner.finalClippedPcmRss > 0);
  assert.ok(
    ['no-descent', 'stationary', 'quantized-plateau'].includes(
      result.initialInner.stopReason,
    ),
  );
  assert.ok(result.history.some((entry) => entry.accepted));
  assert.equal(result.status, 'refined');
});

test('J-floor guard rejects a global-only improvement', () => {
  const baseline = {
    globalSuppressionPercent: 80,
    windowedSuppressionPercent: 82,
  };
  assert.equal(
    passesFullPatchCanonicalGuard(baseline, {
      globalSuppressionPercent: 90,
      windowedSuppressionPercent: 81.94,
    }),
    false,
  );
  assert.equal(
    passesFullPatchCanonicalGuard(baseline, {
      globalSuppressionPercent: 90,
      windowedSuppressionPercent: 81.95,
    }),
    true,
  );
});

test('J-floor fallback restores source despite proposed global growth', () => {
  const truth: ArgCreateSynth = {
    oscillators: [tone(73, 0.4, 0.37)],
  };
  const truthGroup = truth.oscillators[0];
  assert.ok(truthGroup !== undefined);
  truthGroup.ampEnv.endLevel = 1;
  const initial = structuredClone(truth);
  const initialGroup = initial.oscillators[0];
  assert.ok(initialGroup !== undefined);
  initialGroup.ampEnv.startLevel = 0.16;
  initialGroup.osc.phase = 2.2;
  const snapshot = structuredClone(initial);
  const sampleCount = 1024;
  const target = render(truth, sampleCount, 'legacy');
  const result = runFullPatchVariableProjection({
    patch: initial,
    target,
    phaseModel: 'legacy',
    maxOuter: 0,
    maxInner: 8,
    maxBacktracks: 16,
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
    render(initial, sampleCount, 'legacy'),
  );
  assert.deepEqual(initial, snapshot);
});

test('exact current is a no-op with canonical proposed and saved separation', () => {
  const patch = threeAtomTruth();
  const snapshot = structuredClone(patch);
  const target = render(patch, 2024);
  const result = runFullPatchVariableProjection({
    patch,
    target,
    phaseModel: 'integral',
    maxOuter: 4,
    maxInner: 5,
    maxBacktracks: 8,
  });
  assert.equal(result.status, 'unchanged');
  assert.equal(result.rejectionReason, 'Canonical global не вырос');
  assert.deepEqual(result.patch, snapshot);
  assert.deepEqual(result.samples, target);
  assert.deepEqual(patch, snapshot);
  assert.ok(result.proposed !== null);
  assert.notEqual(result.proposed.patch, result.patch);
  assert.deepEqual(result.proposed.samples, result.samples);
  assert.equal(result.proposed.canonicalValid, true);
});

test('counters and results are deterministic and do not mutate input', () => {
  const truth = threeAtomTruth();
  const initial = corruptThreeAtomPatch(truth);
  const snapshot = structuredClone(initial);
  const target = render(truth, 1012);
  const run = (): FullPatchVpResult =>
    runFullPatchVariableProjection({
      patch: initial,
      target,
      phaseModel: 'integral',
      maxOuter: 3,
      maxInner: 5,
      maxBacktracks: 6,
    });
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  assert.deepEqual(initial, snapshot);
  assertFiniteResult(first);
  assert.equal(first.cost.outerAttempts, first.history.length);
  assert.ok(first.cost.sampleWork.total > 0);
  assert.equal(
    first.cost.sampleWork.total,
    first.cost.sampleWork.synth +
      first.cost.sampleWork.basis +
      first.cost.sampleWork.jacobian +
      first.cost.sampleWork.gram +
      first.cost.sampleWork.metric,
  );
});

test('outer audit never mixes inner and canonical data across backtracks', () => {
  const truth = threeAtomTruth();
  const initial = corruptThreeAtomPatch(truth);
  const result = runFullPatchVariableProjection({
    patch: initial,
    target: render(truth, 1012),
    phaseModel: 'integral',
    maxOuter: 6,
    maxInner: 6,
    maxBacktracks: 3,
  });
  assert.ok(
    result.history.some((entry) => entry.backtracks > 0),
    JSON.stringify(
      result.history.map((entry) => ({
        rank: entry.rank,
        backtracks: entry.backtracks,
        reason: entry.rejectionReason,
        inner: entry.inner?.stopReason,
      })),
    ),
  );
  for (const entry of result.history) {
    const inner = entry.inner;
    if (inner === null) {
      assert.equal(entry.rssAfter, null);
      assert.equal(entry.saturatedAfter, null);
      continue;
    }
    assert.equal(entry.saturatedAfter, inner.finalSaturatedSamples);
    if (!inner.success) {
      assert.equal(entry.rssAfter, null);
    } else if (entry.rssAfter !== null) {
      assert.equal(entry.rssAfter, inner.finalClippedPcmRss);
    }
  }
});

test('outer log round-trip preserves exact synth boundaries', () => {
  const bound = FULL_PATCH_OUTER_BOUNDS[0];
  assert.ok(bound !== undefined);
  assert.equal(bound.nativeMinimum, 20);
  assert.ok(Math.exp(Math.log(bound.nativeMinimum)) < 20);
  assert.equal(
    canonicalFullPatchOuterValue(
      bound,
      Math.log(bound.nativeMinimum) - 1,
    ),
    bound.nativeMinimum,
  );
  assert.equal(
    canonicalFullPatchOuterValue(
      bound,
      Math.log(bound.nativeMaximum) + 1,
    ),
    bound.nativeMaximum,
  );
  assert.equal(
    canonicalFullPatchOuterValue(bound, Math.log(73)),
    Math.exp(Math.log(73)),
  );
});

test('input guards reject invalid patches even with zero outer budget', () => {
  const tooMany: ArgCreateSynth = {
    oscillators: Array.from({ length: 51 }, (_, index) =>
      tone(60 + index),
    ),
  };
  assert.throws(
    () =>
      runFullPatchVariableProjection({
        patch: tooMany,
        target: [1],
        maxOuter: 0,
      }),
    /at most 50 slots/,
  );
  const invalid = structuredClone(tooMany);
  invalid.oscillators = invalid.oscillators.slice(0, 1);
  const group = invalid.oscillators[0];
  assert.ok(group !== undefined);
  group.osc.delay = Number.NaN;
  assert.throws(
    () =>
      runFullPatchVariableProjection({
        patch: invalid,
        target: [1],
        maxOuter: 0,
      }),
    /Invalid fixed or phase field/,
  );
});

test('canonical finalization has a six-N known count without outer steps', () => {
  const patch: ArgCreateSynth = {
    oscillators: [tone(73, 0.4, 0.37)],
  };
  const group = patch.oscillators[0];
  assert.ok(group !== undefined);
  group.ampEnv.endLevel = 1;
  const sampleCount = 8;
  const result = runFullPatchVariableProjection({
    patch,
    target: renderForTarget(patch, sampleCount, 'legacy'),
    phaseModel: 'legacy',
    maxOuter: 0,
    maxInner: 1,
    maxBacktracks: 0,
  });
  assert.equal(FULL_PATCH_FINALIZATION_SAMPLE_PASSES, 6);
  // Внутри metric=14N и synth=5N финальный guard даёт 4N и 2N.
  assert.deepEqual(result.cost.sampleWork, {
    synth: 5 * sampleCount,
    basis: 5 * sampleCount,
    jacobian: 0,
    gram: 0,
    metric: 14 * sampleCount,
    total: 24 * sampleCount,
  });
});

test('sample work known count includes Jacobian normalization and MGS vector passes', () => {
  const patch: ArgCreateSynth = {
    oscillators: [tone(73, 0.4, 0.37)],
  };
  const group = patch.oscillators[0];
  assert.ok(group !== undefined);
  group.ampEnv.endLevel = 1;
  const sampleCount = 8;
  const result = runFullPatchVariableProjection({
    patch,
    target: render(patch, sampleCount, 'legacy'),
    phaseModel: 'legacy',
    maxOuter: 1,
    maxInner: 1,
    maxBacktracks: 0,
  });
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0]?.rank, 3);
  assert.equal(
    result.history[0]?.inner?.stopReason,
    'iteration-limit',
  );
  // Kaufman и текущий basis добавляют 19N Gram и 23N basis.
  assert.deepEqual(result.cost.sampleWork, {
    synth: 7 * sampleCount,
    basis: 37 * sampleCount,
    jacobian: sampleCount,
    gram: 63 * sampleCount,
    metric: 20 * sampleCount,
    total: 128 * sampleCount,
  });
});
