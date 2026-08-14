/**
 * Distribution types for hyperparameter sampling.
 * Optuna-style distributions for the TPE sampler.
 */

/** Continuous float parameter. */
export interface FloatDistribution {
  type: 'float';
  low: number;
  high: number;
  log: boolean;
  step: number | null;
}

/** Discrete integer parameter. */
export interface IntDistribution {
  type: 'int';
  low: number;
  high: number;
  log: boolean;
  step: number | null;
}

/** One of predefined options. */
export interface CategoricalDistribution {
  type: 'categorical';
  choices: readonly unknown[];
}

export type Distribution =
  FloatDistribution | IntDistribution | CategoricalDistribution;

/** Trial states (Optuna-compatible). */
export enum TrialState {
  Running = 'running',
  Complete = 'complete',
  Pruned = 'pruned',
  Fail = 'fail',
}

/** Trial result after completion. */
export interface TrialResult {
  number: number;
  value: number | null;
  state: TrialState;
  params: Record<string, number | string | boolean>;
  durationMs?: number;
}

/** Study optimization result. */
export interface StudyResult {
  bestTrial: number;
  bestParams: Record<string, number | string | boolean>;
  bestValue: number | null;
  history: TrialResult[];
}
