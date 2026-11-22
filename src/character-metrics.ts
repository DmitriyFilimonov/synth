/**
 * Измерители характера итогового WAV для Q4. Они не решают, какая
 * бочка лучше: сохраняют наблюдаемые f0 тела и спад, чтобы позже
 * сравнить их с допусками по разбросу сидов.
 */
/** Тело, по которому нормированная автокорреляция оценивает f0. */
const BODY_START_SEC = 0.08;
const BODY_END_SEC = 0.2;
const BODY_MIN_FREQ_HZ = 30;
const BODY_MAX_FREQ_HZ = 250;

/** Скользящие RMS-окна и устойчивость пересечения −20 дБ. */
const DECAY_WINDOW_SEC = 0.02;
const DECAY_HOP_SEC = 0.005;
const DECAY_QUIET_PROBES = 2;
const DECAY_AMPLITUDE_RATIO = 0.1;

/** Наблюдаемые признаки одного WAV. */
export interface CharacterMetrics {
  /** Общий период тела по автокорреляции; null, если его нет. */
  bodyF0Hz: number | null;
  /** Корреляция выбранного периода, 0..1; null вместе с f0. */
  bodyF0Correlation: number | null;
  /** Время от пиковой RMS-пробы до спада до 10% амплитуды. */
  decayDb20Sec: number | null;
  /** Середина пикового 20-мс RMS-окна; null для тишины. */
  decayPeakTimeSec: number | null;
}

/** Разница характера кандидата против эталона. */
export interface CharacterDelta {
  /** Положительное значение означает более высокий f0 кандидата. */
  bodyF0DeltaCents: number | null;
  /** Положительное значение означает более долгий спад кандидата. */
  decayDb20DeltaSec: number | null;
}

/**
 * Находит общий период тела нормированной автокорреляцией.
 *
 * @param samples - Отсчёты сигнала
 * @param sampleRate - Частота дискретизации в Гц
 * @returns Частота и корреляция выбранного периода; оба поля равны
 *   `null`, если тело слишком короткое или нет пика с корреляцией
 *   не ниже 0.2
 * @remarks Анализирует 80–200 мс после вычитания среднего. Для
 *   диапазона 30–250 Гц считает корреляцию ещё на одном lag за каждой
 *   границей, чтобы краевой пик имел соседей для проверки и
 *   интерполяции. Лучший пик и кандидатов выбирает только внутри
 *   диапазона. Среди локальных пиков берёт самый короткий период, чья
 *   корреляция отстаёт от лучшей не более чем на 0.02: так чистые
 *   100 Гц не превращаются в 50 Гц, а слабый фундаментал не теряется
 *   среди гармоник. Позицию пика уточняет параболической
 *   интерполяцией.
 */
function measureBodyFundamental(
  samples: ArrayLike<number>,
  sampleRate: number,
): { frequencyHz: number | null; correlation: number | null } {
  const start = Math.round(BODY_START_SEC * sampleRate);
  const end = Math.min(
    samples.length,
    Math.round(BODY_END_SEC * sampleRate),
  );
  const length = end - start;
  const minLag = Math.floor(sampleRate / BODY_MAX_FREQ_HZ);
  const maxLag = Math.ceil(sampleRate / BODY_MIN_FREQ_HZ);
  const scanMinLag = Math.max(1, minLag - 1);
  const scanMaxLag = maxLag + 1;
  if (length <= minLag + 2 || length <= 0) {
    return { frequencyHz: null, correlation: null };
  }
  const body = new Float64Array(length);
  let mean = 0;
  for (let i = 0; i < length; i += 1) {
    body[i] = samples[start + i] ?? 0;
    mean += body[i] ?? 0;
  }
  mean /= length;
  for (let i = 0; i < length; i += 1) {
    body[i] = (body[i] ?? 0) - mean;
  }

  const correlations: number[] = [];
  for (let lag = scanMinLag; lag <= scanMaxLag; lag += 1) {
    let products = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let i = 0; i + lag < length; i += 1) {
      const left = body[i] ?? 0;
      const right = body[i + lag] ?? 0;
      products += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const denominator = Math.sqrt(leftEnergy * rightEnergy);
    correlations.push(denominator > 0 ? products / denominator : 0);
  }

  const isPeak = (index: number): boolean =>
    index > 0 &&
    index + 1 < correlations.length &&
    (correlations[index] ?? -Infinity) >=
      (correlations[index - 1] ?? -Infinity) &&
    (correlations[index] ?? -Infinity) >=
      (correlations[index + 1] ?? -Infinity);
  const isAllowed = (index: number): boolean => {
    const lag = index + scanMinLag;
    return lag >= minLag && lag <= maxLag;
  };
  let best = -Infinity;
  for (let index = 0; index < correlations.length; index += 1) {
    if (isAllowed(index) && isPeak(index)) {
      best = Math.max(best, correlations[index] ?? -Infinity);
    }
  }
  if (!Number.isFinite(best) || best < 0.2) {
    return { frequencyHz: null, correlation: null };
  }
  let chosen = -1;
  for (let index = 0; index < correlations.length; index += 1) {
    if (
      isAllowed(index) &&
      isPeak(index) &&
      (correlations[index] ?? -1) >= best - 0.02
    ) {
      chosen = index;
      break;
    }
  }
  if (chosen < 0) {
    return { frequencyHz: null, correlation: null };
  }
  const left = correlations[chosen - 1] ?? 0;
  const center = correlations[chosen] ?? 0;
  const right = correlations[chosen + 1] ?? 0;
  const denominator = left - 2 * center + right;
  const rawShift =
    denominator !== 0 ? (0.5 * (left - right)) / denominator : 0;
  const shift = Math.max(-0.5, Math.min(0.5, rawShift));
  return {
    frequencyHz: sampleRate / (chosen + scanMinLag + shift),
    correlation: center,
  };
}

/**
 * Считает RMS полных скользящих окон 20 мс с шагом 5 мс.
 *
 * @param samples - Отсчёты сигнала
 * @param sampleRate - Частота дискретизации в Гц
 * @returns RMS окон, шаг и длину окна в отсчётах; если сигнал короче
 *   одного окна, возвращает пустой список RMS
 */
function measureDecayProbes(
  samples: ArrayLike<number>,
  sampleRate: number,
): { rms: number[]; hopSize: number; windowSize: number } {
  const windowSize = Math.max(
    1,
    Math.round(DECAY_WINDOW_SEC * sampleRate),
  );
  const hopSize = Math.max(1, Math.round(DECAY_HOP_SEC * sampleRate));
  const count =
    samples.length >= windowSize
      ? Math.floor((samples.length - windowSize) / hopSize) + 1
      : 0;
  const rms: number[] = [];
  for (let window = 0; window < count; window += 1) {
    let sum = 0;
    const start = window * hopSize;
    for (let i = 0; i < windowSize; i += 1) {
      const value = samples[start + i] ?? 0;
      sum += value * value;
    }
    rms.push(Math.sqrt(sum / windowSize));
  }
  return { rms, hopSize, windowSize };
}

/**
 * Измеряет спад от пикового RMS-окна до 10% его уровня.
 *
 * @param samples - Отсчёты сигнала
 * @param sampleRate - Частота дискретизации в Гц
 * @returns Длительность спада и середину пикового окна в секундах;
 *   для тишины оба поля равны `null`, а без устойчивого пересечения
 *   порога `null` получает только `decaySec`
 * @remarks Две соседние пробы должны остаться не выше порога, чтобы
 *   один провал не заканчивал спад раньше времени. Точку пересечения
 *   линейно интерполирует между центрами окон, разнесённых на 5 мс.
 */
function measureDecayDb20(
  samples: ArrayLike<number>,
  sampleRate: number,
): { decaySec: number | null; peakTimeSec: number | null } {
  const { rms, hopSize, windowSize } = measureDecayProbes(
    samples,
    sampleRate,
  );
  let peakIndex = -1;
  let peak = 0;
  rms.forEach((value, index) => {
    if (value > peak) {
      peak = value;
      peakIndex = index;
    }
  });
  if (peakIndex < 0 || peak <= 0) {
    return { decaySec: null, peakTimeSec: null };
  }
  const peakTimeSec =
    (peakIndex * hopSize + windowSize / 2) / sampleRate;
  const threshold = peak * DECAY_AMPLITUDE_RATIO;
  for (
    let index = peakIndex + 1;
    index + DECAY_QUIET_PROBES <= rms.length;
    index += 1
  ) {
    let staysQuiet = true;
    for (let offset = 0; offset < DECAY_QUIET_PROBES; offset += 1) {
      if ((rms[index + offset] ?? Infinity) > threshold) {
        staysQuiet = false;
        break;
      }
    }
    if (!staysQuiet) {
      continue;
    }
    const previous = rms[index - 1] ?? peak;
    const current = rms[index] ?? 0;
    const fraction =
      previous > current
        ? Math.min(
            1,
            Math.max(
              0,
              (previous - threshold) / (previous - current),
            ),
          )
        : 0;
    const crossingTimeSec =
      ((index - 1 + fraction) * hopSize + windowSize / 2) /
      sampleRate;
    return {
      decaySec: Math.max(0, crossingTimeSec - peakTimeSec),
      peakTimeSec,
    };
  }
  return { decaySec: null, peakTimeSec };
}

/**
 * Измеряет f0 тела и спад WAV без изменения входных сэмплов.
 *
 * @param samples - Отсчёты сигнала в любой общей амплитудной шкале
 * @param sampleRate - Частота дискретизации в Гц
 * @returns Наблюдаемые признаки; неизмеримые значения равны null
 * @throws Error если sampleRate не конечен или не положителен
 * @remarks F0 ищет общий период 30–250 Гц на 80–200 мс
 *   нормированной автокорреляцией и отклоняет корреляцию ниже 0.2.
 *   Спад использует скользящие
 *   RMS-окна 20 мс с шагом 5 мс, поэтому не измеряет отдельный щелчок
 *   короче окна.
 */
export function measureCharacter(
  samples: ArrayLike<number>,
  sampleRate: number,
): CharacterMetrics {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate должен быть положительным');
  }
  const fundamental = measureBodyFundamental(samples, sampleRate);
  const decay = measureDecayDb20(samples, sampleRate);
  return {
    bodyF0Hz: fundamental.frequencyHz,
    bodyF0Correlation: fundamental.correlation,
    decayDb20Sec: decay.decaySec,
    decayPeakTimeSec: decay.peakTimeSec,
  };
}

/**
 * Сравнивает f0 и спад двух WAV в одних физических единицах.
 *
 * @param reference - Эталонный сигнал
 * @param candidate - Проверяемый сигнал
 * @param sampleRate - Общая частота дискретизации в Гц
 * @returns Разница f0 в центах и спада в секундах; `null`, если хотя
 *   бы один сигнал не дал соответствующего измерения
 * @throws Error если `sampleRate` не конечен или не положителен
 * @remarks Положительная разница означает более высокий f0 или более
 *   долгий спад кандидата.
 */
export function compareCharacter(
  reference: ArrayLike<number>,
  candidate: ArrayLike<number>,
  sampleRate: number,
): CharacterDelta {
  const before = measureCharacter(reference, sampleRate);
  const after = measureCharacter(candidate, sampleRate);
  return {
    bodyF0DeltaCents:
      before.bodyF0Hz !== null &&
      before.bodyF0Hz > 0 &&
      after.bodyF0Hz !== null &&
      after.bodyF0Hz > 0
        ? 1200 * Math.log2(after.bodyF0Hz / before.bodyF0Hz)
        : null,
    decayDb20DeltaSec:
      before.decayDb20Sec !== null && after.decayDb20Sec !== null
        ? after.decayDb20Sec - before.decayDb20Sec
        : null,
  };
}
