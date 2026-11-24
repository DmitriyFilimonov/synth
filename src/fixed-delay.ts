import {
  OSC_PARAMS_PER_OSCILLATOR,
  oscConfigNormales,
} from './synth';

/**
 * Проверяет sidecar неизменных задержек для десятипараметрового вектора.
 *
 * @param fixedDelaySeconds - Задержки по исходным индексам слотов;
 *   undefined означает обычный синтез без sidecar
 * @param numOscillators - Число слотов вектора
 * @returns Тот же массив после успешной проверки либо undefined
 * @throws Error если длина не равна числу слотов, число слотов не целое,
 *   а также если задержка не конечна или лежит вне диапазона 0–0.5 с
 * @remarks Функция не меняет вход и не сохраняет его в модульном состоянии.
 *   Вызывающий код может скопировать массив, чтобы зафиксировать прогон.
 */
export function validateFixedDelaySeconds(
  fixedDelaySeconds: readonly number[] | undefined,
  numOscillators: number,
): readonly number[] | undefined {
  if (fixedDelaySeconds === undefined) {
    return undefined;
  }
  if (!Number.isInteger(numOscillators) || numOscillators < 0) {
    throw new Error(
      `fixedDelaySeconds requires a vector of complete ${OSC_PARAMS_PER_OSCILLATOR}-parameter oscillator slots`,
    );
  }
  if (fixedDelaySeconds.length !== numOscillators) {
    throw new Error(
      `fixedDelaySeconds length ${fixedDelaySeconds.length} must equal oscillator count ${numOscillators}`,
    );
  }
  for (let index = 0; index < fixedDelaySeconds.length; index += 1) {
    const delay = fixedDelaySeconds[index];
    if (
      !Number.isFinite(delay) ||
      (delay ?? 0) < oscConfigNormales.delay.min ||
      (delay ?? 0) > oscConfigNormales.delay.max
    ) {
      throw new Error(
        `fixedDelaySeconds[${index}] must be finite and within [${oscConfigNormales.delay.min}, ${oscConfigNormales.delay.max}] seconds`,
      );
    }
  }
  return fixedDelaySeconds;
}
