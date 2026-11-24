import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../consts';
import type { ArgCreateSynth } from '../synth';
import {
  evaluatePreparedBlockSeeds,
  pursueResidualBlocks,
  selectPreparedPairSeeds,
} from './block-pursuit';
import { quantizeRaw } from './quadrature-refit';
import { renderSamples } from './shared';

type PreparedPairForTest = ReturnType<
  typeof selectPreparedPairSeeds
>['combinations'][number];

/** Создаёт fitted-пару с заданным полным raw-вкладом для known-answer. */
function knownPair(
  pairIndex: number,
  contribution: number[],
  rawWithout: number[],
  target: number[],
): PreparedPairForTest {
  const description = (
    atomIndex: number,
  ): PreparedPairForTest['atoms'][number]['description'] => ({
    frequency: 100 + pairIndex * 2 + atomIndex,
    freqStart: 100 + pairIndex * 2 + atomIndex,
    duration: 0.02,
    slope: 1,
    oscDuration: 0.02,
    oscSlope: 1,
    window: 'full' as const,
    localGain: 0,
    peakMagnitude: 0,
    sweepTemplateIndex: null,
  });
  const atoms = [
    {
      description: description(0),
      sine: Float64Array.of(1, 0, 0, 0),
      cosine: Float64Array.of(0, 1, 0, 0),
      selfGram: [1, 0, 0, 1],
      rhs: [0, 0],
    },
    {
      description: description(1),
      sine: Float64Array.of(0, 0, 1, 0),
      cosine: Float64Array.of(0, 0, 0, 1),
      selfGram: [1, 0, 0, 1],
      rhs: [0, 0],
    },
  ];
  const fits = [0, 1].map((atomIndex) => {
    const sineCoefficient = contribution[atomIndex * 2] ?? 0;
    const cosineCoefficient = contribution[atomIndex * 2 + 1] ?? 0;
    return {
      sineCoefficient,
      cosineCoefficient,
      startLevel: Math.hypot(sineCoefficient, cosineCoefficient),
      phase: Math.atan2(cosineCoefficient, sineCoefficient),
    };
  });
  const initialRss = rawWithout.reduce((sum, raw, index) => {
    const error =
      raw - (target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
    return sum + error * error;
  }, 0);
  const candidateRss = rawWithout.reduce((sum, raw, index) => {
    const error =
      raw +
      (contribution[index] ?? 0) -
      (target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
    return sum + error * error;
  }, 0);
  return {
    atoms,
    atomIndices: [pairIndex * 2, pairIndex * 2 + 1],
    fit: { fits, gain: initialRss - candidateRss },
  };
}

/** Осциллятор integration-fixture с короткой огибающей. */
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

/** Выключенный слот integration-fixture. */
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

test('ninth raw pair reaches exact without mutating fitted inputs', () => {
  const target = [32767, 32767, 32767, 32767];
  const rawWithout = [0.4, 1.2, 1.2, 0.7];
  const combinations = Array.from({ length: 8 }, (_, index) => {
    const level = 0.99 - Math.max(0, index - 1) * 0.001;
    const desiredRaw = [level, level, level, level];
    return knownPair(
      index,
      desiredRaw.map(
        (raw, sampleIndex) => raw - (rawWithout[sampleIndex] ?? 0),
      ),
      rawWithout,
      target,
    );
  });
  const clipBestRaw = [1.2, 1.2, 1.2, 1.2];
  const clipBestContribution = clipBestRaw.map(
    (raw, index) => raw - (rawWithout[index] ?? 0),
  );
  combinations.push(
    knownPair(8, clipBestContribution, rawWithout, target),
  );
  for (const combination of combinations) {
    for (const fit of combination.fit?.fits ?? []) {
      assert.ok(fit.startLevel >= 0.001 && fit.startLevel <= 1);
    }
  }
  assert.ok(
    (combinations[8]?.fit?.gain ?? Infinity) <
      (combinations[0]?.fit?.gain ?? -Infinity),
  );
  const before = structuredClone(combinations);
  for (const combination of combinations) {
    Object.freeze(combination);
  }
  const choice = {
    slots: [3, 7],
    rawWithout: Float64Array.from(rawWithout),
    globalAfterRemoval: 0,
  };
  const common = {
    step: 1,
    slotSetRank: 1,
    choice,
    combinations,
    target,
  };
  const raw = selectPreparedPairSeeds({
    ...common,
    clipAwareSeedSelection: false,
  });
  assert.equal(raw.combinations.length, 8);
  assert.equal(raw.objectiveEvaluations, undefined);
  assert.equal(raw.audit, undefined);
  assert.ok(
    raw.combinations.every(
      (combination) => combination.atomIndices[0] !== 16,
    ),
  );

  const clipped = selectPreparedPairSeeds({
    ...common,
    clipAwareSeedSelection: true,
  });
  assert.equal(clipped.combinations.length, 8);
  assert.equal(clipped.objectiveEvaluations, 9);
  const selected = clipped.audit?.selectedPairs;
  assert.ok(selected !== undefined && selected.length === 8);
  const promoted = selected[0];
  assert.ok(promoted !== undefined);
  assert.deepEqual(promoted.atomIndices, [16, 17]);
  assert.equal(promoted.rawRank, 9);
  assert.equal(promoted.clipRank, 1);
  assert.equal(promoted.clippedRss, 0);
  assert.deepEqual(
    Array.from(quantizeRaw(Float64Array.from(clipBestRaw))),
    target,
  );
  assert.ok(
    selected.slice(1).every((pair) => (pair.clippedRss ?? 0) > 0),
  );
  assert.deepEqual(selected[1]?.atomIndices, [0, 1]);
  assert.deepEqual(selected[2]?.atomIndices, [2, 3]);
  assert.equal(selected[1]?.rawRank, 1);
  assert.equal(selected[2]?.rawRank, 2);
  assert.equal(clipped.combinations[0], combinations[8]);
  assert.deepEqual(combinations, before);

  const defaultExact: number[][] = [];
  assert.equal(
    evaluatePreparedBlockSeeds({
      combinations: raw.combinations,
      evaluate: (combination, fit) => {
        assert.equal(fit, combination.fit);
        defaultExact.push([...combination.atomIndices]);
      },
    }),
    8,
  );
  assert.ok(
    defaultExact.every((atomIndices) => atomIndices[0] !== 16),
  );
  const clipExact: number[][] = [];
  assert.equal(
    evaluatePreparedBlockSeeds({
      combinations: clipped.combinations,
      evaluate: (combination, fit) => {
        assert.equal(fit, combination.fit);
        clipExact.push([...combination.atomIndices]);
      },
    }),
    8,
  );
  assert.deepEqual(clipExact[0], [16, 17]);
  assert.equal(
    clipExact.filter((atomIndices) => atomIndices[0] === 16).length,
    1,
  );
  assert.deepEqual(combinations, before);
});

test('default, explicit off and K1 ignore clip seed selection bitwise', () => {
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
  const common = {
    patch: { oscillators: [off(), off()] },
    target: renderSamples(source, 0.12, { phaseModel: 'integral' }),
    phaseModel: 'integral' as const,
    blockSize: 2 as const,
    maxBlocks: 1,
    diverseShortlist: true,
  };
  const implicit = pursueResidualBlocks(common);
  const explicitOff = pursueResidualBlocks({
    ...common,
    clipAwareSeedSelection: false,
  });
  assert.deepEqual(explicitOff, implicit);
  assert.equal(implicit.clipSeedObjectiveEvaluations, undefined);
  assert.equal(implicit.clipSeedSelections, undefined);
  const k1 = pursueResidualBlocks({ ...common, blockSize: 1 });
  const k1Ignored = pursueResidualBlocks({
    ...common,
    blockSize: 1,
    clipAwareSeedSelection: true,
  });
  assert.deepEqual(k1Ignored, k1);
});

test('A over B preserves refit navigation when it selects the same raw top eight', () => {
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
  const common = {
    patch: { oscillators: [off(), off()] },
    target: renderSamples(source, 0.12, { phaseModel: 'integral' }),
    phaseModel: 'integral' as const,
    blockSize: 2 as const,
    maxBlocks: 1,
    diverseShortlist: true,
    variableProjection: true,
    clipAwareNavigation: true,
    clipAwareRefit: true,
  };
  const b = pursueResidualBlocks(common);
  const bExplicitOff = pursueResidualBlocks({
    ...common,
    clipAwareSeedSelection: false,
  });
  assert.deepEqual(bExplicitOff, b);
  const ab = pursueResidualBlocks({
    ...common,
    clipAwareSeedSelection: true,
  });
  assert.equal(ab.clipSeedObjectiveEvaluations, 36);
  assert.equal(ab.clipSeedSelections?.length, 1);
  assert.equal(ab.clipSeedSelections?.[0]?.selectedPairs.length, 8);
  assert.equal(ab.exactEvaluations, b.exactEvaluations);
  assert.equal(ab.jointEvaluations, b.jointEvaluations);
  assert.equal(ab.basisRenders, b.basisRenders);
  assert.deepEqual(ab.patch, b.patch);
  assert.deepEqual(ab.samples, b.samples);
  assert.deepEqual(ab.metrics, b.metrics);
  assert.deepEqual(ab.steps, b.steps);
  assert.deepEqual(ab.variableProjection, b.variableProjection);
  assert.deepEqual(
    ab.variableProjection?.attempts[0]?.passes.map((pass) => ({
      slots: pass.slots,
      shapeKey: pass.shapeKey,
      winnerGain: pass.winnerGain,
      winnerClippedRss: pass.winnerClippedRss,
      refitIterations: pass.refitIterations,
    })),
    b.variableProjection?.attempts[0]?.passes.map((pass) => ({
      slots: pass.slots,
      shapeKey: pass.shapeKey,
      winnerGain: pass.winnerGain,
      winnerClippedRss: pass.winnerClippedRss,
      refitIterations: pass.refitIterations,
    })),
  );
});
