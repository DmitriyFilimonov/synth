import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../consts';
import { assessCancellationQuality } from '../cancellation-assessment';
import {
  createSynth,
  createOscillatorGroup,
  OSC_PARAMS_PER_OSCILLATOR,
} from '../synth';
import {
  mapVectorToSynthConfig,
  mapVectorToSynthConfigForOsc,
} from '../vector-to-synth-config';

const WINDOW_SIZE_SECONDS = 0.1; // 100ms окна

/** Границы оптимального масштаба при аналитическом подборе. */
const SCALE_MIN = 0.05;
const SCALE_MAX = 100;

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

export const evaluateSuppressionFromWaveform = (
  generated: readonly number[],
  targetSignal: readonly number[],
): number => {
  const inverted = generated.map((s) => -s);
  const assessment = assessCancellationQuality({
    target: [...targetSignal],
    generated: inverted,
  });
  return assessment.suppressionPercent;
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
  return evaluateSuppressionFromWaveform(generated, targetSignal);
};

const goertzel = (
  signal: readonly number[],
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
  targetSignal: readonly number[],
  generated: readonly number[],
  sampleRate: number,
  frequencies: number[],
  targetMagnitudes: number[],
): number => {
  let overlapSum = 0;

  for (let f = 0; f < frequencies.length; f++) {
    const freq = frequencies[f]!;
    const targetMag = targetMagnitudes[f] ?? 0;
    const genGoertzel = goertzel(generated, sampleRate, freq);

    const magnitudeDiff = Math.abs(targetMag - genGoertzel.magnitude);

    if (targetMag > 0) {
      const relativeError = magnitudeDiff / targetMag;
      overlapSum += Math.max(0, 1 - relativeError);
    }
  }

  return frequencies.length > 0 ? overlapSum / frequencies.length : 0;
};

const findDominantFrequencies = (
  signal: readonly number[],
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

/**
 * Спектральный профиль таргетного сигнала: доминантные частоты и их
 * амплитуды/фазы (Goertzel). Инвариантен для всех evaluate-вызовов,
 * поэтому вычисляется один раз на запуск оптимизации.
 */
export interface SpectralProfile {
  freqs: number[];
  targetMagnitudes: number[];
}

export const computeSpectralProfile = (
  targetSignal: readonly number[],
  sampleRate: number,
  numPeaks: number = 5,
): SpectralProfile => {
  const freqs = findDominantFrequencies(
    targetSignal,
    sampleRate,
    numPeaks,
  );
  const targetMagnitudes: number[] = [];
  for (const freq of freqs) {
    const g = goertzel(targetSignal, sampleRate, freq);
    targetMagnitudes.push(g.magnitude);
  }
  return { freqs, targetMagnitudes };
};

const computeSpectralScore = (
  targetSignal: readonly number[],
  generated: readonly number[],
  sampleRate: number,
  profile: SpectralProfile,
): number => {
  if (profile.freqs.length === 0) {
    return 0;
  }
  return spectralOverlap(
    targetSignal,
    generated,
    sampleRate,
    profile.freqs,
    profile.targetMagnitudes,
  );
};

const rangeRMS = (
  signal: readonly number[],
  start: number,
  length: number,
): number => {
  if (length <= 0) {
    return 0;
  }
  let sumOfSquares = 0;
  for (let i = start; i < start + length; i++) {
    const s = signal[i] ?? 0;
    sumOfSquares += s * s;
  }
  return Math.sqrt(sumOfSquares / length);
};

/**
 * Аналитический подбор масштаба и suppression на диапазоне [start, start+len).
 * Оптимальный масштаб минимизирует энергию остатка target - scale*generated:
 * s* = (t·g) / (g·g). Это непрерывный оптимум, всегда не хуже дискретной
 * решётки кандидатов, и требует одного прохода вместо 24 assess-вызовов.
 */
const suppressionForRange = (
  generated: readonly number[],
  targetSignal: readonly number[],
  start: number,
  length: number,
): number => {
  if (length <= 0) {
    return 0;
  }

  let targetSqSum = 0;
  let residualSqSum = 0;
  for (let i = start; i < start + length; i++) {
    const t = targetSignal[i] ?? 0;
    const g = generated[i] ?? 0;
    targetSqSum += t * t;
    const residual = t - g;
    residualSqSum += residual * residual;
  }

  if (targetSqSum === 0) {
    return 0;
  }

  const targetRMS = Math.sqrt(targetSqSum / length);
  const residualRMS = Math.sqrt(residualSqSum / length);

  return (1 - residualRMS / targetRMS) * 100;
};

/**
 * Evaluates suppression using continuous window coverage.
 *
 * Strategy: contiguous non-overlapping windows of fixed size.
 * - Full windows get weight = 1.0
 * - A trailing partial window gets weight = tailLength / windowSize
 *
 * This guarantees every sample is included with proportional weight.
 * Масштаб НЕ подбирается: score честный (фиксированный масштаб 1),
 * амплитуду оптимизируют параметры volume (offset 9).
 */
export const evaluateSuppressionWindowed = (
  generated: readonly number[],
  targetSignal: readonly number[],
  penaltyWeight = 0.5,
  spectralWeight = 0.3,
  sampleRate = 44100,
  spectralProfile?: SpectralProfile,
): number => {
  const length = targetSignal.length;
  const windowSize = Math.round(WINDOW_SIZE_SECONDS * sampleRate);

  // Full contiguous windows from start
  const fullWindows = Math.floor(length / windowSize);
  const tailLength = length - fullWindows * windowSize;

  let windowScoreSum = 0;
  let totalWeight = 0;

  // Full windows (weight = 1.0 each)
  for (let w = 0; w < fullWindows; w++) {
    const start = w * windowSize;

    const targetRMS = rangeRMS(targetSignal, start, windowSize);

    if (targetRMS < 1) {
      continue;
    }

    const localBestScore = suppressionForRange(
      generated,
      targetSignal,
      start,
      windowSize,
    );

    windowScoreSum += localBestScore;
    totalWeight += 1;
  }

  // Trailing partial window (weight proportional to coverage)
  if (tailLength > 0) {
    const start = fullWindows * windowSize;

    const targetRMS = rangeRMS(targetSignal, start, tailLength);

    if (targetRMS >= 1) {
      const localBestScore = suppressionForRange(
        generated,
        targetSignal,
        start,
        tailLength,
      );

      const weight = tailLength / windowSize;
      windowScoreSum += localBestScore * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) {
    const assessment = assessCancellationQuality({
      target: [...targetSignal],
      generated: generated.map((s) => -s),
    });
    return assessment.suppressionPercent;
  }

  const avgLocalScore = windowScoreSum / totalWeight;

  const globalBestScore = suppressionForRange(
    generated,
    targetSignal,
    0,
    length,
  );

  const shapePenalty = Math.max(0, globalBestScore - avgLocalScore);

  const resolvedProfile =
    spectralProfile ??
    computeSpectralProfile(targetSignal, sampleRate);

  const spectralScore =
    spectralWeight > 0
      ? computeSpectralScore(
          targetSignal,
          generated,
          sampleRate,
          resolvedProfile,
        )
      : 0;

  return (
    avgLocalScore * (1 - spectralWeight) +
    spectralScore * spectralWeight -
    penaltyWeight * shapePenalty
  );
};

export const findOptimalScale = (
  generated: readonly number[],
  targetSignal: readonly number[],
  sampleRate = 44100,
  spectralProfile?: SpectralProfile,
): { scale: number; suppressionPercent: number } => {
  let dot = 0;
  let genSqSum = 0;
  for (let i = 0; i < generated.length; i++) {
    const t = targetSignal[i] ?? 0;
    const g = generated[i] ?? 0;
    dot += t * g;
    genSqSum += g * g;
  }

  const scale =
    genSqSum > 0
      ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, dot / genSqSum))
      : 1;

  const scaled = generated.map((s) => s * scale);
  const suppressionPercent = evaluateSuppressionWindowed(
    scaled,
    targetSignal,
    0.5,
    0.3,
    sampleRate,
    spectralProfile,
  );

  return { scale, suppressionPercent };
};

/**
 * Кэш waveform с инкрементальным пересчётом по осцилляторам.
 *
 * Аддитивный синтез линеен по осцилляторам: при изменении одного параметра
 * одного осциллятора пересинтезируется только его вклад (O(n) вместо O(n*m)),
 * сумма поддерживается инкрементально. Итоговая waveform клампится к [-1, 1]
 * и масштабируется так же, как в createSynth/createWaveForm.
 */
export class WaveformCache {
  private readonly sampleRate: number;
  private readonly numSamples: number;
  private readonly numOsc: number;
  private genome: number[];
  private readonly contributions: Float64Array[];
  private readonly enabled: boolean[];
  private readonly sum: Float64Array;

  constructor(
    initialGenome: readonly number[],
    sampleRate: number,
    numSamples: number,
  ) {
    this.sampleRate = sampleRate;
    this.numSamples = numSamples;
    this.numOsc = Math.floor(
      initialGenome.length / OSC_PARAMS_PER_OSCILLATOR,
    );
    this.genome = [...initialGenome];
    this.contributions = [];
    this.enabled = [];
    this.sum = new Float64Array(numSamples);

    for (let osc = 0; osc < this.numOsc; osc++) {
      const on =
        (this.genome[osc * OSC_PARAMS_PER_OSCILLATOR] ?? 0) >= 0.5;
      this.enabled.push(on);
      const contrib = on
        ? this.synthesizeOsc(osc)
        : new Float64Array(numSamples);
      this.contributions.push(contrib);
      if (on) {
        for (let i = 0; i < numSamples; i++) {
          this.sum[i] = (this.sum[i] ?? 0) + contrib[i]!;
        }
      }
    }
  }

  private synthesizeOsc(osc: number): Float64Array {
    const config = mapVectorToSynthConfigForOsc(this.genome, osc);
    const synth = createOscillatorGroup(config);
    const out = new Float64Array(this.numSamples);
    for (let i = 0; i < this.numSamples; i++) {
      out[i] = synth({ x: i / this.sampleRate });
    }
    return out;
  }

  /**
   * Обновляет параметр и пересчитывает вклад затронутого осциллятора.
   * No-op, если значение не изменилось.
   */
  setParam(paramIndex: number, value: number): void {
    const prev = this.genome[paramIndex] ?? 0;
    if (prev === value) {
      return;
    }
    this.genome[paramIndex] = value;

    const osc = Math.floor(paramIndex / OSC_PARAMS_PER_OSCILLATOR);
    const offset = paramIndex % OSC_PARAMS_PER_OSCILLATOR;

    const oldContrib = this.contributions[osc]!;
    for (let i = 0; i < this.numSamples; i++) {
      this.sum[i] = (this.sum[i] ?? 0) - oldContrib[i]!;
    }

    if (offset === 0) {
      this.enabled[osc] = value >= 0.5;
    }

    const contrib = this.enabled[osc]
      ? this.synthesizeOsc(osc)
      : new Float64Array(this.numSamples);
    this.contributions[osc] = contrib;

    if (this.enabled[osc]) {
      for (let i = 0; i < this.numSamples; i++) {
        this.sum[i] = (this.sum[i] ?? 0) + contrib[i]!;
      }
    }
  }

  /** Полный пересинтез из нового генома (random restart, восстановление best). */
  rebuild(genome: readonly number[]): void {
    const newGenome = [...genome];
    const newContributions: Float64Array[] = [];
    const newEnabled: boolean[] = [];
    const newSum = new Float64Array(this.numSamples);

    this.genome = newGenome;
    for (let osc = 0; osc < this.numOsc; osc++) {
      const on =
        (newGenome[osc * OSC_PARAMS_PER_OSCILLATOR] ?? 0) >= 0.5;
      newEnabled.push(on);
      if (on) {
        const contrib = this.synthesizeOsc(osc);
        newContributions.push(contrib);
        for (let i = 0; i < this.numSamples; i++) {
          newSum[i] = (newSum[i] ?? 0) + contrib[i]!;
        }
      } else {
        newContributions.push(new Float64Array(this.numSamples));
      }
    }

    this.contributions.length = 0;
    this.contributions.push(...newContributions);
    this.enabled.length = 0;
    this.enabled.push(...newEnabled);
    this.sum.fill(0);
    for (let i = 0; i < this.numSamples; i++) {
      this.sum[i] = newSum[i] ?? 0;
    }
  }

  /** Клампированная waveform в том же формате, что createWaveForm. */
  getWaveform(): number[] {
    const out = new Array<number>(this.numSamples);
    for (let i = 0; i < this.numSamples; i++) {
      const v = this.sum[i] ?? 0;
      out[i] =
        Math.max(-1, Math.min(1, v)) *
        MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
    }
    return out;
  }

  getGenome(): readonly number[] {
    return this.genome;
  }
}
