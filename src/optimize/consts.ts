import { VOLUME_MIN } from '../consts';

export const OSC_PARAMS = 10;

export const FINE_STEP_BASE = 0.02;
export const STEP_GROWTH_FACTOR = 1.5;
export const STEP_SHRINK_FACTOR = 0.66;
export const EARLY_EXIT_THRESHOLD = 50;
export const STAGNATION_PERTURB_THRESHOLD = 30;
export const RANDOM_PERTURB_RATE = 0.2;
export const RANDOM_PERTURB_MAG = 0.2;

export const clamp01 = (v: number): number =>
  Math.max(0, Math.min(1, v));

export const clampVolume = (v: number): number =>
  Math.max(VOLUME_MIN, Math.min(1, v));

export const isOscEnabled = (
  vec: readonly number[],
  idx: number,
): boolean => {
  const v = vec[idx];
  return v !== undefined && v >= 0.5;
};

export const countActiveOscillators = (
  vec: readonly number[],
): number => {
  let count = 0;
  for (let i = 0; i < vec.length; i += OSC_PARAMS) {
    if (isOscEnabled(vec, i)) {
      count++;
    }
  }
  return count;
};

export const initGenome = (
  initialVector: readonly number[],
): number[] => {
  return initialVector.map((v, idx) => {
    if (idx % OSC_PARAMS === 0) {
      return 1;
    }
    if (idx % OSC_PARAMS === 9) {
      return clampVolume(v);
    }
    return clamp01(v);
  });
};
