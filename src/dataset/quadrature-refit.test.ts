import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import {
  fitQuadrature,
  refitPatchQuadratures,
} from './quadrature-refit';
import { renderSamples } from './shared';

/** Создаёт swept-осциллятор с известной амплитудой и фазой. */
function group(arg: {
  frequency: number;
  sweepFrom: number;
  level: number;
  phase: number;
  duration?: number;
}): ArgCreateSynth['oscillators'][number] {
  return {
    osc: {
      on: true,
      freqBase: arg.frequency,
      freqStart: arg.sweepFrom,
      duration: arg.duration ?? 0.25,
      slope: 1.2,
      phase: arg.phase,
    },
    ampEnv: {
      startLevel: arg.level,
      endLevel: 0.05,
      duration: arg.duration ?? 0.25,
      slope: 0.8,
    },
  };
}

/** Патч с двумя разнесёнными низкими компонентами. */
function patch(
  levels: [number, number],
  phases: [number, number],
): ArgCreateSynth {
  return {
    oscillators: [
      group({
        frequency: 50,
        sweepFrom: 72,
        level: levels[0],
        phase: phases[0],
      }),
      group({
        frequency: 120,
        sweepFrom: 95,
        level: levels[1],
        phase: phases[1],
        duration: 0.18,
      }),
    ],
  };
}

/** Рендерит заданное число отсчётов без ошибки округления длительности. */
function targetSamples(
  source: ArgCreateSynth,
  phaseModel: PhaseModel,
  count = 20046,
): Int16Array {
  return renderSamples(source, (count + 0.5) / 44100, {
    phaseModel,
  });
}

/** Проверяет восстановление в одной фазовой модели. */
function checkRecovery(phaseModel: PhaseModel): void {
  const source = patch([0.3, 0.2], [0.7, 1.2]);
  const initial = patch([0.1, 0.4], [2.5, 0.1]);
  const target = targetSamples(source, phaseModel);
  const result = refitPatchQuadratures({
    patch: initial,
    target,
    phaseModel,
    maxPasses: 4,
  });
  assert.equal(result.status, 'refined');
  assert.equal(result.samples.length, 20046);
  assert.deepEqual(
    result.samples,
    targetSamples(result.patch, phaseModel),
  );
  assert.ok(result.metrics.globalSuppressionPercent > 99.9);
  assert.ok(
    result.metrics.globalSuppressionPercent >
      result.baseline.globalSuppressionPercent + 4.6,
  );
  for (
    let index = 0;
    index < initial.oscillators.length;
    index += 1
  ) {
    const before = initial.oscillators[index];
    const after = result.patch.oscillators[index];
    assert.ok(before !== undefined && after !== undefined);
    assert.equal(after.osc.freqBase, before.osc.freqBase);
    assert.equal(after.osc.freqStart, before.osc.freqStart);
    assert.equal(after.osc.duration, before.osc.duration);
    assert.equal(after.osc.slope, before.osc.slope);
    assert.equal(after.osc.on, before.osc.on);
    assert.deepEqual(after.ampEnv.duration, before.ampEnv.duration);
    assert.deepEqual(after.ampEnv.slope, before.ampEnv.slope);
    assert.deepEqual(after.ampEnv.endLevel, before.ampEnv.endLevel);
    assert.ok(after.ampEnv.startLevel >= 0.001);
    assert.ok(after.ampEnv.startLevel <= 1);
    assert.ok(after.osc.phase >= 0 && after.osc.phase < 2 * Math.PI);
  }
}

test('quadrature refit recovers known legacy amplitudes and phases', () => {
  checkRecovery('legacy');
});

test('quadrature refit recovers known integral amplitudes and phases', () => {
  checkRecovery('integral');
});

test('zero fit is rejected and tiny fit keeps raw and patch consistent', () => {
  const sine = Float64Array.from([1, 0, -1, 0, 1, 0, -1, 0]);
  const cosine = Float64Array.from([0, 1, 0, -1, 0, 1, 0, -1]);
  const rawWithout = new Float64Array(sine.length);
  assert.equal(
    fitQuadrature({
      sine,
      cosine,
      target: new Array<number>(sine.length).fill(0),
      rawWithout,
    }),
    null,
  );
  const tiny = fitQuadrature({
    sine,
    cosine,
    target: Array.from(sine, (value) => value * 0.01),
    rawWithout,
  });
  assert.ok(tiny !== null);
  assert.equal(tiny.startLevel, 0.001);
  assert.ok(
    Math.abs(
      Math.hypot(tiny.sineCoefficient, tiny.cosineCoefficient) -
        0.001,
    ) < 1e-12,
  );
});

test('exact patch stays unchanged and input is not mutated', () => {
  const source = patch([0.3, 0.2], [0.7, 1.2]);
  const initial = structuredClone(source);
  const target = targetSamples(source, 'integral');
  const result = refitPatchQuadratures({
    patch: initial,
    target,
    phaseModel: 'integral',
  });
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.patch, initial);
  assert.deepEqual(initial, source);
  assert.equal(result.passesCompleted, 1);
});

test('invalid target and options fail explicitly', () => {
  const source = patch([0.3, 0.2], [0.7, 1.2]);
  assert.throws(
    () => refitPatchQuadratures({ patch: source, target: [] }),
    /Пустой target/,
  );
  assert.throws(
    () =>
      refitPatchQuadratures({
        patch: source,
        target: new Int16Array(100),
        sampleRate: 48000,
      }),
    /44100/,
  );
  assert.throws(
    () =>
      refitPatchQuadratures({
        patch: source,
        target: new Int16Array(100),
        maxPasses: 0,
      }),
    /maxPasses/,
  );
});
