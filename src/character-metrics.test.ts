import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAMPLE_RATE } from './consts';
import { renderGroundTruth } from './dataset/ground-truth';
import {
  compareCharacter,
  measureCharacter,
} from './character-metrics';

test('constant body tone and exponential decay have known answers', () => {
  const samples = renderGroundTruth(
    [
      {
        freqHz: 100,
        level: 0.5,
        decayRate: 1,
        durationSec: 0.1,
      },
    ],
    0.5,
  );
  const metrics = measureCharacter(samples, SAMPLE_RATE);
  assert.ok(metrics.bodyF0Hz !== null);
  assert.ok(Math.abs(metrics.bodyF0Hz - 100) < 2);
  assert.ok((metrics.bodyF0Correlation ?? 0) > 0.9);
  assert.ok(metrics.decayDb20Sec !== null);
  const expected = 0.1 * Math.log(10);
  assert.ok(
    Math.abs(metrics.decayDb20Sec - expected) < 0.015,
    `expected about ${expected}, got ${metrics.decayDb20Sec}`,
  );
});

test('doubling envelope duration doubles measured decay', () => {
  const reference = renderGroundTruth(
    [
      {
        freqHz: 100,
        level: 0.5,
        decayRate: 1,
        durationSec: 0.1,
      },
    ],
    0.7,
  );
  const candidate = renderGroundTruth(
    [
      {
        freqHz: 100,
        level: 0.5,
        decayRate: 1,
        durationSec: 0.2,
      },
    ],
    0.7,
  );
  const before = measureCharacter(reference, SAMPLE_RATE);
  const after = measureCharacter(candidate, SAMPLE_RATE);
  assert.ok(before.decayDb20Sec !== null);
  assert.ok(after.decayDb20Sec !== null);
  const ratio = after.decayDb20Sec / before.decayDb20Sec;
  assert.ok(ratio > 1.9 && ratio < 2.1, `ratio ${ratio}`);
  const delta = compareCharacter(reference, candidate, SAMPLE_RATE);
  assert.ok(
    Math.abs(
      (delta.decayDb20DeltaSec ?? 0) -
        (after.decayDb20Sec - before.decayDb20Sec),
    ) < 1e-12,
  );
  assert.ok(Math.abs(delta.bodyF0DeltaCents ?? Infinity) < 10);
});

test('pitch comparison reports cents and scaling preserves metrics', () => {
  const reference = renderGroundTruth(
    [
      {
        freqHz: 50,
        level: 0.5,
        decayRate: 1,
        durationSec: 0.2,
      },
    ],
    0.5,
  );
  const candidate = renderGroundTruth(
    [
      {
        freqHz: 55,
        level: 0.25,
        decayRate: 1,
        durationSec: 0.2,
      },
    ],
    0.5,
  );
  const delta = compareCharacter(reference, candidate, SAMPLE_RATE);
  assert.ok(
    Math.abs((delta.bodyF0DeltaCents ?? 0) - 1200 * Math.log2(1.1)) <
      20,
  );
  assert.ok(
    Math.abs(delta.decayDb20DeltaSec ?? Infinity) < 0.001,
    '16-bit quantization must move decay by less than 1 ms',
  );
});

test('harmonics and a high click do not replace the shared period', () => {
  const samples = renderGroundTruth(
    [
      {
        freqHz: 50,
        level: 0.5,
        decayRate: 1,
        durationSec: 0.2,
      },
      {
        freqHz: 100,
        level: 0.25,
        decayRate: 1,
        durationSec: 0.2,
      },
      {
        freqHz: 5000,
        level: 0.02,
        decayRate: 1,
        durationSec: 0.2,
      },
    ],
    0.5,
  );
  const metrics = measureCharacter(samples, SAMPLE_RATE);
  assert.ok(metrics.bodyF0Hz !== null);
  assert.ok(Math.abs(metrics.bodyF0Hz - 50) < 1);
  assert.ok((metrics.bodyF0Correlation ?? 0) > 0.95);
});

test('boundary and near-boundary pitches keep their octave', () => {
  for (const freqHz of [30, 31, 249, 250]) {
    const samples = renderGroundTruth(
      [
        {
          freqHz,
          level: 0.5,
          decayRate: 1,
          durationSec: 0.2,
        },
      ],
      0.5,
    );
    const metrics = measureCharacter(samples, SAMPLE_RATE);
    assert.ok(
      metrics.bodyF0Hz !== null,
      `${freqHz} must be measurable`,
    );
    assert.ok(
      Math.abs(metrics.bodyF0Hz - freqHz) / freqHz < 0.02,
      `expected ${freqHz}, got ${metrics.bodyF0Hz}`,
    );
  }
});

test('silence, noise and non-decaying tone do not invent f0', () => {
  const silence = measureCharacter(
    new Int16Array(SAMPLE_RATE / 2),
    SAMPLE_RATE,
  );
  assert.equal(silence.bodyF0Hz, null);
  assert.equal(silence.bodyF0Correlation, null);
  assert.equal(silence.decayDb20Sec, null);
  assert.equal(silence.decayPeakTimeSec, null);
  const constant = renderGroundTruth(
    [
      {
        freqHz: 50,
        level: 0.2,
        decayRate: 0,
        durationSec: 0.2,
      },
    ],
    0.5,
  );
  assert.equal(
    measureCharacter(constant, SAMPLE_RATE).decayDb20Sec,
    null,
  );
  let state = 1;
  const noise = Float64Array.from({ length: SAMPLE_RATE / 2 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  });
  const noisy = measureCharacter(noise, SAMPLE_RATE);
  assert.equal(noisy.bodyF0Hz, null);
  assert.equal(noisy.bodyF0Correlation, null);
  assert.throws(() => measureCharacter(constant, 0));
});
