import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAMPLE_RATE } from './consts';
import { renderGroundTruth } from './dataset/ground-truth';
import {
  compareWaveformBands,
  measureWaveformBands,
} from './waveform-bands';

function sumSignals(
  ...signals: readonly ArrayLike<number>[]
): Float64Array {
  const length = Math.max(...signals.map((signal) => signal.length));
  const result = new Float64Array(length);
  for (const signal of signals) {
    for (let i = 0; i < signal.length; i += 1) {
      result[i] = (result[i] ?? 0) + (signal[i] ?? 0);
    }
  }
  return result;
}

function scaleSignal(
  samples: ArrayLike<number>,
  factor: number,
): Float64Array {
  return Float64Array.from(
    { length: samples.length },
    (_, index) => (samples[index] ?? 0) * factor,
  );
}

test('known half-level signal loses six dB in every occupied band', () => {
  const reference = renderGroundTruth(
    [
      {
        freqHz: 200,
        level: 0.2,
        decayRate: 0,
        durationSec: 0.5,
      },
      {
        freqHz: 2000,
        level: 0.1,
        decayRate: 0,
        durationSec: 0.5,
      },
    ],
    0.5,
  );
  const deltas = compareWaveformBands(
    reference,
    scaleSignal(reference, 0.5),
    SAMPLE_RATE,
  );
  for (const delta of deltas) {
    if (delta.deltaDb !== null) {
      assert.ok(Math.abs(delta.deltaDb + 6.020599913) < 1e-6);
    }
  }
  assert.ok(
    deltas.some(
      (delta) =>
        delta.region === 'attack' &&
        delta.name === 'upper-low' &&
        delta.deltaDb !== null,
    ),
  );
});

test('removing a tone only from attack leaves later bands intact', () => {
  const low = renderGroundTruth(
    [
      {
        freqHz: 80,
        level: 0.2,
        decayRate: 0,
        durationSec: 0.5,
      },
    ],
    0.5,
  );
  const high = renderGroundTruth(
    [
      {
        freqHz: 2000,
        level: 0.15,
        decayRate: 0,
        durationSec: 0.5,
      },
    ],
    0.5,
  );
  const attackLength = Math.round(0.03 * SAMPLE_RATE);
  const gatedHigh = Float64Array.from(high, (value, index) =>
    index < attackLength ? 0 : value,
  );
  const reference = sumSignals(low, high);
  const candidate = sumSignals(low, gatedHigh);
  const deltas = compareWaveformBands(
    reference,
    candidate,
    SAMPLE_RATE,
  );
  const at = (region: string, band: string): number => {
    const value = deltas.find(
      (delta) => delta.region === region && delta.name === band,
    )?.deltaDb;
    assert.ok(value !== undefined && value !== null);
    return value;
  };

  assert.ok(at('attack', 'upper-mid') < -20);
  assert.ok(Math.abs(at('attack', 'low')) < 0.1);
  assert.ok(Math.abs(at('body', 'upper-mid')) < 0.05);
  assert.ok(Math.abs(at('tail', 'upper-mid')) < 0.05);
});

test('identical WAV keeps every occupied band at zero dB', () => {
  const samples = renderGroundTruth(
    [
      {
        freqHz: 50,
        level: 0.25,
        decayRate: 2,
        durationSec: 0.2,
      },
      {
        freqHz: 50,
        level: 0.25,
        decayRate: 2,
        durationSec: 0.2,
      },
    ],
    0.5,
  );
  const deltas = compareWaveformBands(samples, samples, SAMPLE_RATE);
  for (const delta of deltas) {
    if (delta.deltaDb !== null) {
      assert.ok(Math.abs(delta.deltaDb) < 1e-9);
    }
  }
});

test('removed tone stays negative at any absolute signal scale', () => {
  const reference = Float64Array.from(
    { length: Math.round(0.1 * SAMPLE_RATE) },
    (_, index) =>
      Math.sin((2 * Math.PI * 1000 * index) / SAMPLE_RATE),
  );
  const candidate = new Float64Array(reference.length);
  const bands = [{ name: 'tone', minHz: 900, maxHz: 1100 }];
  const regions = [{ name: 'all', startSec: 0, endSec: 0.1 }];
  const normal = compareWaveformBands(
    reference,
    candidate,
    SAMPLE_RATE,
    bands,
    regions,
  )[0];
  const tiny = compareWaveformBands(
    scaleSignal(reference, 1e-18),
    candidate,
    SAMPLE_RATE,
    bands,
    regions,
  )[0];
  assert.equal(normal?.deltaDb, -300);
  assert.equal(tiny?.deltaDb, -300);
});

test('missing reference energy yields null and specs are validated', () => {
  const silence = new Int16Array(SAMPLE_RATE / 2);
  const measured = measureWaveformBands(silence, SAMPLE_RATE);
  assert.ok(measured.every((band) => band.energy === 0));
  const deltas = compareWaveformBands(silence, silence, SAMPLE_RATE);
  assert.ok(deltas.every((band) => band.deltaDb === null));
  assert.throws(() =>
    measureWaveformBands(silence, SAMPLE_RATE, [
      { name: 'bad', minHz: 100, maxHz: 50 },
    ]),
  );
  assert.throws(() =>
    measureWaveformBands(silence, SAMPLE_RATE, [
      { name: 'dc', minHz: 0, maxHz: 50 },
    ]),
  );
  assert.throws(() =>
    measureWaveformBands(silence, SAMPLE_RATE, undefined, [
      { name: 'short', startSec: 0, endSec: 1 / SAMPLE_RATE },
    ]),
  );
  assert.throws(() =>
    measureWaveformBands(silence, SAMPLE_RATE, undefined, [
      { name: 'long', startSec: 0, endSec: 2 },
    ]),
  );
});
