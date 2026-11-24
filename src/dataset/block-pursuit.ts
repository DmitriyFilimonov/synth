/**
 * Screening совместного residual pursuit для одного или двух слотов.
 * Оба режима используют один словарь и проверяют несколько слотов.
 * Это offline-эксперимент: production match, enhance и API его не вызывают.
 */
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import {
  computeUsefulZone,
  type UsefulZone,
} from '../optimize/evaluate';
import {
  ampEnvConfigNormales,
  oscConfigNormales,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import { solveBoundedQuadratureSystem } from './bounded-quadrature';
import { refitClippedQuadraturePair } from './joint-projection-oracle';
import {
  buildContributions,
  buildPursuitDictionary,
  globalOfSamples,
  groupFromAtom,
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

/** Число одновременно заменяемых слотов. */
export type PursuitBlockSize = 1 | 2;

/** Один атом, принятый внутри одиночного или парного блока. */
export interface BlockPursuitAtom {
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
}

/** Метрики и стоимость одного принятого блока. */
export interface BlockPursuitStep {
  step: number;
  atoms: BlockPursuitAtom[];
  before: RefitMetrics;
  after: RefitMetrics;
  exactCandidates: number;
  jointCandidates: number;
  slotSetsEvaluated: number;
  variableProjection?: VariableProjectionAttemptAudit;
}

/** Нелинейные параметры одного атома в аудите variable projection. */
export interface VariableProjectionAtomAudit {
  frequency: number;
  freqStart: number;
  ratio: number;
  duration: number;
  slope: number;
  oscDuration: number;
  oscSlope: number;
}

/** Победитель одного навигационного прохода и его точная проверка. */
export interface VariableProjectionPassAudit {
  pass: number;
  winnerGain: number;
  winnerClippedRss?: number | null;
  globalSuppressionPercent: number | null;
  windowedSuppressionPercent: number | null;
  accepted: boolean;
  evaluations: number;
  unitBasisRenders: number;
  clipObjectiveEvaluations?: number;
  slots?: number[];
  shapeKey?: string;
  rawGlobalSuppressionPercent?: number | null;
  rawWindowedSuppressionPercent?: number | null;
  rawClippedRss?: number | null;
  rawAccepted?: boolean;
  refitGlobalSuppressionPercent?: number | null;
  refitWindowedSuppressionPercent?: number | null;
  refitClippedRss?: number | null;
  refitIterations?: number;
  refitBacktracks?: number;
  refitMaskChanges?: number;
  refitObjectiveEvaluations?: number;
  refitAccepted?: boolean;
}

/** Чем закончилась попытка VP относительно обычного K2. */
export type VariableProjectionOutcome =
  'accepted' | 'k2-fallback' | 'no-seed' | 'no-accepted';

/** Полный аудит VP внутри одного блока; guard не меняет его навигацию. */
export interface VariableProjectionAttemptAudit {
  step: number;
  seedAccepted: boolean;
  outcome: VariableProjectionOutcome;
  seed: VariableProjectionAtomAudit[] | null;
  final: VariableProjectionAtomAudit[] | null;
  evaluations: number;
  unitBasisRenders: number;
  clipObjectiveEvaluations?: number;
  refitObjectiveEvaluations?: number;
  refitBacktracks?: number;
  refitIterations?: number;
  refitMaskChanges?: number;
  exactCandidates: number;
  passes: VariableProjectionPassAudit[];
}

/** Стоимость и исходы всех VP-попыток одного запуска. */
export interface VariableProjectionSummary {
  evaluations: number;
  unitBasisRenders: number;
  clipObjectiveEvaluations?: number;
  refitObjectiveEvaluations?: number;
  refitBacktracks?: number;
  refitIterations?: number;
  refitMaskChanges?: number;
  exactCandidates: number;
  accepted: number;
  k2Fallback: number;
  noSeed: number;
  noAccepted: number;
  attempts: VariableProjectionAttemptAudit[];
}

/** Итог поиска; unchanged всегда возвращает исходный patch и WAV. */
export interface BlockPursuitResult {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  baseline: RefitMetrics;
  metrics: RefitMetrics;
  steps: BlockPursuitStep[];
  localEvaluations: number;
  jointEvaluations: number;
  exactEvaluations: number;
  basisRenders: number;
  slotSetsEvaluated: number;
  replacementCount: number;
  variableProjection?: VariableProjectionSummary;
}

/**
 * Ранжированный набор слотов и сумма без именно их вкладов.
 *
 * @remarks Каждый выбор независим: `rawWithout` строится от исходной
 *   суммы состояния, а не от другого K1/K2-кандидата. Поэтому K1 не
 *   удаляет скрыто вклад второго слота.
 */
export interface SlotSetChoice {
  slots: number[];
  rawWithout: Float64Array;
  globalAfterRemoval: number;
}

interface PreparedAtom {
  description: AtomDescription;
  sine: Float64Array;
  cosine: Float64Array;
  selfGram: number[];
  rhs: number[];
}

interface JointFit {
  fits: QuadratureFit[];
  gain: number;
}

interface BlockCandidate {
  state: RenderState;
  atoms: PreparedAtom[];
  fits: QuadratureFit[];
  choice: SlotSetChoice;
}

interface VariableProjectionRefitResult {
  candidate: BlockCandidate | null;
  clippedRss: number | null;
  iterations: number;
  backtracks: number;
  maskChanges: number;
  objectiveEvaluations: number;
}

type VariableProjectionParameter =
  'frequency' | 'ratio' | 'duration' | 'slope';

interface VariableProjectionAxis {
  atomIndex: number;
  parameter: VariableProjectionParameter;
}

interface VariableProjectionPoint {
  descriptions: AtomDescription[];
  atoms: PreparedAtom[];
  fit: JointFit;
  gain: number;
  clippedRss?: number;
}

interface VariableProjectionEvaluation {
  descriptions: AtomDescription[];
  atoms: PreparedAtom[];
  fit: JointFit | null;
  gain: number;
  clippedRss?: number;
}

interface VariableProjectionEvaluationCounters {
  evaluations: number;
  unitBasisRenders: number;
  clipObjectiveEvaluations?: number;
}

interface VariableProjectionEvaluator {
  centerEvaluation: VariableProjectionEvaluation;
  counters: VariableProjectionEvaluationCounters;
  evaluate: (
    descriptions: AtomDescription[],
  ) => VariableProjectionEvaluation;
}

interface VariableProjectionPassResult {
  center: VariableProjectionPoint;
  bestAccepted: BlockCandidate | null;
  audit: VariableProjectionPassAudit;
  counters: VariableProjectionEvaluationCounters;
}

interface VariableProjectionRefinement {
  bestAccepted: BlockCandidate | null;
  final: AtomDescription[];
  evaluations: number;
  unitBasisRenders: number;
  clipObjectiveEvaluations?: number;
  refitObjectiveEvaluations?: number;
  refitBacktracks?: number;
  refitIterations?: number;
  refitMaskChanges?: number;
  exactCandidates: number;
  passes: VariableProjectionPassAudit[];
}

interface AttemptCounters {
  localEvaluations: number;
  jointEvaluations: number;
  exactEvaluations: number;
  basisRenders: number;
  slotSetsEvaluated: number;
}

interface AcceptedBlock {
  state: RenderState;
  contributions: (Float64Array | null)[];
  audit: BlockPursuitStep;
}

const DEFAULT_BLOCKS = 6;
export const MAX_BLOCKS = 12;
const SLOT_SHORTLIST_SIZE = 4;
const SLOT_SETS_TO_SEARCH = 2;
const EXACT_PAIRS_PER_SLOT_SET = 8;
const MIN_GLOBAL_GAIN = 0.005;
const CURRENT_WINDOWED_TOLERANCE = 0.01;
const INITIAL_WINDOWED_TOLERANCE = 0.05;
const VP_FREQUENCY_STEPS = [0.005, 0.001, 0.0002, 0.00004, 0.000008];
const VP_MULTIPLICATIVE_STEPS = [2, 1.1892, 1.0443, 1.0109, 1.0027];
const VP_SLOPE_STEPS = [0.32, 0.08, 0.02, 0.005, 0.00125];
const VP_PARAMETERS: VariableProjectionParameter[] = [
  'frequency',
  'ratio',
  'duration',
  'slope',
];
const VP_AXES: VariableProjectionAxis[] = VP_PARAMETERS.flatMap(
  (parameter) => [
    { atomIndex: 0, parameter },
    { atomIndex: 1, parameter },
  ],
);

/** Скалярное произведение двух одинаково длинных массивов. */
function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let value = 0;
  for (let index = 0; index < a.length; index += 1) {
    value += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return value;
}

/**
 * Совместно подгоняет один или два атома к остатку полного сигнала.
 * Порядок базисов: sine/cosine первого атома, затем второго.
 */
export function fitQuadratureBlock(arg: {
  basis: Float64Array[];
  target: ArrayLike<number>;
  rawWithout: ArrayLike<number>;
}): QuadratureFit[] | null {
  const atomCount = arg.basis.length / 2;
  if (
    !Number.isInteger(atomCount) ||
    atomCount < 1 ||
    atomCount > 2 ||
    arg.target.length === 0 ||
    arg.target.length !== arg.rawWithout.length ||
    arg.basis.some((basis) => basis.length !== arg.target.length)
  ) {
    return null;
  }
  const size = atomCount * 2;
  const gram = new Array<number>(size * size).fill(0);
  for (let row = 0; row < size; row += 1) {
    for (let column = row; column < size; column += 1) {
      const value = dot(
        arg.basis[row] ?? new Float64Array(),
        arg.basis[column] ?? new Float64Array(),
      );
      gram[row * size + column] = value;
      gram[column * size + row] = value;
    }
  }
  const residual = Float64Array.from(
    { length: arg.target.length },
    (_, index) =>
      (arg.target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      (arg.rawWithout[index] ?? 0),
  );
  const rhs = arg.basis.map((basis) => dot(basis, residual));
  return solveBoundedQuadratureSystem(gram, rhs, atomCount);
}

/** Вычитает вклады выбранных слотов из необрезанной суммы синтеза. */
function rawWithoutSlots(arg: {
  rawSum: Float64Array;
  contributions: (Float64Array | null)[];
  slots: number[];
}): Float64Array {
  const raw = new Float64Array(arg.rawSum);
  for (const slot of arg.slots) {
    const contribution = arg.contributions[slot];
    if (contribution === null || contribution === undefined) {
      continue;
    }
    for (let index = 0; index < raw.length; index += 1) {
      raw[index] = (raw[index] ?? 0) - (contribution[index] ?? 0);
    }
  }
  return raw;
}

/** Ранжирует все ещё не менявшиеся слоты по потере global при удалении. */
function rankSingleSlots(arg: {
  state: RenderState;
  contributions: (Float64Array | null)[];
  target: number[];
  usedSlots: ReadonlySet<number>;
}): SlotSetChoice[] {
  const ranked: SlotSetChoice[] = [];
  for (
    let slot = 0;
    slot < arg.state.patch.oscillators.length;
    slot += 1
  ) {
    if (arg.usedSlots.has(slot)) {
      continue;
    }
    const group = arg.state.patch.oscillators[slot];
    if (group === undefined) {
      continue;
    }
    const rawWithout = rawWithoutSlots({
      rawSum: arg.state.rawSum,
      contributions: arg.contributions,
      slots: [slot],
    });
    const globalAfterRemoval = group.osc.on
      ? globalOfSamples(quantizeRaw(rawWithout), arg.target)
      : arg.state.metrics.globalSuppressionPercent;
    ranked.push({ slots: [slot], rawWithout, globalAfterRemoval });
  }
  ranked.sort(
    (a, b) =>
      b.globalAfterRemoval - a.globalAfterRemoval ||
      (a.slots[0] ?? 0) - (b.slots[0] ?? 0),
  );
  return ranked;
}

/**
 * Выбирает до двух независимых наборов слотов для K1 или K2.
 *
 * @param arg - Состояние рендера, вклады осцилляторов, target, уже
 *   использованные слоты и размер блока
 * @returns До двух одиночных слотов или пар, отсортированных по global
 *   после удаления их вкладов
 * @remarks K1 ранжирует все неиспользованные слоты поодиночке. K2 строит
 *   пары из четырёх лучших одиночных слотов и заново ранжирует каждую пару.
 *   Каждый `rawWithout` вычитает из исходной суммы только слоты собственного
 *   набора, поэтому кандидаты K1 и K2 не наследуют удаления друг друга.
 */
export function rankSlotSets(arg: {
  state: RenderState;
  contributions: (Float64Array | null)[];
  target: number[];
  usedSlots: ReadonlySet<number>;
  blockSize: PursuitBlockSize;
}): SlotSetChoice[] {
  const singles = rankSingleSlots(arg);
  if (arg.blockSize === 1) {
    return singles.slice(0, SLOT_SETS_TO_SEARCH);
  }
  const pairs: SlotSetChoice[] = [];
  const shortlist = singles.slice(0, SLOT_SHORTLIST_SIZE);
  for (let first = 0; first < shortlist.length; first += 1) {
    for (
      let second = first + 1;
      second < shortlist.length;
      second += 1
    ) {
      const firstChoice = shortlist[first];
      const secondChoice = shortlist[second];
      if (firstChoice === undefined || secondChoice === undefined) {
        continue;
      }
      const slots = [
        firstChoice.slots[0] ?? -1,
        secondChoice.slots[0] ?? -1,
      ];
      const rawWithout = rawWithoutSlots({
        rawSum: arg.state.rawSum,
        contributions: arg.contributions,
        slots,
      });
      pairs.push({
        slots,
        rawWithout,
        globalAfterRemoval: globalOfSamples(
          quantizeRaw(rawWithout),
          arg.target,
        ),
      });
    }
  }
  pairs.sort(
    (a, b) =>
      b.globalAfterRemoval - a.globalAfterRemoval ||
      (a.slots[0] ?? 0) - (b.slots[0] ?? 0) ||
      (a.slots[1] ?? 0) - (b.slots[1] ?? 0),
  );
  return pairs.slice(0, SLOT_SETS_TO_SEARCH);
}

/** Точно рендерит sine/cosine базисы описания и считает его проекции. */
function prepareAtom(arg: {
  description: AtomDescription;
  target: number[];
  fitResidual: Float64Array;
  phaseModel: PhaseModel;
}): PreparedAtom {
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
  return {
    description: arg.description,
    sine,
    cosine,
    selfGram: [
      dot(sine, sine),
      dot(sine, cosine),
      dot(cosine, cosine),
    ],
    rhs: [dot(sine, arg.fitResidual), dot(cosine, arg.fitResidual)],
  };
}

/** Собирает нормальную систему из одного или двух подготовленных атомов. */
function equationsForAtoms(atoms: PreparedAtom[]): {
  gram: number[];
  rhs: number[];
} {
  const size = atoms.length * 2;
  const gram = new Array<number>(size * size).fill(0);
  const rhs = atoms.flatMap((atom) => atom.rhs);
  for (let atomIndex = 0; atomIndex < atoms.length; atomIndex += 1) {
    const atom = atoms[atomIndex];
    if (atom === undefined) {
      continue;
    }
    const offset = atomIndex * 2;
    gram[offset * size + offset] = atom.selfGram[0] ?? 0;
    gram[offset * size + offset + 1] = atom.selfGram[1] ?? 0;
    gram[(offset + 1) * size + offset] = atom.selfGram[1] ?? 0;
    gram[(offset + 1) * size + offset + 1] = atom.selfGram[2] ?? 0;
    for (
      let otherIndex = atomIndex + 1;
      otherIndex < atoms.length;
      otherIndex += 1
    ) {
      const other = atoms[otherIndex];
      if (other === undefined) {
        continue;
      }
      const otherOffset = otherIndex * 2;
      const cross = [
        dot(atom.sine, other.sine),
        dot(atom.sine, other.cosine),
        dot(atom.cosine, other.sine),
        dot(atom.cosine, other.cosine),
      ];
      for (let row = 0; row < 2; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          const value = cross[row * 2 + column] ?? 0;
          gram[(offset + row) * size + otherOffset + column] = value;
          gram[(otherOffset + column) * size + offset + row] = value;
        }
      }
    }
  }
  return { gram, rhs };
}

/** Совместно подгоняет атомы и оценивает локальное снижение RSS. */
function fitPreparedAtoms(atoms: PreparedAtom[]): JointFit | null {
  const equations = equationsForAtoms(atoms);
  const fits = solveBoundedQuadratureSystem(
    equations.gram,
    equations.rhs,
    atoms.length,
  );
  if (fits === null) {
    return null;
  }
  const coefficients = fits.flatMap((fit) => [
    fit.sineCoefficient,
    fit.cosineCoefficient,
  ]);
  let linear = 0;
  let quadratic = 0;
  for (let row = 0; row < coefficients.length; row += 1) {
    linear += (coefficients[row] ?? 0) * (equations.rhs[row] ?? 0);
    for (let column = 0; column < coefficients.length; column += 1) {
      quadratic +=
        (coefficients[row] ?? 0) *
        (equations.gram[row * coefficients.length + column] ?? 0) *
        (coefficients[column] ?? 0);
    }
  }
  const gain = 2 * linear - quadratic;
  return Number.isFinite(gain) ? { fits, gain } : null;
}

/**
 * Сравнивает две точки clip-aware навигации по полному PCM RSS.
 *
 * @param candidate - Новая точка с уже вычисленным clipped RSS
 * @param winner - Текущий победитель с уже вычисленным clipped RSS
 * @returns `true`, только если новый RSS строго меньше
 * @remarks Точка без решения МНК получает бесконечный RSS. При равенстве
 *   прежний победитель сохраняется, поэтому центр не заменяется на tie.
 */
export function isBetterClipAwareNavigationCandidate(
  candidate: { clippedRss?: number },
  winner: { clippedRss?: number },
): boolean {
  return (
    (candidate.clippedRss ?? Number.POSITIVE_INFINITY) <
    (winner.clippedRss ?? Number.POSITIVE_INFINITY)
  );
}

/**
 * Складывает полный raw блока в одном порядке для clip-навигации и
 * exact render. Не применяет clip или квантование.
 */
function renderBlockRawSum(arg: {
  choice: SlotSetChoice;
  atoms: PreparedAtom[];
  fits: QuadratureFit[];
}): Float64Array | null {
  if (arg.atoms.length !== arg.fits.length) {
    return null;
  }
  const rawSum = new Float64Array(arg.choice.rawWithout);
  for (
    let atomIndex = 0;
    atomIndex < arg.atoms.length;
    atomIndex += 1
  ) {
    const atom = arg.atoms[atomIndex];
    const fit = arg.fits[atomIndex];
    if (atom === undefined || fit === undefined) {
      return null;
    }
    for (let index = 0; index < rawSum.length; index += 1) {
      rawSum[index] =
        (rawSum[index] ?? 0) +
        fit.sineCoefficient * (atom.sine[index] ?? 0) +
        fit.cosineCoefficient * (atom.cosine[index] ?? 0);
    }
  }
  return rawSum;
}

/**
 * Считает RSS полного клиппированного PCM против исходного target.
 * Использует тот же raw-sum, что и exact render.
 */
function computeVariableProjectionClipObjective(arg: {
  choice: SlotSetChoice;
  atoms: PreparedAtom[];
  fits: QuadratureFit[];
  target: number[];
}): number | null {
  const rawSum = renderBlockRawSum(arg);
  if (rawSum === null) {
    return null;
  }
  const samples = quantizeRaw(rawSum);
  let rss = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const error = (samples[index] ?? 0) - (arg.target[index] ?? 0);
    rss += error * error;
  }
  return rss;
}

/** Строит кандидат и считает обе метрики по полному квантованному WAV. */
function renderBlockCandidate(arg: {
  state: RenderState;
  choice: SlotSetChoice;
  atoms: PreparedAtom[];
  fits: QuadratureFit[];
  target: number[];
  sampleRate: number;
  zone: UsefulZone;
}): BlockCandidate | null {
  const rawSum = renderBlockRawSum(arg);
  if (rawSum === null) {
    return null;
  }
  const samples = quantizeRaw(rawSum);
  const metrics = measureMetrics(
    samples,
    arg.target,
    arg.sampleRate,
    arg.zone,
  );
  if (
    !Number.isFinite(metrics.globalSuppressionPercent) ||
    !Number.isFinite(metrics.windowedSuppressionPercent)
  ) {
    return null;
  }
  const patch = clonePatch(arg.state.patch);
  for (
    let atomIndex = 0;
    atomIndex < arg.atoms.length;
    atomIndex += 1
  ) {
    const atom = arg.atoms[atomIndex];
    const fit = arg.fits[atomIndex];
    const slot = arg.choice.slots[atomIndex];
    if (
      atom === undefined ||
      fit === undefined ||
      slot === undefined
    ) {
      return null;
    }
    patch.oscillators[slot] = groupFromAtom(atom.description, fit);
  }
  return {
    state: { patch, rawSum, samples, metrics },
    atoms: arg.atoms,
    fits: arg.fits,
    choice: arg.choice,
  };
}

/** Переводит четыре решённых квадратуры в два canonical fit. */
function fitsFromRefitCoefficients(
  coefficients: number[],
): QuadratureFit[] | null {
  if (coefficients.length !== 4) {
    return null;
  }
  const fits: QuadratureFit[] = [];
  for (let atomIndex = 0; atomIndex < 2; atomIndex += 1) {
    const rawSine = coefficients[atomIndex * 2] ?? 0;
    const rawCosine = coefficients[atomIndex * 2 + 1] ?? 0;
    const fittedLevel = Math.hypot(rawSine, rawCosine);
    if (
      !Number.isFinite(fittedLevel) ||
      fittedLevel < 0.001 - 1e-10 ||
      fittedLevel > 1 + 1e-10
    ) {
      return null;
    }
    const startLevel = Math.max(0.001, Math.min(1, fittedLevel));
    const scale = startLevel / fittedLevel;
    const sineCoefficient = rawSine * scale;
    const cosineCoefficient = rawCosine * scale;
    const phase =
      ((Math.atan2(cosineCoefficient, sineCoefficient) %
        (2 * Math.PI)) +
        2 * Math.PI) %
      (2 * Math.PI);
    fits.push({
      sineCoefficient,
      cosineCoefficient,
      startLevel,
      phase,
    });
  }
  return fits;
}

/**
 * Уточняет только коэффициенты уже выбранного VP-победителя.
 *
 * @param arg - Победитель с raw fit, зафиксированные слоты и полный target
 * @returns Отдельный exact-кандидат и стоимость одного E-старта
 * @remarks Базисы, описания, слоты и `choice.rawWithout` берутся у raw
 *   победителя без повторного рендера. Solver видит полную сумму
 *   `rawWithout + вклады пары` до clip. Навигационный `winner.fit` здесь
 *   не изменяется, поэтому следующий проход продолжает raw-навигацию.
 */
function refitVariableProjectionWinner(arg: {
  winner: VariableProjectionEvaluation;
  choice: SlotSetChoice;
  state: RenderState;
  target: number[];
  sampleRate: number;
  zone: UsefulZone;
}): VariableProjectionRefitResult {
  if (arg.winner.fit === null) {
    return {
      candidate: null,
      clippedRss: null,
      iterations: 0,
      backtracks: 0,
      maskChanges: 0,
      objectiveEvaluations: 0,
    };
  }
  const initialCoefficients = arg.winner.fit.fits.flatMap((fit) => [
    fit.sineCoefficient,
    fit.cosineCoefficient,
  ]);
  const refit = refitClippedQuadraturePair({
    basis: arg.winner.atoms.flatMap((atom) => [
      atom.sine,
      atom.cosine,
    ]),
    target: Float64Array.from(
      arg.target,
      (value) => value / MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    ),
    fixedOffset: arg.choice.rawWithout,
    initialCoefficients,
  });
  const fits = fitsFromRefitCoefficients(
    refit.objective.coefficients,
  );
  if (fits === null) {
    throw new Error(
      'Clip-aware refit вернул недопустимые квадратуры',
    );
  }
  const clippedRss = computeVariableProjectionClipObjective({
    choice: arg.choice,
    atoms: arg.winner.atoms,
    fits,
    target: arg.target,
  });
  const candidate = renderBlockCandidate({
    state: arg.state,
    choice: arg.choice,
    atoms: arg.winner.atoms,
    fits,
    target: arg.target,
    sampleRate: arg.sampleRate,
    zone: arg.zone,
  });
  return {
    candidate,
    clippedRss,
    iterations: refit.audit.iterations,
    backtracks: refit.audit.backtracks,
    maskChanges: refit.audit.maskChanges,
    objectiveEvaluations: refit.audit.objectiveEvaluations,
  };
}

/** Проверяет строгий прирост global и оба ограничения на windowed J. */
function acceptsCandidate(arg: {
  current: RefitMetrics;
  candidate: RefitMetrics;
  windowedFloor: number;
}): boolean {
  return (
    arg.candidate.globalSuppressionPercent >=
      arg.current.globalSuppressionPercent + MIN_GLOBAL_GAIN &&
    arg.candidate.windowedSuppressionPercent >=
      arg.current.windowedSuppressionPercent -
        CURRENT_WINDOWED_TOLERANCE &&
    arg.candidate.windowedSuppressionPercent >= arg.windowedFloor
  );
}

/** Сравнивает кандидатов сначала по global, затем по windowed J. */
function betterCandidate(
  candidate: BlockCandidate,
  best: BlockCandidate | null,
): boolean {
  if (best === null) {
    return true;
  }
  const globalDelta =
    candidate.state.metrics.globalSuppressionPercent -
    best.state.metrics.globalSuppressionPercent;
  return (
    globalDelta > 1e-9 ||
    (Math.abs(globalDelta) <= 1e-9 &&
      candidate.state.metrics.windowedSuppressionPercent >
        best.state.metrics.windowedSuppressionPercent)
  );
}

/** Ограничивает нелинейный параметр нормами синтезатора. */
function clampParameter(
  value: number,
  range: { min: number; max: number },
): number {
  return Math.max(range.min, Math.min(range.max, value));
}

/** Ключ содержит только параметры, влияющие на unit-базисы атома. */
function atomShapeKey(description: AtomDescription): string {
  return JSON.stringify([
    description.frequency,
    description.freqStart,
    description.duration,
    description.slope,
    description.oscDuration,
    description.oscSlope,
  ]);
}

/**
 * Строит ключ пары по параметрам, которые меняют unit-базисы.
 *
 * @param descriptions - Нелинейные описания атомов пары
 * @returns Ключ для пропуска повторных кандидатов после clamp
 */
function variableProjectionShapeKey(
  descriptions: AtomDescription[],
): string {
  return JSON.stringify(descriptions.map(atomShapeKey));
}

/**
 * Копирует нелинейные параметры атомов в компактный аудит.
 *
 * @param descriptions - Описания сида или конечной точки VP
 * @returns Параметры атомов без unit-базисов и квадратурных решений
 */
function variableProjectionAtomsAudit(
  descriptions: AtomDescription[],
): VariableProjectionAtomAudit[] {
  return descriptions.map((description) => ({
    frequency: description.frequency,
    freqStart: description.freqStart,
    ratio: description.freqStart / description.frequency,
    duration: description.duration,
    slope: description.slope,
    oscDuration: description.oscDuration,
    oscSlope: description.oscSlope,
  }));
}

/**
 * Сохраняет характер частотной огибающей исходного атома.
 *
 * @param description - Изменённое нелинейное описание атома
 * @param origin - Исходный атом словарного сида
 * @returns Описание с согласованными параметрами частотной огибающей
 * @remarks Если стационарный сид получает sweep, функция задаёт
 *   `oscDuration` по длительности амплитудной огибающей, а `oscSlope`
 *   делает равным 1. У sweep-сида сохраняются исходные значения.
 */
function normalizeVariableProjectionAtom(
  description: AtomDescription,
  origin: AtomDescription,
): AtomDescription {
  const next = { ...description };
  const originWasStationary = origin.freqStart === origin.frequency;
  const hasSweep = next.freqStart !== next.frequency;
  if (originWasStationary && hasSweep) {
    next.oscDuration = clampParameter(
      next.duration,
      oscConfigNormales.duration,
    );
    next.oscSlope = 1;
  } else {
    next.oscDuration = origin.oscDuration;
    next.oscSlope = origin.oscSlope;
  }
  return next;
}

/**
 * Сдвигает одну нелинейную ось атома на шаг выбранного прохода.
 *
 * @param arg - Атом, исходный сид, параметр, направление и проход
 * @returns Новое описание атома в нормах синтезатора
 * @remarks Сдвиг базовой частоты сохраняет `freqStart/frequency`.
 *   При сдвиге этого отношения базовая частота не меняется.
 */
function moveVariableProjectionAtom(arg: {
  description: AtomDescription;
  origin: AtomDescription;
  parameter: VariableProjectionParameter;
  sign: -1 | 1;
  pass: number;
}): AtomDescription {
  const next = { ...arg.description };
  if (arg.parameter === 'frequency') {
    const ratio = next.freqStart / next.frequency;
    const relativeStep = VP_FREQUENCY_STEPS[arg.pass] ?? 0;
    const relativeDelta = next.frequency * relativeStep;
    const delta =
      arg.pass === VP_FREQUENCY_STEPS.length - 1
        ? Math.max(0.01, relativeDelta)
        : relativeDelta;
    next.frequency = clampParameter(
      next.frequency + arg.sign * delta,
      oscConfigNormales.freqBase,
    );
    next.freqStart = clampParameter(
      next.frequency * ratio,
      oscConfigNormales.freqStart,
    );
  } else if (arg.parameter === 'ratio') {
    const factor = VP_MULTIPLICATIVE_STEPS[arg.pass] ?? 1;
    const ratio = next.freqStart / next.frequency;
    const movedRatio = arg.sign > 0 ? ratio * factor : ratio / factor;
    next.freqStart = clampParameter(
      next.frequency * movedRatio,
      oscConfigNormales.freqStart,
    );
  } else if (arg.parameter === 'duration') {
    const factor = VP_MULTIPLICATIVE_STEPS[arg.pass] ?? 1;
    const movedDuration =
      arg.sign > 0 ? next.duration * factor : next.duration / factor;
    next.duration = clampParameter(
      movedDuration,
      ampEnvConfigNormales.duration,
    );
  } else {
    const step = VP_SLOPE_STEPS[arg.pass] ?? 0;
    next.slope = clampParameter(
      next.slope + arg.sign * step,
      ampEnvConfigNormales.slope,
    );
  }
  return normalizeVariableProjectionAtom(next, arg.origin);
}

/**
 * Применяет один или несколько сдвигов к паре на заданном проходе.
 *
 * @param arg - Центр поиска, исходные сиды, сдвиги и номер прохода
 * @returns Новая пара описаний; входные массивы и атомы не изменяются
 */
function moveVariableProjectionAtPass(arg: {
  center: AtomDescription[];
  origins: AtomDescription[];
  moves: { axis: VariableProjectionAxis; sign: -1 | 1 }[];
  pass: number;
}): AtomDescription[] {
  const next = arg.center.map((description) => ({ ...description }));
  for (const move of arg.moves) {
    const index = move.axis.atomIndex;
    const description = next[index];
    const origin = arg.origins[index];
    if (description === undefined || origin === undefined) {
      continue;
    }
    next[index] = moveVariableProjectionAtom({
      description,
      origin,
      parameter: move.axis.parameter,
      sign: move.sign,
      pass: arg.pass,
    });
  }
  return next;
}

/**
 * Создаёт кэшированный измеритель точек одного прохода VP.
 *
 * @param arg - Центр прохода, слоты, target, остаток для МНК, модель
 *   фазы и флаг clip-aware навигации
 * @returns Оценку центра, функцию измерения и локальные счётчики
 * @remarks Повторная clamped-форма возвращается из кэша. Для новой формы
 *   переиспользуются `PreparedAtom` неизменных атомов центра; базисы
 *   изменённых атомов строятся заново, после чего общий bounded МНК
 *   пересчитывает уровни и фазы всей пары. Clip-режим дополнительно
 *   суммирует полный raw, квантует его и считает PCM RSS без новых
 *   вызовов `prepareAtom` или `renderGroup`.
 */
function createVariableProjectionEvaluator(arg: {
  center: VariableProjectionPoint;
  choice: SlotSetChoice;
  target: number[];
  fitResidual: Float64Array;
  phaseModel: PhaseModel;
  clipAwareNavigation: boolean;
}): VariableProjectionEvaluator {
  const cache = new Map<string, VariableProjectionEvaluation>();
  const centerEvaluation: VariableProjectionEvaluation = {
    descriptions: arg.center.descriptions,
    atoms: arg.center.atoms,
    fit: arg.center.fit,
    gain: arg.center.gain,
    ...(arg.center.clippedRss === undefined
      ? {}
      : { clippedRss: arg.center.clippedRss }),
  };
  const counters: VariableProjectionEvaluationCounters = {
    evaluations: 0,
    unitBasisRenders: 0,
    ...(arg.clipAwareNavigation
      ? { clipObjectiveEvaluations: 0 }
      : {}),
  };
  cache.set(
    variableProjectionShapeKey(arg.center.descriptions),
    centerEvaluation,
  );
  const evaluate = (
    descriptions: AtomDescription[],
  ): VariableProjectionEvaluation => {
    const key = variableProjectionShapeKey(descriptions);
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const atoms = descriptions.map((description, index) => {
      const previous = arg.center.atoms[index];
      if (
        previous !== undefined &&
        atomShapeKey(previous.description) ===
          atomShapeKey(description)
      ) {
        return previous;
      }
      counters.unitBasisRenders += 2;
      return prepareAtom({
        description,
        target: arg.target,
        fitResidual: arg.fitResidual,
        phaseModel: arg.phaseModel,
      });
    });
    counters.evaluations += 1;
    const fit = fitPreparedAtoms(atoms);
    const clippedRss =
      arg.clipAwareNavigation && fit !== null
        ? computeVariableProjectionClipObjective({
            choice: arg.choice,
            atoms,
            fits: fit.fits,
            target: arg.target,
          })
        : null;
    if (clippedRss !== null) {
      counters.clipObjectiveEvaluations =
        (counters.clipObjectiveEvaluations ?? 0) + 1;
    }
    const evaluated: VariableProjectionEvaluation = {
      descriptions,
      atoms,
      fit,
      gain: fit?.gain ?? -Infinity,
      ...(clippedRss === null ? {} : { clippedRss }),
    };
    cache.set(key, evaluated);
    return evaluated;
  };
  return { centerEvaluation, counters, evaluate };
}

/**
 * Строит 16 одиночных и четыре совместных кандидата прохода VP.
 *
 * @param arg - Центр, исходные атомы, номер прохода и измеритель точек
 * @returns Кандидаты в исходном детерминированном порядке
 * @remarks Сначала оси из `VP_AXES` проверяются в направлениях minus/plus.
 *   Затем `VP_PARAMETERS` задаёт четыре совместных хода. Обычный VP
 *   выбирает направление по большему RSS gain, а clip-aware VP — по
 *   меньшему полному PCM RSS. При равенстве оба режима выбирают minus.
 */
function buildVariableProjectionPassCandidates(arg: {
  center: VariableProjectionPoint;
  origins: AtomDescription[];
  pass: number;
  clipAwareNavigation: boolean;
  evaluate: (
    descriptions: AtomDescription[],
  ) => VariableProjectionEvaluation;
}): VariableProjectionEvaluation[] {
  const singles = new Map<
    string,
    {
      minus: VariableProjectionEvaluation;
      plus: VariableProjectionEvaluation;
    }
  >();
  const candidates: VariableProjectionEvaluation[] = [];
  for (const axis of VP_AXES) {
    const minus = arg.evaluate(
      moveVariableProjectionAtPass({
        center: arg.center.descriptions,
        origins: arg.origins,
        moves: [{ axis, sign: -1 }],
        pass: arg.pass,
      }),
    );
    const plus = arg.evaluate(
      moveVariableProjectionAtPass({
        center: arg.center.descriptions,
        origins: arg.origins,
        moves: [{ axis, sign: 1 }],
        pass: arg.pass,
      }),
    );
    singles.set(`${axis.parameter}:${axis.atomIndex}`, {
      minus,
      plus,
    });
    candidates.push(minus, plus);
  }
  for (const parameter of VP_PARAMETERS) {
    const moves: { axis: VariableProjectionAxis; sign: -1 | 1 }[] =
      [];
    for (let atomIndex = 0; atomIndex < 2; atomIndex += 1) {
      const single = singles.get(`${parameter}:${atomIndex}`);
      if (single === undefined) {
        continue;
      }
      const plusWins = arg.clipAwareNavigation
        ? isBetterClipAwareNavigationCandidate(
            single.plus,
            single.minus,
          )
        : single.plus.gain > single.minus.gain;
      moves.push({
        axis: { atomIndex, parameter },
        sign: plusWins ? 1 : -1,
      });
    }
    candidates.push(
      arg.evaluate(
        moveVariableProjectionAtPass({
          center: arg.center.descriptions,
          origins: arg.origins,
          moves,
          pass: arg.pass,
        }),
      ),
    );
  }
  return candidates;
}

/**
 * Обрабатывает один проход VP от оценки ходов до нового центра.
 *
 * @param arg - Текущий центр, контекст exact render, лучший accepted
 *   и флаги clip-aware навигации и refit
 * @returns Новый центр, обновлённый accepted, аудит и стоимость прохода
 * @remarks Обычный VP максимизирует RSS gain, а clip-aware VP минимизирует
 *   полный PCM RSS среди кандидатов и прежнего центра. Строгое сравнение
 *   сохраняет центр при равенстве. Полный global/J guard влияет только на
 *   `bestAccepted` и аудит: центр следующего прохода всегда следует за
 *   raw-победителем выбранной навигационной метрики. При включённом refit
 *   второй exact-кандидат меняет только четыре квадратуры этого победителя;
 *   accepted объединяет исходы raw и refit, а лучший допустимый кандидат
 *   выбирается через прежний `betterCandidate`.
 */
function processVariableProjectionPass(arg: {
  center: VariableProjectionPoint;
  origins: AtomDescription[];
  pass: number;
  state: RenderState;
  seed: BlockCandidate;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  zone: UsefulZone;
  windowedFloor: number;
  fitResidual: Float64Array;
  bestAccepted: BlockCandidate | null;
  clipAwareNavigation: boolean;
  clipAwareRefit: boolean;
}): VariableProjectionPassResult {
  const evaluator = createVariableProjectionEvaluator({
    center: arg.center,
    choice: arg.seed.choice,
    target: arg.target,
    fitResidual: arg.fitResidual,
    phaseModel: arg.phaseModel,
    clipAwareNavigation: arg.clipAwareNavigation,
  });
  const candidates = buildVariableProjectionPassCandidates({
    center: arg.center,
    origins: arg.origins,
    pass: arg.pass,
    clipAwareNavigation: arg.clipAwareNavigation,
    evaluate: evaluator.evaluate,
  });
  let winner = evaluator.centerEvaluation;
  for (const candidate of candidates) {
    const candidateWins = arg.clipAwareNavigation
      ? isBetterClipAwareNavigationCandidate(candidate, winner)
      : candidate.gain > winner.gain;
    if (candidateWins) {
      winner = candidate;
    }
  }
  const rawExact =
    winner.fit === null
      ? null
      : renderBlockCandidate({
          state: arg.state,
          choice: arg.seed.choice,
          atoms: winner.atoms,
          fits: winner.fit.fits,
          target: arg.target,
          sampleRate: arg.sampleRate,
          zone: arg.zone,
        });
  const refit = arg.clipAwareRefit
    ? refitVariableProjectionWinner({
        winner,
        choice: arg.seed.choice,
        state: arg.state,
        target: arg.target,
        sampleRate: arg.sampleRate,
        zone: arg.zone,
      })
    : null;
  const rawAccepted =
    rawExact !== null &&
    acceptsCandidate({
      current: arg.state.metrics,
      candidate: rawExact.state.metrics,
      windowedFloor: arg.windowedFloor,
    });
  const refitAccepted =
    refit?.candidate !== null &&
    refit?.candidate !== undefined &&
    acceptsCandidate({
      current: arg.state.metrics,
      candidate: refit.candidate.state.metrics,
      windowedFloor: arg.windowedFloor,
    });
  const accepted = rawAccepted || refitAccepted;
  let bestAccepted = arg.bestAccepted;
  if (
    rawExact !== null &&
    rawAccepted &&
    betterCandidate(rawExact, bestAccepted)
  ) {
    bestAccepted = rawExact;
  }
  if (
    refit?.candidate !== null &&
    refit?.candidate !== undefined &&
    refitAccepted &&
    betterCandidate(refit.candidate, bestAccepted)
  ) {
    bestAccepted = refit.candidate;
  }
  const audit: VariableProjectionPassAudit = {
    pass: arg.pass + 1,
    winnerGain: winner.gain,
    ...(arg.clipAwareNavigation
      ? { winnerClippedRss: winner.clippedRss ?? null }
      : {}),
    globalSuppressionPercent:
      rawExact?.state.metrics.globalSuppressionPercent ?? null,
    windowedSuppressionPercent:
      rawExact?.state.metrics.windowedSuppressionPercent ?? null,
    accepted,
    evaluations: evaluator.counters.evaluations,
    unitBasisRenders: evaluator.counters.unitBasisRenders,
    ...(arg.clipAwareNavigation
      ? {
          clipObjectiveEvaluations:
            evaluator.counters.clipObjectiveEvaluations ?? 0,
        }
      : {}),
    ...(arg.clipAwareRefit
      ? {
          slots: [...arg.seed.choice.slots],
          shapeKey: variableProjectionShapeKey(winner.descriptions),
          rawGlobalSuppressionPercent:
            rawExact?.state.metrics.globalSuppressionPercent ?? null,
          rawWindowedSuppressionPercent:
            rawExact?.state.metrics.windowedSuppressionPercent ??
            null,
          rawClippedRss: winner.clippedRss ?? null,
          rawAccepted,
          refitGlobalSuppressionPercent:
            refit?.candidate?.state.metrics
              .globalSuppressionPercent ?? null,
          refitWindowedSuppressionPercent:
            refit?.candidate?.state.metrics
              .windowedSuppressionPercent ?? null,
          refitClippedRss: refit?.clippedRss ?? null,
          refitIterations: refit?.iterations ?? 0,
          refitBacktracks: refit?.backtracks ?? 0,
          refitMaskChanges: refit?.maskChanges ?? 0,
          refitObjectiveEvaluations: refit?.objectiveEvaluations ?? 0,
          refitAccepted,
        }
      : {}),
  };
  const center =
    winner.fit === null
      ? arg.center
      : {
          descriptions: winner.descriptions,
          atoms: winner.atoms,
          fit: winner.fit,
          gain: winner.gain,
          ...(winner.clippedRss === undefined
            ? {}
            : { clippedRss: winner.clippedRss }),
        };
  return {
    center,
    bestAccepted,
    audit,
    counters: evaluator.counters,
  };
}

/**
 * Уточняет нелинейные параметры словарной пары пятью проходами VP.
 *
 * @param arg - Проверенное состояние, словарный сид, target, порог J
 *   и флаги clip-aware навигации и refit
 * @returns Лучший принятый кандидат, конечный центр и аудит стоимости
 * @remarks Каждый проход оценивает 16 одиночных и четыре совместных
 *   сдвига. Для каждой точки bounded МНК 4×4 заново решает уровни
 *   и фазы обоих атомов. Победителя выбирают по локальному RSS gain
 *   или по полному clipped PCM RSS. Затем exact render проверяет global
 *   вместе с обоими ограничениями J. Clip-aware refit добавляет второй
 *   exact render с уточнёнными квадратурными коэффициентами, поэтому пять
 *   проходов дают до десяти VP exact-оценок вместо пяти. Guard определяет
 *   только `bestAccepted`: даже отклонённый raw-победитель может стать
 *   центром следующего прохода и попасть в аудит `final`, но не может сам
 *   изменить patch. Clip-оценка центра считается один раз и движется
 *   вместе с ним без повторного рендера базисов.
 */
function refineVariableProjection(arg: {
  state: RenderState;
  seed: BlockCandidate;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  zone: UsefulZone;
  windowedFloor: number;
  clipAwareNavigation: boolean;
  clipAwareRefit: boolean;
}): VariableProjectionRefinement {
  const origins = arg.seed.atoms.map((atom) => ({
    ...atom.description,
  }));
  const seedFit = fitPreparedAtoms(arg.seed.atoms);
  let evaluations = 1;
  let unitBasisRenders = 0;
  let clipObjectiveEvaluations = 0;
  let exactCandidates = 0;
  let bestAccepted: BlockCandidate | null = null;
  const passes: VariableProjectionPassAudit[] = [];
  if (seedFit === null) {
    return {
      bestAccepted,
      final: origins,
      evaluations,
      unitBasisRenders,
      ...(arg.clipAwareNavigation
        ? { clipObjectiveEvaluations }
        : {}),
      ...(arg.clipAwareRefit
        ? {
            refitObjectiveEvaluations: 0,
            refitBacktracks: 0,
            refitIterations: 0,
            refitMaskChanges: 0,
          }
        : {}),
      exactCandidates,
      passes,
    };
  }
  const seedClippedRss = arg.clipAwareNavigation
    ? computeVariableProjectionClipObjective({
        choice: arg.seed.choice,
        atoms: arg.seed.atoms,
        fits: seedFit.fits,
        target: arg.target,
      })
    : null;
  if (seedClippedRss !== null) {
    clipObjectiveEvaluations += 1;
  }
  let center: VariableProjectionPoint = {
    descriptions: origins.map((description) => ({ ...description })),
    atoms: arg.seed.atoms,
    fit: seedFit,
    gain: seedFit.gain,
    ...(seedClippedRss === null
      ? {}
      : { clippedRss: seedClippedRss }),
  };
  const fitResidual = Float64Array.from(
    { length: arg.target.length },
    (_, index) =>
      (arg.target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      (arg.seed.choice.rawWithout[index] ?? 0),
  );
  for (let pass = 0; pass < VP_FREQUENCY_STEPS.length; pass += 1) {
    const processed = processVariableProjectionPass({
      center,
      origins,
      pass,
      state: arg.state,
      seed: arg.seed,
      target: arg.target,
      sampleRate: arg.sampleRate,
      phaseModel: arg.phaseModel,
      zone: arg.zone,
      windowedFloor: arg.windowedFloor,
      fitResidual,
      bestAccepted,
      clipAwareNavigation: arg.clipAwareNavigation,
      clipAwareRefit: arg.clipAwareRefit,
    });
    center = processed.center;
    bestAccepted = processed.bestAccepted;
    evaluations += processed.counters.evaluations;
    unitBasisRenders += processed.counters.unitBasisRenders;
    clipObjectiveEvaluations +=
      processed.counters.clipObjectiveEvaluations ?? 0;
    exactCandidates += arg.clipAwareRefit ? 2 : 1;
    passes.push(processed.audit);
  }
  return {
    bestAccepted,
    final: center.descriptions.map((description) => ({
      ...description,
    })),
    evaluations,
    unitBasisRenders,
    ...(arg.clipAwareNavigation ? { clipObjectiveEvaluations } : {}),
    ...(arg.clipAwareRefit
      ? {
          refitObjectiveEvaluations: passes.reduce(
            (sum, pass) =>
              sum + (pass.refitObjectiveEvaluations ?? 0),
            0,
          ),
          refitBacktracks: passes.reduce(
            (sum, pass) => sum + (pass.refitBacktracks ?? 0),
            0,
          ),
          refitIterations: passes.reduce(
            (sum, pass) => sum + (pass.refitIterations ?? 0),
            0,
          ),
          refitMaskChanges: passes.reduce(
            (sum, pass) => sum + (pass.refitMaskChanges ?? 0),
            0,
          ),
        }
      : {}),
    exactCandidates,
    passes,
  };
}

/** Готовит общий словарь и базисы одной пары или одиночного слота. */
function prepareSlotSet(arg: {
  state: RenderState;
  choice: SlotSetChoice;
  target: number[];
  phaseModel: PhaseModel;
  zone: UsefulZone;
  diverseShortlist: boolean;
}): {
  atoms: PreparedAtom[];
  localEvaluations: number;
  basisRenders: number;
} {
  const withoutSamples = quantizeRaw(arg.choice.rawWithout);
  const searchResidual = Float64Array.from(
    arg.target,
    (value, index) =>
      (value - (withoutSamples[index] ?? 0)) /
      MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  );
  const dictionary = buildPursuitDictionary({
    patch: arg.state.patch,
    residual: searchResidual,
    zone: arg.zone,
    phaseModel: arg.phaseModel,
    diverseShortlist: arg.diverseShortlist,
  });
  const fitResidual = Float64Array.from(
    { length: arg.target.length },
    (_, index) =>
      (arg.target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      (arg.choice.rawWithout[index] ?? 0),
  );
  const atoms = dictionary.descriptions.map((description) =>
    prepareAtom({
      description,
      target: arg.target,
      fitResidual,
      phaseModel: arg.phaseModel,
    }),
  );
  return {
    atoms,
    localEvaluations: dictionary.localEvaluations,
    basisRenders: atoms.length * 2,
  };
}

/** Точно проверяет одиночные атомы или восемь лучших совместных пар. */
function searchPreparedSlotSet(arg: {
  state: RenderState;
  choice: SlotSetChoice;
  atoms: PreparedAtom[];
  blockSize: PursuitBlockSize;
  target: number[];
  sampleRate: number;
  zone: UsefulZone;
  windowedFloor: number;
}): {
  bestAccepted: BlockCandidate | null;
  bestAny: BlockCandidate | null;
  exactEvaluations: number;
  jointEvaluations: number;
} {
  const combinations: {
    atoms: PreparedAtom[];
    fit: JointFit | null;
  }[] = [];
  let jointEvaluations = 0;
  if (arg.blockSize === 1) {
    for (const atom of arg.atoms) {
      const fit = fitPreparedAtoms([atom]);
      jointEvaluations += 1;
      combinations.push({ atoms: [atom], fit });
    }
  } else {
    for (let first = 0; first < arg.atoms.length; first += 1) {
      for (
        let second = first + 1;
        second < arg.atoms.length;
        second += 1
      ) {
        const firstAtom = arg.atoms[first];
        const secondAtom = arg.atoms[second];
        if (firstAtom === undefined || secondAtom === undefined) {
          continue;
        }
        const atoms = [firstAtom, secondAtom];
        const fit = fitPreparedAtoms(atoms);
        jointEvaluations += 1;
        if (fit !== null) {
          combinations.push({ atoms, fit });
        }
      }
    }
    combinations.sort(
      (a, b) =>
        (b.fit?.gain ?? -Infinity) - (a.fit?.gain ?? -Infinity),
    );
    combinations.splice(EXACT_PAIRS_PER_SLOT_SET);
  }
  let bestAccepted: BlockCandidate | null = null;
  let bestAny: BlockCandidate | null = null;
  let exactEvaluations = 0;
  for (const combination of combinations) {
    if (combination.fit === null) {
      continue;
    }
    const candidate = renderBlockCandidate({
      state: arg.state,
      choice: arg.choice,
      atoms: combination.atoms,
      fits: combination.fit.fits,
      target: arg.target,
      sampleRate: arg.sampleRate,
      zone: arg.zone,
    });
    exactEvaluations += 1;
    if (candidate === null) {
      continue;
    }
    if (betterCandidate(candidate, bestAny)) {
      bestAny = candidate;
    }
    if (
      acceptsCandidate({
        current: arg.state.metrics,
        candidate: candidate.state.metrics,
        windowedFloor: arg.windowedFloor,
      }) &&
      betterCandidate(candidate, bestAccepted)
    ) {
      bestAccepted = candidate;
    }
  }
  return {
    bestAccepted,
    bestAny,
    exactEvaluations,
    jointEvaluations,
  };
}

/** Сохраняет новые solo-вклады всех слотов принятого блока. */
function replaceBlockContributions(arg: {
  contributions: (Float64Array | null)[];
  candidate: BlockCandidate;
  sampleCount: number;
  phaseModel: PhaseModel;
}): (Float64Array | null)[] {
  const next = [...arg.contributions];
  for (
    let index = 0;
    index < arg.candidate.choice.slots.length;
    index += 1
  ) {
    const slot = arg.candidate.choice.slots[index];
    const group = arg.candidate.state.patch.oscillators[slot ?? -1];
    if (slot === undefined || group === undefined) {
      continue;
    }
    next[slot] = renderGroup(group, arg.sampleCount, arg.phaseModel);
  }
  return next;
}

/** Создаёт запись аудита для каждого атома принятого блока. */
function auditAtoms(arg: {
  previousPatch: ArgCreateSynth;
  candidate: BlockCandidate;
}): BlockPursuitAtom[] {
  const atoms: BlockPursuitAtom[] = [];
  for (
    let index = 0;
    index < arg.candidate.atoms.length;
    index += 1
  ) {
    const atom = arg.candidate.atoms[index];
    const fit = arg.candidate.fits[index];
    const slot = arg.candidate.choice.slots[index];
    if (
      atom === undefined ||
      fit === undefined ||
      slot === undefined
    ) {
      continue;
    }
    const previous = arg.previousPatch.oscillators[slot];
    atoms.push({
      slot,
      replacedFrequency: previous?.osc.on
        ? previous.osc.freqBase
        : null,
      frequency: atom.description.frequency,
      freqStart: atom.description.freqStart,
      duration: atom.description.duration,
      slope: atom.description.slope,
      oscDuration: atom.description.oscDuration,
      oscSlope: atom.description.oscSlope,
      window: atom.description.window,
      sweepTemplateIndex: atom.description.sweepTemplateIndex,
      localGain: atom.description.localGain,
      startLevel: fit.startLevel,
      phase: fit.phase,
    });
  }
  return atoms;
}

/**
 * Ищет лучший блок не более чем в двух наборах слотов.
 *
 * @param arg - Состояние, target, ограничения поиска, флаги VP
 *   и clip-aware навигации
 * @returns Принятый блок, стоимость и необязательный аудит VP
 * @remarks В K2-VP отклонённый guard'ом `bestAny` служит только
 *   сидом для нелинейного уточнения и никогда не возвращается как
 *   принятый блок. Если VP не даёт лучшего принятого кандидата,
 *   сохраняется обычный принятый K2; без такого K2 исходный patch
 *   остаётся неизменным.
 */
function pursueOneBlock(arg: {
  state: RenderState;
  contributions: (Float64Array | null)[];
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  zone: UsefulZone;
  windowedFloor: number;
  step: number;
  blockSize: PursuitBlockSize;
  usedSlots: ReadonlySet<number>;
  diverseShortlist: boolean;
  variableProjection: boolean;
  clipAwareNavigation: boolean;
  clipAwareRefit: boolean;
}): {
  accepted: AcceptedBlock | null;
  counters: AttemptCounters;
  variableProjection?: VariableProjectionAttemptAudit;
} {
  const counters: AttemptCounters = {
    localEvaluations: 0,
    jointEvaluations: 0,
    exactEvaluations: 0,
    basisRenders: 0,
    slotSetsEvaluated: 0,
  };
  const choices = rankSlotSets({
    state: arg.state,
    contributions: arg.contributions,
    target: arg.target,
    usedSlots: arg.usedSlots,
    blockSize: arg.blockSize,
  });
  let bestAccepted: BlockCandidate | null = null;
  let bestAny: BlockCandidate | null = null;
  for (const choice of choices) {
    counters.slotSetsEvaluated += 1;
    const prepared = prepareSlotSet({
      state: arg.state,
      choice,
      target: arg.target,
      phaseModel: arg.phaseModel,
      zone: arg.zone,
      diverseShortlist: arg.diverseShortlist,
    });
    counters.localEvaluations += prepared.localEvaluations;
    counters.basisRenders += prepared.basisRenders;
    const searched = searchPreparedSlotSet({
      state: arg.state,
      choice,
      atoms: prepared.atoms,
      blockSize: arg.blockSize,
      target: arg.target,
      sampleRate: arg.sampleRate,
      zone: arg.zone,
      windowedFloor: arg.windowedFloor,
    });
    counters.exactEvaluations += searched.exactEvaluations;
    counters.jointEvaluations += searched.jointEvaluations;
    if (
      searched.bestAccepted !== null &&
      betterCandidate(searched.bestAccepted, bestAccepted)
    ) {
      bestAccepted = searched.bestAccepted;
    }
    if (
      searched.bestAny !== null &&
      betterCandidate(searched.bestAny, bestAny)
    ) {
      bestAny = searched.bestAny;
    }
  }
  if (!arg.variableProjection || arg.blockSize !== 2) {
    if (bestAccepted === null) {
      return { accepted: null, counters };
    }
    const audit: BlockPursuitStep = {
      step: arg.step,
      atoms: auditAtoms({
        previousPatch: arg.state.patch,
        candidate: bestAccepted,
      }),
      before: arg.state.metrics,
      after: bestAccepted.state.metrics,
      exactCandidates: counters.exactEvaluations,
      jointCandidates: counters.jointEvaluations,
      slotSetsEvaluated: counters.slotSetsEvaluated,
    };
    return {
      accepted: {
        state: bestAccepted.state,
        contributions: replaceBlockContributions({
          contributions: arg.contributions,
          candidate: bestAccepted,
          sampleCount: arg.target.length,
          phaseModel: arg.phaseModel,
        }),
        audit,
      },
      counters,
    };
  }
  const seedAccepted = bestAccepted !== null;
  const seed = bestAccepted ?? bestAny;
  if (seed === null) {
    return {
      accepted: null,
      counters,
      variableProjection: {
        step: arg.step,
        seedAccepted: false,
        outcome: 'no-seed',
        seed: null,
        final: null,
        evaluations: 0,
        unitBasisRenders: 0,
        ...(arg.clipAwareNavigation
          ? { clipObjectiveEvaluations: 0 }
          : {}),
        ...(arg.clipAwareRefit
          ? {
              refitObjectiveEvaluations: 0,
              refitBacktracks: 0,
              refitIterations: 0,
              refitMaskChanges: 0,
            }
          : {}),
        exactCandidates: 0,
        passes: [],
      },
    };
  }
  const refined = refineVariableProjection({
    state: arg.state,
    seed,
    target: arg.target,
    sampleRate: arg.sampleRate,
    phaseModel: arg.phaseModel,
    zone: arg.zone,
    windowedFloor: arg.windowedFloor,
    clipAwareNavigation: arg.clipAwareNavigation,
    clipAwareRefit: arg.clipAwareRefit,
  });
  let best = bestAccepted;
  let outcome: VariableProjectionOutcome = bestAccepted
    ? 'k2-fallback'
    : 'no-accepted';
  if (
    refined.bestAccepted !== null &&
    betterCandidate(refined.bestAccepted, bestAccepted)
  ) {
    best = refined.bestAccepted;
    outcome = 'accepted';
  }
  const variableProjection: VariableProjectionAttemptAudit = {
    step: arg.step,
    seedAccepted,
    outcome,
    seed: variableProjectionAtomsAudit(
      seed.atoms.map((atom) => atom.description),
    ),
    final: variableProjectionAtomsAudit(refined.final),
    evaluations: refined.evaluations,
    unitBasisRenders: refined.unitBasisRenders,
    ...(refined.clipObjectiveEvaluations === undefined
      ? {}
      : {
          clipObjectiveEvaluations: refined.clipObjectiveEvaluations,
        }),
    ...(refined.refitObjectiveEvaluations === undefined
      ? {}
      : {
          refitObjectiveEvaluations:
            refined.refitObjectiveEvaluations,
          refitBacktracks: refined.refitBacktracks ?? 0,
          refitIterations: refined.refitIterations ?? 0,
          refitMaskChanges: refined.refitMaskChanges ?? 0,
        }),
    exactCandidates: refined.exactCandidates,
    passes: refined.passes,
  };
  if (best === null) {
    return { accepted: null, counters, variableProjection };
  }
  const audit: BlockPursuitStep = {
    step: arg.step,
    atoms: auditAtoms({
      previousPatch: arg.state.patch,
      candidate: best,
    }),
    before: arg.state.metrics,
    after: best.state.metrics,
    exactCandidates: counters.exactEvaluations,
    jointCandidates: counters.jointEvaluations,
    slotSetsEvaluated: counters.slotSetsEvaluated,
    variableProjection,
  };
  return {
    accepted: {
      state: best.state,
      contributions: replaceBlockContributions({
        contributions: arg.contributions,
        candidate: best,
        sampleCount: arg.target.length,
        phaseModel: arg.phaseModel,
      }),
      audit,
    },
    counters,
    variableProjection,
  };
}

/**
 * Суммирует стоимость и исходы всех VP-попыток, включая неудачные.
 *
 * @param attempts - Аудит каждой выполненной попытки VP
 * @param clipAwareNavigation - Нужно ли суммировать отдельный счётчик
 *   навигационных clip-оценок; при `false` новое поле не появляется
 * @param clipAwareRefit - Нужно ли суммировать отдельные счётчики E-refit;
 *   при `false` его поля не появляются
 * @returns Общие счётчики и подробные записи по каждому блоку
 */
function summarizeVariableProjection(
  attempts: VariableProjectionAttemptAudit[],
  clipAwareNavigation: boolean,
  clipAwareRefit: boolean,
): VariableProjectionSummary {
  return {
    evaluations: attempts.reduce(
      (sum, attempt) => sum + attempt.evaluations,
      0,
    ),
    unitBasisRenders: attempts.reduce(
      (sum, attempt) => sum + attempt.unitBasisRenders,
      0,
    ),
    ...(clipAwareNavigation
      ? {
          clipObjectiveEvaluations: attempts.reduce(
            (sum, attempt) =>
              sum + (attempt.clipObjectiveEvaluations ?? 0),
            0,
          ),
        }
      : {}),
    ...(clipAwareRefit
      ? {
          refitObjectiveEvaluations: attempts.reduce(
            (sum, attempt) =>
              sum + (attempt.refitObjectiveEvaluations ?? 0),
            0,
          ),
          refitBacktracks: attempts.reduce(
            (sum, attempt) => sum + (attempt.refitBacktracks ?? 0),
            0,
          ),
          refitIterations: attempts.reduce(
            (sum, attempt) => sum + (attempt.refitIterations ?? 0),
            0,
          ),
          refitMaskChanges: attempts.reduce(
            (sum, attempt) => sum + (attempt.refitMaskChanges ?? 0),
            0,
          ),
        }
      : {}),
    exactCandidates: attempts.reduce(
      (sum, attempt) => sum + attempt.exactCandidates,
      0,
    ),
    accepted: attempts.filter(
      (attempt) => attempt.outcome === 'accepted',
    ).length,
    k2Fallback: attempts.filter(
      (attempt) => attempt.outcome === 'k2-fallback',
    ).length,
    noSeed: attempts.filter(
      (attempt) => attempt.outcome === 'no-seed',
    ).length,
    noAccepted: attempts.filter(
      (attempt) => attempt.outcome === 'no-accepted',
    ).length,
    attempts,
  };
}

/**
 * Возвращает исходник после поиска без принятого результата.
 *
 * @param arg - Исходник, счётчики и необязательный аудит VP
 * @returns Результат `unchanged` с копией patch и исходными samples
 * @remarks Аудит VP сохраняется даже при отказе, но отклонённые сиды
 *   и промежуточные кандидаты не попадают в возвращаемые patch и WAV.
 */
function unchangedResult(arg: {
  patch: ArgCreateSynth;
  initial: RenderState;
  counters: AttemptCounters;
  variableProjection?: VariableProjectionSummary;
}): BlockPursuitResult {
  return {
    status: 'unchanged',
    patch: clonePatch(arg.patch),
    samples: arg.initial.samples,
    baseline: arg.initial.metrics,
    metrics: arg.initial.metrics,
    steps: [],
    ...arg.counters,
    replacementCount: 0,
    ...(arg.variableProjection === undefined
      ? {}
      : { variableProjection: arg.variableProjection }),
  };
}

/**
 * Выполняет не более `maxBlocks` жадных одиночных или парных замен.
 *
 * @param arg - Match, target PCM, размер блока и опции поиска;
 *   `variableProjection`, `clipAwareNavigation` и `clipAwareRefit`
 *   по умолчанию равны `false`
 * @returns Лучший patch/WAV и аудит; при неудаче — исходник
 * @remarks K1 и K2 используют общий словарь и проверяют до двух
 *   наборов слотов на шаг. K2 ранжирует пары совместным МНК 4×4 и
 *   точно проверяет восемь лучших пар на набор. Слот меняется
 *   не более одного раза за прогон. Каждый блок повышает global
 *   минимум на 0.005 п.п.; J не падает больше чем на 0.01 п.п. от
 *   текущего и 0.05 п.п. от исходного match.
 *   `variableProjection=true` включает
 *   пять проходов только для K2. Уровни и фазы каждой VP-точки решает
 *   общий bounded МНК 4×4. Отклонённый словарный `bestAny` служит
 *   только сидом: принять блок можно лишь после полного global/J
 *   guard. `clipAwareNavigation=true` действует только вместе с K2-VP:
 *   направление и победителя выбирает RSS полного PCM после clip и
 *   квантования, включая центр. Число exact render, базисов и правила
 *   принятия не меняются, а `clipObjectiveEvaluations` считает только
 *   новые clip-оценки. Без этого флага clip-объектив не вычисляется.
 *   `clipAwareRefit=true` действует только вместе с clip-aware K2-VP.
 *   После выбора raw-победителя один E-старт уточняет четыре квадратуры
 *   при фиксированных слотах, базисах и `rawWithout`; полный сигнал
 *   клиппируется только после сложения внешнего вклада и пары. На проход
 *   разрешены 25 принятых итераций и ограниченный backtracking. Refit
 *   добавляет второй exact-кандидат и свои счётчики, но не меняет центр,
 *   winnerGain/winnerClippedRss или число unit-базисов. Оба кандидата
 *   проходят прежний guard, raw остаётся fallback.
 *   Финальный WAV получается каноническим рендером патча и повторно
 *   проходит суммарный global/J guard; новый CD не запускается. Это
 *   offline-screening вне production: он не доказывает закон T35 и не
 *   показывает, что достигнуты 98% suppression.
 * @throws Error если target пуст, sample rate не 44100 Гц,
 *   blockSize не 1/2 или maxBlocks не целый от 1 до 12
 */
export function pursueResidualBlocks(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  blockSize: PursuitBlockSize;
  maxBlocks?: number;
  diverseShortlist?: boolean;
  variableProjection?: boolean;
  clipAwareNavigation?: boolean;
  clipAwareRefit?: boolean;
}): BlockPursuitResult {
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  const maxBlocks = arg.maxBlocks ?? DEFAULT_BLOCKS;
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Block pursuit поддерживает только 44100 Гц');
  }
  if (arg.target.length === 0) {
    throw new Error('Пустой target');
  }
  if (arg.blockSize !== 1 && arg.blockSize !== 2) {
    throw new Error('blockSize должен быть 1 или 2');
  }
  if (
    !Number.isInteger(maxBlocks) ||
    maxBlocks < 1 ||
    maxBlocks > MAX_BLOCKS
  ) {
    throw new Error(
      `maxBlocks должен быть целым от 1 до ${MAX_BLOCKS}`,
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
  const usedSlots = new Set<number>();
  const steps: BlockPursuitStep[] = [];
  const variableProjectionEnabled =
    (arg.variableProjection ?? false) && arg.blockSize === 2;
  const clipAwareNavigationEnabled =
    variableProjectionEnabled && (arg.clipAwareNavigation ?? false);
  const clipAwareRefitEnabled =
    clipAwareNavigationEnabled && (arg.clipAwareRefit ?? false);
  const variableProjectionAttempts: VariableProjectionAttemptAudit[] =
    [];
  const counters: AttemptCounters = {
    localEvaluations: 0,
    jointEvaluations: 0,
    exactEvaluations: 0,
    basisRenders: 0,
    slotSetsEvaluated: 0,
  };
  const windowedFloor =
    initial.metrics.windowedSuppressionPercent -
    INITIAL_WINDOWED_TOLERANCE;
  for (let step = 1; step <= maxBlocks; step += 1) {
    const attempt = pursueOneBlock({
      state,
      contributions,
      target,
      sampleRate,
      phaseModel,
      zone,
      windowedFloor,
      step,
      blockSize: arg.blockSize,
      usedSlots,
      diverseShortlist: arg.diverseShortlist ?? false,
      variableProjection: variableProjectionEnabled,
      clipAwareNavigation: clipAwareNavigationEnabled,
      clipAwareRefit: clipAwareRefitEnabled,
    });
    if (attempt.variableProjection !== undefined) {
      variableProjectionAttempts.push(attempt.variableProjection);
    }
    for (const key of Object.keys(
      counters,
    ) as (keyof AttemptCounters)[]) {
      counters[key] += attempt.counters[key];
    }
    if (attempt.accepted === null) {
      break;
    }
    state = attempt.accepted.state;
    contributions = attempt.accepted.contributions;
    steps.push(attempt.accepted.audit);
    for (const atom of attempt.accepted.audit.atoms) {
      usedSlots.add(atom.slot);
    }
  }
  const variableProjection = variableProjectionEnabled
    ? summarizeVariableProjection(
        variableProjectionAttempts,
        clipAwareNavigationEnabled,
        clipAwareRefitEnabled,
      )
    : undefined;
  if (steps.length === 0) {
    return unchangedResult({
      patch: arg.patch,
      initial,
      counters,
      variableProjection,
    });
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
    !Number.isFinite(finalMetrics.globalSuppressionPercent) ||
    !Number.isFinite(finalMetrics.windowedSuppressionPercent) ||
    finalMetrics.globalSuppressionPercent <
      initial.metrics.globalSuppressionPercent +
        steps.length * MIN_GLOBAL_GAIN ||
    finalMetrics.windowedSuppressionPercent <
      state.metrics.windowedSuppressionPercent -
        CURRENT_WINDOWED_TOLERANCE ||
    finalMetrics.windowedSuppressionPercent < windowedFloor
  ) {
    return unchangedResult({
      patch: arg.patch,
      initial,
      counters,
      variableProjection,
    });
  }
  return {
    status: 'refined',
    patch: state.patch,
    samples: finalSamples,
    baseline: initial.metrics,
    metrics: finalMetrics,
    steps,
    ...counters,
    replacementCount: steps.reduce(
      (sum, step) => sum + step.atoms.length,
      0,
    ),
    ...(variableProjection === undefined
      ? {}
      : { variableProjection }),
  };
}
