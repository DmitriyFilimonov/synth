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

/**
 * Multi-scale window sizes (seconds). Metric evaluates suppression on each
 * scale independently over the useful zone and combines them. Fine scale
 * (10ms) captures attack transients; medium (50ms) captures body dynamics;
 * coarse (200ms) captures overall shape. The combined score forces CD to
 * fix errors on all timescales — a hole in any scale drags the score down.
 */
const MULTI_SCALE_WINDOWS_SECONDS = [0.01, 0.05, 0.2] as const;

/**
 * RMS threshold (int16 units) below which a 1ms probe window is considered
 * silence when detecting useful-signal boundaries. Set as a fraction of the
 * peak 1ms RMS in the target: everything below 1% of peak counts as silence.
 */
const USEFUL_ZONE_SILENCE_FRACTION = 0.01;

/** Границы оптимального масштаба при аналитическом подборе. */
const SCALE_MIN = 0.05;
const SCALE_MAX = 100;

/**
 * Диапазон полезного сигнала внутри target'а: `[startSample, endSample)`.
 * Всё вне этого диапазона в target'е — цифровая тишина; окна метрики режем
 * только по [start, end), чтобы тишина не разбавляла средний score. При
 * этом сам синтез всегда генерируется на всю длину буфера, и если он даёт
 * ненулевые сэмплы вне useful-зоны — это ловится через ringing penalty.
 *
 * `silentProbes` — маска тишины по 1мс-пробам: `1` там, где локальный RMS
 * таргета ниже порога тишины. Тишина бывает и ВНУТРИ [start, end): у
 * таргетов с плавным затуханием поздний всплеск растягивает зону через
 * длинный тихий хвост. Такие пробы нельзя оценивать относительной шкалой
 * (`1 - resid/target` при target≈0 уходит в сотни процентов минуса), они
 * штрафуются абсолютно — см. `computeRingingPenalty`.
 */
export interface UsefulZone {
  readonly start: number;
  readonly end: number;
  readonly silentProbes: Uint8Array;
  readonly probeSize: number;
}

/**
 * Автоматически определяет границы полезного сигнала по target'у.
 * Разбивает сигнал на непересекающиеся 1мс-окна, считает RMS каждого,
 * находит peak-window RMS. Полезная зона — от первого до последнего окна,
 * RMS которого ≥ 1% от peak. Всё, что вне зоны — цифровая тишина (даже
 * если формально int16 значения не строго 0).
 *
 * Дополнительно возвращает маску тишины по тем же пробам: тихие пробы
 * встречаются и внутри зоны (плавно затухающие таргеты), и относительной
 * шкалой их оценивать нельзя.
 */
export const computeUsefulZone = (
  targetSignal: readonly number[],
  sampleRate: number,
): UsefulZone => {
  const total = targetSignal.length;
  const probeSize = Math.max(1, Math.round(0.001 * sampleRate));
  if (total === 0) {
    return {
      start: 0,
      end: 0,
      silentProbes: new Uint8Array(0),
      probeSize,
    };
  }

  const numProbes = Math.floor(total / probeSize);
  if (numProbes === 0) {
    return {
      start: 0,
      end: total,
      silentProbes: new Uint8Array(0),
      probeSize,
    };
  }

  let peakRms = 0;
  const probeRms = new Float64Array(numProbes);
  for (let p = 0; p < numProbes; p++) {
    const s = p * probeSize;
    let sumSq = 0;
    for (let i = 0; i < probeSize; i++) {
      const v = targetSignal[s + i] ?? 0;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / probeSize);
    probeRms[p] = rms;
    if (rms > peakRms) {
      peakRms = rms;
    }
  }

  if (peakRms === 0) {
    return {
      start: 0,
      end: total,
      silentProbes: new Uint8Array(numProbes).fill(1),
      probeSize,
    };
  }

  const threshold = peakRms * USEFUL_ZONE_SILENCE_FRACTION;
  const silentProbes = new Uint8Array(numProbes);
  for (let p = 0; p < numProbes; p++) {
    silentProbes[p] = (probeRms[p] ?? 0) < threshold ? 1 : 0;
  }

  let firstProbe = 0;
  while (
    firstProbe < numProbes &&
    (probeRms[firstProbe] ?? 0) < threshold
  ) {
    firstProbe++;
  }
  let lastProbe = numProbes - 1;
  while (
    lastProbe > firstProbe &&
    (probeRms[lastProbe] ?? 0) < threshold
  ) {
    lastProbe--;
  }

  const start = firstProbe * probeSize;
  const end = Math.min(total, (lastProbe + 1) * probeSize);
  return { start, end, silentProbes, probeSize };
};

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
 * Штраф за «звон» синтеза на тишине target'а: там, где target ≈ 0, любой
 * ненулевой синтез даёт err_RMS > 0 при target_RMS ≈ 0. Считаем
 * нормированный «выхлоп» синтеза в тишине относительно peak target RMS —
 * это даёт CD прямой сигнал: «убей звон осцилляторов там, где сигнала нет».
 *
 * Область штрафа — все тихие пробы (`silentProbes`), а не только сэмплы вне
 * `[start, end)`. У таргетов с плавным затуханием тихий хвост попадает
 * ВНУТРЬ зоны, и оконная относительная метрика его корректно оценить не
 * может; абсолютная нормировка по peak RMS — может.
 */
const computeRingingPenalty = (
  generated: readonly number[],
  usefulZone: UsefulZone,
  peakTargetRms: number,
): number => {
  if (peakTargetRms <= 0) {
    return 0;
  }
  const total = generated.length;
  const { silentProbes, probeSize } = usefulZone;
  let outSumSq = 0;
  let outCount = 0;

  for (let p = 0; p < silentProbes.length; p++) {
    if (silentProbes[p] === 0) {
      continue;
    }
    const from = p * probeSize;
    const to = Math.min(from + probeSize, total);
    for (let i = from; i < to; i++) {
      const g = generated[i] ?? 0;
      outSumSq += g * g;
      outCount++;
    }
  }

  // Хвост короче пробы всегда лежит за последней пробой, а значит и за
  // границей полезной зоны — он тоже тишина.
  for (let i = silentProbes.length * probeSize; i < total; i++) {
    const g = generated[i] ?? 0;
    outSumSq += g * g;
    outCount++;
  }

  if (outCount === 0) {
    return 0;
  }
  const outRms = Math.sqrt(outSumSq / outCount);
  return (outRms / peakTargetRms) * 100;
};

/**
 * Multi-scale windowed suppression score restricted to the useful zone.
 *
 * For each scale (10ms/50ms/200ms) the useful range [start, end) is
 * partitioned into non-overlapping windows; each window's suppression is
 * computed with `suppressionForRange` and averaged **weighted by target
 * window energy**. The weighting is load-bearing: the per-window score is
 * relative (`1 - resid/target`), so a near-silent window inside the zone
 * scores in the hundreds of percent negative and, averaged unweighted,
 * dominates everything. Energy weighting also makes this surrogate track
 * the honest global suppression instead of understating it.
 *
 * The final score aggregates all three scales with equal weight, then a
 * ringing penalty is subtracted for synthesizer energy in the target's
 * silent regions — which the energy weighting has deliberately stopped
 * scoring, so the penalty is what keeps the tail under control.
 */
const evaluateMultiScaleWindowed = (
  generated: readonly number[],
  targetSignal: readonly number[],
  sampleRate: number,
  usefulZone: UsefulZone,
): number => {
  const length = usefulZone.end - usefulZone.start;
  if (length <= 0) {
    return 0;
  }

  let peakTargetRms = 0;
  const scaleScores: number[] = [];
  for (const scaleSec of MULTI_SCALE_WINDOWS_SECONDS) {
    const windowSize = Math.max(1, Math.round(scaleSec * sampleRate));
    if (windowSize > length) {
      continue;
    }
    const fullWindows = Math.floor(length / windowSize);
    const tailLength = length - fullWindows * windowSize;

    let sumScoreWeighted = 0;
    let totalWeight = 0;

    for (let w = 0; w < fullWindows; w++) {
      const s = usefulZone.start + w * windowSize;
      const tgtRms = rangeRMS(targetSignal, s, windowSize);
      if (tgtRms > peakTargetRms) {
        peakTargetRms = tgtRms;
      }
      if (tgtRms < 1) {
        continue;
      }
      const score = suppressionForRange(
        generated,
        targetSignal,
        s,
        windowSize,
      );
      const weight = tgtRms * tgtRms;
      sumScoreWeighted += score * weight;
      totalWeight += weight;
    }
    if (tailLength > 0) {
      const s = usefulZone.start + fullWindows * windowSize;
      const tgtRms = rangeRMS(targetSignal, s, tailLength);
      if (tgtRms > peakTargetRms) {
        peakTargetRms = tgtRms;
      }
      if (tgtRms >= 1) {
        const score = suppressionForRange(
          generated,
          targetSignal,
          s,
          tailLength,
        );
        const weight = tgtRms * tgtRms * (tailLength / windowSize);
        sumScoreWeighted += score * weight;
        totalWeight += weight;
      }
    }

    if (totalWeight > 0) {
      scaleScores.push(sumScoreWeighted / totalWeight);
    }
  }

  if (scaleScores.length === 0) {
    return 0;
  }

  const avgScale =
    scaleScores.reduce((a, b) => a + b, 0) / scaleScores.length;
  const worstScale = Math.min(...scaleScores);
  // Bias toward worst-scale to force fixing errors on every timescale.
  const combined = worstScale * 0.5 + avgScale * 0.5;

  const ringingPenalty = computeRingingPenalty(
    generated,
    usefulZone,
    peakTargetRms,
  );

  return combined - ringingPenalty;
};

/**
 * Evaluates suppression using multi-scale windowed RMS on the useful zone
 * of the target, minus a ringing penalty for synthesizer energy outside
 * the zone.
 *
 * Windows are cut at three time scales (10ms/50ms/200ms) inside the useful
 * zone; each scale contributes its average per-window suppression; the
 * combined score biases toward the worst-performing scale so CD cannot
 * ignore attack transients or the tail of the useful signal. Beyond the
 * useful zone target is digital silence — any synthesized energy there
 * is charged as a penalty proportional to peak target RMS.
 *
 * The synthesizer is always generated on the full buffer length; the
 * useful zone only restricts which samples enter the RMS integral.
 * Ringing that leaks outside the zone is caught by the penalty term,
 * so the JSON-encoded synth config stays consistent with the full 500ms
 * signal even though the metric focuses on the informative interval.
 *
 * `usefulZone` — оптимизация: если передан, метрика не пересчитывает зону
 * при каждом вызове (тысячи раз за итерацию CD). Callers, знающие target
 * заранее, вычисляют её один раз через `computeUsefulZone(target, rate)`
 * и пробрасывают сюда. Если не передан — вычисляется на лету.
 *
 * Масштаб НЕ подбирается: score честный (фиксированный масштаб 1),
 * амплитуду оптимизируют параметры volume (offset 9).
 */
export const evaluateSuppressionWindowed = (
  generated: readonly number[],
  targetSignal: readonly number[],
  sampleRate = 44100,
  usefulZone?: UsefulZone,
): number => {
  const zone =
    usefulZone ?? computeUsefulZone(targetSignal, sampleRate);
  return evaluateMultiScaleWindowed(
    generated,
    targetSignal,
    sampleRate,
    zone,
  );
};

export const findOptimalScale = (
  generated: readonly number[],
  targetSignal: readonly number[],
  sampleRate = 44100,
  usefulZone?: UsefulZone,
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
    sampleRate,
    usefulZone,
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
