import type { CoordinateDescentSampleWork } from './sample-work';

export interface ProgressEntry {
  iteration: number;
  suppressionPercent: number;
  /** CD cycle label (EXPLORATION / REFINEMENT / PRECISION). */
  cycle?: string;
  /**
   * Snapshot of the best-so-far normalized parameter vector.
   *
   * Populated only on best-score updates (not every iteration) to
   * keep progress traffic light. Consumers may persist this to
   * expose intermediate synth configurations for running jobs.
   */
  bestVector?: readonly number[];
  /**
   * Фактические N-проходы с начала прогона. Поле появляется только при
   * заданном `config.maxSampleWork`, поэтому обычный golden не меняется.
   */
  sampleWork?: CoordinateDescentSampleWork;
  /** Общий жёсткий предел N-проходов, если он был задан. */
  maxSampleWork?: number;
  /** CD остановился перед следующей целой итерацией или финальными стадиями. */
  workBudgetStop?: boolean;
  /**
   * Финальные prune/scale стадии не выполнялись. Поле записывается только
   * в последний budgeted progress и не зависит от остановки перед iter.
   */
  finalStagesSkipped?: boolean;
}

export type ProgressCallback = (entry: ProgressEntry) => void;

import type { CoordinateDescentConfig } from './coordinate-descent';

export interface ArgOptimize {
  initialVector: readonly number[];
  targetSignal: readonly number[];
  sampleRate: number;
  maxIterations?: number;
  onProgress?: ProgressCallback;
  numOscillators?: number;
  /**
   * Неизменные onset по индексам слотов вне десятипараметрового вектора.
   * Если поле задано одновременно с config.fixedDelaySeconds, верхний
   * уровень явно имеет приоритет.
   */
  fixedDelaySeconds?: readonly number[];
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
  config?: Partial<CoordinateDescentConfig>;
}
