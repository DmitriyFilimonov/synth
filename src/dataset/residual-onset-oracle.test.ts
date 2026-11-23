import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { fitQuadratureBlock } from './block-pursuit';
import { globalOfSamples } from './matching-pursuit';
import { quantizeRaw, renderGroup } from './quadrature-refit';
import {
  ONSET_ORACLE_BANDS,
  ONSET_ORACLE_REGIONS,
  buildResidualTimeBandMap,
  idealGlobalAfterRemovingRss,
  measureRawClipping,
  renderClippedQuadrature,
  renderDelayedGroup,
  runResidualOnsetOracle,
  scanAtomOnsets,
} from './residual-onset-oracle';
import type { AtomDescription } from './matching-pursuit';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];

/**
 * Создаёт короткий тон с известной частотой, огибающей и фазой.
 *
 * @param arg - Необязательные переопределения параметров тестового тона
 * @returns Конфигурация одной группы осциллятора
 */
function tone(
  arg: {
    frequency?: number;
    level?: number;
    phase?: number;
    duration?: number;
    on?: boolean;
  } = {},
): OscillatorGroup {
  const frequency = arg.frequency ?? 6000;
  const duration = arg.duration ?? 0.005;
  return {
    osc: {
      on: arg.on ?? true,
      freqBase: frequency,
      freqStart: frequency,
      duration,
      slope: 1,
      phase: arg.phase ?? 0.31,
    },
    ampEnv: {
      startLevel: arg.level ?? 0.24,
      endLevel: 0.001,
      duration,
      slope: 2,
    },
  };
}

/**
 * Возвращает квадратурный вариант тона с единичной амплитудой.
 *
 * @param group - Исходная группа осциллятора
 * @param phase - Фаза sine- или cosine-базиса в радианах
 * @returns Включённая копия группы с заданной фазой и startLevel 1
 */
function unitTone(
  group: OscillatorGroup,
  phase: number,
): OscillatorGroup {
  return {
    osc: { ...group.osc, on: true, phase },
    ampEnv: { ...group.ampEnv, startLevel: 1 },
  };
}

/**
 * Переносит параметры тестового тона в описание атома словаря.
 *
 * @param group - Группа осциллятора с известной формой
 * @returns Описание attack-атома для known-answer проверок
 */
function description(group: OscillatorGroup): AtomDescription {
  return {
    frequency: group.osc.freqBase,
    freqStart: group.osc.freqStart,
    duration: group.ampEnv.duration,
    slope: group.ampEnv.slope,
    oscDuration: group.osc.duration,
    oscSlope: group.osc.slope,
    window: 'attack',
    localGain: 0,
    peakMagnitude: 1,
    sweepTemplateIndex: null,
  };
}

test('missing and zero delay reproduce renderGroup PCM exactly', () => {
  const group = tone({ frequency: 173, duration: 0.02 });
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const expected = renderGroup(group, 2048, phaseModel);
    const missing = renderDelayedGroup({
      group,
      sampleCount: 2048,
      phaseModel,
    });
    const zero = renderDelayedGroup({
      group,
      sampleCount: 2048,
      phaseModel,
      delaySamples: 0,
    });
    assert.deepEqual(missing, expected);
    assert.deepEqual(zero, expected);
    assert.deepEqual(quantizeRaw(missing), quantizeRaw(expected));
    assert.deepEqual(quantizeRaw(zero), quantizeRaw(expected));
  }
});

test('known late 6 kHz tone needs its onset and refits above 99 percent', () => {
  const sampleCount = Math.round(0.05 * SAMPLE_RATE);
  const delaySamples = Math.round(0.005 * SAMPLE_RATE);
  const group = tone();
  const target = quantizeRaw(
    renderDelayedGroup({
      group,
      sampleCount,
      phaseModel: 'integral',
      delaySamples,
    }),
  );
  const delayedBasis = [0, Math.PI / 2].map((phase) =>
    renderDelayedGroup({
      group: unitTone(group, phase),
      sampleCount,
      phaseModel: 'integral',
      delaySamples,
    }),
  );
  const zeroBasis = [0, Math.PI / 2].map((phase) =>
    renderDelayedGroup({
      group: unitTone(group, phase),
      sampleCount,
      phaseModel: 'integral',
    }),
  );
  const delayedFit = fitQuadratureBlock({
    basis: delayedBasis,
    target,
    rawWithout: new Float64Array(sampleCount),
  });
  assert.ok(delayedFit !== null);
  const delayed = renderClippedQuadrature({
    rawWithout: new Float64Array(sampleCount),
    basis: delayedBasis,
    fits: delayedFit,
  });
  const delayedGlobal = globalOfSamples(
    delayed.samples,
    Array.from(target),
  );
  assert.ok(delayedGlobal > 99);

  const zeroFit = fitQuadratureBlock({
    basis: zeroBasis,
    target,
    rawWithout: new Float64Array(sampleCount),
  });
  const zeroGlobal =
    zeroFit === null
      ? 0
      : globalOfSamples(
          renderClippedQuadrature({
            rawWithout: new Float64Array(sampleCount),
            basis: zeroBasis,
            fits: zeroFit,
          }).samples,
          Array.from(target),
        );
  assert.ok(zeroGlobal < delayedGlobal - 50);
});

test('onset scan finds the late tone and keeps a zero-onset negative control', () => {
  const sampleCount = 4096;
  const delaySamples = 221;
  const group = tone();
  const shape = description(group);
  const lateTarget = quantizeRaw(
    renderDelayedGroup({
      group,
      sampleCount,
      phaseModel: 'integral',
      delaySamples,
    }),
  );
  const late = scanAtomOnsets({
    description: shape,
    target: lateTarget,
    rawWithout: new Float64Array(sampleCount),
    phaseModel: 'integral',
    usefulEnd: sampleCount,
    maxOnsetSamples: 500,
    coarseStepSamples: 44,
  });
  assert.ok(late.zero !== null);
  assert.ok(late.delayed !== null);
  assert.equal(late.delayed.atoms[0]?.delaySamples, delaySamples);
  assert.ok(late.delayed.rawRss < late.zero.rawRss);

  const zeroTarget = quantizeRaw(
    renderGroup(group, sampleCount, 'integral'),
  );
  const control = scanAtomOnsets({
    description: shape,
    target: zeroTarget,
    rawWithout: new Float64Array(sampleCount),
    phaseModel: 'integral',
    usefulEnd: sampleCount,
    maxOnsetSamples: 300,
    coarseStepSamples: 44,
  });
  assert.ok(control.zero !== null);
  assert.ok(control.zero.rawRss < 1e-5, String(control.zero.rawRss));
  if (control.delayed !== null) {
    assert.ok((control.delayed.atoms[0]?.delaySamples ?? 0) > 0);
    assert.ok(control.delayed.rawRss >= control.zero.rawRss - 1e-12);
  }
});

test('saturated mixture uses exact clipped PCM guard', () => {
  const rendered = renderClippedQuadrature({
    rawWithout: Float64Array.from([2, 0, -2, 0]),
    basis: [
      Float64Array.from([0, 1, 0, 0]),
      Float64Array.from([1, 0, 1, 1]),
    ],
    fits: [
      {
        sineCoefficient: 0.1,
        cosineCoefficient: 0.1,
        startLevel: Math.hypot(0.1, 0.1),
        phase: Math.PI / 4,
      },
    ],
  });
  assert.ok((rendered.rawSum[0] ?? 0) > 2);
  assert.ok((rendered.rawSum[2] ?? 0) < -1);
  assert.deepEqual(
    Array.from(rendered.samples),
    [32767, 3277, -32767, 3277],
  );
  assert.equal(
    globalOfSamples(rendered.samples, Array.from(rendered.samples)),
    100,
  );
});

test('clipping report counts saturated samples and their canonical RSS', () => {
  const samples = Int16Array.from([32767, 16384]);
  const report = measureRawClipping({
    rawSum: Float64Array.from([2, 0.5]),
    target: new Int16Array(2),
    samples,
  });
  assert.equal(report.saturatedSamples, 1);
  assert.equal(report.saturatedSampleFraction, 0.5);
  const nonSaturated = 16384 / MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
  const expectedShare = 1 / (1 + nonSaturated * nonSaturated);
  assert.ok(
    Math.abs(
      (report.saturatedResidualRssShare ?? 0) - expectedShare,
    ) < 1e-12,
  );
  const perfect = measureRawClipping({
    rawSum: Float64Array.from([2]),
    target: Int16Array.from([32767]),
    samples: Int16Array.from([32767]),
  });
  assert.equal(perfect.saturatedResidualRssShare, null);
});

test('time-band ideal upper bound follows Parseval and RSS subtraction', () => {
  const sampleRate = 1024;
  const residual = Float64Array.from(
    { length: sampleRate },
    (_, index) => Math.sin((2 * Math.PI * 50 * index) / sampleRate),
  );
  const target = Int16Array.from(residual, (value) =>
    Math.round(value * MAX_AMPLITUDE_16_BIT_WAV_ENCODED),
  );
  const map = buildResidualTimeBandMap({
    residual,
    target,
    sampleRate,
    regions: [{ name: 'all', startSec: 0, endSec: 1 }],
  });
  assert.equal(map.cells.length, ONSET_ORACLE_BANDS.length);
  const sub = map.cells.find((cell) => cell.name === 'sub');
  assert.ok(sub !== undefined);
  assert.ok(Math.abs(map.residualRss - 512) < 1e-9);
  assert.ok(
    Math.abs(sub.bandRss - map.residualRss) < 1e-8,
    `${sub.bandRss} vs ${map.residualRss}`,
  );
  assert.ok(Math.abs((sub.residualRssShare ?? 0) - 1) < 1e-12);
  assert.ok(Math.abs(sub.idealGlobalSuppressionPercent - 100) < 1e-4);
  assert.ok(
    Math.abs(
      idealGlobalAfterRemovingRss({
        targetRss: 100,
        residualRss: 25,
        removedRss: 9,
      }) - 60,
    ) < 1e-12,
  );
  assert.equal(ONSET_ORACLE_REGIONS.length, 4);
});

test('short oracle smoke stays diagnostic and bounds exact pairs', () => {
  const group = tone();
  const sampleCount = 2048;
  const target = quantizeRaw(
    renderDelayedGroup({
      group,
      sampleCount,
      phaseModel: 'integral',
      delaySamples: 100,
    }),
  );
  const off = tone({ on: false, level: 0.001 });
  const result = runResidualOnsetOracle({
    patch: { oscillators: [off, structuredClone(off)] },
    target,
    phaseModel: 'integral',
    maxOnsetSamples: 150,
    coarseStepSamples: 25,
    exactPairLimit: 1,
  });
  assert.equal(result.diagnostic, 'residual-onset-oracle');
  assert.equal(result.canonicalPatchWritten, false);
  assert.equal(result.canonicalWavWritten, false);
  assert.ok(result.slotSets.length <= 4);
  const k1Sets = result.slotSets.filter(
    (entry) => entry.mode === 'K1',
  );
  const k2Sets = result.slotSets.filter(
    (entry) => entry.mode === 'K2',
  );
  assert.equal(result.cost.k1.slotSetsEvaluated, k1Sets.length);
  assert.equal(result.cost.k2.slotSetsEvaluated, k2Sets.length);
  assert.equal(result.cost.k1.jointFitEvaluations, 0);
  assert.ok(k1Sets.every((entry) => entry.slots.length === 1));
  assert.ok(k2Sets.every((entry) => entry.slots.length === 2));
  assert.ok(result.cost.k1.exactPairIdentities === 0);
  assert.ok(result.cost.k2.exactPairIdentities <= k2Sets.length);
  assert.ok(result.cost.k1.exactEvaluations <= 3 * k1Sets.length);
  assert.ok(result.cost.k2.exactEvaluations <= 16 * k2Sets.length);
  assert.ok(
    result.cost.k1.exactEvaluations +
      result.cost.k2.exactEvaluations <=
      38,
  );
  assert.equal(result.timeBands.cells.length, 20);
  assert.ok(
    result.cost.k1.scanFitEvaluations +
      result.cost.k2.scanFitEvaluations >
      0,
  );
  assert.ok(
    result.cost.k1.basisRenders + result.cost.k2.basisRenders > 0,
  );
  if (result.bestExactDelayed !== null) {
    const exact = result.bestExactDelayed;
    assert.deepEqual(
      exact.sameZero.candidate.slots,
      exact.candidate.slots,
    );
    assert.equal(exact.sameZero.candidate.mode, exact.candidate.mode);
    assert.deepEqual(
      exact.sameZero.candidate.atoms.map((atom) => ({
        slot: atom.slot,
        description: atom.description,
        delaySamples: atom.delaySamples,
      })),
      exact.candidate.atoms.map((atom) => ({
        slot: atom.slot,
        description: atom.description,
        delaySamples: 0,
      })),
    );
  }
});

test('exact delayed keeps its own paired zero when theoretical winners differ', () => {
  const sampleCount = 2048;
  const early = tone({
    frequency: 800,
    level: 0.2,
    phase: 0.4,
    duration: 0.02,
  });
  const late = tone({
    frequency: 6000,
    level: 0.34,
    duration: 0.04,
  });
  const earlyRaw = renderGroup(early, sampleCount, 'integral');
  const lateRaw = renderDelayedGroup({
    group: late,
    sampleCount,
    phaseModel: 'integral',
    delaySamples: 400,
  });
  const target = quantizeRaw(
    Float64Array.from(
      earlyRaw,
      (value, index) => value + (lateRaw[index] ?? 0),
    ),
  );
  const off = tone({ on: false, level: 0.001 });
  const result = runResidualOnsetOracle({
    patch: { oscillators: [off] },
    target,
    phaseModel: 'integral',
    maxOnsetSamples: 500,
    coarseStepSamples: 50,
    exactPairLimit: 1,
  });
  assert.equal(result.cost.k2.slotSetsEvaluated, 0);
  const theoreticalZero = result.bestTheoreticalZero;
  const theoreticalDelayed = result.bestTheoreticalDelayed;
  const exact = result.bestExactDelayed;
  assert.ok(theoreticalZero !== null);
  assert.ok(theoreticalDelayed !== null);
  assert.ok(exact !== null);
  const zeroAtom = theoreticalZero.atoms[0];
  const delayedAtom = theoreticalDelayed.candidate.atoms[0];
  const exactAtom = exact.candidate.atoms[0];
  const pairedAtom = exact.sameZero.candidate.atoms[0];
  assert.ok(zeroAtom !== undefined);
  assert.ok(delayedAtom !== undefined);
  assert.ok(exactAtom !== undefined);
  assert.ok(pairedAtom !== undefined);
  assert.notDeepEqual(zeroAtom.description, delayedAtom.description);
  assert.ok(
    Math.abs(delayedAtom.description.frequency - 6000) < 30,
    JSON.stringify({
      zero: zeroAtom.description,
      delayed: delayedAtom.description,
      delay: delayedAtom.delaySamples,
    }),
  );
  assert.deepEqual(exact.candidate, theoreticalDelayed.candidate);
  assert.equal(exact.candidate.mode, exact.sameZero.candidate.mode);
  assert.deepEqual(
    exact.sameZero.candidate.slots,
    exact.candidate.slots,
  );
  assert.equal(pairedAtom.slot, exactAtom.slot);
  assert.deepEqual(pairedAtom.description, exactAtom.description);
  assert.equal(pairedAtom.delaySamples, 0);
  assert.ok(exactAtom.delaySamples > 0);
  assert.notDeepEqual(pairedAtom.description, zeroAtom.description);
  assert.ok(Number.isFinite(exact.globalDeltaVsSameZero));
  assert.ok(Number.isFinite(exact.windowedDeltaVsSameZero));
  assert.ok(
    Math.abs(
      exact.globalDeltaVsSameZero -
        (exact.metrics.globalSuppressionPercent -
          exact.sameZero.metrics.globalSuppressionPercent),
    ) < 1e-12,
  );
});

test('K1 removes only its ranked active slot and preserves the other contribution', () => {
  const sampleCount = 2048;
  const body = tone({
    frequency: 120,
    level: 0.3,
    phase: 0.2,
    duration: 0.04,
  });
  const click = tone({
    frequency: 6000,
    level: 0.2,
    phase: 0.7,
    duration: 0.005,
  });
  const groups = [body, click];
  const contributions = groups.map((group) =>
    renderGroup(group, sampleCount, 'integral'),
  );
  const rawSum = Float64Array.from(
    contributions[0] ?? new Float64Array(sampleCount),
    (value, index) => value + (contributions[1]?.[index] ?? 0),
  );
  const target = quantizeRaw(rawSum);
  const result = runResidualOnsetOracle({
    patch: { oscillators: groups },
    target,
    phaseModel: 'integral',
    maxOnsetSamples: 0,
    coarseStepSamples: 20,
    exactPairLimit: 1,
  });
  const k1Sets = result.slotSets.filter(
    (entry) => entry.mode === 'K1',
  );
  assert.equal(k1Sets.length, 2);
  for (const entry of k1Sets) {
    assert.equal(entry.slots.length, 1);
    const slot = entry.slots[0];
    assert.ok(slot === 0 || slot === 1);
    const otherSlot = slot === 0 ? 1 : 0;
    const preserved = contributions[otherSlot];
    assert.ok(preserved !== undefined);
    let expectedRss = 0;
    let pairRemovalRss = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const normalizedTarget =
        (target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
      const remaining = normalizedTarget - (preserved[index] ?? 0);
      const withoutBoth = normalizedTarget;
      expectedRss += remaining * remaining;
      pairRemovalRss += withoutBoth * withoutBoth;
    }
    assert.ok(Math.abs(expectedRss - pairRemovalRss) > 1e-3);
    assert.ok(
      Math.abs(entry.rawRssAfterRemoval - expectedRss) < 1e-9,
    );
    const candidate = entry.bestZero;
    assert.ok(candidate !== null);
    assert.deepEqual(candidate.slots, [slot]);
    assert.ok(
      Math.abs(
        candidate.rawRss +
          candidate.rawRssGainAfterRemoval -
          expectedRss,
      ) < 1e-9,
    );
  }
  assert.equal(result.cost.k1.slotSetsEvaluated, 2);
  assert.equal(result.cost.k1.jointFitEvaluations, 0);
});

test('K2 mixed delayed and zero atoms recover distinct known onsets', () => {
  const sampleCount = 4096;
  const delaySamples = 300;
  const early = tone({ frequency: 6000, level: 0.2, phase: 0.31 });
  const late = tone({
    frequency: 80,
    level: 0.3,
    phase: 0.7,
    duration: 0.1,
  });
  const earlySamples = renderDelayedGroup({
    group: early,
    sampleCount,
    phaseModel: 'integral',
  });
  const lateSamples = renderDelayedGroup({
    group: late,
    sampleCount,
    phaseModel: 'integral',
    delaySamples,
  });
  const raw = Float64Array.from(
    { length: sampleCount },
    (_, index) =>
      (earlySamples[index] ?? 0) + (lateSamples[index] ?? 0),
  );
  const target = quantizeRaw(raw);
  const off = tone({ on: false, level: 0.001 });
  const result = runResidualOnsetOracle({
    patch: { oscillators: [off, structuredClone(off)] },
    target,
    phaseModel: 'integral',
    maxOnsetSamples: 350,
    coarseStepSamples: 50,
  });
  const exact = result.bestExactDelayed;
  assert.ok(exact !== null);
  const delays = exact.candidate.atoms.map(
    (atom) => atom.delaySamples,
  );
  assert.equal(delays.filter((delay) => delay === 0).length, 1);
  assert.equal(delays.filter((delay) => delay > 0).length, 1);
  assert.ok(
    delays.includes(delaySamples),
    `delays=${delays.join(',')} global=${exact.metrics.globalSuppressionPercent}`,
  );
  assert.ok(exact.metrics.globalSuppressionPercent > 98);
  assert.ok(exact.baselineGlobalDelta > 98);
  assert.deepEqual(
    exact.sameZero.candidate.slots,
    exact.candidate.slots,
  );
  assert.ok(
    exact.sameZero.candidate.atoms.every(
      (atom) => atom.delaySamples === 0,
    ),
  );
});

test('invalid delay, quadrature and time-band inputs are rejected', () => {
  const group = tone();
  for (const delaySamples of [-1, 1.5, 2049]) {
    assert.throws(
      () =>
        renderDelayedGroup({
          group,
          sampleCount: 2048,
          phaseModel: 'legacy',
          delaySamples,
        }),
      /delaySamples/,
    );
  }
  assert.throws(
    () =>
      renderDelayedGroup({
        group,
        sampleCount: 1.5,
        phaseModel: 'legacy',
      }),
    /sampleCount/,
  );
  assert.equal(
    renderDelayedGroup({
      group,
      sampleCount: 16,
      phaseModel: 'legacy',
      delaySamples: 16,
    }).every((value) => value === 0),
    true,
  );
  assert.throws(
    () =>
      scanAtomOnsets({
        description: description(group),
        target: [1, 2],
        rawWithout: new Float64Array(3),
        phaseModel: 'legacy',
        usefulEnd: 2,
      }),
    /одну ненулевую длину/,
  );
  assert.throws(
    () =>
      renderClippedQuadrature({
        rawWithout: [0, 0],
        basis: [new Float64Array(2)],
        fits: [],
      }),
    /Несовместимые размеры/,
  );
  assert.throws(
    () =>
      idealGlobalAfterRemovingRss({
        targetRss: 1,
        residualRss: 1,
        removedRss: -1,
      }),
    /RSS/,
  );
  assert.throws(
    () =>
      buildResidualTimeBandMap({
        residual: new Float64Array(16),
        target: new Int16Array(16),
        sampleRate: SAMPLE_RATE,
      }),
    /тихий target/,
  );
  assert.throws(
    () =>
      runResidualOnsetOracle({
        patch: { oscillators: [group] },
        target: [],
      }),
    /непустой target/,
  );
  for (const options of [
    { maxOnsetSamples: -1 },
    { maxOnsetSamples: 0.5 },
    { coarseStepSamples: 0 },
    { exactPairLimit: 0 },
  ]) {
    assert.throws(
      () =>
        runResidualOnsetOracle({
          patch: { oscillators: [] },
          target: [0],
          ...options,
        }),
      /Onset|maxOnsetSamples|coarseStepSamples|exactPairLimit/,
    );
  }
});
