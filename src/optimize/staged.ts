/* eslint-disable no-console */
import {
  coordinateDescent,
  type CoordinateDescentConfig,
} from './coordinate-descent';
import type {
  ProgressEntry,
  ProgressCallback,
  ArgOptimize,
} from './types';

/**
 * Публичный аргумент оптимизации. Наследует `ArgOptimize`, поверх него
 * добавляет только опциональные overrides шага/decay (алиас для CD).
 * Никаких стадий, HPO, fundamentalHz и связанных гиперпараметров —
 * оптимизация всегда идёт одним проходом координатного спуска на полном
 * сигнале.
 */
export interface ArgStagedOptimize extends Omit<
  ArgOptimize,
  'targetSignal'
> {
  targetSignal: readonly number[];
  sampleRate: number;
  maxIterations: number;
  onProgress?: ProgressCallback;
}

export interface StageResult {
  stageIndex: number;
  stageDurationMs: number;
  stageSamples: number;
  suppressionPercent: number;
  iterations: number;
}

export interface OptimizeResult {
  vector: number[];
  history: ProgressEntry[];
  stageResults: StageResult[];
}

/** Backward-compat alias. */
export type StagedOptimizeResult = OptimizeResult;

/**
 * Запускает координатный спуск на полном таргетном сигнале.
 *
 * Прежде здесь было поэтапное усложнение длительности + HPO подбор
 * гиперпараметров. Многолетний опыт показал: staged и HPO стабильно
 * ничего не улучшают, поэтому обёртка сведена к одному вызову CD.
 * Имя `stagedOptimize` сохранено для существующих call-sites.
 */
export const stagedOptimize = (
  arg: ArgStagedOptimize & {
    config?: Partial<CoordinateDescentConfig>;
  },
): OptimizeResult => {
  const {
    targetSignal,
    sampleRate,
    initialVector,
    maxIterations,
    onProgress,
    stepGrowthAdd,
    stepDecayFactor,
    config,
  } = arg;

  const totalSamples = targetSignal.length;
  const history: ProgressEntry[] = [];

  console.log(
    `[CD] ${maxIterations} iter, ${((totalSamples / sampleRate) * 1000).toFixed(0)}ms signal`,
  );

  const wrappedProgress: ProgressCallback | undefined = onProgress
    ? (entry): void => {
        // Cap history to prevent OOM on postMessage serialization.
        if (history.length > 10000) {
          history.length = 5000;
        }
        const wrappedEntry: ProgressEntry = {
          iteration: entry.iteration,
          suppressionPercent: entry.suppressionPercent,
          cycle: entry.cycle,
        };
        if (entry.bestVector !== undefined) {
          wrappedEntry.bestVector = entry.bestVector;
        }
        history.push(wrappedEntry);
        onProgress(wrappedEntry);
      }
    : undefined;

  const { vector, history: cdHistory } = coordinateDescent(
    initialVector,
    targetSignal,
    sampleRate,
    maxIterations,
    wrappedProgress,
    stepGrowthAdd,
    stepDecayFactor,
    config,
  );

  const finalHistory = onProgress ? history : cdHistory;
  const lastSuppression =
    finalHistory.length > 0
      ? (finalHistory[finalHistory.length - 1]?.suppressionPercent ??
        0)
      : 0;

  const stageResult: StageResult = {
    stageIndex: 0,
    stageDurationMs: (totalSamples / sampleRate) * 1000,
    stageSamples: totalSamples,
    suppressionPercent: lastSuppression,
    iterations: finalHistory.length,
  };

  console.log(
    `[CD] Done: ${lastSuppression.toFixed(2)}% in ${finalHistory.length} iter`,
  );

  return {
    vector,
    history: finalHistory,
    stageResults: [stageResult],
  };
};
