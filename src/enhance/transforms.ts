/**
 * Чистые трансформации патча для сервиса улучшения бочек.
 *
 * Каждая трансформация чинит один слышимый дефект патча (см.
 * docs/plan-kick-enhancement.md, раздел «Два режима улучшения»):
 * продлевает обрезанный хвост, усиливает слабый компонент,
 * добавляет щелчок атаки и т.п. Трансформация не запускает синтез
 * и ничего не знает про coordinate descent: она правит параметры
 * напрямую и записывает в журнал, что именно сделала.
 *
 * Контракт каждой функции: входной патч не мутируется; если правка
 * применима, возвращается новый патч и запись в журнале; если нет —
 * возвращается исходный объект без изменений, `audit` равен `null`,
 * а `skipReason` объясняет отказ. Все значения обрезаются по
 * допустимым диапазонам параметров из `synth.ts`.
 */

import { MIN } from '../envelope';
import {
  ampEnvConfigNormales,
  oscConfigNormales,
  type ArgCreateSynth,
} from '../synth';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];

interface Range {
  min: number;
  max: number;
}

/** Запись в журнале улучшения: какая трансформация что сделала. */
export interface TransformAudit {
  /** Машинное имя трансформации. */
  name: string;
  /** Индекс осциллятора, которого коснулась правка. */
  oscillatorIndex?: number;
  /** Человекочитаемое описание правки. */
  detail: string;
}

/** Результат трансформации патча. */
export interface TransformResult {
  /**
   * Патч после правки. Если трансформация неприменима, содержит
   * исходный объект без изменений.
   */
  patch: ArgCreateSynth;
  /**
   * Запись о правке; `null` означает, что трансформация
   * неприменима и патч не тронут.
   */
  audit: TransformAudit | null;
  /** Причина отказа; заполнена, когда `audit` равен `null`. */
  skipReason?: string;
}

/** Параметры щелчка атаки для {@link addTransientClick}. */
export interface TransientClickParams {
  /** Частота щелчка, Гц. */
  freqHz: number;
  /** Стартовый уровень огибающей громкости щелчка. */
  level: number;
}

/** Длительность огибающей громкости щелчка атаки, секунды. */
const TRANSIENT_DURATION_SECONDS = 0.04;

/** Кривизна огибающей щелчка: быстрое затухание. */
const TRANSIENT_AMP_SLOPE = 2;

/** Ограничивает значение допустимым диапазоном параметра. */
const clampToRange = (value: number, range: Range): number =>
  Math.min(range.max, Math.max(range.min, value));

/** Форматирует секунды для журнала. */
const formatSeconds = (value: number): string =>
  `${value.toFixed(3)} с`;

/** Форматирует герцы для журнала. */
const formatHz = (value: number): string => `${value.toFixed(2)} Гц`;

/** Форматирует уровень огибающей для журнала. */
const formatLevel = (value: number): string => value.toFixed(4);

/** Форматирует число без длинного дробного хвоста. */
const formatCompact = (value: number): string =>
  `${Math.round(value * 10000) / 10000}`;

/** Собирает отказ: патч не тронут, причина объяснена. */
const notApplied = (
  patch: ArgCreateSynth,
  name: string,
  reason: string,
): TransformResult => ({
  patch,
  audit: null,
  skipReason: `${name}: ${reason}`,
});

/** Собирает правку: новый патч и запись в журнале. */
const applied = (
  patch: ArgCreateSynth,
  audit: TransformAudit,
): TransformResult => ({ patch, audit });

/**
 * Находит включённый осциллятор по индексу. Возвращает либо сам
 * осциллятор, либо причину, по которой править его нельзя.
 */
const findActiveOscillator = (
  patch: ArgCreateSynth,
  oscillatorIndex: number,
): { group: OscillatorGroup } | { reason: string } => {
  if (!Number.isInteger(oscillatorIndex)) {
    return { reason: `индекс ${oscillatorIndex} не целый` };
  }
  const group = patch.oscillators[oscillatorIndex];
  if (group === undefined) {
    return { reason: `в патче нет осциллятора ${oscillatorIndex}` };
  }
  if (!group.osc.on) {
    return { reason: `осциллятор ${oscillatorIndex} уже выключен` };
  }
  return { group };
};

/** Подменяет один осциллятор, не трогая входной патч. */
const replaceOscillator = (
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  group: OscillatorGroup,
): ArgCreateSynth => ({
  oscillators: patch.oscillators.map((current, index) =>
    index === oscillatorIndex ? group : current,
  ),
});

/** Описывает обрезку значения, если запрошенное вышло за диапазон. */
const clampNote = (
  raw: number,
  clamped: number,
  range: Range,
): string =>
  clamped === raw
    ? ''
    : ` (запрошенное ${formatCompact(raw)} вне диапазона ` +
      `${formatCompact(range.min)}–${formatCompact(range.max)}, ` +
      `обрезал)`;

/**
 * Продлевает огибающую громкости осциллятора в `factor` раз.
 * Чинит обрезанный хвост: звук длится дольше, а частота и уровень
 * не меняются.
 *
 * Неприменима, если осциллятор выключен, если множитель не больше
 * единицы или не конечен и если огибающая уже упёрлась в допустимый
 * максимум длительности.
 */
export const extendTail = (
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  factor: number,
): TransformResult => {
  const found = findActiveOscillator(patch, oscillatorIndex);
  if ('reason' in found) {
    return notApplied(patch, 'extendTail', found.reason);
  }
  if (!Number.isFinite(factor) || factor <= 1) {
    return notApplied(
      patch,
      'extendTail',
      `множитель ${formatCompact(factor)} не продлевает огибающую`,
    );
  }

  const current = found.group.ampEnv.duration;
  const range = ampEnvConfigNormales.duration;
  const next = clampToRange(current * factor, range);
  if (next === current) {
    return notApplied(
      patch,
      'extendTail',
      `огибающая уже длится ${formatSeconds(current)}, ` +
        `дальше диапазон не пускает`,
    );
  }

  const group: OscillatorGroup = {
    osc: { ...found.group.osc },
    ampEnv: { ...found.group.ampEnv, duration: next },
  };
  const clampText =
    next === current * factor
      ? ''
      : `, обрезал по допустимому максимуму ${formatSeconds(range.max)}`;

  return applied(replaceOscillator(patch, oscillatorIndex, group), {
    name: 'extendTail',
    oscillatorIndex,
    detail:
      `продлил огибающую громкости с ${formatSeconds(current)} ` +
      `до ${formatSeconds(next)} в ${factor.toFixed(2)} раза` +
      clampText,
  });
};

/**
 * Усиливает осциллятор: умножает стартовый уровень его огибающей
 * громкости на `factor`. Вытаскивает слабый компонент из-под
 * остальных.
 *
 * Неприменима, если осциллятор выключен, если множитель не больше
 * единицы или не конечен и если уровень уже стоит на допустимом
 * максимуме.
 */
export const boostOscillator = (
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  factor: number,
): TransformResult => {
  const found = findActiveOscillator(patch, oscillatorIndex);
  if ('reason' in found) {
    return notApplied(patch, 'boostOscillator', found.reason);
  }
  if (!Number.isFinite(factor) || factor <= 1) {
    return notApplied(
      patch,
      'boostOscillator',
      `множитель ${formatCompact(factor)} не усиливает осциллятор`,
    );
  }

  const current = found.group.ampEnv.startLevel;
  const range = ampEnvConfigNormales.startLevel;
  const next = clampToRange(current * factor, range);
  if (next === current) {
    return notApplied(
      patch,
      'boostOscillator',
      `уровень уже ${formatLevel(current)}, усиливать некуда`,
    );
  }

  const group: OscillatorGroup = {
    osc: { ...found.group.osc },
    ampEnv: { ...found.group.ampEnv, startLevel: next },
  };

  return applied(replaceOscillator(patch, oscillatorIndex, group), {
    name: 'boostOscillator',
    oscillatorIndex,
    detail:
      `усилил осциллятор: стартовый уровень с ` +
      `${formatLevel(current)} до ${formatLevel(next)} ` +
      `в ${factor.toFixed(2)} раза` +
      clampNote(current * factor, next, range),
  });
};

/**
 * Ставит относительный конечный уровень огибающей громкости: сигнал
 * затухает до `startLevel × endLevel` (см. `envelope.ts`). Убирает
 * артефактные значения, которые оставила инициализация.
 *
 * Неприменима, если осциллятор выключен, если значение не конечно
 * и если такой уровень уже стоит.
 */
export const setEndLevel = (
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  value: number,
): TransformResult => {
  const found = findActiveOscillator(patch, oscillatorIndex);
  if ('reason' in found) {
    return notApplied(patch, 'setEndLevel', found.reason);
  }
  if (!Number.isFinite(value)) {
    return notApplied(
      patch,
      'setEndLevel',
      `уровень ${formatCompact(value)} не конечен`,
    );
  }

  const range = ampEnvConfigNormales.endLevel;
  const next = clampToRange(value, range);
  const current = found.group.ampEnv.endLevel;
  if (current !== undefined && current === next) {
    return notApplied(
      patch,
      'setEndLevel',
      `конечный уровень уже ${formatLevel(next)}`,
    );
  }

  const group: OscillatorGroup = {
    osc: { ...found.group.osc },
    ampEnv: { ...found.group.ampEnv, endLevel: next },
  };
  const was =
    current === undefined ? 'не задан' : formatLevel(current);

  return applied(replaceOscillator(patch, oscillatorIndex, group), {
    name: 'setEndLevel',
    oscillatorIndex,
    detail:
      `поставил относительный конечный уровень ` +
      `${formatLevel(next)} (было: ${was})` +
      clampNote(value, next, range),
  });
};

/**
 * Добавляет щелчок атаки в первый свободный слот патча
 * (`on: false`): осциллятор с огибающей громкости на 40 мс,
 * кривизной 2.0 и нулевой фазой. Частота щелчка не движется:
 * `freqStart` равен `freqBase`.
 *
 * Неприменима, если свободного слота нет или параметры не конечны.
 */
export const addTransientClick = (
  patch: ArgCreateSynth,
  { freqHz, level }: TransientClickParams,
): TransformResult => {
  if (!Number.isFinite(freqHz) || !Number.isFinite(level)) {
    return notApplied(
      patch,
      'addTransientClick',
      'частота и уровень должны быть конечными числами',
    );
  }
  const slotIndex = patch.oscillators.findIndex(
    (group) => !group.osc.on,
  );
  if (slotIndex === -1) {
    return notApplied(
      patch,
      'addTransientClick',
      'в патче нет свободного слота: все осцилляторы включены',
    );
  }

  const freqRange = oscConfigNormales.freqBase;
  const levelRange = ampEnvConfigNormales.startLevel;
  const freq = clampToRange(freqHz, freqRange);
  const startLevel = clampToRange(level, levelRange);

  const group: OscillatorGroup = {
    osc: {
      on: true,
      freqBase: freq,
      freqStart: freq,
      duration: TRANSIENT_DURATION_SECONDS,
      slope: 1,
      phase: 0,
    },
    ampEnv: {
      startLevel,
      endLevel: MIN,
      duration: TRANSIENT_DURATION_SECONDS,
      slope: TRANSIENT_AMP_SLOPE,
    },
  };

  return applied(replaceOscillator(patch, slotIndex, group), {
    name: 'addTransientClick',
    oscillatorIndex: slotIndex,
    detail:
      `добавил щелчок атаки в свободный слот ${slotIndex}: ` +
      `${formatHz(freq)}, уровень ${formatLevel(startLevel)}, ` +
      `огибающая ${formatSeconds(TRANSIENT_DURATION_SECONDS)}` +
      clampNote(freqHz, freq, freqRange) +
      clampNote(level, startLevel, levelRange),
  });
};

/**
 * Выключает осциллятор (`on: false`), сохраняя все его параметры:
 * правку можно проследить и откатить. Убирает компоненты, которые
 * моделируют чужой микс-остаток.
 *
 * Неприменима, если осциллятора нет или он уже выключен.
 */
export const removeOscillator = (
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  reason: string,
): TransformResult => {
  const found = findActiveOscillator(patch, oscillatorIndex);
  if ('reason' in found) {
    return notApplied(patch, 'removeOscillator', found.reason);
  }

  const group: OscillatorGroup = {
    osc: { ...found.group.osc, on: false },
    ampEnv: { ...found.group.ampEnv },
  };
  const why =
    reason.trim() === '' ? 'причина не указана' : reason.trim();

  return applied(replaceOscillator(patch, oscillatorIndex, group), {
    name: 'removeOscillator',
    oscillatorIndex,
    detail: `выключил осциллятор, параметры сохранил: ${why}`,
  });
};

/**
 * Перестраивает основную частоту осциллятора на `newFreqBase`.
 * При `keepRatio` (по умолчанию) двигает и стартовую частоту,
 * сохраняя её отношение к основной. Если исходная основная частота
 * не положительна, отношение сохранить нельзя, и стартовая частота
 * остаётся как была.
 *
 * Неприменима, если осциллятор выключен, если частота не конечна
 * и если после обрезки по диапазону менять нечего.
 */
export const retuneOscillator = (
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  newFreqBase: number,
  keepRatio = true,
): TransformResult => {
  const found = findActiveOscillator(patch, oscillatorIndex);
  if ('reason' in found) {
    return notApplied(patch, 'retuneOscillator', found.reason);
  }
  if (!Number.isFinite(newFreqBase)) {
    return notApplied(
      patch,
      'retuneOscillator',
      `частота ${formatCompact(newFreqBase)} не конечна`,
    );
  }

  const currentBase = found.group.osc.freqBase;
  const currentStart = found.group.osc.freqStart;
  const baseRange = oscConfigNormales.freqBase;
  const startRange = oscConfigNormales.freqStart;
  const nextBase = clampToRange(newFreqBase, baseRange);

  let nextStart = currentStart;
  let ratioText = '';
  if (keepRatio && currentBase > 0) {
    const ratio = currentStart / currentBase;
    nextStart = clampToRange(nextBase * ratio, startRange);
    ratioText =
      `, стартовую — с ${formatHz(currentStart)} до ` +
      `${formatHz(nextStart)}, отношение ${ratio.toFixed(3)} сохранил`;
  } else {
    ratioText = ', стартовую частоту не тронул';
  }

  if (nextBase === currentBase && nextStart === currentStart) {
    return notApplied(
      patch,
      'retuneOscillator',
      `основная частота уже ${formatHz(currentBase)}`,
    );
  }

  const group: OscillatorGroup = {
    osc: {
      ...found.group.osc,
      freqBase: nextBase,
      freqStart: nextStart,
    },
    ampEnv: { ...found.group.ampEnv },
  };

  return applied(replaceOscillator(patch, oscillatorIndex, group), {
    name: 'retuneOscillator',
    oscillatorIndex,
    detail:
      `перестроил основную частоту с ${formatHz(currentBase)} ` +
      `до ${formatHz(nextBase)}${ratioText}` +
      clampNote(newFreqBase, nextBase, baseRange),
  });
};

/**
 * Ставит длительность амплитудной огибающей в секундах, в любую
 * сторону (в отличие от одностороннего `extendTail`). Нужен режиму
 * B: коррекция умеет и укорачивать раздутые хвосты.
 *
 * Неприменима, если осциллятор выключен, если значение не конечно
 * или не положительно. Значение обрезается в допустимый диапазон;
 * обрезка записывается в журнал.
 */
export const setAmpEnvDuration = (
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  seconds: number,
): TransformResult => {
  const found = findActiveOscillator(patch, oscillatorIndex);
  if ('reason' in found) {
    return notApplied(patch, 'setAmpEnvDuration', found.reason);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return notApplied(
      patch,
      'setAmpEnvDuration',
      `длительность ${formatCompact(seconds)} не положительна`,
    );
  }

  const current = found.group.ampEnv.duration;
  const range = ampEnvConfigNormales.duration;
  const next = clampToRange(seconds, range);
  if (next === current) {
    return notApplied(
      patch,
      'setAmpEnvDuration',
      `огибающая уже длится ${formatSeconds(current)}`,
    );
  }

  const group: OscillatorGroup = {
    osc: { ...found.group.osc },
    ampEnv: { ...found.group.ampEnv, duration: next },
  };

  return applied(replaceOscillator(patch, oscillatorIndex, group), {
    name: 'setAmpEnvDuration',
    oscillatorIndex,
    detail:
      `поставил длительность огибающей ` +
      `${formatSeconds(next)} (было ${formatSeconds(current)})` +
      clampNote(seconds, next, range),
  });
};
