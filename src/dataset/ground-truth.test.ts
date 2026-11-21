/**
 * Проверки эталонного генератора: он обязан быть точнее любых мер,
 * которые им проверяют. Сверяем с синтезатором на постоянной частоте,
 * где обе реализации обязаны совпасть, и с аналитической частотой
 * свипа по переходам через ноль.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSynth } from '../synth';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../consts';
import { SAMPLE_RATE } from '../consts';
import {
  renderGroundTruth,
  groundTruthToPatch,
  zeroCrossingFrequency,
  type GroundTruthComponent,
} from './ground-truth';

const TONE: GroundTruthComponent = {
  freqHz: 100,
  level: 0.5,
  phaseRad: 0.7,
  decayRate: 6,
  durationSec: 0.4,
};

test('ground truth matches the integral synth on a constant tone', () => {
  const seconds = 0.3;
  const expected = renderGroundTruth([TONE], seconds);
  const synth = createSynth(groundTruthToPatch(TONE), {
    phaseModel: 'integral',
  });
  let worst = 0;
  for (let i = 0; i < expected.length; i++) {
    const actual = Math.round(
      synth({ x: i / SAMPLE_RATE }) *
        MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    );
    worst = Math.max(worst, Math.abs(actual - (expected[i] ?? 0)));
  }
  assert.ok(
    worst <= 1,
    `generator and integral synth must agree within 1 LSB, got ${worst}`,
  );
});

test('zero-crossing measurement recovers a constant frequency', () => {
  const samples = renderGroundTruth([TONE], 0.3);
  const points = zeroCrossingFrequency(samples).filter(
    (p) => p.t > 0.02,
  );
  assert.ok(points.length > 15);
  for (const p of points) {
    assert.ok(
      Math.abs(p.freqHz - TONE.freqHz) / TONE.freqHz < 0.01,
      `frequency ${p.freqHz} deviates from ${TONE.freqHz}`,
    );
  }
});

test('sweep trajectory follows the nominal exponential', () => {
  const sweep: GroundTruthComponent = {
    freqHz: 50,
    freqStartHz: 800,
    freqTauSec: 0.03,
    level: 0.5,
    decayRate: 3,
    durationSec: 0.4,
  };
  const samples = renderGroundTruth([sweep], 0.4);
  const points = zeroCrossingFrequency(samples);
  const late = points.filter((p) => p.t > 0.25);
  assert.ok(late.length >= 3);
  for (const p of late) {
    assert.ok(
      Math.abs(p.freqHz - 50) < 1,
      `late sweep must settle at 50 Hz, got ${p.freqHz} at ${p.t}`,
    );
  }
  const early = points.find((p) => p.t > 0.005);
  assert.ok(early !== undefined && early.freqHz > 200);
});

test('legacy and integral models diverge on a swept patch', () => {
  // Контроль чувствительности: если модель фазы случайно не та,
  // сравнение с эталоном обязано это заметить.
  const patch = groundTruthToPatch(TONE);
  const first = patch.oscillators[0];
  if (first !== undefined) {
    first.osc.freqStart = 800;
  }
  const legacy = createSynth(patch, { phaseModel: 'legacy' });
  const integral = createSynth(patch, { phaseModel: 'integral' });
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const x = i / SAMPLE_RATE;
    worst = Math.max(
      worst,
      Math.abs(legacy({ x }) - integral({ x })),
    );
  }
  assert.ok(worst > 0.05);
});
