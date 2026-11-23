import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from './consts';
import { renderSamples } from './dataset/shared';
import { synthPreset1 } from './presets';
import {
  createOscillatorGroup,
  type ArgCreateSynth,
  type PhaseModel,
} from './synth';
import { mapSynthConfigToVector } from './synth-config-to-vector';

/**
 * Создаёт один короткий тон с необязательной задержкой.
 *
 * @param delay - Onset в секундах; `undefined` опускает `osc.delay`
 * @param swept - Включает частотную огибающую для проверки локального
 *   времени; по умолчанию частота постоянна
 * @returns Патч known-answer тона с одним осциллятором
 */
function delayedTone(
  delay: number | undefined,
  swept = false,
): ArgCreateSynth {
  return {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 6000,
          freqStart: swept ? 9000 : 6000,
          duration: 0.05,
          slope: 1.2,
          phase: 0.7,
          ...(delay === undefined ? {} : { delay }),
        },
        ampEnv: {
          startLevel: 0.3,
          endLevel: 0.001,
          duration: 0.005,
          slope: 2,
        },
      },
    ],
  };
}

/**
 * Добавляет явный нулевой delay всем осцилляторам пресета.
 *
 * @param patch - Исходный пресет без обязательного поля `osc.delay`
 * @returns Независимая копия с `osc.delay: 0` в каждой группе
 */
function withZeroDelay(patch: ArgCreateSynth): ArgCreateSynth {
  return {
    oscillators: patch.oscillators.map((group) => ({
      ...group,
      osc: { ...group.osc, delay: 0 },
      ampEnv: { ...group.ampEnv },
    })),
  };
}

test('missing and zero delay preserve preset PCM in both phase models', () => {
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const original = renderSamples(synthPreset1, 0.2, { phaseModel });
    const explicit = renderSamples(withZeroDelay(synthPreset1), 0.2, {
      phaseModel,
    });
    assert.deepEqual(explicit, original);
    assert.equal(mapSynthConfigToVector(synthPreset1).length, 20);
    assert.equal(
      mapSynthConfigToVector(withZeroDelay(synthPreset1)).length,
      20,
    );
  }
});

test('delay shifts phase and both envelopes using local oscillator time', () => {
  const delaySamples = Math.round(0.037 * SAMPLE_RATE);
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const patch = delayedTone(delaySamples / SAMPLE_RATE, true);
    const snapshot = structuredClone(patch);
    const actual = renderSamples(patch, 0.2, { phaseModel });
    const withoutDelay = delayedTone(undefined, true);
    const group = withoutDelay.oscillators[0];
    assert.ok(group !== undefined);
    const synth = createOscillatorGroup(group, { phaseModel });
    const expected = new Int16Array(actual.length);
    for (
      let index = delaySamples;
      index < actual.length;
      index += 1
    ) {
      expected[index] = Math.round(
        synth({ x: (index - delaySamples) / SAMPLE_RATE }) *
          MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
      );
    }
    assert.ok(
      actual.slice(0, delaySamples).every((value) => value === 0),
    );
    assert.deepEqual(actual, expected);
    assert.deepEqual(patch, snapshot);
  }
});

test('invalid delay and lossy optimizer mapping are rejected explicitly', () => {
  for (const delay of [-1 / SAMPLE_RATE, Number.NaN, 0.501]) {
    assert.throws(
      () => renderSamples(delayedTone(delay), 0.2),
      /Delay must be finite/,
    );
  }
  assert.throws(
    () => mapSynthConfigToVector(delayedTone(0.01)),
    /cannot be mapped/,
  );
});
