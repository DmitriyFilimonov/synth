/* eslint-disable no-console */
/**
 * Offline oracle независимого начала атома и диагностика клиппинга.
 * Модуль пишет только диагностический отчёт. Отдельный delayed-patch
 * runner превращает выбранный candidate в canonical patch/WAV. Это проверка
 * гипотезы для T36, не закон T35.
 *
 * npx tsx src/dataset/residual-onset-oracle.ts \
 *   --dataset datasets/ref --out datasets/onset-oracle \
 *   --slugs GrumU,BOg-Disco-Futuro
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import { fftMagnitudeSpectrum } from '../fft';
import {
  computeUsefulZone,
  type UsefulZone,
} from '../optimize/evaluate';
import { readWav } from '../read-wav';
import {
  createOscillatorGroup,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import type { WaveformBand, WaveformRegion } from '../waveform-bands';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  fitQuadratureBlock,
  rankSlotSets,
  type SlotSetChoice,
} from './block-pursuit';
import {
  buildContributions,
  buildPursuitDictionary,
  type AtomDescription,
} from './matching-pursuit';
import {
  createInitialState,
  measureMetrics,
  quantizeRaw,
  renderGroup,
  type QuadratureFit,
  type RefitMetrics,
  type RenderState,
} from './quadrature-refit';
import { withAttackBoost } from './quadrature-refit-run';
import {
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];
type CandidateMode = 'K1' | 'K2';

/** Пять полос, которые разделяют остаток без перекрытия границ. */
export const ONSET_ORACLE_BANDS: readonly WaveformBand[] = [
  { name: 'sub', minHz: 30, maxHz: 60 },
  { name: 'low', minHz: 60, maxHz: 100 },
  { name: 'upper', minHz: 100, maxHz: 300 },
  { name: 'mid', minHz: 300, maxHz: 1000 },
  { name: 'high', minHz: 1000, maxHz: 16000 },
];

/** Четыре неперекрывающихся участка от начала WAV. */
export const ONSET_ORACLE_REGIONS: readonly WaveformRegion[] = [
  { name: 'attack', startSec: 0, endSec: 0.02 },
  { name: 'early', startSec: 0.02, endSec: 0.1 },
  { name: 'body', startSec: 0.1, endSec: 0.2 },
  { name: 'tail', startSec: 0.2, endSec: 0.45 },
];

interface OnsetBasis {
  description: AtomDescription;
  delaySamples: number;
  sine: Float64Array;
  cosine: Float64Array;
}

interface FittedCandidate {
  mode: CandidateMode;
  slots: number[];
  atoms: OnsetBasis[];
  fits: QuadratureFit[];
  rawRss: number;
}

interface ExactEvaluation {
  candidate: FittedCandidate;
  metrics: RefitMetrics;
}

/** Результат сканирования одного описания атома. */
export interface AtomOnsetScan {
  zero: FittedCandidate | null;
  delayed: FittedCandidate | null;
  onsetEvaluations: number;
  quadratureFitEvaluations: number;
  basisRenders: number;
}

/** Одна ячейка ортогонального FFT-разложения остатка. */
export interface ResidualTimeBandCell extends WaveformBand {
  region: string;
  bandRss: number;
  residualRssShare: number | null;
  idealGlobalSuppressionPercent: number;
}

/** Верхняя оценка при идеальном удалении каждой FFT-ячейки. */
export interface ResidualTimeBandMap {
  targetRss: number;
  residualRss: number;
  cells: ResidualTimeBandCell[];
}

/** Клиппинг исходной необрезанной суммы и доля её отсчётов в RSS. */
export interface RawClippingReport {
  saturatedSamples: number;
  saturatedSampleFraction: number;
  clippedResidualRss: number;
  totalResidualRss: number;
  saturatedResidualRssShare: number | null;
}

interface CandidateAtomReport {
  slot: number;
  description: AtomDescription;
  delaySamples: number;
  delayMs: number;
  fit: QuadratureFit;
}

interface CandidateReport {
  mode: CandidateMode;
  slots: number[];
  atoms: CandidateAtomReport[];
  rawRss: number;
  rawRssGainAfterRemoval: number;
}

interface ExactReport {
  candidate: CandidateReport;
  metrics: RefitMetrics;
}

interface DelayedTheoreticalReport {
  candidate: CandidateReport;
  sameZero: CandidateReport | null;
  rawRssGainVsSameZero: number | null;
}

interface DelayedExactReport extends ExactReport {
  baselineGlobalDelta: number;
  baselineWindowedDelta: number;
  sameZero: ExactReport;
  globalDeltaVsSameZero: number;
  windowedDeltaVsSameZero: number;
}

interface AtomScanReport {
  descriptionIndex: number;
  description: AtomDescription;
  zero: CandidateReport | null;
  delayed: CandidateReport | null;
  rawRssGainVsSameZero: number | null;
}

interface SlotSetReport {
  mode: CandidateMode;
  slots: number[];
  rawRssAfterRemoval: number;
  bestZero: CandidateReport | null;
  bestDelayed: CandidateReport | null;
  exactPairIdentities: number;
  atoms: AtomScanReport[];
}

/** Стоимость одного независимого режима K1 или K2. */
export interface OnsetModeOracleCost {
  dictionaryLocalEvaluations: number;
  onsetEvaluations: number;
  scanFitEvaluations: number;
  jointFitEvaluations: number;
  exactEvaluations: number;
  exactPairIdentities: number;
  basisRenders: number;
  slotSetsEvaluated: number;
}

/** K1 и K2 не смешивают наборы слотов, exact-контроли и стоимость. */
export interface OnsetOracleCost {
  durationMs: number;
  k1: OnsetModeOracleCost;
  k2: OnsetModeOracleCost;
}

/** Результат одного готового match без production-артефактов. */
export interface ResidualOnsetOracleResult {
  diagnostic: 'residual-onset-oracle';
  baseline: RefitMetrics;
  bestTheoreticalZero: CandidateReport | null;
  bestTheoreticalDelayed: DelayedTheoreticalReport | null;
  bestExactZero: ExactReport | null;
  bestExactDelayed: DelayedExactReport | null;
  clipping: RawClippingReport;
  timeBands: ResidualTimeBandMap;
  slotSets: SlotSetReport[];
  cost: OnsetOracleCost;
  canonicalPatchWritten: false;
  canonicalWavWritten: false;
}

interface DatasetManifest {
  targetsDir: string;
  phaseModel?: PhaseModel;
  attackBoost?: number;
}

interface RunRecord {
  status: string;
  target: string;
  globalSuppressionPercent?: number | null;
}

interface OracleCliOptions {
  dataset: string;
  outDir: string;
  slugs: string[];
  maxOnsetMs: number;
}

interface SeedReport extends ResidualOnsetOracleResult {
  slug: string;
  seed: number;
  sourceRunDir: string;
  savedGlobalSuppressionPercent: number | null;
}

interface RunError {
  slug: string;
  seed: number;
  message: string;
}

interface TargetSummary {
  slug: string;
  runs: number;
  runsWithDelayedCandidate: number;
  meanDelayedGlobalDelta: number | null;
  meanDelayedVsSameZeroGlobalDelta: number | null;
  delayedBeatsBaseline: number;
  delayedBeatsSameZero: number;
  meanSaturatedSampleFraction: number;
}

interface OracleReport {
  version: 2;
  diagnostic: 'residual-onset-oracle';
  createdAt: string;
  dataset: string;
  phaseModel: PhaseModel;
  attackBoost: number;
  seeds: number[];
  maxOnsetMs: number;
  exactK2PairLimitPerSlotSet: number;
  finished: boolean;
  canonicalPatchWritten: false;
  canonicalWavWritten: false;
  errors: RunError[];
  runs: SeedReport[];
  summaries: TargetSummary[];
}

const DEFAULT_EXACT_K2_PAIRS = 8;
const DEFAULT_MAX_ONSET_SAMPLES = Math.round(0.2 * SAMPLE_RATE);
const DEFAULT_COARSE_STEP_SAMPLES = Math.round(SAMPLE_RATE / 1000);
const MAX_FFT_SAMPLES = 65536;

function dotRssDifference(
  target: ArrayLike<number>,
  rawWithout: ArrayLike<number>,
): number {
  let rss = 0;
  for (let index = 0; index < target.length; index += 1) {
    const residual =
      (target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      (rawWithout[index] ?? 0);
    rss += residual * residual;
  }
  return rss;
}

/**
 * Рендерит группу с независимым целым onset в отсчётах.
 *
 * @param arg - Группа, длина, модель фазы и необязательная задержка
 * @returns Нули до onset, затем обычный osc group с локального времени 0
 * @remarks Без `delaySamples` и при нулевой задержке функция напрямую
 *   вызывает `renderGroup`, поэтому PCM совпадает побайтово. Задержка,
 *   равная длине буфера, даёт нулевой буфер. Функция не меняет формат
 *   синтезатора и нужна только offline-диагностике.
 * @throws Error если длина или задержка нецелые либо отрицательные, либо
 *   задержка больше длины буфера
 */
export function renderDelayedGroup(arg: {
  group: OscillatorGroup;
  sampleCount: number;
  phaseModel: PhaseModel;
  delaySamples?: number;
}): Float64Array {
  const delay = arg.delaySamples ?? 0;
  if (!Number.isInteger(arg.sampleCount) || arg.sampleCount < 0) {
    throw new Error(
      'sampleCount должен быть целым и неотрицательным',
    );
  }
  if (
    !Number.isInteger(delay) ||
    delay < 0 ||
    delay > arg.sampleCount
  ) {
    throw new Error(
      'delaySamples должен быть целым от 0 до sampleCount',
    );
  }
  if (delay === 0) {
    return renderGroup(arg.group, arg.sampleCount, arg.phaseModel);
  }
  const synth = createOscillatorGroup(arg.group, {
    phaseModel: arg.phaseModel,
  });
  const result = new Float64Array(arg.sampleCount);
  for (let index = delay; index < arg.sampleCount; index += 1) {
    result[index] = synth({ x: (index - delay) / SAMPLE_RATE });
  }
  return result;
}

function shiftBasis(
  source: Float64Array,
  delaySamples: number,
): Float64Array {
  const shifted = new Float64Array(source.length);
  shifted.set(
    source.subarray(0, source.length - delaySamples),
    delaySamples,
  );
  return shifted;
}

function candidateRss(arg: {
  target: ArrayLike<number>;
  rawWithout: Float64Array;
  atoms: OnsetBasis[];
  fits: QuadratureFit[];
}): number {
  let rss = 0;
  for (let index = 0; index < arg.target.length; index += 1) {
    let generated = arg.rawWithout[index] ?? 0;
    for (
      let atomIndex = 0;
      atomIndex < arg.atoms.length;
      atomIndex += 1
    ) {
      const atom = arg.atoms[atomIndex];
      const fit = arg.fits[atomIndex];
      if (atom === undefined || fit === undefined) {
        continue;
      }
      generated +=
        fit.sineCoefficient * (atom.sine[index] ?? 0) +
        fit.cosineCoefficient * (atom.cosine[index] ?? 0);
    }
    const residual =
      (arg.target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      generated;
    rss += residual * residual;
  }
  return rss;
}

function fitCandidate(arg: {
  mode: CandidateMode;
  slots: number[];
  atoms: OnsetBasis[];
  target: ArrayLike<number>;
  rawWithout: Float64Array;
}): FittedCandidate | null {
  const basis = arg.atoms.flatMap((atom) => [atom.sine, atom.cosine]);
  const fits = fitQuadratureBlock({
    basis,
    target: arg.target,
    rawWithout: arg.rawWithout,
  });
  if (fits === null) {
    return null;
  }
  const rawRss = candidateRss({
    target: arg.target,
    rawWithout: arg.rawWithout,
    atoms: arg.atoms,
    fits,
  });
  return Number.isFinite(rawRss)
    ? {
        mode: arg.mode,
        slots: arg.slots,
        atoms: arg.atoms,
        fits,
        rawRss,
      }
    : null;
}

function betterRawCandidate(
  candidate: FittedCandidate | null,
  best: FittedCandidate | null,
): boolean {
  if (candidate === null) {
    return false;
  }
  if (best === null || candidate.rawRss < best.rawRss - 1e-15) {
    return true;
  }
  if (Math.abs(candidate.rawRss - best.rawRss) > 1e-15) {
    return false;
  }
  const candidateDelay = candidate.atoms.reduce(
    (sum, atom) => sum + atom.delaySamples,
    0,
  );
  const bestDelay = best.atoms.reduce(
    (sum, atom) => sum + atom.delaySamples,
    0,
  );
  return candidateDelay < bestDelay;
}

/**
 * Сканирует onset одного атома и сравнивает его с нулевой задержкой.
 *
 * @param arg - Описание общего словаря, target, сумма без слотов и границы
 *   поиска; по умолчанию скан идёт до 200 мс с грубым шагом около 1 мс
 * @returns Лучшие K1-кандидаты delay=0 и delay>0, а также стоимость
 * @remarks Сначала проверяются все грубые onset до `usefulEnd`, включая
 *   поздние пики. Затем окрестность лучшего ненулевого грубого onset
 *   проверяется с точностью до отсчёта. Каждый кандидат подгоняется через
 *   `fitQuadratureBlock` и сравнивается по полному raw RSS без клиппинга.
 * @throws Error если размеры не совпадают или параметры сетки некорректны
 */
export function scanAtomOnsets(arg: {
  description: AtomDescription;
  target: ArrayLike<number>;
  rawWithout: Float64Array;
  phaseModel: PhaseModel;
  usefulEnd: number;
  maxOnsetSamples?: number;
  coarseStepSamples?: number;
}): AtomOnsetScan {
  if (
    arg.target.length === 0 ||
    arg.target.length !== arg.rawWithout.length
  ) {
    throw new Error(
      'target и rawWithout должны иметь одну ненулевую длину',
    );
  }
  const maximum = arg.maxOnsetSamples ?? DEFAULT_MAX_ONSET_SAMPLES;
  const coarseStep =
    arg.coarseStepSamples ?? DEFAULT_COARSE_STEP_SAMPLES;
  if (!Number.isInteger(maximum) || maximum < 0) {
    throw new Error(
      'maxOnsetSamples должен быть целым и неотрицательным',
    );
  }
  if (!Number.isInteger(coarseStep) || coarseStep < 1) {
    throw new Error(
      'coarseStepSamples должен быть положительным целым',
    );
  }
  const sampleCount = arg.target.length;
  const maxDelay = Math.min(
    sampleCount - 1,
    maximum,
    Math.max(0, Math.floor(arg.usefulEnd)),
  );
  const template = {
    description: arg.description,
    sine: renderDelayedGroup({
      group: groupForBasis(arg.description, 0),
      sampleCount,
      phaseModel: arg.phaseModel,
    }),
    cosine: renderDelayedGroup({
      group: groupForBasis(arg.description, Math.PI / 2),
      sampleCount,
      phaseModel: arg.phaseModel,
    }),
  };
  const zeroAtom: OnsetBasis = {
    description: arg.description,
    delaySamples: 0,
    sine: template.sine,
    cosine: template.cosine,
  };
  const zero = fitCandidate({
    mode: 'K1',
    slots: [],
    atoms: [zeroAtom],
    target: arg.target,
    rawWithout: arg.rawWithout,
  });
  let delayed: FittedCandidate | null = null;
  let bestCoarse: FittedCandidate | null = null;
  let bestCoarseDelay = 0;
  let onsetEvaluations = 1;
  let quadratureFitEvaluations = 1;
  let basisRenders = 2;
  const tried = new Set<number>([0]);
  const evaluateDelay = (
    delaySamples: number,
    coarse: boolean,
  ): void => {
    if (
      delaySamples <= 0 ||
      delaySamples > maxDelay ||
      tried.has(delaySamples)
    ) {
      return;
    }
    tried.add(delaySamples);
    const atom: OnsetBasis = {
      description: arg.description,
      delaySamples,
      sine: shiftBasis(template.sine, delaySamples),
      cosine: shiftBasis(template.cosine, delaySamples),
    };
    basisRenders += 2;
    onsetEvaluations += 1;
    quadratureFitEvaluations += 1;
    const candidate = fitCandidate({
      mode: 'K1',
      slots: [],
      atoms: [atom],
      target: arg.target,
      rawWithout: arg.rawWithout,
    });
    if (betterRawCandidate(candidate, delayed)) {
      delayed = candidate;
    }
    if (coarse && betterRawCandidate(candidate, bestCoarse)) {
      bestCoarse = candidate;
      bestCoarseDelay = delaySamples;
    }
  };
  for (
    let delay = coarseStep;
    delay <= maxDelay;
    delay += coarseStep
  ) {
    evaluateDelay(delay, true);
  }
  if (maxDelay > 0) {
    evaluateDelay(maxDelay, true);
  }
  if (bestCoarseDelay > 0) {
    const start = Math.max(1, bestCoarseDelay - coarseStep);
    const end = Math.min(maxDelay, bestCoarseDelay + coarseStep);
    for (let delay = start; delay <= end; delay += 1) {
      evaluateDelay(delay, false);
    }
  }
  return {
    zero,
    delayed,
    onsetEvaluations,
    quadratureFitEvaluations,
    basisRenders,
  };
}

function groupForBasis(
  description: AtomDescription,
  phase: number,
): OscillatorGroup {
  return {
    osc: {
      on: true,
      freqBase: description.frequency,
      freqStart: description.freqStart,
      duration: description.oscDuration,
      slope: description.oscSlope,
      phase,
    },
    ampEnv: {
      startLevel: 1,
      endLevel: 0.001,
      duration: description.duration,
      slope: description.slope,
    },
  };
}

/**
 * Складывает квадратуры и применяет ровно production-клиппинг и PCM.
 *
 * @param arg - Сумма без атомов, sine/cosine-базисы и их коэффициенты
 * @returns Необрезанная сумма и диагностический quantized PCM
 * @remarks Oracle не сохраняет этот PCM как WAV. Delayed-patch runner
 *   отдельно строит тот же сигнал через canonical render. Клиппинг здесь
 *   обязателен, чтобы насыщенная сумма не получила неверный global.
 * @throws Error если базисы и коэффициенты несовместимы по размеру
 */
export function renderClippedQuadrature(arg: {
  rawWithout: ArrayLike<number>;
  basis: Float64Array[];
  fits: QuadratureFit[];
}): { rawSum: Float64Array; samples: Int16Array } {
  if (
    arg.fits.length < 1 ||
    arg.fits.length > 2 ||
    arg.basis.length !== arg.fits.length * 2 ||
    arg.basis.some((basis) => basis.length !== arg.rawWithout.length)
  ) {
    throw new Error('Несовместимые размеры quadrature candidate');
  }
  const rawSum = Float64Array.from(arg.rawWithout);
  for (
    let atomIndex = 0;
    atomIndex < arg.fits.length;
    atomIndex += 1
  ) {
    const fit = arg.fits[atomIndex];
    const sine = arg.basis[atomIndex * 2];
    const cosine = arg.basis[atomIndex * 2 + 1];
    if (
      fit === undefined ||
      sine === undefined ||
      cosine === undefined
    ) {
      throw new Error('Неполный quadrature candidate');
    }
    for (let index = 0; index < rawSum.length; index += 1) {
      rawSum[index] =
        (rawSum[index] ?? 0) +
        fit.sineCoefficient * (sine[index] ?? 0) +
        fit.cosineCoefficient * (cosine[index] ?? 0);
    }
  }
  return { rawSum, samples: quantizeRaw(rawSum) };
}

function evaluateExact(arg: {
  candidate: FittedCandidate;
  rawWithout: Float64Array;
  target: number[];
  sampleRate: number;
  zone: UsefulZone;
}): ExactEvaluation {
  const rendered = renderClippedQuadrature({
    rawWithout: arg.rawWithout,
    basis: arg.candidate.atoms.flatMap((atom) => [
      atom.sine,
      atom.cosine,
    ]),
    fits: arg.candidate.fits,
  });
  return {
    candidate: arg.candidate,
    metrics: measureMetrics(
      rendered.samples,
      arg.target,
      arg.sampleRate,
      arg.zone,
    ),
  };
}

/**
 * Измеряет долю насыщенных отсчётов и их вклад в canonical residual RSS.
 *
 * @param arg - Необрезанная сумма исходного match, target и его PCM
 * @returns Число и доля `|rawSum| > 1`; доля RSS равна `null` при нулевом
 *   полном остатке
 * @remarks RSS считается по фактическому clipped/quantized match, а не по
 *   необрезанной сумме. Поэтому доля показывает, сколько видимой ошибки
 *   исходного WAV лежит на насыщенных отсчётах.
 * @throws Error если длины входов различаются или буфер пуст
 */
export function measureRawClipping(arg: {
  rawSum: ArrayLike<number>;
  target: ArrayLike<number>;
  samples: ArrayLike<number>;
}): RawClippingReport {
  if (
    arg.rawSum.length === 0 ||
    arg.rawSum.length !== arg.target.length ||
    arg.rawSum.length !== arg.samples.length
  ) {
    throw new Error(
      'rawSum, target и samples должны иметь одну ненулевую длину',
    );
  }
  let saturatedSamples = 0;
  let clippedResidualRss = 0;
  let totalResidualRss = 0;
  for (let index = 0; index < arg.rawSum.length; index += 1) {
    const saturated = Math.abs(arg.rawSum[index] ?? 0) > 1;
    const residual =
      ((arg.target[index] ?? 0) - (arg.samples[index] ?? 0)) /
      MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
    const square = residual * residual;
    totalResidualRss += square;
    if (saturated) {
      saturatedSamples += 1;
      clippedResidualRss += square;
    }
  }
  return {
    saturatedSamples,
    saturatedSampleFraction: saturatedSamples / arg.rawSum.length,
    clippedResidualRss,
    totalResidualRss,
    saturatedResidualRssShare:
      totalResidualRss > 0
        ? clippedResidualRss / totalResidualRss
        : null,
  };
}

/**
 * Считает global после идеального вычитания заданной доли residual RSS.
 *
 * @param arg - Полный target RSS, residual RSS и удаляемый RSS ячейки
 * @returns RMS-based suppression в процентах
 * @remarks Это алгебраическая верхняя оценка внутри выбранного разложения,
 *   а не обещание физически реализуемого атома. Удаляемый RSS ограничен
 *   полным residual RSS, чтобы ошибка округления не давала корень из минуса.
 * @throws Error если энергии отрицательны, нефинитны или target тихий
 */
export function idealGlobalAfterRemovingRss(arg: {
  targetRss: number;
  residualRss: number;
  removedRss: number;
}): number {
  if (
    !Number.isFinite(arg.targetRss) ||
    !Number.isFinite(arg.residualRss) ||
    !Number.isFinite(arg.removedRss) ||
    arg.targetRss <= 0 ||
    arg.residualRss < 0 ||
    arg.removedRss < 0
  ) {
    throw new Error(
      'RSS должен быть конечным, targetRss положительным',
    );
  }
  const remaining = Math.max(
    0,
    arg.residualRss - Math.min(arg.residualRss, arg.removedRss),
  );
  return 100 * (1 - Math.sqrt(remaining / arg.targetRss));
}

/**
 * Строит время-полосовую карту canonical residual и её ideal upper bound.
 *
 * @param arg - Остаток в полной шкале, target PCM, sample rate и необязательные
 *   неперекрывающиеся участки/полосы
 * @returns RSS каждой ячейки, её доля полного остатка и global после её
 *   идеального удаления
 * @remarks Для каждого участка используется прямоугольное окно и Parseval:
 *   `bandRss = 2 * fftSize * sum(magnitude²)`. Поэтому энергию ячейки можно
 *   вычитать из полного residual RSS без смешивания шкал. Полосы вне 30 Гц–16
 *   кГц остаются в остатке. Оценка не описывает физический фильтр или закон.
 * @throws Error если длины не совпадают, target тихий, участок некорректен
 *   или требует больше 65536 точек FFT
 */
export function buildResidualTimeBandMap(arg: {
  residual: ArrayLike<number>;
  target: ArrayLike<number>;
  sampleRate: number;
  bands?: readonly WaveformBand[];
  regions?: readonly WaveformRegion[];
}): ResidualTimeBandMap {
  if (
    arg.residual.length === 0 ||
    arg.residual.length !== arg.target.length ||
    !Number.isFinite(arg.sampleRate) ||
    arg.sampleRate <= 0
  ) {
    throw new Error('Некорректные residual, target или sampleRate');
  }
  const bands = arg.bands ?? ONSET_ORACLE_BANDS;
  const regions = arg.regions ?? ONSET_ORACLE_REGIONS;
  let targetRss = 0;
  let residualRss = 0;
  for (let index = 0; index < arg.residual.length; index += 1) {
    const target =
      (arg.target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
    const residual = arg.residual[index] ?? 0;
    targetRss += target * target;
    residualRss += residual * residual;
  }
  if (targetRss <= 0) {
    throw new Error('time-band map не поддерживает тихий target');
  }
  const cells: ResidualTimeBandCell[] = [];
  for (const region of regions) {
    if (
      !Number.isFinite(region.startSec) ||
      !Number.isFinite(region.endSec) ||
      region.startSec < 0 ||
      region.endSec <= region.startSec
    ) {
      throw new Error(`Некорректный участок ${region.name}`);
    }
    const start = Math.round(region.startSec * arg.sampleRate);
    const length = Math.round(
      (region.endSec - region.startSec) * arg.sampleRate,
    );
    if (length < 4 || length > MAX_FFT_SAMPLES) {
      throw new Error(`Некорректная длина участка ${region.name}`);
    }
    const window = new Float64Array(length);
    for (let index = 0; index < length; index += 1) {
      window[index] = arg.residual[start + index] ?? 0;
    }
    const { magnitudes, fftSize } = fftMagnitudeSpectrum(window);
    for (const band of bands) {
      if (
        !Number.isFinite(band.minHz) ||
        !Number.isFinite(band.maxHz) ||
        band.minHz <= 0 ||
        band.maxHz <= band.minHz
      ) {
        throw new Error(`Некорректная полоса ${band.name}`);
      }
      let spectralRss = 0;
      for (let bin = 1; bin < magnitudes.length; bin += 1) {
        const frequency = (bin * arg.sampleRate) / fftSize;
        if (frequency >= band.minHz && frequency < band.maxHz) {
          const magnitude = magnitudes[bin] ?? 0;
          spectralRss += magnitude * magnitude;
        }
      }
      const bandRss = 2 * fftSize * spectralRss;
      cells.push({
        region: region.name,
        ...band,
        bandRss,
        residualRssShare:
          residualRss > 0 ? bandRss / residualRss : null,
        idealGlobalSuppressionPercent: idealGlobalAfterRemovingRss({
          targetRss,
          residualRss,
          removedRss: bandRss,
        }),
      });
    }
  }
  return { targetRss, residualRss, cells };
}

function withSlots(
  candidate: FittedCandidate | null,
  slots: number[],
): FittedCandidate | null {
  if (candidate === null) {
    return null;
  }
  return {
    ...candidate,
    slots: slots.slice(0, candidate.atoms.length),
  };
}

function candidateReport(
  candidate: FittedCandidate,
  rawRssAfterRemoval: number,
): CandidateReport {
  return {
    mode: candidate.mode,
    slots: [...candidate.slots],
    atoms: candidate.atoms.map((atom, index) => ({
      slot: candidate.slots[index] ?? -1,
      description: { ...atom.description },
      delaySamples: atom.delaySamples,
      delayMs: (1000 * atom.delaySamples) / SAMPLE_RATE,
      fit: {
        ...(candidate.fits[index] ?? {
          sineCoefficient: 0,
          cosineCoefficient: 0,
          startLevel: 0,
          phase: 0,
        }),
      },
    })),
    rawRss: candidate.rawRss,
    rawRssGainAfterRemoval: rawRssAfterRemoval - candidate.rawRss,
  };
}

function exactReport(
  exact: ExactEvaluation,
  rawRssAfterRemoval: number,
): ExactReport {
  return {
    candidate: candidateReport(exact.candidate, rawRssAfterRemoval),
    metrics: exact.metrics,
  };
}

function betterExact(
  candidate: ExactEvaluation,
  best: ExactEvaluation | null,
): boolean {
  if (best === null) {
    return true;
  }
  const globalDelta =
    candidate.metrics.globalSuppressionPercent -
    best.metrics.globalSuppressionPercent;
  return (
    globalDelta > 1e-12 ||
    (Math.abs(globalDelta) <= 1e-12 &&
      (candidate.metrics.windowedSuppressionPercent >
        best.metrics.windowedSuppressionPercent + 1e-12 ||
        (Math.abs(
          candidate.metrics.windowedSuppressionPercent -
            best.metrics.windowedSuppressionPercent,
        ) <= 1e-12 &&
          candidate.candidate.rawRss < best.candidate.rawRss)))
  );
}

function candidateBaselineRss(
  candidate: FittedCandidate,
  baselines: Map<FittedCandidate, number>,
): number {
  return baselines.get(candidate) ?? candidate.rawRss;
}

function delayedTheoreticalReport(
  candidate: FittedCandidate,
  pairedZero: Map<FittedCandidate, FittedCandidate | null>,
  baselines: Map<FittedCandidate, number>,
): DelayedTheoreticalReport {
  const zero = pairedZero.get(candidate) ?? null;
  return {
    candidate: candidateReport(
      candidate,
      candidateBaselineRss(candidate, baselines),
    ),
    sameZero:
      zero === null
        ? null
        : candidateReport(
            zero,
            candidateBaselineRss(zero, baselines),
          ),
    rawRssGainVsSameZero:
      zero === null ? null : zero.rawRss - candidate.rawRss,
  };
}

function delayedExactReport(arg: {
  exact: ExactEvaluation;
  pairedZero: Map<FittedCandidate, FittedCandidate | null>;
  exactByCandidate: Map<FittedCandidate, ExactEvaluation>;
  baselines: Map<FittedCandidate, number>;
  baseline: RefitMetrics;
}): DelayedExactReport {
  const baselineRss = candidateBaselineRss(
    arg.exact.candidate,
    arg.baselines,
  );
  const zero = arg.pairedZero.get(arg.exact.candidate) ?? null;
  const zeroExact =
    zero === null ? undefined : arg.exactByCandidate.get(zero);
  if (zeroExact === undefined) {
    throw new Error(
      'Delayed exact candidate потерял paired zero control',
    );
  }
  return {
    ...exactReport(arg.exact, baselineRss),
    baselineGlobalDelta:
      arg.exact.metrics.globalSuppressionPercent -
      arg.baseline.globalSuppressionPercent,
    baselineWindowedDelta:
      arg.exact.metrics.windowedSuppressionPercent -
      arg.baseline.windowedSuppressionPercent,
    sameZero: exactReport(
      zeroExact,
      candidateBaselineRss(zeroExact.candidate, arg.baselines),
    ),
    globalDeltaVsSameZero:
      arg.exact.metrics.globalSuppressionPercent -
      zeroExact.metrics.globalSuppressionPercent,
    windowedDeltaVsSameZero:
      arg.exact.metrics.windowedSuppressionPercent -
      zeroExact.metrics.windowedSuppressionPercent,
  };
}

interface ProcessSlotSetArg {
  mode: CandidateMode;
  choice: SlotSetChoice;
  patch: ArgCreateSynth;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  zone: UsefulZone;
  maxOnsetSamples: number;
  coarseStepSamples: number;
  exactPairLimit: number;
}

interface SlotSetScanResult {
  rawRssAfterRemoval: number;
  dictionary: ReturnType<typeof buildPursuitDictionary>;
  scans: AtomOnsetScan[];
  zeroSingles: (FittedCandidate | null)[];
  delayedSingles: (FittedCandidate | null)[];
}

interface PairRecord {
  zero: FittedCandidate | null;
  delayed: FittedCandidate;
}

interface ModeCandidatesResult {
  zeroCandidates: FittedCandidate[];
  delayedCandidates: FittedCandidate[];
  pairedZero: Map<FittedCandidate, FittedCandidate | null>;
  baselines: Map<FittedCandidate, number>;
  pairRecords: PairRecord[];
  jointFitEvaluations: number;
}

interface ExactSlotSetResult {
  exactZero: ExactEvaluation[];
  exactDelayed: ExactEvaluation[];
  exactByCandidate: Map<FittedCandidate, ExactEvaluation>;
  exactPairIdentities: number;
}

interface ProcessSlotSetResult {
  report: SlotSetReport;
  zeroCandidates: FittedCandidate[];
  delayedCandidates: FittedCandidate[];
  exactZero: ExactEvaluation[];
  exactDelayed: ExactEvaluation[];
  pairedZero: Map<FittedCandidate, FittedCandidate | null>;
  baselines: Map<FittedCandidate, number>;
  cost: OnsetModeOracleCost;
}

/** Строит словарь и сканирует onset каждого описания одного набора слотов. */
function scanSlotSetDictionary(
  arg: ProcessSlotSetArg,
): SlotSetScanResult {
  const rawRssAfterRemoval = dotRssDifference(
    arg.target,
    arg.choice.rawWithout,
  );
  const withoutSamples = quantizeRaw(arg.choice.rawWithout);
  const searchResidual = Float64Array.from(
    arg.target,
    (value, index) =>
      (value - (withoutSamples[index] ?? 0)) /
      MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  );
  const dictionary = buildPursuitDictionary({
    patch: arg.patch,
    residual: searchResidual,
    zone: arg.zone,
    phaseModel: arg.phaseModel,
    diverseShortlist: true,
  });
  const scans = dictionary.descriptions.map((description) =>
    scanAtomOnsets({
      description,
      target: arg.target,
      rawWithout: arg.choice.rawWithout,
      phaseModel: arg.phaseModel,
      usefulEnd: arg.zone.end,
      maxOnsetSamples: arg.maxOnsetSamples,
      coarseStepSamples: arg.coarseStepSamples,
    }),
  );
  return {
    rawRssAfterRemoval,
    dictionary,
    scans,
    zeroSingles: scans.map((scan) =>
      withSlots(scan.zero, arg.choice.slots),
    ),
    delayedSingles: scans.map((scan) =>
      withSlots(scan.delayed, arg.choice.slots),
    ),
  };
}

/** Совместно подгоняет два одиночных кандидата в одной паре слотов. */
function fitK2Pair(arg: {
  first: FittedCandidate | null;
  second: FittedCandidate | null;
  choice: SlotSetChoice;
  target: number[];
}): FittedCandidate | null {
  if (arg.first === null || arg.second === null) {
    return null;
  }
  const firstAtom = arg.first.atoms[0];
  const secondAtom = arg.second.atoms[0];
  if (firstAtom === undefined || secondAtom === undefined) {
    return null;
  }
  return withSlots(
    fitCandidate({
      mode: 'K2',
      slots: arg.choice.slots,
      atoms: [firstAtom, secondAtom],
      target: arg.target,
      rawWithout: arg.choice.rawWithout,
    }),
    arg.choice.slots,
  );
}

/** Формирует K1, both-delayed и mixed K2-пары с общим paired zero. */
function buildModeCandidates(
  arg: ProcessSlotSetArg,
  scanned: SlotSetScanResult,
): ModeCandidatesResult {
  const pairedZero = new Map<
    FittedCandidate,
    FittedCandidate | null
  >();
  const baselines = new Map<FittedCandidate, number>();
  const zeroCandidates: FittedCandidate[] = [];
  const delayedCandidates: FittedCandidate[] = [];
  if (arg.mode === 'K1') {
    for (let index = 0; index < scanned.scans.length; index += 1) {
      const zero = scanned.zeroSingles[index] ?? null;
      const delayed = scanned.delayedSingles[index] ?? null;
      if (zero !== null) {
        zeroCandidates.push(zero);
        baselines.set(zero, scanned.rawRssAfterRemoval);
      }
      if (delayed !== null) {
        delayedCandidates.push(delayed);
        pairedZero.set(delayed, zero);
        baselines.set(delayed, scanned.rawRssAfterRemoval);
      }
    }
  }
  let jointFitEvaluations = 0;
  const pairRecords: PairRecord[] = [];
  if (arg.mode === 'K2') {
    for (let first = 0; first < scanned.scans.length; first += 1) {
      for (
        let second = first + 1;
        second < scanned.scans.length;
        second += 1
      ) {
        const firstScan = scanned.scans[first];
        const secondScan = scanned.scans[second];
        if (firstScan === undefined || secondScan === undefined) {
          continue;
        }
        let zero: FittedCandidate | null = null;
        if (firstScan.zero !== null && secondScan.zero !== null) {
          jointFitEvaluations += 1;
          zero = fitK2Pair({
            first: firstScan.zero,
            second: secondScan.zero,
            choice: arg.choice,
            target: arg.target,
          });
          if (zero !== null) {
            zeroCandidates.push(zero);
            baselines.set(zero, scanned.rawRssAfterRemoval);
          }
        }
        const pairs = [
          [firstScan.delayed, secondScan.delayed],
          [firstScan.delayed, secondScan.zero],
          [firstScan.zero, secondScan.delayed],
        ] as const;
        for (const [firstCandidate, secondCandidate] of pairs) {
          if (firstCandidate === null || secondCandidate === null) {
            continue;
          }
          jointFitEvaluations += 1;
          const delayed = fitK2Pair({
            first: firstCandidate,
            second: secondCandidate,
            choice: arg.choice,
            target: arg.target,
          });
          if (delayed !== null) {
            delayedCandidates.push(delayed);
            pairedZero.set(delayed, zero);
            baselines.set(delayed, scanned.rawRssAfterRemoval);
            pairRecords.push({ zero, delayed });
          }
        }
      }
    }
  }
  return {
    zeroCandidates,
    delayedCandidates,
    pairedZero,
    baselines,
    pairRecords,
    jointFitEvaluations,
  };
}

/** Выполняет exact-оценки с обязательным paired zero и лимитом K2. */
function evaluateSlotSetExact(
  arg: ProcessSlotSetArg,
  candidates: ModeCandidatesResult,
  scanned: SlotSetScanResult,
): ExactSlotSetResult {
  candidates.pairRecords.sort(
    (a, b) => a.delayed.rawRss - b.delayed.rawRss,
  );
  const exactPairs =
    arg.mode === 'K2'
      ? candidates.pairRecords.slice(0, arg.exactPairLimit)
      : [];
  const exactZero: ExactEvaluation[] = [];
  const exactDelayed: ExactEvaluation[] = [];
  const exactByCandidate = new Map<
    FittedCandidate,
    ExactEvaluation
  >();
  const evaluate = (candidate: FittedCandidate | null): boolean => {
    if (candidate === null) {
      return false;
    }
    if (exactByCandidate.has(candidate)) {
      return true;
    }
    if (candidate.atoms.some((atom) => atom.delaySamples > 0)) {
      const zero = candidates.pairedZero.get(candidate) ?? null;
      if (zero === null || !evaluate(zero)) {
        return false;
      }
    }
    const exact = evaluateExact({
      candidate,
      rawWithout: arg.choice.rawWithout,
      target: arg.target,
      sampleRate: arg.sampleRate,
      zone: arg.zone,
    });
    exactByCandidate.set(candidate, exact);
    if (candidate.atoms.some((atom) => atom.delaySamples > 0)) {
      exactDelayed.push(exact);
    } else {
      exactZero.push(exact);
    }
    return true;
  };
  if (arg.mode === 'K1') {
    let bestZeroSingle: FittedCandidate | null = null;
    let bestDelayedSingle: FittedCandidate | null = null;
    for (const candidate of scanned.zeroSingles) {
      if (betterRawCandidate(candidate, bestZeroSingle)) {
        bestZeroSingle = candidate;
      }
    }
    for (const candidate of scanned.delayedSingles) {
      if (betterRawCandidate(candidate, bestDelayedSingle)) {
        bestDelayedSingle = candidate;
      }
    }
    evaluate(bestZeroSingle);
    evaluate(bestDelayedSingle);
  }
  let exactPairIdentities = 0;
  for (const pair of exactPairs) {
    if (evaluate(pair.delayed)) {
      exactPairIdentities += 1;
    }
  }
  return {
    exactZero,
    exactDelayed,
    exactByCandidate,
    exactPairIdentities,
  };
}

/** Выбирает theoretical-победителей и собирает отчёт и стоимость набора. */
function buildSlotSetReport(
  arg: ProcessSlotSetArg,
  scanned: SlotSetScanResult,
  candidates: ModeCandidatesResult,
  exact: ExactSlotSetResult,
): ProcessSlotSetResult {
  let bestZero: FittedCandidate | null = null;
  let bestDelayed: FittedCandidate | null = null;
  for (const candidate of candidates.zeroCandidates) {
    if (betterRawCandidate(candidate, bestZero)) {
      bestZero = candidate;
    }
  }
  for (const candidate of candidates.delayedCandidates) {
    if (betterRawCandidate(candidate, bestDelayed)) {
      bestDelayed = candidate;
    }
  }
  const atomReports =
    arg.mode === 'K1'
      ? scanned.scans.map((scan, descriptionIndex) => {
          const zero = scanned.zeroSingles[descriptionIndex] ?? null;
          const delayed =
            scanned.delayedSingles[descriptionIndex] ?? null;
          return {
            descriptionIndex,
            description: {
              ...(scanned.dictionary.descriptions[
                descriptionIndex
              ] ?? {
                frequency: 0,
                freqStart: 0,
                duration: 0,
                slope: 0,
                oscDuration: 0,
                oscSlope: 0,
                window: 'full' as const,
                localGain: 0,
                peakMagnitude: 0,
                sweepTemplateIndex: null,
              }),
            },
            zero:
              zero === null
                ? null
                : candidateReport(zero, scanned.rawRssAfterRemoval),
            delayed:
              delayed === null
                ? null
                : candidateReport(
                    delayed,
                    scanned.rawRssAfterRemoval,
                  ),
            rawRssGainVsSameZero:
              zero === null || delayed === null
                ? null
                : zero.rawRss - delayed.rawRss,
          };
        })
      : [];
  const scanCost = scanned.scans.reduce(
    (total, scan) => ({
      onsetEvaluations:
        total.onsetEvaluations + scan.onsetEvaluations,
      scanFitEvaluations:
        total.scanFitEvaluations + scan.quadratureFitEvaluations,
      basisRenders: total.basisRenders + scan.basisRenders,
    }),
    { onsetEvaluations: 0, scanFitEvaluations: 0, basisRenders: 0 },
  );
  return {
    report: {
      mode: arg.mode,
      slots: [...arg.choice.slots],
      rawRssAfterRemoval: scanned.rawRssAfterRemoval,
      bestZero:
        bestZero === null
          ? null
          : candidateReport(bestZero, scanned.rawRssAfterRemoval),
      bestDelayed:
        bestDelayed === null
          ? null
          : candidateReport(bestDelayed, scanned.rawRssAfterRemoval),
      exactPairIdentities: exact.exactPairIdentities,
      atoms: atomReports,
    },
    zeroCandidates: candidates.zeroCandidates,
    delayedCandidates: candidates.delayedCandidates,
    exactZero: exact.exactZero,
    exactDelayed: exact.exactDelayed,
    pairedZero: candidates.pairedZero,
    baselines: candidates.baselines,
    cost: {
      dictionaryLocalEvaluations: scanned.dictionary.localEvaluations,
      onsetEvaluations: scanCost.onsetEvaluations,
      scanFitEvaluations: scanCost.scanFitEvaluations,
      jointFitEvaluations: candidates.jointFitEvaluations,
      exactEvaluations: exact.exactByCandidate.size,
      exactPairIdentities: exact.exactPairIdentities,
      basisRenders: scanCost.basisRenders,
      slotSetsEvaluated: 1,
    },
  };
}

/** Связывает четыре этапа обработки одного набора слотов. */
function processSlotSet(
  arg: ProcessSlotSetArg,
): ProcessSlotSetResult {
  const scanned = scanSlotSetDictionary(arg);
  const candidates = buildModeCandidates(arg, scanned);
  const exact = evaluateSlotSetExact(arg, candidates, scanned);
  return buildSlotSetReport(arg, scanned, candidates, exact);
}

function mergeMaps<T, U>(target: Map<T, U>, source: Map<T, U>): void {
  for (const [key, value] of source) {
    target.set(key, value);
  }
}

function emptyModeCost(): OnsetModeOracleCost {
  return {
    dictionaryLocalEvaluations: 0,
    onsetEvaluations: 0,
    scanFitEvaluations: 0,
    jointFitEvaluations: 0,
    exactEvaluations: 0,
    exactPairIdentities: 0,
    basisRenders: 0,
    slotSetsEvaluated: 0,
  };
}

function addModeCost(
  target: OnsetModeOracleCost,
  source: OnsetModeOracleCost,
): void {
  for (const key of Object.keys(
    target,
  ) as (keyof OnsetModeOracleCost)[]) {
    target[key] += source[key];
  }
}

interface OracleOptions {
  patch: ArgCreateSynth;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  exactPairLimit: number;
  maxOnsetSamples: number;
  coarseStepSamples: number;
}

interface OracleContext {
  initial: RenderState;
  zone: UsefulZone;
  contributions: (Float64Array | null)[];
  choices: { mode: CandidateMode; choice: SlotSetChoice }[];
}

interface CollectedOracleResults {
  zeroCandidates: FittedCandidate[];
  delayedCandidates: FittedCandidate[];
  exactZero: ExactEvaluation[];
  exactDelayed: ExactEvaluation[];
  pairedZero: Map<FittedCandidate, FittedCandidate | null>;
  baselines: Map<FittedCandidate, number>;
  exactByCandidate: Map<FittedCandidate, ExactEvaluation>;
  slotSets: SlotSetReport[];
  cost: OnsetOracleCost;
}

/** Проверяет все опции до baseline, choices или чтения словаря. */
function validateOracleOptions(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  maxOnsetSamples?: number;
  coarseStepSamples?: number;
  exactPairLimit?: number;
}): OracleOptions {
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  const exactPairLimit = arg.exactPairLimit ?? DEFAULT_EXACT_K2_PAIRS;
  const maxOnsetSamples =
    arg.maxOnsetSamples ?? DEFAULT_MAX_ONSET_SAMPLES;
  const coarseStepSamples =
    arg.coarseStepSamples ?? DEFAULT_COARSE_STEP_SAMPLES;
  if (sampleRate !== SAMPLE_RATE || arg.target.length === 0) {
    throw new Error(
      'Onset oracle требует непустой target на 44100 Гц',
    );
  }
  if (
    !Number.isInteger(exactPairLimit) ||
    exactPairLimit < 1 ||
    exactPairLimit > DEFAULT_EXACT_K2_PAIRS
  ) {
    throw new Error('exactPairLimit должен быть целым от 1 до 8');
  }
  if (!Number.isInteger(maxOnsetSamples) || maxOnsetSamples < 0) {
    throw new Error(
      'maxOnsetSamples должен быть целым и неотрицательным',
    );
  }
  if (!Number.isInteger(coarseStepSamples) || coarseStepSamples < 1) {
    throw new Error(
      'coarseStepSamples должен быть положительным целым',
    );
  }
  return {
    patch: arg.patch,
    target: Array.from(arg.target),
    sampleRate,
    phaseModel,
    exactPairLimit,
    maxOnsetSamples,
    coarseStepSamples,
  };
}

/** Готовит baseline, solo-вклады и независимые K1/K2 наборы слотов. */
function prepareOracleContext(options: OracleOptions): OracleContext {
  const zone = computeUsefulZone(options.target, options.sampleRate);
  const initial = createInitialState({
    patch: options.patch,
    target: options.target,
    sampleRate: options.sampleRate,
    phaseModel: options.phaseModel,
    usefulZone: zone,
  });
  const contributions = buildContributions(
    initial.patch,
    options.target.length,
    options.phaseModel,
  );
  return {
    initial,
    zone,
    contributions,
    choices: [
      ...rankSlotSets({
        state: initial,
        contributions,
        target: options.target,
        usedSlots: new Set<number>(),
        blockSize: 1,
      }).map((choice) => ({ mode: 'K1' as const, choice })),
      ...rankSlotSets({
        state: initial,
        contributions,
        target: options.target,
        usedSlots: new Set<number>(),
        blockSize: 2,
      }).map((choice) => ({ mode: 'K2' as const, choice })),
    ],
  };
}

/** Обрабатывает все наборы слотов и объединяет кандидаты и стоимость. */
function collectSlotSetResults(
  options: OracleOptions,
  context: OracleContext,
): CollectedOracleResults {
  const zeroCandidates: FittedCandidate[] = [];
  const delayedCandidates: FittedCandidate[] = [];
  const exactZero: ExactEvaluation[] = [];
  const exactDelayed: ExactEvaluation[] = [];
  const pairedZero = new Map<
    FittedCandidate,
    FittedCandidate | null
  >();
  const baselines = new Map<FittedCandidate, number>();
  const exactByCandidate = new Map<
    FittedCandidate,
    ExactEvaluation
  >();
  const slotSets: SlotSetReport[] = [];
  const cost: OnsetOracleCost = {
    durationMs: 0,
    k1: emptyModeCost(),
    k2: emptyModeCost(),
  };
  for (const { mode, choice } of context.choices) {
    const processed = processSlotSet({
      mode,
      choice,
      patch: context.initial.patch,
      target: options.target,
      sampleRate: options.sampleRate,
      phaseModel: options.phaseModel,
      zone: context.zone,
      maxOnsetSamples: options.maxOnsetSamples,
      coarseStepSamples: options.coarseStepSamples,
      exactPairLimit: options.exactPairLimit,
    });
    slotSets.push(processed.report);
    zeroCandidates.push(...processed.zeroCandidates);
    delayedCandidates.push(...processed.delayedCandidates);
    exactZero.push(...processed.exactZero);
    exactDelayed.push(...processed.exactDelayed);
    mergeMaps(pairedZero, processed.pairedZero);
    mergeMaps(baselines, processed.baselines);
    for (const exact of [
      ...processed.exactZero,
      ...processed.exactDelayed,
    ]) {
      exactByCandidate.set(exact.candidate, exact);
    }
    addModeCost(mode === 'K1' ? cost.k1 : cost.k2, processed.cost);
  }
  return {
    zeroCandidates,
    delayedCandidates,
    exactZero,
    exactDelayed,
    pairedZero,
    baselines,
    exactByCandidate,
    slotSets,
    cost,
  };
}

/** Выбирает theoretical и exact-победителей через прежние компараторы. */
function selectBestOracleCandidates(
  collected: CollectedOracleResults,
): {
  bestZero: FittedCandidate | null;
  bestDelayed: FittedCandidate | null;
  bestExactZero: ExactEvaluation | null;
  bestExactDelayed: ExactEvaluation | null;
} {
  let bestZero: FittedCandidate | null = null;
  let bestDelayed: FittedCandidate | null = null;
  for (const candidate of collected.zeroCandidates) {
    if (betterRawCandidate(candidate, bestZero)) {
      bestZero = candidate;
    }
  }
  for (const candidate of collected.delayedCandidates) {
    if (betterRawCandidate(candidate, bestDelayed)) {
      bestDelayed = candidate;
    }
  }
  let bestExactZero: ExactEvaluation | null = null;
  let bestExactDelayed: ExactEvaluation | null = null;
  for (const exact of collected.exactZero) {
    if (betterExact(exact, bestExactZero)) {
      bestExactZero = exact;
    }
  }
  for (const exact of collected.exactDelayed) {
    if (betterExact(exact, bestExactDelayed)) {
      bestExactDelayed = exact;
    }
  }
  return { bestZero, bestDelayed, bestExactZero, bestExactDelayed };
}

/** Строит residual, clipping и time-band диагностику исходного match. */
function buildOracleDiagnostics(
  context: OracleContext,
  options: OracleOptions,
): {
  clipping: RawClippingReport;
  timeBands: ResidualTimeBandMap;
} {
  const residual = Float64Array.from(
    options.target,
    (value, index) =>
      (value - (context.initial.samples[index] ?? 0)) /
      MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  );
  return {
    clipping: measureRawClipping({
      rawSum: context.initial.rawSum,
      target: options.target,
      samples: context.initial.samples,
    }),
    timeBands: buildResidualTimeBandMap({
      residual,
      target: options.target,
      sampleRate: options.sampleRate,
    }),
  };
}

/**
 * Выполняет K1/K2 onset-диагностику готового match без нового CD.
 *
 * @param arg - Исходный патч, target PCM и параметры поиска onset;
 *   sample rate по умолчанию 44100 Гц, модель фазы — `legacy`
 * @returns Theoretical и exact-кандидаты, paired zero, clipping,
 *   time-band диагностику и стоимость поиска; patch и WAV не создаются
 * @throws Error если target пуст, sample rate отличается от 44100 Гц,
 *   сетка onset или лимит exact-пар некорректны либо exact delayed
 *   потерял paired zero
 * @remarks K1 и K2 независимо выбирают слоты и сумму без них. K2
 *   проверяет both-delayed и mixed delayed+zero пары. Каждый exact
 *   delayed получает paired zero с теми же описаниями и слотами, но с
 *   нулевыми onset у всех атомов. Общий потолок — 38 exact-оценок на
 *   сид. Результат остаётся offline-диагностикой: canonical patch/WAV
 *   отдельно строит и проверяет delayed-patch runner.
 */
export function runResidualOnsetOracle(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  maxOnsetSamples?: number;
  coarseStepSamples?: number;
  exactPairLimit?: number;
}): ResidualOnsetOracleResult {
  const started = Date.now();
  const options = validateOracleOptions(arg);
  const context = prepareOracleContext(options);
  const collected = collectSlotSetResults(options, context);
  const selected = selectBestOracleCandidates(collected);
  const diagnostics = buildOracleDiagnostics(context, options);
  return {
    diagnostic: 'residual-onset-oracle',
    baseline: context.initial.metrics,
    bestTheoreticalZero:
      selected.bestZero === null
        ? null
        : candidateReport(
            selected.bestZero,
            candidateBaselineRss(
              selected.bestZero,
              collected.baselines,
            ),
          ),
    bestTheoreticalDelayed:
      selected.bestDelayed === null
        ? null
        : delayedTheoreticalReport(
            selected.bestDelayed,
            collected.pairedZero,
            collected.baselines,
          ),
    bestExactZero:
      selected.bestExactZero === null
        ? null
        : exactReport(
            selected.bestExactZero,
            candidateBaselineRss(
              selected.bestExactZero.candidate,
              collected.baselines,
            ),
          ),
    bestExactDelayed:
      selected.bestExactDelayed === null
        ? null
        : delayedExactReport({
            exact: selected.bestExactDelayed,
            pairedZero: collected.pairedZero,
            exactByCandidate: collected.exactByCandidate,
            baselines: collected.baselines,
            baseline: context.initial.metrics,
          }),
    clipping: diagnostics.clipping,
    timeBands: diagnostics.timeBands,
    slotSets: collected.slotSets,
    cost: {
      ...collected.cost,
      durationMs: Date.now() - started,
    },
    canonicalPatchWritten: false,
    canonicalWavWritten: false,
  };
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeTarget(
  slug: string,
  runs: SeedReport[],
): TargetSummary {
  const delayed = runs.flatMap((run) =>
    run.bestExactDelayed === null ? [] : [run.bestExactDelayed],
  );
  return {
    slug,
    runs: runs.length,
    runsWithDelayedCandidate: delayed.length,
    meanDelayedGlobalDelta: mean(
      delayed.map((candidate) => candidate.baselineGlobalDelta),
    ),
    meanDelayedVsSameZeroGlobalDelta: mean(
      delayed.map((candidate) => candidate.globalDeltaVsSameZero),
    ),
    delayedBeatsBaseline: delayed.filter(
      (candidate) => candidate.baselineGlobalDelta > 1e-9,
    ).length,
    delayedBeatsSameZero: delayed.filter(
      (candidate) => candidate.globalDeltaVsSameZero > 1e-9,
    ).length,
    meanSaturatedSampleFraction:
      mean(runs.map((run) => run.clipping.saturatedSampleFraction)) ??
      0,
  };
}

function fixed(value: number | null | undefined, digits = 3): string {
  return value === null ||
    value === undefined ||
    !Number.isFinite(value)
    ? '—'
    : value.toFixed(digits);
}

function candidateDelays(
  candidate: CandidateReport | null | undefined,
): string {
  if (candidate === null || candidate === undefined) {
    return '—';
  }
  return candidate.atoms
    .map((atom) => atom.delayMs.toFixed(3))
    .join(',');
}

function candidateSlots(
  candidate: CandidateReport | null | undefined,
): string {
  return candidate === null || candidate === undefined
    ? '—'
    : candidate.slots.join(',');
}

function candidateDescriptions(
  candidate: CandidateReport | null | undefined,
): string {
  if (candidate === null || candidate === undefined) {
    return '—';
  }
  return candidate.atoms
    .map(
      (atom) =>
        `${atom.slot}:${atom.description.frequency.toFixed(3)}Hz`,
    )
    .join(',');
}

/**
 * Строит Markdown-отчёт чекпоинта, не выдавая oracle за production.
 *
 * @param report - Завершённый или промежуточный отчёт по сидам
 * @returns Markdown со стоимостью, theoretical/exact-кандидатами и клиппингом
 * @remarks Theoretical и exact candidates занимают разные разделы и строки;
 *   paired zero показан отдельными столбцами и не подменяет независимый zero.
 *   Delayed-результаты остаются диагностикой raw sum: отчёт не объявляет
 *   patch или WAV: их сохраняет отдельный delayed-patch runner.
 */
export function renderResidualOnsetReportMarkdown(
  report: OracleReport,
): string {
  const lines = [
    '# Residual onset oracle и clipping',
    '',
    `Это offline-диагностика T36, не итоговый патч и не закон T35. K2 проверяет both-delayed и mixed delayed+zero пары до onset ${report.maxOnsetMs} мс. Отчёт не содержит patch или WAV; delayed-patch runner отдельно проверяет candidate через canonical render. Exact global/J описывает raw sum после production-клиппинга и квантования. Ideal time-band global вычитает RSS выбранной FFT-ячейки и не обещает физически реализуемый атом.`,
    '',
    '| Таргет | Сид | Baseline global/J | K1 наборов | K2 наборов | K1 scan/joint/exact/basis | K2 scan/joint/exact/basis | Насыщено | Доля RSS насыщенных | Секунд |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const run of report.runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${run.baseline.globalSuppressionPercent.toFixed(3)} / ${run.baseline.windowedSuppressionPercent.toFixed(3)} | ${run.cost.k1.slotSetsEvaluated} | ${run.cost.k2.slotSetsEvaluated} | ${run.cost.k1.scanFitEvaluations} / ${run.cost.k1.jointFitEvaluations} / ${run.cost.k1.exactEvaluations} / ${run.cost.k1.basisRenders} | ${run.cost.k2.scanFitEvaluations} / ${run.cost.k2.jointFitEvaluations} / ${run.cost.k2.exactEvaluations} / ${run.cost.k2.basisRenders} | ${(100 * run.clipping.saturatedSampleFraction).toFixed(3)}% | ${fixed(run.clipping.saturatedResidualRssShare === null ? null : 100 * run.clipping.saturatedResidualRssShare, 3)}% | ${(run.cost.durationMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push(
    '',
    '## Theoretical candidates',
    '',
    'Каждая строка описывает один candidate. Paired zero вынесен в отдельно названные столбцы и не подменяет лучший независимый zero.',
    '',
    '| Таргет | Сид | Выбор | Mode | Slots | Descriptions | Onset, мс | Raw RSS | Paired zero raw RSS | RSS gain против paired zero |',
    '| --- | ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: |',
  );
  for (const run of report.runs) {
    const zero = run.bestTheoreticalZero;
    if (zero !== null) {
      lines.push(
        `| ${run.slug} | ${run.seed} | best evaluated zero | ${zero.mode} | ${candidateSlots(zero)} | ${candidateDescriptions(zero)} | ${candidateDelays(zero)} | ${zero.rawRss.toFixed(6)} | — | — |`,
      );
    }
    const delayed = run.bestTheoreticalDelayed;
    if (delayed !== null) {
      lines.push(
        `| ${run.slug} | ${run.seed} | best evaluated delayed | ${delayed.candidate.mode} | ${candidateSlots(delayed.candidate)} | ${candidateDescriptions(delayed.candidate)} | ${candidateDelays(delayed.candidate)} | ${delayed.candidate.rawRss.toFixed(6)} | ${fixed(delayed.sameZero?.rawRss, 6)} | ${fixed(delayed.rawRssGainVsSameZero, 6)} |`,
      );
    }
  }
  lines.push(
    '',
    '## Exact clipped/quantized candidates',
    '',
    'Slots, onset и global/J в основных столбцах принадлежат одному exact candidate. Его paired zero имеет собственные slots, onset и global/J.',
    '',
    '| Таргет | Сид | Выбор | Mode | Slots | Descriptions | Onset, мс | Raw RSS | Global/J | Δ baseline global/J | Paired zero slots | Paired zero onset, мс | Paired zero global/J | Δ paired zero global/J |',
    '| --- | ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: |',
  );
  for (const run of report.runs) {
    const zero = run.bestExactZero;
    if (zero !== null) {
      const baselineGlobalDelta =
        zero.metrics.globalSuppressionPercent -
        run.baseline.globalSuppressionPercent;
      const baselineWindowedDelta =
        zero.metrics.windowedSuppressionPercent -
        run.baseline.windowedSuppressionPercent;
      lines.push(
        `| ${run.slug} | ${run.seed} | best evaluated zero | ${zero.candidate.mode} | ${candidateSlots(zero.candidate)} | ${candidateDescriptions(zero.candidate)} | ${candidateDelays(zero.candidate)} | ${zero.candidate.rawRss.toFixed(6)} | ${zero.metrics.globalSuppressionPercent.toFixed(3)} / ${zero.metrics.windowedSuppressionPercent.toFixed(3)} | ${baselineGlobalDelta.toFixed(3)} / ${baselineWindowedDelta.toFixed(3)} | — | — | — | — |`,
      );
    }
    const exact = run.bestExactDelayed;
    if (exact !== null) {
      lines.push(
        `| ${run.slug} | ${run.seed} | best evaluated delayed | ${exact.candidate.mode} | ${candidateSlots(exact.candidate)} | ${candidateDescriptions(exact.candidate)} | ${candidateDelays(exact.candidate)} | ${exact.candidate.rawRss.toFixed(6)} | ${exact.metrics.globalSuppressionPercent.toFixed(3)} / ${exact.metrics.windowedSuppressionPercent.toFixed(3)} | ${exact.baselineGlobalDelta.toFixed(3)} / ${exact.baselineWindowedDelta.toFixed(3)} | ${candidateSlots(exact.sameZero.candidate)} | ${candidateDelays(exact.sameZero.candidate)} | ${exact.sameZero.metrics.globalSuppressionPercent.toFixed(3)} / ${exact.sameZero.metrics.windowedSuppressionPercent.toFixed(3)} | ${exact.globalDeltaVsSameZero.toFixed(3)} / ${exact.windowedDeltaVsSameZero.toFixed(3)} |`,
      );
    }
  }
  lines.push(
    '',
    '## Сводка exact delayed',
    '',
    '| Таргет | Прогонов | С exact delayed | Средний Δ global | Средний Δ против paired zero | Лучше baseline | Лучше paired zero | Средняя доля насыщенных |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const summary of report.summaries) {
    lines.push(
      `| ${summary.slug} | ${summary.runs} | ${summary.runsWithDelayedCandidate} | ${fixed(summary.meanDelayedGlobalDelta)} | ${fixed(summary.meanDelayedVsSameZeroGlobalDelta)} | ${summary.delayedBeatsBaseline} | ${summary.delayedBeatsSameZero} | ${(100 * summary.meanSaturatedSampleFraction).toFixed(3)}% |`,
    );
  }
  const topCells = report.runs.flatMap((run) =>
    [...run.timeBands.cells]
      .sort(
        (a, b) =>
          b.idealGlobalSuppressionPercent -
          a.idealGlobalSuppressionPercent,
      )
      .slice(0, 3)
      .map((cell) => ({ run, cell })),
  );
  lines.push(
    '',
    '## Три самые сильные ideal time-band ячейки каждого сида',
    '',
  );
  if (topCells.length === 0) {
    lines.push('Нет завершённых прогонов.');
  }
  for (const { run, cell } of topCells) {
    lines.push(
      `- ${run.slug}, seed ${run.seed}, ${cell.region}/${cell.name} ${cell.minHz}–${cell.maxHz} Гц: доля residual RSS ${fixed(cell.residualRssShare === null ? null : 100 * cell.residualRssShare, 3)}%, ideal global ${cell.idealGlobalSuppressionPercent.toFixed(3)}%.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function makeReport(arg: {
  options: OracleCliOptions;
  manifest: DatasetManifest;
  runs: SeedReport[];
  errors: RunError[];
  finished: boolean;
}): OracleReport {
  return {
    version: 2,
    diagnostic: 'residual-onset-oracle',
    createdAt: new Date().toISOString(),
    dataset: arg.options.dataset,
    phaseModel: arg.manifest.phaseModel ?? 'legacy',
    attackBoost: arg.manifest.attackBoost ?? 1,
    seeds: [1, 2, 3, 4],
    maxOnsetMs: arg.options.maxOnsetMs,
    exactK2PairLimitPerSlotSet: DEFAULT_EXACT_K2_PAIRS,
    finished: arg.finished,
    canonicalPatchWritten: false,
    canonicalWavWritten: false,
    errors: arg.errors,
    runs: arg.runs,
    summaries: arg.options.slugs.map((slug) =>
      summarizeTarget(
        slug,
        arg.runs.filter((run) => run.slug === slug),
      ),
    ),
  };
}

async function checkpoint(
  outDir: string,
  report: OracleReport,
): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await writeJsonAtomic(join(outDir, 'report.json'), report);
  await writeTextAtomic(
    join(outDir, 'report.md'),
    renderResidualOnsetReportMarkdown(report),
  );
}

async function processSeed(arg: {
  options: OracleCliOptions;
  manifest: DatasetManifest;
  slug: string;
  seed: number;
}): Promise<SeedReport | null> {
  const sourceRunDir = join(
    arg.options.dataset,
    arg.slug,
    `seed-${arg.seed}`,
  );
  const record = await readJsonOrNull<RunRecord>(
    join(sourceRunDir, 'run.json'),
  );
  if (record?.status !== 'completed') {
    return null;
  }
  const patch = await readJsonOrNull<ArgCreateSynth>(
    join(sourceRunDir, 'patch.json'),
  );
  if (patch === null) {
    throw new Error(`Нет patch.json в ${sourceRunDir}`);
  }
  const target = readWav(
    join(arg.manifest.targetsDir, record.target),
  );
  const baselineWav = readWav(join(sourceRunDir, 'result.wav'));
  if (
    target.sampleRate !== baselineWav.sampleRate ||
    target.samples.length !== baselineWav.samples.length
  ) {
    throw new Error(`Target и match не совпадают в ${sourceRunDir}`);
  }
  const phaseModel = arg.manifest.phaseModel ?? 'legacy';
  assertPatchMatchesWav(
    patch,
    baselineWav.samples,
    phaseModel,
    baselineWav.sampleRate,
    target.samples.length,
  );
  const result = runResidualOnsetOracle({
    patch,
    target: target.samples,
    sampleRate: target.sampleRate,
    phaseModel,
    maxOnsetSamples: Math.round(
      (arg.options.maxOnsetMs / 1000) * target.sampleRate,
    ),
  });
  return {
    slug: arg.slug,
    seed: arg.seed,
    sourceRunDir,
    savedGlobalSuppressionPercent:
      record.globalSuppressionPercent ?? null,
    ...result,
  };
}

function parseArgs(args: string[]): OracleCliOptions {
  const options: OracleCliOptions = {
    dataset: '',
    outDir: '',
    slugs: ['GrumU', 'BOg-Disco-Futuro'],
    maxOnsetMs: 200,
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--dataset') {
      options.dataset = resolve(value);
    } else if (key === '--out') {
      options.outDir = resolve(value);
    } else if (key === '--slugs') {
      options.slugs = value
        .split(',')
        .map((slug) => slug.trim())
        .filter(Boolean);
    } else if (key === '--max-onset-ms') {
      options.maxOnsetMs = Number(value);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (
    options.dataset === '' ||
    options.outDir === '' ||
    options.slugs.length === 0
  ) {
    throw new Error(
      'Usage: residual-onset-oracle --dataset DIR --out DIR [--slugs GrumU,BOg-Disco-Futuro] [--max-onset-ms 200]',
    );
  }
  if (
    !Number.isFinite(options.maxOnsetMs) ||
    Math.round((options.maxOnsetMs / 1000) * SAMPLE_RATE) < 1 ||
    options.maxOnsetMs > 450
  ) {
    throw new Error(
      '--max-onset-ms должен давать хотя бы один отсчёт и не превышать 450',
    );
  }
  return options;
}

function logSeedResult(run: SeedReport): void {
  const theoretical = run.bestTheoreticalDelayed;
  const theoreticalCandidate = theoretical?.candidate;
  console.log(
    `THEORY ${run.slug} seed=${run.seed} ` +
      `mode=${theoreticalCandidate?.mode ?? '—'} ` +
      `slots=${candidateSlots(theoreticalCandidate)} ` +
      `descriptions=${candidateDescriptions(theoreticalCandidate)} ` +
      `onsetMs=${candidateDelays(theoreticalCandidate)} ` +
      `rawRSS=${fixed(theoreticalCandidate?.rawRss, 6)} ` +
      `pairedZeroRSS=${fixed(theoretical?.sameZero?.rawRss, 6)} ` +
      `pairedGain=${fixed(theoretical?.rawRssGainVsSameZero, 6)}`,
  );
  const exact = run.bestExactDelayed;
  const exactCandidate = exact?.candidate;
  console.log(
    `EXACT ${run.slug} seed=${run.seed} ` +
      `mode=${exactCandidate?.mode ?? '—'} ` +
      `slots=${candidateSlots(exactCandidate)} ` +
      `descriptions=${candidateDescriptions(exactCandidate)} ` +
      `onsetMs=${candidateDelays(exactCandidate)} ` +
      `global=${fixed(exact?.metrics.globalSuppressionPercent)} ` +
      `J=${fixed(exact?.metrics.windowedSuppressionPercent)} ` +
      `baselineDelta=${fixed(exact?.baselineGlobalDelta)}/${fixed(exact?.baselineWindowedDelta)} ` +
      `pairedSlots=${candidateSlots(exact?.sameZero.candidate)} ` +
      `pairedOnsetMs=${candidateDelays(exact?.sameZero.candidate)} ` +
      `pairedGlobal=${fixed(exact?.sameZero.metrics.globalSuppressionPercent)} ` +
      `pairedJ=${fixed(exact?.sameZero.metrics.windowedSuppressionPercent)} ` +
      `pairedDelta=${fixed(exact?.globalDeltaVsSameZero)}/${fixed(exact?.windowedDeltaVsSameZero)}`,
  );
  console.log(
    `COST ${run.slug} seed=${run.seed} ` +
      `K1=${run.cost.k1.scanFitEvaluations}/${run.cost.k1.jointFitEvaluations}/${run.cost.k1.exactEvaluations}/${run.cost.k1.basisRenders} ` +
      `K2=${run.cost.k2.scanFitEvaluations}/${run.cost.k2.jointFitEvaluations}/${run.cost.k2.exactEvaluations}/${run.cost.k2.basisRenders} ` +
      `clipped=${(100 * run.clipping.saturatedSampleFraction).toFixed(3)}% ` +
      `seconds=${(run.cost.durationMs / 1000).toFixed(1)}`,
  );
}

async function runCli(
  options: OracleCliOptions,
  manifest: DatasetManifest,
): Promise<OracleReport> {
  const runs: SeedReport[] = [];
  const errors: RunError[] = [];
  for (const slug of options.slugs) {
    for (const seed of [1, 2, 3, 4]) {
      try {
        const run = await processSeed({
          options,
          manifest,
          slug,
          seed,
        });
        if (run === null) {
          console.log(`SKIP ${slug}/seed-${seed}: not completed`);
        } else {
          runs.push(run);
          logSeedResult(run);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        errors.push({ slug, seed, message });
        console.warn(`WARN ${slug}/seed-${seed}: ${message}`);
      }
      await checkpoint(
        options.outDir,
        makeReport({
          options,
          manifest,
          runs,
          errors,
          finished: false,
        }),
      );
    }
  }
  const report = makeReport({
    options,
    manifest,
    runs,
    errors,
    finished: true,
  });
  await checkpoint(options.outDir, report);
  return report;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(options.dataset, 'manifest.json'),
  );
  if (manifest === null) {
    throw new Error(`Нет manifest.json в ${options.dataset}`);
  }
  const report = await withAttackBoost(
    manifest.attackBoost ?? 1,
    () => runCli(options, manifest),
  );
  for (const summary of report.summaries) {
    console.log(
      `SUMMARY ${summary.slug} runs=${summary.runs} ` +
        `delayed=${summary.runsWithDelayedCandidate} ` +
        `meanGlobalDelta=${fixed(summary.meanDelayedGlobalDelta)} ` +
        `meanSameZeroDelta=${fixed(summary.meanDelayedVsSameZeroGlobalDelta)} ` +
        `beatsBaseline=${summary.delayedBeatsBaseline} ` +
        `beatsSameZero=${summary.delayedBeatsSameZero}`,
    );
  }
  console.log(
    `REPORT runs=${report.runs.length} errors=${report.errors.length} ` +
      'diagnostic-only=no-patch-no-wav',
  );
  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
