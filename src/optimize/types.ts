export interface ProgressEntry {
  iteration: number;
  suppressionPercent: number;
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
