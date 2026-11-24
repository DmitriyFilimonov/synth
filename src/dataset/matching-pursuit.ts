/**
 * Ограниченный residual-driven matching pursuit поверх готового match.
 * Окна нужны только для поиска кандидатов; принимает атом полный WAV.
 * Не добавляет правку в CD или enhance: это изолированный A/B-эксперимент.
 */
import { assessCancellationQuality } from '../cancellation-assessment';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import { fftMagnitudeSpectrum } from '../fft';
import {
  computeUsefulZone,
  type UsefulZone,
} from '../optimize/evaluate';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import {
  clonePatch,
  createInitialState,
  fitQuadrature,
  measureMetrics,
  quantizeRaw,
  renderForTarget,
  renderGroup,
  renderQuadratureCandidate,
  unitGroup,
  type QuadratureFit,
  type RefitMetrics,
  type RenderState,
} from './quadrature-refit';

export type OscillatorGroup = ArgCreateSynth['oscillators'][number];
export type SearchWindow = 'attack' | 'early' | 'full';

interface ResidualPeak {
  frequency: number;
  magnitude: number;
  window: SearchWindow;
}

export interface AtomDescription {
  frequency: number;
  freqStart: number;
  duration: number;
  slope: number;
  oscDuration: number;
  oscSlope: number;
  window: SearchWindow;
  localGain: number;
  peakMagnitude: number;
  sweepTemplateIndex: number | null;
}

/** Один принятый атом и его влияние на обе метрики. */
export interface PursuitStep {
  step: number;
  slot: number;
  replacedFrequency: number | null;
  frequency: number;
  freqStart: number;
  duration: number;
  slope: number;
  oscDuration: number;
  oscSlope: number;
  window: SearchWindow;
  sweepTemplateIndex: number | null;
  localGain: number;
  startLevel: number;
  phase: number;
  before: RefitMetrics;
  after: RefitMetrics;
  exactCandidates: number;
}

/** Патч, WAV и полный аудит ограниченного поиска. */
export interface PursuitResult {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  baseline: RefitMetrics;
  metrics: RefitMetrics;
  steps: PursuitStep[];
  localEvaluations: number;
  exactEvaluations: number;
}

interface AtomCandidate {
  state: RenderState;
  fit: QuadratureFit;
  description: AtomDescription;
  exactCandidates: number;
}

interface SlotChoice {
  slot: number;
  rawWithout: Float64Array;
  contributions: (Float64Array | null)[];
}

const SEARCH_FFT_SIZE = 65536;
const MIN_FREQUENCY = 20;
const MAX_FREQUENCY = 16000;
const DEFAULT_STEPS = 12;
const MAX_STEPS = 48;
const MAX_EXACT_CANDIDATES = 16;

/** Возвращает границы трёх окон поиска в отсчётах. */
function searchWindows(
  sampleCount: number,
  zone: UsefulZone,
): { name: SearchWindow; end: number; separationHz: number }[] {
  const last = Math.max(1, Math.min(sampleCount, zone.end));
  return [
    {
      name: 'attack',
      end: Math.max(
        1,
        Math.min(last, Math.round(0.02 * SAMPLE_RATE)),
      ),
      separationHz: 25,
    },
    {
      name: 'early',
      end: Math.max(1, Math.min(last, Math.round(0.1 * SAMPLE_RATE))),
      separationHz: 5,
    },
    { name: 'full', end: last, separationHz: 1 },
  ];
}

/** Строит Hann-окно остатка и дополняет его до фиксированного FFT. */
function paddedResidualWindow(
  residual: Float64Array,
  end: number,
): Float64Array {
  const padded = new Float64Array(SEARCH_FFT_SIZE);
  for (let index = 0; index < end; index += 1) {
    const weight =
      end <= 1
        ? 1
        : 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (end - 1));
    padded[index] = (residual[index] ?? 0) * weight;
  }
  return padded;
}

/** Возвращает до четырёх разнесённых FFT-пиков одного окна. */
function peaksInWindow(
  residual: Float64Array,
  window: { name: SearchWindow; end: number; separationHz: number },
): ResidualPeak[] {
  if (window.end < 16) {
    return [];
  }
  const { magnitudes, fftSize } = fftMagnitudeSpectrum(
    paddedResidualWindow(residual, window.end),
  );
  const first = Math.max(
    2,
    Math.ceil((MIN_FREQUENCY * fftSize) / SAMPLE_RATE),
  );
  const last = Math.min(
    magnitudes.length - 2,
    Math.floor((MAX_FREQUENCY * fftSize) / SAMPLE_RATE),
  );
  const local: { bin: number; magnitude: number }[] = [];
  for (let bin = first; bin <= last; bin += 1) {
    const magnitude = magnitudes[bin] ?? 0;
    if (
      magnitude > (magnitudes[bin - 1] ?? 0) &&
      magnitude >= (magnitudes[bin + 1] ?? 0)
    ) {
      local.push({ bin, magnitude });
    }
  }
  local.sort((a, b) => b.magnitude - a.magnitude);
  const selected: ResidualPeak[] = [];
  for (const peak of local) {
    const previous = magnitudes[peak.bin - 1] ?? 0;
    const current = magnitudes[peak.bin] ?? 0;
    const next = magnitudes[peak.bin + 1] ?? 0;
    const denominator = previous - 2 * current + next;
    const offset =
      Math.abs(denominator) > 1e-20
        ? Math.max(
            -0.5,
            Math.min(0.5, (0.5 * (previous - next)) / denominator),
          )
        : 0;
    const frequency = ((peak.bin + offset) * SAMPLE_RATE) / fftSize;
    if (
      selected.some(
        (other) =>
          Math.abs(other.frequency - frequency) < window.separationHz,
      )
    ) {
      continue;
    }
    selected.push({
      frequency,
      magnitude: peak.magnitude,
      window: window.name,
    });
    if (selected.length === 4) {
      break;
    }
  }
  return selected;
}

/** Ищет максимум 12 пиков остатка во всех трёх окнах. */
function findResidualPeaks(
  residual: Float64Array,
  zone: UsefulZone,
): ResidualPeak[] {
  return searchWindows(residual.length, zone).flatMap((window) =>
    peaksInWindow(residual, window),
  );
}

/** Банк огибающих зависит от окна поиска, но не от имени таргета. */
export function envelopeBank(window: SearchWindow): {
  durations: number[];
  slopes: number[];
} {
  if (window === 'attack') {
    return { durations: [0.001, 0.005, 0.02, 0.04], slopes: [1, 2] };
  }
  if (window === 'early') {
    return { durations: [0.01, 0.04, 0.1, 0.2], slopes: [1, 2] };
  }
  return {
    durations: [0.05, 0.1, 0.2, 0.4],
    slopes: [0.5, 1, 2],
  };
}

/** Создаёт стационарный атом с нулевой фазой и единичным уровнем. */
function descriptionFromPeak(
  peak: ResidualPeak,
  duration: number,
  slope: number,
): AtomDescription {
  return {
    frequency: peak.frequency,
    freqStart: peak.frequency,
    duration,
    slope,
    oscDuration: Math.max(1 / SAMPLE_RATE, Math.min(0.5, duration)),
    oscSlope: 1,
    window: peak.window,
    localGain: 0,
    peakMagnitude: peak.magnitude,
    sweepTemplateIndex: null,
  };
}

/** Нормированная огибающая единичного атома для дешёвого shortlist. */
function unitEnvelope(
  length: number,
  duration: number,
  slope: number,
): Float64Array {
  const endRatio = Math.log(0.001);
  return Float64Array.from({ length }, (_, index) => {
    const time = index / SAMPLE_RATE;
    const position = Math.min(1, time / duration);
    return Math.exp(endRatio * position ** slope);
  });
}

/** Sin/cos одной частоты строятся рекуррентно для всех огибающих окна. */
function sineCosine(
  frequency: number,
  length: number,
): { sine: Float64Array; cosine: Float64Array } {
  const sine = new Float64Array(length);
  const cosine = new Float64Array(length);
  const angle = (2 * Math.PI * frequency) / SAMPLE_RATE;
  const stepSine = Math.sin(angle);
  const stepCosine = Math.cos(angle);
  let currentSine = 0;
  let currentCosine = 1;
  for (let index = 0; index < length; index += 1) {
    sine[index] = currentSine;
    cosine[index] = currentCosine;
    const nextSine =
      currentSine * stepCosine + currentCosine * stepSine;
    currentCosine =
      currentCosine * stepCosine - currentSine * stepSine;
    currentSine = nextSine;
  }
  return { sine, cosine };
}

/** Оценивает прирост RSS одной огибающей на локальном окне. */
function localAtomGain(arg: {
  residual: Float64Array;
  end: number;
  sine: Float64Array;
  cosine: Float64Array;
  envelope: Float64Array;
}): number {
  let ss = 0;
  let cc = 0;
  let sc = 0;
  let sr = 0;
  let cr = 0;
  for (let index = 0; index < arg.end; index += 1) {
    const envelope = arg.envelope[index] ?? 0;
    const sine = envelope * (arg.sine[index] ?? 0);
    const cosine = envelope * (arg.cosine[index] ?? 0);
    const residual = arg.residual[index] ?? 0;
    ss += sine * sine;
    cc += cosine * cosine;
    sc += sine * cosine;
    sr += sine * residual;
    cr += cosine * residual;
  }
  const determinant = ss * cc - sc * sc;
  if (determinant <= 1e-12 * ss * cc || ss <= 0 || cc <= 0) {
    return 0;
  }
  let a = (sr * cc - cr * sc) / determinant;
  let b = (cr * ss - sr * sc) / determinant;
  const amplitude = Math.hypot(a, b);
  if (amplitude > 1) {
    a /= amplitude;
    b /= amplitude;
  }
  return Math.max(
    0,
    2 * a * sr +
      2 * b * cr -
      a * a * ss -
      b * b * cc -
      2 * a * b * sc,
  );
}

/** Возвращает исходный shortlist словаря 2: восемь сильнейших разных атомов. */
function topStationaryShortlist(
  ranked: AtomDescription[],
): AtomDescription[] {
  const unique = new Map<string, AtomDescription>();
  for (const atom of ranked) {
    const key = `${Math.round(atom.frequency * 5)}:${atom.duration}:${atom.slope}`;
    if (!unique.has(key)) {
      unique.set(key, atom);
    }
    if (unique.size === 8) {
      break;
    }
  }
  return [...unique.values()];
}

/** Сохраняет восемь сильнейших атомов и добавляет до четырёх разнообразных. */
function diverseStationaryShortlist(
  ranked: AtomDescription[],
): AtomDescription[] {
  const unique = new Map<string, AtomDescription>();
  for (const atom of ranked) {
    const key = `${Math.round(atom.frequency * 5)}:${atom.duration}:${atom.slope}`;
    if (!unique.has(key)) {
      unique.set(key, atom);
    }
  }
  const atoms = [...unique.values()];
  const selected = atoms.slice(0, 8);
  const selectedKeys = new Set(
    selected.map(
      (atom) =>
        `${Math.round(atom.frequency * 5)}:${atom.duration}:${atom.slope}`,
    ),
  );
  const add = (atom: AtomDescription | undefined): void => {
    if (atom === undefined || selected.length >= 12) {
      return;
    }
    const key = `${Math.round(atom.frequency * 5)}:${atom.duration}:${atom.slope}`;
    if (!selectedKeys.has(key)) {
      selected.push(atom);
      selectedKeys.add(key);
    }
  };
  add(
    atoms.find(
      (atom) => atom.window === 'attack' && atom.frequency >= 4000,
    ),
  );
  add(atoms.find((atom) => atom.window === 'attack'));
  add(atoms.find((atom) => atom.window === 'early'));
  add(atoms.find((atom) => atom.window === 'full'));
  return selected;
}

/** Ранжирует 112 стационарных атомов и оставляет до двенадцати разных. */
function rankStationaryAtoms(
  peaks: ResidualPeak[],
  residual: Float64Array,
  zone: UsefulZone,
  diverse: boolean,
): { atoms: AtomDescription[]; evaluations: number } {
  const windows = new Map(
    searchWindows(residual.length, zone).map((window) => [
      window.name,
      window.end,
    ]),
  );
  const envelopeCache = new Map<string, Float64Array>();
  const ranked: AtomDescription[] = [];
  let evaluations = 0;
  for (const peak of peaks) {
    const end = windows.get(peak.window) ?? residual.length;
    const waves = sineCosine(peak.frequency, end);
    const bank = envelopeBank(peak.window);
    for (const duration of bank.durations) {
      for (const slope of bank.slopes) {
        const key = `${peak.window}:${duration}:${slope}`;
        let envelope = envelopeCache.get(key);
        if (envelope === undefined) {
          envelope = unitEnvelope(end, duration, slope);
          envelopeCache.set(key, envelope);
        }
        const description = descriptionFromPeak(
          peak,
          duration,
          slope,
        );
        description.localGain = localAtomGain({
          residual,
          end,
          sine: waves.sine,
          cosine: waves.cosine,
          envelope,
        });
        evaluations += 1;
        if (description.localGain > 0) {
          ranked.push(description);
        }
      }
    }
  }
  ranked.sort(
    (a, b) =>
      b.localGain - a.localGain || b.peakMagnitude - a.peakMagnitude,
  );
  return {
    atoms: diverse
      ? diverseStationaryShortlist(ranked)
      : topStationaryShortlist(ranked),
    evaluations,
  };
}

/** Находит ближайший низкий шаблон траектории для одного пика. */
function nearestSweepTemplate(
  peak: ResidualPeak,
  patch: ArgCreateSynth,
): { group: OscillatorGroup; index: number } | null {
  if (peak.frequency > 300) {
    return null;
  }
  const nearest = patch.oscillators
    .map((group, index) => ({ group, index }))
    .filter(
      ({ group }) =>
        group.osc.on &&
        group.osc.freqBase >= 20 &&
        group.osc.freqBase <= 300,
    )
    .map((template) => ({
      ...template,
      distance: Math.abs(
        Math.log(template.group.osc.freqBase / peak.frequency),
      ),
    }))
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest === undefined
    ? null
    : { group: nearest.group, index: nearest.index };
}

/** Ставит траекторию шаблона на конкретную базовую частоту. */
function sweepAtBase(
  peak: ResidualPeak,
  template: { group: OscillatorGroup; index: number },
  frequency: number,
): AtomDescription {
  const source = template.group;
  const ratio = source.osc.freqStart / source.osc.freqBase;
  return {
    frequency,
    freqStart: Math.max(20, Math.min(20000, frequency * ratio)),
    duration: source.ampEnv.duration,
    slope: source.ampEnv.slope,
    oscDuration: source.osc.duration,
    oscSlope: source.osc.slope,
    window: peak.window,
    localGain: 0,
    peakMagnitude: peak.magnitude,
    sweepTemplateIndex: template.index,
  };
}

/** Точно строит sweep-волны на локальном окне и считает их RSS-выигрыш. */
function renderedSweepGain(arg: {
  shape: AtomDescription;
  residual: Float64Array;
  end: number;
  phaseModel: PhaseModel;
}): number {
  const group = groupFromAtom(arg.shape, {
    sineCoefficient: 1,
    cosineCoefficient: 0,
    startLevel: 1,
    phase: 0,
  });
  const sine = renderGroup(group, arg.end, arg.phaseModel);
  const cosine = renderGroup(
    { ...group, osc: { ...group.osc, phase: Math.PI / 2 } },
    arg.end,
    arg.phaseModel,
  );
  return localAtomGain({
    residual: arg.residual,
    end: arg.end,
    sine,
    cosine,
    envelope: new Float64Array(arg.end).fill(1),
  });
}

/** Грубо и затем локально уточняет базовую частоту одного sweep-пика. */
function rankPeakSweep(
  peak: ResidualPeak,
  patch: ArgCreateSynth,
  residual: Float64Array,
  zone: UsefulZone,
  phaseModel: PhaseModel,
): { atom: AtomDescription | null; evaluations: number } {
  const template = nearestSweepTemplate(peak, patch);
  if (template === null) {
    return { atom: null, evaluations: 0 };
  }
  const ratio =
    template.group.osc.freqStart / template.group.osc.freqBase;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return { atom: null, evaluations: 0 };
  }
  const end =
    searchWindows(residual.length, zone).find(
      (window) => window.name === peak.window,
    )?.end ?? residual.length;
  const bestHolder: { current: AtomDescription | null } = {
    current: null,
  };
  let evaluations = 0;
  const evaluate = (frequency: number): void => {
    if (frequency < 20 || frequency > 300) {
      return;
    }
    const shape = sweepAtBase(peak, template, frequency);
    shape.localGain = renderedSweepGain({
      shape,
      residual,
      end,
      phaseModel,
    });
    evaluations += 1;
    if (
      bestHolder.current === null ||
      shape.localGain > bestHolder.current.localGain
    ) {
      bestHolder.current = shape;
    }
  };
  const maximum = Math.min(250, Math.max(30, peak.frequency + 10));
  for (let frequency = 20; frequency <= maximum; frequency += 5) {
    evaluate(frequency);
  }
  evaluate(peak.frequency);
  const center = bestHolder.current?.frequency ?? peak.frequency;
  for (let offset = -5; offset <= 5; offset += 0.5) {
    evaluate(center + offset);
  }
  return { atom: bestHolder.current, evaluations };
}

/** Оставляет до четырёх sweep-атомов после поиска их базовых частот. */
function lowSweepAtoms(arg: {
  peaks: ResidualPeak[];
  patch: ArgCreateSynth;
  residual: Float64Array;
  zone: UsefulZone;
  phaseModel: PhaseModel;
}): { atoms: AtomDescription[]; evaluations: number } {
  const lowPeaks = arg.peaks
    .filter((peak) => peak.frequency <= 300)
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 4);
  const ranked: AtomDescription[] = [];
  let evaluations = 0;
  for (const peak of lowPeaks) {
    const result = rankPeakSweep(
      peak,
      arg.patch,
      arg.residual,
      arg.zone,
      arg.phaseModel,
    );
    evaluations += result.evaluations;
    if (result.atom !== null && result.atom.localGain > 0) {
      ranked.push(result.atom);
    }
  }
  ranked.sort((a, b) => b.localGain - a.localGain);
  const unique = new Map<string, AtomDescription>();
  for (const atom of ranked) {
    const key = `${atom.sweepTemplateIndex}:${Math.round(atom.frequency * 2)}:${atom.duration}:${atom.slope}`;
    if (!unique.has(key)) {
      unique.set(key, atom);
    }
    if (unique.size === 4) {
      break;
    }
  }
  return { atoms: [...unique.values()], evaluations };
}

/** Общий словарь одиночного и блочного pursuit на одном остатке. */
export interface PursuitDictionary {
  descriptions: AtomDescription[];
  localEvaluations: number;
}

/**
 * Ищет пики остатка и строит общий shortlist атомов для K1 и K2.
 *
 * @param arg - Исходный patch, остаток, полезная зона и модель фазы;
 *   `diverseShortlist` включает разнесённый выбор стационарных атомов
 * @returns До 16 описаний атомов и число локальных оценок; если пиков
 *   нет, возвращает пустой словарь с нулевым счётчиком
 * @remarks Сначала ранжирует стационарные огибающие, затем добавляет
 *   низкие sweep-шаблоны. Общий список обрезается до лимита точных
 *   кандидатов; сами точные проверки здесь не выполняются.
 */
export function buildPursuitDictionary(arg: {
  patch: ArgCreateSynth;
  residual: Float64Array;
  zone: UsefulZone;
  phaseModel: PhaseModel;
  diverseShortlist?: boolean;
}): PursuitDictionary {
  const peaks = findResidualPeaks(arg.residual, arg.zone);
  if (peaks.length === 0) {
    return { descriptions: [], localEvaluations: 0 };
  }
  const stationary = rankStationaryAtoms(
    peaks,
    arg.residual,
    arg.zone,
    arg.diverseShortlist ?? false,
  );
  const swept = lowSweepAtoms({
    peaks,
    patch: arg.patch,
    residual: arg.residual,
    zone: arg.zone,
    phaseModel: arg.phaseModel,
  });
  return {
    descriptions: [...stationary.atoms, ...swept.atoms].slice(
      0,
      MAX_EXACT_CANDIDATES,
    ),
    localEvaluations: stationary.evaluations + swept.evaluations,
  };
}

/** Строит кэш текущих solo-вкладов один раз на исходный патч. */
export function buildContributions(
  patch: ArgCreateSynth,
  sampleCount: number,
  phaseModel: PhaseModel,
): (Float64Array | null)[] {
  return patch.oscillators.map((group) =>
    group.osc.on ? renderGroup(group, sampleCount, phaseModel) : null,
  );
}

/** Global одного PCM без расчёта J; нужен для leave-one-out слотов. */
export function globalOfSamples(
  samples: Int16Array,
  target: number[],
): number {
  const inverted = Array.from(samples, (value) => -value);
  return assessCancellationQuality({
    target,
    generated: inverted,
  }).suppressionPercent;
}

/** Выбирает свободный слот или минимальную фактическую потерю global. */
function chooseSlot(arg: {
  state: RenderState;
  contributions: (Float64Array | null)[];
  target: number[];
}): SlotChoice {
  const free = arg.state.patch.oscillators.findIndex(
    (group) => !group.osc.on,
  );
  if (free >= 0) {
    return {
      slot: free,
      rawWithout: new Float64Array(arg.state.rawSum),
      contributions: arg.contributions,
    };
  }
  let bestSlot = -1;
  let bestRaw: Float64Array | null = null;
  let bestGlobal = -Infinity;
  for (
    let slot = 0;
    slot < arg.state.patch.oscillators.length;
    slot += 1
  ) {
    const group = arg.state.patch.oscillators[slot];
    const contribution = arg.contributions[slot];
    if (
      group === undefined ||
      !group.osc.on ||
      contribution === null ||
      contribution === undefined
    ) {
      continue;
    }
    const rawWithout = Float64Array.from(
      arg.state.rawSum,
      (value, index) => value - (contribution[index] ?? 0),
    );
    const global = globalOfSamples(
      quantizeRaw(rawWithout),
      arg.target,
    );
    if (global > bestGlobal) {
      bestGlobal = global;
      bestSlot = slot;
      bestRaw = rawWithout;
    }
  }
  if (bestSlot < 0 || bestRaw === null) {
    return {
      slot: -1,
      rawWithout: new Float64Array(arg.state.rawSum),
      contributions: arg.contributions,
    };
  }
  return {
    slot: bestSlot,
    rawWithout: bestRaw,
    contributions: arg.contributions,
  };
}

/** Создаёт точный osc group из описания и подобранных квадратур. */
export function groupFromAtom(
  description: AtomDescription,
  fit: QuadratureFit,
): OscillatorGroup {
  return {
    osc: {
      on: true,
      freqBase: description.frequency,
      freqStart: description.freqStart,
      duration: description.oscDuration,
      slope: description.oscSlope,
      phase: fit.phase,
    },
    ampEnv: {
      startLevel: fit.startLevel,
      endLevel: 0.001,
      duration: description.duration,
      slope: description.slope,
    },
  };
}

/** Точно рендерит один атом в выбранном слоте и считает обе метрики. */
function evaluateExactAtom(arg: {
  state: RenderState;
  slot: number;
  rawWithout: Float64Array;
  description: AtomDescription;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  zone: UsefulZone;
}): AtomCandidate | null {
  const template = groupFromAtom(arg.description, {
    sineCoefficient: 1,
    cosineCoefficient: 0,
    startLevel: 1,
    phase: 0,
  });
  const sine = renderGroup(
    unitGroup(template, 0),
    arg.target.length,
    arg.phaseModel,
  );
  const cosine = renderGroup(
    unitGroup(template, Math.PI / 2),
    arg.target.length,
    arg.phaseModel,
  );
  const fit = fitQuadrature({
    sine,
    cosine,
    target: arg.target,
    rawWithout: arg.rawWithout,
  });
  if (fit === null) {
    return null;
  }
  const rendered = renderQuadratureCandidate({
    rawWithout: arg.rawWithout,
    sine,
    cosine,
    fit,
  });
  const metrics = measureMetrics(
    rendered.samples,
    arg.target,
    arg.sampleRate,
    arg.zone,
  );
  const patch = clonePatch(arg.state.patch);
  patch.oscillators[arg.slot] = groupFromAtom(arg.description, fit);
  return {
    state: {
      patch,
      rawSum: rendered.rawSum,
      samples: rendered.samples,
      metrics,
    },
    fit,
    description: arg.description,
    exactCandidates: 1,
  };
}

/** Обновляет один solo-вклад после принятия атома. */
function replaceContribution(arg: {
  contributions: (Float64Array | null)[];
  slot: number;
  group: OscillatorGroup;
  sampleCount: number;
  phaseModel: PhaseModel;
}): (Float64Array | null)[] {
  const next = [...arg.contributions];
  next[arg.slot] = renderGroup(
    arg.group,
    arg.sampleCount,
    arg.phaseModel,
  );
  return next;
}

/** Один шаг shortlist и точного выбора; null означает отсутствие атома. */
function pursueOneStep(arg: {
  state: RenderState;
  contributions: (Float64Array | null)[];
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  zone: UsefulZone;
  windowedFloor: number;
  step: number;
  diverseShortlist: boolean;
}): {
  state: RenderState;
  contributions: (Float64Array | null)[];
  audit: PursuitStep;
  localEvaluations: number;
  exactEvaluations: number;
} | null {
  const choice = chooseSlot({
    state: arg.state,
    contributions: arg.contributions,
    target: arg.target,
  });
  if (choice.slot < 0) {
    return null;
  }
  const withoutSamples = quantizeRaw(choice.rawWithout);
  const residual = Float64Array.from(
    arg.target,
    (value, index) =>
      (value - (withoutSamples[index] ?? 0)) /
      MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  );
  const dictionary = buildPursuitDictionary({
    patch: arg.state.patch,
    residual,
    zone: arg.zone,
    phaseModel: arg.phaseModel,
    diverseShortlist: arg.diverseShortlist,
  });
  const descriptions = dictionary.descriptions;
  let best: AtomCandidate | null = null;
  let exactEvaluations = 0;
  for (const description of descriptions) {
    const candidate = evaluateExactAtom({
      state: arg.state,
      slot: choice.slot,
      rawWithout: choice.rawWithout,
      description,
      target: arg.target,
      sampleRate: arg.sampleRate,
      phaseModel: arg.phaseModel,
      zone: arg.zone,
    });
    exactEvaluations += 1;
    if (candidate === null) {
      continue;
    }
    const metrics = candidate.state.metrics;
    if (
      metrics.globalSuppressionPercent <=
        arg.state.metrics.globalSuppressionPercent + 1e-9 ||
      metrics.windowedSuppressionPercent < arg.windowedFloor
    ) {
      continue;
    }
    if (
      best === null ||
      metrics.globalSuppressionPercent >
        best.state.metrics.globalSuppressionPercent + 1e-9 ||
      (Math.abs(
        metrics.globalSuppressionPercent -
          best.state.metrics.globalSuppressionPercent,
      ) <= 1e-9 &&
        metrics.windowedSuppressionPercent >
          best.state.metrics.windowedSuppressionPercent)
    ) {
      best = candidate;
    }
  }
  if (best === null) {
    return null;
  }
  const group = best.state.patch.oscillators[choice.slot];
  if (group === undefined) {
    return null;
  }
  const previous = arg.state.patch.oscillators[choice.slot];
  const audit: PursuitStep = {
    step: arg.step,
    slot: choice.slot,
    replacedFrequency: previous?.osc.on
      ? previous.osc.freqBase
      : null,
    frequency: best.description.frequency,
    freqStart: best.description.freqStart,
    duration: best.description.duration,
    slope: best.description.slope,
    oscDuration: best.description.oscDuration,
    oscSlope: best.description.oscSlope,
    window: best.description.window,
    sweepTemplateIndex: best.description.sweepTemplateIndex,
    localGain: best.description.localGain,
    startLevel: best.fit.startLevel,
    phase: best.fit.phase,
    before: arg.state.metrics,
    after: best.state.metrics,
    exactCandidates: exactEvaluations,
  };
  return {
    state: best.state,
    contributions: replaceContribution({
      contributions: choice.contributions,
      slot: choice.slot,
      group,
      sampleCount: arg.target.length,
      phaseModel: arg.phaseModel,
    }),
    audit,
    localEvaluations: dictionary.localEvaluations,
    exactEvaluations,
  };
}

/**
 * Выполняет не более maxSteps жадных атомов с исходным fallback.
 *
 * @param arg - Исходный match, target PCM и модель фазы
 * @returns Патч/WAV и аудит; если ни один атом не помог, исходные данные
 * @remarks По умолчанию до 12 шагов и до 12 точных кандидатов на шаг;
 *   `diverseShortlist=true` добавляет до четырёх кандидатов для разных
 *   окон и high-атаки. Экспериментальный maxSteps ограничен 1–48.
 *   Локальный shortlist содержит до 112 стационарных огибающих; низкие
 *   sweep-шаблоны занимают только зарезервированные точные проверки.
 *   Окончательный выбор максимизирует global на полном WAV и не даёт J
 *   упасть больше чем на 0.05 п.п. от исходного match. Новый CD не идёт.
 * @throws Error если target пуст, sample rate не 44100 Гц или maxSteps
 *   не является целым от 1 до 48
 */
export function pursueResidualAtoms(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  maxSteps?: number;
  diverseShortlist?: boolean;
}): PursuitResult {
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  const maxSteps = arg.maxSteps ?? DEFAULT_STEPS;
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Matching pursuit поддерживает только 44100 Гц');
  }
  if (arg.target.length === 0) {
    throw new Error('Пустой target');
  }
  if (
    !Number.isInteger(maxSteps) ||
    maxSteps < 1 ||
    maxSteps > MAX_STEPS
  ) {
    throw new Error(
      `maxSteps должен быть целым от 1 до ${MAX_STEPS}`,
    );
  }
  const target = Array.from(arg.target);
  const zone = computeUsefulZone(target, sampleRate);
  const initial = createInitialState({
    patch: arg.patch,
    target,
    sampleRate,
    phaseModel,
    usefulZone: zone,
  });
  let state = initial;
  let contributions = buildContributions(
    state.patch,
    target.length,
    phaseModel,
  );
  const steps: PursuitStep[] = [];
  let localEvaluations = 0;
  let exactEvaluations = 0;
  const windowedFloor =
    initial.metrics.windowedSuppressionPercent - 0.05;
  for (let step = 1; step <= maxSteps; step += 1) {
    const accepted = pursueOneStep({
      state,
      contributions,
      target,
      sampleRate,
      phaseModel,
      zone,
      windowedFloor,
      step,
      diverseShortlist: arg.diverseShortlist ?? false,
    });
    if (accepted === null) {
      break;
    }
    state = accepted.state;
    contributions = accepted.contributions;
    steps.push(accepted.audit);
    localEvaluations += accepted.localEvaluations;
    exactEvaluations += accepted.exactEvaluations;
  }
  const unchanged = (): PursuitResult => ({
    status: 'unchanged',
    patch: clonePatch(arg.patch),
    samples: initial.samples,
    baseline: initial.metrics,
    metrics: initial.metrics,
    steps: [],
    localEvaluations,
    exactEvaluations,
  });
  if (steps.length === 0) {
    return unchanged();
  }
  const finalSamples = renderForTarget(
    state.patch,
    target.length,
    phaseModel,
  );
  const finalMetrics = measureMetrics(
    finalSamples,
    target,
    sampleRate,
    zone,
  );
  if (
    finalMetrics.globalSuppressionPercent <=
      initial.metrics.globalSuppressionPercent ||
    finalMetrics.windowedSuppressionPercent < windowedFloor
  ) {
    return unchanged();
  }
  return {
    status: 'refined',
    patch: state.patch,
    samples: finalSamples,
    baseline: initial.metrics,
    metrics: finalMetrics,
    steps,
    localEvaluations,
    exactEvaluations,
  };
}
