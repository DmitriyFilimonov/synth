/**
 * Native structural-атомы для synthetic-численного слоя T38.
 *
 * Форма хранит все нелинейные поля одного осциллятора. Слоты и квадратуры
 * живут отдельно, поэтому будущий beam сможет переносить форму без
 * десятипараметрового vector. Модуль не ищет кандидатов и не подключается
 * к production match/enhance/API.
 */
import { SAMPLE_RATE } from '../consts';
import {
  ampEnvConfigNormales,
  MAX_OSCILLATORS,
  oscConfigNormales,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import {
  clonePatch,
  renderGroup,
  unitGroup,
  type QuadratureFit,
} from './quadrature-refit';
import {
  addStructuralSampleWork,
  type StructuralWorkLedger,
} from './structural-work';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];

/** Все нелинейные поля одного native structural-атома. */
export interface StructuralAtomShape {
  freqBase: number;
  freqStart: number;
  /** Длительность частотной огибающей в секундах. */
  oscDuration: number;
  oscSlope: number;
  /** Длительность спада амплитуды в секундах после необязательной атаки. */
  ampDuration: number;
  ampEndLevel: number;
  ampSlope: number;
  /** Целый onset в отсчётах при проектной частоте дискретизации. */
  delaySamples: number;
  /** Целая длина sin²-атаки в отсчётах при той же частоте. */
  attackSamples: number;
  hardStop: boolean;
}

/**
 * Полная разметка слотов и совместное sine/cosine-решение.
 *
 * Кандидат заменяет существующие слоты и может дополнить короткий patch.
 * Каждую добавленную позицию нужно занять явно; итог не превышает 50 слотов.
 * Пары коэффициентов следуют в порядке `slots` и `shapes`.
 */
export interface StructuralCandidate {
  slots: readonly number[];
  shapes: readonly StructuralAtomShape[];
  coefficients: ArrayLike<number>;
}

const TWO_PI = 2 * Math.PI;
const FIT_BOUNDARY_TOLERANCE = 4 * Number.EPSILON;

/** Отклоняет нечисловое значение или выход за норму синтезатора. */
function assertNorm(
  name: string,
  value: number,
  range: { min: number; max: number },
): void {
  if (
    !Number.isFinite(value) ||
    value < range.min ||
    value > range.max
  ) {
    throw new Error(
      `${name} must be finite and within ${range.min}..${range.max}`,
    );
  }
}

/** Проверяет целое поле в отсчётах и его перевод в секунды. */
function assertSampleField(
  name: string,
  value: number,
  range: { min: number; max: number },
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  assertNorm(`${name}/SAMPLE_RATE`, value / SAMPLE_RATE, range);
}

/** Проверяет каждое нелинейное поле и ничего не обрезает. */
function assertStructuralAtomShape(shape: StructuralAtomShape): void {
  assertNorm('freqBase', shape.freqBase, oscConfigNormales.freqBase);
  assertNorm(
    'freqStart',
    shape.freqStart,
    oscConfigNormales.freqStart,
  );
  assertNorm(
    'oscDuration',
    shape.oscDuration,
    oscConfigNormales.duration,
  );
  assertNorm('oscSlope', shape.oscSlope, oscConfigNormales.slope);
  assertNorm(
    'ampDuration',
    shape.ampDuration,
    ampEnvConfigNormales.duration,
  );
  assertNorm(
    'ampEndLevel',
    shape.ampEndLevel,
    ampEnvConfigNormales.endLevel,
  );
  assertNorm('ampSlope', shape.ampSlope, ampEnvConfigNormales.slope);
  assertSampleField(
    'delaySamples',
    shape.delaySamples,
    oscConfigNormales.delay,
  );
  assertSampleField(
    'attackSamples',
    shape.attackSamples,
    ampEnvConfigNormales.attack,
  );
  if (typeof shape.hardStop !== 'boolean') {
    throw new Error('hardStop must be boolean');
  }
}

/** Переводит два линейных коэффициента в native-уровень и фазу. */
export function structuralFitFromCoefficients(
  coefficients: ArrayLike<number>,
): QuadratureFit | null {
  if (coefficients.length !== 2) {
    return null;
  }
  const sineCoefficient = coefficients[0] ?? 0;
  const cosineCoefficient = coefficients[1] ?? 0;
  const fittedLevel = Math.hypot(sineCoefficient, cosineCoefficient);
  const min = ampEnvConfigNormales.startLevel.min;
  const max = ampEnvConfigNormales.startLevel.max;
  if (
    !Number.isFinite(fittedLevel) ||
    fittedLevel < min - FIT_BOUNDARY_TOLERANCE ||
    fittedLevel > max + FIT_BOUNDARY_TOLERANCE
  ) {
    return null;
  }
  const phase =
    ((Math.atan2(cosineCoefficient, sineCoefficient) % TWO_PI) +
      TWO_PI) %
    TWO_PI;
  if (fittedLevel >= min && fittedLevel <= max) {
    return {
      sineCoefficient,
      cosineCoefficient,
      startLevel: fittedLevel,
      phase,
    };
  }
  // Исправляем только округление на границе. Содержательное нарушение
  // уже отклонено выше, а не скрыто clamp'ом.
  const startLevel = fittedLevel < min ? min : max;
  const scale = startLevel / fittedLevel;
  return {
    sineCoefficient: sineCoefficient * scale,
    cosineCoefficient: cosineCoefficient * scale,
    startLevel,
    phase,
  };
}

/**
 * Строит включённую native-группу осциллятора из формы и fit.
 *
 * @param shape - Независимые частоты, огибающие и поля поддержки
 * @param fit - Ограниченная совместная квадратура в виде уровня и фазы
 * @returns Новая группа для `ArgCreateSynth`
 * @throws Error если любое поле формы или fit выходит за нормы synth
 * @remarks Нулевые delay/attack и false hardStop не создают optional-поля.
 * Положительные отсчёты делятся на `SAMPLE_RATE`; значения не clamp'ятся.
 */
export function groupFromStructuralAtom(
  shape: StructuralAtomShape,
  fit: QuadratureFit,
): OscillatorGroup {
  assertStructuralAtomShape(shape);
  assertNorm(
    'startLevel',
    fit.startLevel,
    ampEnvConfigNormales.startLevel,
  );
  assertNorm('phase', fit.phase, oscConfigNormales.phase);
  if (
    !Number.isFinite(fit.sineCoefficient) ||
    !Number.isFinite(fit.cosineCoefficient)
  ) {
    throw new Error('Structural fit coefficients must be finite');
  }
  return {
    osc: {
      on: true,
      freqBase: shape.freqBase,
      freqStart: shape.freqStart,
      duration: shape.oscDuration,
      slope: shape.oscSlope,
      phase: fit.phase,
      ...(shape.delaySamples > 0
        ? { delay: shape.delaySamples / SAMPLE_RATE }
        : {}),
    },
    ampEnv: {
      startLevel: fit.startLevel,
      endLevel: shape.ampEndLevel,
      duration: shape.ampDuration,
      slope: shape.ampSlope,
      ...(shape.attackSamples > 0
        ? { attack: shape.attackSamples / SAMPLE_RATE }
        : {}),
      ...(shape.hardStop ? { hardStop: true } : {}),
    },
  };
}

/** Возвращает единичный уровень и нулевую фазу только для базиса. */
function unitFit(): QuadratureFit {
  return {
    sineCoefficient: 1,
    cosineCoefficient: 0,
    startLevel: 1,
    phase: 0,
  };
}

/**
 * Рендерит ровно две native unit-квадратуры для каждой формы.
 *
 * @param arg - Формы, точная длина вывода, модель фазы (по умолчанию legacy)
 *   и необязательный общий work ledger
 * @returns Плоский список `[sine0, cosine0, sine1, cosine1, ...]`
 * @throws Error при пустом или слишком большом списке форм, неверной длине
 *   либо нечисловом выходе renderer
 * @remarks Вызывает `unitGroup` и `renderGroup` прямо на native-группах.
 * `groupFromAtom`, vector converter и обёртка над delayed group не нужны.
 * Если передан `work`, каждая квадратура добавляет N в `basis`, а её полная
 * finite-проверка добавляет N в `validation`. Solver может продолжить тот же
 * ledger через собственный optional `work` без повторного basis-учёта.
 */
export function renderStructuralBasis(arg: {
  shapes: readonly StructuralAtomShape[];
  sampleCount: number;
  phaseModel?: PhaseModel;
  work?: StructuralWorkLedger;
}): Float64Array[] {
  const phaseModel = arg.phaseModel ?? 'legacy';
  if (
    arg.shapes.length === 0 ||
    arg.shapes.length > MAX_OSCILLATORS ||
    !Number.isSafeInteger(arg.sampleCount) ||
    arg.sampleCount < 1 ||
    (phaseModel !== 'legacy' && phaseModel !== 'integral')
  ) {
    throw new Error('Invalid structural basis request');
  }
  const basis: Float64Array[] = [];
  for (const shape of arg.shapes) {
    const template = groupFromStructuralAtom(shape, unitFit());
    for (const phase of [0, Math.PI / 2]) {
      const column = renderGroup(
        unitGroup(template, phase),
        arg.sampleCount,
        phaseModel,
      );
      if (arg.work !== undefined) {
        addStructuralSampleWork(arg.work, 'basis', arg.sampleCount);
      }
      if (!column.every(Number.isFinite)) {
        throw new Error('Non-finite structural basis column');
      }
      if (arg.work !== undefined) {
        addStructuralSampleWork(
          arg.work,
          'validation',
          arg.sampleCount,
        );
      }
      basis.push(column);
    }
  }
  return basis;
}

/**
 * Возвращает стабильный ключ полной формы независимо от порядка свойств.
 * Числовой -0 канонизируется в 0; остальные значения не округляются.
 */
export function structuralAtomShapeKey(
  shape: StructuralAtomShape,
): string {
  assertStructuralAtomShape(shape);
  const number = (value: number): number => (value === 0 ? 0 : value);
  return JSON.stringify([
    number(shape.freqBase),
    number(shape.freqStart),
    number(shape.oscDuration),
    number(shape.oscSlope),
    number(shape.ampDuration),
    number(shape.ampEndLevel),
    number(shape.ampSlope),
    shape.delaySamples,
    shape.attackSamples,
    shape.hardStop,
  ]);
}

/**
 * Применяет решённый structural-кандидат к явно выбранным уникальным слотам.
 *
 * @param source - Patch, чьи невыбранные группы нельзя менять
 * @param candidate - Формы, целевые слоты и ровно 2K коэффициентов
 * @returns Независимый patch; выбранные группы становятся включёнными атомами
 * @throws Error при несовместимых размерах, повторном или неверном слоте,
 *   пропуске в appended-диапазоне, невалидной форме/fit либо итоге выше 50
 * @remarks Бюджет слотов проверяется до создания групп. Невыбранные on/off
 * группы клонируются со всеми optional delay, attack, endLevel и hardStop.
 * Входной patch и массивы candidate не меняются.
 */
export function patchFromStructuralCandidate(
  source: ArgCreateSynth,
  candidate: StructuralCandidate,
): ArgCreateSynth {
  const atomCount = candidate.slots.length;
  if (
    source.oscillators.length > MAX_OSCILLATORS ||
    atomCount < 1 ||
    atomCount > MAX_OSCILLATORS ||
    candidate.shapes.length !== atomCount ||
    candidate.coefficients.length !== atomCount * 2
  ) {
    throw new Error('Invalid structural candidate dimensions');
  }
  const used = new Set<number>();
  let outputLength = source.oscillators.length;
  for (const slot of candidate.slots) {
    if (!Number.isSafeInteger(slot) || slot < 0 || used.has(slot)) {
      throw new Error(
        'Invalid or duplicate structural candidate slot',
      );
    }
    used.add(slot);
    outputLength = Math.max(outputLength, slot + 1);
  }
  if (outputLength > MAX_OSCILLATORS) {
    throw new Error(
      `Structural candidate exceeds ${MAX_OSCILLATORS} slots`,
    );
  }
  for (
    let slot = source.oscillators.length;
    slot < outputLength;
    slot += 1
  ) {
    if (!used.has(slot)) {
      throw new Error(
        'Appended structural slots must not contain gaps',
      );
    }
  }

  const patch = clonePatch(source);
  for (let atom = 0; atom < atomCount; atom += 1) {
    const slot = candidate.slots[atom];
    const shape = candidate.shapes[atom];
    if (slot === undefined || shape === undefined) {
      throw new Error('Incomplete structural candidate');
    }
    const fit = structuralFitFromCoefficients([
      candidate.coefficients[atom * 2] ?? 0,
      candidate.coefficients[atom * 2 + 1] ?? 0,
    ]);
    if (fit === null) {
      throw new Error(
        `Invalid quadrature for structural atom ${atom}`,
      );
    }
    patch.oscillators[slot] = groupFromStructuralAtom(shape, fit);
  }
  return patch;
}
