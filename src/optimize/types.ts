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
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
  config?: Partial<CoordinateDescentConfig>;
}
