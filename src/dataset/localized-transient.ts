/**
 * Один localized high-only атом поверх готового A+B2.
 *
 * Поиск ограничен двумя high-ячейками, двумя слотами и шестнадцатью
 * exact-оценками. Он не вызывает CD, K2 или VP и не подключён к production.
 */
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import { fftMagnitudeSpectrum } from '../fft';
import {
  computeUsefulZone,
  type UsefulZone,
} from '../optimize/evaluate';
import {
  ampEnvConfigNormales,
  MAX_OSCILLATORS,
  oscConfigNormales,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import { assertPatchMatchesWav } from './beat-transfer-run';
import { fitQuadratureBlock } from './block-pursuit';
import {
  refitClippedQuadratureAtom,
  type ClipStartAudit,
} from './joint-projection-oracle';
import {
  buildContributions,
  envelopeBank,
  globalOfSamples,
  type AtomDescription,
  type SearchWindow,
} from './matching-pursuit';
import {
  clonePatch,
  createInitialState,
  measureMetrics,
  quantizeRaw,
  renderForTarget,
  renderGroup,
  unitGroup,
  type QuadratureFit,
  type RefitMetrics,
  type RenderState,
} from './quadrature-refit';
import {
  buildResidualTimeBandMap,
  measureRawClipping,
  ONSET_ORACLE_REGIONS,
  type RawClippingReport,
  type ResidualTimeBandCell,
  type ResidualTimeBandMap,
} from './residual-onset-oracle';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];

/** Атом с явным onset, sin²-атакой и конечной поддержкой после атаки. */
export interface LocalizedAtomDescription extends AtomDescription {
  delaySamples: number;
  attackSamples: number;
  supportSamples: number;
  /** Имя исходной time-band ячейки для независимого high guard. */
  cellRegion: string;
}

/** Зафиксированные пределы; runner не меняет их по итогам эксперимента. */
export const LOCALIZED_TRANSIENT_LIMITS = {
  maxCells: 2,
  maxPeaksPerCell: 4,
  maxCoarseLeadersPerCell: 4,
  maxSlots: 2,
  maxRawExactPerSlot: 4,
  maxClipRefitsPerRaw: 1,
  maxExactPerSeed: 16,
  maxAcceptedAtoms: 1,
  minHighHz: 1000,
  maxHighHz: 16000,
  attackSamples: Math.round(0.0005 * SAMPLE_RATE),
  sweepRatios: [0.5, 2],
  attackEarlyCoarseStepSamples: Math.round(0.001 * SAMPLE_RATE),
  bodyTailCoarseStepSamples: Math.round(0.005 * SAMPLE_RATE),
  maxClipIterations: 25,
  globalEpsilon: 1e-10,
  windowedFloorDelta: 0.05,
} as const;

/** Предельные условия продолжения зафиксированы до чтения результата. */
export const LOCALIZED_CONTINUATION_GATE = {
  requiredRuns: 4,
  minMeanSavedGlobalDelta: 0.5,
  minImprovedSeeds: 2,
  windowedFloorDelta: 0.05,
} as const;

/** Free/high-слот и необрезанная сумма без его прежнего вклада. */
export interface LocalizedSlotChoice {
  slot: number;
  replacedFrequency: number | null;
  globalAfterRemoval: number;
  rawWithout: Float64Array;
}

interface HighResidualSnapshot {
  selectedCellRss: number;
  totalHighRss: number;
}

interface SearchFit {
  description: LocalizedAtomDescription;
  fit: QuadratureFit;
  rawRss: number;
  gain: number;
}

/** Метрики и guard одного proposed raw или clip-refit exact-кандидата. */
export interface LocalizedProposalAudit {
  kind: 'raw' | 'refit';
  fit: QuadratureFit;
  metrics: RefitMetrics;
  globalDelta: number;
  windowedDelta: number;
  selectedHighRssBefore: number;
  selectedHighRssAfter: number;
  totalHighRssBefore: number;
  totalHighRssAfter: number;
  clipping: RawClippingReport;
  accepted: boolean;
  rejectionReasons: string[];
  clip: ClipStartAudit | null;
}

/** Raw и refit одного описания на одном слоте. */
export interface LocalizedAttemptAudit {
  slot: number;
  replacedFrequency: number | null;
  description: LocalizedAtomDescription;
  raw: LocalizedProposalAudit | null;
  refit: LocalizedProposalAudit | null;
}

/** Счётчики ограничивают стоимость без wall-clock критериев. */
export interface LocalizedTransientCost {
  timeBandMaps: number;
  peakFftEvaluations: number;
  coarseShapeEvaluations: number;
  onsetEvaluations: number;
  refinedOnsetEvaluations: number;
  variantFitEvaluations: number;
  rawExactEvaluations: number;
  clipRefitEvaluations: number;
  exactEvaluations: number;
  unitBasisRenders: number;
  clipObjectiveEvaluations: number;
  clipIterations: number;
  clipBacktracks: number;
  canonicalFinalRenders: number;
}

/** Итог одного A+B2; unchanged всегда хранит исходные patch/WAV. */
export interface LocalizedTransientResult {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  baseline: RefitMetrics;
  metrics: RefitMetrics;
  baselineTimeBands: ResidualTimeBandMap;
  baselineClipping: RawClippingReport;
  selectedCells: ResidualTimeBandCell[];
  slots: Array<{
    slot: number;
    replacedFrequency: number | null;
    globalAfterRemoval: number;
  }>;
  attempts: LocalizedAttemptAudit[];
  proposedRaw: LocalizedProposalAudit | null;
  proposedRefit: LocalizedProposalAudit | null;
  saved: {
    status: 'refined' | 'unchanged';
    kind: 'raw' | 'refit' | null;
    description: LocalizedAtomDescription | null;
    slot: number | null;
    metrics: RefitMetrics;
    globalDelta: number;
    windowedDelta: number;
    high: {
      selectedCellRssBefore: number;
      selectedCellRssAfter: number;
      totalHighRssBefore: number;
      totalHighRssAfter: number;
    } | null;
    clipping: RawClippingReport | null;
    rejectionReasons: string[];
  };
  limits: typeof LOCALIZED_TRANSIENT_LIMITS;
  cost: LocalizedTransientCost;
  q4Pass: null;
}

/** Внутренний exact-кандидат с PCM и патчем до окончательного canonical guard. */
export interface LocalizedExactCandidate {
  slot: number;
  replacedFrequency: number | null;
  description: LocalizedAtomDescription;
  patch: ArgCreateSynth;
  rawSum: Float64Array;
  samples: Int16Array;
  audit: LocalizedProposalAudit;
}

/** Неизменный target, baseline и полезная зона для exact/canonical оценок. */
export interface LocalizedExactContext {
  state: RenderState;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  zone: UsefulZone;
  baselineTimeBands: ResidualTimeBandMap;
}

function emptyCost(): LocalizedTransientCost {
  return {
    timeBandMaps: 0,
    peakFftEvaluations: 0,
    coarseShapeEvaluations: 0,
    onsetEvaluations: 0,
    refinedOnsetEvaluations: 0,
    variantFitEvaluations: 0,
    rawExactEvaluations: 0,
    clipRefitEvaluations: 0,
    exactEvaluations: 0,
    unitBasisRenders: 0,
    clipObjectiveEvaluations: 0,
    clipIterations: 0,
    clipBacktracks: 0,
    canonicalFinalRenders: 0,
  };
}

function assertIntegerSampleCount(name: string, value: number): void {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${name} должен быть конечным целым >= 0`);
  }
}

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
      `${name} должен быть в диапазоне ${range.min}..${range.max}`,
    );
  }
}

/**
 * Переводит localized-описание в настоящий osc group без clamp частот.
 *
 * @param description - Частоты, sweep, огибающая и целые времена в отсчётах
 * @param fit - Уровень и фаза, полученные bounded solver
 * @returns Включённый osc group с delay, attack и hardStop=true
 * @throws Error если целые времена, частоты или огибающие выходят за нормы;
 *   supportSamples=0 нельзя представить положительной ampEnv.duration
 * @remarks supportSamples задаёт ampEnv.duration после attack. Поле
 *   description.duration обязано равняться supportSamples/SAMPLE_RATE, чтобы
 *   поисковый shortlist и canonical patch не описывали разные формы.
 */
export function groupFromLocalizedAtom(
  description: LocalizedAtomDescription,
  fit: QuadratureFit,
): OscillatorGroup {
  assertIntegerSampleCount('delaySamples', description.delaySamples);
  assertIntegerSampleCount(
    'attackSamples',
    description.attackSamples,
  );
  assertIntegerSampleCount(
    'supportSamples',
    description.supportSamples,
  );
  const delay = description.delaySamples / SAMPLE_RATE;
  const attack = description.attackSamples / SAMPLE_RATE;
  const support = description.supportSamples / SAMPLE_RATE;
  assertNorm(
    'delaySamples/SAMPLE_RATE',
    delay,
    oscConfigNormales.delay,
  );
  assertNorm(
    'attackSamples/SAMPLE_RATE',
    attack,
    ampEnvConfigNormales.attack,
  );
  assertNorm(
    'supportSamples/SAMPLE_RATE',
    support,
    ampEnvConfigNormales.duration,
  );
  if (description.duration !== support) {
    throw new Error(
      'description.duration должен равняться supportSamples/SAMPLE_RATE',
    );
  }
  assertNorm(
    'frequency',
    description.frequency,
    oscConfigNormales.freqBase,
  );
  assertNorm(
    'freqStart',
    description.freqStart,
    oscConfigNormales.freqStart,
  );
  assertNorm(
    'oscDuration',
    description.oscDuration,
    oscConfigNormales.duration,
  );
  assertNorm(
    'oscSlope',
    description.oscSlope,
    oscConfigNormales.slope,
  );
  assertNorm('slope', description.slope, ampEnvConfigNormales.slope);
  assertNorm(
    'startLevel',
    fit.startLevel,
    ampEnvConfigNormales.startLevel,
  );
  assertNorm('phase', fit.phase, oscConfigNormales.phase);
  return {
    osc: {
      on: true,
      freqBase: description.frequency,
      freqStart: description.freqStart,
      duration: description.oscDuration,
      slope: description.oscSlope,
      phase: fit.phase,
      delay,
    },
    ampEnv: {
      startLevel: fit.startLevel,
      endLevel: 0.001,
      duration: support,
      slope: description.slope,
      attack,
      hardStop: true,
    },
  };
}

function unitFit(): QuadratureFit {
  return {
    sineCoefficient: 1,
    cosineCoefficient: 0,
    startLevel: 1,
    phase: 0,
  };
}

function renderLocalizedBasis(arg: {
  description: LocalizedAtomDescription;
  sampleCount: number;
  phaseModel: PhaseModel;
}): Float64Array[] {
  const template = groupFromLocalizedAtom(arg.description, unitFit());
  return [
    renderGroup(
      unitGroup(template, 0),
      arg.sampleCount,
      arg.phaseModel,
    ),
    renderGroup(
      unitGroup(template, Math.PI / 2),
      arg.sampleCount,
      arg.phaseModel,
    ),
  ];
}

function residualFromSamples(
  target: ArrayLike<number>,
  samples: ArrayLike<number>,
): Float64Array {
  return Float64Array.from(
    { length: target.length },
    (_, index) =>
      ((target[index] ?? 0) - (samples[index] ?? 0)) /
      MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  );
}

function timeBandMapForSamples(arg: {
  target: number[];
  samples: Int16Array;
  sampleRate: number;
}): ResidualTimeBandMap {
  return buildResidualTimeBandMap({
    residual: residualFromSamples(arg.target, arg.samples),
    target: arg.target,
    sampleRate: arg.sampleRate,
  });
}

function highSnapshot(arg: {
  map: ResidualTimeBandMap;
  region: string;
}): HighResidualSnapshot {
  const selected = arg.map.cells.find(
    (cell) => cell.region === arg.region && cell.name === 'high',
  );
  if (selected === undefined) {
    throw new Error(`В time-band map нет high/${arg.region}`);
  }
  return {
    selectedCellRss: selected.bandRss,
    totalHighRss: arg.map.cells
      .filter((cell) => cell.name === 'high')
      .reduce((sum, cell) => sum + cell.bandRss, 0),
  };
}

/**
 * Проверяет, что exact-кандидат действительно уменьшает выбранный high-остаток.
 */
export function localizedHighGuardRejectionReasons(arg: {
  before: HighResidualSnapshot;
  after: HighResidualSnapshot;
}): string[] {
  const reasons: string[] = [];
  if (!(arg.after.selectedCellRss < arg.before.selectedCellRss)) {
    reasons.push('selected high cell RSS не уменьшился');
  }
  if (!(arg.after.totalHighRss < arg.before.totalHighRss)) {
    reasons.push('total high RSS не уменьшился');
  }
  return reasons;
}

/** Собирает global/J и high-причины отказа одного exact-кандидата. */
export function localizedProposalRejectionReasons(arg: {
  baseline: RefitMetrics;
  metrics: RefitMetrics;
  before: HighResidualSnapshot;
  after: HighResidualSnapshot;
}): string[] {
  const reasons: string[] = [];
  if (
    !Number.isFinite(arg.metrics.globalSuppressionPercent) ||
    !Number.isFinite(arg.metrics.windowedSuppressionPercent)
  ) {
    reasons.push('нечисловые global/J');
  }
  if (
    arg.metrics.globalSuppressionPercent <=
    arg.baseline.globalSuppressionPercent +
      LOCALIZED_TRANSIENT_LIMITS.globalEpsilon
  ) {
    reasons.push('global не вырос');
  }
  if (
    arg.metrics.windowedSuppressionPercent <
    arg.baseline.windowedSuppressionPercent -
      LOCALIZED_TRANSIENT_LIMITS.windowedFloorDelta
  ) {
    reasons.push('J ниже initial−0.05');
  }
  reasons.push(
    ...localizedHighGuardRejectionReasons({
      before: arg.before,
      after: arg.after,
    }),
  );
  return reasons;
}

/** До двух свободных или уже высоких слотов с наименьшей потерей global. */
export function rankLocalizedHighSlots(arg: {
  state: RenderState;
  contributions: (Float64Array | null)[];
  target: number[];
}): LocalizedSlotChoice[] {
  const choices: LocalizedSlotChoice[] = [];
  for (
    let slot = 0;
    slot < arg.state.patch.oscillators.length;
    slot += 1
  ) {
    const group = arg.state.patch.oscillators[slot];
    if (group === undefined) {
      continue;
    }
    if (
      group.osc.on &&
      group.osc.freqBase < LOCALIZED_TRANSIENT_LIMITS.minHighHz
    ) {
      continue;
    }
    const contribution = arg.contributions[slot];
    const rawWithout = new Float64Array(arg.state.rawSum);
    if (
      group.osc.on &&
      contribution !== null &&
      contribution !== undefined
    ) {
      for (let index = 0; index < rawWithout.length; index += 1) {
        rawWithout[index] =
          (rawWithout[index] ?? 0) - (contribution[index] ?? 0);
      }
    }
    choices.push({
      slot,
      replacedFrequency: group.osc.on ? group.osc.freqBase : null,
      globalAfterRemoval: group.osc.on
        ? globalOfSamples(quantizeRaw(rawWithout), arg.target)
        : arg.state.metrics.globalSuppressionPercent,
      rawWithout,
    });
  }
  choices.sort(
    (a, b) =>
      b.globalAfterRemoval - a.globalAfterRemoval || a.slot - b.slot,
  );
  return choices.slice(0, LOCALIZED_TRANSIENT_LIMITS.maxSlots);
}

function regionForCell(
  cell: ResidualTimeBandCell,
): (typeof ONSET_ORACLE_REGIONS)[number] {
  const region = ONSET_ORACLE_REGIONS.find(
    (candidate) => candidate.name === cell.region,
  );
  if (region === undefined) {
    throw new Error(`Неизвестный участок ${cell.region}`);
  }
  return region;
}

function searchWindowForRegion(region: string): SearchWindow {
  if (region === 'attack' || region === 'early') {
    return region;
  }
  return 'full';
}

interface LocalPeak {
  frequency: number;
  magnitude: number;
}

/** FFT только локального rectangular-среза; prefix window здесь отсутствует. */
function localHighPeaks(arg: {
  residual: Float64Array;
  cell: ResidualTimeBandCell;
  sampleRate: number;
}): LocalPeak[] {
  const region = regionForCell(arg.cell);
  const start = Math.round(region.startSec * arg.sampleRate);
  const end = Math.round(region.endSec * arg.sampleRate);
  const local = Float64Array.from(
    { length: Math.max(0, end - start) },
    (_, index) => arg.residual[start + index] ?? 0,
  );
  if (local.length < 16) {
    return [];
  }
  const { magnitudes, fftSize } = fftMagnitudeSpectrum(local);
  const first = Math.max(
    1,
    Math.ceil(
      (LOCALIZED_TRANSIENT_LIMITS.minHighHz * fftSize) /
        arg.sampleRate,
    ),
  );
  const last = Math.min(
    magnitudes.length - 2,
    Math.floor(
      (LOCALIZED_TRANSIENT_LIMITS.maxHighHz * fftSize) /
        arg.sampleRate,
    ),
  );
  const candidates: Array<{ bin: number; magnitude: number }> = [];
  for (let bin = first; bin <= last; bin += 1) {
    const magnitude = magnitudes[bin] ?? 0;
    if (
      magnitude > (magnitudes[bin - 1] ?? 0) &&
      magnitude >= (magnitudes[bin + 1] ?? 0)
    ) {
      candidates.push({ bin, magnitude });
    }
  }
  candidates.sort(
    (a, b) => b.magnitude - a.magnitude || a.bin - b.bin,
  );
  const peaks: LocalPeak[] = [];
  const separationHz = arg.cell.region === 'attack' ? 20 : 5;
  for (const peak of candidates) {
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
    const frequency =
      ((peak.bin + offset) * arg.sampleRate) / fftSize;
    if (
      frequency < LOCALIZED_TRANSIENT_LIMITS.minHighHz ||
      frequency > LOCALIZED_TRANSIENT_LIMITS.maxHighHz ||
      peaks.some(
        (other) =>
          Math.abs(other.frequency - frequency) < separationHz,
      )
    ) {
      continue;
    }
    peaks.push({ frequency, magnitude: peak.magnitude });
    if (peaks.length === LOCALIZED_TRANSIENT_LIMITS.maxPeaksPerCell) {
      break;
    }
  }
  return peaks;
}

function stationaryDescriptions(arg: {
  cell: ResidualTimeBandCell;
  peaks: LocalPeak[];
}): LocalizedAtomDescription[] {
  const window = searchWindowForRegion(arg.cell.region);
  const bank = envelopeBank(window);
  const descriptions: LocalizedAtomDescription[] = [];
  for (const peak of arg.peaks) {
    for (const duration of bank.durations) {
      for (const slope of bank.slopes) {
        const supportSamples = Math.round(duration * SAMPLE_RATE);
        descriptions.push({
          frequency: peak.frequency,
          freqStart: peak.frequency,
          duration: supportSamples / SAMPLE_RATE,
          slope,
          oscDuration: supportSamples / SAMPLE_RATE,
          oscSlope: 1,
          window,
          localGain: 0,
          peakMagnitude: peak.magnitude,
          sweepTemplateIndex: null,
          delaySamples: 0,
          attackSamples: 0,
          supportSamples,
          cellRegion: arg.cell.region,
        });
      }
    }
  }
  return descriptions;
}

function rawRssForFit(arg: {
  target: ArrayLike<number>;
  rawWithout: ArrayLike<number>;
  basis: Float64Array[];
  fit: QuadratureFit;
}): number {
  let rss = 0;
  for (let index = 0; index < arg.target.length; index += 1) {
    const value =
      (arg.target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      (arg.rawWithout[index] ?? 0) -
      arg.fit.sineCoefficient * (arg.basis[0]?.[index] ?? 0) -
      arg.fit.cosineCoefficient * (arg.basis[1]?.[index] ?? 0);
    rss += value * value;
  }
  return rss;
}

function fitSearchDescription(arg: {
  description: LocalizedAtomDescription;
  target: number[];
  rawWithout: Float64Array;
  baselineRawRss: number;
  phaseModel: PhaseModel;
  cost: LocalizedTransientCost;
}): SearchFit | null {
  const basis = renderLocalizedBasis({
    description: arg.description,
    sampleCount: arg.target.length,
    phaseModel: arg.phaseModel,
  });
  arg.cost.unitBasisRenders += 2;
  const fits = fitQuadratureBlock({
    basis,
    target: arg.target,
    rawWithout: arg.rawWithout,
  });
  const fit = fits?.[0];
  if (fit === undefined) {
    return null;
  }
  const rawRss = rawRssForFit({
    target: arg.target,
    rawWithout: arg.rawWithout,
    basis,
    fit,
  });
  if (!Number.isFinite(rawRss)) {
    return null;
  }
  const description = {
    ...arg.description,
    localGain: Math.max(0, arg.baselineRawRss - rawRss),
  };
  return {
    description,
    fit,
    rawRss,
    gain: arg.baselineRawRss - rawRss,
  };
}

function betterSearchFit(
  candidate: SearchFit | null,
  current: SearchFit | null,
): candidate is SearchFit {
  if (candidate === null) {
    return false;
  }
  if (current === null || candidate.gain > current.gain + 1e-15) {
    return true;
  }
  return (
    Math.abs(candidate.gain - current.gain) <= 1e-15 &&
    candidate.description.delaySamples <
      current.description.delaySamples
  );
}

function coarseDelays(arg: {
  cell: ResidualTimeBandCell;
  sampleCount: number;
  usefulEnd: number;
}): { values: number[]; step: number } {
  const region = regionForCell(arg.cell);
  const step =
    arg.cell.region === 'attack' || arg.cell.region === 'early'
      ? LOCALIZED_TRANSIENT_LIMITS.attackEarlyCoarseStepSamples
      : LOCALIZED_TRANSIENT_LIMITS.bodyTailCoarseStepSamples;
  const start = Math.round(region.startSec * SAMPLE_RATE);
  const end = Math.min(
    arg.sampleCount - 1,
    Math.floor(arg.usefulEnd),
    Math.round(region.endSec * SAMPLE_RATE),
    Math.floor(oscConfigNormales.delay.max * SAMPLE_RATE),
  );
  const values = new Set<number>([0]);
  for (let delay = start; delay <= end; delay += step) {
    values.add(delay);
  }
  if (end >= 0) {
    values.add(end);
  }
  return {
    values: [...values].sort((a, b) => a - b),
    step,
  };
}

function baselineRawRss(
  target: number[],
  rawSum: Float64Array,
): number {
  let rss = 0;
  for (let index = 0; index < target.length; index += 1) {
    const residual =
      (target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      (rawSum[index] ?? 0);
    rss += residual * residual;
  }
  return rss;
}

function scanCoarseShapes(arg: {
  descriptions: LocalizedAtomDescription[];
  cell: ResidualTimeBandCell;
  target: number[];
  rawSum: Float64Array;
  rawRss: number;
  phaseModel: PhaseModel;
  usefulEnd: number;
  cost: LocalizedTransientCost;
}): { fits: SearchFit[]; coarseStep: number } {
  const grid = coarseDelays({
    cell: arg.cell,
    sampleCount: arg.target.length,
    usefulEnd: arg.usefulEnd,
  });
  const ranked: SearchFit[] = [];
  for (const description of arg.descriptions) {
    arg.cost.coarseShapeEvaluations += 1;
    let best: SearchFit | null = null;
    for (const delaySamples of grid.values) {
      arg.cost.onsetEvaluations += 1;
      const candidate = fitSearchDescription({
        description: { ...description, delaySamples },
        target: arg.target,
        rawWithout: arg.rawSum,
        baselineRawRss: arg.rawRss,
        phaseModel: arg.phaseModel,
        cost: arg.cost,
      });
      if (betterSearchFit(candidate, best)) {
        best = candidate;
      }
    }
    if (best !== null) {
      ranked.push(best);
    }
  }
  ranked.sort(
    (a, b) =>
      b.gain - a.gain ||
      a.description.frequency - b.description.frequency ||
      a.description.supportSamples - b.description.supportSamples ||
      a.description.slope - b.description.slope ||
      a.description.delaySamples - b.description.delaySamples,
  );
  return {
    fits: ranked.slice(
      0,
      LOCALIZED_TRANSIENT_LIMITS.maxCoarseLeadersPerCell,
    ),
    coarseStep: grid.step,
  };
}

function refineCoarseLeaders(arg: {
  leaders: SearchFit[];
  cell: ResidualTimeBandCell;
  coarseStep: number;
  target: number[];
  rawSum: Float64Array;
  rawRss: number;
  phaseModel: PhaseModel;
  usefulEnd: number;
  cost: LocalizedTransientCost;
}): SearchFit[] {
  const grid = coarseDelays({
    cell: arg.cell,
    sampleCount: arg.target.length,
    usefulEnd: arg.usefulEnd,
  });
  const maximum = Math.max(...grid.values);
  return arg.leaders.map((leader) => {
    let best = leader;
    const center = leader.description.delaySamples;
    const start = Math.max(0, center - arg.coarseStep);
    const end = Math.min(maximum, center + arg.coarseStep);
    for (
      let delaySamples = start;
      delaySamples <= end;
      delaySamples += 1
    ) {
      if (delaySamples === center) {
        continue;
      }
      arg.cost.onsetEvaluations += 1;
      arg.cost.refinedOnsetEvaluations += 1;
      const candidate = fitSearchDescription({
        description: { ...leader.description, delaySamples },
        target: arg.target,
        rawWithout: arg.rawSum,
        baselineRawRss: arg.rawRss,
        phaseModel: arg.phaseModel,
        cost: arg.cost,
      });
      if (betterSearchFit(candidate, best)) {
        best = candidate;
      }
    }
    return best;
  });
}

/** Разрешает только sweep, у которого обе частоты остаются в 1–16 кГц. */
export function validHighSweep(
  description: LocalizedAtomDescription,
): boolean {
  return (
    description.frequency >= LOCALIZED_TRANSIENT_LIMITS.minHighHz &&
    description.freqStart >= LOCALIZED_TRANSIENT_LIMITS.minHighHz &&
    description.frequency <= LOCALIZED_TRANSIENT_LIMITS.maxHighHz &&
    description.freqStart <= LOCALIZED_TRANSIENT_LIMITS.maxHighHz
  );
}

function localizedVariantKey(
  description: LocalizedAtomDescription,
): string {
  return JSON.stringify([
    description.cellRegion,
    description.frequency,
    description.freqStart,
    description.supportSamples,
    description.slope,
    description.oscDuration,
    description.oscSlope,
    description.delaySamples,
    description.attackSamples,
  ]);
}

function expandLeaderVariants(leaders: SearchFit[]): {
  descriptions: LocalizedAtomDescription[];
  duplicateControls: number;
} {
  const variants = new Map<string, LocalizedAtomDescription>();
  let duplicateControls = 0;
  for (const leader of leaders) {
    const source = leader.description;
    const candidates: LocalizedAtomDescription[] = [
      { ...source },
      { ...source, delaySamples: 0 },
      {
        ...source,
        attackSamples: LOCALIZED_TRANSIENT_LIMITS.attackSamples,
      },
      ...LOCALIZED_TRANSIENT_LIMITS.sweepRatios.map((ratio) => ({
        ...source,
        freqStart: source.frequency * ratio,
        attackSamples: LOCALIZED_TRANSIENT_LIMITS.attackSamples,
      })),
    ];
    for (const candidate of candidates) {
      if (!validHighSweep(candidate)) {
        continue;
      }
      const key = localizedVariantKey(candidate);
      if (variants.has(key)) {
        duplicateControls += 1;
      } else {
        variants.set(key, candidate);
      }
    }
  }
  return {
    descriptions: [...variants.values()],
    duplicateControls,
  };
}

function fitVariants(arg: {
  leaders: SearchFit[];
  target: number[];
  rawSum: Float64Array;
  rawRss: number;
  phaseModel: PhaseModel;
  cost: LocalizedTransientCost;
}): SearchFit[] {
  const expanded = expandLeaderVariants(arg.leaders);
  const fits: SearchFit[] = [];
  for (const description of expanded.descriptions) {
    arg.cost.variantFitEvaluations += 1;
    const candidate = fitSearchDescription({
      description,
      target: arg.target,
      rawWithout: arg.rawSum,
      baselineRawRss: arg.rawRss,
      phaseModel: arg.phaseModel,
      cost: arg.cost,
    });
    if (candidate !== null) {
      fits.push(candidate);
    }
  }
  fits.sort(
    (a, b) =>
      b.gain - a.gain ||
      localizedVariantKey(a.description).localeCompare(
        localizedVariantKey(b.description),
      ),
  );
  return fits;
}

function selectLocalizedDescriptions(arg: {
  cells: ResidualTimeBandCell[];
  residual: Float64Array;
  target: number[];
  state: RenderState;
  phaseModel: PhaseModel;
  zone: UsefulZone;
  cost: LocalizedTransientCost;
}): LocalizedAtomDescription[] {
  const rawRss = baselineRawRss(arg.target, arg.state.rawSum);
  const variants: SearchFit[] = [];
  for (const cell of arg.cells) {
    const peaks = localHighPeaks({
      residual: arg.residual,
      cell,
      sampleRate: SAMPLE_RATE,
    });
    arg.cost.peakFftEvaluations += 1;
    const stationary = stationaryDescriptions({ cell, peaks });
    const coarse = scanCoarseShapes({
      descriptions: stationary,
      cell,
      target: arg.target,
      rawSum: arg.state.rawSum,
      rawRss,
      phaseModel: arg.phaseModel,
      usefulEnd: arg.zone.end,
      cost: arg.cost,
    });
    const refined = refineCoarseLeaders({
      leaders: coarse.fits,
      cell,
      coarseStep: coarse.coarseStep,
      target: arg.target,
      rawSum: arg.state.rawSum,
      rawRss,
      phaseModel: arg.phaseModel,
      usefulEnd: arg.zone.end,
      cost: arg.cost,
    });
    variants.push(
      ...fitVariants({
        leaders: refined,
        target: arg.target,
        rawSum: arg.state.rawSum,
        rawRss,
        phaseModel: arg.phaseModel,
        cost: arg.cost,
      }),
    );
  }
  variants.sort(
    (a, b) =>
      b.gain - a.gain ||
      localizedVariantKey(a.description).localeCompare(
        localizedVariantKey(b.description),
      ),
  );
  const unique = new Map<string, LocalizedAtomDescription>();
  for (const candidate of variants) {
    const key = localizedVariantKey(candidate.description);
    if (!unique.has(key)) {
      unique.set(key, candidate.description);
    }
    if (
      unique.size === LOCALIZED_TRANSIENT_LIMITS.maxRawExactPerSlot
    ) {
      break;
    }
  }
  return [...unique.values()];
}

function buildExactRawSum(arg: {
  rawWithout: Float64Array;
  basis: Float64Array[];
  fit: QuadratureFit;
}): Float64Array {
  return Float64Array.from(
    arg.rawWithout,
    (value, index) =>
      value +
      arg.fit.sineCoefficient * (arg.basis[0]?.[index] ?? 0) +
      arg.fit.cosineCoefficient * (arg.basis[1]?.[index] ?? 0),
  );
}

interface LocalizedProposalEvaluation {
  metrics: RefitMetrics;
  before: HighResidualSnapshot;
  after: HighResidualSnapshot;
  rejectionReasons: string[];
}

/** Общая метрика, high-RSS и clipping для exact и canonical PCM. */
function evaluateLocalizedProposal(arg: {
  context: LocalizedExactContext;
  description: LocalizedAtomDescription;
  rawSum: Float64Array;
  samples: Int16Array;
  cost: LocalizedTransientCost;
}): LocalizedProposalEvaluation {
  const metrics = measureMetrics(
    arg.samples,
    arg.context.target,
    arg.context.sampleRate,
    arg.context.zone,
  );
  const map = timeBandMapForSamples({
    target: arg.context.target,
    samples: arg.samples,
    sampleRate: arg.context.sampleRate,
  });
  arg.cost.timeBandMaps += 1;
  const before = highSnapshot({
    map: arg.context.baselineTimeBands,
    region: arg.description.cellRegion,
  });
  const after = highSnapshot({
    map,
    region: arg.description.cellRegion,
  });
  return {
    metrics,
    before,
    after,
    rejectionReasons: localizedProposalRejectionReasons({
      baseline: arg.context.state.metrics,
      metrics,
      before,
      after,
    }),
  };
}

function proposalFromExact(arg: {
  context: LocalizedExactContext;
  choice: LocalizedSlotChoice;
  description: LocalizedAtomDescription;
  fit: QuadratureFit;
  basis: Float64Array[];
  kind: 'raw' | 'refit';
  clip: ClipStartAudit | null;
  cost: LocalizedTransientCost;
}): LocalizedExactCandidate {
  const rawSum = buildExactRawSum({
    rawWithout: arg.choice.rawWithout,
    basis: arg.basis,
    fit: arg.fit,
  });
  const samples = quantizeRaw(rawSum);
  const evaluation = evaluateLocalizedProposal({
    context: arg.context,
    description: arg.description,
    rawSum,
    samples,
    cost: arg.cost,
  });
  const { metrics, before, after, rejectionReasons } = evaluation;
  const patch = clonePatch(arg.context.state.patch);
  try {
    patch.oscillators[arg.choice.slot] = groupFromLocalizedAtom(
      arg.description,
      arg.fit,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('startLevel ')
    ) {
      throw new Error(
        `Invalid localized fit: slot=${arg.choice.slot} stage=${arg.kind} startLevel=${arg.fit.startLevel}`,
      );
    }
    throw error;
  }
  const audit: LocalizedProposalAudit = {
    kind: arg.kind,
    fit: { ...arg.fit },
    metrics,
    globalDelta:
      metrics.globalSuppressionPercent -
      arg.context.state.metrics.globalSuppressionPercent,
    windowedDelta:
      metrics.windowedSuppressionPercent -
      arg.context.state.metrics.windowedSuppressionPercent,
    selectedHighRssBefore: before.selectedCellRss,
    selectedHighRssAfter: after.selectedCellRss,
    totalHighRssBefore: before.totalHighRss,
    totalHighRssAfter: after.totalHighRss,
    clipping: measureRawClipping({
      rawSum,
      target: arg.context.target,
      samples,
    }),
    accepted: rejectionReasons.length === 0,
    rejectionReasons,
    clip: arg.clip,
  };
  return {
    slot: arg.choice.slot,
    replacedFrequency: arg.choice.replacedFrequency,
    description: { ...arg.description },
    patch,
    rawSum,
    samples,
    audit,
  };
}

const LOCALIZED_LEVEL_BOUNDARY_TOLERANCE = 4 * Number.EPSILON;

/**
 * Канонизирует только ulp-выход за границу уровня и согласованно масштабирует
 * квадратуры. Более широкое нарушение возвращает null, а не маскируется clamp.
 */
export function canonicalizeLocalizedFitBoundary(
  fit: QuadratureFit,
): QuadratureFit | null {
  const fittedLevel = Math.hypot(
    fit.sineCoefficient,
    fit.cosineCoefficient,
  );
  if (!Number.isFinite(fittedLevel)) {
    return null;
  }
  const min = ampEnvConfigNormales.startLevel.min;
  const max = ampEnvConfigNormales.startLevel.max;
  if (
    fittedLevel < min - LOCALIZED_LEVEL_BOUNDARY_TOLERANCE ||
    fittedLevel > max + LOCALIZED_LEVEL_BOUNDARY_TOLERANCE
  ) {
    return null;
  }
  if (fittedLevel >= min && fittedLevel <= max) {
    return fit;
  }
  const startLevel = fittedLevel < min ? min : max;
  const scale = startLevel / fittedLevel;
  return {
    ...fit,
    sineCoefficient: fit.sineCoefficient * scale,
    cosineCoefficient: fit.cosineCoefficient * scale,
    startLevel,
  };
}

/** Превращает refit-квадратуры в уровень/фазу с тем же ulp-guard, что и raw. */
export function fitFromTwoCoefficients(
  coefficients: ArrayLike<number>,
): QuadratureFit | null {
  if (coefficients.length !== 2) {
    return null;
  }
  const sineCoefficient = coefficients[0] ?? 0;
  const cosineCoefficient = coefficients[1] ?? 0;
  const fittedLevel = Math.hypot(sineCoefficient, cosineCoefficient);
  const phase =
    ((Math.atan2(cosineCoefficient, sineCoefficient) %
      (2 * Math.PI)) +
      2 * Math.PI) %
    (2 * Math.PI);
  return canonicalizeLocalizedFitBoundary({
    sineCoefficient,
    cosineCoefficient,
    startLevel: fittedLevel,
    phase,
  });
}

function evaluateRawAndRefit(arg: {
  context: LocalizedExactContext;
  choice: LocalizedSlotChoice;
  description: LocalizedAtomDescription;
  cost: LocalizedTransientCost;
}): {
  raw: LocalizedExactCandidate | null;
  refit: LocalizedExactCandidate | null;
} {
  const basis = renderLocalizedBasis({
    description: arg.description,
    sampleCount: arg.context.target.length,
    phaseModel: arg.context.phaseModel,
  });
  arg.cost.unitBasisRenders += 2;
  const fits = fitQuadratureBlock({
    basis,
    target: arg.context.target,
    rawWithout: arg.choice.rawWithout,
  });
  const rawFit = fits?.[0];
  if (rawFit === undefined) {
    return { raw: null, refit: null };
  }
  const fit = canonicalizeLocalizedFitBoundary(rawFit);
  if (fit === null) {
    throw new Error(
      `Invalid localized fit: slot=${arg.choice.slot} stage=raw startLevel=${rawFit.startLevel}`,
    );
  }
  arg.cost.rawExactEvaluations += 1;
  arg.cost.exactEvaluations += 1;
  const raw = proposalFromExact({
    context: arg.context,
    choice: arg.choice,
    description: arg.description,
    fit,
    basis,
    kind: 'raw',
    clip: null,
    cost: arg.cost,
  });
  arg.cost.clipRefitEvaluations += 1;
  arg.cost.exactEvaluations += 1;
  const refitResult = refitClippedQuadratureAtom({
    basis,
    target: Float64Array.from(
      arg.context.target,
      (value) => value / MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    ),
    fixedOffset: arg.choice.rawWithout,
    initialCoefficients: [fit.sineCoefficient, fit.cosineCoefficient],
    maxIterations: LOCALIZED_TRANSIENT_LIMITS.maxClipIterations,
  });
  arg.cost.clipObjectiveEvaluations +=
    refitResult.audit.objectiveEvaluations;
  arg.cost.clipIterations += refitResult.audit.iterations;
  arg.cost.clipBacktracks += refitResult.audit.backtracks;
  const refitFit = fitFromTwoCoefficients(
    refitResult.objective.coefficients,
  );
  if (refitFit === null) {
    const invalidLevel = Math.hypot(
      refitResult.objective.coefficients[0] ?? Number.NaN,
      refitResult.objective.coefficients[1] ?? Number.NaN,
    );
    throw new Error(
      `Invalid localized fit: slot=${arg.choice.slot} stage=refit startLevel=${invalidLevel}`,
    );
  }
  const refit = proposalFromExact({
    context: arg.context,
    choice: arg.choice,
    description: arg.description,
    fit: refitFit,
    basis,
    kind: 'refit',
    clip: refitResult.audit,
    cost: arg.cost,
  });
  return { raw, refit };
}

function betterProposal(
  candidate: LocalizedProposalAudit,
  current: LocalizedProposalAudit | null,
): boolean {
  if (current === null) {
    return true;
  }
  const globalDelta =
    candidate.metrics.globalSuppressionPercent -
    current.metrics.globalSuppressionPercent;
  return (
    globalDelta > 1e-12 ||
    (Math.abs(globalDelta) <= 1e-12 &&
      candidate.metrics.windowedSuppressionPercent >
        current.metrics.windowedSuppressionPercent)
  );
}

function betterLocalizedExactCandidate(
  candidate: LocalizedExactCandidate,
  current: LocalizedExactCandidate | null,
): boolean {
  return betterProposal(candidate.audit, current?.audit ?? null);
}

/** Собирает unchanged DTO из клонов исходных patch/WAV и нулевых дельт. */
function createLocalizedFallback(arg: {
  state: RenderState;
  baselineTimeBands: ResidualTimeBandMap;
  baselineClipping: RawClippingReport;
  selectedCells: ResidualTimeBandCell[];
  slots: LocalizedSlotChoice[];
  attempts: LocalizedAttemptAudit[];
  proposedRaw: LocalizedProposalAudit | null;
  proposedRefit: LocalizedProposalAudit | null;
  cost: LocalizedTransientCost;
  rejectionReasons?: string[];
}): LocalizedTransientResult {
  return {
    status: 'unchanged',
    patch: clonePatch(arg.state.patch),
    samples: new Int16Array(arg.state.samples),
    baseline: arg.state.metrics,
    metrics: arg.state.metrics,
    baselineTimeBands: arg.baselineTimeBands,
    baselineClipping: arg.baselineClipping,
    selectedCells: arg.selectedCells,
    slots: arg.slots.map((choice) => ({
      slot: choice.slot,
      replacedFrequency: choice.replacedFrequency,
      globalAfterRemoval: choice.globalAfterRemoval,
    })),
    attempts: arg.attempts,
    proposedRaw: arg.proposedRaw,
    proposedRefit: arg.proposedRefit,
    saved: {
      status: 'unchanged',
      kind: null,
      description: null,
      slot: null,
      metrics: arg.state.metrics,
      globalDelta: 0,
      windowedDelta: 0,
      high: null,
      clipping: null,
      rejectionReasons: arg.rejectionReasons ?? [],
    },
    limits: LOCALIZED_TRANSIENT_LIMITS,
    cost: arg.cost,
    q4Pass: null,
  };
}

interface LocalizedFinalizationInput {
  winner: LocalizedExactCandidate | null;
  context: LocalizedExactContext;
  baselineTimeBands: ResidualTimeBandMap;
  baselineClipping: RawClippingReport;
  selectedCells: ResidualTimeBandCell[];
  slots: LocalizedSlotChoice[];
  attempts: LocalizedAttemptAudit[];
  proposedRaw: LocalizedProposalAudit | null;
  proposedRefit: LocalizedProposalAudit | null;
  cost: LocalizedTransientCost;
}

/** Собирает DTO только после успешного canonical guard. */
function createRefinedLocalizedResult(arg: {
  input: LocalizedFinalizationInput;
  winner: LocalizedExactCandidate;
  samples: Int16Array;
  evaluation: LocalizedProposalEvaluation;
}): LocalizedTransientResult {
  const { input, winner, samples, evaluation } = arg;
  const { metrics, before, after } = evaluation;
  return {
    status: 'refined',
    patch: winner.patch,
    samples,
    baseline: input.context.state.metrics,
    metrics,
    baselineTimeBands: input.baselineTimeBands,
    baselineClipping: input.baselineClipping,
    selectedCells: input.selectedCells,
    slots: input.slots.map((choice) => ({
      slot: choice.slot,
      replacedFrequency: choice.replacedFrequency,
      globalAfterRemoval: choice.globalAfterRemoval,
    })),
    attempts: input.attempts,
    proposedRaw: input.proposedRaw,
    proposedRefit: input.proposedRefit,
    saved: {
      status: 'refined',
      kind: winner.audit.kind,
      description: { ...winner.description },
      slot: winner.slot,
      metrics,
      globalDelta:
        metrics.globalSuppressionPercent -
        input.context.state.metrics.globalSuppressionPercent,
      windowedDelta:
        metrics.windowedSuppressionPercent -
        input.context.state.metrics.windowedSuppressionPercent,
      high: {
        selectedCellRssBefore: before.selectedCellRss,
        selectedCellRssAfter: after.selectedCellRss,
        totalHighRssBefore: before.totalHighRss,
        totalHighRssAfter: after.totalHighRss,
      },
      clipping: measureRawClipping({
        rawSum: winner.rawSum,
        target: input.context.target,
        samples,
      }),
      rejectionReasons: [],
    },
    limits: LOCALIZED_TRANSIENT_LIMITS,
    cost: input.cost,
    q4Pass: null,
  };
}

/**
 * Проверяет только первый exact-winner и при canonical отказе возвращает базу.
 * Другие accepted proposals намеренно не становятся следующим winner.
 */
export function finalizeLocalizedCandidate(
  arg: LocalizedFinalizationInput,
): LocalizedTransientResult {
  const fallback = (
    rejectionReasons: string[] = [],
  ): LocalizedTransientResult =>
    createLocalizedFallback({
      ...arg,
      state: arg.context.state,
      rejectionReasons,
    });
  if (arg.winner === null) {
    return fallback();
  }
  const winner = arg.winner;
  if (winner.patch.oscillators.length > MAX_OSCILLATORS) {
    throw new Error('Localized patch превысил 50 осцилляторов');
  }
  const samples = renderForTarget(
    winner.patch,
    arg.context.target.length,
    arg.context.phaseModel,
  );
  arg.cost.canonicalFinalRenders += 1;
  assertPatchMatchesWav(
    winner.patch,
    samples,
    arg.context.phaseModel,
    arg.context.sampleRate,
    arg.context.target.length,
  );
  const evaluation = evaluateLocalizedProposal({
    context: arg.context,
    description: winner.description,
    rawSum: winner.rawSum,
    samples,
    cost: arg.cost,
  });
  if (evaluation.rejectionReasons.length > 0) {
    return fallback(
      evaluation.rejectionReasons.map(
        (reason) => `canonical: ${reason}`,
      ),
    );
  }
  return createRefinedLocalizedResult({
    input: arg,
    winner,
    samples,
    evaluation,
  });
}

/** Выбирает до двух сильнейших непустых high-ячеек без изменения карты. */
export function selectHighResidualCells(
  map: ResidualTimeBandMap,
): ResidualTimeBandCell[] {
  return map.cells
    .filter(
      (cell) =>
        cell.name === 'high' &&
        cell.minHz === LOCALIZED_TRANSIENT_LIMITS.minHighHz &&
        cell.maxHz === LOCALIZED_TRANSIENT_LIMITS.maxHighHz &&
        cell.bandRss > 0,
    )
    .sort(
      (a, b) =>
        b.bandRss - a.bandRss || a.region.localeCompare(b.region),
    )
    .slice(0, LOCALIZED_TRANSIENT_LIMITS.maxCells);
}

/** Общие baseline-данные и ranked slots до выбора словаря и exact-оценок. */
export interface PreparedLocalizedContext {
  context: LocalizedExactContext;
  cost: LocalizedTransientCost;
  baselineClipping: RawClippingReport;
  selectedCells: ResidualTimeBandCell[];
  slots: LocalizedSlotChoice[];
  residual: Float64Array;
}

/**
 * Проверяет вход и один раз строит baseline, high-карту и ranked slots.
 * Порядок baseline-вычислений совпадает с исходным монолитным runner.
 */
export function prepareLocalizedContext(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
}): PreparedLocalizedContext {
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error(
      'Localized transient поддерживает только 44100 Гц',
    );
  }
  if (arg.target.length === 0) {
    throw new Error('Пустой target');
  }
  if (arg.patch.oscillators.length > MAX_OSCILLATORS) {
    throw new Error(
      'База localized transient превысила 50 осцилляторов',
    );
  }
  const target = Array.from(arg.target);
  const zone = computeUsefulZone(target, sampleRate);
  const state = createInitialState({
    patch: arg.patch,
    target,
    sampleRate,
    phaseModel,
    usefulZone: zone,
  });
  const cost = emptyCost();
  const baselineTimeBands = timeBandMapForSamples({
    target,
    samples: state.samples,
    sampleRate,
  });
  cost.timeBandMaps += 1;
  const baselineClipping = measureRawClipping({
    rawSum: state.rawSum,
    target,
    samples: state.samples,
  });
  const selectedCells = selectHighResidualCells(baselineTimeBands);
  const contributions = buildContributions(
    state.patch,
    target.length,
    phaseModel,
  );
  const slots = rankLocalizedHighSlots({
    state,
    contributions,
    target,
  });
  return {
    context: {
      state,
      target,
      sampleRate,
      phaseModel,
      zone,
      baselineTimeBands,
    },
    cost,
    baselineClipping,
    selectedCells,
    slots,
    residual: residualFromSamples(target, state.samples),
  };
}

/** Все exact DTO и единственный winner до его canonical проверки. */
export interface EvaluatedLocalizedCandidates {
  attempts: LocalizedAttemptAudit[];
  proposedRaw: LocalizedProposalAudit | null;
  proposedRefit: LocalizedProposalAudit | null;
  winner: LocalizedExactCandidate | null;
}

/**
 * Оценивает descriptions по ranked slots в прежнем порядке и выбирает одного
 * exact-winner. Canonical guard здесь намеренно ещё не выполняется.
 */
export function evaluateLocalizedCandidates(arg: {
  context: LocalizedExactContext;
  slots: LocalizedSlotChoice[];
  descriptions: LocalizedAtomDescription[];
  cost: LocalizedTransientCost;
}): EvaluatedLocalizedCandidates {
  const { context, slots, descriptions, cost } = arg;
  const attempts: LocalizedAttemptAudit[] = [];
  let proposedRaw: LocalizedProposalAudit | null = null;
  let proposedRefit: LocalizedProposalAudit | null = null;
  let winner: LocalizedExactCandidate | null = null;
  for (const choice of slots) {
    let rawOnSlot = 0;
    let clipOnSlot = 0;
    for (const description of descriptions) {
      if (
        rawOnSlot >= LOCALIZED_TRANSIENT_LIMITS.maxRawExactPerSlot ||
        cost.exactEvaluations >=
          LOCALIZED_TRANSIENT_LIMITS.maxExactPerSeed
      ) {
        break;
      }
      const evaluated = evaluateRawAndRefit({
        context,
        choice,
        description,
        cost,
      });
      if (evaluated.raw !== null) {
        rawOnSlot += 1;
      }
      if (evaluated.refit !== null) {
        clipOnSlot += 1;
      }
      if (
        clipOnSlot > LOCALIZED_TRANSIENT_LIMITS.maxRawExactPerSlot
      ) {
        throw new Error('Превышен предел clip refit на слот');
      }
      attempts.push({
        slot: choice.slot,
        replacedFrequency: choice.replacedFrequency,
        description: { ...description },
        raw: evaluated.raw?.audit ?? null,
        refit: evaluated.refit?.audit ?? null,
      });
      for (const candidate of [evaluated.raw, evaluated.refit]) {
        if (candidate === null) {
          continue;
        }
        if (candidate.audit.kind === 'raw') {
          if (betterProposal(candidate.audit, proposedRaw)) {
            proposedRaw = candidate.audit;
          }
        } else if (betterProposal(candidate.audit, proposedRefit)) {
          proposedRefit = candidate.audit;
        }
        if (
          candidate.audit.accepted &&
          betterLocalizedExactCandidate(candidate, winner)
        ) {
          winner = candidate;
        }
      }
    }
  }
  if (
    cost.exactEvaluations > LOCALIZED_TRANSIENT_LIMITS.maxExactPerSeed
  ) {
    throw new Error(
      'Превышен предел exact-оценок localized transient',
    );
  }
  return { attempts, proposedRaw, proposedRefit, winner };
}

/**
 * Подбирает не более одного localized high-only атома поверх готового A+B2.
 *
 * @param arg - Каноническая база, исходный target PCM и модель фазы
 * @returns Proposed raw/refit аудит и saved canonical patch/WAV; при любом
 *   проигрыше сохраняются исходные A+B2
 * @throws Error если target пуст, sample rate не 44100 Гц или база содержит
 *   больше 50 слотов
 * @remarks До двух сильнейших high-ячеек дают по четыре FFT-пика из
 *   локального rectangular-среза. Существующий envelope bank снабжает
 *   стационарные формы. Onset сканируется с шагом 1 мс в attack/early и 5 мс
 *   в body/tail; четыре лидера каждой ячейки уточняются до отсчёта. Варианты
 *   добавляют attack=0.5 мс, sweep ratio 0.5/2, stationary attack=0 и zero
 *   onset control. У каждого варианта freqBase и freqStart остаются внутри
 *   1–16 кГц; выход за границу отклоняет вариант без clamp. На каждом из не
 *   более чем двух слотов выполняются до четырёх raw exact и четырёх
 *   честных двухквадратурных clip refit. High guard обязателен для каждого
 *   accepted, J не может упасть ниже initial−0.05. Canonical guard проверяет
 *   только первого winner: при его отказе сохраняется база, а следующий
 *   accepted не продвигается. Поиск ограничен счётчиками, а не временем.
 */
export function runLocalizedTransientExperiment(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
}): LocalizedTransientResult {
  const prepared = prepareLocalizedContext(arg);
  const {
    context,
    cost,
    baselineClipping,
    selectedCells,
    slots,
    residual,
  } = prepared;
  const descriptions = selectLocalizedDescriptions({
    cells: selectedCells,
    residual,
    target: context.target,
    state: context.state,
    phaseModel: context.phaseModel,
    zone: context.zone,
    cost,
  });
  const evaluated = evaluateLocalizedCandidates({
    context,
    slots,
    descriptions,
    cost,
  });
  return finalizeLocalizedCandidate({
    ...evaluated,
    context,
    baselineTimeBands: context.baselineTimeBands,
    baselineClipping,
    selectedCells,
    slots,
    cost,
  });
}

/**
 * Проверяет заранее зафиксированный gate по фактически сохранённым WAV.
 */
export function localizedContinuationGate(
  runs: Array<{
    status: 'refined' | 'unchanged';
    savedGlobalDelta: number;
    savedWindowed: number;
    baselineWindowed: number;
    acceptedHighGuard: boolean;
  }>,
): {
  pass: boolean;
  runs: number;
  meanSavedGlobalDelta: number;
  improvedSeeds: number;
} {
  const meanSavedGlobalDelta =
    runs.length === 0
      ? 0
      : runs.reduce((sum, run) => sum + run.savedGlobalDelta, 0) /
        runs.length;
  const improvedSeeds = runs.filter(
    (run) => run.status === 'refined' && run.savedGlobalDelta > 0,
  ).length;
  const floorsHold = runs.every(
    (run) =>
      run.savedWindowed >=
        run.baselineWindowed -
          LOCALIZED_CONTINUATION_GATE.windowedFloorDelta &&
      run.acceptedHighGuard,
  );
  return {
    pass:
      runs.length === LOCALIZED_CONTINUATION_GATE.requiredRuns &&
      meanSavedGlobalDelta >=
        LOCALIZED_CONTINUATION_GATE.minMeanSavedGlobalDelta &&
      improvedSeeds >= LOCALIZED_CONTINUATION_GATE.minImprovedSeeds &&
      floorsHold,
    runs: runs.length,
    meanSavedGlobalDelta,
    improvedSeeds,
  };
}
