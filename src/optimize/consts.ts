import { VOLUME_MIN } from '../consts';
import { VECTOR_PARAM_OFFSETS as OFFSET } from '../vector-param-offsets';

export const OSC_PARAMS = 10;

export const FINE_STEP_BASE = 0.02;

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

/**
 * Создаёт рабочий геном и ограничивает его значения допустимым
 * диапазоном.
 *
 * @param initialVector - Исходный нормализованный вектор осцилляторов
 * @param preserveOscillatorFlags - Сохранять ли исходные флаги
 *   on/off; по умолчанию false, и функция включает все осцилляторы,
 *   как в обычном match
 * @returns Новый геном; флаги равны 0 или 1, громкости ограничены
 *   через clampVolume, остальные значения лежат в [0, 1]
 * @remarks При preserveOscillatorFlags=true функция нормализует
 *   исходный флаг по порогу 0.5, а не включает выключенный слот.
 */
export const initGenome = (
  initialVector: readonly number[],
  preserveOscillatorFlags = false,
): number[] => {
  return initialVector.map((v, idx) => {
    if (idx % OSC_PARAMS === OFFSET.flag) {
      return preserveOscillatorFlags ? (v >= 0.5 ? 1 : 0) : 1;
    }
    if (idx % OSC_PARAMS === OFFSET.startLevel) {
      return clampVolume(v);
    }
    return clamp01(v);
  });
};
