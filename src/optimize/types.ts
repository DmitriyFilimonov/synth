export interface ProgressEntry {
  iteration: number;
  suppressionPercent: number;
  phase?: 'hpo' | 'cd';
  stageIndex?: number;
  totalStages?: number;
  stageDurationMs?: number;
  /** CD cycle label (EXPLORATION / REFINEMENT / PRECISION). */
  cycle?: string;
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
  randomRestartRegressionLimit: number;
  restartSchedule: Array<{
    startStep: number;
    minStep: number;
    label: string;
  }>;
  frequencyStep: number;
  frequencyStepCoarse: number;
  frequencyStepRefine: number;
  phaseStep: number;
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
