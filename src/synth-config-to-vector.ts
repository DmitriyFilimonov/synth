import { MIN } from './envelope';
import {
  ArgCreateSynth,
  OSC_PARAMS_PER_OSCILLATOR,
  oscConfigNormales as oscNormales,
  ampEnvConfigNormales as ampEnvNormales,
} from './synth';
import { VECTOR_PARAM_OFFSETS as OFFSET } from './vector-param-offsets';

/**
 * Нормализует конфигурацию синтезатора в вектор оптимизатора.
 *
 * @param arg - Конфигурация с произвольным числом осцилляторов
 * @returns Вектор из OSC_PARAMS_PER_OSCILLATOR значений на каждый
 *   осциллятор в исходном порядке
 * @remarks Непрерывные параметры переводятся в долю своего диапазона,
 *   включённый флаг становится 1. Выключенный осциллятор даёт слот из
 *   нулей. Позиции значений задаёт VECTOR_PARAM_OFFSETS.
 */
export const mapSynthConfigToVector = (
  arg: ArgCreateSynth,
): number[] =>
  arg.oscillators.flatMap<number>((osc) => {
    if (osc.osc.on) {
      const on = Number(osc.osc.on);

      const freqBase =
        (osc.osc.freqBase - oscNormales.freqBase.min) /
        (oscNormales.freqBase.max - oscNormales.freqBase.min);

      const freqStart =
        (osc.osc.freqStart - oscNormales.freqStart.min) /
        (oscNormales.freqStart.max - oscNormales.freqStart.min);

      const slope =
        (osc.osc.slope - oscNormales.slope.min) /
        (oscNormales.slope.max - oscNormales.slope.min);

      const freqEnvDuration =
        (osc.osc.duration - oscNormales.duration.min) /
        (oscNormales.duration.max - oscNormales.duration.min);

      const phase =
        (osc.osc.phase - oscNormales.phase.min) /
        (oscNormales.phase.max - oscNormales.phase.min);

      const ampEnvDuration =
        (osc.ampEnv.duration - ampEnvNormales.duration.min) /
        (ampEnvNormales.duration.max - ampEnvNormales.duration.min);

      const endLevel =
        ((osc.ampEnv.endLevel ?? MIN) - ampEnvNormales.endLevel.min) /
        (ampEnvNormales.endLevel.max - ampEnvNormales.endLevel.min);

      const ampEnvSlope =
        (osc.ampEnv.slope - ampEnvNormales.slope.min) /
        (ampEnvNormales.slope.max - ampEnvNormales.slope.min);

      const ampEnvStartLevel =
        (osc.ampEnv.startLevel - ampEnvNormales.startLevel.min) /
        (ampEnvNormales.startLevel.max -
          ampEnvNormales.startLevel.min);

      const values: number[] = [];
      values[OFFSET.flag] = on;
      values[OFFSET.freqBase] = freqBase;
      values[OFFSET.freqStart] = freqStart;
      values[OFFSET.slope] = slope;
      values[OFFSET.duration] = freqEnvDuration;
      values[OFFSET.phase] = phase;
      values[OFFSET.ampEnvDuration] = ampEnvDuration;
      values[OFFSET.endLevel] = endLevel;
      values[OFFSET.ampEnvSlope] = ampEnvSlope;
      values[OFFSET.startLevel] = ampEnvStartLevel;
      return values;
    }

    return new Array<number>(OSC_PARAMS_PER_OSCILLATOR).fill(0);
  });
