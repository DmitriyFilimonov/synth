/**
 * WAV-only screening локальной модуляции одного низкочастотного
 * носителя. H0 имеет постоянные квадратуры, H1 — кусочно-линейные.
 * Общие огибающая и фаза подбираются по H0 только на обучающих
 * отсчётах каждого fold и затем одинаково входят в обе модели.
 *
 * Это диагностика предсказания исключённых блоков, а не тест биения,
 * не accepted-правило и не закон качества.
 */
import {
  BEAT_DECIMATION,
  lowpassAmplitudeGain,
  lowpassDecimate,
  lowpassGroupDelaySec,
} from './beat-model';

const TWO_PI = 2 * Math.PI;
const MIN_FREQUENCY_HZ = 20;
const MAX_FREQUENCY_HZ = 300;
const MIN_SWEEP_TAU_SEC = 0.008;
const MAX_SWEEP_TAU_SEC = 0.12;
const RSS_FLOOR = 1e-24;

/** Общие нелинейные параметры D(t) и phi(t). */
export interface SharedModulationNuisance {
  /** Асимптотическая частота экспоненциального свипа, Гц. */
  frequencyHz: number;
  /** Разность стартовой и асимптотической частот, Гц. */
  sweepDeltaHz: number;
  /** Постоянная времени экспоненциального свипа, секунды. */
  sweepTauSec: number;
  /** Наклон log D на нормированном времени анализа. */
  logAmplitudeSlope: number;
}

/**
 * Общая модель, зафиксированная без использования held-out значений.
 */
export interface FittedSharedModulationNuisance extends SharedModulationNuisance {
  /** Вычтенный максимум log D, вычисленный только по train. */
  trainingMaxLogAmplitude: number;
}

/** Параметры воспроизводимого разбиения и регуляризации. */
export interface LocalModulationOptions {
  /** Начало анализа, секунды; по умолчанию 0.06. */
  startSec?: number;
  /** Наибольший конец анализа, секунды; по умолчанию 0.36. */
  endSec?: number;
  /** Шаг узлов сплайна и held-out блоков, 0.02–0.04 секунды. */
  blockSec?: number;
  /** Безразмерный вес штрафа вторых разностей; по умолчанию 0.08. */
  smoothing?: number;
}

/** Численный результат H0/H1 на одном исключённом блоке. */
export interface LocalModulationFold {
  index: number;
  startSec: number;
  endSec: number;
  trainSampleCount: number;
  heldOutSampleCount: number;
  /** Дополнительно исключённые filtered отсчёты вне scoring-блока. */
  purgedTrainSampleCount: number;
  nuisance: FittedSharedModulationNuisance;
  h0Coefficients: number[];
  h1Coefficients: number[];
  h0TrainRss: number;
  h1TrainRss: number;
  h0HeldOutRss: number;
  h1HeldOutRss: number;
  heldOutRssGain: number;
  h0HeldOutCenterPrediction: number;
  h1HeldOutCenterPrediction: number;
}

/** Описательная траектория полного fit; это не held-out оценка. */
export interface LocalModulationTrajectoryPoint {
  timeSec: number;
  sharedD: number;
  h0Amplitude: number;
  h1Amplitude: number;
  h1ResidualPhaseRad: number;
  h1ResidualFrequencyHz: number | null;
  h1TotalFrequencyHz: number | null;
}

/** Полный fit только для A(t), фазы и частоты. */
export interface LocalModulationDescriptiveFit {
  nuisance: FittedSharedModulationNuisance;
  h0Coefficients: number[];
  h1Coefficients: number[];
  h0Rss: number;
  h1Rss: number;
  trajectory: LocalModulationTrajectoryPoint[];
}

/** Сводные числа по folds без бинарного вердикта. */
export interface LocalModulationSummary {
  h0PooledHeldOutRss: number;
  h1PooledHeldOutRss: number;
  pooledHeldOutRssGain: number;
  medianFoldRssGain: number;
  minFoldRssGain: number;
  maxFoldRssGain: number;
  positiveGainFoldCount: number;
}

/** Результат screening либо явная причина отсутствия подгонки. */
export interface LocalModulationResult {
  modelVersion: 1;
  status: 'ok' | 'silence' | 'insufficient-data';
  sampleRate: number;
  decimatedSampleRate: number;
  decimation: number;
  options: Required<LocalModulationOptions>;
  analysisStartSec: number;
  analysisEndSec: number;
  knotsSec: number[];
  folds: LocalModulationFold[];
  summary: LocalModulationSummary;
  descriptiveFit: LocalModulationDescriptiveFit | null;
}

interface AnalysisData {
  times: number[];
  /** Raw index, который дал каждый decimated filtered отсчёт. */
  rawSampleIndices: number[];
  values: number[];
  referenceSec: number;
  spanSec: number;
  sourceDelaySec: number;
  sourceSampleRate: number;
  knotsSec: number[];
}

/** Индексы одного LOCO fold до численной подгонки. */
export interface LocalModulationFoldPartition {
  index: number;
  startSec: number;
  endSec: number;
  rawHeldOutStartIndex: number;
  rawHeldOutEndIndex: number;
  heldOutIndices: number[];
  trainIndices: number[];
  /** Train-кандидаты вне scoring-блока, удалённые из-за support. */
  purgedTrainIndices: number[];
  heldOutRawSampleIndices: number[];
  trainRawSampleIndices: number[];
  purgedTrainRawSampleIndices: number[];
  filterPastSamples: number;
  filterFutureSamples: number;
}

interface LinearFit {
  coefficients: number[];
  trainRss: number;
}

interface FoldFit {
  nuisance: FittedSharedModulationNuisance;
  h0Columns: number[][];
  h1Columns: number[][];
  h0: LinearFit;
  h1: LinearFit;
}

const PARAMETER_BOUNDS = {
  frequencyHz: [MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ],
  sweepDeltaHz: [-1600, 1600],
  logSweepTau: [
    Math.log(MIN_SWEEP_TAU_SEC),
    Math.log(MAX_SWEEP_TAU_SEC),
  ],
  logAmplitudeSlope: [-30, 30],
} as const;

type SearchParameter = keyof typeof PARAMETER_BOUNDS;

type SearchPoint = Record<SearchParameter, number>;

/**
 * Проверяет пересечение support filtered отсчёта и raw held-out.
 *
 * @param filterRawIndex - Raw index выхода фильтра до децимации
 * @param rawStart - Первый raw index held-out блока
 * @param rawEnd - Индекс сразу после held-out блока
 * @param pastSamples - Число предыдущих raw отсчётов в support
 * @param futureSamples - Число будущих raw отсчётов; у текущих трёх
 *   causal MA64 равно нулю
 * @returns true, если хотя бы один raw отсчёт support попал в блок
 * @remarks Support включает обе свои границы, а held-out имеет вид
 *   `[rawStart, rawEnd)`. Явный `futureSamples` не даёт silently
 *   сохранить causal-only purge после смены фильтра на двусторонний.
 */
export function filterSupportIntersectsRawHeldOut(
  filterRawIndex: number,
  rawStart: number,
  rawEnd: number,
  pastSamples: number,
  futureSamples = 0,
): boolean {
  const supportStart = filterRawIndex - pastSamples;
  const supportEnd = filterRawIndex + futureSamples;
  return supportStart < rawEnd && supportEnd >= rawStart;
}

function clamp(
  value: number,
  bounds: readonly [number, number],
): number {
  return Math.max(bounds[0], Math.min(bounds[1], value));
}

/**
 * Переводит точку поиска в физические параметры общей модели.
 *
 * @param point - Параметры поиска с log-постоянной времени sweep
 * @returns Общие параметры без train-only нормировки амплитуды
 */
function fromSearchPoint(
  point: SearchPoint,
): SharedModulationNuisance {
  return {
    frequencyHz: point.frequencyHz,
    sweepDeltaHz: point.sweepDeltaHz,
    sweepTauSec: Math.exp(point.logSweepTau),
    logAmplitudeSlope: point.logAmplitudeSlope,
  };
}

/**
 * Считает мгновенную частоту sweep на входе известного фильтра.
 *
 * @param sourceTimeSec - Время источника после вычитания задержки
 * @param nuisance - Общие параметры носителя
 * @returns Мгновенная частота в герцах
 */
function sourceFrequency(
  sourceTimeSec: number,
  nuisance: SharedModulationNuisance,
): number {
  return (
    nuisance.frequencyHz +
    nuisance.sweepDeltaHz *
      Math.exp(-sourceTimeSec / nuisance.sweepTauSec)
  );
}

/**
 * Считает log D с известной АЧХ фильтра, но без свободного масштаба.
 *
 * @param timeSec - Время decimated filtered отсчёта
 * @param data - Временные координаты и параметры фильтра
 * @param nuisance - Общие параметры огибающей и носителя
 * @returns Логарифм амплитуды до train-only нормировки
 * @remarks Задержка фильтра переводит filtered время во время
 *   источника. АЧХ использует неотрицательную частоту sweep.
 */
function logAmplitude(
  timeSec: number,
  data: AnalysisData,
  nuisance: SharedModulationNuisance,
): number {
  const sourceTimeSec = Math.max(0, timeSec - data.sourceDelaySec);
  const x = (sourceTimeSec - data.referenceSec) / data.spanSec;
  const filterGain = Math.max(
    1e-15,
    lowpassAmplitudeGain(
      Math.max(0, sourceFrequency(sourceTimeSec, nuisance)),
      data.sourceSampleRate,
    ),
  );
  return nuisance.logAmplitudeSlope * x + Math.log(filterGain);
}

/**
 * Считает интеграл фазы общего экспоненциального sweep.
 *
 * @param timeSec - Время decimated filtered отсчёта
 * @param data - Задержка фильтра и временные координаты
 * @param nuisance - Общие параметры носителя
 * @returns Фаза носителя в радианах
 */
function carrierPhase(
  timeSec: number,
  data: AnalysisData,
  nuisance: SharedModulationNuisance,
): number {
  const sourceTimeSec = Math.max(0, timeSec - data.sourceDelaySec);
  const tau = nuisance.sweepTauSec;
  const exponential =
    nuisance.sweepDeltaHz *
    tau *
    (1 - Math.exp(-sourceTimeSec / tau));
  return (
    TWO_PI * (nuisance.frequencyHz * sourceTimeSec + exponential)
  );
}

/**
 * Строит D·cos(phi) и −D·sin(phi) с train-only нормировкой D.
 *
 * @param data - Отсчёты, времена и параметры известного фильтра
 * @param nuisance - Общие параметры огибающей и носителя
 * @param trainIndices - Индексы, задающие максимум log D
 * @returns Два столбца носителя и вычтенный максимум log D
 * @remarks Столбцы строятся для всех отсчётов, но их масштаб зависит
 *   только от train. Значения held-out здесь не участвуют.
 */
function carrierColumns(
  data: AnalysisData,
  nuisance: SharedModulationNuisance,
  trainIndices: number[],
): { columns: number[][]; trainingMaxLogAmplitude: number } {
  let trainingMaxLogAmplitude = -Infinity;
  for (const index of trainIndices) {
    trainingMaxLogAmplitude = Math.max(
      trainingMaxLogAmplitude,
      logAmplitude(data.times[index] ?? 0, data, nuisance),
    );
  }
  if (!Number.isFinite(trainingMaxLogAmplitude)) {
    trainingMaxLogAmplitude = 0;
  }
  const cosine: number[] = [];
  const sine: number[] = [];
  for (const timeSec of data.times) {
    const amplitude = Math.exp(
      logAmplitude(timeSec, data, nuisance) - trainingMaxLogAmplitude,
    );
    const phase = carrierPhase(timeSec, data, nuisance);
    cosine.push(amplitude * Math.cos(phase));
    sine.push(-amplitude * Math.sin(phase));
  }
  return {
    columns: [cosine, sine],
    trainingMaxLogAmplitude,
  };
}

/**
 * Решает симметричную систему с выбором главного элемента.
 *
 * @param matrix - Квадратная матрица системы
 * @param right - Правая часть системы
 * @returns Вектор решения либо null при численной вырожденности
 * @remarks Исходные массивы не меняются. Нулевой, слишком малый или
 *   нечисловой pivot отклоняет решение, а не маскирует его.
 */
function solveLinearSystem(
  matrix: number[][],
  right: number[],
): number[] | null {
  const size = right.length;
  const augmented = matrix.map((row, index) => [
    ...row,
    right[index] ?? 0,
  ]);
  let scale = 0;
  for (const row of matrix) {
    for (const value of row) {
      scale = Math.max(scale, Math.abs(value));
    }
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (
        Math.abs(augmented[row]?.[column] ?? 0) >
        Math.abs(augmented[pivot]?.[column] ?? 0)
      ) {
        pivot = row;
      }
    }
    const current = augmented[column];
    const selected = augmented[pivot];
    if (current === undefined || selected === undefined) {
      return null;
    }
    augmented[column] = selected;
    augmented[pivot] = current;
    const divisor = augmented[column]?.[column] ?? 0;
    if (
      !Number.isFinite(divisor) ||
      Math.abs(divisor) <= 1e-13 * scale
    ) {
      return null;
    }
    for (let row = column + 1; row < size; row += 1) {
      const factor = (augmented[row]?.[column] ?? 0) / divisor;
      for (let index = column; index <= size; index += 1) {
        const target = augmented[row];
        if (target !== undefined) {
          target[index] =
            (target[index] ?? 0) -
            factor * (augmented[column]?.[index] ?? 0);
        }
      }
    }
  }
  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = augmented[row]?.[size] ?? 0;
    for (let column = row + 1; column < size; column += 1) {
      value -=
        (augmented[row]?.[column] ?? 0) * (solution[column] ?? 0);
    }
    const divisor = augmented[row]?.[row] ?? 0;
    if (!Number.isFinite(divisor) || Math.abs(divisor) <= 1e-30) {
      return null;
    }
    solution[row] = value / divisor;
  }
  return solution.every(Number.isFinite) ? solution : null;
}

/**
 * Складывает базис в предсказание на одном отсчёте.
 *
 * @param columns - Столбцы базиса по всем отсчётам
 * @param coefficients - Коэффициенты соответствующих столбцов
 * @param index - Индекс отсчёта
 * @returns Предсказанное значение отсчёта
 */
function predict(
  columns: number[][],
  coefficients: number[],
  index: number,
): number {
  let value = 0;
  for (let column = 0; column < columns.length; column += 1) {
    value +=
      (columns[column]?.[index] ?? 0) * (coefficients[column] ?? 0);
  }
  return value;
}

/**
 * Считает RSS строго на переданных индексах.
 *
 * @param columns - Столбцы базиса по всем отсчётам
 * @param coefficients - Коэффициенты подобранной модели
 * @param values - Наблюдаемые filtered значения
 * @param indices - Индексы train или held-out отсчётов
 * @returns Сумма квадратов остатков на выбранных индексах
 * @throws Error если полученный RSS не конечен
 */
function residualSumSquares(
  columns: number[][],
  coefficients: number[],
  values: number[],
  indices: number[],
): number {
  let rss = 0;
  for (const index of indices) {
    const residual =
      (values[index] ?? 0) - predict(columns, coefficients, index);
    rss += residual * residual;
  }
  if (!Number.isFinite(rss)) {
    throw new Error('RSS не конечен');
  }
  return rss;
}

interface NormalEquations {
  gram: number[][];
  right: number[];
}

/**
 * Складывает Gram и правую часть строго в прежнем train-порядке.
 *
 * @param columns - Столбцы базиса по всем отсчётам
 * @param values - Наблюдаемые filtered значения
 * @param trainIndices - Очищенные от support held-out индексы train
 * @returns Нерегуляризованные нормальные уравнения
 * @remarks Цикл читает значения только из trainIndices и заполняет
 *   верхний треугольник Gram, после чего зеркалит его вниз.
 */
function buildNormalEquations(
  columns: number[][],
  values: number[],
  trainIndices: number[],
): NormalEquations {
  const size = columns.length;
  const gram = Array.from({ length: size }, () =>
    new Array<number>(size).fill(0),
  );
  const right = new Array<number>(size).fill(0);
  for (const index of trainIndices) {
    for (let row = 0; row < size; row += 1) {
      const rowValue = columns[row]?.[index] ?? 0;
      const target = right[row] ?? 0;
      right[row] = target + rowValue * (values[index] ?? 0);
      const gramRow = gram[row];
      if (gramRow !== undefined) {
        for (let column = row; column < size; column += 1) {
          gramRow[column] =
            (gramRow[column] ?? 0) +
            rowValue * (columns[column]?.[index] ?? 0);
        }
      }
    }
  }
  for (let row = 0; row < size; row += 1) {
    const gramRow = gram[row];
    if (gramRow !== undefined) {
      for (let column = 0; column < row; column += 1) {
        gramRow[column] = gram[column]?.[row] ?? 0;
      }
    }
  }
  return { gram, right };
}

/**
 * Добавляет train-scaled ridge и штраф вторых разностей C/S.
 *
 * @param equations - Нормальные уравнения, собранные только по train
 * @param knotCount - Число узлов на каждую квадратуру H1
 * @param smoothing - Вес штрафа вторых разностей
 * @returns Ничего; меняет Gram переданных уравнений
 * @remarks Средний диагональный элемент Gram задаёт масштаб обоих
 *   штрафов. Квадратуры C и S получают независимые блоки вторых
 *   разностей; правая часть не меняется.
 */
function addRegularization(
  equations: NormalEquations,
  knotCount: number,
  smoothing: number,
): void {
  const { gram } = equations;
  const size = gram.length;
  let diagonalSum = 0;
  for (let index = 0; index < size; index += 1) {
    diagonalSum += gram[index]?.[index] ?? 0;
  }
  const meanDiagonal = Math.max(diagonalSum / size, 1e-20);
  const ridge = meanDiagonal * 1e-10;
  for (let index = 0; index < size; index += 1) {
    const diagonal = gram[index];
    if (diagonal !== undefined) {
      diagonal[index] = (diagonal[index] ?? 0) + ridge;
    }
  }
  if (knotCount >= 3 && smoothing > 0) {
    const penalty = smoothing * meanDiagonal;
    for (let quadrature = 0; quadrature < 2; quadrature += 1) {
      for (let knot = 1; knot + 1 < knotCount; knot += 1) {
        const indices = [
          quadrature * knotCount + knot - 1,
          quadrature * knotCount + knot,
          quadrature * knotCount + knot + 1,
        ];
        const difference = [1, -2, 1];
        for (let row = 0; row < 3; row += 1) {
          for (let column = 0; column < 3; column += 1) {
            const i = indices[row] ?? 0;
            const j = indices[column] ?? 0;
            if (gram[i] !== undefined) {
              gram[i][j] =
                (gram[i][j] ?? 0) +
                penalty *
                  (difference[row] ?? 0) *
                  (difference[column] ?? 0);
            }
          }
        }
      }
    }
  }
}

/**
 * Решает готовую систему и считает RSS на том же train.
 *
 * @param equations - Регуляризованные нормальные уравнения
 * @param columns - Столбцы базиса по всем отсчётам
 * @param values - Наблюдаемые filtered значения
 * @param trainIndices - Тот же очищенный train, что собрал систему
 * @returns Коэффициенты и обычный RSS без регуляризационного штрафа
 * @throws Error если система вырождена или RSS не конечен
 */
function solveNormalEquations(
  equations: NormalEquations,
  columns: number[][],
  values: number[],
  trainIndices: number[],
): LinearFit {
  const coefficients = solveLinearSystem(
    equations.gram,
    equations.right,
  );
  if (coefficients === null) {
    throw new Error('Не удалось решить регуляризованную систему');
  }
  return {
    coefficients,
    trainRss: residualSumSquares(
      columns,
      coefficients,
      values,
      trainIndices,
    ),
  };
}

/**
 * Подгоняет линейные квадратуры только по очищенному train.
 *
 * @param columns - Столбцы базиса по всем отсчётам
 * @param values - Наблюдаемые filtered значения
 * @param trainIndices - Train без held-out и его raw support
 * @param knotCount - Число узлов на квадратуру; у H0 равно единице
 * @param smoothing - Вес штрафа вторых разностей H1
 * @returns Коэффициенты и RSS на train
 * @throws Error если система вырождена или RSS не конечен
 * @remarks Held-out значения не входят ни в уравнения, ни в RSS.
 */
function fitLinear(
  columns: number[][],
  values: number[],
  trainIndices: number[],
  knotCount: number,
  smoothing: number,
): LinearFit {
  const equations = buildNormalEquations(
    columns,
    values,
    trainIndices,
  );
  addRegularization(equations, knotCount, smoothing);
  return solveNormalEquations(
    equations,
    columns,
    values,
    trainIndices,
  );
}

/**
 * Оценивает variable projection только для H0 и только на train.
 *
 * @param point - Пробные общие параметры в координатах поиска
 * @param data - Filtered отсчёты и временные координаты
 * @param trainIndices - Очищенные индексы train
 * @returns RSS лучшей линейной H0 либо Infinity при отказе fit
 * @remarks H1 и held-out значения не влияют на эту целевую функцию.
 */
function nuisanceRss(
  point: SearchPoint,
  data: AnalysisData,
  trainIndices: number[],
): number {
  const { columns } = carrierColumns(
    data,
    fromSearchPoint(point),
    trainIndices,
  );
  try {
    const rss = fitLinear(
      columns,
      data.values,
      trainIndices,
      1,
      0,
    ).trainRss;
    return rss;
  } catch {
    return Infinity;
  }
}

/**
 * Грубо ищет носитель без использования held-out блоков.
 *
 * @param data - Filtered отсчёты и параметры известного фильтра
 * @param trainIndices - Очищенные индексы train
 * @returns Начальная точка с лучшей частотой по H0 train RSS
 * @remarks Сканирует частоты 25–250 Гц с шагом 1 Гц при нулевых
 *   sweep и наклоне амплитуды; постоянная времени равна 30 мс.
 */
function initialCarrier(
  data: AnalysisData,
  trainIndices: number[],
): SearchPoint {
  const point: SearchPoint = {
    frequencyHz: 50,
    sweepDeltaHz: 0,
    logSweepTau: Math.log(0.03),
    logAmplitudeSlope: 0,
  };
  let bestRss = Infinity;
  let bestFrequency = point.frequencyHz;
  for (let frequency = 25; frequency <= 250; frequency += 1) {
    point.frequencyHz = frequency;
    const rss = nuisanceRss(point, data, trainIndices);
    if (rss < bestRss) {
      bestFrequency = frequency;
      bestRss = rss;
    }
  }
  point.frequencyHz = bestFrequency;
  return point;
}

/**
 * Сдвигает один параметр и ограничивает его заданными границами.
 *
 * @param point - Исходная точка поиска
 * @param parameter - Имя изменяемого параметра
 * @param offset - Сдвиг в координатах поиска
 * @returns Новая точка; исходная не меняется
 */
function movedPoint(
  point: SearchPoint,
  parameter: SearchParameter,
  offset: number,
): SearchPoint {
  return {
    ...point,
    [parameter]: clamp(
      point[parameter] + offset,
      PARAMETER_BOUNDS[parameter],
    ),
  };
}

/**
 * Строит фиксированную sweep-сетку вокруг найденного носителя.
 *
 * @param initial - Точка после грубого поиска несущей частоты
 * @returns Исходная точка и детерминированные старты pattern search
 * @remarks Сетка меняет частоту, размах и постоянную времени sweep,
 *   но наследует наклон log D из initial. Случайных стартов нет.
 */
function createNuisanceSeeds(initial: SearchPoint): SearchPoint[] {
  const baseFrequency = Math.round(initial.frequencyHz);
  const seeds: SearchPoint[] = [{ ...initial }];
  for (const frequencyOffset of [-2, -1, 0, 1, 2]) {
    for (const delta of [
      -800, -400, -200, -100, 100, 200, 400, 750, 800,
    ]) {
      for (const tau of [0.015, 0.025, 0.03, 0.06]) {
        seeds.push({
          ...initial,
          frequencyHz: clamp(
            baseFrequency + frequencyOffset,
            PARAMETER_BOUNDS.frequencyHz,
          ),
          sweepDeltaHz: delta,
          logSweepTau: Math.log(tau),
        });
      }
    }
  }
  return seeds;
}

/**
 * Выполняет детерминированный pattern search в прежнем порядке осей.
 *
 * @param initial - Точка после грубого поиска несущей частоты
 * @param data - Filtered отсчёты и параметры известного фильтра
 * @param trainIndices - Очищенные индексы train
 * @returns Лучшая найденная точка общих параметров H0
 * @remarks Сначала сравнивает фиксированные старты, затем 16 проходов
 *   уточняет четыре параметра и вдвое уменьшает шаги. Случайных
 *   стартов и Math.random здесь нет; held-out значения не читаются.
 */
function patternSearchNuisance(
  initial: SearchPoint,
  data: AnalysisData,
  trainIndices: number[],
): SearchPoint {
  let best = initial;
  let bestRss = nuisanceRss(best, data, trainIndices);
  for (const seed of createNuisanceSeeds(initial)) {
    const rss = nuisanceRss(seed, data, trainIndices);
    if (rss < bestRss) {
      best = seed;
      bestRss = rss;
    }
  }
  const steps: Record<SearchParameter, number> = {
    frequencyHz: 0.25,
    sweepDeltaHz: 25,
    logSweepTau: 0.1,
    logAmplitudeSlope: 0.5,
  };
  const parameters = Object.keys(steps) as SearchParameter[];
  for (let pass = 0; pass < 16; pass += 1) {
    for (const parameter of parameters) {
      for (let move = 0; move < 4; move += 1) {
        let movedBest = best;
        let movedRss = bestRss;
        for (const sign of [-1, 1]) {
          const candidate = movedPoint(
            best,
            parameter,
            sign * steps[parameter],
          );
          const rss = nuisanceRss(candidate, data, trainIndices);
          if (rss < movedRss) {
            movedBest = candidate;
            movedRss = rss;
          }
        }
        if (movedRss >= bestRss) {
          break;
        }
        best = movedBest;
        bestRss = movedRss;
      }
    }
    for (const parameter of parameters) {
      steps[parameter] *= 0.5;
    }
  }
  return best;
}

/**
 * Фиксирует nuisance и train-only нормировку после поиска.
 *
 * @param best - Лучшая точка pattern search
 * @param data - Отсчёты и временные координаты
 * @param trainIndices - Очищенные индексы train
 * @returns Общие параметры и максимум log D только по train
 * @remarks Held-out не меняет ни выбранные параметры, ни масштаб D.
 */
function finalizeNuisance(
  best: SearchPoint,
  data: AnalysisData,
  trainIndices: number[],
): FittedSharedModulationNuisance {
  const nuisance = fromSearchPoint(best);
  const { trainingMaxLogAmplitude } = carrierColumns(
    data,
    nuisance,
    trainIndices,
  );
  return { ...nuisance, trainingMaxLogAmplitude };
}

/**
 * Последовательно запускает carrier scan, seed grid и pattern search.
 *
 * @param data - Filtered отсчёты и параметры известного фильтра
 * @param trainIndices - Очищенные индексы train
 * @returns Общие для H0 и H1 параметры, подобранные только по H0
 * @remarks H1 не получает отдельных D или phi: обе модели используют
 *   этот результат без изменений.
 */
function optimizeNuisance(
  data: AnalysisData,
  trainIndices: number[],
): FittedSharedModulationNuisance {
  const initial = initialCarrier(data, trainIndices);
  const best = patternSearchNuisance(initial, data, trainIndices);
  return finalizeNuisance(best, data, trainIndices);
}

/**
 * Умножает общий носитель на постоянные или hat-basis квадратуры.
 *
 * @param data - Времена отсчётов и узлы сплайна
 * @param fitted - Зафиксированные общие D и phi
 * @param trainIndices - Индексы для train-only нормировки D
 * @returns Два столбца H0 и кусочно-линейный базис H1
 * @remarks Обе модели получают один носитель; H1 меняет только
 *   квадратуры и не запускает собственный поиск nuisance.
 */
function modulationColumns(
  data: AnalysisData,
  fitted: FittedSharedModulationNuisance,
  trainIndices: number[],
): { h0Columns: number[][]; h1Columns: number[][] } {
  const { columns: carrier } = carrierColumns(
    data,
    fitted,
    trainIndices,
  );
  const h1Columns: number[][] = [];
  for (let quadrature = 0; quadrature < 2; quadrature += 1) {
    for (let knot = 0; knot < data.knotsSec.length; knot += 1) {
      const column = data.times.map((timeSec, index) => {
        const knotSec = data.knotsSec[knot] ?? 0;
        const left = data.knotsSec[knot - 1];
        const right = data.knotsSec[knot + 1];
        let weight = 0;
        if (
          left !== undefined &&
          timeSec >= left &&
          timeSec <= knotSec
        ) {
          weight = (timeSec - left) / (knotSec - left);
        } else if (
          right !== undefined &&
          timeSec >= knotSec &&
          timeSec <= right
        ) {
          weight = (right - timeSec) / (right - knotSec);
        } else if (left === undefined && timeSec <= knotSec) {
          weight = 1;
        } else if (right === undefined && timeSec >= knotSec) {
          weight = 1;
        }
        return weight * (carrier[quadrature]?.[index] ?? 0);
      });
      h1Columns.push(column);
    }
  }
  return { h0Columns: carrier, h1Columns };
}

/**
 * Подгоняет общие параметры и обе линейные модели на одном train.
 *
 * @param data - Filtered отсчёты, времена и узлы сплайна
 * @param trainIndices - Train без held-out и его raw support
 * @param smoothing - Вес штрафа вторых разностей H1
 * @returns Общий nuisance, базисы и линейные fit для H0 и H1
 * @throws Error если линейная система вырождена или RSS не конечен
 * @remarks Nuisance сначала выбирается по H0 на train, затем обе
 *   модели используют его и одну train-only нормировку амплитуды.
 */
function fitModels(
  data: AnalysisData,
  trainIndices: number[],
  smoothing: number,
): FoldFit {
  const nuisance = optimizeNuisance(data, trainIndices);
  const { h0Columns, h1Columns } = modulationColumns(
    data,
    nuisance,
    trainIndices,
  );
  return {
    nuisance,
    h0Columns,
    h1Columns,
    h0: fitLinear(h0Columns, data.values, trainIndices, 1, 0),
    h1: fitLinear(
      h1Columns,
      data.values,
      trainIndices,
      data.knotsSec.length,
      smoothing,
    ),
  };
}

/**
 * Считает долю остатка H0, которую сняла модель H1.
 *
 * @param h0Rss - RSS модели с постоянными квадратурами
 * @param h1Rss - RSS модели с кусочно-линейными квадратурами
 * @returns Величина `(h0Rss - h1Rss) / h0Rss` с защитой знаменателя
 * @throws Error если входной RSS или итоговый gain не конечен
 * @remarks Если оба RSS не превышают RSS_FLOOR, возвращается ноль.
 */
function residualGain(h0Rss: number, h1Rss: number): number {
  if (!Number.isFinite(h0Rss) || !Number.isFinite(h1Rss)) {
    throw new Error('Нельзя сравнивать нечисловые RSS');
  }
  if (h0Rss <= RSS_FLOOR && h1Rss <= RSS_FLOOR) {
    return 0;
  }
  const gain = (h0Rss - h1Rss) / Math.max(h0Rss, RSS_FLOOR);
  if (!Number.isFinite(gain)) {
    throw new Error('RSS gain не конечен');
  }
  return gain;
}

/**
 * Считает медиану без изменения исходного массива.
 *
 * @param values - Значения fold gain
 * @returns Медиана либо ноль для пустого массива
 */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Считает C, S и центральные производные на глобальном hat-basis.
 *
 * @param knot - Индекс узла сплайна
 * @param coefficients - Сначала все C, затем все S по узлам
 * @param knotDurationSec - Расстояние между соседними узлами
 * @returns Квадратуры и их производные по времени в узле
 * @remarks На краях используются односторонние разности.
 */
function quadraturesAtKnot(
  knot: number,
  coefficients: number[],
  knotDurationSec: number,
): { c: number; s: number; dc: number; ds: number } {
  const knotCount = coefficients.length / 2;
  const next = Math.min(knot + 1, knotCount - 1);
  const previous = Math.max(knot - 1, 0);
  const derivativeSpan = (next - previous) * knotDurationSec;
  const c = coefficients[knot] ?? 0;
  const s = coefficients[knotCount + knot] ?? 0;
  const dc =
    derivativeSpan > 0
      ? ((coefficients[next] ?? 0) - (coefficients[previous] ?? 0)) /
        derivativeSpan
      : 0;
  const ds =
    derivativeSpan > 0
      ? ((coefficients[knotCount + next] ?? 0) -
          (coefficients[knotCount + previous] ?? 0)) /
        derivativeSpan
      : 0;
  return { c, s, dc, ds };
}

/**
 * Строит описательный full fit; folds его не используют.
 *
 * @param data - Все подготовленные filtered отсчёты
 * @param smoothing - Вес штрафа вторых разностей H1
 * @returns Полные fit и траектории A(t), фазы и частоты
 * @throws Error если линейная система вырождена или RSS не конечен
 * @remarks Full fit использует все отсчёты и служит только описанием
 *   траекторий. Он не входит в held-out RSS, gain или summary folds.
 */
function descriptiveFit(
  data: AnalysisData,
  smoothing: number,
): LocalModulationDescriptiveFit {
  const allIndices = data.times.map((_, index) => index);
  const fitted = fitModels(data, allIndices, smoothing);
  const firstKnot = data.knotsSec[0] ?? 0;
  const lastKnot = data.knotsSec[data.knotsSec.length - 1] ?? 1;
  const knotDuration =
    data.knotsSec.length > 1
      ? (lastKnot - firstKnot) / (data.knotsSec.length - 1)
      : 1;
  const trajectory = data.knotsSec.map((timeSec, knot) => {
    const q = quadraturesAtKnot(
      knot,
      fitted.h1.coefficients,
      knotDuration,
    );
    const sharedD = Math.exp(
      logAmplitude(timeSec, data, fitted.nuisance) -
        fitted.nuisance.trainingMaxLogAmplitude,
    );
    const h0Amplitude =
      sharedD *
      Math.hypot(
        fitted.h0.coefficients[0] ?? 0,
        fitted.h0.coefficients[1] ?? 0,
      );
    const amplitudeSquared = q.c * q.c + q.s * q.s;
    const residualFrequencyHz =
      amplitudeSquared > 1e-20
        ? (q.c * q.ds - q.s * q.dc) / amplitudeSquared / TWO_PI
        : null;
    const carrierFrequencyHz = sourceFrequency(
      Math.max(0, timeSec - data.sourceDelaySec),
      fitted.nuisance,
    );
    return {
      timeSec,
      sharedD,
      h0Amplitude,
      h1Amplitude: sharedD * Math.sqrt(amplitudeSquared),
      h1ResidualPhaseRad: Math.atan2(q.s, q.c),
      h1ResidualFrequencyHz: residualFrequencyHz,
      h1TotalFrequencyHz:
        residualFrequencyHz === null
          ? null
          : carrierFrequencyHz + residualFrequencyHz,
    };
  });
  return {
    nuisance: fitted.nuisance,
    h0Coefficients: fitted.h0.coefficients,
    h1Coefficients: fitted.h1.coefficients,
    h0Rss: fitted.h0.trainRss,
    h1Rss: fitted.h1.trainRss,
    trajectory,
  };
}

/**
 * Создаёт нулевую сводку для результата без оценённых folds.
 *
 * @returns Summary с нулевыми RSS, gain и счётчиками
 */
function emptySummary(): LocalModulationSummary {
  return {
    h0PooledHeldOutRss: 0,
    h1PooledHeldOutRss: 0,
    pooledHeldOutRssGain: 0,
    medianFoldRssGain: 0,
    minFoldRssGain: 0,
    maxFoldRssGain: 0,
    positiveGainFoldCount: 0,
  };
}

/**
 * Проверяет частоту дискретизации и ограничения screening.
 *
 * @param sampleRate - Исходная частота дискретизации
 * @param options - Полностью заполненные параметры анализа
 * @returns Ничего
 * @throws Error если параметр не конечен или выходит за допуск
 */
function validateOptions(
  sampleRate: number,
  options: Required<LocalModulationOptions>,
): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate должен быть положительным');
  }
  if (
    !Number.isFinite(options.startSec) ||
    !Number.isFinite(options.endSec) ||
    options.startSec < 0 ||
    options.endSec <= options.startSec
  ) {
    throw new Error('Некорректный интервал анализа');
  }
  if (
    !Number.isFinite(options.blockSec) ||
    options.blockSec < 0.02 ||
    options.blockSec > 0.04
  ) {
    throw new Error('blockSec должен лежать в диапазоне 0.02–0.04');
  }
  if (!Number.isFinite(options.smoothing) || options.smoothing < 0) {
    throw new Error('smoothing должен быть неотрицательным');
  }
}

interface ResultContext {
  sampleRate: number;
  decimatedSampleRate: number;
  options: Required<LocalModulationOptions>;
  analysisStartSec: number;
  analysisEndSec: number;
}

interface PreparedLocalModulation {
  context: ResultContext;
  data: AnalysisData | null;
  status: LocalModulationResult['status'];
}

/**
 * Создаёт пустой результат без фиктивных folds или full fit.
 *
 * @param context - Фактические границы и параметры анализа
 * @param status - Явная причина отсутствия fit либо ok для шаблона
 * @param knotsSec - Узлы анализа, если они уже построены
 * @returns Результат с пустыми folds, нулевой summary и без full fit
 */
function emptyLocalModulationResult(
  context: ResultContext,
  status: LocalModulationResult['status'],
  knotsSec: number[] = [],
): LocalModulationResult {
  return {
    modelVersion: 1,
    ...context,
    decimation: BEAT_DECIMATION,
    knotsSec,
    folds: [],
    summary: emptySummary(),
    descriptiveFit: null,
    status,
  };
}

/**
 * Фильтрует, децимирует и готовит общие временные/raw координаты.
 *
 * @param samples - Исходные raw отсчёты mono PCM
 * @param sampleRate - Исходная частота дискретизации
 * @param options - Интервал, длительность блоков и сглаживание
 * @returns Контекст результата, данные анализа и статус подготовки
 * @throws Error если sampleRate или options не проходят ограничения
 * @remarks Сохраняет связь каждого filtered отсчёта с raw index,
 *   задержку и частоту исходника для последующего support purge.
 *   Короткий вход и тишина возвращают data=null без подгонки.
 */
function prepareLocalModulation(
  samples: ArrayLike<number>,
  sampleRate: number,
  options: LocalModulationOptions,
): PreparedLocalModulation {
  const resolved: Required<LocalModulationOptions> = {
    startSec: options.startSec ?? 0.06,
    endSec: options.endSec ?? 0.36,
    blockSec: options.blockSec ?? 0.03,
    smoothing: options.smoothing ?? 0.08,
  };
  validateOptions(sampleRate, resolved);
  const decimated = lowpassDecimate(samples);
  const decimatedSampleRate = sampleRate / BEAT_DECIMATION;
  const availableEnd = decimated.length / decimatedSampleRate;
  const foldCount = Math.floor(
    (Math.min(resolved.endSec, availableEnd) - resolved.startSec) /
      resolved.blockSec,
  );
  const analysisEndSec =
    resolved.startSec + Math.max(0, foldCount) * resolved.blockSec;
  const context: ResultContext = {
    sampleRate,
    decimatedSampleRate,
    options: resolved,
    analysisStartSec: resolved.startSec,
    analysisEndSec,
  };
  if (foldCount < 5) {
    return { context, data: null, status: 'insufficient-data' };
  }
  const indices = decimated
    .map((_, index) => index)
    .filter((index) => {
      const timeSec = index / decimatedSampleRate;
      return timeSec >= resolved.startSec && timeSec < analysisEndSec;
    });
  const energy = indices.reduce(
    (sum, index) => sum + (decimated[index] ?? 0) ** 2,
    0,
  );
  if (energy <= 1e-20) {
    return { context, data: null, status: 'silence' };
  }
  const knotsSec = Array.from(
    { length: foldCount + 1 },
    (_, index) => resolved.startSec + index * resolved.blockSec,
  );
  const data: AnalysisData = {
    times: indices.map((index) => index / decimatedSampleRate),
    rawSampleIndices: indices.map((index) => index * BEAT_DECIMATION),
    values: indices.map((index) => decimated[index] ?? 0),
    referenceSec: (resolved.startSec + analysisEndSec) / 2,
    spanSec: analysisEndSec - resolved.startSec,
    sourceDelaySec: lowpassGroupDelaySec(sampleRate),
    sourceSampleRate: sampleRate,
    knotsSec,
  };
  return { context, data, status: 'ok' };
}

/**
 * Строит support-safe разбиения внутренних LOCO folds без optimizer.
 *
 * @param data - Подготовленные filtered отсчёты и raw координаты
 * @returns Разбиения held-out, очищенного train и purge
 * @remarks Первый и последний блоки остаются в train, поэтому H1 не
 *   экстраполирует крайние held-out блоки. Train также теряет каждый
 *   filtered отсчёт вне scoring-блока, если его raw support
 *   пересекает held-out. Текущие три causal MA64 имеют нулевой
 *   future support.
 */
function createFoldPartitions(
  data: AnalysisData,
): LocalModulationFoldPartition[] {
  const filterPastSamples = Math.round(
    2 * data.sourceDelaySec * data.sourceSampleRate,
  );
  const filterFutureSamples = 0;
  const partitions: LocalModulationFoldPartition[] = [];
  for (let fold = 1; fold < data.knotsSec.length - 2; fold += 1) {
    const startSec = data.knotsSec[fold] ?? 0;
    const endSec = data.knotsSec[fold + 1] ?? startSec;
    const rawHeldOutStartIndex = Math.ceil(
      startSec * data.sourceSampleRate,
    );
    const rawHeldOutEndIndex = Math.ceil(
      endSec * data.sourceSampleRate,
    );
    const heldOutIndices = data.times
      .map((timeSec, index) => ({ timeSec, index }))
      .filter(
        ({ timeSec }) => timeSec >= startSec && timeSec < endSec,
      )
      .map(({ index }) => index);
    const heldOut = new Set(heldOutIndices);
    const trainIndices: number[] = [];
    const purgedTrainIndices: number[] = [];
    for (let index = 0; index < data.times.length; index += 1) {
      if (heldOut.has(index)) {
        continue;
      }
      const intersects = filterSupportIntersectsRawHeldOut(
        data.rawSampleIndices[index] ?? 0,
        rawHeldOutStartIndex,
        rawHeldOutEndIndex,
        filterPastSamples,
        filterFutureSamples,
      );
      if (intersects) {
        purgedTrainIndices.push(index);
      } else {
        trainIndices.push(index);
      }
    }
    partitions.push({
      index: fold,
      startSec,
      endSec,
      rawHeldOutStartIndex,
      rawHeldOutEndIndex,
      heldOutIndices,
      trainIndices,
      purgedTrainIndices,
      heldOutRawSampleIndices: heldOutIndices.map(
        (index) => data.rawSampleIndices[index] ?? 0,
      ),
      trainRawSampleIndices: trainIndices.map(
        (index) => data.rawSampleIndices[index] ?? 0,
      ),
      purgedTrainRawSampleIndices: purgedTrainIndices.map(
        (index) => data.rawSampleIndices[index] ?? 0,
      ),
      filterPastSamples,
      filterFutureSamples,
    });
  }
  return partitions;
}

/**
 * Готовит support-safe folds без подгонки, чтобы проверять границы.
 *
 * @param samples - Исходные raw отсчёты
 * @param sampleRate - Частота дискретизации, по умолчанию 44100 Гц
 * @param options - Те же интервал и блоки, что у screening
 * @returns Внутренние folds; для silence/short входа возвращается []
 * @throws Error если sampleRate или options не проходят ограничения
 * @remarks Для текущих трёх causal MA64 past support равен
 *   `round(2·lowpassGroupDelaySec·sampleRate)` = 189 raw отсчётам
 *   при 44100 Гц, то есть полный support содержит 190 отсчётов.
 *   Дополнительно удаляются filtered отсчёты справа, чей support
 *   пересекает held-out.
 */
export function createLocalModulationFoldPartitions(
  samples: ArrayLike<number>,
  sampleRate = 44100,
  options: LocalModulationOptions = {},
): LocalModulationFoldPartition[] {
  const prepared = prepareLocalModulation(
    samples,
    sampleRate,
    options,
  );
  return prepared.data === null
    ? []
    : createFoldPartitions(prepared.data);
}

/**
 * Подгоняет H0/H1 и оценивает один заранее очищенный fold.
 *
 * @param data - Подготовленные filtered отсчёты и raw координаты
 * @param partition - Зафиксированные train, held-out и purge индексы
 * @param smoothing - Вес штрафа вторых разностей H1
 * @returns Метрики fold либо null при пустом held-out или train < 8
 * @throws Error если solver вырожден или RSS/gain не конечен
 * @remarks Общие nuisance и обе модели подгоняются только на train.
 *   Held-out значения используются лишь после fit для RSS и gain;
 *   центральное предсказание берётся на ближайшем к середине отсчёте.
 */
function evaluateFold(
  data: AnalysisData,
  partition: LocalModulationFoldPartition,
  smoothing: number,
): LocalModulationFold | null {
  const { heldOutIndices, trainIndices } = partition;
  if (heldOutIndices.length === 0 || trainIndices.length < 8) {
    return null;
  }
  const fitted = fitModels(data, trainIndices, smoothing);
  const h0HeldOutRss = residualSumSquares(
    fitted.h0Columns,
    fitted.h0.coefficients,
    data.values,
    heldOutIndices,
  );
  const h1HeldOutRss = residualSumSquares(
    fitted.h1Columns,
    fitted.h1.coefficients,
    data.values,
    heldOutIndices,
  );
  const centerSec = (partition.startSec + partition.endSec) / 2;
  let centerIndex = heldOutIndices[0] ?? 0;
  let centerDistance = Infinity;
  for (const index of heldOutIndices) {
    const distance = Math.abs((data.times[index] ?? 0) - centerSec);
    if (distance < centerDistance) {
      centerDistance = distance;
      centerIndex = index;
    }
  }
  return {
    index: partition.index,
    startSec: partition.startSec,
    endSec: partition.endSec,
    trainSampleCount: trainIndices.length,
    heldOutSampleCount: heldOutIndices.length,
    purgedTrainSampleCount: partition.purgedTrainIndices.length,
    nuisance: fitted.nuisance,
    h0Coefficients: fitted.h0.coefficients,
    h1Coefficients: fitted.h1.coefficients,
    h0TrainRss: fitted.h0.trainRss,
    h1TrainRss: fitted.h1.trainRss,
    h0HeldOutRss,
    h1HeldOutRss,
    heldOutRssGain: residualGain(h0HeldOutRss, h1HeldOutRss),
    h0HeldOutCenterPrediction: predict(
      fitted.h0Columns,
      fitted.h0.coefficients,
      centerIndex,
    ),
    h1HeldOutCenterPrediction: predict(
      fitted.h1Columns,
      fitted.h1.coefficients,
      centerIndex,
    ),
  };
}

/**
 * Сводит только реально оценённые folds в прежнем порядке.
 *
 * @param folds - Непустой либо пустой список завершённых folds
 * @returns Pooled RSS/gain и описательный разброс fold gain
 * @throws Error если pooled RSS или gain не конечен
 * @remarks Pooled gain считается из сумм held-out RSS, а не усредняет
 *   fold gain. Пустой список даёт нулевые метрики; full fit сюда не
 *   входит. Положительным считается gain строго больше 1e-6.
 */
function summarizeFolds(
  folds: LocalModulationFold[],
): LocalModulationSummary {
  const h0PooledHeldOutRss = folds.reduce(
    (sum, fold) => sum + fold.h0HeldOutRss,
    0,
  );
  const h1PooledHeldOutRss = folds.reduce(
    (sum, fold) => sum + fold.h1HeldOutRss,
    0,
  );
  const gains = folds.map((fold) => fold.heldOutRssGain);
  return {
    h0PooledHeldOutRss,
    h1PooledHeldOutRss,
    pooledHeldOutRssGain: residualGain(
      h0PooledHeldOutRss,
      h1PooledHeldOutRss,
    ),
    medianFoldRssGain: median(gains),
    minFoldRssGain: gains.length > 0 ? Math.min(...gains) : 0,
    maxFoldRssGain: gains.length > 0 ? Math.max(...gains) : 0,
    positiveGainFoldCount: gains.filter((gain) => gain > 1e-6).length,
  };
}

/**
 * Сравнивает H0 и H1 внутренним support-safe
 * leave-one-contiguous-block-out (LOCO).
 *
 * @param samples - Исходные отсчёты mono PCM в int16-шкале
 * @param sampleRate - Частота дискретизации, по умолчанию 44100 Гц
 * @param options - Интервал, шаг блоков 20–40 мс и сглаживание
 * @returns Поблочные RSS/gain, коэффициенты и описательные траектории
 * @throws Error если параметры неверны, solver вырожден или RSS
 *   не конечен
 * @remarks H0 использует постоянные C0/S0, а H1 — hat-сплайны со
 *   штрафом вторых разностей. Обе модели делят экспоненциальные D и
 *   sweep-фазу с известными АЧХ и задержкой фильтра. В каждом fold
 *   общие параметры подбираются по H0 только на train; H1 не получает
 *   свою nuisance-оптимизацию. Из train удаляются и scoring-блок, и
 *   все filtered отсчёты, чей фактический raw support его пересекает.
 *   Scoring и полный fit не меняются. Первый и последний блоки всегда
 *   остаются доступными для train, поэтому соседние узлы
 *   интерполируют. Если ни один fold не получает 8 train отсчётов и
 *   непустой held-out, возвращается `insufficient-data`, а не `ok` с
 *   нулевыми метриками. Полный fit использует все отсчёты и не входит
 *   в fold-метрики.
 */
export function screenLocalModulation(
  samples: ArrayLike<number>,
  sampleRate = 44100,
  options: LocalModulationOptions = {},
): LocalModulationResult {
  const prepared = prepareLocalModulation(
    samples,
    sampleRate,
    options,
  );
  const { context, data } = prepared;
  if (data === null) {
    return emptyLocalModulationResult(context, prepared.status);
  }
  const folds: LocalModulationFold[] = [];
  for (const partition of createFoldPartitions(data)) {
    const evaluated = evaluateFold(
      data,
      partition,
      context.options.smoothing,
    );
    if (evaluated !== null) {
      folds.push(evaluated);
    }
  }
  if (folds.length === 0) {
    return emptyLocalModulationResult(
      context,
      'insufficient-data',
      data.knotsSec,
    );
  }
  return {
    ...emptyLocalModulationResult(context, 'ok', data.knotsSec),
    folds,
    summary: summarizeFolds(folds),
    descriptiveFit: descriptiveFit(data, context.options.smoothing),
  };
}
