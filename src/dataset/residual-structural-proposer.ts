/**
 * Residual-driven proposer для native structural beam.
 *
 * Модуль сам выполняет и измеряет subtraction, Hann/FFT, выбор пиков,
 * построение полных форм и leave-one-out slot ranking. Он не использует
 * `buildPursuitDictionary`: его localEvaluations не описывают всю работу.
 * Единица W равна одному посещённому отсчёту, FFT-bit/reversal/butterfly,
 * спектральному бину, shape-попытке или slot-сравнению. Dense-операций и
 * wall clock здесь нет. Модуль работает только с synthetic known-answer
 * входами и не подключается к production match/enhance/API.
 */
import { SAMPLE_RATE } from '../consts';
import {
  ampEnvConfigNormales,
  MAX_OSCILLATORS,
  oscConfigNormales,
  type PhaseModel,
} from '../synth';
import type {
  NativeStructuralParent,
  NativeStructuralProposal,
  NativeStructuralProposerSession,
} from './native-structural-beam';
import { clonePatch, renderForTarget } from './quadrature-refit';
import {
  structuralAtomShapeKey,
  type StructuralAtomShape,
} from './structural-atom';

/** Явное полуоткрытое окно анализа в отсчётах исходного PCM. */
export interface ResidualStructuralWindow {
  name: string;
  start: number;
  end: number;
}

/** Полуоткрытая полезная зона; пустая зона имеет `start === end`. */
export interface ResidualStructuralUsefulZone {
  start: number;
  end: number;
}

/** Независимые нелинейные поля, которые proposer добавляет к частоте пика. */
export interface ResidualStructuralShapeVariant {
  /** Множитель частоты пика для независимого `freqStart`. */
  freqStartRatio: number;
  oscDuration: number;
  oscSlope: number;
  ampDuration: number;
  ampEndLevel: number;
  ampSlope: number;
  /** Onset относительно начала окна, а не общий onset всей группы. */
  delaySamples: number;
  attackSamples: number;
  hardStop: boolean;
}

/**
 * Вход фабрики независимых proposer sessions.
 *
 * Без `usefulZone` каждый вызов находит первый и последний ненулевой
 * target-отсчёт одним измеренным проходом. Без `windows` строятся attack
 * 20 мс, early 100 мс и full внутри полезной зоны. Явные окна могут быть
 * невыровнены по степени двойки; последний участок дополняется нулями.
 * Статические injected candidates не ограничиваются `maxGroupSize`: общий
 * native scheduler сам применяет свой предел группы.
 */
export interface ResidualStructuralProposerOptions {
  /** Ненулевой target PCM в единицах Int16; массив копируется на session. */
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  usefulZone?: ResidualStructuralUsefulZone;
  windows?: readonly ResidualStructuralWindow[];
  minFrequency?: number;
  maxFrequency?: number;
  maxPeaksPerWindow?: number;
  /** Доля максимального magnitude в окне; ноль оставляет все локальные пики. */
  relativePeakThreshold?: number;
  shapeVariants?: readonly ResidualStructuralShapeVariant[];
  /** Предел только автоматических групп, от 1 до 50 без скрытого K1/K2. */
  maxGroupSize?: number;
  /** Число слабых active slots после off/append; ноль отключает LOO-рендеры. */
  weakActiveSlotCount?: number;
  /** Полные known-answer proposals; дубли, gaps и slot >= 50 отклоняются. */
  injectedCandidates?: readonly NativeStructuralProposal[];
}

/** Фактические операции одной или нескольких expansions по категориям. */
export interface ResidualStructuralWorkBreakdown {
  /** Target−quantized parent PCM в Float64. */
  residual: number;
  /** Полезная зона, Hann и нулевое дополнение окон. */
  window: number;
  /** Bit reversal, output writes и radix-2 butterflies. */
  fft: number;
  /** Magnitudes, local maxima, shortlist comparisons и interpolation. */
  peaks: number;
  /** Попытки полных shape и stable shape keys, включая отклонённые формы. */
  shapes: number;
  /** Canonical LOO renders/metrics, ranking и проверка слотов proposals. */
  slots: number;
  /** Сумма шести категорий выше. */
  total: number;
}

/** Независимый снимок session; кэша и общего бюджета между sessions нет. */
export interface ResidualStructuralProposerSnapshot {
  calls: number;
  cost: number;
  categories: ResidualStructuralWorkBreakdown;
}

/** Измеренный native expansion без legacy array в возвращаемом типе. */
export interface ResidualStructuralProposeResult {
  candidates: readonly NativeStructuralProposal[];
  cost: number;
}

/** Native session с явным накопительным ledger пропозера. */
export interface ResidualStructuralProposerSession extends NativeStructuralProposerSession {
  /**
   * Строит candidates из residual parent и учитывает фактическую работу.
   *
   * @param parent - Canonical native-состояние текущего узла
   * @returns Дедуплицированные proposals и фактический cost в единицах W
   * @throws Error если parent несовместим с target, injected proposal
   *   невалиден, счётчик работы переполняется или cost превышает estimate
   * @remarks Повторный вызов заново выполняет анализ и увеличивает ledger.
   */
  propose: (
    parent: NativeStructuralParent,
  ) => ResidualStructuralProposeResult;
  /**
   * Оценивает сверху работу expansion без PCM/FFT-анализа.
   *
   * @param parent - Canonical native-состояние текущего узла
   * @returns Консервативный верхний предел expansion cost в единицах W
   * @throws Error если parent несовместим с target или работа выходит
   *   за диапазон safe integer
   * @remarks Не меняет накопленный ledger session.
   */
  estimateExpansion: (parent: NativeStructuralParent) => number;
  /**
   * Возвращает независимый снимок накопленной работы session.
   *
   * @returns Число вызовов, суммарный cost и разложение по категориям
   */
  snapshot: () => ResidualStructuralProposerSnapshot;
}

/**
 * Factory можно передать прямо в native `createProposerSession`.
 *
 * @returns Новую независимую measured proposer session
 */
export type ResidualStructuralProposerFactory =
  () => ResidualStructuralProposerSession;

type WorkCategory = Exclude<
  keyof ResidualStructuralWorkBreakdown,
  'total'
>;

interface NormalizedOptions {
  target: Int16Array;
  sampleRate: number;
  phaseModel: PhaseModel;
  usefulZone: ResidualStructuralUsefulZone | null;
  windows: readonly ResidualStructuralWindow[] | null;
  minFrequency: number;
  maxFrequency: number;
  maxPeaksPerWindow: number;
  relativePeakThreshold: number;
  shapeVariants: readonly ResidualStructuralShapeVariant[];
  maxGroupSize: number;
  weakActiveSlotCount: number;
  injectedCandidates: readonly NativeStructuralProposal[];
}

interface PreparedWindow extends ResidualStructuralWindow {
  fftSize: number;
  levels: number;
}

interface Spectrum {
  real: Float64Array;
  imag: Float64Array;
}

interface ResidualPeak {
  bin: number;
  frequency: number;
  magnitude: number;
}

interface WindowPeaks {
  window: PreparedWindow;
  peaks: ResidualPeak[];
}

interface ActiveSlotLoss {
  slot: number;
  loss: number;
}

const TWO_PI = 2 * Math.PI;
const MAX_FFT_SIZE = 2 ** 30;

/** Три полных варианта; группа назначает их членам по рангу пика. */
export const DEFAULT_RESIDUAL_STRUCTURAL_SHAPE_VARIANTS: readonly ResidualStructuralShapeVariant[] =
  [
    {
      freqStartRatio: 1,
      oscDuration: 0.018,
      oscSlope: 0.8,
      ampDuration: 0.04,
      ampEndLevel: 0.02,
      ampSlope: 1.1,
      delaySamples: 0,
      attackSamples: 0,
      hardStop: true,
    },
    {
      freqStartRatio: 1.08,
      oscDuration: 0.011,
      oscSlope: 1.25,
      ampDuration: 0.085,
      ampEndLevel: 0.008,
      ampSlope: 0.65,
      delaySamples: 3,
      attackSamples: 2,
      hardStop: true,
    },
    {
      freqStartRatio: 1,
      oscDuration: 0.029,
      oscSlope: 0.55,
      ampDuration: 0.16,
      ampEndLevel: 0.04,
      ampSlope: 1.55,
      delaySamples: 11,
      attackSamples: 5,
      hardStop: false,
    },
  ];

/** Создаёт пустой ledger без модульного состояния. */
function emptyWork(): ResidualStructuralWorkBreakdown {
  return {
    residual: 0,
    window: 0,
    fft: 0,
    peaks: 0,
    shapes: 0,
    slots: 0,
    total: 0,
  };
}

/** Добавляет конечное целое число измеренных операций и следит за overflow. */
function addWork(
  work: ResidualStructuralWorkBreakdown,
  category: WorkCategory,
  count = 1,
): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Invalid residual proposer work increment');
  }
  const categoryTotal = work[category] + count;
  const total = work.total + count;
  if (
    !Number.isSafeInteger(categoryTotal) ||
    !Number.isSafeInteger(total)
  ) {
    throw new Error('Residual proposer work overflow');
  }
  work[category] = categoryTotal;
  work.total = total;
}

/** Проверяет целый параметр конфигурации. */
function assertInteger(
  value: number,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be a safe integer within ${minimum}..${maximum}`,
    );
  }
}

/** Проверяет значение против опубликованной нормы синтезатора. */
function assertRange(
  label: string,
  value: number,
  range: { min: number; max: number },
): void {
  if (
    !Number.isFinite(value) ||
    value < range.min ||
    value > range.max
  ) {
    throw new Error(
      `${label} must be finite and within ${range.min}..${range.max}`,
    );
  }
}

/** Копирует и проверяет один полный shape variant. */
function normalizeVariant(
  variant: ResidualStructuralShapeVariant,
): ResidualStructuralShapeVariant {
  if (
    !Number.isFinite(variant.freqStartRatio) ||
    variant.freqStartRatio <= 0
  ) {
    throw new Error('freqStartRatio must be finite and positive');
  }
  assertRange(
    'variant oscDuration',
    variant.oscDuration,
    oscConfigNormales.duration,
  );
  assertRange(
    'variant oscSlope',
    variant.oscSlope,
    oscConfigNormales.slope,
  );
  assertRange(
    'variant ampDuration',
    variant.ampDuration,
    ampEnvConfigNormales.duration,
  );
  assertRange(
    'variant ampEndLevel',
    variant.ampEndLevel,
    ampEnvConfigNormales.endLevel,
  );
  assertRange(
    'variant ampSlope',
    variant.ampSlope,
    ampEnvConfigNormales.slope,
  );
  assertInteger(
    variant.delaySamples,
    'variant delaySamples',
    0,
    Math.floor(oscConfigNormales.delay.max * SAMPLE_RATE),
  );
  assertInteger(
    variant.attackSamples,
    'variant attackSamples',
    0,
    Math.floor(ampEnvConfigNormales.attack.max * SAMPLE_RATE),
  );
  if (typeof variant.hardStop !== 'boolean') {
    throw new Error('variant hardStop must be boolean');
  }
  return { ...variant };
}

/** Копирует target и статические proposals, исключая внешние мутации. */
function normalizeOptions(
  options: ResidualStructuralProposerOptions,
): NormalizedOptions {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error(`sample rate ${sampleRate} != ${SAMPLE_RATE}`);
  }
  const phaseModel = options.phaseModel ?? 'legacy';
  if (phaseModel !== 'legacy' && phaseModel !== 'integral') {
    throw new Error('Invalid residual proposer phase model');
  }
  const targetValues = Array.from(options.target);
  if (targetValues.length === 0) {
    throw new Error('Residual proposer target must not be empty');
  }
  for (const value of targetValues) {
    if (
      !Number.isSafeInteger(value) ||
      value < -32768 ||
      value > 32767
    ) {
      throw new Error(
        'Residual proposer target must contain Int16 PCM',
      );
    }
  }
  const sampleCount = targetValues.length;
  const usefulZone = options.usefulZone;
  if (usefulZone !== undefined) {
    assertInteger(
      usefulZone.start,
      'usefulZone.start',
      0,
      sampleCount,
    );
    assertInteger(usefulZone.end, 'usefulZone.end', 0, sampleCount);
    if (usefulZone.end < usefulZone.start) {
      throw new Error('usefulZone.end must not precede start');
    }
  }
  const windows = options.windows;
  if (windows !== undefined) {
    for (const window of windows) {
      if (
        typeof window.name !== 'string' ||
        window.name.length === 0
      ) {
        throw new Error('Residual window name must be non-empty');
      }
      assertInteger(window.start, 'window.start', 0, sampleCount - 1);
      assertInteger(window.end, 'window.end', 1, sampleCount);
      if (window.end <= window.start) {
        throw new Error('Residual window end must follow start');
      }
    }
  }
  const minFrequency = options.minFrequency ?? 20;
  const maxFrequency = options.maxFrequency ?? 16000;
  assertRange('minFrequency', minFrequency, {
    min: 20,
    max: 16000,
  });
  assertRange('maxFrequency', maxFrequency, {
    min: 20,
    max: 16000,
  });
  if (maxFrequency < minFrequency) {
    throw new Error('maxFrequency must not be below minFrequency');
  }
  const maxPeaksPerWindow = options.maxPeaksPerWindow ?? 6;
  assertInteger(
    maxPeaksPerWindow,
    'maxPeaksPerWindow',
    1,
    MAX_OSCILLATORS,
  );
  const relativePeakThreshold = options.relativePeakThreshold ?? 0.01;
  assertRange('relativePeakThreshold', relativePeakThreshold, {
    min: 0,
    max: 1,
  });
  const maxGroupSize = options.maxGroupSize ?? MAX_OSCILLATORS;
  assertInteger(maxGroupSize, 'maxGroupSize', 1, MAX_OSCILLATORS);
  const weakActiveSlotCount = options.weakActiveSlotCount ?? 2;
  assertInteger(
    weakActiveSlotCount,
    'weakActiveSlotCount',
    0,
    MAX_OSCILLATORS,
  );
  const shapeVariants = (
    options.shapeVariants ??
    DEFAULT_RESIDUAL_STRUCTURAL_SHAPE_VARIANTS
  ).map(normalizeVariant);
  return {
    target: Int16Array.from(targetValues),
    sampleRate,
    phaseModel,
    usefulZone: usefulZone === undefined ? null : { ...usefulZone },
    windows:
      windows === undefined
        ? null
        : windows.map((window) => ({ ...window })),
    minFrequency,
    maxFrequency,
    maxPeaksPerWindow,
    relativePeakThreshold,
    shapeVariants,
    maxGroupSize,
    weakActiveSlotCount,
    injectedCandidates: (options.injectedCandidates ?? []).map(
      (proposal) => ({
        slots: [...proposal.slots],
        shapes: proposal.shapes.map((shape) => ({ ...shape })),
      }),
    ),
  };
}

/** Проверяет совместимость parent до residual subtraction или estimator. */
function assertParent(
  parent: NativeStructuralParent,
  options: NormalizedOptions,
): void {
  if (parent.samples.length !== options.target.length) {
    throw new Error('Residual parent PCM length must match target');
  }
  if (parent.patch.oscillators.length > MAX_OSCILLATORS) {
    throw new Error(`Maximum ${MAX_OSCILLATORS} oscillators allowed`);
  }
}

/** Находит nonzero useful zone одним фактически учтённым проходом target. */
function measureUsefulZone(
  options: NormalizedOptions,
  work: ResidualStructuralWorkBreakdown,
): ResidualStructuralUsefulZone {
  let start = options.target.length;
  let end = 0;
  for (let index = 0; index < options.target.length; index += 1) {
    addWork(work, 'window');
    if ((options.target[index] ?? 0) !== 0) {
      start = Math.min(start, index);
      end = index + 1;
    }
  }
  return start === options.target.length
    ? { start: 0, end: 0 }
    : { start, end };
}

/** Возвращает меньшую степень двойки, которая покрывает всё окно. */
function fftSizeFor(length: number): {
  fftSize: number;
  levels: number;
} {
  let fftSize = 1;
  let levels = 0;
  while (fftSize < length) {
    fftSize *= 2;
    levels += 1;
    if (fftSize > MAX_FFT_SIZE) {
      throw new Error('Residual proposer FFT is too large');
    }
  }
  return { fftSize, levels };
}

/** Строит attack/early/full либо копирует явные окна без выравнивания. */
function prepareWindows(
  options: NormalizedOptions,
  zone: ResidualStructuralUsefulZone,
): PreparedWindow[] {
  let windows: ResidualStructuralWindow[];
  if (options.windows !== null) {
    windows = options.windows.map((window) => ({ ...window }));
  } else if (zone.start === zone.end) {
    windows = [];
  } else {
    const attackEnd = Math.min(
      zone.end,
      zone.start + Math.max(1, Math.round(0.02 * options.sampleRate)),
    );
    const earlyEnd = Math.min(
      zone.end,
      zone.start + Math.max(1, Math.round(0.1 * options.sampleRate)),
    );
    windows = [
      { name: 'attack', start: zone.start, end: attackEnd },
      { name: 'early', start: zone.start, end: earlyEnd },
      { name: 'full', start: zone.start, end: zone.end },
    ];
  }
  const seen = new Set<string>();
  const prepared: PreparedWindow[] = [];
  for (const window of windows) {
    const key = JSON.stringify([window.start, window.end]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const size = fftSizeFor(window.end - window.start);
    prepared.push({ ...window, ...size });
  }
  return prepared;
}

/** Вычитает quantized parent.samples, не читая и не смешивая rawSum. */
function subtractResidual(
  parent: NativeStructuralParent,
  options: NormalizedOptions,
  work: ResidualStructuralWorkBreakdown,
): { residual: Float64Array; residualSquares: number } {
  const residual = new Float64Array(options.target.length);
  let residualSquares = 0;
  for (let index = 0; index < options.target.length; index += 1) {
    const value =
      (options.target[index] ?? 0) - (parent.samples[index] ?? 0);
    residual[index] = value;
    residualSquares += value * value;
    addWork(work, 'residual');
  }
  return { residual, residualSquares };
}

/** Применяет Hann к полному окну и заполняет последний fold нулями. */
function windowResidual(
  residual: Float64Array,
  window: PreparedWindow,
  work: ResidualStructuralWorkBreakdown,
): Spectrum {
  const real = new Float64Array(window.fftSize);
  const imag = new Float64Array(window.fftSize);
  const length = window.end - window.start;
  for (let index = 0; index < window.fftSize; index += 1) {
    if (index < length) {
      const weight =
        length <= 1
          ? 1
          : 0.5 -
            0.5 *
              Math.cos((TWO_PI * index) / Math.max(1, length - 1));
      real[index] = (residual[window.start + index] ?? 0) * weight;
    }
    addWork(work, 'window');
  }
  return { real, imag };
}

/** Выполняет собственный radix-2 FFT и считает каждый reversal и butterfly. */
function forwardFft(
  input: Spectrum,
  work: ResidualStructuralWorkBreakdown,
): Spectrum {
  const size = input.real.length;
  const levels = Math.round(Math.log2(size));
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    let source = index;
    let reversed = 0;
    for (let bit = 0; bit < levels; bit += 1) {
      reversed = (reversed << 1) | (source & 1);
      source >>= 1;
      addWork(work, 'fft');
    }
    real[reversed] = input.real[index] ?? 0;
    imag[reversed] = input.imag[index] ?? 0;
    addWork(work, 'fft');
  }

  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2;
    const angle = -TWO_PI / width;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let block = 0; block < size; block += width) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const even = block + offset;
        const odd = even + half;
        const evenReal = real[even] ?? 0;
        const evenImag = imag[even] ?? 0;
        const oddReal = real[odd] ?? 0;
        const oddImag = imag[odd] ?? 0;
        const productReal =
          twiddleReal * oddReal - twiddleImag * oddImag;
        const productImag =
          twiddleReal * oddImag + twiddleImag * oddReal;
        real[even] = evenReal + productReal;
        imag[even] = evenImag + productImag;
        real[odd] = evenReal - productReal;
        imag[odd] = evenImag - productImag;
        const nextReal =
          twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
        addWork(work, 'fft');
      }
    }
  }
  return { real, imag };
}

/** Возвращает true, если первый пик сильнее или выигрывает tie по bin. */
function peakPrecedes(a: ResidualPeak, b: ResidualPeak): boolean {
  if (a.magnitude !== b.magnitude) {
    return a.magnitude > b.magnitude;
  }
  return a.bin < b.bin;
}

/** Уточняет частоту параболой по трём magnitude без выхода за полбина. */
function interpolatedPeak(
  bin: number,
  magnitudes: Float64Array,
  fftSize: number,
  sampleRate: number,
): ResidualPeak {
  const left = magnitudes[bin - 1] ?? 0;
  const center = magnitudes[bin] ?? 0;
  const right = magnitudes[bin + 1] ?? 0;
  const denominator = left - 2 * center + right;
  let offset = 0;
  if (denominator !== 0 && Number.isFinite(denominator)) {
    offset = Math.max(
      -0.5,
      Math.min(0.5, (0.5 * (left - right)) / denominator),
    );
  }
  return {
    bin,
    frequency: ((bin + offset) * sampleRate) / fftSize,
    magnitude: center,
  };
}

/** Выбирает до N пиков от minFrequency до maxFrequency с явным учётом сортировки. */
function selectPeaks(
  spectrum: Spectrum,
  window: PreparedWindow,
  options: NormalizedOptions,
  work: ResidualStructuralWorkBreakdown,
): ResidualPeak[] {
  const size = spectrum.real.length;
  const nyquist = Math.floor(size / 2);
  const magnitudes = new Float64Array(nyquist + 1);
  for (let bin = 0; bin <= nyquist; bin += 1) {
    magnitudes[bin] =
      Math.hypot(spectrum.real[bin] ?? 0, spectrum.imag[bin] ?? 0) /
      size;
    addWork(work, 'peaks');
  }
  const firstBin = Math.max(
    1,
    Math.ceil((options.minFrequency * size) / options.sampleRate),
  );
  const lastBin = Math.min(
    nyquist - 1,
    Math.floor((options.maxFrequency * size) / options.sampleRate),
  );
  if (lastBin < firstBin) {
    return [];
  }

  let maximum = 0;
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    maximum = Math.max(maximum, magnitudes[bin] ?? 0);
    addWork(work, 'peaks');
  }
  const threshold = maximum * options.relativePeakThreshold;
  const localPeaks: ResidualPeak[] = [];
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    const magnitude = magnitudes[bin] ?? 0;
    if (
      magnitude > 0 &&
      magnitude >= threshold &&
      magnitude > (magnitudes[bin - 1] ?? 0) &&
      magnitude >= (magnitudes[bin + 1] ?? 0)
    ) {
      localPeaks.push({ bin, frequency: 0, magnitude });
      addWork(work, 'peaks');
    }
    addWork(work, 'peaks');
  }

  const shortlist: ResidualPeak[] = [];
  for (const peak of localPeaks) {
    let insertAt = shortlist.length;
    for (let index = 0; index < shortlist.length; index += 1) {
      const current = shortlist[index];
      addWork(work, 'peaks');
      if (current !== undefined && peakPrecedes(peak, current)) {
        insertAt = index;
        break;
      }
    }
    if (insertAt < options.maxPeaksPerWindow) {
      shortlist.splice(insertAt, 0, peak);
      if (shortlist.length > options.maxPeaksPerWindow) {
        shortlist.pop();
      }
    }
  }
  return shortlist.map((peak) => {
    addWork(work, 'peaks');
    return interpolatedPeak(
      peak.bin,
      magnitudes,
      size,
      options.sampleRate,
    );
  });
}

/** Считает RSS canonical PCM после фактического удаления одного active slot. */
function leaveOneOutLoss(
  parent: NativeStructuralParent,
  slot: number,
  baselineResidualSquares: number,
  options: NormalizedOptions,
  work: ResidualStructuralWorkBreakdown,
): number {
  const patch = clonePatch(parent.patch);
  const group = patch.oscillators[slot];
  if (group === undefined || !group.osc.on) {
    throw new Error('Leave-one-out slot must be active');
  }
  group.osc.on = false;
  const samples = renderForTarget(
    patch,
    options.target.length,
    options.phaseModel,
  );
  addWork(work, 'slots', options.target.length);
  let residualSquares = 0;
  for (let index = 0; index < options.target.length; index += 1) {
    const value =
      (options.target[index] ?? 0) - (samples[index] ?? 0);
    residualSquares += value * value;
    addWork(work, 'slots');
  }
  // При общей target-норме прирост RSS ранжирует так же, как потерю global.
  return residualSquares - baselineResidualSquares;
}

/** Ставит off/append первым, затем добавляет слабые active по фактическому RSS. */
function rankSlots(
  parent: NativeStructuralParent,
  baselineResidualSquares: number,
  options: NormalizedOptions,
  work: ResidualStructuralWorkBreakdown,
): number[] {
  let offSlot: number | null = null;
  const active: number[] = [];
  for (
    let slot = 0;
    slot < parent.patch.oscillators.length;
    slot += 1
  ) {
    const group = parent.patch.oscillators[slot];
    addWork(work, 'slots');
    if (group?.osc.on === true) {
      active.push(slot);
    } else if (offSlot === null) {
      offSlot = slot;
    }
  }
  const slots: number[] = [];
  if (offSlot !== null) {
    slots.push(offSlot);
  } else if (parent.patch.oscillators.length < MAX_OSCILLATORS) {
    slots.push(parent.patch.oscillators.length);
  }
  if (options.weakActiveSlotCount === 0) {
    return slots;
  }

  const weakest: ActiveSlotLoss[] = [];
  for (const slot of active) {
    const candidate = {
      slot,
      loss: leaveOneOutLoss(
        parent,
        slot,
        baselineResidualSquares,
        options,
        work,
      ),
    };
    let insertAt = weakest.length;
    for (let index = 0; index < weakest.length; index += 1) {
      const current = weakest[index];
      addWork(work, 'slots');
      if (
        current !== undefined &&
        (candidate.loss < current.loss ||
          (candidate.loss === current.loss && slot < current.slot))
      ) {
        insertAt = index;
        break;
      }
    }
    if (insertAt < options.weakActiveSlotCount) {
      weakest.splice(insertAt, 0, candidate);
      if (weakest.length > options.weakActiveSlotCount) {
        weakest.pop();
      }
    }
  }
  for (const candidate of weakest) {
    slots.push(candidate.slot);
  }
  return slots;
}

/** Превращает пик и variant в полную форму; нули остаются числовыми полями shape. */
function shapeFromPeak(
  peak: ResidualPeak,
  variant: ResidualStructuralShapeVariant,
  window: PreparedWindow,
): StructuralAtomShape {
  return {
    freqBase: peak.frequency,
    freqStart: peak.frequency * variant.freqStartRatio,
    oscDuration: variant.oscDuration,
    oscSlope: variant.oscSlope,
    ampDuration: variant.ampDuration,
    ampEndLevel: variant.ampEndLevel,
    ampSlope: variant.ampSlope,
    delaySamples: window.start + variant.delaySamples,
    attackSamples: variant.attackSamples,
    hardStop: variant.hardStop,
  };
}

/** Возвращает текст ошибки slots/dimensions до evaluator и basis render. */
function proposalSlotError(
  parent: NativeStructuralParent,
  proposal: NativeStructuralProposal,
): string | null {
  const count = proposal.slots.length;
  if (
    count < 1 ||
    count > MAX_OSCILLATORS ||
    proposal.shapes.length !== count
  ) {
    return 'Invalid residual structural proposal dimensions';
  }
  const used = new Set<number>();
  let outputLength = parent.patch.oscillators.length;
  for (const slot of proposal.slots) {
    if (
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      slot >= MAX_OSCILLATORS ||
      used.has(slot)
    ) {
      return 'Invalid or duplicate residual structural slot';
    }
    used.add(slot);
    outputLength = Math.max(outputLength, slot + 1);
  }
  if (outputLength > MAX_OSCILLATORS) {
    return `Residual structural proposal exceeds ${MAX_OSCILLATORS} slots`;
  }
  for (
    let slot = parent.patch.oscillators.length;
    slot < outputLength;
    slot += 1
  ) {
    if (!used.has(slot)) {
      return 'Appended residual structural slots must not contain gaps';
    }
  }
  return null;
}

/** Проверяет, измеряет, дедуплицирует и копирует один proposal. */
function registerProposal(arg: {
  parent: NativeStructuralParent;
  proposal: NativeStructuralProposal;
  injected: boolean;
  seen: Set<string>;
  output: NativeStructuralProposal[];
  work: ResidualStructuralWorkBreakdown;
}): void {
  addWork(arg.work, 'shapes', arg.proposal.shapes.length);
  addWork(arg.work, 'slots', arg.proposal.slots.length);
  const slotError = proposalSlotError(arg.parent, arg.proposal);
  if (slotError !== null) {
    if (arg.injected) {
      throw new Error(slotError);
    }
    return;
  }
  let shapeKeys: string[];
  try {
    shapeKeys = arg.proposal.shapes.map((shape) =>
      structuralAtomShapeKey(shape),
    );
  } catch (error) {
    if (arg.injected) {
      throw error;
    }
    return;
  }
  const key = JSON.stringify([arg.proposal.slots, shapeKeys]);
  if (arg.seen.has(key)) {
    return;
  }
  arg.seen.add(key);
  arg.output.push({
    slots: [...arg.proposal.slots],
    shapes: arg.proposal.shapes.map((shape) => ({ ...shape })),
  });
}

/** Добавляет singles со всеми variants/slots и группы каждого доступного K. */
function proposeFromPeaks(arg: {
  parent: NativeStructuralParent;
  analyses: readonly WindowPeaks[];
  slots: readonly number[];
  options: NormalizedOptions;
  seen: Set<string>;
  output: NativeStructuralProposal[];
  work: ResidualStructuralWorkBreakdown;
}): void {
  for (const analysis of arg.analyses) {
    for (const peak of analysis.peaks) {
      for (const variant of arg.options.shapeVariants) {
        const shape = shapeFromPeak(peak, variant, analysis.window);
        for (const slot of arg.slots) {
          registerProposal({
            parent: arg.parent,
            proposal: { slots: [slot], shapes: [shape] },
            injected: false,
            seen: arg.seen,
            output: arg.output,
            work: arg.work,
          });
        }
      }
    }

    const maxGroupSize = Math.min(
      arg.options.maxGroupSize,
      analysis.peaks.length,
      arg.slots.length,
    );
    for (
      let groupSize = 2;
      groupSize <= maxGroupSize;
      groupSize += 1
    ) {
      const shapes: StructuralAtomShape[] = [];
      const slots: number[] = [];
      for (let index = 0; index < groupSize; index += 1) {
        const peak = analysis.peaks[index];
        const variant =
          arg.options.shapeVariants[
            (index + groupSize - 1) % arg.options.shapeVariants.length
          ];
        const slot = arg.slots[index];
        if (
          peak === undefined ||
          variant === undefined ||
          slot === undefined
        ) {
          throw new Error('Incomplete residual structural group');
        }
        shapes.push(shapeFromPeak(peak, variant, analysis.window));
        slots.push(slot);
      }
      registerProposal({
        parent: arg.parent,
        proposal: { slots, shapes },
        injected: false,
        seen: arg.seen,
        output: arg.output,
        work: arg.work,
      });
    }
  }
}

/** Возвращает conservative category bound, не выполняя PCM/FFT-анализ. */
function estimateExpansionWork(
  parent: NativeStructuralParent,
  options: NormalizedOptions,
): number {
  assertParent(parent, options);
  const sampleCount = options.target.length;
  const estimateZone = options.usefulZone ?? {
    start: 0,
    end: sampleCount,
  };
  const windows = prepareWindows(options, estimateZone);
  const work = emptyWork();
  addWork(work, 'residual', sampleCount);
  if (options.usefulZone === null) {
    addWork(work, 'window', sampleCount);
  }
  for (const window of windows) {
    addWork(work, 'window', window.fftSize);
    const butterflies = (window.fftSize / 2) * window.levels;
    addWork(work, 'fft', window.fftSize);
    addWork(work, 'fft', window.fftSize * window.levels);
    addWork(work, 'fft', butterflies);
    const nyquist = Math.floor(window.fftSize / 2);
    const firstBin = Math.max(
      1,
      Math.ceil(
        (options.minFrequency * window.fftSize) / options.sampleRate,
      ),
    );
    const lastBin = Math.min(
      nyquist - 1,
      Math.floor(
        (options.maxFrequency * window.fftSize) / options.sampleRate,
      ),
    );
    const bins = Math.max(0, lastBin - firstBin + 1);
    addWork(work, 'peaks', nyquist + 1);
    addWork(work, 'peaks', 3 * bins);
    addWork(work, 'peaks', bins * options.maxPeaksPerWindow);
    addWork(work, 'peaks', options.maxPeaksPerWindow);
  }

  let activeCount = 0;
  let hasOff = false;
  for (const group of parent.patch.oscillators) {
    if (group.osc.on) {
      activeCount += 1;
    } else {
      hasOff = true;
    }
  }
  const hasAppend = parent.patch.oscillators.length < MAX_OSCILLATORS;
  const slotCount =
    (hasOff || hasAppend ? 1 : 0) +
    Math.min(activeCount, options.weakActiveSlotCount);
  const peakCount = options.maxPeaksPerWindow;
  const variantCount = options.shapeVariants.length;
  const groupLimit = Math.min(
    options.maxGroupSize,
    peakCount,
    slotCount,
  );
  const singleAttempts = peakCount * variantCount * slotCount;
  const groupShapeAttempts = peakCount * groupLimit;
  for (let index = 0; index < windows.length; index += 1) {
    addWork(work, 'shapes', singleAttempts + groupShapeAttempts);
    addWork(work, 'slots', singleAttempts + groupShapeAttempts);
  }
  if (windows.length > 0 && variantCount > 0) {
    addWork(work, 'slots', parent.patch.oscillators.length);
    addWork(work, 'slots', 2 * sampleCount * activeCount);
    addWork(work, 'slots', activeCount * options.weakActiveSlotCount);
  }
  for (const proposal of options.injectedCandidates) {
    addWork(work, 'shapes', proposal.shapes.length);
    addWork(work, 'slots', proposal.slots.length);
  }
  return work.total;
}

/** Складывает фактический вызов в session snapshot независимой копией. */
function accumulateWork(
  target: ResidualStructuralWorkBreakdown,
  added: ResidualStructuralWorkBreakdown,
): void {
  const categories: WorkCategory[] = [
    'residual',
    'window',
    'fft',
    'peaks',
    'shapes',
    'slots',
  ];
  for (const category of categories) {
    addWork(target, category, added[category]);
  }
}

/**
 * Создаёт одну независимую residual proposer session.
 *
 * @param options - Target PCM, окна, формы, slots и known-answer
 *   injections
 * @returns Native measured session с conservative estimator и snapshot
 * @throws Error при невалидных опциях
 * @remarks Каждый `propose` заново выполняет весь анализ: кэша нет,
 *   поэтому повтор parent возвращает те же canonical proposals и снова
 *   оплачивает работу. `estimateExpansion` ничего не меняет в ledger.
 *   Две sessions не делят target buffers, counters или candidates.
 *   Функция копирует и проверяет options один раз при создании session,
 *   как native root preparation, и не включает эту работу в W.
 */
export function createResidualStructuralProposerSession(
  options: ResidualStructuralProposerOptions,
): ResidualStructuralProposerSession {
  const normalized = normalizeOptions(options);
  const totals = emptyWork();
  let calls = 0;

  return {
    estimateExpansion: (parent): number =>
      estimateExpansionWork(parent, normalized),
    propose: (parent): ResidualStructuralProposeResult => {
      assertParent(parent, normalized);
      const estimatedWork = estimateExpansionWork(parent, normalized);
      const work = emptyWork();
      const output: NativeStructuralProposal[] = [];
      const seen = new Set<string>();
      calls += 1;
      const { residual, residualSquares } = subtractResidual(
        parent,
        normalized,
        work,
      );

      for (const proposal of normalized.injectedCandidates) {
        registerProposal({
          parent,
          proposal,
          injected: true,
          seen,
          output,
          work,
        });
      }
      const zone =
        normalized.usefulZone ?? measureUsefulZone(normalized, work);
      const windows = prepareWindows(normalized, zone);
      const analyses: WindowPeaks[] = [];
      for (const window of windows) {
        const windowed = windowResidual(residual, window, work);
        const spectrum = forwardFft(windowed, work);
        const peaks = selectPeaks(spectrum, window, normalized, work);
        analyses.push({ window, peaks });
      }
      if (
        normalized.shapeVariants.length > 0 &&
        analyses.some((analysis) => analysis.peaks.length > 0)
      ) {
        const slots = rankSlots(
          parent,
          residualSquares,
          normalized,
          work,
        );
        proposeFromPeaks({
          parent,
          analyses,
          slots,
          options: normalized,
          seen,
          output,
          work,
        });
      }

      accumulateWork(totals, work);
      const actualCost = work.total;
      if (!Number.isFinite(actualCost) || actualCost < 0) {
        throw new Error(
          'Residual proposer actual cost must be non-negative',
        );
      }
      if (actualCost > estimatedWork) {
        throw new Error(
          `Residual proposer exceeded estimate for ${parent.nodeKey}: ` +
            `${actualCost} > ${estimatedWork}`,
        );
      }
      return { candidates: output, cost: actualCost };
    },
    snapshot: (): ResidualStructuralProposerSnapshot => ({
      calls,
      cost: totals.total,
      categories: { ...totals },
    }),
  };
}

/**
 * Создаёт factory для `NativeStructuralBeamOptions.createProposerSession`.
 *
 * @param options - Общие deterministic правила; каждая ветвь получает
 *   свою копию
 * @returns Factory, который создаёт независимые measured sessions
 * @remarks Не замыкает counters или budget снаружи factory. Width-control
 *   и повторный native beam поэтому начинают с одинаковых первых
 *   proposals.
 */
export function createResidualStructuralProposer(
  options: ResidualStructuralProposerOptions,
): ResidualStructuralProposerFactory {
  return () => createResidualStructuralProposerSession(options);
}
