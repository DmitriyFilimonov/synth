import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeUsefulZone } from '../optimize/evaluate';
import type { ArgCreateSynth } from '../synth';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  canonicalCandidate,
  evaluateJointProjectionCoefficients,
  patchFromJointCoefficients,
  prepareJointProjectionProblem,
  projectRadialCoefficientPairs,
  refitClippedQuadratureAtom,
  runJointProjectionOracle,
  solveJointProjectionProblem,
} from './joint-projection-oracle';
import { refitPatchQuadratures } from './quadrature-refit';
import { renderSamples } from './shared';

type Group = ArgCreateSynth['oscillators'][number];

/** Осциллятор с известной частотой, амплитудой и фазой. */
function group(arg: {
  frequency: number;
  level: number;
  phase: number;
  duration?: number;
  endLevel?: number;
}): Group {
  const duration = arg.duration ?? 0.09;
  return {
    osc: {
      on: true,
      freqBase: arg.frequency,
      freqStart: arg.frequency,
      duration,
      slope: 1,
      phase: arg.phase,
    },
    ampEnv: {
      startLevel: arg.level,
      endLevel: arg.endLevel ?? 0.02,
      duration,
      slope: 1.1,
    },
  };
}

/** Выключенный слот с полями, которые oracle не должен трогать. */
function offGroup(): Group {
  return {
    osc: {
      on: false,
      freqBase: 4321,
      freqStart: 1234,
      duration: 0.07,
      slope: 1.7,
      phase: 2.2,
    },
    ampEnv: {
      startLevel: 0.2,
      endLevel: 0.03,
      duration: 0.06,
      slope: 1.4,
    },
  };
}

/** Рендерит точное число PCM-отсчётов в модели integral. */
function renderExact(
  patch: ArgCreateSynth,
  sampleCount: number,
): Int16Array {
  return renderSamples(patch, (sampleCount + 0.5) / 44100, {
    phaseModel: 'integral',
  });
}

/** Четыре близких, но не дублирующих атома для совместного known-answer. */
function fourAtomPatch(
  levels: number[],
  phases: number[],
): ArgCreateSynth {
  const frequencies = [73, 79, 86, 94];
  return {
    oscillators: [
      ...frequencies.map((frequency, index) =>
        group({
          frequency,
          level: levels[index] ?? 0.1,
          phase: phases[index] ?? 0,
          duration: 0.07 + index * 0.013,
          endLevel: 0.03 + index * 0.01,
        }),
      ),
      offGroup(),
    ],
  };
}

test('joint D recovers four correlated atoms beyond sequential steps', () => {
  const source = fourAtomPatch(
    [0.3, 0.18, 0.22, 0.12],
    [0.4, 1.7, 2.8, 5.4],
  );
  const initial = fourAtomPatch(
    [0.08, 0.09, 0.07, 0.06],
    [2.9, 0.1, 5.8, 1.4],
  );
  const original = structuredClone(initial);
  const target = renderExact(source, 8192);
  const sequential = refitPatchQuadratures({
    patch: initial,
    target,
    phaseModel: 'integral',
    maxPasses: 1,
  });
  const result = runJointProjectionOracle({
    patch: initial,
    target,
    phaseModel: 'integral',
    maxEIterations: 5,
  });
  assert.equal(result.d.status, 'refined');
  assert.equal(
    result.d.savedGlobalDelta,
    result.d.canonical.globalDelta,
  );
  assert.equal(
    result.d.savedWindowedDelta,
    result.d.canonical.windowedDelta,
  );
  assert.ok(result.d.canonical.globalSuppressionPercent > 99);
  assert.ok(
    result.d.canonical.globalSuppressionPercent >
      sequential.metrics.globalSuppressionPercent + 1,
  );
  assert.equal(result.diagnostics.basisColumns, 8);
  assert.equal(result.cost.unitBasisRenders, 8);
  assert.equal(result.cost.gramDotProducts, 36);
  assert.deepEqual(initial, original);
  assert.deepEqual(result.d.patch.oscillators[4], offGroup());
  assertPatchMatchesWav(
    result.d.patch,
    result.d.samples,
    'integral',
    44100,
    target.length,
  );
});

test('duplicate quadratures and one-sample oscillator keep rank finite', () => {
  const tone = Float64Array.from([1]);
  const zero = new Float64Array(1);
  const problem = prepareJointProjectionProblem({
    basis: [tone, zero, tone, zero, zero, tone],
    target: [0.25],
    initialCoefficients: [0.1, 0, 0.1, 0, 0, 0.1],
  });
  const result = solveJointProjectionProblem(problem, {
    maxEIterations: 3,
  });
  assert.ok(result.diagnostics.effectiveRank < 6);
  assert.ok(result.diagnostics.effectiveRank > 0);
  assert.ok(Number.isFinite(result.diagnostics.cutoff));
  assert.ok(Number.isFinite(result.diagnostics.condition ?? 0));
  assert.ok(
    Number.isFinite(result.diagnostics.retainedCondition ?? 0),
  );
  assert.ok(
    result.diagnostics.eigenvalues.every((value) =>
      Number.isFinite(value),
    ),
  );
  assert.ok(
    result.diagnostics.droppedQuadratures.some(
      (entry) => entry.oscillator === 2 && entry.kind === 'sine',
    ),
  );
  for (const fit of result.unbounded.fits) {
    assert.ok(Number.isFinite(fit.rawRss));
    assert.ok(Number.isFinite(fit.clippedRss));
  }
  assert.ok(Number.isFinite(result.d.rawRss));
  assert.ok(Number.isFinite(result.e.clippedRss));
});

test('radial bounds keep unit norm and all phase quadrants', () => {
  const input = [2, 2, -2, 2, -2, -2, 2, -2];
  const projected = projectRadialCoefficientPairs(input);
  for (let offset = 0; offset < projected.length; offset += 2) {
    const sine = projected[offset] ?? 0;
    const cosine = projected[offset + 1] ?? 0;
    assert.ok(Math.abs(Math.hypot(sine, cosine) - 1) < 1e-12);
    assert.equal(Math.sign(sine), Math.sign(input[offset] ?? 0));
    assert.equal(
      Math.sign(cosine),
      Math.sign(input[offset + 1] ?? 0),
    );
    const phase = Math.atan2(cosine, sine);
    assert.ok(Number.isFinite(phase));
  }
  const minimum = projectRadialCoefficientPairs([0, 0], [-0.2, -0.3]);
  assert.ok(
    Math.abs(Math.hypot(minimum[0] ?? 0, minimum[1] ?? 0) - 0.001) <
      1e-12,
  );
  assert.ok((minimum[0] ?? 0) < 0 && (minimum[1] ?? 0) < 0);
  const source: ArgCreateSynth = {
    oscillators: [0, 1, 2, 3].map((index) =>
      group({ frequency: 60 + index, level: 0.1, phase: 0 }),
    ),
  };
  const phased = patchFromJointCoefficients({
    patch: source,
    activeOscillatorIndices: [0, 1, 2, 3],
    coefficients: projected,
  });
  const expectedPhases = [
    Math.PI / 4,
    (3 * Math.PI) / 4,
    (5 * Math.PI) / 4,
    (7 * Math.PI) / 4,
  ];
  for (let index = 0; index < phased.oscillators.length; index += 1) {
    const phase = phased.oscillators[index]?.osc.phase ?? 0;
    const expected = expectedPhases[index] ?? 0;
    const distance = Math.abs(
      Math.atan2(
        Math.sin(phase - expected),
        Math.cos(phase - expected),
      ),
    );
    assert.ok(distance < 1e-12);
    assert.equal(phased.oscillators[index]?.ampEnv.startLevel, 1);
  }
});

test('exact current is a PCM no-op and both guards fall back', () => {
  const patch = fourAtomPatch(
    [0.2, 0.1, 0.15, 0.08],
    [0.2, 1.2, 2.3, 4.1],
  );
  const target = renderExact(patch, 4096);
  const original = structuredClone(patch);
  const result = runJointProjectionOracle({
    patch,
    target,
    phaseModel: 'integral',
    maxEIterations: 4,
  });
  assert.equal(result.d.status, 'unchanged');
  assert.equal(result.e.status, 'unchanged');
  assert.deepEqual(result.d.samples, target);
  assert.deepEqual(result.e.samples, target);
  assert.deepEqual(result.d.patch, original);
  assert.deepEqual(result.e.patch, original);
  assert.deepEqual(result.current.samples, target);
  assert.deepEqual(patch, original);
});

/** Численная clip-ловушка: raw optimum 1.1, clipped optimum 1.5. */
function clipTrap(): ReturnType<typeof solveJointProjectionProblem> {
  const shape = Float64Array.from([1, 0.5]);
  const zero = new Float64Array(2);
  const problem = prepareJointProjectionProblem({
    basis: [shape, zero, shape, zero],
    target: [1, 0.75],
    initialCoefficients: [0.1, 0, 0.1, 0],
  });
  return solveJointProjectionProblem(problem);
}

test('clip trap rejects raw winner and E selects clipped winner', () => {
  const result = clipTrap();
  assert.ok(result.d.rawRss < result.current.rawRss);
  assert.ok(result.e.rawRss > result.d.rawRss);
  assert.ok(result.e.clippedRss < result.d.clippedRss);
  assert.ok(result.e.clippedRss < 1e-8);
  const total =
    (result.e.coefficients[0] ?? 0) + (result.e.coefficients[2] ?? 0);
  assert.ok(Math.abs(total - 1.5) < 1e-4);
  for (const coefficient of result.e.coefficients) {
    assert.ok(Number.isFinite(coefficient));
  }
});

test('clip mask is recomputed when a sample crosses the boundary', () => {
  const result = clipTrap();
  const currentStart = result.e.starts.find(
    (entry) => entry.start === 'current',
  );
  assert.ok(currentStart !== undefined);
  assert.ok(currentStart.maskChanges > 0);
  assert.ok(
    currentStart.history.some(
      (entry) => entry.saturatedBefore !== entry.saturatedAfter,
    ),
  );
  assert.ok(currentStart.maskRecomputations > 1);
});

test('two-quadrature atom refit includes an already saturated fixed offset', () => {
  const shape = Float64Array.from([1, 0.5]);
  const result = refitClippedQuadratureAtom({
    basis: [shape, new Float64Array(2)],
    target: [1, 0.75],
    fixedOffset: [1.25, 0],
    initialCoefficients: [0.1, 0],
  });
  const sine = result.objective.coefficients[0] ?? 0;
  assert.ok(Math.abs(sine - 1) < 1e-4);
  assert.equal(result.objective.coefficients.length, 2);
  assert.equal(result.objective.saturatedSamples, 1);
  assert.ok(Math.abs(result.objective.clippedRss - 0.0625) < 1e-8);
  assert.throws(
    () =>
      refitClippedQuadratureAtom({
        basis: [
          shape,
          new Float64Array(2),
          shape,
          new Float64Array(2),
        ],
        target: [1, 0.75],
        fixedOffset: [1.25, 0],
        initialCoefficients: [0.1, 0, 0.1, 0],
      }),
    /две квадратуры/,
  );
});

test('backtracking is monotone, deterministic and bounded', () => {
  const first = clipTrap();
  const second = clipTrap();
  assert.deepEqual(first.e.coefficients, second.e.coefficients);
  assert.ok(first.e.backtracks > 0);
  for (const start of first.e.starts) {
    let previous = start.initialRss;
    for (const iteration of start.history) {
      assert.equal(iteration.rssBefore, previous);
      assert.ok(iteration.rssAfter < iteration.rssBefore);
      previous = iteration.rssAfter;
    }
    assert.equal(start.finalRss, previous);
    assert.ok(start.iterations <= 25);
    assert.ok(start.backtracks <= 25 * 25);
  }
});

test('canonical accepted patch roundtrips and raw RSS is direct', () => {
  const source = fourAtomPatch(
    [0.25, 0.12, 0.14, 0.09],
    [0.7, 2.1, 3.4, 5.2],
  );
  const initial = fourAtomPatch(
    [0.1, 0.08, 0.07, 0.05],
    [2.2, 0.3, 4.4, 1.1],
  );
  const target = renderExact(source, 8192);
  const result = runJointProjectionOracle({
    patch: initial,
    target,
    phaseModel: 'integral',
    maxEIterations: 3,
  });
  assert.equal(result.d.status, 'refined');
  assert.deepEqual(
    result.d.samples,
    renderExact(result.d.patch, 8192),
  );
  assertPatchMatchesWav(
    result.d.patch,
    result.d.samples,
    'integral',
    44100,
    8192,
  );
  const shape = Float64Array.from([1, 0]);
  const problem = prepareJointProjectionProblem({
    basis: [shape, new Float64Array(2)],
    target: [0.25, 0],
    initialCoefficients: [0.1, 0],
  });
  const direct = evaluateJointProjectionCoefficients(
    problem,
    [0.5, 0],
  );
  assert.ok(Math.abs(direct.rawRss - 0.0625) < 1e-15);
});

test('D counts each initial bound violation only in its solver start', () => {
  const sine = Float64Array.from([1, 0, 0, 0]);
  const cosine = Float64Array.from([0, 1, 0, 0]);
  const problem = prepareJointProjectionProblem({
    basis: [sine, cosine],
    target: [2, 0, 0, 0],
    initialCoefficients: [0.1, 0],
  });
  const result = solveJointProjectionProblem(problem, {
    maxEIterations: 1,
  });
  const unbounded = result.unbounded.best.coefficients;
  assert.ok(Math.hypot(unbounded[0] ?? 0, unbounded[1] ?? 0) > 1);
  const startViolations = result.d.solver.starts.reduce(
    (sum, entry) => sum + entry.violatedBounds,
    0,
  );
  const unboundedStart = result.d.solver.starts.find(
    (entry) => entry.start === 'unbounded',
  );
  assert.ok(unboundedStart !== undefined);
  assert.ok(unboundedStart.violatedBounds >= 1);
  assert.equal(result.d.solver.violatedBounds, startViolations);
});

test('public E iteration limit is 25 and truncated fit is not upper bound', () => {
  const shape = Float64Array.from([1, 0]);
  const problem = prepareJointProjectionProblem({
    basis: [shape, new Float64Array(2)],
    target: [0.25, 0],
    initialCoefficients: [0.1, 0],
  });
  assert.throws(
    () =>
      solveJointProjectionProblem(problem, { maxEIterations: 26 }),
    /1 до 25/,
  );
  const result = solveJointProjectionProblem(problem, {
    maxEIterations: 1,
  });
  assert.ok(
    Number.isFinite(result.unbounded.diagnosticSuppressionPercent),
  );
  assert.equal(
    'diagnosticSuppressionUpperPercent' in result.unbounded,
    false,
  );
});

/** Возвращает accepted D и исходные данные для изолированных guard-тестов. */
function acceptedGuardFixture(): {
  result: ReturnType<typeof runJointProjectionOracle>;
  target: number[];
} {
  const source: ArgCreateSynth = {
    oscillators: [
      group({
        frequency: 80,
        level: 0.2,
        phase: 0.8,
        duration: 0.04,
      }),
    ],
  };
  const initial: ArgCreateSynth = {
    oscillators: [
      group({
        frequency: 80,
        level: 0.07,
        phase: 2.4,
        duration: 0.04,
      }),
    ],
  };
  const target = renderExact(source, 1024);
  const result = runJointProjectionOracle({
    patch: initial,
    target,
    phaseModel: 'integral',
    maxEIterations: 1,
  });
  assert.equal(result.d.status, 'refined');
  return { result, target: Array.from(target) };
}

test('J-floor rejection keeps current despite positive global', () => {
  const { result, target } = acceptedGuardFixture();
  const proposed = result.d;
  const rejected = canonicalCandidate({
    kind: 'd',
    raw: proposed.raw,
    proposedPatch: proposed.patch,
    currentPatch: result.current.patch,
    currentSamples: result.current.samples,
    baseline: {
      globalSuppressionPercent:
        result.current.metrics.globalSuppressionPercent,
      windowedSuppressionPercent:
        proposed.canonical.windowedSuppressionPercent + 0.1,
    },
    target,
    sampleRate: 44100,
    phaseModel: 'integral',
    usefulZone: computeUsefulZone(target, 44100),
  });
  assert.ok(rejected.canonical.globalDelta > 0);
  assert.equal(rejected.savedGlobalDelta, 0);
  assert.equal(rejected.savedWindowedDelta, 0);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.status, 'unchanged');
  assert.equal(
    rejected.rejectionReason,
    'canonical J ниже initial−0.05',
  );
  assert.deepEqual(rejected.patch, result.current.patch);
  assert.deepEqual(rejected.samples, result.current.samples);
  assert.equal(
    rejected.canonical.globalSuppressionPercent,
    proposed.canonical.globalSuppressionPercent,
  );
});

test('canonical infrastructure errors abort instead of hiding as rejection', () => {
  const { result, target } = acceptedGuardFixture();
  assert.throws(
    () =>
      canonicalCandidate({
        kind: 'd',
        raw: result.d.raw,
        proposedPatch: result.d.patch,
        currentPatch: result.current.patch,
        currentSamples: result.current.samples,
        baseline: result.current.metrics,
        target,
        sampleRate: 48000,
        phaseModel: 'integral',
        usefulZone: computeUsefulZone(target, 44100),
      }),
    /48000/,
  );
});
