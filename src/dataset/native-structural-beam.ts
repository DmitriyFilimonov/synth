/**
 * Соединяет native structural-атомы, joint-K solver и generic beam для T38.
 *
 * Входной target остаётся PCM в единицах Int16 и один раз нормализуется для
 * solver. Каждый candidate получает независимый canonical render и метрики;
 * quantized PCM внутри solver не заменяет этот результат. Модуль работает
 * только на synthetic known-answer и не подключается к match/enhance/API.
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
  MAX_OSCILLATORS,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  DEFAULT_JOINT_K_QUADRATURE_OPTIONS,
  solveJointKQuadrature,
  type JointKQuadratureResult,
} from './joint-k-quadrature';
import {
  clonePatch,
  measureMetrics,
  renderForTarget,
  renderGroup,
  type RefitMetrics,
} from './quadrature-refit';
import {
  patchFromStructuralCandidate,
  renderStructuralBasis,
  structuralAtomShapeKey,
  type StructuralAtomShape,
} from './structural-atom';
import {
  runStructuralBeam,
  type StructuralBeamCandidate,
  type StructuralBeamCompactResult,
  type StructuralBeamEvaluation,
  type StructuralBeamNode,
  type StructuralBeamOptions,
  type StructuralBeamResult,
} from './structural-beam';
import {
  aggregateNativeStructuralDenseWork,
  compactNativeStructuralHistory,
  compactNativeStructuralValue,
  type NativeStructuralAuditState,
  type NativeStructuralCompactHistoryEntry,
  type NativeStructuralCompactNode,
} from './native-structural-audit';
import {
  normalizeStructuralExpansion,
  type StructuralExpansionResult,
} from './structural-expansion';
import {
  jsonArrayOrderToken,
  jsonStringOrderToken,
  orderTokenFromRaw,
} from './structural-key-order';
import {
  addStructuralSampleWork,
  createStructuralWorkLedger,
  snapshotStructuralWork,
  type StructuralDenseWork,
  type StructuralSampleWork,
  type StructuralWorkLedger,
} from './structural-work';

export type {
  JointKQuadratureAudit,
  NativeStructuralAuditState,
  NativeStructuralCompactHistoryEntry,
  NativeStructuralCompactNode,
  NativeStructuralEvaluationAudit,
} from './native-structural-audit';

/** Canonical native-состояние, которое proposer получает без vector conversion. */
export interface NativeStructuralState {
  patch: ArgCreateSynth;
  samples: Int16Array;
  metrics: RefitMetrics;
  /** Сумма canonical contribution без clip; off slots не добавляют энергию. */
  rawSum: Float64Array;
  /**
   * Полный solo-cache есть только у root для совместимости. Evaluated node
   * хранит null и не удерживает 50 буферов длины N. При null evaluator
   * рендерит по одному только старые selected contributions parent.patch.
   */
  contributions: readonly (Float64Array | null)[] | null;
  /** Root хранит null, а evaluated node — весь solver/canonical аудит. */
  evaluation: NativeStructuralEvaluation | null;
}

/**
 * Parent с metadata пути, переданный injected `propose(parent)`.
 * Proposer читает patch/PCM напрямую: contributions равен null у evaluated
 * parent, а полный root cache не является обязательным входным контрактом.
 */
export interface NativeStructuralParent extends NativeStructuralState {
  depth: number;
  nodeKey: string;
  candidateKey: string | null;
}

/**
 * Одна группа полных native-форм; коэффициенты решает evaluator.
 * Слот может продолжить patch с индекса `parent.patch.oscillators.length`;
 * пропуск в appended-диапазоне отклоняется до basis render и solver.
 */
export interface NativeStructuralProposal {
  slots: readonly number[];
  shapes: readonly StructuralAtomShape[];
}

/**
 * Прежний массив proposals либо measured `{ candidates, cost }`.
 * Массив сохраняет нулевую expansion cost, а объект списывает
 * фактическую работу proposer в общий W.
 */
export type NativeStructuralProposeResult =
  StructuralExpansionResult<NativeStructuralProposal>;

/**
 * Stateless native proposer; measured expansion является opt-in.
 *
 * @param parent - Canonical native-состояние и metadata текущего узла
 * @returns Массив proposals либо measured `{ candidates, cost }`
 */
export type NativeStructuralPropose = (
  parent: NativeStructuralParent,
) => NativeStructuralProposeResult;

/**
 * Возвращает conservative estimate только для proposer, не для
 * evaluator.
 *
 * @param parent - Canonical native-состояние и metadata текущего узла
 * @returns Конечный неотрицательный верхний предел expansion cost в
 *   единицах W
 */
export type NativeStructuralExpansionEstimate = (
  parent: NativeStructuralParent,
) => number;

/**
 * Независимая session одного запуска или одной ветви width-control.
 * Внутреннее состояние и measured cost принадлежат только этой
 * session.
 */
export interface NativeStructuralProposerSession {
  /**
   * Возвращает proposals и при measured API их фактическую стоимость.
   */
  propose: NativeStructuralPropose;
  /** Возвращает conservative estimate до вызова `propose`. */
  estimateExpansion?: NativeStructuralExpansionEstimate;
}

/**
 * Создаёт новую session с одинаковым начальным состоянием для
 * каждой ветви.
 *
 * @returns Новая независимая session proposer
 */
export type NativeStructuralProposerSessionFactory =
  () => NativeStructuralProposerSession;

/** Раздельный учёт canonical N-проходов вне solver ledger. */
export interface NativeStructuralCanonicalWork {
  fixedOffsetCopy: number;
  /** Старые selected renders, нужные только при parent.contributions=null. */
  parentContributionRenders: number;
  selectedContributionRenders: number;
  rawSumAssembly: number;
  canonicalRender: number;
  canonicalAssertion: number;
  canonicalMetrics: number;
  total: number;
}

/** Полный аудит одного evaluator call; cost не включает dense-операции. */
export interface NativeStructuralEvaluation {
  proposal: NativeStructuralProposal;
  /** Raw parent sum после однократного удаления старых selected slots. */
  fixedOffset: Float64Array;
  solver: JointKQuadratureResult;
  sampleWork: StructuralSampleWork;
  denseWork: StructuralDenseWork;
  canonicalWork: NativeStructuralCanonicalWork;
  /** Фактические N-pass единицы: basis, solver и canonical стадии вместе. */
  cost: number;
}

export type NativeStructuralNode = StructuralBeamNode<
  NativeStructuralState,
  RefitMetrics
>;

/** Лучший evaluated candidate до финального guard, даже если победил root. */
export interface NativeStructuralProposed {
  nodeKey: string;
  candidateKey: string;
  parentKey: string | null;
  depth: number;
  groupSize: number;
  estimatedWork: number;
  cost: number;
  patch: ArgCreateSynth;
  samples: Int16Array;
  metrics: RefitMetrics;
  evaluation: NativeStructuralEvaluation;
}

/** История evaluator calls в фактическом deterministic порядке. */
export interface NativeStructuralHistoryEntry {
  nodeKey: string;
  candidateKey: string;
  parentKey: string | null;
  depth: number;
  groupSize: number;
  estimatedWork: number;
  cost: number;
  proposal: NativeStructuralProposal;
  fixedOffset: Float64Array;
  solver: JointKQuadratureResult;
  sampleWork: StructuralSampleWork;
  denseWork: StructuralDenseWork;
  canonicalWork: NativeStructuralCanonicalWork;
}

export type NativeStructuralCanonicalAssert =
  typeof assertPatchMatchesWav;

/** Общие поля native synthetic beam независимо от способа подачи proposer. */
export interface NativeStructuralBeamBaseOptions {
  patch: ArgCreateSynth;
  /** Ненулевой mono PCM в единицах Int16; повторного квантования нет. */
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  beamWidth: number;
  maxDepth: number;
  maxGroupSize: number;
  /**
   * W покрывает evaluator и opt-in measured expansion; root и
   * finalization в этот бюджет не входят.
   */
  workBudget: number;
  maxInner?: number;
  maxBacktracks?: number;
  /**
   * Точка synthetic mismatch-контроля; по умолчанию вызывается общий
   * `assertPatchMatchesWav`. Production runner сюда не подключается.
   */
  assertCanonical?: NativeStructuralCanonicalAssert;
  /** Полностью legacy full audit остаётся режимом по умолчанию. */
  auditMode?: 'full';
}

/**
 * Вход native synthetic beam с ровно одним источником proposals.
 *
 * Прямой `propose` сохраняет прежний stateless API. Для stateful
 * proposer и независимого width-control следует передать
 * `createProposerSession`: factory вызывается отдельно для основной и
 * width-1 ветви. Необязательный estimator задаётся рядом с прямым
 * `propose` или внутри session, относится только к measured
 * expansion и использует те же caller-defined единицы W.
 */
export type NativeStructuralProposerOptions =
  | {
      propose: NativeStructuralPropose;
      estimateExpansion?: NativeStructuralExpansionEstimate;
      createProposerSession?: never;
    }
  | {
      propose?: never;
      estimateExpansion?: never;
      createProposerSession: NativeStructuralProposerSessionFactory;
    };

/** Прежний full/default вход без обязательного режима. */
export type NativeStructuralBeamOptions =
  NativeStructuralBeamBaseOptions & NativeStructuralProposerOptions;

/**
 * Opt-in вход с bounded IDs и light evaluated/depths/path/history.
 * Exact legacy ordering остаётся в скрытых lazy order tokens.
 */
export type NativeStructuralCompactBeamOptions = Omit<
  NativeStructuralBeamBaseOptions,
  'auditMode'
> & {
  auditMode: 'compact';
} & NativeStructuralProposerOptions;

type AnyNativeStructuralBeamOptions =
  NativeStructuralBeamOptions | NativeStructuralCompactBeamOptions;

/** Общий saved/proposed/root/work результат обоих режимов аудита. */
interface NativeStructuralBeamResultCommon {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  baseline: RefitMetrics;
  metrics: RefitMetrics;
  proposed: NativeStructuralProposed | null;
  rejectionReason: string | null;
  canonicalError: string | null;
  root: NativeStructuralNode;
  bestAny: NativeStructuralNode;
  work: StructuralBeamResult<
    NativeStructuralState,
    RefitMetrics
  >['work'];
  /**
   * N-pass evaluator ветви; без measured expansion совпадает с
   * прежним `work.used`.
   */
  evaluatorWork: number;
  /**
   * Caller-defined proposer work ветви; не примешивается к denseWork.
   */
  expansionWork: number;
  /** Expansion parent/depth/estimate/cost/keys только этой ветви. */
  expansions: StructuralBeamResult<
    NativeStructuralState,
    RefitMetrics
  >['expansions'];
  /**
   * Тот же expansion-skip аудит, что и в `skips.expansionBudget`.
   */
  skippedExpansionBudget: StructuralBeamResult<
    NativeStructuralState,
    RefitMetrics
  >['skippedExpansionBudget'];
  skips: {
    budget: StructuralBeamResult<
      NativeStructuralState,
      RefitMetrics
    >['work']['skippedBudget'];
    expansionBudget: StructuralBeamResult<
      NativeStructuralState,
      RefitMetrics
    >['skippedExpansionBudget'];
    groupSize: StructuralBeamResult<
      NativeStructuralState,
      RefitMetrics
    >['skippedGroupSize'];
  };
  /** Суммарная dense-работа candidates хранится вне W. */
  denseWork: StructuralDenseWork;
  /** Повторный render/assert/global/J лучшего узла; в candidate W не входит. */
  finalizationSampleWork: number;
}

/**
 * Полностью legacy full audit с canonical values у всех evaluated nodes,
 * recursive keys и raw-string ordering.
 */
export interface NativeStructuralBeamResult extends NativeStructuralBeamResultCommon {
  bestPath: NativeStructuralNode[];
  /** Короткий alias того же пути от root до bestAny. */
  path: NativeStructuralNode[];
  depths: StructuralBeamResult<
    NativeStructuralState,
    RefitMetrics
  >['depths'];
  evaluated: NativeStructuralNode[];
  history: NativeStructuralHistoryEntry[];
}

/**
 * Compact audit хранит light history без N-мерных arrays и order tokens;
 * подробные root/bestAny/proposed/saved остаются отдельно.
 */
export interface CompactNativeStructuralBeamResult extends NativeStructuralBeamResultCommon {
  bestPath: NativeStructuralCompactNode[];
  path: NativeStructuralCompactNode[];
  depths: StructuralBeamCompactResult<
    NativeStructuralState,
    RefitMetrics,
    NativeStructuralAuditState
  >['depths'];
  evaluated: NativeStructuralCompactNode[];
  history: NativeStructuralCompactHistoryEntry[];
}

/** Две полные ветви делят один prepared canonical root и исходный W. */
export interface NativeStructuralWidthControlResult {
  beam: NativeStructuralBeamResult;
  width1: NativeStructuralBeamResult;
}

/** Две compact-ветви с независимыми proposer sessions и light history. */
export interface CompactNativeStructuralWidthControlResult {
  beam: CompactNativeStructuralBeamResult;
  width1: CompactNativeStructuralBeamResult;
}

type PreparedNativeProposer =
  | {
      kind: 'stateless';
      propose: NativeStructuralPropose;
      estimateExpansion?: NativeStructuralExpansionEstimate;
    }
  | {
      kind: 'factory';
      createSession: NativeStructuralProposerSessionFactory;
    };

interface PreparedNativeRun {
  source: ArgCreateSynth;
  rootState: NativeStructuralState;
  target: number[];
  normalizedTarget: Float64Array;
  sampleRate: number;
  phaseModel: PhaseModel;
  usefulZone: UsefulZone;
  maxInner: number;
  maxBacktracks: number;
  /** Factory хранится невызванной до начала конкретной ветви. */
  proposer: PreparedNativeProposer;
  assertCanonical: NativeStructuralCanonicalAssert;
}

interface FinalizedNativeStructuralResult {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  metrics: RefitMetrics;
  proposed: NativeStructuralProposed | null;
  rejectionReason: string | null;
  canonicalError: string | null;
  finalizationSampleWork: number;
}

const ROOT_KEY = 'native-root';
const GLOBAL_EPSILON = 1e-10;
const WINDOWED_FLOOR = 0.05;

/** Проверяет целый параметр до canonical root или первого proposal. */
function assertInteger(
  value: number,
  label: string,
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
}

/** Проверяет общий W без приравнивания его к CD iterations. */
function assertWorkBudget(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('workBudget must be finite and non-negative');
  }
}

/**
 * Возвращает conservative upper bound фактических N-pass единиц candidate.
 *
 * Формула включает fixed-offset copy/subtraction, 2K native basis и их
 * проверки, весь ограниченный solver, selected canonical contributions,
 * rawSum, полный render, повторный assert и независимые global/J. На каждую
 * inner-попытку отводятся все masked norms/dots, `maxBacktracks + 1` полных
 * objective и mask comparison. Поэтому bound покрывает и accepted mask change,
 * и rejected backtracks последней попытки. Это базовая оценка для root;
 * `prepareNativeStructuralProposal` дополнительно добавляет `atomCount * N`
 * для parent без cached contributions. Dense P×P/Jacobi сюда не складываются.
 */
export function estimateStructuralCandidateWork(arg: {
  sampleCount: number;
  atomCount: number;
  maxInner?: number;
  maxBacktracks?: number;
}): number {
  assertInteger(arg.sampleCount, 'sampleCount', 1);
  assertInteger(arg.atomCount, 'atomCount', 1);
  if (arg.atomCount > MAX_OSCILLATORS) {
    throw new Error(`atomCount must not exceed ${MAX_OSCILLATORS}`);
  }
  const maxInner =
    arg.maxInner ?? DEFAULT_JOINT_K_QUADRATURE_OPTIONS.maxInner;
  const maxBacktracks =
    arg.maxBacktracks ??
    DEFAULT_JOINT_K_QUADRATURE_OPTIONS.maxBacktracks;
  assertInteger(maxInner, 'maxInner', 0);
  assertInteger(maxBacktracks, 'maxBacktracks', 0);

  const columns = 2 * arg.atomCount;
  const gramPasses = 2 * columns + (columns * (columns + 1)) / 2;
  const objectivePasses = columns + 4;
  const innerPasses =
    gramPasses + (maxBacktracks + 1) * objectivePasses + 1;
  const fixedAndCanonicalPasses = 12 * arg.atomCount + 14;
  const passes = fixedAndCanonicalPasses + maxInner * innerPasses;
  const estimated = arg.sampleCount * passes;
  if (
    !Number.isSafeInteger(passes) ||
    !Number.isSafeInteger(estimated)
  ) {
    throw new Error('Structural candidate work estimate overflow');
  }
  return estimated;
}

/** Отклоняет фактическую стоимость выше conservative estimate. */
export function assertNativeStructuralEvaluationWork(arg: {
  candidateKey: string;
  cost: number;
  estimatedWork: number;
}): void {
  if (
    !Number.isFinite(arg.cost) ||
    arg.cost < 0 ||
    !Number.isFinite(arg.estimatedWork) ||
    arg.estimatedWork < 0
  ) {
    throw new Error('Invalid native structural evaluation work');
  }
  if (arg.cost > arg.estimatedWork) {
    throw new Error(
      `Native structural candidate ${arg.candidateKey} exceeded estimate: ` +
        `${arg.cost} > ${arg.estimatedWork}`,
    );
  }
}

/** Единый финальный guard: строгий global и допуск J не хуже −0.05 п.п. */
export function passesNativeStructuralGuard(
  baseline: RefitMetrics,
  candidate: RefitMetrics,
): boolean {
  return (
    candidate.globalSuppressionPercent >
      baseline.globalSuppressionPercent + GLOBAL_EPSILON &&
    candidate.windowedSuppressionPercent >=
      baseline.windowedSuppressionPercent - WINDOWED_FLOOR
  );
}

/** Больше canonical global лучше; J разрешает только равный global. */
function compareNativeScores(
  a: RefitMetrics,
  b: RefitMetrics,
): number {
  const globalDelta =
    a.globalSuppressionPercent - b.globalSuppressionPercent;
  if (globalDelta !== 0) {
    return globalDelta;
  }
  return a.windowedSuppressionPercent - b.windowedSuppressionPercent;
}

/** Проверяет обе независимо измеренные canonical метрики. */
function assertFiniteMetrics(metrics: RefitMetrics): void {
  if (
    !Number.isFinite(metrics.globalSuppressionPercent) ||
    !Number.isFinite(metrics.windowedSuppressionPercent)
  ) {
    throw new Error('Non-finite native canonical metrics');
  }
}

/** Проверяет взаимно исключающие stateless и session-factory входы. */
function prepareNativeProposer(
  options: AnyNativeStructuralBeamOptions,
): PreparedNativeProposer {
  const direct = options.propose;
  const factory = options.createProposerSession;
  if (factory !== undefined) {
    if (
      direct !== undefined ||
      options.estimateExpansion !== undefined
    ) {
      throw new Error(
        'Use either propose or createProposerSession, not both',
      );
    }
    if (typeof factory !== 'function') {
      throw new Error('createProposerSession must be a function');
    }
    return { kind: 'factory', createSession: factory };
  }
  if (typeof direct !== 'function') {
    throw new Error('propose must be a function');
  }
  const estimateExpansion = options.estimateExpansion;
  if (
    estimateExpansion !== undefined &&
    typeof estimateExpansion !== 'function'
  ) {
    throw new Error('estimateExpansion must be a function');
  }
  return {
    kind: 'stateless',
    propose: direct,
    estimateExpansion,
  };
}

/** Создаёт session после подготовки root, не деля её с другой ветвью. */
function createNativeProposerSession(
  context: PreparedNativeRun,
): NativeStructuralProposerSession {
  const source = context.proposer;
  if (source.kind === 'stateless') {
    const estimateExpansion = source.estimateExpansion;
    return {
      propose: (parent) => source.propose(parent),
      estimateExpansion:
        estimateExpansion === undefined
          ? undefined
          : (parent): number => estimateExpansion(parent),
    };
  }
  const session = source.createSession();
  if (
    typeof session !== 'object' ||
    session === null ||
    typeof session.propose !== 'function'
  ) {
    throw new Error('Proposer session must provide propose(parent)');
  }
  if (
    session.estimateExpansion !== undefined &&
    typeof session.estimateExpansion !== 'function'
  ) {
    throw new Error(
      'Proposer session estimateExpansion must be a function',
    );
  }
  return session;
}

/** Проверяет вход и один раз нормализует continuous target для solver. */
function prepareNativeStructuralRun(
  options: AnyNativeStructuralBeamOptions,
): PreparedNativeRun {
  assertInteger(options.beamWidth, 'beamWidth', 1);
  assertInteger(options.maxDepth, 'maxDepth', 0);
  assertInteger(options.maxGroupSize, 'maxGroupSize', 1);
  assertWorkBudget(options.workBudget);
  if (
    options.auditMode !== undefined &&
    options.auditMode !== 'full' &&
    options.auditMode !== 'compact'
  ) {
    throw new Error('Invalid native structural audit mode');
  }
  const maxInner =
    options.maxInner ?? DEFAULT_JOINT_K_QUADRATURE_OPTIONS.maxInner;
  const maxBacktracks =
    options.maxBacktracks ??
    DEFAULT_JOINT_K_QUADRATURE_OPTIONS.maxBacktracks;
  assertInteger(maxInner, 'maxInner', 0);
  assertInteger(maxBacktracks, 'maxBacktracks', 0);
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const phaseModel = options.phaseModel ?? 'legacy';
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error(`sample rate ${sampleRate} != ${SAMPLE_RATE}`);
  }
  if (phaseModel !== 'legacy' && phaseModel !== 'integral') {
    throw new Error('Invalid native structural phase model');
  }
  if (options.patch.oscillators.length > MAX_OSCILLATORS) {
    throw new Error(`Maximum ${MAX_OSCILLATORS} oscillators allowed`);
  }
  const proposer = prepareNativeProposer(options);

  const target = Array.from(options.target);
  if (target.length === 0) {
    throw new Error('Native structural target must not be empty');
  }
  for (const value of target) {
    if (
      !Number.isSafeInteger(value) ||
      value < -32768 ||
      value > 32767
    ) {
      throw new Error(
        'Native structural target must contain Int16 PCM',
      );
    }
  }
  const normalizedTarget = Float64Array.from(
    target,
    (value) => value / MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  );
  const usefulZone = computeUsefulZone(target, sampleRate);
  const source = clonePatch(options.patch);
  const assertCanonical =
    options.assertCanonical ?? assertPatchMatchesWav;
  const rootState = prepareNativeStructuralRoot({
    source,
    target,
    sampleRate,
    phaseModel,
    usefulZone,
    assertCanonical,
  });
  return {
    source,
    rootState,
    target,
    normalizedTarget,
    sampleRate,
    phaseModel,
    usefulZone,
    maxInner,
    maxBacktracks,
    proposer,
    assertCanonical,
  };
}

/** Строит canonical source baseline и cached contributions до beam. */
function prepareNativeStructuralRoot(arg: {
  source: ArgCreateSynth;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  usefulZone: UsefulZone;
  assertCanonical: NativeStructuralCanonicalAssert;
}): NativeStructuralState {
  const patch = clonePatch(arg.source);
  const sampleCount = arg.target.length;
  const contributions: (Float64Array | null)[] =
    patch.oscillators.map((group) =>
      group.osc.on
        ? renderGroup(group, sampleCount, arg.phaseModel)
        : null,
    );
  const rawSum = new Float64Array(sampleCount);
  for (const contribution of contributions) {
    if (contribution === null) {
      continue;
    }
    for (let sample = 0; sample < sampleCount; sample += 1) {
      rawSum[sample] =
        (rawSum[sample] ?? 0) + (contribution[sample] ?? 0);
    }
  }
  const samples = renderForTarget(patch, sampleCount, arg.phaseModel);
  arg.assertCanonical(
    patch,
    samples,
    arg.phaseModel,
    arg.sampleRate,
    sampleCount,
  );
  const metrics = measureMetrics(
    samples,
    arg.target,
    arg.sampleRate,
    arg.usefulZone,
  );
  assertFiniteMetrics(metrics);
  return {
    patch,
    samples,
    metrics,
    rawSum,
    contributions,
    evaluation: null,
  };
}

/** Клонирует proposal и проверяет slots/формы до любого dense или PCM render. */
function prepareNativeStructuralProposal(
  proposal: NativeStructuralProposal,
  parent: NativeStructuralNode,
  context: PreparedNativeRun,
): StructuralBeamCandidate<NativeStructuralProposal> {
  const slots = [...proposal.slots];
  const shapes = proposal.shapes.map((shape) => ({ ...shape }));
  const atomCount = slots.length;
  if (
    atomCount < 1 ||
    atomCount > MAX_OSCILLATORS ||
    shapes.length !== atomCount
  ) {
    throw new Error('Invalid native structural proposal dimensions');
  }
  const used = new Set<number>();
  let outputLength = parent.value.patch.oscillators.length;
  for (const slot of slots) {
    if (
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      slot >= MAX_OSCILLATORS ||
      used.has(slot)
    ) {
      throw new Error('Invalid or duplicate native structural slot');
    }
    used.add(slot);
    outputLength = Math.max(outputLength, slot + 1);
  }
  for (
    let slot = parent.value.patch.oscillators.length;
    slot < outputLength;
    slot += 1
  ) {
    if (!used.has(slot)) {
      throw new Error(
        'Appended native structural slots must not contain gaps',
      );
    }
  }
  const shapeKeys = shapes.map((shape) =>
    structuralAtomShapeKey(shape),
  );
  // Full получает прежний recursive parent key. Compact использует bounded ID,
  // но отдельный orderToken ниже повторяет legacy JSON точно и не копирует rope.
  const key = JSON.stringify([parent.nodeKey, slots, shapeKeys]);
  const parentContributionEstimate =
    parent.value.contributions === null
      ? atomCount * context.target.length
      : 0;
  const candidate: StructuralBeamCandidate<NativeStructuralProposal> =
    {
      key,
      value: { slots, shapes },
      groupSize: atomCount,
      estimatedWork:
        estimateStructuralCandidateWork({
          sampleCount: context.target.length,
          atomCount,
          maxInner: context.maxInner,
          maxBacktracks: context.maxBacktracks,
        }) + parentContributionEstimate,
    };
  if (parent.orderToken !== undefined) {
    candidate.orderToken = jsonArrayOrderToken([
      jsonStringOrderToken(parent.orderToken),
      orderTokenFromRaw(JSON.stringify(slots)),
      orderTokenFromRaw(JSON.stringify(shapeKeys)),
    ]);
  }
  return candidate;
}

/** Создаёт пустой canonical ledger; total не смешивается с dense-work. */
function emptyCanonicalWork(): NativeStructuralCanonicalWork {
  return {
    fixedOffsetCopy: 0,
    parentContributionRenders: 0,
    selectedContributionRenders: 0,
    rawSumAssembly: 0,
    canonicalRender: 0,
    canonicalAssertion: 0,
    canonicalMetrics: 0,
    total: 0,
  };
}

/** Добавляет явные canonical проходы длины N. */
function addCanonicalWork(
  work: NativeStructuralCanonicalWork,
  category: Exclude<keyof NativeStructuralCanonicalWork, 'total'>,
  sampleCount: number,
  passes = 1,
): void {
  const added = sampleCount * passes;
  work[category] += added;
  work.total += added;
}

/**
 * Вычитает старые selected contributions ровно один раз из parent rawSum.
 * Без root cache каждый активный selected group рендерится отдельно и его
 * временный solo-buffer освобождается на следующей итерации. Полный набор
 * contributions для evaluated parent не создаётся.
 */
function nativeFixedOffset(arg: {
  parent: NativeStructuralState;
  slots: readonly number[];
  phaseModel: PhaseModel;
  ledger: StructuralWorkLedger;
  canonicalWork: NativeStructuralCanonicalWork;
}): Float64Array {
  const sampleCount = arg.parent.rawSum.length;
  const fixedOffset = new Float64Array(arg.parent.rawSum);
  addCanonicalWork(arg.canonicalWork, 'fixedOffsetCopy', sampleCount);
  const cached = arg.parent.contributions;
  for (const slot of arg.slots) {
    let previous = cached?.[slot] ?? null;
    if (cached === null) {
      const group = arg.parent.patch.oscillators[slot];
      if (group?.osc.on === true) {
        previous = renderGroup(group, sampleCount, arg.phaseModel);
        addCanonicalWork(
          arg.canonicalWork,
          'parentContributionRenders',
          sampleCount,
        );
      }
    }
    if (previous === null) {
      continue;
    }
    for (let sample = 0; sample < sampleCount; sample += 1) {
      fixedOffset[sample] =
        (fixedOffset[sample] ?? 0) - (previous[sample] ?? 0);
    }
    addStructuralSampleWork(arg.ledger, 'offset', sampleCount);
  }
  return fixedOffset;
}

/** Берёт стартовые квадратуры из parent, включая off slot; append получает MIN. */
function initialNativeCoefficients(
  parent: NativeStructuralState,
  slots: readonly number[],
): number[] {
  const coefficients: number[] = [];
  for (const slot of slots) {
    const group = parent.patch.oscillators[slot];
    if (group === undefined) {
      coefficients.push(0.001, 0);
      continue;
    }
    coefficients.push(
      group.ampEnv.startLevel * Math.cos(group.osc.phase),
      group.ampEnv.startLevel * Math.sin(group.osc.phase),
    );
  }
  return coefficients;
}

/**
 * Рендерит новые selected groups и собирает следующий canonical rawSum.
 * Solo-buffers живут только до возврата функции: evaluated state получает
 * rawSum, но не клонирует и не сохраняет полный contributions array.
 */
function nextNativeRawSum(arg: {
  patch: ArgCreateSynth;
  proposal: NativeStructuralProposal;
  fixedOffset: Float64Array;
  phaseModel: PhaseModel;
  canonicalWork: NativeStructuralCanonicalWork;
}): Float64Array {
  const sampleCount = arg.fixedOffset.length;
  const rawSum = new Float64Array(arg.fixedOffset);
  addCanonicalWork(arg.canonicalWork, 'rawSumAssembly', sampleCount);
  for (const slot of arg.proposal.slots) {
    const group = arg.patch.oscillators[slot];
    if (group === undefined) {
      throw new Error('Native structural selected slot disappeared');
    }
    const contribution = renderGroup(
      group,
      sampleCount,
      arg.phaseModel,
    );
    addCanonicalWork(
      arg.canonicalWork,
      'selectedContributionRenders',
      sampleCount,
    );
    for (let sample = 0; sample < sampleCount; sample += 1) {
      rawSum[sample] =
        (rawSum[sample] ?? 0) + (contribution[sample] ?? 0);
    }
    addCanonicalWork(
      arg.canonicalWork,
      'rawSumAssembly',
      sampleCount,
    );
  }
  return rawSum;
}

/** Выполняет basis+solver, затем независимо измеряет canonical patch/PCM. */
function evaluateNativeStructuralCandidate(
  candidate: StructuralBeamCandidate<NativeStructuralProposal>,
  parent: NativeStructuralNode,
  context: PreparedNativeRun,
): StructuralBeamEvaluation<NativeStructuralState, RefitMetrics> {
  const sampleCount = context.target.length;
  const ledger = createStructuralWorkLedger();
  const canonicalWork = emptyCanonicalWork();
  const fixedOffset = nativeFixedOffset({
    parent: parent.value,
    slots: candidate.value.slots,
    phaseModel: context.phaseModel,
    ledger,
    canonicalWork,
  });
  const basis = renderStructuralBasis({
    shapes: candidate.value.shapes,
    sampleCount,
    phaseModel: context.phaseModel,
    work: ledger,
  });
  const solver = solveJointKQuadrature({
    basis,
    target: context.normalizedTarget,
    fixedOffset,
    initialCoefficients: initialNativeCoefficients(
      parent.value,
      candidate.value.slots,
    ),
    maxInner: context.maxInner,
    maxBacktracks: context.maxBacktracks,
    work: ledger,
  });
  const basisAndSolverWork = snapshotStructuralWork(ledger);
  const patch = patchFromStructuralCandidate(parent.value.patch, {
    slots: candidate.value.slots,
    shapes: candidate.value.shapes,
    coefficients: solver.coefficients,
  });
  const rawSum = nextNativeRawSum({
    patch,
    proposal: candidate.value,
    fixedOffset,
    phaseModel: context.phaseModel,
    canonicalWork,
  });
  const samples = renderForTarget(
    patch,
    sampleCount,
    context.phaseModel,
  );
  addCanonicalWork(canonicalWork, 'canonicalRender', sampleCount);
  try {
    context.assertCanonical(
      patch,
      samples,
      context.phaseModel,
      context.sampleRate,
      sampleCount,
    );
  } finally {
    // assertPatchMatchesWav повторно рендерит patch и сравнивает N отсчётов.
    addCanonicalWork(
      canonicalWork,
      'canonicalAssertion',
      sampleCount,
      2,
    );
  }
  const metrics = measureMetrics(
    samples,
    context.target,
    context.sampleRate,
    context.usefulZone,
  );
  addCanonicalWork(canonicalWork, 'canonicalMetrics', sampleCount, 2);
  assertFiniteMetrics(metrics);
  const cost =
    basisAndSolverWork.sampleWork.total + canonicalWork.total;
  assertNativeStructuralEvaluationWork({
    candidateKey: candidate.key,
    cost,
    estimatedWork: candidate.estimatedWork,
  });
  const evaluation: NativeStructuralEvaluation = {
    proposal: candidate.value,
    fixedOffset,
    solver,
    sampleWork: basisAndSolverWork.sampleWork,
    denseWork: basisAndSolverWork.denseWork,
    canonicalWork,
    cost,
  };
  return {
    value: {
      patch,
      samples,
      metrics,
      rawSum,
      contributions: null,
      evaluation,
    },
    score: metrics,
    cost,
  };
}

/** Снимок proposed остаётся доступным независимо от saved guard. */
function proposedFromNode(
  node: NativeStructuralNode,
): NativeStructuralProposed {
  const evaluation = node.value.evaluation;
  if (evaluation === null || node.candidateKey === null) {
    throw new Error('Root cannot become a native proposed candidate');
  }
  return {
    nodeKey: node.nodeKey,
    candidateKey: node.candidateKey,
    parentKey: node.parentKey,
    depth: node.depth,
    groupSize: node.groupSize,
    estimatedWork: node.estimatedWork,
    cost: node.cost,
    patch: clonePatch(node.value.patch),
    samples: new Int16Array(node.value.samples),
    metrics: { ...node.value.metrics },
    evaluation,
  };
}

type NativeStructuralSearchResult =
  | StructuralBeamResult<NativeStructuralState, RefitMetrics>
  | StructuralBeamCompactResult<
      NativeStructuralState,
      RefitMetrics,
      NativeStructuralAuditState
    >;

/** Если root лучше всех, всё равно сохраняет лучший evaluated для аудита. */
function bestEvaluatedNode(
  result: StructuralBeamResult<NativeStructuralState, RefitMetrics>,
): NativeStructuralNode | null {
  let best: NativeStructuralNode | null = null;
  for (const node of result.evaluated) {
    if (
      best === null ||
      compareNativeScores(node.score, best.score) > 0
    ) {
      best = node;
    }
  }
  return best;
}

/** Возвращает неизменный canonical source без изменения proposed аудита. */
function unchangedNativeResult(arg: {
  context: PreparedNativeRun;
  proposed: NativeStructuralProposed | null;
  rejectionReason: string;
  canonicalError?: string | null;
  finalizationSampleWork?: number;
}): FinalizedNativeStructuralResult {
  return {
    status: 'unchanged',
    patch: clonePatch(arg.context.source),
    samples: new Int16Array(arg.context.rootState.samples),
    metrics: { ...arg.context.rootState.metrics },
    proposed: arg.proposed,
    rejectionReason: arg.rejectionReason,
    canonicalError: arg.canonicalError ?? null,
    finalizationSampleWork: arg.finalizationSampleWork ?? 0,
  };
}

/** Повторно рендерит победителя и отделяет proposed от saved после guard. */
function finalizeNativeStructuralCandidate(
  result: NativeStructuralSearchResult,
  context: PreparedNativeRun,
  bestEvaluated: NativeStructuralNode | null,
): FinalizedNativeStructuralResult {
  const proposedNode =
    result.bestAny.candidateKey === null
      ? bestEvaluated
      : result.bestAny;
  const proposed =
    proposedNode === null ? null : proposedFromNode(proposedNode);
  if (result.bestAny.candidateKey === null) {
    return unchangedNativeResult({
      context,
      proposed,
      rejectionReason:
        proposed === null
          ? 'Нет canonical candidate'
          : 'Canonical global не вырос',
    });
  }

  const sampleCount = context.target.length;
  let finalizationSampleWork = 0;
  const finalSamples = renderForTarget(
    result.bestAny.value.patch,
    sampleCount,
    context.phaseModel,
  );
  finalizationSampleWork += sampleCount;
  let canonicalError: string | null = null;
  try {
    context.assertCanonical(
      result.bestAny.value.patch,
      finalSamples,
      context.phaseModel,
      context.sampleRate,
      sampleCount,
    );
  } catch (caught) {
    canonicalError =
      caught instanceof Error ? caught.message : String(caught);
  } finally {
    finalizationSampleWork += 2 * sampleCount;
  }
  const finalMetrics = measureMetrics(
    finalSamples,
    context.target,
    context.sampleRate,
    context.usefulZone,
  );
  finalizationSampleWork += 2 * sampleCount;
  assertFiniteMetrics(finalMetrics);
  if (canonicalError !== null) {
    return unchangedNativeResult({
      context,
      proposed,
      rejectionReason: 'Canonical patch/WAV не совпали',
      canonicalError,
      finalizationSampleWork,
    });
  }
  if (
    !passesNativeStructuralGuard(
      context.rootState.metrics,
      finalMetrics,
    )
  ) {
    return unchangedNativeResult({
      context,
      proposed,
      rejectionReason:
        finalMetrics.globalSuppressionPercent <=
        context.rootState.metrics.globalSuppressionPercent +
          GLOBAL_EPSILON
          ? 'Canonical global не вырос'
          : 'Canonical J ниже initial−0.05',
      finalizationSampleWork,
    });
  }
  return {
    status: 'refined',
    patch: clonePatch(result.bestAny.value.patch),
    samples: new Int16Array(finalSamples),
    metrics: finalMetrics,
    proposed,
    rejectionReason: null,
    canonicalError: null,
    finalizationSampleWork,
  };
}

/** Разворачивает evaluator audit в отдельную историю вызовов. */
function nativeHistory(
  evaluated: readonly NativeStructuralNode[],
): NativeStructuralHistoryEntry[] {
  return evaluated.map((node) => {
    const evaluation = node.value.evaluation;
    if (evaluation === null || node.candidateKey === null) {
      throw new Error(
        'Evaluated native node has no evaluation audit',
      );
    }
    return {
      nodeKey: node.nodeKey,
      candidateKey: node.candidateKey,
      parentKey: node.parentKey,
      depth: node.depth,
      groupSize: node.groupSize,
      estimatedWork: node.estimatedWork,
      cost: node.cost,
      proposal: evaluation.proposal,
      fixedOffset: evaluation.fixedOffset,
      solver: evaluation.solver,
      sampleWork: evaluation.sampleWork,
      denseWork: evaluation.denseWork,
      canonicalWork: evaluation.canonicalWork,
    };
  });
}

/** Добавляет metadata пути без копирования больших native PCM buffers. */
function nativeStructuralParent(
  parent: NativeStructuralNode,
): NativeStructuralParent {
  return {
    ...parent.value,
    depth: parent.depth,
    nodeKey: parent.nodeKey,
    candidateKey: parent.candidateKey,
  };
}

/** Запускает compact scheduler и сохраняет только light history ветви. */
function executeNativeStructuralBeam(
  context: PreparedNativeRun,
  beamWidth: number,
  maxDepth: number,
  maxGroupSize: number,
  workBudget: number,
  auditMode: 'compact',
): CompactNativeStructuralBeamResult;
/** Запускает прежний full scheduler без compact lifecycle. */
function executeNativeStructuralBeam(
  context: PreparedNativeRun,
  beamWidth: number,
  maxDepth: number,
  maxGroupSize: number,
  workBudget: number,
  auditMode: 'full',
): NativeStructuralBeamResult;
/** Разделяет полный поисковый state и выбранное представление истории. */
function executeNativeStructuralBeam(
  context: PreparedNativeRun,
  beamWidth: number,
  maxDepth: number,
  maxGroupSize: number,
  workBudget: number,
  auditMode: 'full' | 'compact',
): NativeStructuralBeamResult | CompactNativeStructuralBeamResult {
  const proposer = createNativeProposerSession(context);
  const propose = proposer.propose;
  const estimateExpansion = proposer.estimateExpansion;
  const schedulerOptions: StructuralBeamOptions<
    NativeStructuralState,
    RefitMetrics,
    NativeStructuralProposal
  > = {
    root: {
      key: ROOT_KEY,
      value: context.rootState,
      score: context.rootState.metrics,
    },
    beamWidth,
    maxDepth,
    maxGroupSize,
    workBudget,
    estimateExpansion:
      estimateExpansion === undefined
        ? undefined
        : (parent): number =>
            estimateExpansion.call(
              proposer,
              nativeStructuralParent(parent),
            ),
    expand: (parent) => {
      const expansion = normalizeStructuralExpansion(
        propose.call(proposer, nativeStructuralParent(parent)),
      );
      return {
        candidates: expansion.candidates.map((proposal) =>
          prepareNativeStructuralProposal(proposal, parent, context),
        ),
        cost: expansion.cost,
      };
    },
    evaluate: (candidate, parent) =>
      evaluateNativeStructuralCandidate(candidate, parent, context),
    compareScores: compareNativeScores,
  };
  let beam: NativeStructuralSearchResult;
  let bestEvaluated: NativeStructuralNode | null = null;
  if (auditMode === 'compact') {
    beam = runStructuralBeam<
      NativeStructuralState,
      RefitMetrics,
      NativeStructuralProposal,
      NativeStructuralAuditState
    >({
      ...schedulerOptions,
      compact: {
        compactValue: compactNativeStructuralValue,
        onEvaluated: (node) => {
          if (
            bestEvaluated === null ||
            compareNativeScores(node.score, bestEvaluated.score) > 0
          ) {
            bestEvaluated = { ...node };
          }
        },
      },
    });
  } else {
    const fullBeam = runStructuralBeam<
      NativeStructuralState,
      RefitMetrics,
      NativeStructuralProposal
    >(schedulerOptions);
    beam = fullBeam;
    bestEvaluated = bestEvaluatedNode(fullBeam);
  }
  const finalized = finalizeNativeStructuralCandidate(
    beam,
    context,
    bestEvaluated,
  );
  const common = {
    status: finalized.status,
    patch: finalized.patch,
    samples: finalized.samples,
    baseline: { ...context.rootState.metrics },
    metrics: finalized.metrics,
    proposed: finalized.proposed,
    rejectionReason: finalized.rejectionReason,
    canonicalError: finalized.canonicalError,
    root: beam.root,
    bestAny: beam.bestAny,
    work: beam.work,
    evaluatorWork: beam.evaluatorWork,
    expansionWork: beam.expansionWork,
    expansions: beam.expansions,
    skippedExpansionBudget: beam.skippedExpansionBudget,
    skips: {
      budget: beam.work.skippedBudget,
      expansionBudget: beam.skippedExpansionBudget,
      groupSize: beam.skippedGroupSize,
    },
    finalizationSampleWork: finalized.finalizationSampleWork,
  };
  if (auditMode === 'compact') {
    const compactBeam = beam as StructuralBeamCompactResult<
      NativeStructuralState,
      RefitMetrics,
      NativeStructuralAuditState
    >;
    return {
      ...common,
      bestPath: compactBeam.bestPath,
      path: compactBeam.bestPath,
      depths: compactBeam.depths,
      evaluated: compactBeam.evaluated,
      history: compactNativeStructuralHistory(compactBeam.evaluated),
      denseWork: aggregateNativeStructuralDenseWork(
        compactBeam.evaluated,
      ),
    };
  }
  const fullBeam = beam as StructuralBeamResult<
    NativeStructuralState,
    RefitMetrics
  >;
  return {
    ...common,
    bestPath: fullBeam.bestPath,
    path: fullBeam.bestPath,
    depths: fullBeam.depths,
    evaluated: fullBeam.evaluated,
    history: nativeHistory(fullBeam.evaluated),
    denseWork: aggregateNativeStructuralDenseWork(fullBeam.evaluated),
  };
}

/**
 * Запускает deterministic native synthetic beam от canonical source
 * baseline.
 *
 * @param options - Исходный patch/PCM, пределы beam/W, источник proposals
 *   и audit mode
 * @returns Saved patch/WAV, лучший proposed candidate и выбранный full или
 *   compact audit
 * @throws Error при невалидном входе, нарушении estimate/W или ошибке
 *   proposer/evaluator
 * @remarks Proposer получает patch/PCM/global/J/rawSum текущего узла.
 * Полный contributions cache остаётся только у root; evaluated parent
 * передаёт null, поэтому proposer использует patch напрямую. Evaluator
 * при необходимости перерендеривает только старые selected slots и
 * добавляет их верхнюю стоимость K*N к candidate estimate. Каждый proposal
 * заново решает все 2K коэффициенты против `target−fixedOffset`.
 * `bestAny` включает root, а `proposed`
 * сохраняет лучший evaluated candidate даже тогда, когда saved guard
 * возвращает исходник.
 * `work.used = evaluatorWork + expansionWork <= workBudget`, а
 * `work.unused` равен остатку. Прежний массив proposals имеет нулевую
 * expansion cost; measured `{ candidates, cost }` проходит тот же
 * generic estimate/W guard. Dense-work, proposer work и одноразовый
 * финальный guard опубликованы отдельно. CD и реальные runner'ы не
 * вызываются.
 *
 * По умолчанию `auditMode='full'` полностью сохраняет legacy-путь: прежние
 * buffers, recursive keys, raw-string ordering и history; order tokens и
 * compact adapter не используются.
 *
 * При `compact` bounded public IDs служат только identity. Non-enumerable
 * `orderToken` и `candidateOrderToken` хранят lazy persistent ropes точного
 * legacy ordering. Light evaluated/depths/path/history не содержат N-мерные
 * fixedOffset/rawSum/raw/PCM или order tokens. Root, bestAny, proposed и saved
 * остаются полными; proposer получает полные retained parents. Compact меняет
 * только хранение аудита и не меняет W, evaluator/proposer calls, solver или
 * saved guard.
 */
export function runNativeStructuralBeam(
  options: NativeStructuralCompactBeamOptions,
): CompactNativeStructuralBeamResult;
export function runNativeStructuralBeam(
  options: NativeStructuralBeamOptions,
): NativeStructuralBeamResult;
export function runNativeStructuralBeam(
  options: AnyNativeStructuralBeamOptions,
): NativeStructuralBeamResult | CompactNativeStructuralBeamResult {
  const context = prepareNativeStructuralRun(options);
  const auditMode = options.auditMode ?? 'full';
  if (auditMode === 'compact') {
    return executeNativeStructuralBeam(
      context,
      options.beamWidth,
      options.maxDepth,
      options.maxGroupSize,
      options.workBudget,
      'compact',
    );
  }
  return executeNativeStructuralBeam(
    context,
    options.beamWidth,
    options.maxDepth,
    options.maxGroupSize,
    options.workBudget,
    'full',
  );
}

/**
 * Сравнивает заданную ширину с width-1 от одного canonical root и
 * одного W.
 *
 * @param options - Общий canonical вход, audit mode и правила обоих
 *   запусков
 * @returns Full или compact результаты заданной ширины и независимой
 *   width-1 ветви
 * @throws Error при невалидном входе, нарушении estimate/W или ошибке
 *   proposer/evaluator
 * @remarks Обе ветви получают одинаковые expansion rules и W, но
 * независимые ledger и фактические used/unused/saved/proposed. При
 * `createProposerSession` factory создаёт отдельную session для
 * каждой ветви, поэтому stateful budget/history первой ветви не влияет
 * на вторую. Прямой stateless `propose` сохраняется. Общий root
 * подготавливается один раз; scheduler не переиспользует score или
 * PCM другой ветви. Выбранный `auditMode` действует на обе ветви и не меняет
 * W, solver calls или saved guard.
 */
export function runNativeStructuralBeamWithWidthControl(
  options: NativeStructuralCompactBeamOptions,
): CompactNativeStructuralWidthControlResult;
export function runNativeStructuralBeamWithWidthControl(
  options: NativeStructuralBeamOptions,
): NativeStructuralWidthControlResult;
export function runNativeStructuralBeamWithWidthControl(
  options: AnyNativeStructuralBeamOptions,
):
  | NativeStructuralWidthControlResult
  | CompactNativeStructuralWidthControlResult {
  const context = prepareNativeStructuralRun(options);
  const auditMode = options.auditMode ?? 'full';
  if (auditMode === 'compact') {
    const beam = executeNativeStructuralBeam(
      context,
      options.beamWidth,
      options.maxDepth,
      options.maxGroupSize,
      options.workBudget,
      'compact',
    );
    const width1 = executeNativeStructuralBeam(
      context,
      1,
      options.maxDepth,
      options.maxGroupSize,
      options.workBudget,
      'compact',
    );
    return { beam, width1 };
  }
  const beam = executeNativeStructuralBeam(
    context,
    options.beamWidth,
    options.maxDepth,
    options.maxGroupSize,
    options.workBudget,
    'full',
  );
  const width1 = executeNativeStructuralBeam(
    context,
    1,
    options.maxDepth,
    options.maxGroupSize,
    options.workBudget,
    'full',
  );
  return { beam, width1 };
}
