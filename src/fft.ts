/**
 * Minimal FFT implementation (Cooley-Tukey radix-2).
 * Used ONLY for initializing oscillator vectors from WAV targets.
 * NOT used in runtime synthesis or optimization metrics.
 */

type ComplexVal = [number, number]; // [real, imag]

const fft = (signal: Float64Array): ComplexVal[] => {
  const n = signal.length;
  if (n <= 1) return [[signal[0] ?? 0, 0]];

  const omega = (-2.0 * Math.PI) / n;
  const result: ComplexVal[] = Array.from({ length: n });

  // Bit-reversal permutation
  const jReverse = (i: number): number => {
    let reversed = 0;
    let bits = 0;
    let temp = i;
    let len = n;
    while (len > 1) {
      len >>= 1;
      bits++;
    }
    while (bits > 0) {
      reversed = (reversed << 1) | (temp & 1);
      temp >>= 1;
      bits--;
    }
    return reversed;
  };

  for (let i = 0; i < n; i++) {
    const ri = jReverse(i);
    const sample = signal[ri] ?? 0;
    result[ri] = [sample, 0];
  }

  // Butterfly passes
  let len = 2;
  while (len <= n) {
    const half = len >> 1;
    const wAngle = omega * half;
    const wReal = Math.cos(wAngle);
    const wImag = Math.sin(wAngle);

    for (let i = 0; i < n; i += len) {
      let uReal = 1;
      let uImag = 0;
      for (let j = 0; j < half; j++) {
        const ai = i + j;
        const bi = i + j + half;
        const [aReal, aImag] = result[ai]!;
        const [bReal, bImag] = result[bi]!;
        const tr = uReal * bReal - uImag * bImag;
        const ti = uReal * bImag + uImag * bReal;
        result[ai] = [aReal + tr, aImag + ti];
        result[bi] = [aReal - tr, aImag - ti];
        const newReal = uReal * wReal - uImag * wImag;
        const newImag = uReal * wImag + uImag * wReal;
        uReal = newReal;
        uImag = newImag;
      }
    }
    len <<= 1;
  }

  return result;
};

export interface DominantHarmonic {
  frequency: number;
  magnitude: number;
  phase: number;
}

interface PeakCandidate extends DominantHarmonic {
  weightedMagnitude: number;
}

/**
 * Extract dominant harmonics from a WAV signal using FFT.
 * Returns up to `maxHarmonics` harmonics sorted by magnitude (descending).
 */
export const fftExtractHarmonics = (
  signal: Int16Array | number[],
  sampleRate: number,
  maxHarmonics: number,
): DominantHarmonic[] => {
  // Find nearest power of 2, pad with zeros
  const n = signal.length;
  let fftSize = 1;
  while (fftSize < n) fftSize <<= 1;
  // Cap to avoid huge FFTs
  fftSize = Math.min(fftSize, 65536);

  const padded = new Float64Array(fftSize);
  for (let i = 0; i < Math.min(n, fftSize); i++) {
    padded[i] = signal[i] ?? 0;
  }

  const spectrum = fft(padded);

  const magnitudeBin = (k: number): number => {
    const [r, i] = spectrum[k] ?? [0, 0];
    return Math.sqrt(r * r + i * i) / fftSize;
  };

  // Only positive frequencies, skip DC (bin 0)
  const numBins = fftSize >> 1;
  const binFreq = (k: number): number => (k * sampleRate) / fftSize;

  // Find peaks with local-maxima detection
  // Bias toward lower frequencies (fundamentals) by weighting magnitude inversely with frequency
  const magnitudes = Array.from({ length: numBins }, (_, k) =>
    magnitudeBin(k),
  );
  const maxMag = Math.max(...magnitudes);
  const threshold = maxMag * 0.02;

  const peaks: PeakCandidate[] = [];
  for (let k = 1; k < numBins; k++) {
    const mag = magnitudeBin(k);
    if (mag < threshold) continue;
    const prev = magnitudeBin(k - 1);
    const next = magnitudeBin(k + 1);
    // Must be a local maximum
    if (mag > prev && mag > next) {
      const [r, i] = spectrum[k] ?? [0, 0];
      const freq = binFreq(k);
      const phase = Math.atan2(i, r);
      // Weight by low-frequency preference (higher weight for fundamentals)
      // Weight = 1 / sqrt(frequency) so 100 Hz gets 10x weight of 10 kHz
      const freqWeight = 1 / Math.sqrt(Math.max(freq, 20));
      peaks.push({
        frequency: freq,
        magnitude: mag,
        weightedMagnitude: mag * freqWeight,
        phase,
      });
    }
  }

  // Sort by the weighted magnitude to favor lower fundamentals
  peaks.sort((a, b) => b.weightedMagnitude - a.weightedMagnitude);
  const result: DominantHarmonic[] = [];
  for (
    let i = 0;
    i < peaks.length && result.length < maxHarmonics;
    i++
  ) {
    const p = peaks[i];
    if (!p) continue;
    result.push({
      frequency: p.frequency,
      magnitude: p.magnitude,
      phase: p.phase,
    });
  }
  return result;
};
