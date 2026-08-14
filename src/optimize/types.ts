export interface ProgressEntry {
  iteration: number;
  suppressionPercent: number;
  stageIndex?: number;
  totalStages?: number;
  stageDurationMs?: number;
}

export type ProgressCallback = (entry: ProgressEntry) => void;

/**
 * Конфигурация алгоритма coordinate descent.
 * Может быть переопределена для HPO-подбора.
 * @see CoordinateDescentConfig in coordinate-descent.ts
 */
export interface CoordinateDescentConfig {
  stagnationExitThreshold: number;
  plateauRestartThreshold: number;
  stepGrowthThreshold: number;
  stagnationStepDecayFactor: number;
  significantImprovementThreshold: number;
  earlyExitSuppression: number;
  maxRestartsBeforeRandomRestart: number;
  kickFallbackThreshold: number;
  restartSchedule: Array<{
    startStep: number;
    minStep: number;
    label: string;
  }>;
}

export interface ArgOptimize {
  initialVector: readonly number[];
  targetSignal: readonly number[];
  sampleRate: number;
  maxIterations?: number;
  onProgress?: ProgressCallback;
  numOscillators?: number;
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
  config?: Partial<CoordinateDescentConfig>;
}
