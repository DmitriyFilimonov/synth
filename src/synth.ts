import { envelopeCreator, MIN } from './envelope';
import { oscillatorCreator } from './oscillator';
import { SAMPLE_RATE } from './consts';

interface ArgFrequncyEnvelopeCreator {
  /**Hz */
  modulation: number;
  base: number;
  /**s */
  duration: number;
  slope: number;
}

/** Create the frequency envelope used by synthesizer oscillators. */
export const frequencyEnvelopeCreator = ({
  modulation,
  base,
  duration,
  slope,
}: ArgFrequncyEnvelopeCreator): {
  frequencyEnvelop: (arg: { x: number }) => number;
} => {
  const frequencyEnvelopeNormalized = envelopeCreator({
    duration,
    max: 1,
    min: MIN,
    slope,
  });

  const frequencyEnvelop = ({
    x,
  }: {
    /**время (в секундах) */
    x: number;
  }): number => {
    const normalizedFrequencyModulation = frequencyEnvelopeNormalized(
      { x },
    );

    const frequency =
      base + modulation * normalizedFrequencyModulation;

    return frequency;
  };

  return { frequencyEnvelop };
};

interface ArgOscConfig {
  freqBase: number;
  freqStart: number;
  duration: number;
  slope: number;
  phase: number;
  on: boolean;
  /** Время начала в секундах; отсутствие и 0 сохраняют прежний PCM. */
  delay?: number;
}

type OscConfigNormales = Required<{
  [K in keyof ArgOscConfig]: {
    min: number;
    max: number;
  };
}>;

export const oscConfigNormales: OscConfigNormales = {
  duration: {
    min: 1 / 44100,
    max: 0.5,
  },
  freqBase: {
    min: 20,
    max: 20000,
  },
  freqStart: {
    min: 20,
    max: 20000,
  },
  on: {
    min: 0,
    max: 1,
  },
  delay: {
    min: 0,
    max: 0.5,
  },
  phase: {
    min: 0,
    max: 2 * Math.PI,
  },
  slope: {
    min: 0.2,
    max: 2,
  },
};

export interface ArgAmpEnvConfig {
  startLevel: number;
  endLevel?: number;
  duration: number;
  slope: number;
  /** Длительность sin²-нарастания в секундах до экспоненциального спада. */
  attack?: number;
  /** Обнуляет сигнал после attack + duration вместо сохранения хвоста. */
  hardStop?: boolean;
}

type AmpEnvConfigNormales = Required<{
  [K in keyof ArgAmpEnvConfig]: {
    min: number;
    max: number;
  };
}>;

export const ampEnvConfigNormales: AmpEnvConfigNormales = {
  duration: {
    min: 1 / 44100,
    max: 0.5,
  },
  slope: {
    min: 0.2,
    max: 2,
  },
  startLevel: {
    min: MIN,
    max: 1,
  },
  endLevel: {
    min: MIN,
    max: 1,
  },
  attack: {
    min: 0,
    max: 0.5,
  },
  hardStop: {
    min: 0,
    max: 1,
  },
};

interface OscillatorGroup {
  osc: ArgOscConfig;
  ampEnv: ArgAmpEnvConfig;
}

export interface ArgCreateSynth {
  oscillators: OscillatorGroup[];
}

export const MAX_OSCILLATORS = 50;
export const OSC_PARAMS_PER_OSCILLATOR = 10;

/**
 * Модель фазы осциллятора.
 *
 * `legacy` (по умолчанию, совместимость с пресетами и прошлыми
 * прогонами): фаза = 2π·x·f(x), поэтому звучащая частота равна
 * d(x·f)/dx, а не f(x).
 *
 * `integral`: фаза = 2π·∫f(τ)dτ, звучащая частота равна f(x).
 * Для постоянной частоты модели совпадают.
 */
export type PhaseModel = 'legacy' | 'integral';

/** Опции синтеза; без них действует модель `legacy`. */
export interface SynthOptions {
  phaseModel?: PhaseModel;
}

/**
 * Накопленная фаза в циклах для модели `integral`. Интеграл считается
 * трапециями на сетке 1/SAMPLE_RATE; таблица растёт по мере запросов,
 * значения между узлами интерполируются линейно.
 *
 * Память и время ограничены: таблица покрывает первые
 * `MAX_PHASE_TABLE_SECONDS`, дальше остаток интеграла добирается
 * Симпсоном с фиксированным числом интервалов, без роста таблицы.
 * Нефинитный `x` (NaN, Infinity) возвращает 0: зависание или
 * бесконечный цикл в аудиопути недопустимы.
 *
 * @param frequency - Мгновенная частота в Гц
 * @returns Функция x → число циклов от 0 до x
 */
const MAX_PHASE_TABLE_SECONDS = 10;
const PHASE_TAIL_INTERVALS = 2048;

export const createCyclePhase = (
  frequency: (arg: { x: number }) => number,
): ((x: number) => number) => {
  const cycles: number[] = [0];
  let lastFrequency = frequency({ x: 0 });
  const maxIndex = MAX_PHASE_TABLE_SECONDS * SAMPLE_RATE;

  const ensureTable = (index: number): void => {
    while (cycles.length <= index + 1) {
      const k = cycles.length;
      const current = frequency({ x: k / SAMPLE_RATE });
      cycles.push(
        (cycles[k - 1] ?? 0) +
          (lastFrequency + current) / 2 / SAMPLE_RATE,
      );
      lastFrequency = current;
    }
  };

  /** Остаток интеграла за пределами таблицы, с фиксированной ценой. */
  const tailIntegral = (from: number, to: number): number => {
    const n = PHASE_TAIL_INTERVALS;
    const h = (to - from) / n;
    let sum = frequency({ x: from }) + frequency({ x: to });
    for (let k = 1; k < n; k++) {
      sum += (k % 2 === 0 ? 2 : 4) * frequency({ x: from + k * h });
    }
    return (sum * h) / 3;
  };

  return (x: number): number => {
    if (!Number.isFinite(x)) {
      return 0;
    }
    const position = Math.max(0, x * SAMPLE_RATE);
    if (position >= maxIndex) {
      const baseIndex = maxIndex - 1;
      ensureTable(baseIndex);
      const from = baseIndex / SAMPLE_RATE;
      return (cycles[baseIndex] ?? 0) + tailIntegral(from, x);
    }
    const index = Math.floor(position);
    ensureTable(index);
    const c0 = cycles[index] ?? 0;
    const c1 = cycles[index + 1] ?? c0;
    return c0 + (position - index) * (c1 - c0);
  };
};

/**
 * Создаёт амплитудную огибающую с необязательной localized-формой.
 *
 * @param config - Уровни, спад, attack и hardStop одного осциллятора
 * @returns Функция локального времени в амплитуду
 * @throws Error если attack не конечен или вне 0–0.5 с, либо hardStop не
 *   boolean
 * @remarks При отсутствующих полях, attack=0 и hardStop=false возвращается
 *   исходная exponential-функция без дополнительного вызова или округления.
 *   Поэтому default PCM не зависит от выделения этого helper. Для localized
 *   формы support end сравнивается с допуском нескольких ulp только ради
 *   точного нуля на целой границе отсчётов.
 */
const createLocalizedAmplitudeEnvelope = (
  config: ArgAmpEnvConfig,
): ((arg: { x: number }) => number) => {
  const amplitudeEnvelope = envelopeCreator({
    duration: config.duration,
    max: config.startLevel,
    min: config.endLevel,
    slope: config.slope,
  });
  const attack = config.attack ?? 0;
  const hardStop = config.hardStop ?? false;
  if (
    !Number.isFinite(attack) ||
    attack < ampEnvConfigNormales.attack.min ||
    attack > ampEnvConfigNormales.attack.max
  ) {
    throw new Error(
      `Attack must be finite and within [${ampEnvConfigNormales.attack.min}, ${ampEnvConfigNormales.attack.max}] seconds`,
    );
  }
  if (typeof hardStop !== 'boolean') {
    throw new Error('HardStop must be boolean');
  }
  const supportEnd = attack + config.duration;
  const supportTolerance =
    4 * Number.EPSILON * Math.max(1, Math.abs(supportEnd));
  const localizedAmplitude = ({ x }: { x: number }): number => {
    if (!Number.isFinite(x) || x < 0) {
      return 0;
    }
    if (hardStop && x + supportTolerance >= supportEnd) {
      return 0;
    }
    if (attack > 0 && x < attack) {
      return (
        config.startLevel *
        Math.sin((Math.PI * x) / (2 * attack)) ** 2
      );
    }
    return amplitudeEnvelope({ x: x - attack });
  };
  return attack === 0 && !hardStop
    ? amplitudeEnvelope
    : localizedAmplitude;
};

/**
 * Создаёт функцию одного осциллятора с двумя огибающими.
 *
 * @param config - Параметры осциллятора и его огибающих
 * @param options - Модель фазы; по умолчанию используется `legacy`
 * @returns Функция, которая принимает время в секундах и возвращает
 *   нормированный отсчёт
 * @throws Error если `osc.delay` или `ampEnv.attack` не конечны или
 *   выходят за диапазон 0–0.5 секунды, либо `hardStop` не boolean
 * @remarks Отсутствующий или нулевой `osc.delay` сохраняет прежний
 *   рендер без сдвига. При положительной задержке функция выдаёт нули
 *   до onset, а затем вычисляет фазу и обе огибающие по локальному
 *   времени `x - delay`. Отсутствующие `attack` и `hardStop`, явный
 *   нулевой attack и `hardStop: false` сохраняют прежнюю амплитуду.
 *   Положительный attack добавляет sin²-нарастание, а спад начинается
 *   после него с прежнего startLevel. `hardStop: true` возвращает точный
 *   ноль с конца support; без него огибающая сохраняет прежний хвост на
 *   endLevel. Нефинитное `x` у отложенной группы даёт 0.
 */
export const createOscillatorGroup = (
  config: OscillatorGroup,
  options: SynthOptions = {},
): ((arg: { x: number }) => number) => {
  const osc = oscillatorCreator({
    on: config.osc.on,
    initialPhase: config.osc.phase,
  });

  const { frequencyEnvelop } = frequencyEnvelopeCreator({
    base: config.osc.freqBase,
    duration: config.osc.duration,
    modulation: config.osc.freqStart - config.osc.freqBase,
    slope: config.osc.slope,
  });

  const amplitudeAt = createLocalizedAmplitudeEnvelope(config.ampEnv);

  const cyclesAt =
    options.phaseModel === 'integral'
      ? createCyclePhase(frequencyEnvelop)
      : null;
  const renderLocal =
    options.phaseModel === 'integral'
      ? ({ x }: { x: number }): number => {
          if (!config.osc.on) {
            return 0;
          }
          return (
            Math.sin(
              2 * Math.PI * (cyclesAt?.(x) ?? 0) + config.osc.phase,
            ) * amplitudeAt({ x })
          );
        }
      : ({ x }: { x: number }): number => {
          return osc({
            amplitude: amplitudeAt({ x }),
            frequency: frequencyEnvelop({ x }),
            x,
          });
        };
  const delay = config.osc.delay ?? 0;
  if (
    !Number.isFinite(delay) ||
    delay < oscConfigNormales.delay.min ||
    delay > oscConfigNormales.delay.max
  ) {
    throw new Error(
      `Delay must be finite and within [${oscConfigNormales.delay.min}, ${oscConfigNormales.delay.max}] seconds`,
    );
  }
  if (delay === 0) {
    return renderLocal;
  }
  return ({ x }: { x: number }): number => {
    if (!Number.isFinite(x)) {
      return 0;
    }
    return x < delay ? 0 : renderLocal({ x: x - delay });
  };
};

export const createSynth = (
  synthConfig: ArgCreateSynth,
  options: SynthOptions = {},
): ((arg: { x: number }) => number) => {
  if (synthConfig.oscillators.length > MAX_OSCILLATORS) {
    throw new Error(
      `Maximum ${MAX_OSCILLATORS} oscillators allowed, got ${synthConfig.oscillators.length}`,
    );
  }

  const oscillatorGroups = synthConfig.oscillators
    .filter((config) => config.osc.on)
    .map((config) => createOscillatorGroup(config, options));

  return ({ x }: { x: number }): number => {
    let sum = 0;
    for (const oscGroup of oscillatorGroups) {
      sum += oscGroup({ x });
    }
    return Math.max(-1, Math.min(1, sum));
  };
};
