import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../consts';
import { calculateRMS } from '../rms';
import { assessCancellationQuality } from '../cancellation-assessment';
import { createSynth } from '../synth';
import { mapVectorToSynthConfig } from '../vector-to-synth-config';

const WINDOW_SIZE_SECONDS = 0.1; // 100ms окна

export const createWaveForm = (
  vectorValues: readonly number[],
  sampleRate: number,
  numSamples: number,
): number[] => {
  const synth = createSynth(
    mapVectorToSynthConfig([...vectorValues]),
  );
  const samples: number[] = [];
  for (let i = 0; i < numSamples; i++) {
    const timeSeconds = i / sampleRate;
    const sample = synth({ x: timeSeconds });
    samples.push(sample * MAX_AMPLITUDE_16_BIT_WAV_ENCODED);
  }
  return samples;
};

export const evaluateSuppression = (
  vectorValues: readonly number[],
  targetSignal: readonly number[],
  sampleRate: number,
): number => {
  const generated = createWaveForm(
    vectorValues,
    sampleRate,
    targetSignal.length,
  );
  const inverted = generated.map((s) => -s);
  const assessment = assessCancellationQuality({
    target: [...targetSignal],
    generated: inverted,
  });
  return assessment.suppressionPercent;
};

const goertzel = (
  signal: number[],
  sampleRate: number,
  targetFreq: number,
): { magnitude: number; phase: number } => {
  const n = signal.length;
  const k = (targetFreq * n) / sampleRate;
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);

  let sPrev = 0;
  let sPrev2 = 0;
  for (let i = 0; i < n; i++) {
    const sCurr = (signal[i] ?? 0) + coeff * sPrev - sPrev2;
    sPrev2 = sPrev;
    sPrev = sCurr;
  }

  const power =
    sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2;
  const magnitude = Math.sqrt(power) / n;
  const real = sPrev - sPrev2 * Math.cos(omega);
  const imag = sPrev2 * Math.sin(omega);
  const phase = Math.atan2(imag, real);

  return { magnitude, phase };
};

const spectralOverlap = (
  targetSignal: number[],
  generated: number[],
  sampleRate: number,
  frequencies: number[],
): number => {
  let overlapSum = 0;
  let totalTargetMag = 0;

  for (const freq of frequencies) {
    const targetGoertzel = goertzel(targetSignal, sampleRate, freq);
    const genGoertzel = goertzel(generated, sampleRate, freq);

    const magnitudeDiff = Math.abs(
      targetGoertzel.magnitude - genGoertzel.magnitude,
    );
    const targetMag = targetGoertzel.magnitude;

    totalTargetMag += targetMag;

    if (targetMag > 0) {
      const relativeError = magnitudeDiff / targetMag;
      overlapSum += Math.max(0, 1 - relativeError);
    }
  }

  return totalTargetMag > 0 ? overlapSum / frequencies.length : 0;
};

const findDominantFrequencies = (
  signal: number[],
  sampleRate: number,
  count: number,
  searchMinFreq: number = 20,
  searchMaxFreq: number = 5000,
  resolution: number = 5,
): number[] => {
  const spectrum: { freq: number; mag: number }[] = [];

  for (
    let freq = searchMinFreq;
    freq <= searchMaxFreq;
    freq += resolution
  ) {
    const g = goertzel(signal, sampleRate, freq);
    spectrum.push({ freq, mag: g.magnitude });
  }

  spectrum.sort((a, b) => b.mag - a.mag);

  const result: number[] = [];
  const minSeparationHz = 15;

  for (const peak of spectrum) {
    if (result.length >= count) {
      break;
    }
    const tooClose = result.some(
      (r) => Math.abs(r - peak.freq) < minSeparationHz,
    );
    if (!tooClose && peak.mag > 0.1) {
      result.push(peak.freq);
    }
  }

  return result;
};

const findOptimalScaleFor = (
  generated: number[],
  targetSignal: number[],
): { scale: number; suppressionPercent: number } => {
  let bestScale = 1;
  let bestScore = -Infinity;

  const scaleCandidates = [
    0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95,
    1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5, 1.7, 2.0, 2.5, 3.0,
  ];

  for (const scale of scaleCandidates) {
    const scaled = generated.map((s) => s * scale);
    const inverted = scaled.map((s) => -s);
    const assessment = assessCancellationQuality({
      target: targetSignal,
      generated: inverted,
    });
    if (assessment.suppressionPercent > bestScore) {
      bestScore = assessment.suppressionPercent;
      bestScale = scale;
    }
  }

  return { scale: bestScale, suppressionPercent: bestScore };
};

export const evaluateSuppressionWindowed = (
  generated: number[],
  targetSignal: readonly number[],
  penaltyWeight = 0.5,
  spectralWeight = 0.3,
  sampleRate = 44100,
): number => {
  const length = targetSignal.length;
  const windowSize = Math.round(WINDOW_SIZE_SECONDS * sampleRate);

  const windowCount = Math.max(1, Math.floor(length / windowSize));
  const step = Math.floor(length / windowCount);

  let windowScoreSum = 0;
  let windowCountUsed = 0;

  for (let w = 0; w < windowCount; w++) {
    const start = w * step;
    const end = Math.min(start + windowSize, length);
    const count = end - start;

    if (count === 0) {
      break;
    }

    const targetWindow: number[] = [];
    const generatedWindow: number[] = [];

    for (let i = start; i < end; i++) {
      targetWindow.push(targetSignal[i] ?? 0);
      generatedWindow.push(generated[i] ?? 0);
    }

    const targetRMS = calculateRMS(targetWindow);

    if (targetRMS < 1) {
      continue;
    }

    const { suppressionPercent: localBestScore } =
      findOptimalScaleFor(generatedWindow, targetWindow);

    windowScoreSum += localBestScore;
    windowCountUsed++;
  }

  if (windowCountUsed === 0) {
    const assessment = assessCancellationQuality({
      target: [...targetSignal],
      generated: generated.map((s) => -s),
    });
    return assessment.suppressionPercent;
  }

  const avgLocalScore = windowScoreSum / windowCountUsed;

  const { suppressionPercent: globalBestScore } = findOptimalScaleFor(
    generated,
    [...targetSignal],
  );

  const shapePenalty = Math.max(0, globalBestScore - avgLocalScore);

  const spectralScore =
    spectralWeight > 0
      ? computeSpectralScore([...targetSignal], generated, sampleRate)
      : 0;

  return (
    avgLocalScore * (1 - spectralWeight) +
    spectralScore * spectralWeight -
    penaltyWeight * shapePenalty
  );
};

const computeSpectralScore = (
  targetSignal: number[],
  generated: number[],
  sampleRate: number,
): number => {
  const numPeaks = 5;
  const targetFreqs = findDominantFrequencies(
    targetSignal,
    sampleRate,
    numPeaks,
  );

  if (targetFreqs.length === 0) {
    return 0;
  }

  return spectralOverlap(
    targetSignal,
    generated,
    sampleRate,
    targetFreqs,
  );
};

export const findOptimalScale = (
  generated: number[],
  targetSignal: readonly number[],
): { scale: number; suppressionPercent: number } => {
  let bestScale = 1;
  let bestScore = -Infinity;

  const scaleCandidates = [
    0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6,
    0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2,
    1.3, 1.4, 1.5, 1.7, 2.0, 2.5, 3.0,
  ];

  for (const scale of scaleCandidates) {
    const scaled = generated.map((s) => s * scale);
    const score = evaluateSuppressionWindowed(scaled, targetSignal);
    if (score > bestScore) {
      bestScore = score;
      bestScale = scale;
    }
  }

  return { scale: bestScale, suppressionPercent: bestScore };
};
