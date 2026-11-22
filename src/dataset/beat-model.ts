/**
 * Подгонка одиночного затухающего тона и пары. Модель сравнивается
 * на другом временном участке, поэтому вторая частота не
 * засчитывается как биение только из-за подгонки к шуму или свипу.
 */
import { measureCharacter } from '../character-metrics';

/** Результат подгонки и независимой проверки пары. */
export interface DampedBeatFit {
  f0: number;
  singleF1: number;
  singleLambda: number;
  singleCoeff: number[];
  f1: number;
  f2: number;
  lambda: number;
  pairCoeff: number[];
  deltaHz: number;
  depth: number;
  trainGain: number;
  valGain: number;
  singleTrainR2: number;
  pairTrainR2: number;
  singleValR2: number;
  pairValR2: number;
  accepted: boolean;
  rejectionReasons: string[];
}

interface Candidate {
  f1: number;
  f2: number | null;
  lambda: number;
  rss: number;
  coeff: number[];
  valColumns: number[][];
}

interface SearchData {
  trainT: number[];
  trainY: number[];
  valT: number[];
}

interface SearchWindows {
  data: SearchData;
  valY: number[];
}

interface PairEvaluation {
  depth: number;
  trainGain: number;
  valGain: number;
  singleTrainR2: number;
  pairTrainR2: number;
  singleValR2: number;
  pairValR2: number;
  accepted: boolean;
  rejectionReasons: string[];
}

const DECIMATION = 4;
const LOWPASS_SIZE = 64;
const MIN_FREQ_HZ = 25;
const MAX_FREQ_HZ = 250;
const MIN_DELTA_HZ = 1;
const MAX_DELTA_HZ = 8;

/**
 * Подавляет верхние частоты и прореживает исходные отсчёты.
 *
 * @param samples - Отсчёты в int16-шкале
 * @returns Нормированные отсчёты после трёх скользящих средних и
 *   децимации в четыре раза
 * @remarks Каждый проход усредняет окно из 64 отсчётов. После
 *   третьего прохода функция берёт каждый четвёртый отсчёт.
 */
function lowpassDecimate(samples: ArrayLike<number>): number[] {
  let current = Float64Array.from(samples, (value) => value / 32768);
  for (let pass = 0; pass < 3; pass += 1) {
    const filtered = new Float64Array(current.length);
    let sum = 0;
    for (let i = 0; i < current.length; i += 1) {
      sum += current[i] ?? 0;
      if (i >= LOWPASS_SIZE) {
        sum -= current[i - LOWPASS_SIZE] ?? 0;
      }
      filtered[i] = sum / LOWPASS_SIZE;
    }
    current = filtered;
  }
  return Array.from(
    { length: Math.floor(current.length / DECIMATION) },
    (_, index) => current[index * DECIMATION] ?? 0,
  );
}

/**
 * Считает модуль АЧХ трёх скользящих средних на частоте компоненты.
 * Коэффициенты модели относятся к отфильтрованному сигналу, поэтому
 * перед вычитанием из исходного WAV их нужно разделить на это число.
 */
function lowpassAmplitudeGain(
  frequency: number,
  sampleRate: number,
): number {
  const x = (Math.PI * frequency) / sampleRate;
  if (Math.abs(x) < 1e-12) {
    return 1;
  }
  const single = Math.abs(
    Math.sin(LOWPASS_SIZE * x) / (LOWPASS_SIZE * Math.sin(x)),
  );
  return single ** 3;
}

/**
 * Строит косинусный и синусный базис затухающих компонентов.
 *
 * @param frequencies - Частоты компонентов в Гц
 * @param lambda - Общий коэффициент экспоненциального затухания
 * @param times - Время каждого отсчёта в секундах
 * @returns Столбцы в порядке cos/sin для каждой частоты
 */
function basis(
  frequencies: number[],
  lambda: number,
  times: number[],
): number[][] {
  const columns: number[][] = [];
  for (const frequency of frequencies) {
    const cosine: number[] = [];
    const sine: number[] = [];
    for (const time of times) {
      const decay = Math.exp(-lambda * time);
      const phase = 2 * Math.PI * frequency * time;
      cosine.push(decay * Math.cos(phase));
      sine.push(decay * Math.sin(phase));
    }
    columns.push(cosine, sine);
  }
  return columns;
}

/**
 * Подбирает коэффициенты базиса методом наименьших квадратов.
 *
 * @param columns - Столбцы базиса со значениями по отсчётам
 * @param values - Исходный сигнал на тех же отсчётах
 * @returns Коэффициенты для каждого столбца; нули при вырожденной
 *   системе
 * @remarks Складывает нормальную систему, добавляет `1e-8` на
 *   диагональ и решает её с выбором главного элемента.
 */
function solveLeastSquares(
  columns: number[][],
  values: number[],
): number[] {
  const count = columns.length;
  const matrix = Array.from({ length: count }, () =>
    new Array<number>(count + 1).fill(0),
  );
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      let sum = 0;
      for (let i = 0; i < values.length; i += 1) {
        sum += (columns[row]?.[i] ?? 0) * (columns[column]?.[i] ?? 0);
      }
      const target = matrix[row];
      if (target !== undefined) {
        target[column] = sum;
      }
    }
    let right = 0;
    for (let i = 0; i < values.length; i += 1) {
      right += (columns[row]?.[i] ?? 0) * (values[i] ?? 0);
    }
    const target = matrix[row];
    if (target !== undefined) {
      target[count] = right;
    }
  }
  for (let index = 0; index < count; index += 1) {
    const diagonal = matrix[index];
    if (diagonal !== undefined) {
      diagonal[index] = (diagonal[index] ?? 0) + 1e-8;
    }
  }
  for (let column = 0; column < count; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < count; row += 1) {
      if (
        Math.abs(matrix[row]?.[column] ?? 0) >
        Math.abs(matrix[pivot]?.[column] ?? 0)
      ) {
        pivot = row;
      }
    }
    const pivotRow = matrix[pivot];
    const currentRow = matrix[column];
    if (pivotRow !== undefined && currentRow !== undefined) {
      matrix[column] = pivotRow;
      matrix[pivot] = currentRow;
    }
    const divisor = matrix[column]?.[column] ?? 0;
    if (Math.abs(divisor) < 1e-12) {
      return new Array<number>(count).fill(0);
    }
    for (let j = column; j <= count; j += 1) {
      const row = matrix[column];
      if (row !== undefined) {
        row[j] = (row[j] ?? 0) / divisor;
      }
    }
    for (let row = 0; row < count; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = matrix[row]?.[column] ?? 0;
      for (let j = column; j <= count; j += 1) {
        const target = matrix[row];
        if (target !== undefined) {
          target[j] =
            (target[j] ?? 0) - factor * (matrix[column]?.[j] ?? 0);
        }
      }
    }
  }
  return matrix.map((row) => row[count] ?? 0);
}

/**
 * Считает сумму квадратов ошибки кандидата.
 *
 * @param columns - Столбцы базиса кандидата
 * @param coefficients - Коэффициенты этих столбцов
 * @param values - Отсчёты исходного сигнала
 * @returns Сумма квадратов разности сигнала и предсказания
 */
function residualSumSquares(
  columns: number[][],
  coefficients: number[],
  values: number[],
): number {
  let result = 0;
  for (let i = 0; i < values.length; i += 1) {
    let prediction = 0;
    for (let k = 0; k < columns.length; k += 1) {
      prediction += (coefficients[k] ?? 0) * (columns[k]?.[i] ?? 0);
    }
    result += ((values[i] ?? 0) - prediction) ** 2;
  }
  return result;
}

/**
 * Подгоняет один кандидат и готовит его проверочный базис.
 *
 * @param arg - Частоты, затухание и данные обучающего и проверочного
 *   участков
 * @returns Кандидат с коэффициентами и остатком обучения, а также
 *   базисом для проверки
 * @remarks Коэффициенты подбираются только на обучающем участке.
 *   Проверочный базис использует те же частоты и затухание.
 */
function evaluateCandidate(arg: {
  f1: number;
  f2: number | null;
  lambda: number;
  data: SearchData;
}): Candidate {
  const frequencies = arg.f2 === null ? [arg.f1] : [arg.f1, arg.f2];
  const trainColumns = basis(
    frequencies,
    arg.lambda,
    arg.data.trainT,
  );
  const coeff = solveLeastSquares(trainColumns, arg.data.trainY);
  return {
    f1: arg.f1,
    f2: arg.f2,
    lambda: arg.lambda,
    rss: residualSumSquares(trainColumns, coeff, arg.data.trainY),
    coeff,
    valColumns: basis(frequencies, arg.lambda, arg.data.valT),
  };
}

/** Выбирает кандидата с меньшим остатком, не заменяя null на шум. */
function betterCandidate(
  current: Candidate | null,
  candidate: Candidate,
): Candidate {
  return current === null || candidate.rss < current.rss
    ? candidate
    : current;
}

/**
 * Ищет одиночный тон грубой сеткой и локальным уточнением.
 *
 * @param f0 - Начальная оценка основного тона в Гц
 * @param data - Обучающий сигнал и время проверочных отсчётов
 * @returns Кандидат с наименьшим остатком обучения либо `null`, если
 *   кандидатов нет
 * @remarks Сначала перебирает частоту `f0 ± 4 Гц` с шагом 1 Гц и
 *   затухание 0–24 с шагом 1. Затем уточняет оба параметра около
 *   лучшей точки с шагами 0.25 Гц и 0.5.
 */
function fitSingle(f0: number, data: SearchData): Candidate | null {
  let best: Candidate | null = null;
  for (let f1 = f0 - 4; f1 <= f0 + 4; f1 += 1) {
    for (let lambda = 0; lambda <= 24; lambda += 1) {
      best = betterCandidate(
        best,
        evaluateCandidate({ f1, f2: null, lambda, data }),
      );
    }
  }
  if (best === null) {
    return null;
  }
  const centerF1 = best.f1;
  const centerLambda = best.lambda;
  for (let f1 = centerF1 - 1; f1 <= centerF1 + 1; f1 += 0.25) {
    for (
      let lambda = Math.max(0, centerLambda - 1);
      lambda <= centerLambda + 1;
      lambda += 0.5
    ) {
      best = betterCandidate(
        best,
        evaluateCandidate({ f1, f2: null, lambda, data }),
      );
    }
  }
  return best;
}

/**
 * Ищет пару тонов грубой сеткой и локальным уточнением.
 *
 * @param f0 - Начальная оценка основного тона в Гц
 * @param data - Обучающий сигнал и время проверочных отсчётов
 * @returns Пара с наименьшим остатком обучения либо `null`, если ни
 *   одна вторая частота не попала в допустимый диапазон
 * @remarks Перебирает разницу частот 1–8 Гц в обе стороны от первого
 *   тона и оставляет вторую частоту только в диапазоне 25–250 Гц.
 *   Грубая сетка частоты и затухания совпадает с поиском одиночного
 *   тона; затем параметры уточняются около лучшей пары.
 */
function fitPair(f0: number, data: SearchData): Candidate | null {
  let best: Candidate | null = null;
  for (let f1 = f0 - 4; f1 <= f0 + 4; f1 += 1) {
    for (let lambda = 0; lambda <= 24; lambda += 1) {
      for (
        let delta = MIN_DELTA_HZ;
        delta <= MAX_DELTA_HZ;
        delta += 0.5
      ) {
        for (const sign of [-1, 1]) {
          const f2 = f1 + sign * delta;
          if (f2 < MIN_FREQ_HZ || f2 > MAX_FREQ_HZ) {
            continue;
          }
          best = betterCandidate(
            best,
            evaluateCandidate({ f1, f2, lambda, data }),
          );
        }
      }
    }
  }
  if (best === null || best.f2 === null) {
    return null;
  }
  const centerF1 = best.f1;
  const centerF2 = best.f2;
  const centerLambda = best.lambda;
  const sign = Math.sign(centerF2 - centerF1) || 1;
  const centerDelta = Math.abs(centerF2 - centerF1);
  for (let f1 = centerF1 - 1; f1 <= centerF1 + 1; f1 += 0.25) {
    for (
      let delta = Math.max(MIN_DELTA_HZ, centerDelta - 0.5);
      delta <= Math.min(MAX_DELTA_HZ, centerDelta + 0.5);
      delta += 0.1
    ) {
      for (
        let lambda = Math.max(0, centerLambda - 1);
        lambda <= centerLambda + 1;
        lambda += 0.5
      ) {
        const f2 = f1 + sign * delta;
        if (f2 < MIN_FREQ_HZ || f2 > MAX_FREQ_HZ) {
          continue;
        }
        best = betterCandidate(
          best,
          evaluateCandidate({ f1, f2, lambda, data }),
        );
      }
    }
  }
  return best;
}

/**
 * Готовит обучающий и проверочный участки после децимации.
 * Возвращает null, если хотя бы один участок содержит меньше восьми
 * отсчётов.
 */
function prepareSearchWindows(
  decimated: number[],
  decimatedRate: number,
): SearchWindows | null {
  const allTimes = decimated.map((_, index) => index / decimatedRate);
  const trainIndices = allTimes
    .map((time, index) => ({ time, index }))
    .filter(({ time }) => time >= 0.08 && time < 0.18)
    .map(({ index }) => index);
  const valIndices = allTimes
    .map((time, index) => ({ time, index }))
    .filter(({ time }) => time >= 0.18 && time < 0.3)
    .map(({ index }) => index);
  if (trainIndices.length < 8 || valIndices.length < 8) {
    return null;
  }
  return {
    data: {
      trainT: trainIndices.map((index) => allTimes[index] ?? 0),
      trainY: trainIndices.map((index) => decimated[index] ?? 0),
      valT: valIndices.map((index) => allTimes[index] ?? 0),
    },
    valY: valIndices.map((index) => decimated[index] ?? 0),
  };
}

/** Нецентрированный R²; нулевые сигнал и ошибка дают 0, а не 1. */
function uncenteredR2(rss: number, energy: number): number {
  if (energy <= 1e-20 && rss <= 1e-20) {
    return 0;
  }
  return 1 - rss / Math.max(energy, 1e-20);
}

/** Доля снятого остатка; две нулевые ошибки означают отсутствие выигрыша. */
function residualGain(pairRss: number, singleRss: number): number {
  if (singleRss <= 1e-20 && pairRss <= 1e-20) {
    return 0;
  }
  return 1 - pairRss / Math.max(singleRss, 1e-20);
}

/** Сравнивает одиночную модель и пару и применяет зафиксированные пороги. */
function evaluatePair(
  single: Candidate,
  pair: Candidate,
  data: SearchData,
  valY: number[],
): PairEvaluation {
  const singleValRss = residualSumSquares(
    single.valColumns,
    single.coeff,
    valY,
  );
  const pairValRss = residualSumSquares(
    pair.valColumns,
    pair.coeff,
    valY,
  );
  const trainEnergy = data.trainY.reduce(
    (sum, value) => sum + value * value,
    0,
  );
  const valEnergy = valY.reduce(
    (sum, value) => sum + value * value,
    0,
  );
  const singleTrainR2 = uncenteredR2(single.rss, trainEnergy);
  const pairTrainR2 = uncenteredR2(pair.rss, trainEnergy);
  const singleValR2 = uncenteredR2(singleValRss, valEnergy);
  const pairValR2 = uncenteredR2(pairValRss, valEnergy);
  const firstAmplitude = Math.hypot(
    pair.coeff[0] ?? 0,
    pair.coeff[1] ?? 0,
  );
  const secondAmplitude = Math.hypot(
    pair.coeff[2] ?? 0,
    pair.coeff[3] ?? 0,
  );
  const amplitudeSum = firstAmplitude + secondAmplitude;
  const depth =
    amplitudeSum > 0
      ? (2 * Math.min(firstAmplitude, secondAmplitude)) / amplitudeSum
      : 0;
  const trainGain = residualGain(pair.rss, single.rss);
  const valGain = residualGain(pairValRss, singleValRss);
  const rejectionReasons: string[] = [];
  if (depth < 0.05) {
    rejectionReasons.push('depth');
  }
  if (pairTrainR2 < 0.8) {
    rejectionReasons.push('train-r2<0.8');
  }
  if (pairValR2 < 0.5) {
    rejectionReasons.push('validation-r2<0.5');
  }
  if (valGain < 0.5) {
    rejectionReasons.push('validation-gain<0.5');
  }
  if (pairValR2 - singleValR2 < 0.005) {
    rejectionReasons.push('validation-improvement<0.005');
  }
  return {
    depth,
    trainGain,
    valGain,
    singleTrainR2,
    pairTrainR2,
    singleValR2,
    pairValR2,
    accepted: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

/**
 * Оценивает f0 только на обучающих 80–180 мс. Проверочный участок не
 * участвует ни в выборе центра сетки, ни в коэффициентах модели.
 */
export function measureTrainingF0(
  samples: ArrayLike<number>,
  sampleRate: number,
): number | null {
  const trainingEnd = Math.min(
    samples.length,
    Math.round(0.18 * sampleRate),
  );
  const training = Array.from(
    { length: trainingEnd },
    (_, index) => samples[index] ?? 0,
  );
  return measureCharacter(training, sampleRate).bodyF0Hz;
}

/**
 * Подбирает пару и проверяет её на независимом участке.
 *
 * @param samples - Сэмплы в int16-шкале
 * @param f0 - Оценка основного тона в Гц
 * @param sampleRate - Частота дискретизации в Гц; по умолчанию 44100
 * @returns Модель, метрики и причины отклонения; `null`, если на
 *   участках меньше восьми отсчётов или пару не удалось подобрать.
 *   `lambda` измеряется в с⁻¹. Коэффициенты идут в порядке cos/sin
 *   для каждой частоты и относятся к сигналу, нормированному на 32768.
 * @throws Error если `f0` или `sampleRate` не конечны либо не
 *   положительны
 * @remarks Обучение идёт на 80–180 мс, проверка — на 180–300 мс.
 *   Коэффициенты на проверочном участке не переподгоняются. R²
 *   нецентрирован: `1 - RSS / Σy²`. Нулевые сигнал и остаток дают
 *   R²=0; при нулевой энергии и ненулевом остатке R² отрицателен.
 *   `trainGain` и `valGain` равны `1 - RSS_pair / RSS_single`.
 *   Для амплитуд компонент A₁ и A₂ глубина огибающей равна
 *   `(max−min)/max = 2·min(A₁,A₂)/(A₁+A₂)`. Кандидат принимается при
 *   `pairTrainR2 ≥ 0.8`, `pairValR2 ≥ 0.5`, `valGain ≥ 0.5`,
 *   приросте проверочного R² не менее 0.005 и глубине не менее 0.05.
 */
export function fitDampedBeat(
  samples: ArrayLike<number>,
  f0: number,
  sampleRate = 44100,
): DampedBeatFit | null {
  if (!Number.isFinite(f0) || f0 <= 0) {
    throw new Error('f0 должен быть положительным');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate должен быть положительным');
  }
  const decimated = lowpassDecimate(samples);
  const windows = prepareSearchWindows(
    decimated,
    sampleRate / DECIMATION,
  );
  if (windows === null) {
    return null;
  }
  const { data, valY } = windows;
  const single = fitSingle(f0, data);
  const pair = fitPair(f0, data);
  if (single === null || pair === null || pair.f2 === null) {
    return null;
  }
  const evaluation = evaluatePair(single, pair, data, valY);
  return {
    f0,
    singleF1: single.f1,
    singleLambda: single.lambda,
    singleCoeff: single.coeff,
    f1: pair.f1,
    f2: pair.f2,
    lambda: pair.lambda,
    pairCoeff: pair.coeff,
    deltaHz: Math.abs(pair.f2 - pair.f1),
    ...evaluation,
  };
}

/**
 * Удаляет выбранную компоненту пары и оставляет остаток сигнала.
 * Это вмешательство не добавляет новых колебаний.
 *
 * @param samples - Исходные сэмплы в int16-шкале
 * @param fit - Результат {@link fitDampedBeat}
 * @param component - Удаляемая компонента; по умолчанию вторая
 * @param sampleRate - Частота дискретизации в Гц; по умолчанию 44100
 * @returns Неокруглённые сэмплы `Float64Array` в int16-шкале без
 *   выбранной компоненты; значения не ограничены диапазоном int16
 * @throws Error если `sampleRate` не конечен или не положителен
 *   либо АЧХ фильтра на частоте компоненты даёт gain < 1e-9
 * @remarks При вычитании базис сдвигается на
 *   `3 * (64 - 1) / (2 * sampleRate)` секунды. Это компенсирует
 *   групповую задержку трёх скользящих средних в `lowpassDecimate`.
 *   Коэффициенты дополнительно делятся на модуль АЧХ фильтра на
 *   частоте удаляемой компоненты, иначе из исходного WAV вычиталась
 *   бы только ослабленная фильтром часть тона.
 */
export function removeFittedComponent(
  samples: ArrayLike<number>,
  fit: DampedBeatFit,
  component: 'first' | 'second' = 'second',
  sampleRate = 44100,
): Float64Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate должен быть положительным');
  }
  const groupDelaySec = (3 * (LOWPASS_SIZE - 1)) / (2 * sampleRate);
  const times = Array.from(
    { length: samples.length },
    (_, index) => index / sampleRate + groupDelaySec,
  );
  const frequency = component === 'first' ? fit.f1 : fit.f2;
  const gain = lowpassAmplitudeGain(frequency, sampleRate);
  if (gain < 1e-9) {
    throw new Error('АЧХ фильтра подавляет компоненту не обратимо');
  }
  const scale = 32768 / gain;
  const columns = basis([fit.f1, fit.f2], fit.lambda, times);
  const offset = component === 'first' ? 0 : 2;
  return Float64Array.from(
    samples,
    (value, index) =>
      value -
      (fit.pairCoeff[offset] ?? 0) *
        scale *
        (columns[offset]?.[index] ?? 0) -
      (fit.pairCoeff[offset + 1] ?? 0) *
        scale *
        (columns[offset + 1]?.[index] ?? 0),
  );
}
