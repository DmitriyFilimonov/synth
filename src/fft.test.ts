/**
 * Тесты FFT: после починки бит-реверсированной перестановки и
 * угла твiddle-фактора держим корректность под охраной: синус с
 * целым числом циклов даёт пик ровно в своём бине, импульс даёт
 * плоский спектр, два тона разделяются, и маленький сигнал
 * сверяется с наивным DFT.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fftMagnitudeSpectrum } from './fft';

/** Наивный DFT для сверки маленьких сигналов. */
function naiveDftMagnitude(signal: number[], k: number): number {
  const n = signal.length;
  let re = 0;
  let im = 0;
  for (let t = 0; t < n; t++) {
    const angle = (-2 * Math.PI * k * t) / n;
    re += (signal[t] ?? 0) * Math.cos(angle);
    im += (signal[t] ?? 0) * Math.sin(angle);
  }
  return Math.sqrt(re * re + im * im) / n;
}

test('sine with integer cycles peaks exactly at its bin', () => {
  const n = 1024;
  const cycles = 5;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sig[i] = Math.sin((2 * Math.PI * cycles * i) / n);
  }
  const { magnitudes } = fftMagnitudeSpectrum(sig);
  const peakBin = magnitudes.reduce(
    (best, m, k) => (m > (magnitudes[best] ?? 0) ? k : best),
    0,
  );
  assert.equal(peakBin, cycles);
  assert.ok(Math.abs((magnitudes[cycles] ?? 0) - 0.5) < 1e-9);
});

test('impulse gives a flat spectrum', () => {
  const imp = new Float64Array(256);
  imp[0] = 1;
  const { magnitudes } = fftMagnitudeSpectrum(imp);
  const first = magnitudes[0] ?? 0;
  for (const m of magnitudes) {
    assert.ok(Math.abs(m - first) < 1e-12);
  }
});

test('two tones split into their bins with half magnitude each', () => {
  const n = 2048;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sig[i] =
      0.5 * Math.sin((2 * Math.PI * 3 * i) / n) +
      0.5 * Math.sin((2 * Math.PI * 17 * i) / n);
  }
  const { magnitudes } = fftMagnitudeSpectrum(sig);
  assert.ok(Math.abs((magnitudes[3] ?? 0) - 0.25) < 1e-9);
  assert.ok(Math.abs((magnitudes[17] ?? 0) - 0.25) < 1e-9);
  assert.ok((magnitudes[10] ?? 0) < 1e-9);
});

test('matches the naive DFT on a small arbitrary signal', () => {
  const n = 8;
  const raw = [0.3, -1.2, 0.7, 0.9, -0.4, 1.1, 0.0, 0.2];
  const sig = new Float64Array(raw);
  const { magnitudes } = fftMagnitudeSpectrum(sig);
  for (let k = 0; k < n / 2; k++) {
    const expected = naiveDftMagnitude(raw, k);
    assert.ok(
      Math.abs((magnitudes[k] ?? 0) - expected) < 1e-9,
      `bin ${k}: fft ${magnitudes[k]} vs dft ${expected}`,
    );
  }
});
