/**
 * Модуль оценки качества противофазного подавления сигнала.
 *
 * ## Принцип работы
 *
 * При сложении двух сигналов в противофазе происходит интерференция —
 * амплитуды вычитаются. Если сгенерированный сигнал находится в идеальной
 * противофазе с таргетным и имеет совпадающие амплитуды, результат их
 * сложения будет близок к нулю (полное подавление).
 *
 * ## Метрика
 *
 * Используется **RMS (Root Mean Square)** — среднеквадратичное значение
 * энергии сигнала. Сравнение проходит в два этапа:
 *
 * 1. Вычисляется энергия таргетного сигнала (`targetRMS`).
 * 2. Вычисляется энергия суммы таргетного и сгенерированного сигналов
 *    (`resultRMS`) — это остаточная энергия после «вычитания».
 *
 * Качество подавления = `(1 - resultRMS / targetRMS) * 100%`
 *
 * Если результат текущей итерации полностью заглушил таргетный сигнал,
 * `resultRMS ≈ 0` и качество подавления ≈ 100%.
 *
 * ## Порог удовлетворительности
 *
 * Подавление считается удовлетворительным при ≥ 98%.
 *
 * ## Пример
 *
 * ```ts
 * const target = [1, 0.5, -0.3, /* ... *\/];
 * const generated = [-1, -0.5, 0.3, /* ... *\/];
 *
 * const assessment = assessCancellationQuality({ target, generated });
 *
 * console.log(assessment.suppressionPercent); // ~100
 * console.log(assessment.isSatisfactory);     // true
 * ```
 */

import { calculateRMS } from './rms';

interface ArgAssessCancellationQuality {
  /** Таргетный сигнал, который нужно подавить */
  target: number[];
  /** Сгенерированный сигнал (в противофазе) */
  generated: number[];
  /** Порог подавления в процентах (по умолчанию 98) */
  thresholdPercent?: number;
}

/** Результат оценки качества подавления */
export interface CancellationAssessment {
  /** RMS энергия таргетного сигнала */
  targetRMS: number;
  /** RMS энергия остаточного сигнала (target + generated) */
  residualRMS: number;
  /** Процент подавления (0–100+) */
  suppressionPercent: number;
  /** Достигло ли подавление порога удовлетворительности. */
  isSatisfactory: boolean;
}

const validateCancellationArg = (
  target: number[],
  generated: number[],
  targetRMS: number,
): void => {
  if (target.length === 0 || generated.length === 0) {
    throw new Error(
      'Both target and generated signals must contain at least one sample.',
    );
  }

  if (targetRMS === 0) {
    throw new Error(
      'Target signal has zero energy — nothing to assess.',
    );
  }
};

/**
 * Оценивает качество противофазного подавления таргетного сигнала.
 *
 * Складывает таргетный и сгенерированный сигналы и измеряет
 * остаточную энергию по сравнению с исходной энергией таргета.
 */
export const assessCancellationQuality = (
  arg: ArgAssessCancellationQuality,
): CancellationAssessment => {
  const { target, generated, thresholdPercent = 98 } = arg;

  const length = Math.min(target.length, generated.length);
  const targetRMS = calculateRMS(target.slice(0, length));

  validateCancellationArg(target, generated, targetRMS);

  const residual: number[] = [];

  for (let i = 0; i < length; i++) {
    const targetSample = target[i];
    const generatedSample = generated[i];

    if (targetSample === undefined || generatedSample === undefined) {
      break;
    }

    residual.push(targetSample + generatedSample);
  }

  const residualRMS = calculateRMS(residual);

  const suppressionPercent = (1 - residualRMS / targetRMS) * 100;

  return {
    targetRMS,
    residualRMS,
    suppressionPercent,
    isSatisfactory: suppressionPercent >= thresholdPercent,
  };
};
