/**
 * Генератор сигналов с известной структурой для проверки измерений.
 *
 * Зачем: любая мера (биение, скорость модуляции, глубина) сначала
 * обязана вернуть правильный ответ на сигнале, где этот ответ известен
 * по построению. Индекс модуляции 1–8 Гц такой проверки не прошёл и был
 * отозван (T20). Этот модуль даёт эталон: фаза — интеграл частоты,
 * амплитуда — экспоненциальная огибающая, всё считается напрямую, без
 * синтезатора, поэтому генератор независим от его модели фазы.
 *
 * Частота задаётся двумя способами:
 * - постоянная: `freqHz`;
 * - экспоненциальный подход к базе: `freqStartHz`, `freqTauSec` —
 *   f(t) = freqHz + (freqStartHz - freqHz)·exp(-t/τ).
 *
 * Амплитуда: `level·exp(-decayRate·(t/durationSec)^slope)` при
 * `slope = 1` это обычная экспонента, при других slope — та же форма,
 * что и у огибающей синтезатора.
 */

import { SAMPLE_RATE } from '../consts';
import { renderSamples } from './shared';
import { type ArgCreateSynth } from '../synth';

/** Один компонент эталонного сигнала. */
export interface GroundTruthComponent {
  /** Базовая частота, Гц. */
  freqHz: number;
  /** Стартовая частота свипа, Гц; по умолчанию равна `freqHz`. */
  freqStartHz?: number;
  /** Постоянная времени свипа, секунды; нужна только при свипе. */
  freqTauSec?: number;
  /** Стартовый уровень в долях полной шкалы. */
  level: number;
  /** Начальная фаза, радианы. */
  phaseRad?: number;
  /** Скорость спада: чем больше, тем быстрее затухает. */
  decayRate: number;
  /** Длительность огибающей в формуле спада, секунды. */
  durationSec: number;
  /** Крутизна огибающей: 1 — экспонента. */
  slope?: number;
}

/**
 * Мгновенная частота компонента в момент t, Гц.
 *
 * @param c - Компонент
 * @param t - Время, секунды
 * @returns Частота в Гц
 */
export function groundTruthFrequency(
  c: GroundTruthComponent,
  t: number,
): number {
  const start = c.freqStartHz ?? c.freqHz;
  if (start === c.freqHz || c.freqTauSec === undefined) {
    return c.freqHz;
  }
  return c.freqHz + (start - c.freqHz) * Math.exp(-t / c.freqTauSec);
}

/**
 * Амплитуда компонента в момент t (без осцилляции).
 *
 * @param c - Компонент
 * @param t - Время, секунды
 * @returns Множитель амплитуды
 */
export function groundTruthAmplitude(
  c: GroundTruthComponent,
  t: number,
): number {
  const slope = c.slope ?? 1;
  return (
    c.level *
    Math.exp(-c.decayRate * Math.pow(t / c.durationSec, slope))
  );
}

/**
 * Рендерит сумму компонентов в сэмплы int16.
 *
 * Фаза интегрируется трапециями на сетке 1/SAMPLE_RATE — тем же способом,
 * что и модель `integral` синтезатора, но независимым кодом. Для проверки
 * частоты это не важно: ошибка интегрирования на такой сетке составляет
 * доли градуса за полсекунды.
 *
 * @param components - Компоненты сигнала
 * @param seconds - Длительность рендера
 * @returns Сэмплы int16, сумма без клиппинга по построению уровней
 */
export function renderGroundTruth(
  components: readonly GroundTruthComponent[],
  seconds: number,
): Int16Array {
  const n = Math.floor(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  for (const c of components) {
    let phase = c.phaseRad ?? 0;
    let prevFreq = groundTruthFrequency(c, 0);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const freq = groundTruthFrequency(c, t);
      // Первый сэмпл звучит на стартовой фазе; накопление начинаем
      // со второго, иначе весь сигнал сместится на один сэмпл.
      if (i > 0) {
        phase += (Math.PI * (prevFreq + freq)) / SAMPLE_RATE;
      }
      prevFreq = freq;
      out[i] =
        (out[i] ?? 0) + groundTruthAmplitude(c, t) * Math.sin(phase);
    }
  }
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = Math.round((out[i] ?? 0) * 32767);
  }
  return samples;
}

/**
 * Мгновенная частота по периодам между восходящими переходами через
 * ноль, с линейной интерполяцией момента перехода. Возвращает пары
 * (время середины периода, частота). Метод грубый на коротких окнах и
 * при сильном свипе: это средняя частота за период, а не мгновенная.
 *
 * @param samples - Сигнал
 * @returns Массив точек (t секунды, частота Гц)
 */
export function zeroCrossingFrequency(
  samples: ArrayLike<number>,
): { t: number; freqHz: number }[] {
  const crossings: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = (samples[i - 1] ?? 0) / 32768;
    const b = (samples[i] ?? 0) / 32768;
    if (a < 0 && b >= 0) {
      crossings.push(i - 1 + -a / (b - a));
    }
  }
  const out: { t: number; freqHz: number }[] = [];
  for (let k = 0; k + 1 < crossings.length; k++) {
    const a = crossings[k] ?? 0;
    const b = crossings[k + 1] ?? a;
    if (b > a) {
      out.push({
        t: (a + b) / 2 / SAMPLE_RATE,
        freqHz: SAMPLE_RATE / (b - a),
      });
    }
  }
  return out;
}

/**
 * Эталонный компонент в конфиг синтезатора: нужен, чтобы сверять
 * генератор с `createSynth` на одинаковых параметрах. Свип по частоте
 * переносится в `freqStart`/`duration`/`slope` синтезатора только
 * приблизительно, поэтому для точной сверки берите постоянную частоту.
 *
 * @param c - Компонент
 * @returns Конфигурация с одним осциллятором
 */
export function groundTruthToPatch(
  c: GroundTruthComponent,
): ArgCreateSynth {
  return {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: c.freqHz,
          freqStart: c.freqHz,
          slope: c.slope ?? 1,
          duration: c.durationSec,
          phase: c.phaseRad ?? 0,
        },
        ampEnv: {
          duration: c.durationSec,
          endLevel: Math.exp(-c.decayRate),
          slope: c.slope ?? 1,
          startLevel: c.level,
        },
      },
    ],
  };
}
