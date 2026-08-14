export { coordinateDescent, optimize } from './coordinate-descent';
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
