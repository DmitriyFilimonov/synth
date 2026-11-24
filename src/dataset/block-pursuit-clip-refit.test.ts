import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArgCreateSynth } from '../synth';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  pursueResidualBlocks,
  type VariableProjectionPassAudit,
} from './block-pursuit';
import { refitClippedQuadraturePair } from './joint-projection-oracle';
import { renderSamples } from './shared';

/** Осциллятор known-answer с короткой экспоненциальной огибающей. */
function atom(arg: {
  frequency: number;
  level: number;
  phase: number;
  duration?: number;
}): ArgCreateSynth['oscillators'][number] {
  const duration = arg.duration ?? 0.02;
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
      endLevel: 0.001,
      duration,
      slope: 2,
    },
  };
}

/** Выключенный слот для двух атомов known-answer. */
function off(): ArgCreateSynth['oscillators'][number] {
  return {
    osc: {
      on: false,
      freqBase: 50,
      freqStart: 50,
      duration: 0.5,
      slope: 1,
      phase: 0,
    },
    ampEnv: {
      startLevel: 0.001,
      endLevel: 0.001,
      duration: 0.5,
      slope: 1,
    },
  };
}

/** Рендерит короткий PCM в фазовой модели integral. */
function render(patch: ArgCreateSynth): Int16Array {
  return renderSamples(patch, 0.12, { phaseModel: 'integral' });
}

/** Запускает clip-aware VP без refit и с refit от двух пустых слотов. */
function runRefitComparison(source: ArgCreateSynth): {
  target: Int16Array;
  raw: ReturnType<typeof pursueResidualBlocks>;
  refit: ReturnType<typeof pursueResidualBlocks>;
} {
  const target = render(source);
  const common = {
    patch: { oscillators: [off(), off()] },
    target,
    phaseModel: 'integral' as const,
    blockSize: 2 as const,
    maxBlocks: 1,
    diverseShortlist: true,
    variableProjection: true,
    clipAwareNavigation: true,
  };
  return {
    target,
    raw: pursueResidualBlocks(common),
    refit: pursueResidualBlocks({
      ...common,
      clipAwareRefit: true,
    }),
  };
}

test('fixed-offset clip refit finds 1.5 where pair-only clipping finds 1.3', () => {
  const shape = Float64Array.from([1, 0.5, 0.5]);
  const zero = new Float64Array(3);
  const basis = [shape, zero, shape, zero];
  const basisBefore = basis.map((column) => Array.from(column));
  const initialCoefficients = [0.55, 0, 0.55, 0];
  const target = [0.9, 0.85, 0.95];
  const fixedOffset = [-0.1, 0.1, 0.4];
  const rawRss = (total: number): number => {
    let rss = 0;
    for (let index = 0; index < target.length; index += 1) {
      const raw =
        (fixedOffset[index] ?? 0) + total * (shape[index] ?? 0);
      const residual = (target[index] ?? 0) - raw;
      rss += residual * residual;
    }
    return rss;
  };
  assert.ok(rawRss(1.1) < rawRss(1.1 - 1e-6));
  assert.ok(rawRss(1.1) < rawRss(1.1 + 1e-6));

  const refit = refitClippedQuadraturePair({
    basis,
    target,
    fixedOffset,
    initialCoefficients,
  });
  const total =
    (refit.objective.coefficients[0] ?? 0) +
    (refit.objective.coefficients[2] ?? 0);
  assert.ok(Math.abs(total - 1.5) < 1e-4);
  assert.ok(refit.objective.clippedRss < refit.audit.initialRss);
  assert.ok(Math.abs(refit.objective.clippedRss - 0.0125) < 1e-8);
  assert.ok(refit.audit.iterations <= 25);
  assert.ok(refit.audit.backtracks <= 25 * 25);
  assert.ok(refit.audit.maskChanges > 0);
  for (let atomIndex = 0; atomIndex < 2; atomIndex += 1) {
    const norm = Math.hypot(
      refit.objective.coefficients[atomIndex * 2] ?? 0,
      refit.objective.coefficients[atomIndex * 2 + 1] ?? 0,
    );
    assert.ok(norm >= 0.001 && norm <= 1);
  }
  assert.deepEqual(
    basis.map((column) => Array.from(column)),
    basisBefore,
  );

  const pairOnly = refitClippedQuadraturePair({
    basis,
    target: [1, 0.75, 0.55],
    fixedOffset: [0, 0, 0],
    initialCoefficients,
  });
  const pairOnlyTotal =
    (pairOnly.objective.coefficients[0] ?? 0) +
    (pairOnly.objective.coefficients[2] ?? 0);
  assert.ok(Math.abs(pairOnlyTotal - 1.3) < 1e-4);
  assert.ok(Math.abs(pairOnlyTotal - 1.5) > 0.1);
});

test('clip refit preserves raw navigation and defaults to a bitwise off path', () => {
  const source: ArgCreateSynth = {
    oscillators: [
      atom({ frequency: 800, level: 0.3, phase: 0.7 }),
      atom({
        frequency: 6000,
        level: 0.2,
        phase: 0.2,
        duration: 0.005,
      }),
    ],
  };
  const original = structuredClone(source);
  const common = {
    patch: source,
    target: render(source),
    phaseModel: 'integral' as const,
    blockSize: 2 as const,
    maxBlocks: 1,
    diverseShortlist: true,
    variableProjection: true,
    clipAwareNavigation: true,
  };
  const off = pursueResidualBlocks(common);
  const explicitOff = pursueResidualBlocks({
    ...common,
    clipAwareRefit: false,
  });
  assert.deepEqual(explicitOff, off);
  const on = pursueResidualBlocks({
    ...common,
    clipAwareRefit: true,
  });
  const offAttempt = off.variableProjection?.attempts[0];
  const onAttempt = on.variableProjection?.attempts[0];
  assert.ok(offAttempt !== undefined && onAttempt !== undefined);
  assert.equal(offAttempt.passes.length, 5);
  assert.equal(onAttempt.passes.length, 5);
  assert.deepEqual(onAttempt.seed, offAttempt.seed);
  assert.deepEqual(onAttempt.final, offAttempt.final);
  assert.equal(onAttempt.evaluations, offAttempt.evaluations);
  assert.equal(
    onAttempt.unitBasisRenders,
    offAttempt.unitBasisRenders,
  );
  assert.equal(
    onAttempt.clipObjectiveEvaluations,
    offAttempt.clipObjectiveEvaluations,
  );
  assert.equal(offAttempt.exactCandidates, 5);
  assert.equal(onAttempt.exactCandidates, 10);
  assert.equal(on.basisRenders, off.basisRenders);
  assert.equal(
    off.variableProjection?.refitObjectiveEvaluations,
    undefined,
  );

  const slots = onAttempt.passes[0]?.slots;
  assert.ok(slots !== undefined && slots.length === 2);
  for (let index = 0; index < offAttempt.passes.length; index += 1) {
    const raw: VariableProjectionPassAudit | undefined =
      offAttempt.passes[index];
    const refitted: VariableProjectionPassAudit | undefined =
      onAttempt.passes[index];
    assert.ok(raw !== undefined && refitted !== undefined);
    assert.equal(refitted.winnerGain, raw.winnerGain);
    assert.equal(refitted.winnerClippedRss, raw.winnerClippedRss);
    assert.equal(
      refitted.globalSuppressionPercent,
      raw.globalSuppressionPercent,
    );
    assert.equal(
      refitted.windowedSuppressionPercent,
      raw.windowedSuppressionPercent,
    );
    assert.equal(refitted.evaluations, raw.evaluations);
    assert.equal(refitted.unitBasisRenders, raw.unitBasisRenders);
    assert.equal(
      refitted.clipObjectiveEvaluations,
      raw.clipObjectiveEvaluations,
    );
    assert.deepEqual(refitted.slots, slots);
    assert.ok(refitted.shapeKey !== undefined);
    assert.equal(
      refitted.rawGlobalSuppressionPercent,
      raw.globalSuppressionPercent,
    );
    assert.equal(
      refitted.rawWindowedSuppressionPercent,
      raw.windowedSuppressionPercent,
    );
    assert.equal(refitted.rawClippedRss, raw.winnerClippedRss);
    assert.ok(Number.isFinite(refitted.refitClippedRss));
    assert.ok((refitted.refitIterations ?? Infinity) <= 25);
    assert.ok((refitted.refitBacktracks ?? Infinity) <= 25 * 25);
    assert.equal(
      refitted.refitObjectiveEvaluations,
      (refitted.refitIterations ?? 0) +
        (refitted.refitBacktracks ?? 0) +
        1,
    );
  }
  assert.equal(on.status, 'unchanged');
  assert.deepEqual(on.patch, original);
  assert.deepEqual(on.samples, off.samples);
  assert.deepEqual(source, original);
});

test('accepted clip refit wins raw and reaches step, patch and canonical WAV', () => {
  const source: ArgCreateSynth = {
    oscillators: [
      atom({ frequency: 800, level: 0.9, phase: 0.7 }),
      atom({
        frequency: 6000,
        level: 0.8,
        phase: 0.2,
        duration: 0.005,
      }),
    ],
  };
  const { target, raw, refit } = runRefitComparison(source);
  assert.equal(raw.status, 'refined');
  assert.equal(refit.status, 'refined');
  assert.ok(
    refit.metrics.globalSuppressionPercent >
      raw.metrics.globalSuppressionPercent,
  );
  const winningPass =
    refit.variableProjection?.attempts[0]?.passes.find(
      (pass) =>
        pass.refitGlobalSuppressionPercent ===
          refit.metrics.globalSuppressionPercent &&
        pass.refitWindowedSuppressionPercent ===
          refit.metrics.windowedSuppressionPercent,
    );
  assert.ok(winningPass !== undefined);
  assert.equal(winningPass.rawAccepted, true);
  assert.equal(winningPass.refitAccepted, true);
  assert.ok(
    (winningPass.refitGlobalSuppressionPercent ?? -Infinity) >
      (winningPass.rawGlobalSuppressionPercent ?? Infinity),
  );
  assert.ok((winningPass.refitIterations ?? 0) > 0);

  const step = refit.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.atoms.length, 2);
  assert.deepEqual(step.after, refit.metrics);
  for (const audit of step.atoms) {
    const group = refit.patch.oscillators[audit.slot];
    assert.ok(group !== undefined);
    assert.equal(group.ampEnv.startLevel, audit.startLevel);
    assert.equal(group.osc.phase, audit.phase);
  }
  assert.notDeepEqual(refit.patch, raw.patch);
  assert.notDeepEqual(refit.samples, raw.samples);
  assertPatchMatchesWav(
    refit.patch,
    refit.samples,
    'integral',
    44100,
    target.length,
  );
});

test('raw candidate remains saved when refit does not beat the raw optimum', () => {
  const source: ArgCreateSynth = {
    oscillators: [
      atom({ frequency: 800, level: 0.3, phase: 0.7 }),
      atom({
        frequency: 6000,
        level: 0.2,
        phase: 0.2,
        duration: 0.005,
      }),
    ],
  };
  const { target, raw, refit } = runRefitComparison(source);
  assert.equal(raw.status, 'refined');
  assert.equal(refit.status, 'refined');
  const passes = refit.variableProjection?.attempts[0]?.passes;
  assert.ok(passes !== undefined && passes.length === 5);
  for (const pass of passes) {
    assert.equal(pass.rawAccepted, true);
    assert.equal(pass.refitAccepted, true);
    assert.equal(pass.refitIterations, 0);
    assert.equal(
      pass.refitGlobalSuppressionPercent,
      pass.rawGlobalSuppressionPercent,
    );
    assert.equal(
      pass.refitWindowedSuppressionPercent,
      pass.rawWindowedSuppressionPercent,
    );
  }
  assert.deepEqual(refit.patch, raw.patch);
  assert.deepEqual(refit.samples, raw.samples);
  assert.deepEqual(refit.steps[0]?.atoms, raw.steps[0]?.atoms);
  assert.deepEqual(refit.metrics, raw.metrics);
  assertPatchMatchesWav(
    refit.patch,
    refit.samples,
    'integral',
    44100,
    target.length,
  );
});
