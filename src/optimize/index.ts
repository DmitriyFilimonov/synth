export { coordinateDescent, optimize } from './coordinate-descent';
export {
  DEFAULT_COORD_DESCENT_CONFIG,
  type CoordinateDescentConfig,
} from './coordinate-descent';
export { evaluateSuppression, createWaveForm } from './evaluate';
export {
  stagedOptimize,
  extrapolateVectorBetweenStages,
} from './staged';
export {
  OSC_PARAMS,
  FINE_STEP_BASE,
  clamp01,
  clampVolume,
  isOscEnabled,
  countActiveOscillators,
  initGenome,
} from './consts';
export type {
  ProgressEntry,
  ProgressCallback,
  ArgOptimize,
} from './types';
export type {
  ArgStagedOptimize,
  StagedOptimizeResult,
  StageResult,
} from './staged';
export {
  runHPO,
  type ArgHPO,
  type HPOResult,
  type HPOProgressEntry,
} from './hpo';
export {
  Study,
  Trial,
  TPESampler,
  RandomSampler,
  type Sampler,
} from './hpo';
export type {
  FloatDistribution,
  IntDistribution,
  CategoricalDistribution,
  Distribution,
  TrialState,
  TrialResult,
  TPEConfig,
} from './hpo';
export {
  HYPERPARAM_SPACE,
  HYPERPARAM_DEFAULTS,
  resolveHyperparams,
  type HyperparamDef,
  type ResolvedHyperparams,
} from './hpo';
