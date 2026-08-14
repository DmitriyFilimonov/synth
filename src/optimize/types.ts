export interface ProgressEntry {
  iteration: number;
  suppressionPercent: number;
  stageIndex?: number;
  totalStages?: number;
  stageDurationMs?: number;
}

export type ProgressCallback = (entry: ProgressEntry) => void;

export interface ArgOptimize {
  initialVector: readonly number[];
  targetSignal: readonly number[];
  sampleRate: number;
  maxIterations?: number;
  onProgress?: ProgressCallback;
  numOscillators?: number;
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
}
