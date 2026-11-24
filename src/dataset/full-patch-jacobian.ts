/**
 * Аналитический Jacobian полного patch для offline variable projection.
 * Квадратуры остаются линейными внутренними коэффициентами, а семь
 * нелинейных форм получают производные в натуральных логарифмах.
 * Модуль не запускает coordinate descent и не подключён к production.
 */
import { SAMPLE_RATE } from '../consts';
import { MIN } from '../envelope';
import {
  ampEnvConfigNormales,
  createCyclePhase,
  MAX_OSCILLATORS,
  oscConfigNormales,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';

/** Порядок столбцов семи наружных форм каждого активного осциллятора. */
export const FULL_PATCH_OUTER_FIELDS = [
  'freqBase',
  'freqStart',
  'osc.slope',
  'osc.duration',
  'ampEnv.duration',
  'ampEnv.endLevel',
  'ampEnv.slope',
] as const;

/** Имя одной наружной формы в Jacobian. */
export type FullPatchOuterField =
  (typeof FULL_PATCH_OUTER_FIELDS)[number];

/** Границы одной логарифмической координаты будущего solver. */
export interface FullPatchOuterBound {
  field: FullPatchOuterField;
  nativeMinimum: number;
  nativeMaximum: number;
  logMinimum: number;
  logMaximum: number;
}

/** Создаёт запись границ в исходной и логарифмической шкалах. */
function outerBound(
  field: FullPatchOuterField,
  nativeMinimum: number,
  nativeMaximum: number,
): FullPatchOuterBound {
  return {
    field,
    nativeMinimum,
    nativeMaximum,
    logMinimum: Math.log(nativeMinimum),
    logMaximum: Math.log(nativeMaximum),
  };
}

/**
 * Явные границы логарифмических координат из норм синтезатора.
 * Экспонента координаты равна исходному полю; единица логарифма —
 * натуральный log, а не log10.
 */
export const FULL_PATCH_OUTER_BOUNDS: readonly FullPatchOuterBound[] =
  [
    outerBound(
      'freqBase',
      oscConfigNormales.freqBase.min,
      oscConfigNormales.freqBase.max,
    ),
    outerBound(
      'freqStart',
      oscConfigNormales.freqStart.min,
      oscConfigNormales.freqStart.max,
    ),
    outerBound(
      'osc.slope',
      oscConfigNormales.slope.min,
      oscConfigNormales.slope.max,
    ),
    outerBound(
      'osc.duration',
      oscConfigNormales.duration.min,
      oscConfigNormales.duration.max,
    ),
    outerBound(
      'ampEnv.duration',
      ampEnvConfigNormales.duration.min,
      ampEnvConfigNormales.duration.max,
    ),
    outerBound(
      'ampEnv.endLevel',
      ampEnvConfigNormales.endLevel.min,
      ampEnvConfigNormales.endLevel.max,
    ),
    outerBound(
      'ampEnv.slope',
      ampEnvConfigNormales.slope.min,
      ampEnvConfigNormales.slope.max,
    ),
  ];

/** Линейные коэффициенты sine/cosine-базиса одного исходного слота. */
export interface FullPatchQuadratureCoefficients {
  oscillatorIndex: number;
  sineCoefficient: number;
  cosineCoefficient: number;
}

/** Вклад и семь log-Jacobian-столбцов одного активного осциллятора. */
export interface FullPatchOscillatorJacobian {
  oscillatorIndex: number;
  contribution: Float64Array;
  jacobian: Float64Array[];
  supportSampleCount: number;
  zeroSupport: boolean;
}

/** Диагностика одного столбца полного Jacobian. */
export interface FullPatchColumnDiagnostic {
  column: number;
  oscillatorIndex: number;
  field: FullPatchOuterField;
  norm: number;
  zero: boolean;
  dependent: boolean;
  duplicateOf: number | null;
  residualRatio: number;
}

/** Численный rank после нормировки столбцов и модифицированного Грама—Шмидта. */
export interface FullPatchRankDiagnostics {
  rank: number;
  columnCount: number;
  zeroColumns: number[];
  dependentColumns: number[];
  columns: FullPatchColumnDiagnostic[];
  rankTolerance: number;
  duplicateTolerance: number;
}

/** Результат full-patch VP без полного клиппинга и PCM-квантования. */
export interface FullPatchJacobianResult {
  sampleCount: number;
  phaseModel: PhaseModel;
  coordinate: 'log';
  fields: readonly FullPatchOuterField[];
  bounds: readonly FullPatchOuterBound[];
  oscillators: FullPatchOscillatorJacobian[];
  diagnostics: FullPatchRankDiagnostics | null;
}

interface OuterValues {
  freqBase: number;
  freqStart: number;
  frequencySlope: number;
  frequencyDuration: number;
  amplitudeDuration: number;
  amplitudeEndLevel: number;
  amplitudeSlope: number;
}

interface FrequencyState {
  value: number;
  normalized: number;
  power: number;
  logRatio: number;
  beforeDuration: boolean;
}

interface AmplitudeState {
  value: number;
  durationLogDerivative: number;
  endLevelLogDerivative: number;
  slopeLogDerivative: number;
}

interface PreparedColumn {
  column: number;
  oscillatorIndex: number;
  field: FullPatchOuterField;
  norm: number;
  normalized: Float64Array | null;
}

interface BasisColumn {
  column: number;
  values: Float64Array;
}

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;
const DEFAULT_RANK_TOLERANCE = 1e-8;
const DEFAULT_DUPLICATE_TOLERANCE = 1e-12;

/** Проверяет положительное финитное поле, которое переводится в log. */
function positiveFinite(value: number, path: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be finite and positive`);
  }
  return value;
}

/** Читает наружные формы без изменения исходного patch. */
function readOuterValues(
  group: ArgCreateSynth['oscillators'][number],
  oscillatorIndex: number,
): OuterValues {
  const prefix = `oscillators[${oscillatorIndex}]`;
  return {
    freqBase: positiveFinite(
      group.osc.freqBase,
      `${prefix}.osc.freqBase`,
    ),
    freqStart: positiveFinite(
      group.osc.freqStart,
      `${prefix}.osc.freqStart`,
    ),
    frequencySlope: positiveFinite(
      group.osc.slope,
      `${prefix}.osc.slope`,
    ),
    frequencyDuration: positiveFinite(
      group.osc.duration,
      `${prefix}.osc.duration`,
    ),
    amplitudeDuration: positiveFinite(
      group.ampEnv.duration,
      `${prefix}.ampEnv.duration`,
    ),
    amplitudeEndLevel: positiveFinite(
      group.ampEnv.endLevel ?? MIN,
      `${prefix}.ampEnv.endLevel`,
    ),
    amplitudeSlope: positiveFinite(
      group.ampEnv.slope,
      `${prefix}.ampEnv.slope`,
    ),
  };
}

/** Проверяет неизменные localized/onset-поля по контракту renderer. */
function readFixedFields(
  group: ArgCreateSynth['oscillators'][number],
  oscillatorIndex: number,
): { delay: number; attack: number; hardStop: boolean } {
  const prefix = `oscillators[${oscillatorIndex}]`;
  const delay = group.osc.delay ?? 0;
  const attack = group.ampEnv.attack ?? 0;
  const hardStop = group.ampEnv.hardStop ?? false;
  if (
    !Number.isFinite(delay) ||
    delay < oscConfigNormales.delay.min ||
    delay > oscConfigNormales.delay.max
  ) {
    throw new Error(`${prefix}.osc.delay is outside 0–0.5 seconds`);
  }
  if (
    !Number.isFinite(attack) ||
    attack < ampEnvConfigNormales.attack.min ||
    attack > ampEnvConfigNormales.attack.max
  ) {
    throw new Error(
      `${prefix}.ampEnv.attack is outside 0–0.5 seconds`,
    );
  }
  if (typeof hardStop !== 'boolean') {
    throw new Error(`${prefix}.ampEnv.hardStop must be boolean`);
  }
  return { delay, attack, hardStop };
}

/** Вычисляет частотную огибающую и общие члены её производных. */
function frequencyState(
  x: number,
  values: OuterValues,
): FrequencyState {
  const clampedX = Math.min(x, values.frequencyDuration);
  const ratio = clampedX / values.frequencyDuration;
  const power = ratio ** values.frequencySlope;
  const normalized = Math.E ** (Math.log(MIN) * power);
  return {
    value:
      values.freqBase +
      (values.freqStart - values.freqBase) * normalized,
    normalized,
    power,
    logRatio: ratio > 0 ? Math.log(ratio) : 0,
    beforeDuration: x < values.frequencyDuration,
  };
}

/** Возвращает d(frequency)/d(log freqBase) в Гц. */
function frequencyBaseLogDerivative(
  x: number,
  values: OuterValues,
): number {
  const state = frequencyState(x, values);
  return values.freqBase * (1 - state.normalized);
}

/** Возвращает d(frequency)/d(log freqStart) в Гц. */
function frequencyStartLogDerivative(
  x: number,
  values: OuterValues,
): number {
  return values.freqStart * frequencyState(x, values).normalized;
}

/** Возвращает d(frequency)/d(log osc.slope) в Гц. */
function frequencySlopeLogDerivative(
  x: number,
  values: OuterValues,
): number {
  const state = frequencyState(x, values);
  if (!state.beforeDuration) {
    return 0;
  }
  return (
    (values.freqStart - values.freqBase) *
    state.normalized *
    Math.log(MIN) *
    state.power *
    state.logRatio *
    values.frequencySlope
  );
}

/** Возвращает d(frequency)/d(log osc.duration) в Гц. */
function frequencyDurationLogDerivative(
  x: number,
  values: OuterValues,
): number {
  const state = frequencyState(x, values);
  if (!state.beforeDuration) {
    return 0;
  }
  return (
    -(values.freqStart - values.freqBase) *
    state.normalized *
    Math.log(MIN) *
    state.power *
    values.frequencySlope
  );
}

/** Считает амплитуду и три её log-производные внутри support. */
function amplitudeState(
  localTime: number,
  values: OuterValues,
  attack: number,
): AmplitudeState {
  if (attack > 0 && localTime < attack) {
    return {
      value: Math.sin((Math.PI * localTime) / (2 * attack)) ** 2,
      durationLogDerivative: 0,
      endLevelLogDerivative: 0,
      slopeLogDerivative: 0,
    };
  }
  const decayTime = localTime - attack;
  const beforeDuration = decayTime < values.amplitudeDuration;
  const clampedTime = Math.min(decayTime, values.amplitudeDuration);
  const ratio = clampedTime / values.amplitudeDuration;
  const power = ratio ** values.amplitudeSlope;
  const logEndLevel = Math.log(values.amplitudeEndLevel);
  const value = Math.E ** (logEndLevel * power);
  const logRatio = ratio > 0 ? Math.log(ratio) : 0;
  return {
    value,
    durationLogDerivative: beforeDuration
      ? -value * logEndLevel * power * values.amplitudeSlope
      : 0,
    endLevelLogDerivative: value * power,
    slopeLogDerivative: beforeDuration
      ? value * logEndLevel * power * logRatio * values.amplitudeSlope
      : 0,
  };
}

/** Индексирует коэффициенты по исходным слотам и отклоняет неоднозначность. */
function indexCoefficients(
  patch: ArgCreateSynth,
  coefficients: readonly FullPatchQuadratureCoefficients[],
): Map<number, FullPatchQuadratureCoefficients> {
  const indexed = new Map<number, FullPatchQuadratureCoefficients>();
  for (const coefficient of coefficients) {
    const group = patch.oscillators[coefficient.oscillatorIndex];
    if (
      !Number.isInteger(coefficient.oscillatorIndex) ||
      group === undefined ||
      !group.osc.on
    ) {
      throw new Error(
        `Quadrature oscillatorIndex ${coefficient.oscillatorIndex} must name an active slot`,
      );
    }
    if (indexed.has(coefficient.oscillatorIndex)) {
      throw new Error(
        `Duplicate quadrature for oscillator ${coefficient.oscillatorIndex}`,
      );
    }
    if (
      !Number.isFinite(coefficient.sineCoefficient) ||
      !Number.isFinite(coefficient.cosineCoefficient)
    ) {
      throw new Error(
        `Quadrature for oscillator ${coefficient.oscillatorIndex} must be finite`,
      );
    }
    indexed.set(coefficient.oscillatorIndex, coefficient);
  }
  return indexed;
}

/** Строит вклад и аналитические log-производные одного активного слота. */
function buildOscillatorJacobian(arg: {
  group: ArgCreateSynth['oscillators'][number];
  oscillatorIndex: number;
  coefficients: FullPatchQuadratureCoefficients;
  sampleCount: number;
  phaseModel: PhaseModel;
}): FullPatchOscillatorJacobian {
  const values = readOuterValues(arg.group, arg.oscillatorIndex);
  const fixed = readFixedFields(arg.group, arg.oscillatorIndex);
  const cyclesAt =
    arg.phaseModel === 'integral'
      ? createCyclePhase(({ x }) => frequencyState(x, values).value)
      : null;
  const derivativeCyclesAt =
    arg.phaseModel === 'integral'
      ? {
          freqBase: createCyclePhase(({ x }) =>
            frequencyBaseLogDerivative(x, values),
          ),
          freqStart: createCyclePhase(({ x }) =>
            frequencyStartLogDerivative(x, values),
          ),
          frequencySlope: createCyclePhase(({ x }) =>
            frequencySlopeLogDerivative(x, values),
          ),
          frequencyDuration: createCyclePhase(({ x }) =>
            frequencyDurationLogDerivative(x, values),
          ),
        }
      : null;
  const contribution = new Float64Array(arg.sampleCount);
  const jacobian = Array.from(
    { length: FULL_PATCH_OUTER_FIELDS.length },
    () => new Float64Array(arg.sampleCount),
  );
  const sineCoefficient = arg.coefficients.sineCoefficient;
  const cosineCoefficient = arg.coefficients.cosineCoefficient;
  const supportEnd = fixed.attack + values.amplitudeDuration;
  const supportTolerance =
    4 * Number.EPSILON * Math.max(1, Math.abs(supportEnd));
  let supportSampleCount = 0;

  for (let index = 0; index < arg.sampleCount; index += 1) {
    const globalTime = index / SAMPLE_RATE;
    if (globalTime < fixed.delay) {
      continue;
    }
    const localTime = globalTime - fixed.delay;
    if (
      fixed.hardStop &&
      localTime + supportTolerance >= supportEnd
    ) {
      continue;
    }
    supportSampleCount += 1;
    const frequency = frequencyState(localTime, values);
    const angle =
      arg.phaseModel === 'integral'
        ? TWO_PI * (cyclesAt?.(localTime) ?? 0)
        : localTime * frequency.value * TWO_PI;
    const sine = Math.sin(angle);
    const cosine = Math.sin(angle + HALF_PI);
    const quadrature =
      sineCoefficient * sine + cosineCoefficient * cosine;
    const amplitude = amplitudeState(localTime, values, fixed.attack);
    contribution[index] = amplitude.value * quadrature;
    const phaseDerivative =
      amplitude.value *
      (sineCoefficient * Math.cos(angle) +
        cosineCoefficient * Math.cos(angle + HALF_PI));

    const frequencyDerivatives = [
      frequencyBaseLogDerivative(localTime, values),
      frequencyStartLogDerivative(localTime, values),
      frequencySlopeLogDerivative(localTime, values),
      frequencyDurationLogDerivative(localTime, values),
    ];
    const integratedDerivatives = derivativeCyclesAt;
    for (let column = 0; column < 4; column += 1) {
      const derivativeCycles =
        integratedDerivatives === null
          ? localTime * (frequencyDerivatives[column] ?? 0)
          : column === 0
            ? integratedDerivatives.freqBase(localTime)
            : column === 1
              ? integratedDerivatives.freqStart(localTime)
              : column === 2
                ? integratedDerivatives.frequencySlope(localTime)
                : integratedDerivatives.frequencyDuration(localTime);
      jacobian[column]?.set(
        [TWO_PI * phaseDerivative * derivativeCycles],
        index,
      );
    }
    const baseQuadrature = quadrature;
    jacobian[4]?.set(
      [amplitude.durationLogDerivative * baseQuadrature],
      index,
    );
    jacobian[5]?.set(
      [amplitude.endLevelLogDerivative * baseQuadrature],
      index,
    );
    jacobian[6]?.set(
      [amplitude.slopeLogDerivative * baseQuadrature],
      index,
    );
  }

  const arrays = [contribution, ...jacobian];
  if (!arrays.every((array) => array.every(Number.isFinite))) {
    throw new Error(
      `Non-finite full-patch Jacobian at oscillator ${arg.oscillatorIndex}`,
    );
  }
  return {
    oscillatorIndex: arg.oscillatorIndex,
    contribution,
    jacobian,
    supportSampleCount,
    zeroSupport: supportSampleCount === 0,
  };
}

/** Считает Euclidean norm без промежуточного переполнения квадратов. */
function stableNorm(values: Float64Array): number {
  let scale = 0;
  let scaledSquares = 0;
  for (const value of values) {
    const magnitude = Math.abs(value);
    if (magnitude === 0) {
      continue;
    }
    if (scale < magnitude) {
      const ratio = scale / magnitude;
      scaledSquares = 1 + scaledSquares * ratio * ratio;
      scale = magnitude;
    } else {
      const ratio = magnitude / scale;
      scaledSquares += ratio * ratio;
    }
  }
  const norm = scale === 0 ? 0 : scale * Math.sqrt(scaledSquares);
  if (!Number.isFinite(norm)) {
    throw new Error('Non-finite Jacobian column norm');
  }
  return norm;
}

/** Скалярное произведение двух нормированных столбцов. */
function dot(a: Float64Array, b: Float64Array): number {
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result += (a[index] ?? 0) * (b[index] ?? 0);
  }
  if (!Number.isFinite(result)) {
    throw new Error('Non-finite Jacobian column projection');
  }
  return result;
}

/** Нормирует ненулевой столбец для диагностики rank. */
function normalizedColumn(
  values: Float64Array,
  norm: number,
): Float64Array {
  return Float64Array.from(values, (value) => value / norm);
}

/** Готовит нормы и нормированные столбцы в порядке slot × field. */
function prepareColumns(
  oscillators: FullPatchOscillatorJacobian[],
): PreparedColumn[] {
  const prepared: PreparedColumn[] = [];
  for (const oscillator of oscillators) {
    for (
      let fieldIndex = 0;
      fieldIndex < FULL_PATCH_OUTER_FIELDS.length;
      fieldIndex += 1
    ) {
      const values = oscillator.jacobian[fieldIndex];
      const field = FULL_PATCH_OUTER_FIELDS[fieldIndex];
      if (values === undefined || field === undefined) {
        throw new Error('Incomplete full-patch Jacobian');
      }
      const norm = stableNorm(values);
      prepared.push({
        column: prepared.length,
        oscillatorIndex: oscillator.oscillatorIndex,
        field,
        norm,
        normalized:
          norm === 0 ? null : normalizedColumn(values, norm),
      });
    }
  }
  return prepared;
}

/** Ищет прежний базисный столбец, который почти совпадает по направлению. */
function duplicateSource(
  projections: number[],
  basis: BasisColumn[],
  duplicateTolerance: number,
): number | null {
  let largest = 0;
  let source: number | null = null;
  for (let index = 0; index < projections.length; index += 1) {
    const magnitude = Math.abs(projections[index] ?? 0);
    if (magnitude > largest) {
      largest = magnitude;
      source = basis[index]?.column ?? null;
    }
  }
  return largest >= 1 - duplicateTolerance ? source : null;
}

/**
 * Помечает нулевые, повторные и почти коллинеарные столбцы.
 * Два прохода ортогонализации ограничивают потерю ортогональности.
 */
function diagnoseRank(
  oscillators: FullPatchOscillatorJacobian[],
  rankTolerance: number,
  duplicateTolerance: number,
): FullPatchRankDiagnostics {
  const prepared = prepareColumns(oscillators);
  const basis: BasisColumn[] = [];
  const columns: FullPatchColumnDiagnostic[] = [];
  const zeroColumns: number[] = [];
  const dependentColumns: number[] = [];
  for (const current of prepared) {
    if (current.normalized === null) {
      zeroColumns.push(current.column);
      dependentColumns.push(current.column);
      columns.push({
        column: current.column,
        oscillatorIndex: current.oscillatorIndex,
        field: current.field,
        norm: 0,
        zero: true,
        dependent: true,
        duplicateOf: null,
        residualRatio: 0,
      });
      continue;
    }
    const residual = new Float64Array(current.normalized);
    const projections: number[] = [];
    for (let pass = 0; pass < 2; pass += 1) {
      for (
        let basisIndex = 0;
        basisIndex < basis.length;
        basisIndex += 1
      ) {
        const basisValues = basis[basisIndex]?.values;
        if (basisValues === undefined) {
          continue;
        }
        const projection = dot(
          pass === 0 ? current.normalized : residual,
          basisValues,
        );
        if (pass === 0) {
          projections.push(projection);
        }
        for (let index = 0; index < residual.length; index += 1) {
          residual[index] =
            (residual[index] ?? 0) -
            projection * (basisValues[index] ?? 0);
        }
      }
    }
    const residualRatio = stableNorm(residual);
    const dependent = residualRatio <= rankTolerance;
    const duplicateOf =
      dependent && residualRatio <= duplicateTolerance
        ? duplicateSource(projections, basis, duplicateTolerance)
        : null;
    if (dependent) {
      dependentColumns.push(current.column);
    } else {
      basis.push({
        column: current.column,
        values: normalizedColumn(residual, residualRatio),
      });
    }
    columns.push({
      column: current.column,
      oscillatorIndex: current.oscillatorIndex,
      field: current.field,
      norm: current.norm,
      zero: false,
      dependent,
      duplicateOf,
      residualRatio,
    });
  }
  return {
    rank: basis.length,
    columnCount: prepared.length,
    zeroColumns,
    dependentColumns,
    columns,
    rankTolerance,
    duplicateTolerance,
  };
}

/**
 * Строит canonical contribution каждого активного осциллятора и его
 * аналитический Jacobian по семи наружным формам.
 *
 * @param arg - Исходный `ArgCreateSynth`, квадратуры активных слотов,
 *   число отсчётов 44.1 кГц и модель фазы
 * @returns Вклады без общего clip, семь `Float64Array` на активный слот,
 *   явные log-границы и необязательную численную rank-диагностику
 * @throws Error если активный слот не имеет ровно одной финитной пары
 *   квадратур, log-поле не положительно, fixed-поля невалидны либо хотя бы
 *   один результат не финитен
 * @remarks Столбцы следуют порядку `FULL_PATCH_OUTER_FIELDS` и содержат
 *   `d(contribution)/d(log(field))`; натуральную производную получают
 *   делением на текущее положительное значение поля. Квадратуры держатся
 *   неподвижно: `sineCoefficient` умножает unit-фазу 0, а
 *   `cosineCoefficient` — unit-фазу π/2. Если их получить как
 *   `startLevel·cos(phase)` и `startLevel·sin(phase)`, contribution совпадает
 *   с `createOscillatorGroup` до округления. Модуль не меняет patch,
 *   коэффициенты, on/off, delay, attack, hardStop и остальные поля.
 *
 *   Integral-фаза и все её частотные производные используют отдельные
 *   экземпляры canonical `createCyclePhase`: трапеции на тех же узлах,
 *   та же интерполяция и тот же хвост за пределами таблицы. Во время attack
 *   амплитудные производные равны нулю. При x ≥ duration выбрана clamped-ветка:
 *   duration/slope имеют нулевую одностороннюю производную, а endLevel и
 *   частотные base/start сохраняют производные хвостов. Hard stop обнуляет
 *   значение и все столбцы с границы support; пересечение этой границы шагом
 *   solver здесь не моделируется.
 *
 *   Rank вычисляется для нормированных столбцов двумя проходами MGS.
 *   `duplicateTolerance` помечает почти точные повторы одного прежнего
 *   направления, `rankTolerance` — общую линейную зависимость. Диагностика
 *   стоит O(sampleCount·columnCount²); будущий горячий solver может отключить
 *   её через `rankDiagnostics: false`. Это фундамент гипотезы T36, а не
 *   измеренный выигрыш, закон качества или production-поведение.
 */
export function buildFullPatchJacobian(arg: {
  patch: ArgCreateSynth;
  coefficients: readonly FullPatchQuadratureCoefficients[];
  sampleCount: number;
  phaseModel?: PhaseModel;
  rankDiagnostics?: boolean;
  rankTolerance?: number;
  duplicateTolerance?: number;
}): FullPatchJacobianResult {
  const phaseModel = arg.phaseModel ?? 'legacy';
  const rankTolerance = arg.rankTolerance ?? DEFAULT_RANK_TOLERANCE;
  const duplicateTolerance =
    arg.duplicateTolerance ?? DEFAULT_DUPLICATE_TOLERANCE;
  if (!Number.isInteger(arg.sampleCount) || arg.sampleCount < 0) {
    throw new Error('sampleCount must be a non-negative integer');
  }
  if (phaseModel !== 'legacy' && phaseModel !== 'integral') {
    throw new Error(`Unknown phase model ${String(phaseModel)}`);
  }
  if (arg.patch.oscillators.length > MAX_OSCILLATORS) {
    throw new Error(
      `Full patch supports at most ${MAX_OSCILLATORS} slots`,
    );
  }
  if (
    !Number.isFinite(rankTolerance) ||
    !Number.isFinite(duplicateTolerance) ||
    duplicateTolerance <= 0 ||
    duplicateTolerance > rankTolerance ||
    rankTolerance >= 1
  ) {
    throw new Error(
      'Require 0 < duplicateTolerance <= rankTolerance < 1',
    );
  }
  const indexed = indexCoefficients(arg.patch, arg.coefficients);
  const activeCount = arg.patch.oscillators.filter(
    (group) => group.osc.on,
  ).length;
  if (indexed.size !== activeCount) {
    throw new Error(
      'Every active oscillator needs one quadrature pair',
    );
  }
  const oscillators: FullPatchOscillatorJacobian[] = [];
  for (
    let oscillatorIndex = 0;
    oscillatorIndex < arg.patch.oscillators.length;
    oscillatorIndex += 1
  ) {
    const group = arg.patch.oscillators[oscillatorIndex];
    if (group === undefined || !group.osc.on) {
      continue;
    }
    const coefficients = indexed.get(oscillatorIndex);
    if (coefficients === undefined) {
      throw new Error(
        `Missing quadrature for oscillator ${oscillatorIndex}`,
      );
    }
    oscillators.push(
      buildOscillatorJacobian({
        group,
        oscillatorIndex,
        coefficients,
        sampleCount: arg.sampleCount,
        phaseModel,
      }),
    );
  }
  return {
    sampleCount: arg.sampleCount,
    phaseModel,
    coordinate: 'log',
    fields: FULL_PATCH_OUTER_FIELDS,
    bounds: FULL_PATCH_OUTER_BOUNDS,
    oscillators,
    diagnostics:
      (arg.rankDiagnostics ?? true)
        ? diagnoseRank(oscillators, rankTolerance, duplicateTolerance)
        : null,
  };
}
