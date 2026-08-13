export interface ProgressEntry {
  iteration: number;
  suppressionPercent: number;
  status?: 'optimizing' | 'stagnation' | 'fine_tuning' | 'done';
}

export type ProgressCallback = (entry: ProgressEntry) => void;

export interface ArgOptimize {
  initialVector: readonly number[];
  targetSignal: readonly number[];
  sampleRate: number;
  maxIterations?: number;
  onProgress?: ProgressCallback;
  numOscillators?: number;
}

export interface PerturbationResult {
  genome: number[];
  score: number;
}
