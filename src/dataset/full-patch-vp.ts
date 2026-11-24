/**
 * Offline full-patch variable projection с clip-aware inner solve и LM.
 * Работает только с `ArgCreateSynth`; production match, enhance, API и
 * coordinate descent не вызываются.
 */
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import { computeUsefulZone } from '../optimize/evaluate';
import {
  ampEnvConfigNormales,
  MAX_OSCILLATORS,
  oscConfigNormales,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  buildFullPatchJacobian,
  FULL_PATCH_OUTER_BOUNDS,
  FULL_PATCH_OUTER_FIELDS,
  type FullPatchOuterField,
  type FullPatchQuadratureCoefficients,
} from './full-patch-jacobian';
import {
  buildJointRankDiagnostics,
  projectRadialCoefficientPairs,
  type DroppedQuadrature,
  type JointRankDiagnostics,
} from './joint-projection-oracle';
import { fitFromTwoCoefficients } from './localized-transient';
import {
  clonePatch,
  measureMetrics,
  quantizeRaw,
  renderForTarget,
  renderGroup,
  unitGroup,
  type RefitMetrics,
} from './quadrature-refit';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];
type WorkKind = 'synth' | 'basis' | 'jacobian' | 'gram' | 'metric';

/** Логические проходы длины N; dense P×P solve сюда не входит. */
export interface FullPatchSampleWork {
  synth: number;
  basis: number;
  jacobian: number;
  gram: number;
  metric: number;
  total: number;
}

/** Детерминированная стоимость без wall-clock условий остановки. */
export interface FullPatchVpCost {
  sampleWork: FullPatchSampleWork;
  innerSolves: number;
  outerAttempts: number;
  canonicalRenders: number;
  basisRenders: number;
  jacobianBuilds: number;
  gramDotProducts: number;
  metricEvaluations: number;
}

/** Одно принятое обновление clip-маски внутри variable projection. */
export interface FullPatchInnerIteration {
  iteration: number;
  rssBefore: number;
  rssAfter: number;
  backtracks: number;
  saturatedBefore: number;
  saturatedAfter: number;
  maskChanges: number;
  rank: number;
  condition: number | null;
}

/** Аудит совместного решения всех квадратур при неподвижных формах. */
export interface FullPatchInnerAudit {
  success: boolean;
  stopReason:
    | 'converged'
    | 'zero-rank'
    | 'no-descent'
    | 'stationary'
    | 'quantized-plateau'
    | 'iteration-limit'
    | 'backtrack-limit'
    | 'nonfinite'
    | 'infeasible';
  iterations: number;
  objectiveEvaluations: number;
  backtracks: number;
  maskChanges: number;
  maskRecomputations: number;
  boundaryProjections: number;
  diagnostics: JointRankDiagnostics | null;
  finalClippedPcmRss: number;
  finalSaturatedSamples: number;
  history: FullPatchInnerIteration[];
}

/** Один наружный LM-запрос, включая все его bounded backtracks. */
export interface FullPatchOuterIteration {
  iteration: number;
  lambda: number;
  rank: number;
  coefficientRank: number;
  activeRadialBounds: number;
  columnCount: number;
  accepted: boolean;
  step: number | null;
  backtracks: number;
  directionDescent: boolean;
  rssBefore: number;
  rssAfter: number | null;
  saturatedBefore: number;
  saturatedAfter: number | null;
  metrics: RefitMetrics | null;
  rejectionReason: string | null;
  inner: FullPatchInnerAudit | null;
}

/** Лучший canonical candidate до финального global/J guard. */
export interface FullPatchProposedCandidate {
  patch: ArgCreateSynth;
  samples: Int16Array;
  metrics: RefitMetrics;
  clippedPcmRss: number;
  outerIteration: number | null;
  canonicalValid: boolean;
  canonicalError: string | null;
}

/** Результат offline solver; при отказе saved равен исходному patch/WAV. */
/** Прямой результат low-level inner solve без patch и canonical guard. */
export interface FullPatchBasisInnerResult {
  coefficients: number[];
  raw: Float64Array;
  samples: Int16Array;
  clippedPcmRss: number;
  saturatedSamples: number;
  audit: FullPatchInnerAudit;
  cost: FullPatchVpCost;
}

export interface FullPatchVpResult {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  baseline: RefitMetrics;
  metrics: RefitMetrics;
  proposed: FullPatchProposedCandidate | null;
  rejectionReason: string | null;
  initialInner: FullPatchInnerAudit | null;
  history: FullPatchOuterIteration[];
  cost: FullPatchVpCost;
}

/** Внутренние изменяемые счётчики до публикации immutable-сводки. */
interface MutableCost {
  sampleWork: Omit<FullPatchSampleWork, 'total'>;
  innerSolves: number;
  outerAttempts: number;
  canonicalRenders: number;
  basisRenders: number;
  jacobianBuilds: number;
  gramDotProducts: number;
  metricEvaluations: number;
}

interface InnerState {
  coefficients: number[];
  raw: Float64Array;
  samples: Int16Array;
  clippedPcmRss: number;
  continuousClippedRss: number;
  mask: Uint8Array;
  saturatedSamples: number;
}

interface InnerResult {
  state: InnerState;
  audit: FullPatchInnerAudit;
}

interface InnerBacktrackResult {
  result: InnerResult;
  accepted: boolean;
}

interface CanonicalState {
  patch: ArgCreateSynth;
  coefficients: number[];
  samples: Int16Array;
  clippedPcmRss: number;
  metrics: RefitMetrics;
  outerIteration: number | null;
}

interface NormalEquations {
  gram: Float64Array;
  rhs: Float64Array;
  norms: Float64Array;
  rank: ReturnType<typeof buildJointRankDiagnostics>;
}

interface PreparedOuterColumn {
  originalColumn: number;
  norm: number;
  normalized: Float64Array;
  residual: Float64Array;
  residualRatio: number;
  independent: boolean;
}

interface OuterNavigation {
  columns: PreparedOuterColumn[];
  selected: PreparedOuterColumn[];
  directionalRhs: Float64Array;
  rank: number;
  coefficientRank: number;
  activeRadialBounds: number;
}

/** Диагностика проекции Jacobian на orthogonal complement внутреннего базиса. */
export interface FullPatchKaufmanProjectionResult {
  columns: Float64Array[];
  coefficientRank: number;
  activeRadialBounds: number;
  diagnostics: JointRankDiagnostics | null;
  cost: FullPatchVpCost;
}

type KaufmanProjection = Omit<
  FullPatchKaufmanProjectionResult,
  'cost'
>;

interface OuterNavigationState {
  navigation: OuterNavigation;
  saturatedBefore: number;
}

interface OuterTrial {
  inner: InnerResult;
  candidate: CanonicalState | null;
}

interface OuterAttempt {
  acceptedState: CanonicalState | null;
  audit: FullPatchOuterIteration;
  stop: boolean;
}

/** Входные данные одного offline full-patch VP запуска. */
export interface FullPatchRunInput {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  maxOuter?: number;
  maxInner?: number;
  maxBacktracks?: number;
}

/** Явные численные пределы одного запуска. */
export interface FullPatchVpOptions {
  maxOuter: number;
  maxInner: number;
  maxBacktracks: number;
}

interface ValidatedFullPatchRun {
  source: ArgCreateSynth;
  coefficients: number[];
  context: SolverContext;
}

interface InitialFullPatchState {
  baseline: CanonicalState;
  current: CanonicalState | null;
  initialInner: FullPatchInnerAudit | null;
}

interface SolverContext {
  target: number[];
  normalizedTarget: Float64Array;
  sampleRate: number;
  phaseModel: PhaseModel;
  usefulZone: ReturnType<typeof computeUsefulZone>;
  activeOscillatorIndices: number[];
  options: FullPatchVpOptions;
  cost: MutableCost;
}

const MIN_LEVEL = 0.001;
const MAX_LEVEL = 1;
const LEVEL_BOUNDARY_TOLERANCE = 4 * Number.EPSILON;
const NORM_RELATIVE_CUTOFF = 1e-12;
const OUTER_RANK_TOLERANCE = 1e-8;
const INITIAL_LAMBDA = 1e-3;
const MIN_LAMBDA = 1e-12;
const MAX_LAMBDA = 1e12;

/** Пределы работы по умолчанию; solver не смотрит на часы. */
export const DEFAULT_FULL_PATCH_VP_OPTIONS: FullPatchVpOptions = {
  maxOuter: 24,
  maxInner: 12,
  maxBacktracks: 16,
};

/** Создаёт нулевые счётчики логической стоимости. */
function createCost(): MutableCost {
  return {
    sampleWork: {
      synth: 0,
      basis: 0,
      jacobian: 0,
      gram: 0,
      metric: 0,
    },
    innerSolves: 0,
    outerAttempts: 0,
    canonicalRenders: 0,
    basisRenders: 0,
    jacobianBuilds: 0,
    gramDotProducts: 0,
    metricEvaluations: 0,
  };
}

/** Учитывает count логических проходов длины sampleCount. */
function addWork(
  context: SolverContext,
  kind: WorkKind,
  count = 1,
): void {
  context.cost.sampleWork[kind] += context.target.length * count;
}

/** Фиксирует стоимость после всех финальных canonical проверок. */
function snapshotCost(cost: MutableCost): FullPatchVpCost {
  const sampleWork = { ...cost.sampleWork };
  return {
    sampleWork: {
      ...sampleWork,
      total:
        sampleWork.synth +
        sampleWork.basis +
        sampleWork.jacobian +
        sampleWork.gram +
        sampleWork.metric,
    },
    innerSolves: cost.innerSolves,
    outerAttempts: cost.outerAttempts,
    canonicalRenders: cost.canonicalRenders,
    basisRenders: cost.basisRenders,
    jacobianBuilds: cost.jacobianBuilds,
    gramDotProducts: cost.gramDotProducts,
    metricEvaluations: cost.metricEvaluations,
  };
}

/** Скалярное произведение с явным sample-work учётом. */
function countedDot(
  context: SolverContext,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  mask?: Uint8Array,
): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (mask !== undefined && (mask[index] ?? 0) === 1) {
      continue;
    }
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  context.cost.gramDotProducts += 1;
  addWork(context, 'gram');
  if (!Number.isFinite(sum)) {
    throw new Error('Non-finite full-patch dot product');
  }
  return sum;
}

/** Устойчивая Euclidean norm по ненасыщенным отсчётам. */
function maskedNorm(
  context: SolverContext,
  values: Float64Array,
  mask?: Uint8Array,
): number {
  let scale = 0;
  let scaledSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (mask !== undefined && (mask[index] ?? 0) === 1) {
      continue;
    }
    const magnitude = Math.abs(values[index] ?? 0);
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
  addWork(context, 'gram');
  const norm = scale === 0 ? 0 : scale * Math.sqrt(scaledSquares);
  if (!Number.isFinite(norm)) {
    throw new Error('Non-finite full-patch column norm');
  }
  return norm;
}

/** Число отсчётов, у которых изменилась принадлежность clip-маске. */
function maskChanges(a: Uint8Array, b: Uint8Array): number {
  let changes = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      changes += 1;
    }
  }
  return changes;
}

/** RSS фактического quantized PCM, а не непрерывного clipped сигнала. */
function pcmRss(samples: Int16Array, target: number[]): number {
  let rss = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const residual = (samples[index] ?? 0) - (target[index] ?? 0);
    rss += residual * residual;
  }
  if (!Number.isFinite(rss)) {
    throw new Error('Non-finite clipped PCM RSS');
  }
  return rss;
}

/** Исходные sine/cosine coefficients активных слотов. */
function patchCoefficients(patch: ArgCreateSynth): {
  activeOscillatorIndices: number[];
  coefficients: number[];
} {
  const activeOscillatorIndices: number[] = [];
  const coefficients: number[] = [];
  for (let index = 0; index < patch.oscillators.length; index += 1) {
    const group = patch.oscillators[index];
    if (group === undefined || !group.osc.on) {
      continue;
    }
    const level = group.ampEnv.startLevel;
    if (
      !Number.isFinite(level) ||
      !Number.isFinite(group.osc.phase) ||
      level < MIN_LEVEL - LEVEL_BOUNDARY_TOLERANCE ||
      level > MAX_LEVEL + LEVEL_BOUNDARY_TOLERANCE
    ) {
      throw new Error(
        `Invalid quadrature level at oscillator ${index}`,
      );
    }
    activeOscillatorIndices.push(index);
    coefficients.push(
      level * Math.cos(group.osc.phase),
      level * Math.sin(group.osc.phase),
    );
  }
  return { activeOscillatorIndices, coefficients };
}

/** Канонизирует радиальные границы и возвращает согласованные пары. */
function canonicalCoefficientPairs(
  coefficients: ArrayLike<number>,
  fallback: ArrayLike<number>,
): { coefficients: number[]; boundaryProjections: number } {
  const projected = projectRadialCoefficientPairs(
    coefficients,
    fallback,
  );
  const canonical: number[] = [];
  let boundaryProjections = 0;
  for (let offset = 0; offset < projected.length; offset += 2) {
    const before = Math.hypot(
      coefficients[offset] ?? 0,
      coefficients[offset + 1] ?? 0,
    );
    const after = Math.hypot(
      projected[offset] ?? 0,
      projected[offset + 1] ?? 0,
    );
    if (Math.abs(before - after) > 0) {
      boundaryProjections += 1;
    }
    const fit = fitFromTwoCoefficients([
      projected[offset] ?? 0,
      projected[offset + 1] ?? 0,
    ]);
    if (fit === null) {
      throw new Error('Infeasible full-patch quadrature pair');
    }
    canonical.push(fit.sineCoefficient, fit.cosineCoefficient);
  }
  return { coefficients: canonical, boundaryProjections };
}

/** Пишет только startLevel/phase активных слотов в независимый patch. */
function patchFromCoefficients(
  shapePatch: ArgCreateSynth,
  activeOscillatorIndices: number[],
  coefficients: number[],
): { patch: ArgCreateSynth; coefficients: number[] } {
  if (activeOscillatorIndices.length * 2 !== coefficients.length) {
    throw new Error('Full-patch quadrature dimensions disagree');
  }
  const canonical = canonicalCoefficientPairs(
    coefficients,
    coefficients,
  );
  const patch = clonePatch(shapePatch);
  for (
    let active = 0;
    active < activeOscillatorIndices.length;
    active += 1
  ) {
    const oscillatorIndex = activeOscillatorIndices[active] ?? -1;
    const group = patch.oscillators[oscillatorIndex];
    if (group === undefined || !group.osc.on) {
      throw new Error('Active full-patch slot changed during solve');
    }
    const fit = fitFromTwoCoefficients([
      canonical.coefficients[active * 2] ?? 0,
      canonical.coefficients[active * 2 + 1] ?? 0,
    ]);
    if (fit === null) {
      throw new Error('Full-patch quadrature is outside synth norms');
    }
    group.ampEnv.startLevel = fit.startLevel;
    group.osc.phase = fit.phase;
  }
  return { patch, coefficients: canonical.coefficients };
}

/** Рендерит два unit-базиса каждого активного слота без vector converter. */
function renderBasis(
  patch: ArgCreateSynth,
  context: SolverContext,
): Float64Array[] {
  const basis: Float64Array[] = [];
  for (const oscillatorIndex of context.activeOscillatorIndices) {
    const group = patch.oscillators[oscillatorIndex];
    if (group === undefined || !group.osc.on) {
      throw new Error('Active full-patch basis slot disappeared');
    }
    for (const phase of [0, Math.PI / 2]) {
      const values = renderGroup(
        unitGroup(group, phase),
        context.target.length,
        context.phaseModel,
      );
      if (!values.every(Number.isFinite)) {
        throw new Error('Non-finite full-patch unit basis');
      }
      basis.push(values);
      context.cost.basisRenders += 1;
      addWork(context, 'basis');
    }
  }
  return basis;
}

/** Прямо собирает raw, применяет canonical clip/quantize и считает PCM RSS. */
function evaluateInnerCoefficients(
  basis: Float64Array[],
  coefficients: number[],
  context: SolverContext,
): InnerState {
  const sampleCount = context.target.length;
  const raw = new Float64Array(sampleCount);
  for (let column = 0; column < basis.length; column += 1) {
    const values = basis[column];
    const coefficient = coefficients[column];
    if (values === undefined || coefficient === undefined) {
      throw new Error('Incomplete full-patch inner basis');
    }
    for (let sample = 0; sample < sampleCount; sample += 1) {
      raw[sample] =
        (raw[sample] ?? 0) + coefficient * (values[sample] ?? 0);
    }
    addWork(context, 'basis');
  }
  addWork(context, 'basis');
  if (!raw.every(Number.isFinite)) {
    throw new Error('Non-finite full-patch raw sum');
  }
  const samples = quantizeRaw(raw);
  addWork(context, 'synth');
  const mask = new Uint8Array(sampleCount);
  let saturatedSamples = 0;
  let continuousClippedRss = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = raw[sample] ?? 0;
    if (value <= -1 || value >= 1) {
      mask[sample] = 1;
      saturatedSamples += 1;
    }
    const clipped = Math.max(-1, Math.min(1, value));
    const residual =
      (context.normalizedTarget[sample] ?? 0) - clipped;
    continuousClippedRss += residual * residual;
  }
  addWork(context, 'metric');
  const clippedPcmRss = pcmRss(samples, context.target);
  addWork(context, 'metric');
  return {
    coefficients: [...coefficients],
    raw,
    samples,
    clippedPcmRss,
    continuousClippedRss,
    mask,
    saturatedSamples,
  };
}

/** Строит normalized Gram и rank без правой части. */
function maskedGram(
  basis: Float64Array[],
  mask: Uint8Array,
  context: SolverContext,
): Omit<NormalEquations, 'rhs'> {
  const size = basis.length;
  const norms = new Float64Array(size);
  const rawNorms = basis.map((column) =>
    maskedNorm(context, column, mask),
  );
  const maxNorm = Math.max(0, ...rawNorms);
  const droppedQuadratures: DroppedQuadrature[] = [];
  for (let column = 0; column < size; column += 1) {
    const norm = rawNorms[column] ?? 0;
    if (norm > NORM_RELATIVE_CUTOFF * maxNorm && norm > 1e-15) {
      norms[column] = norm;
    } else {
      droppedQuadratures.push({
        column,
        oscillator: Math.floor(column / 2),
        kind: column % 2 === 0 ? 'sine' : 'cosine',
        norm,
      });
    }
  }
  const gram = new Float64Array(size * size);
  for (let row = 0; row < size; row += 1) {
    const rowNorm = norms[row] ?? 0;
    const rowBasis = basis[row] ?? new Float64Array();
    for (let column = row; column < size; column += 1) {
      const columnNorm = norms[column] ?? 0;
      const value =
        rowNorm > 0 && columnNorm > 0
          ? countedDot(
              context,
              rowBasis,
              basis[column] ?? new Float64Array(),
              mask,
            ) /
            (rowNorm * columnNorm)
          : 0;
      gram[row * size + column] = value;
      gram[column * size + row] = value;
    }
  }
  const rank = buildJointRankDiagnostics({
    gram,
    droppedQuadratures,
  });
  return { gram, norms, rank };
}

/** Добавляет target rhs к normalized Gram текущей clip-маски. */
function maskedNormalEquations(
  basis: Float64Array[],
  mask: Uint8Array,
  context: SolverContext,
): NormalEquations {
  const prepared = maskedGram(basis, mask, context);
  const rhs = new Float64Array(basis.length);
  for (let row = 0; row < basis.length; row += 1) {
    const norm = prepared.norms[row] ?? 0;
    if (norm > 0) {
      rhs[row] =
        countedDot(
          context,
          basis[row] ?? new Float64Array(),
          context.normalizedTarget,
          mask,
        ) / norm;
    }
  }
  return { ...prepared, rhs };
}

/** Truncated pseudo-inverse для произвольной normalized rhs. */
function coefficientsFromRhs(
  equations: NormalEquations,
  rhs: Float64Array,
): number[] {
  const size = equations.norms.length;
  const normalized = new Float64Array(size);
  for (const eigenvector of equations.rank.retainedEigenvectors) {
    const eigenvalue = equations.rank.eigenvalues[eigenvector] ?? 0;
    if (!(eigenvalue > 0)) {
      continue;
    }
    let projection = 0;
    for (let row = 0; row < size; row += 1) {
      projection +=
        (equations.rank.eigenvectors[row * size + eigenvector] ?? 0) *
        (rhs[row] ?? 0);
    }
    const scale = projection / eigenvalue;
    for (let row = 0; row < size; row += 1) {
      normalized[row] =
        (normalized[row] ?? 0) +
        (equations.rank.eigenvectors[row * size + eigenvector] ?? 0) *
          scale;
    }
  }
  return Array.from(normalized, (value, index) => {
    const norm = equations.norms[index] ?? 0;
    return norm > 0 ? value / norm : 0;
  });
}

/** Truncated pseudo-inverse на retained eigenvectors, без ridge-кандидата. */
function unconstrainedCoefficients(
  equations: NormalEquations,
): number[] {
  return coefficientsFromRhs(equations, equations.rhs);
}

/** Свободные пары дают две оси; на radial boundary остаётся tangent. */
function coefficientProjectionBasis(
  basis: Float64Array[],
  coefficients: number[],
  context: SolverContext,
): { basis: Float64Array[]; activeRadialBounds: number } {
  const projectedBasis: Float64Array[] = [];
  let activeRadialBounds = 0;
  for (let offset = 0; offset < basis.length; offset += 2) {
    const sine = basis[offset];
    const cosine = basis[offset + 1];
    const sineCoefficient = coefficients[offset] ?? 0;
    const cosineCoefficient = coefficients[offset + 1] ?? 0;
    const level = Math.hypot(sineCoefficient, cosineCoefficient);
    if (
      sine === undefined ||
      cosine === undefined ||
      !Number.isFinite(level) ||
      level <= 0
    ) {
      throw new Error('Invalid Kaufman coefficient basis');
    }
    const atBound =
      Math.abs(level - MIN_LEVEL) <= LEVEL_BOUNDARY_TOLERANCE ||
      Math.abs(level - MAX_LEVEL) <= LEVEL_BOUNDARY_TOLERANCE;
    if (!atBound) {
      projectedBasis.push(sine, cosine);
      continue;
    }
    activeRadialBounds += 1;
    const tangent = new Float64Array(sine.length);
    for (let sample = 0; sample < tangent.length; sample += 1) {
      tangent[sample] =
        (-cosineCoefficient * (sine[sample] ?? 0) +
          sineCoefficient * (cosine[sample] ?? 0)) /
        level;
    }
    projectedBasis.push(tangent);
    addWork(context, 'basis');
  }
  return { basis: projectedBasis, activeRadialBounds };
}

/** Строит `(I − BB+)J` на ненасыщенных samples через normalized Gram. */
function projectKaufmanColumns(
  basis: Float64Array[],
  coefficients: number[],
  columns: Float64Array[],
  mask: Uint8Array,
  context: SolverContext,
): KaufmanProjection {
  const prepared = coefficientProjectionBasis(
    basis,
    coefficients,
    context,
  );
  if (prepared.basis.length === 0) {
    return {
      columns: columns.map((column) => new Float64Array(column)),
      coefficientRank: 0,
      activeRadialBounds: prepared.activeRadialBounds,
      diagnostics: null,
    };
  }
  const equations = maskedGram(prepared.basis, mask, context);
  if (!equations.rank.diagnostics.jacobiConverged) {
    throw new Error('Kaufman coefficient Gram did not converge');
  }
  const projectedColumns = columns.map((column) => {
    const rhs = new Float64Array(prepared.basis.length);
    for (let row = 0; row < prepared.basis.length; row += 1) {
      const norm = equations.norms[row] ?? 0;
      if (norm > 0) {
        rhs[row] =
          countedDot(
            context,
            prepared.basis[row] ?? new Float64Array(),
            column,
            mask,
          ) / norm;
      }
    }
    const projectionCoefficients = coefficientsFromRhs(
      { ...equations, rhs },
      rhs,
    );
    const projected = new Float64Array(column);
    for (let row = 0; row < prepared.basis.length; row += 1) {
      const coefficient = projectionCoefficients[row] ?? 0;
      const basisColumn = prepared.basis[row] ?? new Float64Array();
      for (let sample = 0; sample < projected.length; sample += 1) {
        if ((mask[sample] ?? 0) === 1) {
          continue;
        }
        projected[sample] =
          (projected[sample] ?? 0) -
          coefficient * (basisColumn[sample] ?? 0);
      }
      addWork(context, 'basis');
    }
    addWork(context, 'basis');
    if (!projected.every(Number.isFinite)) {
      throw new Error('Non-finite projected Kaufman column');
    }
    return projected;
  });
  return {
    columns: projectedColumns,
    coefficientRank: equations.rank.diagnostics.effectiveRank,
    activeRadialBounds: prepared.activeRadialBounds,
    diagnostics: equations.rank.diagnostics,
  };
}

/**
 * Низкоуровневый Kaufman known-answer без запуска patch solver.
 * Возвращает `(I − BB+)J` и стоимость той же реализации, что outer LM.
 */
export function projectFullPatchKaufmanColumns(arg: {
  basis: Float64Array[];
  coefficients: ArrayLike<number>;
  columns: Float64Array[];
  mask?: Uint8Array;
}): FullPatchKaufmanProjectionResult {
  const sampleCount = arg.basis[0]?.length ?? 0;
  const mask = arg.mask ?? new Uint8Array(sampleCount);
  if (
    sampleCount === 0 ||
    arg.basis.length % 2 !== 0 ||
    arg.basis.some((column) => column.length !== sampleCount) ||
    arg.columns.some((column) => column.length !== sampleCount) ||
    arg.coefficients.length !== arg.basis.length ||
    mask.length !== sampleCount
  ) {
    throw new Error('Invalid Kaufman projection input');
  }
  const cost = createCost();
  const context: SolverContext = {
    target: new Array<number>(sampleCount).fill(0),
    normalizedTarget: new Float64Array(sampleCount),
    sampleRate: SAMPLE_RATE,
    phaseModel: 'legacy',
    usefulZone: {
      start: 0,
      end: 0,
      silentProbes: new Uint8Array(0),
      probeSize: 44,
    },
    activeOscillatorIndices: [],
    options: DEFAULT_FULL_PATCH_VP_OPTIONS,
    cost,
  };
  const projected = projectKaufmanColumns(
    arg.basis,
    Array.from(arg.coefficients),
    arg.columns,
    mask,
    context,
  );
  return { ...projected, cost: snapshotCost(cost) };
}

/** Завершает inner audit одной согласованной конечной точкой. */
function finishInner(
  state: InnerState,
  audit: FullPatchInnerAudit,
  success: boolean,
  stopReason: FullPatchInnerAudit['stopReason'],
): InnerResult {
  return {
    state,
    audit: {
      ...audit,
      success,
      stopReason,
      finalClippedPcmRss: state.clippedPcmRss,
      finalSaturatedSamples: state.saturatedSamples,
    },
  };
}

/** RSS gain текущей masked quadratic модели без нового N-прохода. */
function maskedRawGain(
  equations: NormalEquations,
  current: number[],
  desired: number[],
): number {
  const size = current.length;
  let gain = 0;
  const currentNormalized = current.map(
    (value, index) => value * (equations.norms[index] ?? 0),
  );
  const desiredNormalized = desired.map(
    (value, index) => value * (equations.norms[index] ?? 0),
  );
  for (let row = 0; row < size; row += 1) {
    const delta =
      (desiredNormalized[row] ?? 0) - (currentNormalized[row] ?? 0);
    gain += 2 * delta * (equations.rhs[row] ?? 0);
    for (let column = 0; column < size; column += 1) {
      gain -=
        (desiredNormalized[row] ?? 0) *
          (equations.gram[row * size + column] ?? 0) *
          (desiredNormalized[column] ?? 0) -
        (currentNormalized[row] ?? 0) *
          (equations.gram[row * size + column] ?? 0) *
          (currentNormalized[column] ?? 0);
    }
  }
  return gain;
}

/** Создаёт неуспешный inner audit без подмены результата raw-only fit. */
function innerFailure(
  state: InnerState,
  audit: FullPatchInnerAudit,
  stopReason: FullPatchInnerAudit['stopReason'],
): InnerResult {
  return finishInner(state, audit, false, stopReason);
}

/**
 * Совместно решает все квадратуры на текущей ненасыщенной маске.
 * Каждая проба заново квантует полный raw и принимается только по PCM RSS.
 */
function solveInner(
  shapePatch: ArgCreateSynth,
  initialCoefficients: number[],
  context: SolverContext,
): InnerResult {
  context.cost.innerSolves += 1;
  return solveRenderedBasis(
    renderBasis(shapePatch, context),
    initialCoefficients,
    context,
  );
}

/** Проверяет desired coefficients bounded backtracking и классифицирует стоп. */
function backtrackInnerCandidate(arg: {
  basis: Float64Array[];
  state: InnerState;
  desired: ReturnType<typeof canonicalCoefficientPairs>;
  equations: NormalEquations;
  audit: FullPatchInnerAudit;
  context: SolverContext;
}): InnerBacktrackResult {
  const { basis, desired, equations, audit, context } = arg;
  const state = arg.state;
  let sawPcmPlateau = false;
  let sawContinuousDecrease = false;
  let lastCandidate: InnerState | null = null;
  for (
    let backtrack = 0;
    backtrack <= context.options.maxBacktracks;
    backtrack += 1
  ) {
    const step = 1 / 2 ** backtrack;
    const interpolated = state.coefficients.map(
      (value, column) =>
        value +
        step * ((desired.coefficients[column] ?? value) - value),
    );
    let candidateCoefficients: number[];
    try {
      candidateCoefficients = canonicalCoefficientPairs(
        interpolated,
        state.coefficients,
      ).coefficients;
    } catch {
      return {
        accepted: false,
        result: innerFailure(state, audit, 'infeasible'),
      };
    }
    let candidate: InnerState;
    try {
      candidate = evaluateInnerCoefficients(
        basis,
        candidateCoefficients,
        context,
      );
    } catch {
      return {
        accepted: false,
        result: innerFailure(state, audit, 'nonfinite'),
      };
    }
    audit.objectiveEvaluations += 1;
    audit.maskRecomputations += 1;
    sawPcmPlateau ||= candidate.clippedPcmRss === state.clippedPcmRss;
    sawContinuousDecrease ||=
      candidate.continuousClippedRss < state.continuousClippedRss;
    lastCandidate = candidate;
    if (candidate.clippedPcmRss < state.clippedPcmRss) {
      const changes = maskChanges(state.mask, candidate.mask);
      addWork(context, 'metric');
      audit.history.push({
        iteration: audit.history.length + 1,
        rssBefore: state.clippedPcmRss,
        rssAfter: candidate.clippedPcmRss,
        backtracks: backtrack,
        saturatedBefore: state.saturatedSamples,
        saturatedAfter: candidate.saturatedSamples,
        maskChanges: changes,
        rank: equations.rank.diagnostics.effectiveRank,
        condition: equations.rank.diagnostics.retainedCondition,
      });
      audit.iterations += 1;
      audit.maskChanges += changes;
      return {
        accepted: true,
        result: finishInner(candidate, audit, true, 'converged'),
      };
    }
    audit.backtracks += 1;
  }
  if (sawPcmPlateau || sawContinuousDecrease) {
    return {
      accepted: false,
      result: finishInner(state, audit, true, 'quantized-plateau'),
    };
  }
  const rawGain = maskedRawGain(
    equations,
    state.coefficients,
    desired.coefficients,
  );
  if (!Number.isFinite(rawGain)) {
    return {
      accepted: false,
      result: innerFailure(state, audit, 'nonfinite'),
    };
  }
  if (rawGain <= 1e-14) {
    return {
      accepted: false,
      result: finishInner(state, audit, true, 'no-descent'),
    };
  }
  const stationaryTolerance =
    1e-15 * Math.max(1, state.continuousClippedRss);
  if (
    lastCandidate !== null &&
    Math.abs(
      lastCandidate.continuousClippedRss - state.continuousClippedRss,
    ) <= stationaryTolerance
  ) {
    return {
      accepted: false,
      result: finishInner(state, audit, true, 'stationary'),
    };
  }
  return {
    accepted: false,
    result: innerFailure(state, audit, 'backtrack-limit'),
  };
}

/** Решает квадратуры уже отрендеренного базиса текущей формы. */
function solveRenderedBasis(
  basis: Float64Array[],
  initialCoefficients: number[],
  context: SolverContext,
): InnerResult {
  let canonical: ReturnType<typeof canonicalCoefficientPairs>;
  try {
    canonical = canonicalCoefficientPairs(
      initialCoefficients,
      initialCoefficients,
    );
  } catch {
    const fallback = evaluateInnerCoefficients(
      basis,
      initialCoefficients.map((value) =>
        Number.isFinite(value) ? value : 0,
      ),
      context,
    );
    return innerFailure(
      fallback,
      {
        success: false,
        stopReason: 'infeasible',
        iterations: 0,
        objectiveEvaluations: 1,
        backtracks: 0,
        maskChanges: 0,
        maskRecomputations: 1,
        boundaryProjections: 0,
        diagnostics: null,
        finalClippedPcmRss: fallback.clippedPcmRss,
        finalSaturatedSamples: fallback.saturatedSamples,
        history: [],
      },
      'infeasible',
    );
  }
  let state: InnerState;
  try {
    state = evaluateInnerCoefficients(
      basis,
      canonical.coefficients,
      context,
    );
  } catch {
    throw new Error('Initial full-patch inner state is non-finite');
  }
  const audit: FullPatchInnerAudit = {
    success: true,
    stopReason: 'converged',
    iterations: 0,
    objectiveEvaluations: 1,
    backtracks: 0,
    maskChanges: 0,
    maskRecomputations: 1,
    boundaryProjections: canonical.boundaryProjections,
    diagnostics: null,
    finalClippedPcmRss: state.clippedPcmRss,
    finalSaturatedSamples: state.saturatedSamples,
    history: [],
  };
  if (state.clippedPcmRss === 0) {
    return finishInner(state, audit, true, 'converged');
  }
  for (
    let innerIteration = 0;
    innerIteration < context.options.maxInner;
    innerIteration += 1
  ) {
    let equations: NormalEquations;
    try {
      equations = maskedNormalEquations(basis, state.mask, context);
    } catch {
      return innerFailure(state, audit, 'nonfinite');
    }
    audit.diagnostics = equations.rank.diagnostics;
    if (!equations.rank.diagnostics.jacobiConverged) {
      return innerFailure(state, audit, 'iteration-limit');
    }
    if (equations.rank.retainedEigenvectors.length === 0) {
      return finishInner(state, audit, true, 'zero-rank');
    }
    const desiredRaw = unconstrainedCoefficients(equations);
    let desired: ReturnType<typeof canonicalCoefficientPairs>;
    try {
      desired = canonicalCoefficientPairs(
        desiredRaw,
        state.coefficients,
      );
    } catch {
      return innerFailure(state, audit, 'infeasible');
    }
    audit.boundaryProjections += desired.boundaryProjections;
    let directionNorm = 0;
    for (
      let column = 0;
      column < desired.coefficients.length;
      column += 1
    ) {
      const delta =
        (desired.coefficients[column] ?? 0) -
        (state.coefficients[column] ?? 0);
      directionNorm += delta * delta;
    }
    if (!Number.isFinite(directionNorm)) {
      return innerFailure(state, audit, 'nonfinite');
    }
    if (directionNorm <= 1e-28) {
      return finishInner(state, audit, true, 'no-descent');
    }
    const backtracked = backtrackInnerCandidate({
      basis,
      state,
      desired,
      equations,
      audit,
      context,
    });
    state = backtracked.result.state;
    if (!backtracked.accepted || state.clippedPcmRss === 0) {
      return backtracked.result;
    }
  }
  return innerFailure(state, audit, 'iteration-limit');
}

/**
 * Низкоуровневый clip-aware solve для known-answer и независимой ревизии.
 * Основной patch-native API вызывает тот же код после canonical unit render.
 */
export function solveFullPatchClipAwareBasis(arg: {
  basis: Float64Array[];
  target: ArrayLike<number>;
  initialCoefficients: ArrayLike<number>;
  maxInner?: number;
  maxBacktracks?: number;
}): FullPatchBasisInnerResult {
  const targetNormalized = Float64Array.from(arg.target);
  const maxInner =
    arg.maxInner ?? DEFAULT_FULL_PATCH_VP_OPTIONS.maxInner;
  const maxBacktracks =
    arg.maxBacktracks ?? DEFAULT_FULL_PATCH_VP_OPTIONS.maxBacktracks;
  if (
    targetNormalized.length === 0 ||
    !targetNormalized.every(Number.isFinite) ||
    arg.basis.length === 0 ||
    arg.basis.length > 100 ||
    arg.basis.length % 2 !== 0 ||
    arg.initialCoefficients.length !== arg.basis.length ||
    arg.basis.some(
      (column) => column.length !== targetNormalized.length,
    ) ||
    !Number.isSafeInteger(maxInner) ||
    maxInner < 1 ||
    !Number.isSafeInteger(maxBacktracks) ||
    maxBacktracks < 0
  ) {
    throw new Error('Invalid clip-aware full-patch basis input');
  }
  // Нормированный known-answer target сначала получает тот же PCM, что synth.
  const target = Array.from(quantizeRaw(targetNormalized));
  const cost = createCost();
  cost.innerSolves = 1;
  const context: SolverContext = {
    target,
    normalizedTarget: Float64Array.from(
      target,
      (value) => value / MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    ),
    sampleRate: SAMPLE_RATE,
    phaseModel: 'legacy',
    usefulZone: computeUsefulZone(target, SAMPLE_RATE),
    activeOscillatorIndices: Array.from(
      { length: arg.basis.length / 2 },
      (_, index) => index,
    ),
    options: { maxOuter: 0, maxInner, maxBacktracks },
    cost,
  };
  // Учитываем PCM-квантование target и поиск useful zone.
  addWork(context, 'synth');
  addWork(context, 'metric');
  const result = solveRenderedBasis(
    arg.basis,
    Array.from(arg.initialCoefficients),
    context,
  );
  return {
    coefficients: [...result.state.coefficients],
    raw: new Float64Array(result.state.raw),
    samples: new Int16Array(result.state.samples),
    clippedPcmRss: result.state.clippedPcmRss,
    saturatedSamples: result.state.saturatedSamples,
    audit: result.audit,
    cost: snapshotCost(cost),
  };
}

/** Рендерит и измеряет полный canonical PCM одного inner candidate. */
function canonicalState(
  patch: ArgCreateSynth,
  coefficients: number[],
  context: SolverContext,
  outerIteration: number | null,
): CanonicalState {
  const samples = renderForTarget(
    patch,
    context.target.length,
    context.phaseModel,
  );
  context.cost.canonicalRenders += 1;
  addWork(context, 'synth');
  addWork(context, 'metric');
  const metrics = measureMetrics(
    samples,
    context.target,
    context.sampleRate,
    context.usefulZone,
  );
  context.cost.metricEvaluations += 1;
  addWork(context, 'metric', 2);
  if (
    !Number.isFinite(metrics.globalSuppressionPercent) ||
    !Number.isFinite(metrics.windowedSuppressionPercent)
  ) {
    throw new Error('Non-finite canonical full-patch metrics');
  }
  return {
    patch,
    coefficients: [...coefficients],
    samples,
    clippedPcmRss: pcmRss(samples, context.target),
    metrics,
    outerIteration,
  };
}

/** Лучший proposed выбирается по global, затем по windowed J. */
function betterCanonical(
  candidate: CanonicalState,
  current: CanonicalState | null,
): boolean {
  if (current === null) {
    return true;
  }
  const globalDelta =
    candidate.metrics.globalSuppressionPercent -
    current.metrics.globalSuppressionPercent;
  return (
    globalDelta > 0 ||
    (globalDelta === 0 &&
      candidate.metrics.windowedSuppressionPercent >
        current.metrics.windowedSuppressionPercent)
  );
}

/** Читает семь наружных полей активного слота в натуральных логарифмах. */
function outerLogs(
  patch: ArgCreateSynth,
  active: number[],
): number[] {
  const logs: number[] = [];
  for (const oscillatorIndex of active) {
    const group = patch.oscillators[oscillatorIndex];
    if (group === undefined || !group.osc.on) {
      throw new Error('Active outer slot disappeared');
    }
    const values = [
      group.osc.freqBase,
      group.osc.freqStart,
      group.osc.slope,
      group.osc.duration,
      group.ampEnv.duration,
      group.ampEnv.endLevel ?? MIN_LEVEL,
      group.ampEnv.slope,
    ];
    for (let field = 0; field < values.length; field += 1) {
      const value = values[field] ?? 0;
      const bound = FULL_PATCH_OUTER_BOUNDS[field];
      if (
        bound === undefined ||
        !Number.isFinite(value) ||
        value < bound.nativeMinimum ||
        value > bound.nativeMaximum
      ) {
        throw new Error(
          `Outer field ${FULL_PATCH_OUTER_FIELDS[field] ?? field} is outside synth norms`,
        );
      }
      logs.push(Math.log(value));
    }
  }
  return logs;
}

/** Пишет только семь разрешённых полей активных слотов. */
function patchFromOuterLogs(
  currentPatch: ArgCreateSynth,
  active: number[],
  logs: number[],
): ArgCreateSynth {
  const patch = clonePatch(currentPatch);
  for (
    let activeIndex = 0;
    activeIndex < active.length;
    activeIndex += 1
  ) {
    const oscillatorIndex = active[activeIndex] ?? -1;
    const group = patch.oscillators[oscillatorIndex];
    if (group === undefined || !group.osc.on) {
      throw new Error('Active outer patch slot disappeared');
    }
    for (
      let field = 0;
      field < FULL_PATCH_OUTER_FIELDS.length;
      field += 1
    ) {
      const bound = FULL_PATCH_OUTER_BOUNDS[field];
      const log =
        logs[activeIndex * FULL_PATCH_OUTER_FIELDS.length + field];
      if (bound === undefined || log === undefined) {
        throw new Error('Incomplete full-patch outer coordinates');
      }
      const clamped = Math.max(
        bound.logMinimum,
        Math.min(bound.logMaximum, log),
      );
      writeOuterField(group, bound.field, Math.exp(clamped));
    }
  }
  return patch;
}

/** Присваивает одно разрешённое поле без преобразования всего patch. */
function writeOuterField(
  group: OscillatorGroup,
  field: FullPatchOuterField,
  value: number,
): void {
  if (field === 'freqBase') {
    group.osc.freqBase = value;
  } else if (field === 'freqStart') {
    group.osc.freqStart = value;
  } else if (field === 'osc.slope') {
    group.osc.slope = value;
  } else if (field === 'osc.duration') {
    group.osc.duration = value;
  } else if (field === 'ampEnv.duration') {
    group.ampEnv.duration = value;
  } else if (field === 'ampEnv.endLevel') {
    group.ampEnv.endLevel = value;
  } else {
    group.ampEnv.slope = value;
  }
}

/** Нормирует projected columns и выполняет два MGS-pass без projection BB+. */
function orthogonalizeOuterColumns(
  rawColumns: Float64Array[],
  mask: Uint8Array,
  residual: Float64Array,
  context: SolverContext,
): Omit<OuterNavigation, 'coefficientRank' | 'activeRadialBounds'> {
  const norms = rawColumns.map((column) =>
    maskedNorm(context, column, mask),
  );
  const maxNorm = Math.max(0, ...norms);
  const columns: PreparedOuterColumn[] = [];
  const independentBasis: Float64Array[] = [];
  for (
    let columnIndex = 0;
    columnIndex < rawColumns.length;
    columnIndex += 1
  ) {
    const raw = rawColumns[columnIndex] ?? new Float64Array();
    const norm = norms[columnIndex] ?? 0;
    if (norm <= NORM_RELATIVE_CUTOFF * maxNorm || norm <= 1e-15) {
      continue;
    }
    const normalized = Float64Array.from(raw, (value, index) =>
      (mask[index] ?? 0) === 1 ? 0 : value / norm,
    );
    addWork(context, 'gram');
    const orthogonal = new Float64Array(normalized);
    for (let pass = 0; pass < 2; pass += 1) {
      for (const basis of independentBasis) {
        const projection = countedDot(
          context,
          pass === 0 ? normalized : orthogonal,
          basis,
        );
        for (
          let sample = 0;
          sample < orthogonal.length;
          sample += 1
        ) {
          orthogonal[sample] =
            (orthogonal[sample] ?? 0) -
            projection * (basis[sample] ?? 0);
        }
        addWork(context, 'gram');
      }
    }
    const residualRatio = maskedNorm(context, orthogonal);
    const independent = residualRatio > OUTER_RANK_TOLERANCE;
    const prepared: PreparedOuterColumn = {
      originalColumn: columnIndex,
      norm,
      normalized,
      residual: orthogonal,
      residualRatio,
      independent,
    };
    columns.push(prepared);
    if (independent) {
      independentBasis.push(
        Float64Array.from(
          orthogonal,
          (value) => value / residualRatio,
        ),
      );
      addWork(context, 'gram');
    }
  }
  const directionalRhs = new Float64Array(rawColumns.length);
  for (const column of columns) {
    directionalRhs[column.originalColumn] = countedDot(
      context,
      column.normalized,
      residual,
    );
  }
  return {
    columns,
    selected: columns.filter((column) => column.independent),
    directionalRhs,
    rank: independentBasis.length,
  };
}

/** Сначала строит `(I − BB+)J`, затем независимо выполняет MGS rank guard. */
function prepareOuterNavigation(
  jacobian: ReturnType<typeof buildFullPatchJacobian>,
  basis: Float64Array[],
  coefficients: number[],
  mask: Uint8Array,
  residual: Float64Array,
  context: SolverContext,
): OuterNavigation {
  const fixedCoefficientColumns = jacobian.oscillators.flatMap(
    (oscillator) => oscillator.jacobian,
  );
  const projected = projectKaufmanColumns(
    basis,
    coefficients,
    fixedCoefficientColumns,
    mask,
    context,
  );
  const orthogonal = orthogonalizeOuterColumns(
    projected.columns,
    mask,
    residual,
    context,
  );
  return {
    ...orthogonal,
    coefficientRank: projected.coefficientRank,
    activeRadialBounds: projected.activeRadialBounds,
  };
}

/** Собирает текущий basis, raw residual, Jacobian и projected navigation. */
function buildOuterNavigationState(
  current: CanonicalState,
  context: SolverContext,
): OuterNavigationState {
  const basis = renderBasis(current.patch, context);
  const coefficients: FullPatchQuadratureCoefficients[] =
    context.activeOscillatorIndices.map(
      (oscillatorIndex, active) => ({
        oscillatorIndex,
        sineCoefficient: current.coefficients[active * 2] ?? 0,
        cosineCoefficient: current.coefficients[active * 2 + 1] ?? 0,
      }),
    );
  const jacobian = buildFullPatchJacobian({
    patch: current.patch,
    coefficients,
    sampleCount: context.target.length,
    phaseModel: context.phaseModel,
    rankDiagnostics: false,
  });
  context.cost.jacobianBuilds += 1;
  addWork(context, 'jacobian', jacobian.oscillators.length);
  const raw = new Float64Array(context.target.length);
  for (const oscillator of jacobian.oscillators) {
    for (
      let sample = 0;
      sample < context.target.length;
      sample += 1
    ) {
      raw[sample] =
        (raw[sample] ?? 0) + (oscillator.contribution[sample] ?? 0);
    }
    addWork(context, 'basis');
  }
  const mask = new Uint8Array(context.target.length);
  let saturatedBefore = 0;
  const residual = new Float64Array(context.target.length);
  for (let sample = 0; sample < context.target.length; sample += 1) {
    const value = raw[sample] ?? 0;
    if (value <= -1 || value >= 1) {
      mask[sample] = 1;
      saturatedBefore += 1;
    } else {
      residual[sample] =
        (context.normalizedTarget[sample] ?? 0) - value;
    }
  }
  addWork(context, 'metric');
  const navigation = prepareOuterNavigation(
    jacobian,
    basis,
    current.coefficients,
    mask,
    residual,
    context,
  );
  return { navigation, saturatedBefore };
}

/** Решает небольшую dense систему с partial pivoting и finite guards. */
function solveDenseSystem(
  matrix: Float64Array,
  rhs: Float64Array,
  size: number,
): Float64Array | null {
  const augmented = Array.from({ length: size }, (_, row) => [
    ...matrix.slice(row * size, (row + 1) * size),
    rhs[row] ?? 0,
  ]);
  const scale = Math.max(
    1,
    ...matrix.map((value) => Math.abs(value)),
  );
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    let pivotSize = Math.abs(augmented[column]?.[column] ?? 0);
    for (let row = column + 1; row < size; row += 1) {
      const candidate = Math.abs(augmented[row]?.[column] ?? 0);
      if (candidate > pivotSize) {
        pivotRow = row;
        pivotSize = candidate;
      }
    }
    if (!Number.isFinite(pivotSize) || pivotSize <= 1e-14 * scale) {
      return null;
    }
    const pivot = augmented[pivotRow];
    const current = augmented[column];
    if (pivot === undefined || current === undefined) {
      return null;
    }
    augmented[column] = pivot;
    augmented[pivotRow] = current;
    for (let row = column + 1; row < size; row += 1) {
      const target = augmented[row];
      const factor =
        (target?.[column] ?? 0) / (augmented[column]?.[column] ?? 0);
      if (target === undefined || !Number.isFinite(factor)) {
        return null;
      }
      for (let index = column; index <= size; index += 1) {
        target[index] =
          (target[index] ?? 0) -
          factor * (augmented[column]?.[index] ?? 0);
      }
    }
  }
  const solution = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = augmented[row]?.[size] ?? 0;
    for (let column = row + 1; column < size; column += 1) {
      value -=
        (augmented[row]?.[column] ?? 0) * (solution[column] ?? 0);
    }
    const divisor = augmented[row]?.[row] ?? 0;
    if (!Number.isFinite(divisor) || Math.abs(divisor) <= 1e-20) {
      return null;
    }
    solution[row] = value / divisor;
  }
  return solution.every(Number.isFinite) ? solution : null;
}

/** Строит damped LM-направление в исходных log-координатах. */
function lmDirection(
  navigation: OuterNavigation,
  lambda: number,
): { direction: Float64Array; descent: boolean } | null {
  const selected = navigation.selected;
  const size = selected.length;
  if (size === 0) {
    return null;
  }
  const hessian = new Float64Array(size * size);
  const rhs = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    const rowColumn = selected[row];
    if (rowColumn === undefined) {
      return null;
    }
    rhs[row] =
      navigation.directionalRhs[rowColumn.originalColumn] ?? 0;
    for (let column = row; column < size; column += 1) {
      const other = selected[column];
      if (other === undefined) {
        return null;
      }
      let value = 0;
      for (
        let sample = 0;
        sample < rowColumn.normalized.length;
        sample += 1
      ) {
        value +=
          (rowColumn.normalized[sample] ?? 0) *
          (other.normalized[sample] ?? 0);
      }
      if (!Number.isFinite(value)) {
        return null;
      }
      hessian[row * size + column] = value;
      hessian[column * size + row] = value;
    }
  }
  // H и его диагональ уже построены выше; dot-work учитывает caller.
  for (let index = 0; index < size; index += 1) {
    hessian[index * size + index] =
      (hessian[index * size + index] ?? 0) + lambda;
  }
  const normalizedDirection = solveDenseSystem(hessian, rhs, size);
  if (normalizedDirection === null) {
    return null;
  }
  let predictedReduction = 0;
  for (let index = 0; index < size; index += 1) {
    predictedReduction +=
      (rhs[index] ?? 0) * (normalizedDirection[index] ?? 0);
  }
  if (
    !(predictedReduction > 0) ||
    !Number.isFinite(predictedReduction)
  ) {
    return { direction: new Float64Array(size), descent: false };
  }
  const fullColumnCount = navigation.directionalRhs.length;
  const direction = new Float64Array(fullColumnCount);
  for (let index = 0; index < size; index += 1) {
    const column = selected[index];
    if (column === undefined || column.norm <= 0) {
      return null;
    }
    direction[column.originalColumn] =
      (normalizedDirection[index] ?? 0) / column.norm;
  }
  return { direction, descent: true };
}

/** Проверяет descent уже после физических ограничений log-координат. */
function boundedDirectionDescent(
  navigation: OuterNavigation,
  currentLogs: number[],
  nextLogs: number[],
): boolean {
  let reduction = 0;
  for (const column of navigation.columns) {
    const original = column.originalColumn;
    const delta =
      (nextLogs[original] ?? 0) - (currentLogs[original] ?? 0);
    reduction +=
      column.norm *
      (navigation.directionalRhs[original] ?? 0) *
      delta;
  }
  return Number.isFinite(reduction) && reduction > 0;
}

/** Выполняет один LM-запрос и все его согласованные backtrack-пробы. */
function attemptFullPatchOuterStep(arg: {
  current: CanonicalState;
  navigationState: OuterNavigationState;
  lambda: number;
  outer: number;
  context: SolverContext;
}): OuterAttempt {
  const { current, navigationState, lambda, outer, context } = arg;
  const { navigation } = navigationState;
  context.cost.outerAttempts += 1;
  const audit: FullPatchOuterIteration = {
    iteration: outer + 1,
    lambda,
    rank: navigation.rank,
    coefficientRank: navigation.coefficientRank,
    activeRadialBounds: navigation.activeRadialBounds,
    columnCount:
      FULL_PATCH_OUTER_FIELDS.length *
      context.activeOscillatorIndices.length,
    accepted: false,
    step: null,
    backtracks: 0,
    directionDescent: false,
    rssBefore: current.clippedPcmRss,
    rssAfter: null,
    saturatedBefore: navigationState.saturatedBefore,
    saturatedAfter: null,
    metrics: null,
    rejectionReason: null,
    inner: null,
  };
  const direction = lmDirection(navigation, lambda);
  const densePasses = (navigation.rank * (navigation.rank + 1)) / 2;
  addWork(context, 'gram', densePasses);
  context.cost.gramDotProducts += densePasses;
  if (navigation.rank === 0) {
    audit.rejectionReason = 'LM rank равен нулю';
    return { acceptedState: null, audit, stop: true };
  }
  if (direction === null) {
    audit.rejectionReason = 'Dense LM solve не дал направления';
    return { acceptedState: null, audit, stop: false };
  }
  if (!direction.descent) {
    audit.rejectionReason = 'LM direction не является descent';
    return { acceptedState: null, audit, stop: false };
  }
  audit.directionDescent = true;
  const currentLogs = outerLogs(
    current.patch,
    context.activeOscillatorIndices,
  );
  let acceptedState: CanonicalState | null = null;
  let acceptedStep: number | null = null;
  let lastTrial: OuterTrial | null = null;
  let lastReason = 'Backtracking не уменьшил clipped PCM RSS';
  for (
    let backtrack = 0;
    backtrack <= context.options.maxBacktracks;
    backtrack += 1
  ) {
    lastTrial = null;
    const step = 1 / 2 ** backtrack;
    const nextLogs = currentLogs.map((value, column) => {
      const bound =
        FULL_PATCH_OUTER_BOUNDS[
          column % FULL_PATCH_OUTER_BOUNDS.length
        ];
      const proposed =
        value + step * (direction.direction[column] ?? 0);
      return bound === undefined
        ? proposed
        : Math.max(
            bound.logMinimum,
            Math.min(bound.logMaximum, proposed),
          );
    });
    if (!boundedDirectionDescent(navigation, currentLogs, nextLogs)) {
      lastReason = 'Bounded LM direction не является descent';
      audit.backtracks += 1;
      continue;
    }
    const shapePatch = patchFromOuterLogs(
      current.patch,
      context.activeOscillatorIndices,
      nextLogs,
    );
    let inner: InnerResult;
    try {
      inner = solveInner(shapePatch, current.coefficients, context);
    } catch {
      lastReason = 'Inner solve вернул nonfinite';
      audit.backtracks += 1;
      continue;
    }
    lastTrial = { inner, candidate: null };
    if (!inner.audit.success) {
      lastReason = `Inner solve: ${inner.audit.stopReason}`;
      audit.backtracks += 1;
      continue;
    }
    let fitted: ReturnType<typeof patchFromCoefficients>;
    try {
      fitted = patchFromCoefficients(
        shapePatch,
        context.activeOscillatorIndices,
        inner.state.coefficients,
      );
    } catch {
      lastReason = 'Inner quadratures вне физических границ';
      audit.backtracks += 1;
      continue;
    }
    let candidate: CanonicalState;
    try {
      candidate = canonicalState(
        fitted.patch,
        fitted.coefficients,
        context,
        outer + 1,
      );
    } catch {
      lastReason = 'Canonical trial вернул nonfinite';
      audit.backtracks += 1;
      continue;
    }
    lastTrial = { inner, candidate };
    if (candidate.clippedPcmRss < current.clippedPcmRss) {
      acceptedState = candidate;
      acceptedStep = step;
      break;
    }
    audit.backtracks += 1;
  }
  audit.inner = lastTrial?.inner.audit ?? null;
  audit.rssAfter = lastTrial?.candidate?.clippedPcmRss ?? null;
  audit.saturatedAfter =
    lastTrial?.inner.state.saturatedSamples ?? null;
  if (acceptedState === null) {
    audit.rejectionReason = lastReason;
    return { acceptedState: null, audit, stop: false };
  }
  audit.accepted = true;
  audit.step = acceptedStep;
  audit.rssAfter = acceptedState.clippedPcmRss;
  audit.metrics = acceptedState.metrics;
  audit.rejectionReason = null;
  return { acceptedState, audit, stop: false };
}

/** Единый финальный guard: canonical, строгий global и initial J-floor. */
export function passesFullPatchCanonicalGuard(
  baseline: RefitMetrics,
  candidate: RefitMetrics,
): boolean {
  return (
    candidate.globalSuppressionPercent >
      baseline.globalSuppressionPercent + 1e-10 &&
    candidate.windowedSuppressionPercent >=
      baseline.windowedSuppressionPercent - 0.05
  );
}

/** Собирает unchanged-ответ, не смешивая saved с proposed. */
function unchangedResult(arg: {
  source: ArgCreateSynth;
  baselineState: CanonicalState;
  proposed: FullPatchProposedCandidate | null;
  rejectionReason: string;
  initialInner: FullPatchInnerAudit | null;
  history: FullPatchOuterIteration[];
  cost: MutableCost;
}): FullPatchVpResult {
  return {
    status: 'unchanged',
    patch: clonePatch(arg.source),
    samples: new Int16Array(arg.baselineState.samples),
    baseline: arg.baselineState.metrics,
    metrics: arg.baselineState.metrics,
    proposed: arg.proposed,
    rejectionReason: arg.rejectionReason,
    initialInner: arg.initialInner,
    history: arg.history,
    cost: snapshotCost(arg.cost),
  };
}

/** Проверяет весь вход до первого render и создаёт неизменяемый контекст. */
function validateFullPatchRunInput(
  arg: FullPatchRunInput,
): ValidatedFullPatchRun {
  if (arg.patch.oscillators.length > MAX_OSCILLATORS) {
    throw new Error(
      `Full patch supports at most ${MAX_OSCILLATORS} slots`,
    );
  }
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  const options: FullPatchVpOptions = {
    maxOuter: arg.maxOuter ?? DEFAULT_FULL_PATCH_VP_OPTIONS.maxOuter,
    maxInner: arg.maxInner ?? DEFAULT_FULL_PATCH_VP_OPTIONS.maxInner,
    maxBacktracks:
      arg.maxBacktracks ??
      DEFAULT_FULL_PATCH_VP_OPTIONS.maxBacktracks,
  };
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Full-patch VP supports only 44100 Hz');
  }
  if (phaseModel !== 'legacy' && phaseModel !== 'integral') {
    throw new Error(`Unknown phase model ${String(phaseModel)}`);
  }
  if (
    !Number.isSafeInteger(options.maxOuter) ||
    options.maxOuter < 0 ||
    !Number.isSafeInteger(options.maxInner) ||
    options.maxInner < 1 ||
    !Number.isSafeInteger(options.maxBacktracks) ||
    options.maxBacktracks < 0
  ) {
    throw new Error(
      'Require maxOuter >= 0, maxInner >= 1 and maxBacktracks >= 0 integers',
    );
  }
  const target = Array.from(arg.target);
  if (
    target.length === 0 ||
    target.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      'Full-patch VP target must be non-empty and finite',
    );
  }
  const source = clonePatch(arg.patch);
  const extracted = patchCoefficients(source);
  for (const oscillatorIndex of extracted.activeOscillatorIndices) {
    const group = source.oscillators[oscillatorIndex];
    if (group === undefined) {
      throw new Error(
        'Active input slot disappeared during validation',
      );
    }
    const delay = group.osc.delay ?? 0;
    const attack = group.ampEnv.attack ?? 0;
    const hardStop = group.ampEnv.hardStop ?? false;
    if (
      !Number.isFinite(delay) ||
      delay < oscConfigNormales.delay.min ||
      delay > oscConfigNormales.delay.max ||
      !Number.isFinite(attack) ||
      attack < ampEnvConfigNormales.attack.min ||
      attack > ampEnvConfigNormales.attack.max ||
      typeof hardStop !== 'boolean' ||
      group.osc.phase < oscConfigNormales.phase.min ||
      group.osc.phase > oscConfigNormales.phase.max
    ) {
      throw new Error(
        `Invalid fixed or phase field at oscillator ${oscillatorIndex}`,
      );
    }
  }
  outerLogs(source, extracted.activeOscillatorIndices);
  const cost = createCost();
  const usefulZone = computeUsefulZone(target, sampleRate);
  const context: SolverContext = {
    target,
    normalizedTarget: Float64Array.from(
      target,
      (value) => value / MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    ),
    sampleRate,
    phaseModel,
    usefulZone,
    activeOscillatorIndices: extracted.activeOscillatorIndices,
    options,
    cost,
  };
  // Полезная зона и normalized target — два независимых N-прохода.
  addWork(context, 'metric', 2);
  return { source, coefficients: extracted.coefficients, context };
}

/** Создаёт baseline и первый solved current без наружных шагов. */
function createInitialFullPatchState(
  validated: ValidatedFullPatchRun,
): InitialFullPatchState {
  const { source, context } = validated;
  const baseline = canonicalState(
    clonePatch(source),
    validated.coefficients,
    context,
    null,
  );
  if (context.activeOscillatorIndices.length === 0) {
    return { baseline, current: null, initialInner: null };
  }
  const initialInner = solveInner(
    source,
    validated.coefficients,
    context,
  );
  if (!initialInner.audit.success) {
    return {
      baseline,
      current: null,
      initialInner: initialInner.audit,
    };
  }
  const fitted = patchFromCoefficients(
    source,
    context.activeOscillatorIndices,
    initialInner.state.coefficients,
  );
  const current = canonicalState(
    fitted.patch,
    fitted.coefficients,
    context,
    null,
  );
  return { baseline, current, initialInner: initialInner.audit };
}

/** Повторно рендерит proposed и применяет единый saved guard. */
function finalizeFullPatchCandidate(arg: {
  source: ArgCreateSynth;
  proposedState: CanonicalState | null;
  baselineState: CanonicalState;
  initialInner: FullPatchInnerAudit | null;
  history: FullPatchOuterIteration[];
  context: SolverContext;
}): FullPatchVpResult {
  const {
    source,
    proposedState,
    baselineState,
    initialInner,
    history,
    context,
  } = arg;
  if (proposedState === null) {
    return unchangedResult({
      source,
      baselineState,
      proposed: null,
      rejectionReason: 'Нет canonical candidate',
      initialInner,
      history,
      cost: context.cost,
    });
  }
  const finalSamples = renderForTarget(
    proposedState.patch,
    context.target.length,
    context.phaseModel,
  );
  context.cost.canonicalRenders += 1;
  addWork(context, 'synth');
  let canonicalValid = true;
  let canonicalError: string | null = null;
  try {
    assertPatchMatchesWav(
      proposedState.patch,
      finalSamples,
      context.phaseModel,
      context.sampleRate,
      context.target.length,
    );
  } catch (caught) {
    canonicalValid = false;
    canonicalError =
      caught instanceof Error ? caught.message : String(caught);
  } finally {
    context.cost.canonicalRenders += 1;
    addWork(context, 'synth');
    addWork(context, 'metric');
  }
  const finalMetrics = measureMetrics(
    finalSamples,
    context.target,
    context.sampleRate,
    context.usefulZone,
  );
  context.cost.metricEvaluations += 1;
  addWork(context, 'metric', 2);
  const proposed: FullPatchProposedCandidate = {
    patch: clonePatch(proposedState.patch),
    samples: new Int16Array(finalSamples),
    metrics: finalMetrics,
    clippedPcmRss: pcmRss(finalSamples, context.target),
    outerIteration: proposedState.outerIteration,
    canonicalValid,
    canonicalError,
  };
  addWork(context, 'metric');
  const accepted =
    canonicalValid &&
    passesFullPatchCanonicalGuard(
      baselineState.metrics,
      finalMetrics,
    );
  if (!accepted) {
    return unchangedResult({
      source,
      baselineState,
      proposed,
      rejectionReason: !canonicalValid
        ? 'Canonical patch/WAV не совпали'
        : finalMetrics.globalSuppressionPercent <=
            baselineState.metrics.globalSuppressionPercent + 1e-10
          ? 'Canonical global не вырос'
          : 'Canonical J ниже initial−0.05',
      initialInner,
      history,
      cost: context.cost,
    });
  }
  return {
    status: 'refined',
    patch: clonePatch(proposed.patch),
    samples: new Int16Array(proposed.samples),
    baseline: baselineState.metrics,
    metrics: finalMetrics,
    proposed,
    rejectionReason: null,
    initialInner,
    history,
    cost: snapshotCost(context.cost),
  };
}

/**
 * Совместно меняет формы всех активных осцилляторов и решает их квадратуры.
 *
 * @param arg - Исходный `ArgCreateSynth`, target PCM, модель фазы и явные
 *   пределы `maxOuter`, `maxInner`, `maxBacktracks`
 * @returns Лучший proposed candidate до guard, saved patch/WAV, историю LM,
 *   rank/clip-диагностику и детерминированный sample-work счётчик
 * @throws Error если число слотов, target, sample rate, fixed-поля, наружные
 *   или квадратурные нормы невалидны; все входные проверки предшествуют render
 * @remarks Внутренний solver использует `startLevel·cos(phase)` и
 *   `startLevel·sin(phase)`, normalized masked Gram и truncated pseudo-inverse.
 *   Радиальная проекция держит норму каждой пары в [0.001, 1]; только ulp-выход
 *   канонизируется отдельно общим helper. Quantized plateau и stationary fit
 *   с ненулевым RSS допускают outer LM, а nonfinite/infeasible и численные
 *   пределы отклоняют candidate.
 *
 *   Наружный шаг использует projected Kaufman Jacobian `(I − BB+)J` на текущей
 *   clip-маске. Rank определяется по normalized Gram внутреннего basis; на
 *   активной радиальной границе в проекции остаётся только tangent пары.
 *   Производные квадратур по формам отдельно не строятся. Столбцы результата
 *   нормируются и проходят MGS rank guard до `(JTJ + lambda I) delta = -g`;
 *   dense система решается с partial pivoting. Нулевой rank останавливает
 *   поиск, а dense/non-descent отказ повышает lambda до численного потолка.
 *   Backtracking ограничивает log-координаты физическими нормами и заново
 *   запускает inner solve. Каждая проба получает атомарный inner/canonical
 *   audit, поэтому changing `hardStop` support не заимствует stale WAV.
 *
 *   Proposed выбирается по global, затем по J, независимо от финального guard.
 *   Saved возвращается только при росте global и `J >= initialJ - 0.05`;
 *   иначе функция возвращает клон исходного patch и его canonical PCM. Off,
 *   on/off, delay, attack, hardStop и остальные поля не записываются. Память
 *   содержит N×P массивы и dense P×P, но никогда не строит N×N. Runner,
 *   character/bands и реальные A/B в этот модуль не входят.
 */
export function runFullPatchVariableProjection(
  arg: FullPatchRunInput,
): FullPatchVpResult {
  const validated = validateFullPatchRunInput(arg);
  const { source, context } = validated;
  const initial = createInitialFullPatchState(validated);
  const history: FullPatchOuterIteration[] = [];
  if (context.activeOscillatorIndices.length === 0) {
    return unchangedResult({
      source,
      baselineState: initial.baseline,
      proposed: null,
      rejectionReason: 'Нет активных осцилляторов',
      initialInner: null,
      history,
      cost: context.cost,
    });
  }
  if (initial.current === null) {
    return unchangedResult({
      source,
      baselineState: initial.baseline,
      proposed: null,
      rejectionReason: `Initial inner solve: ${initial.initialInner?.stopReason ?? 'unknown'}`,
      initialInner: initial.initialInner,
      history,
      cost: context.cost,
    });
  }
  let current = initial.current;
  let proposedState: CanonicalState | null = current;
  let lambda = INITIAL_LAMBDA;
  for (let outer = 0; outer < context.options.maxOuter; outer += 1) {
    const navigationState = buildOuterNavigationState(
      current,
      context,
    );
    const attempt = attemptFullPatchOuterStep({
      current,
      navigationState,
      lambda,
      outer,
      context,
    });
    history.push(attempt.audit);
    if (attempt.stop) {
      break;
    }
    if (attempt.acceptedState === null) {
      if (lambda >= MAX_LAMBDA) {
        break;
      }
      lambda = Math.min(MAX_LAMBDA, lambda * 10);
      continue;
    }
    current = attempt.acceptedState;
    if (betterCanonical(current, proposedState)) {
      proposedState = current;
    }
    lambda = Math.max(MIN_LAMBDA, lambda * 0.3);
  }
  return finalizeFullPatchCandidate({
    source,
    proposedState,
    baselineState: initial.baseline,
    initialInner: initial.initialInner,
    history,
    context,
  });
}
