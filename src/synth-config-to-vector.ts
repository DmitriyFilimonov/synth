import { MIN } from './envelope';
import {
  ArgCreateSynth,
  OSC_PARAMS_PER_OSCILLATOR,
  oscConfigNormales as oscNormales,
  ampEnvConfigNormales as ampEnvNormales,
} from './synth';
import { VECTOR_PARAM_OFFSETS as OFFSET } from './vector-param-offsets';
import { validateFixedDelaySeconds } from './fixed-delay';

/**
 * Нормализует конфигурацию синтезатора в вектор оптимизатора.
 *
 * @param arg - Конфигурация с произвольным числом осцилляторов
 * @returns Вектор из OSC_PARAMS_PER_OSCILLATOR значений на каждый
 *   осциллятор в исходном порядке
 * @remarks Непрерывные параметры переводятся в долю своего диапазона,
 *   включённый флаг становится 1. Выключенный осциллятор даёт слот из
 *   нулей. Позиции значений задаёт VECTOR_PARAM_OFFSETS.
 * @throws Error если хотя бы один осциллятор имеет ненулевой delay,
 *   ненулевой ampEnv.attack или hardStop=true: десятипараметровый вектор
 *   не может сохранить эти поля. Проверка включает off-слоты, потому что
 *   будущее включение не должно молча потерять localized-форму
 */
export const mapSynthConfigToVector = (
  arg: ArgCreateSynth,
): number[] => {
  if (arg.oscillators.some((group) => (group.osc.delay ?? 0) !== 0)) {
    throw new Error(
      'Delayed oscillator patches cannot be mapped to the 10-parameter optimizer vector',
    );
  }
  if (
    arg.oscillators.some(
      (group) =>
        (group.ampEnv.attack ?? 0) !== 0 ||
        (group.ampEnv.hardStop ?? false),
    )
  ) {
    throw new Error(
      'Localized amplitude patches cannot be mapped to the 10-parameter optimizer vector',
    );
  }
  return arg.oscillators.flatMap<number>((osc) => {
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
};

/** Вектор оптимизатора и отдельный неизменный onset каждого слота. */
export interface SynthConfigVectorWithFixedDelays {
  vector: number[];
  fixedDelaySeconds: number[];
}

/**
 * Извлекает десятипараметровый вектор и fixed-delay sidecar из патча.
 *
 * @param arg - Конфигурация с необязательным osc.delay у любого слота
 * @returns Нормализованный вектор прежней длины 10×N и массив из N
 *   задержек в исходном порядке осцилляторов
 * @throws Error если хотя бы одна задержка не конечна или выходит за
 *   диапазон 0–0.5 с, либо любой слот содержит активные attack/hardStop
 * @remarks Старый mapSynthConfigToVector намеренно остаётся строгим и
 *   отклоняет ненулевой delay. Этот helper явно снимает delay только во
 *   временной копии, а оригинальные значения возвращает отдельно. Поэтому
 *   onset выключенного слота тоже сохраняется и восстановится при on/off.
 *   Он не добавляет sidecar для attack/hardStop и заранее отклоняет такой
 *   патч через строгий конвертер, включая потенциально включаемые off-слоты.
 */
export const mapSynthConfigToVectorWithFixedDelays = (
  arg: ArgCreateSynth,
): SynthConfigVectorWithFixedDelays => {
  const fixedDelaySeconds = arg.oscillators.map(
    (group) => group.osc.delay ?? 0,
  );
  validateFixedDelaySeconds(
    fixedDelaySeconds,
    arg.oscillators.length,
  );
  const withoutDelays: ArgCreateSynth = {
    oscillators: arg.oscillators.map((group) => ({
      osc: { ...group.osc, delay: 0 },
      ampEnv: { ...group.ampEnv },
    })),
  };
  return {
    vector: mapSynthConfigToVector(withoutDelays),
    fixedDelaySeconds,
  };
};
