import {
  MAX_OSCILLATORS,
  OSC_PARAMS_PER_OSCILLATOR,
  ArgCreateSynth,
  oscConfigNormales as oscNormales,
  ampEnvConfigNormales as ampEnvNormales,
} from './synth';

type VectorToSynthConfig = (vector: number[]) => ArgCreateSynth;

const clip = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const denormalize = (arg: {
  normalized: number;
  min: number;
  max: number;
}) => {
  const clipped = clip(arg.normalized, 0, 1);
  return clipped * (arg.max - arg.min) + arg.min;
};

export const mapVectorToSynthConfig: VectorToSynthConfig = (
  vector,
) => {
  const oscillators = [];

  for (let i = 0; i < MAX_OSCILLATORS; i++) {
    const offset = i * OSC_PARAMS_PER_OSCILLATOR;

    const on = vector[offset] ?? 0;
    const freqBaseNorm = vector[offset + 1] ?? 0;
    const freqStartNorm = vector[offset + 2] ?? 0;
    const slopeNorm = vector[offset + 3] ?? 0;
    const freqEnvDurationNorm = vector[offset + 4] ?? 0;
    const phaseNorm = vector[offset + 5] ?? 0;
    const ampEnvDurationNorm = vector[offset + 6] ?? 0;
    const endLevelNorm = vector[offset + 7] ?? 0;
    const ampEnvSlopeNorm = vector[offset + 8] ?? 0;
    const ampEnvStartLevelNorm = vector[offset + 9] ?? 0;

    const onBool = on >= 0.5;

    const freqBase = denormalize({
      normalized: freqBaseNorm,
      min: oscNormales.freqBase.min,
      max: oscNormales.freqBase.max,
    });

    const freqStart = denormalize({
      normalized: freqStartNorm,
      min: oscNormales.freqStart.min,
      max: oscNormales.freqStart.max,
    });

    const slope = denormalize({
      normalized: slopeNorm,
      min: oscNormales.slope.min,
      max: oscNormales.slope.max,
    });

    const duration = denormalize({
      normalized: freqEnvDurationNorm,
      min: oscNormales.duration.min,
      max: oscNormales.duration.max,
    });

    const phase = denormalize({
      normalized: phaseNorm,
      min: oscNormales.phase.min,
      max: oscNormales.phase.max,
    });

    const ampEnvDuration = denormalize({
      normalized: ampEnvDurationNorm,
      min: ampEnvNormales.duration.min,
      max: ampEnvNormales.duration.max,
    });

    const endLevel = denormalize({
      normalized: endLevelNorm,
      min: ampEnvNormales.endLevel.min,
      max: ampEnvNormales.endLevel.max,
    });

    const ampEnvSlope = denormalize({
      normalized: ampEnvSlopeNorm,
      min: ampEnvNormales.slope.min,
      max: ampEnvNormales.slope.max,
    });

    const ampEnvStartLevel = denormalize({
      normalized: ampEnvStartLevelNorm,
      min: ampEnvNormales.startLevel.min,
      max: ampEnvNormales.startLevel.max,
    });

    oscillators.push({
      osc: {
        on: onBool,
        freqBase,
        freqStart,
        slope,
        duration,
        phase,
      },
      ampEnv: {
        duration: ampEnvDuration,
        endLevel,
        slope: ampEnvSlope,
        startLevel: ampEnvStartLevel,
      },
    });
  }

  return { oscillators };
};
