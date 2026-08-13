/**
 * Estimate fundamental frequency of the target signal using autocorrelation.
 * Works well for single-tone or harmonically-rich signals.
 */

/**
 * Calculate autocorrelation for lag (in samples).
 */
const autocorrelation = (
  signal: Int16Array | number[],
  lag: number,
): number => {
  let sum = 0;
  const n = signal.length - lag;
  for (let i = 0; i < n; i++) {
    sum += (signal[i] ?? 0) * (signal[i + lag] ?? 0);
  }
  return sum;
};

/**
 * Find fundamental frequency using YIN-like autocorrelation method.
 * Returns frequency in Hz, or null if no clear periodicity found.
 */
export const estimateFundamentalFreq = (
  signal: Int16Array | number[],
  sampleRate: number,
  minFreq: number = 50,
  maxFreq: number = 5000,
): number | null => {
  const minLag = Math.floor(sampleRate / maxFreq);
  const maxLag = Math.ceil(sampleRate / minFreq);

  let bestLag = -1;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    const corr = autocorrelation(signal, lag);
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (bestLag <= 0) return null;

  // Verify: correlation should be strong
  const zeroLagCorr = autocorrelation(signal, 0);
  if (zeroLagCorr === 0) return null;

  const normalizedCorr = bestCorr / zeroLagCorr;
  if (normalizedCorr < 0.1) return null; // No clear periodicity

  return sampleRate / bestLag;
};

/**
 * Get amplitude envelope by computing RMS in sliding windows.
 */
export const computeAmplitudeEnvelope = (
  signal: Int16Array | number[],
  sampleRate: number,
  windowSize: number = 1024,
  hopSize: number = 256,
): { timeSeconds: number; rms: number }[] => {
  const result: { timeSeconds: number; rms: number }[] = [];

  for (
    let start = 0;
    start + windowSize <= signal.length;
    start += hopSize
  ) {
    let sumSq = 0;
    for (let i = start; i < start + windowSize; i++) {
      const s = signal[i] ?? 0;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / windowSize);
    const timeSeconds = start / sampleRate;
    result.push({ timeSeconds, rms });
  }

  return result;
};

/**
 * Estimate frequency at different time segments using zero-crossing rate.
 */
export const estimateFreqOverTime = (
  signal: Int16Array | number[],
  sampleRate: number,
  segmentSize: number = 4410,
): { timeSeconds: number; freq: number }[] => {
  const result: { timeSeconds: number; freq: number }[] = [];

  for (
    let start = 0;
    start + segmentSize <= signal.length;
    start += segmentSize
  ) {
    let crossings = 0;
    for (let i = start + 1; i < start + segmentSize; i++) {
      const prev = signal[i - 1] ?? 0;
      const curr = signal[i] ?? 0;
      if ((prev < 0 && curr >= 0) || (prev >= 0 && curr < 0)) {
        crossings++;
      }
    }
    const freq = ((crossings / 2) * sampleRate) / segmentSize;
    const timeSeconds = start / sampleRate;
    if (freq > 20 && freq < 22000) {
      result.push({ timeSeconds, freq });
    }
  }

  return result;
};
