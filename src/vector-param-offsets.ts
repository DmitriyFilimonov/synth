/** Раскладка десяти нормализованных значений одного осциллятора. */
export const VECTOR_PARAM_OFFSETS = {
  flag: 0,
  freqBase: 1,
  freqStart: 2,
  slope: 3,
  duration: 4,
  phase: 5,
  ampEnvDuration: 6,
  endLevel: 7,
  ampEnvSlope: 8,
  startLevel: 9,
} as const;

/** Имя непрерывного параметра в нормализованном векторе. */
export type ContinuousVectorParamName = Exclude<
  keyof typeof VECTOR_PARAM_OFFSETS,
  'flag'
>;
