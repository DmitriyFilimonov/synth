/* eslint-disable no-console */
import { OSC_PARAMS, clampVolume, clamp01 } from './consts';
import {
  VOLUME_PRUNE_THRESHOLD,
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
} from '../consts';
import { oscConfigNormales, ampEnvConfigNormales } from '../synth';
import {
  WaveformCache,
  SpectralProfile,
  evaluateSuppressionWindowed,
} from './evaluate';

const TWO_PI = 2 * Math.PI;

const FREQ_MIN_HZ = oscConfigNormales.freqBase.min;
const FREQ_MAX_HZ = oscConfigNormales.freqBase.max;

// Границы сканирования остатка: ниже 40 Гц разрешение Goertzel на
// коротких окнах недостаточно, выше 10 кГц энергия таргетов редка.
const SCAN_MIN_HZ = 40;
const SCAN_MAX_HZ = 10000;
const SCAN_COARSE_STEP_HZ = 5;
const SCAN_REFINE_STEP_HZ = 0.5;

// Пик остатка ближе этого расстояния к частоте активного
// осциллятора считается уже покрытым (CD уточнит его локально).
// 8 Гц: плотные гребёнки (пики через 8–9 Гц) должны покрываться
// полностью, а не через одного.
const COVERED_SEPARATION_HZ = 8;

// Пик остатка слабее этого порога не оправдывает relocation.
// Низкий порог (~0.002 полной шкалы): богатые спектры несут
// энергию в десятках слабых компонент — каждый мизерный,
// но суммарно значимы для тембра; отсев по «сильному» порогу
// здесь — это и есть деградация к малому числу осцилляторов.
const MIN_PEAK_MAGNITUDE = 0.002 * MAX_AMPLITUDE_16_BIT_WAV_ENCODED;

// Стартовая громкость relocate-нутого осциллятора: по амплитуде
// пика остатка (mag / full-scale), но не ниже RELOCATION_MIN_LEVEL.
// Минимум чуть выше prune-порога: осциллятор не становится
// prune-кандидатом в ту же итерацию (иначе relocation-попытки
// повторяются каждую итерацию, сжигая лимит и бюджет), но CD
// приглушит призрачный пик обратно за ~10 итераций.
const RELOCATION_MIN_LEVEL = VOLUME_PRUNE_THRESHOLD + 0.005;
const RELOCATION_MAX_LEVEL = 0.5;

const IDX_FREQ_BASE = 1;
const IDX_FREQ_START = 2;
const IDX_OSC_SLOPE = 3;
const IDX_OSC_DURATION = 4;
const IDX_PHASE = 5;
const IDX_AMP_DURATION = 6;
const IDX_AMP_END = 7;
const IDX_AMP_SLOPE = 8;
const IDX_AMP_START = 9;

/**
 * Амплитуда проекции сигнала на гармонику freqHz — рекуррентный
 * Goertzel (O(n), без тригонометрии в цикле).
 *
 * @param residual - Остаток target − synth (или любой сигнал)
 * @param sampleRate - Частота дискретизации, Гц
 * @param freqHz - Частота гармоники проекции, Гц
 * @returns Амплитуда гармоники в единицах входного сигнала
 * @remarks Используется в скане остатка: magnitude точна и при
 *   нецелом k, а наивная DFT-проекция с cos/sin на сэмпл здесь
 *   в ~80 раз медленнее и делала бы скан доминирующей стоимостью
 *   CD.
 */
const residualMagnitude = (
  residual: readonly number[],
  sampleRate: number,
  freqHz: number,
): number => {
  const n = residual.length;
  const k = (freqHz * n) / sampleRate;
  const omega = (TWO_PI * k) / n;
  const coeff = 2 * Math.cos(omega);

  let sPrev = 0;
  let sPrev2 = 0;
  for (let i = 0; i < n; i++) {
    const sCurr = (residual[i] ?? 0) + coeff * sPrev - sPrev2;
    sPrev2 = sPrev;
    sPrev = sCurr;
  }

  const power =
    sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2;
  return (2 * Math.sqrt(power)) / n;
};

/**
 * Точная амплитуда и фаза проекции сигнала на sin-гармонику
 * freqHz — прямая DFT-проекция (cos/sin на сэмпл).
 *
 * @param residual - Остаток target − synth (или любой сигнал)
 * @param sampleRate - Частота дискретизации, Гц
 * @param freqHz - Частота гармоники проекции, Гц
 * @returns Амплитуда и фаза φ (рад, [0, 2π)) гармоники
 * @remarks Дороже Goertzel, но вызывается один раз на найденный
 *   пик. Фаза рекуррентного Goertzel при нецелом k имеет
 *   систематическую ошибку frac(k)·2π рад (верифицировано численно:
 *   f=553 Гц, k=55.3 → ошибка 1.89 рад — relocate ставил
 *   осциллятор почти в противофазу), поэтому для фазы Goertzel
 *   не используется.
 *   Для s(t) = A·sin(2πft + φ): X = Σ s·e^{−iωi} =
 *   (An/2)·e^{i(φ−π/2)} → возвращаемая phase = φ (пригодна для
 *   oscillatorCreator).
 */
const residualMagPhaseDFT = (
  residual: readonly number[],
  sampleRate: number,
  freqHz: number,
): { magnitude: number; phase: number } => {
  const n = residual.length;
  const omega = (TWO_PI * freqHz) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const s = residual[i] ?? 0;
    re += s * Math.cos(omega * i);
    im -= s * Math.sin(omega * i);
  }
  re /= n;
  im /= n;
  const magnitude = Math.sqrt(re * re + im * im) * 2;
  const extracted = Math.atan2(im, re);
  const phase =
    (((extracted + Math.PI / 2) % TWO_PI) + TWO_PI) % TWO_PI;
  return { magnitude, phase };
};

/**
 * Ищет доминантную частоту остатка (target − synth), не покрытую
 * включёнными осцилляторами.
 *
 * @param residual - Остаток target − synth
 * @param sampleRate - Частота дискретизации, Гц
 * @param excludeFreqsHz - Покрытые частоты (Гц): пики ближе
 *   COVERED_SEPARATION_HZ к ним игнорируются
 * @returns Частота, амплитуда и фаза пика или null, если
 *   приличного пика нет (все пики ниже MIN_PEAK_MAGNITUDE)
 * @remarks Двухпроходный Goertzel-скан: грубый (5 Гц) → уточнение
 *   (0.5 Гц) вокруг найденного пика. Фаза извлекается точной
 *   DFT-проекцией на уточнённой частоте.
 */
const findResidualPeak = (
  residual: readonly number[],
  sampleRate: number,
  excludeFreqsHz: readonly number[],
): { freqHz: number; magnitude: number; phase: number } | null => {
  const isCovered = (f: number): boolean =>
    excludeFreqsHz.some(
      (e) => Math.abs(e - f) < COVERED_SEPARATION_HZ,
    );

  let bestFreq = 0;
  let bestMag = 0;
  for (
    let f = SCAN_MIN_HZ;
    f <= SCAN_MAX_HZ;
    f += SCAN_COARSE_STEP_HZ
  ) {
    if (isCovered(f)) {
      continue;
    }
    const magnitude = residualMagnitude(residual, sampleRate, f);
    if (magnitude > bestMag) {
      bestMag = magnitude;
      bestFreq = f;
    }
  }

  if (bestFreq === 0 || bestMag < MIN_PEAK_MAGNITUDE) {
    return null;
  }

  // Уточнение вокруг грубого пика
  let refinedFreq = bestFreq;
  let refinedMag = bestMag;
  const refineFrom = Math.max(
    SCAN_MIN_HZ,
    bestFreq - SCAN_COARSE_STEP_HZ,
  );
  const refineTo = Math.min(
    SCAN_MAX_HZ,
    bestFreq + SCAN_COARSE_STEP_HZ,
  );
  for (let f = refineFrom; f <= refineTo; f += SCAN_REFINE_STEP_HZ) {
    if (isCovered(f)) {
      continue;
    }
    const magnitude = residualMagnitude(residual, sampleRate, f);
    if (magnitude > refinedMag) {
      refinedMag = magnitude;
      refinedFreq = f;
    }
  }

  // Фаза — точная DFT-проекция на найденной частоте (фаза
  // рекуррентного Goertzel при нецелом k систематически смещена).
  const { phase } = residualMagPhaseDFT(
    residual,
    sampleRate,
    refinedFreq,
  );

  return {
    freqHz: refinedFreq,
    magnitude: refinedMag,
    phase,
  };
};

const normalizeFreqHz = (hz: number): number =>
  clamp01((hz - FREQ_MIN_HZ) / (FREQ_MAX_HZ - FREQ_MIN_HZ));

const normalize01Range = (
  value: number,
  range: { min: number; max: number },
): number => clamp01((value - range.min) / (range.max - range.min));

/**
 * Собирает частоты freqBase (Гц) активных осцилляторов генома —
 * список «покрытых» частот для exclusion при скане остатка.
 *
 * @param genome - Вектор параметров (осцилляторы × OSC_PARAMS)
 * @returns Частоты freqBase (Гц) включённых осцилляторов
 * @remarks Осцилляторы с volume на уровне prune-порога (мусорные,
 *   сами кандидаты на relocation) пики остатка НЕ блокируют: иначе
 *   десятки мусорных полос ±15 Гц перекрывают реальные пики
 *   и relocation не находит места.
 */
const collectCoveredFreqsHz = (
  genome: readonly number[],
): number[] => {
  const freqs: number[] = [];
  for (let base = 0; base < genome.length; base += OSC_PARAMS) {
    const on = (genome[base] ?? 0) >= 0.5;
    const volume = genome[base + IDX_AMP_START] ?? 0;
    if (on && volume > VOLUME_PRUNE_THRESHOLD) {
      const norm = genome[base + IDX_FREQ_BASE] ?? 0;
      freqs.push(norm * (FREQ_MAX_HZ - FREQ_MIN_HZ) + FREQ_MIN_HZ);
    }
  }
  return freqs;
};

/**
 * Один greedy-проход по 9 параметрам relocate-нутого осциллятора.
 *
 * @param arg.genome - Геном (мутируется: лучшие значения
 *   фиксируются)
 * @param arg.waveformCache - Кэш waveform, синхронизирован с геномом
 * @param arg.oscIndex - Индекс relocate-нутого осциллятора
 * @param arg.targetSignal - Эталонный сигнал
 * @param arg.sampleRate - Частота дискретизации, Гц
 * @param arg.score - Текущий windowed-score (стартовая точка)
 * @param arg.spectralProfile - Спектральный профиль таргета
 * @returns Лучший windowed-score после прохода
 * @remarks Сырая ровная огибающая relocate почти никогда не
 *   оптимальна (у таргетного тона своя затухающая огибающая),
 *   поэтому оценка «потенциала» relocation делается не по сырому
 *   score, а по score после этого уточняющего прохода — иначе
 *   relocation на реальный пик отвергалась бы из-за заниженного
 *   немедленного выигрыша. Шаги грубые (частота ~2 Гц, фаза ~1.1°):
 *   задача прохода — оценить потенциал, дооптимизацию сделает
 *   основной CD.
 */
const relocationGreedyPass = (arg: {
  genome: number[];
  waveformCache: WaveformCache;
  oscIndex: number;
  targetSignal: readonly number[];
  sampleRate: number;
  score: number;
  spectralProfile: SpectralProfile;
}): number => {
  const {
    genome,
    waveformCache,
    oscIndex,
    targetSignal,
    sampleRate,
    spectralProfile,
  } = arg;
  const base = oscIndex * OSC_PARAMS;

  // Шаги в нормализованных единицах: частота ~2 Гц (как EXPLORATION),
  // фаза ~1.1°, огибающие грубые — задача прохода оценить потенциал,
  // а не дооптимизировать (это сделает основной CD).
  const steps: Record<number, number> = {
    [IDX_FREQ_BASE]: 0.0001,
    [IDX_FREQ_START]: 0.0001,
    [IDX_OSC_SLOPE]: 0.05,
    [IDX_OSC_DURATION]: 0.05,
    [IDX_PHASE]: 0.003125,
    [IDX_AMP_DURATION]: 0.05,
    [IDX_AMP_END]: 0.05,
    [IDX_AMP_SLOPE]: 0.05,
    [IDX_AMP_START]: 0.25, // мультипликативный: ×(1±0.25)
  };

  let best = arg.score;
  for (let p = 1; p < OSC_PARAMS; p++) {
    const idx = base + p;
    const center = genome[idx] ?? 0;
    const step = steps[p] ?? 0.05;
    const candidates =
      p === IDX_AMP_START
        ? [
            clampVolume(center * (1 - step)),
            clampVolume(center * (1 + step)),
          ]
        : [clamp01(center - step), clamp01(center + step)];

    let bestValue = center;
    for (const cand of candidates) {
      waveformCache.setParam(idx, cand);
      const probe = evaluateSuppressionWindowed(
        waveformCache.getWaveform(),
        targetSignal,
        0.5,
        0.3,
        sampleRate,
        spectralProfile,
      );
      if (probe > best) {
        best = probe;
        bestValue = cand;
      }
    }
    waveformCache.setParam(idx, bestValue);
    genome[idx] = bestValue;
  }
  return best;
};

/**
 * Residual-guided relocation: переставляет слабый осциллятор
 * (oscIndex) на доминантную частоту остатка target − synth.
 *
 * @param arg.genome - Геном (мутируется при принятии relocation)
 * @param arg.waveformCache - Кэш waveform, синхронизирован с геномом
 * @param arg.oscIndex - Индекс слабого осциллятора-кандидата
 * @param arg.targetSignal - Эталонный сигнал
 * @param arg.sampleRate - Частота дискретизации, Гц
 * @param arg.currentScore - Текущий windowed-score генома
 * @param arg.spectralProfile - Спектральный профиль таргета
 * @param arg.minImprovement - Минимальное улучшение score (п.п.)
 *   для принятия relocation (дефолт 0)
 * @returns relocated=true и новый score, если relocation принят;
 *   иначе relocated=false и исходный score
 * @remarks Мотивация: coordinate descent — локальный поиск, шаг
 *   частоты (~2 Гц) не позволяет осциллятору с неверной стартовой
 *   частотой дойти до правильной за сотни Гц. Локальный оптимум
 *   такого осциллятора — volume→0 → выключение, и сложный таргет
 *   аппроксимируется 2–3 осцилляторами вместо реального числа.
 *   Relocation совершает дальний прыжок туда, где энергии остатка
 *   больше всего, вместо отключения «мешающего» осциллятора.
 *   Принимается, только если windowed-score после greedy-прохода
 *   строго улучшается; иначе геном и кэш откатываются к исходному
 *   состоянию.
 */
export const tryRelocateOscillator = (arg: {
  genome: number[];
  waveformCache: WaveformCache;
  oscIndex: number;
  targetSignal: readonly number[];
  sampleRate: number;
  currentScore: number;
  spectralProfile: SpectralProfile;
  /** Минимальное улучшение score (п.п.) для принятия relocation. */
  minImprovement?: number;
}): { relocated: boolean; score: number } => {
  const {
    genome,
    waveformCache,
    oscIndex,
    targetSignal,
    sampleRate,
    currentScore,
    spectralProfile,
    minImprovement = 0,
  } = arg;

  // Остаток против текущего состояния (кандидат ещё включён,
  // но его вклад при volume ≤ prune-порога пренебрежим).
  const generated = waveformCache.getWaveform();
  const residual = new Array<number>(targetSignal.length);
  for (let i = 0; i < targetSignal.length; i++) {
    residual[i] = (targetSignal[i] ?? 0) - (generated[i] ?? 0);
  }

  const peak = findResidualPeak(
    residual,
    sampleRate,
    collectCoveredFreqsHz(genome),
  );
  if (!peak) {
    return { relocated: false, score: currentScore };
  }

  const base = oscIndex * OSC_PARAMS;
  const saved: number[] = [];
  for (let p = 1; p < OSC_PARAMS; p++) {
    saved.push(genome[base + p] ?? 0);
  }

  const durationSec = targetSignal.length / sampleRate;
  const freqNorm = normalizeFreqHz(peak.freqHz);
  const startLevel = clampVolume(
    Math.max(
      RELOCATION_MIN_LEVEL,
      Math.min(
        RELOCATION_MAX_LEVEL,
        peak.magnitude / MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
      ),
    ),
  );

  const relocated: Record<number, number> = {
    [IDX_FREQ_BASE]: freqNorm,
    [IDX_FREQ_START]: freqNorm,
    [IDX_OSC_SLOPE]: normalize01Range(0.8, oscConfigNormales.slope),
    [IDX_OSC_DURATION]: normalize01Range(
      durationSec,
      oscConfigNormales.duration,
    ),
    [IDX_PHASE]: clamp01(peak.phase / TWO_PI),
    [IDX_AMP_DURATION]: normalize01Range(
      durationSec,
      ampEnvConfigNormales.duration,
    ),
    [IDX_AMP_END]: normalize01Range(
      startLevel * 0.9,
      ampEnvConfigNormales.endLevel,
    ),
    [IDX_AMP_SLOPE]: normalize01Range(
      0.8,
      ampEnvConfigNormales.slope,
    ),
    [IDX_AMP_START]: normalize01Range(
      startLevel,
      ampEnvConfigNormales.startLevel,
    ),
  };

  for (let p = 1; p < OSC_PARAMS; p++) {
    const value = relocated[p] ?? 0;
    genome[base + p] = value;
    waveformCache.setParam(base + p, value);
  }

  // Оценка потенциала: greedy-проход по параметрам осциллятора.
  // Сырое relocation-значение score занижено неточной огибающей;
  // реальный пик после уточнения даёт выигрыш, призрачный — нет
  // (CD немедленно приглушает его volume обратно).
  const score = relocationGreedyPass({
    genome,
    waveformCache,
    oscIndex,
    targetSignal,
    sampleRate,
    score: evaluateSuppressionWindowed(
      waveformCache.getWaveform(),
      targetSignal,
      0.5,
      0.3,
      sampleRate,
      spectralProfile,
    ),
    spectralProfile,
  });

  if (score > currentScore + minImprovement) {
    console.log(
      `[CoordDescent] Relocation: osc[${oscIndex}] → ${peak.freqHz.toFixed(1)} Hz, score ${currentScore.toFixed(4)}% → ${score.toFixed(4)}%`,
    );
    return { relocated: true, score };
  }

  // Откат: relocation не улучшила score
  for (let p = 1; p < OSC_PARAMS; p++) {
    const value = saved[p - 1] ?? 0;
    genome[base + p] = value;
    waveformCache.setParam(base + p, value);
  }
  if (process.env.DEBUG_RELOC) {
    console.log(
      `[RelocDebug] osc[${oscIndex}] → ${peak.freqHz.toFixed(1)} Hz REJECTED: ${currentScore.toFixed(4)}% → ${score.toFixed(4)}% (mag=${peak.magnitude.toFixed(0)})`,
    );
  }
  return { relocated: false, score: currentScore };
};
