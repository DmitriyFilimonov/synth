import {
  MAX_OSCILLATORS,
  OSC_PARAMS_PER_OSCILLATOR,
  ArgCreateSynth,
  oscConfigNormales as oscNormales,
  ampEnvConfigNormales as ampEnvNormales,
} from './synth';
import { VECTOR_PARAM_OFFSETS as OFFSET } from './vector-param-offsets';

type VectorToSynthConfig = (vector: number[]) => ArgCreateSynth;

const clip = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const denormalize = (arg: {
  normalized: number;
  min: number;
  max: number;
}): number => {
  const clipped = clip(arg.normalized, 0, 1);
  return clipped * (arg.max - arg.min) + arg.min;
};

/**
 * Денормализует вектор оптимизатора в полную конфигурацию синтезатора.
 *
 * @param vector - Нормализованные параметры осцилляторов
 * @returns Конфигурация ровно с MAX_OSCILLATORS осцилляторами
 * @remarks Недостающие слоты читаются как нули, поэтому короткий вектор
 *   дополняется выключенными осцилляторами.
 */
export const mapVectorToSynthConfig: VectorToSynthConfig = (
  vector,
) => {
  const oscillators = [];

  for (let i = 0; i < MAX_OSCILLATORS; i++) {
    oscillators.push(mapVectorToSynthConfigForOsc(vector, i));
  }

  return { oscillators };
};

/**
 * Денормализует один слот вектора в настройки осциллятора и огибающей.
 *
 * @param vector - Общий нормализованный вектор оптимизатора
 * @param oscIndex - Нулевой индекс нужного осциллятора
 * @returns Параметры osc и ampEnv в единицах конфигурации синтезатора
 * @remarks Отсутствующие значения заменяются нулём, непрерывные
 *   параметры ограничиваются диапазоном [0, 1] перед денормализацией,
 *   а флаг on включается при значении от 0.5. Позиции берутся из
 *   VECTOR_PARAM_OFFSETS.
 */
export const mapVectorToSynthConfigForOsc = (
  vector: readonly number[],
  oscIndex: number,
): {
  osc: {
    on: boolean;
    freqBase: number;
    freqStart: number;
    slope: number;
    duration: number;
    phase: number;
  };
  ampEnv: {
    duration: number;
    endLevel: number;
    slope: number;
    startLevel: number;
  };
} => {
  const i = oscIndex;
  const offset = i * OSC_PARAMS_PER_OSCILLATOR;

  const on = vector[offset + OFFSET.flag] ?? 0;
  const freqBaseNorm = vector[offset + OFFSET.freqBase] ?? 0;
  const freqStartNorm = vector[offset + OFFSET.freqStart] ?? 0;
  const slopeNorm = vector[offset + OFFSET.slope] ?? 0;
  const freqEnvDurationNorm = vector[offset + OFFSET.duration] ?? 0;
  const phaseNorm = vector[offset + OFFSET.phase] ?? 0;
  const ampEnvDurationNorm =
    vector[offset + OFFSET.ampEnvDuration] ?? 0;
  const endLevelNorm = vector[offset + OFFSET.endLevel] ?? 0;
  const ampEnvSlopeNorm = vector[offset + OFFSET.ampEnvSlope] ?? 0;
  const ampEnvStartLevelNorm =
    vector[offset + OFFSET.startLevel] ?? 0;

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

  return {
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
  };
};
