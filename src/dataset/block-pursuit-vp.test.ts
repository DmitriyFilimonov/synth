import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import {
  isBetterClipAwareNavigationCandidate,
  pursueResidualBlocks,
  type BlockPursuitResult,
} from './block-pursuit';
import { quantizeRaw } from './quadrature-refit';
import { renderSamples } from './shared';

/**
 * Создаёт осциллятор known-answer с необязательным sweep.
 *
 * @param arg - Частота, уровень, фаза, огибающие и sweep
 * @returns Включённый осциллятор тестового патча
 */
function atom(arg: {
  frequency: number;
  level: number;
  phase: number;
  duration?: number;
  slope?: number;
  ratio?: number;
  oscDuration?: number;
  oscSlope?: number;
}): ArgCreateSynth['oscillators'][number] {
  const duration = arg.duration ?? 0.02;
  return {
    osc: {
      on: true,
      freqBase: arg.frequency,
      freqStart: arg.frequency * (arg.ratio ?? 1),
      duration: arg.oscDuration ?? duration,
      slope: arg.oscSlope ?? 1,
      phase: arg.phase,
    },
    ampEnv: {
      startLevel: arg.level,
      endLevel: 0.001,
      duration,
      slope: arg.slope ?? 2,
    },
  };
}

/**
 * Создаёт выключенный слот без заданной частотной траектории.
 *
 * @returns Конфигурация неактивного осциллятора для исходного патча
 */
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

/**
 * Рендерит короткий known-answer в выбранной фазовой модели.
 *
 * @param patch - Эталонный патч теста
 * @param phaseModel - Модель фазы; по умолчанию `integral`
 * @returns Моно PCM длительностью 0.12 секунды
 */
function render(
  patch: ArgCreateSynth,
  phaseModel: PhaseModel = 'integral',
): Int16Array {
  return renderSamples(patch, 0.12, { phaseModel });
}

/**
 * Запускает обычный K2, K2-VP и clip-aware K2-VP от одного исходника.
 *
 * @param arg - Исходный patch, эталонный source и модель фазы
 * @returns Результаты `fixed`, `projected` и `clipProjected`
 * @remarks `fixed` не передаёт `variableProjection` и проверяет его
 *   значение по умолчанию `false`. Все режимы получают один
 *   `common`-объект, один словарный shortlist и лимит в один блок.
 */
function runPair(arg: {
  patch: ArgCreateSynth;
  source: ArgCreateSynth;
  phaseModel?: PhaseModel;
}): {
  fixed: BlockPursuitResult;
  projected: BlockPursuitResult;
  clipProjected: BlockPursuitResult;
} {
  const common = {
    patch: arg.patch,
    target: render(arg.source, arg.phaseModel),
    phaseModel: arg.phaseModel ?? ('integral' as const),
    blockSize: 2 as const,
    maxBlocks: 1,
    diverseShortlist: true,
  };
  const fixed = pursueResidualBlocks(common);
  const projected = pursueResidualBlocks({
    ...common,
    variableProjection: true,
  });
  const clipProjected = pursueResidualBlocks({
    ...common,
    variableProjection: true,
    clipAwareNavigation: true,
  });
  return { fixed, projected, clipProjected };
}

/** Считает PCM RSS одного полного raw-отсчёта против 32767. */
function clippedTrapRss(raw: number): { pcm: number; rss: number } {
  const pcm = quantizeRaw(Float64Array.of(raw))[0] ?? 0;
  const error = pcm - 32767;
  return { pcm, rss: error * error };
}

test('clip-aware comparator avoids the raw-RSS clipping trap', () => {
  const a = { name: 'A', ...clippedTrapRss(1.3) };
  const b = { name: 'B', ...clippedTrapRss(0.9) };
  const rawRss = (raw: number): number => ((raw - 1) * 32767) ** 2;
  assert.ok(rawRss(0.9) < rawRss(1.3));
  assert.deepEqual(a, { name: 'A', pcm: 32767, rss: 0 });
  assert.deepEqual(b, {
    name: 'B',
    pcm: 29490,
    rss: 10738729,
  });
  assert.equal(
    isBetterClipAwareNavigationCandidate(
      { clippedRss: a.rss },
      { clippedRss: b.rss },
    ),
    true,
  );
  assert.equal(
    isBetterClipAwareNavigationCandidate(
      { clippedRss: b.rss },
      { clippedRss: a.rss },
    ),
    false,
  );
  assert.equal(
    isBetterClipAwareNavigationCandidate(
      { clippedRss: a.rss },
      { clippedRss: a.rss },
    ),
    false,
  );
});

test('VP refines a rejected dictionary seed between frequency grids', () => {
  const source: ArgCreateSynth = {
    oscillators: [
      atom({ frequency: 803.2, level: 0.3, phase: 0.7 }),
      atom({
        frequency: 6003.2,
        level: 0.2,
        phase: 0.2,
        duration: 0.005,
      }),
    ],
  };
  const approximate: ArgCreateSynth = {
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
  const target = render(source);
  const dictionarySeed = pursueResidualBlocks({
    patch: approximate,
    target,
    phaseModel: 'integral',
    blockSize: 2,
    maxBlocks: 1,
    diverseShortlist: true,
  });
  assert.equal(dictionarySeed.status, 'refined');
  const patch = dictionarySeed.patch;
  const original = structuredClone(patch);
  const { fixed, projected, clipProjected } = runPair({
    patch,
    source,
  });
  const audit = projected.variableProjection?.attempts[0];
  const clipAudit = clipProjected.variableProjection?.attempts[0];
  assert.ok(
    audit !== undefined &&
      audit.seed !== null &&
      audit.final !== null,
  );
  assert.equal(fixed.status, 'unchanged');
  assert.ok(
    projected.metrics.globalSuppressionPercent >
      fixed.metrics.globalSuppressionPercent,
  );
  assert.equal(projected.status, 'refined');
  assert.equal(
    audit?.seedAccepted,
    false,
    JSON.stringify({
      fixed: fixed.metrics,
      baseline: fixed.baseline,
      projected: projected.metrics,
      seed: audit?.seed,
      final: audit?.final,
    }),
  );
  assert.equal(audit?.outcome, 'accepted');
  assert.equal(audit?.passes.length, 5);
  assert.equal(audit?.exactCandidates, 5);
  assert.ok((audit?.evaluations ?? Infinity) <= 101);
  assert.ok((clipAudit?.evaluations ?? Infinity) <= 101);
  assert.equal(clipAudit?.exactCandidates, 5);
  assert.ok(
    (clipAudit?.unitBasisRenders ?? Infinity) <=
      4 * ((clipAudit?.evaluations ?? 0) - 1),
  );
  assert.equal(
    clipProjected.exactEvaluations,
    projected.exactEvaluations,
  );
  assert.equal(clipProjected.basisRenders, projected.basisRenders);
  assert.ok(
    (clipAudit?.clipObjectiveEvaluations ?? Infinity) <=
      (clipAudit?.evaluations ?? 0),
  );
  assert.ok(
    clipAudit?.passes.every(
      (pass) =>
        Number.isFinite(pass.winnerGain) &&
        Number.isFinite(pass.winnerClippedRss),
    ),
  );
  assert.equal(
    clipProjected.variableProjection?.clipObjectiveEvaluations,
    clipAudit?.clipObjectiveEvaluations,
  );
  assert.ok(
    audit?.passes.every((pass) => Number.isFinite(pass.winnerGain)),
  );
  assert.ok(
    audit.final?.some(
      (entry, index) =>
        Math.abs(
          entry.frequency - (audit.seed?.[index]?.frequency ?? 0),
        ) > 0.001,
    ),
  );
  assert.deepEqual(patch, original);
});

for (const phaseModel of ['integral', 'legacy'] as const) {
  test(`VP gives stationary mid/high seeds sweeps through ratio (${phaseModel})`, () => {
    const source: ArgCreateSynth = {
      oscillators: [
        atom({
          frequency: 800,
          ratio: 2,
          level: 0.3,
          phase: 0.7,
          duration: 0.04,
          slope: 1,
        }),
        atom({
          frequency: 6000,
          ratio: 0.5,
          level: 0.2,
          phase: 0.2,
          duration: 0.005,
          slope: 2,
        }),
      ],
    };
    const { fixed, projected, clipProjected } = runPair({
      patch: { oscillators: [off(), off()] },
      source,
      phaseModel,
    });
    const audit = projected.variableProjection?.attempts[0];
    const clipAudit = clipProjected.variableProjection?.attempts[0];
    assert.ok(
      audit !== undefined &&
        audit.seed !== null &&
        audit.final !== null,
    );
    assert.ok(
      projected.metrics.globalSuppressionPercent >
        fixed.metrics.globalSuppressionPercent,
    );
    assert.equal(audit?.outcome, 'accepted');
    assert.ok(
      audit?.seed.every((entry) => Math.abs(entry.ratio - 1) < 1e-9),
    );
    assert.ok(
      audit?.final.some((entry) => Math.abs(entry.ratio - 1) > 0.01),
    );
    assert.ok(
      audit.final.some(
        (entry, index) =>
          entry.freqStart !== audit.seed?.[index]?.freqStart &&
          entry.frequency === audit.seed?.[index]?.frequency,
      ),
    );
    assert.ok((clipAudit?.evaluations ?? Infinity) <= 101);
    assert.equal(clipAudit?.exactCandidates, 5);
    assert.ok(
      (clipAudit?.unitBasisRenders ?? Infinity) <=
        4 * ((clipAudit?.evaluations ?? 0) - 1),
    );
    assert.equal(clipProjected.basisRenders, projected.basisRenders);
    assert.ok(
      (clipAudit?.clipObjectiveEvaluations ?? 0) > 0,
      phaseModel,
    );
    assert.ok(
      clipAudit?.passes.every((pass) =>
        Number.isFinite(pass.winnerClippedRss),
      ),
    );
  });
}

test('default K2 is unchanged and rejected VP preserves an exact match deterministically', () => {
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
  };
  const fixed = pursueResidualBlocks(common);
  const explicitFalse = pursueResidualBlocks({
    ...common,
    variableProjection: false,
  });
  assert.deepEqual(explicitFalse, fixed);
  assert.equal(fixed.variableProjection, undefined);
  const projected = pursueResidualBlocks({
    ...common,
    variableProjection: true,
  });
  const repeated = pursueResidualBlocks({
    ...common,
    variableProjection: true,
    clipAwareNavigation: false,
  });
  assert.deepEqual(repeated, projected);
  assert.equal(
    projected.variableProjection?.clipObjectiveEvaluations,
    undefined,
  );
  assert.ok(
    projected.variableProjection?.attempts.every((attempt) =>
      attempt.passes.every(
        (pass) => pass.winnerClippedRss === undefined,
      ),
    ),
  );
  const nonVpClip = pursueResidualBlocks({
    ...common,
    clipAwareNavigation: true,
  });
  assert.deepEqual(nonVpClip, fixed);
  const clipProjected = pursueResidualBlocks({
    ...common,
    variableProjection: true,
    clipAwareNavigation: true,
  });
  assert.equal(clipProjected.status, 'unchanged');
  assert.deepEqual(clipProjected.patch, source);
  assert.deepEqual(clipProjected.samples, fixed.samples);
  assert.ok(
    (clipProjected.variableProjection?.clipObjectiveEvaluations ??
      0) > 0,
  );
  assert.equal(
    clipProjected.variableProjection?.attempts[0]?.exactCandidates,
    5,
  );
  assert.equal(projected.status, 'unchanged');
  assert.deepEqual(projected.patch, source);
  assert.deepEqual(projected.samples, fixed.samples);
  assert.equal(
    projected.variableProjection?.attempts[0]?.outcome,
    'no-accepted',
  );
  assert.equal(
    projected.variableProjection?.attempts[0]?.seedAccepted,
    false,
  );
  assert.deepEqual(source, original);
});
