/* eslint-disable no-console */
/**
 * Offline-измеритель совместной квадратурной проекции готового match.
 *
 * D оценивает линейный RSS с радиальными границами амплитуды, а E
 * непосредственно уменьшает RSS после hard clip. Unbounded-решения нужны
 * только для диагностики и никогда не становятся патчем. Модуль не вызывает
 * coordinate descent и не подключён к production match/enhance/API.
 *
 * npx tsx src/dataset/joint-projection-oracle.ts --dataset datasets/ref --out datasets/joint
 *
 * --out обязан отсутствовать или быть пустым. Повторный запуск использует
 * новый каталог: runner ничего не удаляет и не смешивает старые артефакты.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import { computeUsefulZone } from '../optimize/evaluate';
import { readWav } from '../read-wav';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  clonePatch,
  measureMetrics,
  renderForTarget,
  renderGroup,
  unitGroup,
  type RefitMetrics,
} from './quadrature-refit';
import { withAttackBoost } from './quadrature-refit-run';
import {
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

const TWO_PI = 2 * Math.PI;
const MIN_LEVEL = 0.001;
const MAX_LEVEL = 1;
const RANK_RELATIVE_CUTOFF = 1e-10;
const NORM_RELATIVE_CUTOFF = 1e-12;
const D_MAX_ITERATIONS = 160;
const MAX_BACKTRACKS = 24;
const ACCEPTANCE_EPSILON = 1e-12;

/** Фиксированный ряд ridge на нормированной диагонали, без HPO. */
export const JOINT_RIDGE_LAMBDAS = [1e-8, 1e-6, 1e-4] as const;

/** Число clip-aware итераций на каждый из двух стартов. */
export const JOINT_E_ITERATIONS = 25;

/** Константы записываются в report, чтобы старые аудиты читались однозначно. */
export const JOINT_PROJECTION_CONFIG = {
  dMaxIterationsPerStart: D_MAX_ITERATIONS,
  maxEIterationsPerStart: JOINT_E_ITERATIONS,
  maxBacktracksPerProbe: MAX_BACKTRACKS,
  maxBacktracksPerEStart: JOINT_E_ITERATIONS * (MAX_BACKTRACKS + 1),
  acceptanceEpsilon: ACCEPTANCE_EPSILON,
  rankRelativeCutoff: RANK_RELATIVE_CUTOFF,
  rankAbsoluteCutoff: 1e-12,
  normRelativeCutoff: NORM_RELATIVE_CUTOFF,
  normAbsoluteCutoff: 1e-15,
  minLevel: MIN_LEVEL,
  maxLevel: MAX_LEVEL,
  eInitialStepFactor: 2,
  canonicalWindowedFloorDelta: 0.05,
} as const;

/** Нулевая или почти нулевая квадратура, исключённая из системы. */
export interface DroppedQuadrature {
  column: number;
  oscillator: number;
  kind: 'sine' | 'cosine';
  norm: number;
}

/** Диагностика ранга нормированной матрицы Грама. */
export interface JointRankDiagnostics {
  basisColumns: number;
  effectiveRank: number;
  cutoff: number;
  condition: number | null;
  retainedCondition: number | null;
  diagonalMin: number;
  diagonalMax: number;
  diagonalCondition: number | null;
  eigenvalueMin: number;
  eigenvalueMax: number;
  retainedEigenvalueMin: number | null;
  retainedEigenvalueMax: number | null;
  jacobiSweeps: number;
  jacobiConverged: boolean;
  droppedQuadratures: DroppedQuadrature[];
  eigenvalues: number[];
}

/** Подготовленный базис. target и сигнал базиса выражены в полной шкале. */
export interface JointProjectionProblem {
  target: Float64Array;
  /** Фиксированный вклад остальных осцилляторов, добавляемый до clip. */
  fixedOffset?: Float64Array;
  targetRss: number;
  basis: Float64Array[];
  norms: Float64Array;
  gram: Float64Array;
  rhs: Float64Array;
  initialCoefficients: number[];
  diagnostics: JointRankDiagnostics;
  eigenvalues: Float64Array;
  eigenvectors: Float64Array;
  retainedEigenvectors: number[];
}

/** RSS линейного и clipped-сигнала, оба пересчитаны через базис. */
export interface JointProjectionObjective {
  coefficients: number[];
  rawRss: number;
  clippedRss: number;
  rawSuppressionPercent: number;
  clippedSuppressionPercent: number;
  saturatedSamples: number;
}

interface ClipEvaluation extends JointProjectionObjective {
  raw: Float64Array;
  mask: Uint8Array;
}

/** Один unbounded ridge-диагностик. */
export interface UnboundedJointFit extends JointProjectionObjective {
  lambda: number;
}

/**
 * Truncated ridge-диагностика без patch или WAV. Это не upper bound:
 * ridge и отсечённые направления могут исключить часть линейного запаса.
 */
export interface UnboundedJointDiagnostic {
  fits: UnboundedJointFit[];
  bestLambda: number;
  best: UnboundedJointFit;
  diagnosticSuppressionPercent: number;
}

/** Стоимость и проекции границ bounded raw solver. */
export interface BoundedSolverAudit {
  iterations: number;
  backtracks: number;
  violatedBounds: number;
  starts: Array<{
    start: 'current' | 'unbounded';
    iterations: number;
    backtracks: number;
    violatedBounds: number;
    rawRss: number;
  }>;
}

/** Принятый clip-aware шаг. Маска насыщения считается заново на пробе. */
export interface ClipIterationAudit {
  iteration: number;
  rssBefore: number;
  rssAfter: number;
  step: number;
  backtracks: number;
  violatedBounds: number;
  saturatedBefore: number;
  saturatedAfter: number;
  maskChanges: number;
}

/** Отдельный запуск E от current или D. */
export interface ClipStartAudit {
  start: 'current' | 'd';
  initialRss: number;
  finalRss: number;
  iterations: number;
  backtracks: number;
  violatedBounds: number;
  maskChanges: number;
  maskRecomputations: number;
  objectiveEvaluations: number;
  history: ClipIterationAudit[];
  coefficients: number[];
}

/** Clip-aware результат; выбирается минимум clipped RSS среди стартов. */
export interface ClippedJointSolution extends JointProjectionObjective {
  selectedStart: 'current' | 'd';
  starts: ClipStartAudit[];
  iterations: number;
  backtracks: number;
  violatedBounds: number;
  maskChanges: number;
  objectiveEvaluations: number;
}

/** Численный результат без синтеза патча. */
export interface JointProjectionSolution {
  current: JointProjectionObjective;
  unbounded: UnboundedJointDiagnostic;
  d: JointProjectionObjective & { solver: BoundedSolverAudit };
  e: ClippedJointSolution;
  diagnostics: JointRankDiagnostics;
  directStateEvaluations: number;
}

/** Метрики предложенного canonical WAV, включая отвергнутый кандидат. */
export interface CanonicalCandidateMetrics extends RefitMetrics {
  globalDelta: number;
  windowedDelta: number;
  valid: boolean;
  error: string | null;
}

/** D или E после canonical guard. При отказе patch/WAV равны current. */
export interface JointProjectionCandidate<
  T extends JointProjectionObjective = JointProjectionObjective,
> {
  kind: 'd' | 'e';
  status: 'refined' | 'unchanged';
  accepted: boolean;
  rejectionReason: string | null;
  patch: ArgCreateSynth;
  samples: Int16Array;
  coefficients: number[];
  raw: T;
  canonical: CanonicalCandidateMetrics;
  savedGlobalDelta: number;
  savedWindowedDelta: number;
  metrics: RefitMetrics;
}

/** Полный offline oracle одного match-сида. */
export interface JointProjectionOracleResult {
  current: {
    patch: ArgCreateSynth;
    samples: Int16Array;
    metrics: RefitMetrics;
    raw: JointProjectionObjective;
  };
  diagnostics: JointRankDiagnostics & {
    activeOscillatorIndices: number[];
  };
  unbounded: UnboundedJointDiagnostic;
  d: JointProjectionCandidate<
    JointProjectionObjective & { solver: BoundedSolverAudit }
  >;
  e: JointProjectionCandidate<ClippedJointSolution>;
  eMinusD: {
    rawRss: number;
    clippedRss: number;
    canonicalGlobal: number;
    canonicalWindowed: number;
  };
  cost: {
    activeOscillators: number;
    unitBasisRenders: number;
    gramDotProducts: number;
    directStateEvaluations: number;
    clipObjectiveEvaluations: number;
    dIterations: number;
    eIterations: number;
    backtracks: number;
    canonicalCandidateRenders: number;
    durationMs: number;
  };
}

interface EigenDecomposition {
  values: Float64Array;
  vectors: Float64Array;
  sweeps: number;
  converged: boolean;
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

export interface CandidateRunReport {
  status: 'refined' | 'unchanged';
  accepted: boolean;
  rejectionReason: string | null;
  rawRss: number;
  rawRssDelta: number;
  clippedRss: number;
  clippedRssDelta: number;
  rawSuppressionPercent: number;
  rawSuppressionDelta: number;
  clippedSuppressionPercent: number;
  clippedSuppressionDelta: number;
  canonicalGlobalSuppressionPercent: number;
  canonicalWindowedSuppressionPercent: number;
  canonicalGlobalDelta: number;
  canonicalWindowedDelta: number;
  savedGlobalDelta: number;
  savedWindowedDelta: number;
  canonicalValid: boolean;
  canonicalError: string | null;
  patch: string;
  wav: string;
  audit: string;
}

export interface JointRunReport {
  slug: string;
  seed: number;
  sourceRunDir: string;
  savedGlobalSuppressionPercent: number | null;
  current: {
    globalSuppressionPercent: number;
    windowedSuppressionPercent: number;
    rawRss: number;
    clippedRss: number;
    rawSuppressionPercent: number;
    clippedSuppressionPercent: number;
  };
  rank: JointProjectionOracleResult['diagnostics'];
  unbounded: {
    bestLambda: number;
    rawRss: number;
    clippedRss: number;
    diagnosticSuppressionPercent: number;
    fits: UnboundedJointFit[];
  };
  d: CandidateRunReport & {
    iterations: number;
    backtracks: number;
    violatedBounds: number;
  };
  e: CandidateRunReport & {
    selectedStart: 'current' | 'd';
    iterations: number;
    backtracks: number;
    violatedBounds: number;
    maskChanges: number;
    starts: ClipStartAudit[];
  };
  eMinusD: JointProjectionOracleResult['eMinusD'];
  cost: JointProjectionOracleResult['cost'];
  durationMs: number;
}

export interface JointCandidateSummary {
  runs: number;
  meanSavedGlobalDelta: number;
  meanSavedWindowedDelta: number;
  improved: number;
  meanProposedGlobalDelta: number;
  meanProposedWindowedDelta: number;
}

export interface JointTargetSummary {
  slug: string;
  runs: number;
  d: JointCandidateSummary;
  e: JointCandidateSummary;
}

export interface RunError {
  slug: string;
  seed: number;
  message: string;
}

/** Скалярное произведение без создания промежуточных массивов. */
function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}

/** Нормирует фазу на полуинтервал [0, 2π). */
function normalizedPhase(phase: number): number {
  return ((phase % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * Проецирует каждую sine/cosine-пару на кольцо нормы [0.001, 1].
 * Это не NNLS: знаки и квадрант фазы сохраняются.
 */
export function projectRadialCoefficientPairs(
  coefficients: ArrayLike<number>,
  fallback?: ArrayLike<number>,
): number[] {
  if (coefficients.length % 2 !== 0) {
    throw new Error('Квадратурные коэффициенты должны идти парами');
  }
  const projected = Array.from(coefficients);
  for (let offset = 0; offset < projected.length; offset += 2) {
    const sine = projected[offset] ?? 0;
    const cosine = projected[offset + 1] ?? 0;
    const norm = Math.hypot(sine, cosine);
    if (!Number.isFinite(norm)) {
      throw new Error('Нечисловые квадратурные коэффициенты');
    }
    if (norm >= MIN_LEVEL && norm <= MAX_LEVEL) {
      continue;
    }
    if (norm > 1e-15) {
      const targetNorm = Math.max(
        MIN_LEVEL,
        Math.min(MAX_LEVEL, norm),
      );
      projected[offset] = (sine / norm) * targetNorm;
      projected[offset + 1] = (cosine / norm) * targetNorm;
      continue;
    }
    const fallbackSine = fallback?.[offset] ?? 0;
    const fallbackCosine = fallback?.[offset + 1] ?? 0;
    const fallbackNorm = Math.hypot(fallbackSine, fallbackCosine);
    if (fallbackNorm > 1e-15 && Number.isFinite(fallbackNorm)) {
      projected[offset] = (fallbackSine / fallbackNorm) * MIN_LEVEL;
      projected[offset + 1] =
        (fallbackCosine / fallbackNorm) * MIN_LEVEL;
    } else {
      projected[offset] = MIN_LEVEL;
      projected[offset + 1] = 0;
    }
  }
  return projected;
}

/** Число пар, вышедших за радиальные границы до проекции. */
function countBoundViolations(
  coefficients: ArrayLike<number>,
): number {
  let count = 0;
  for (let offset = 0; offset < coefficients.length; offset += 2) {
    const norm = Math.hypot(
      coefficients[offset] ?? 0,
      coefficients[offset + 1] ?? 0,
    );
    if (
      !Number.isFinite(norm) ||
      norm < MIN_LEVEL - 1e-10 ||
      norm > MAX_LEVEL + 1e-10
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Циклический Jacobi для симметричной P×P матрицы, P≤100.
 * Работает только с Gram и не строит матрицу N×N.
 */
function jacobiEigen(
  input: Float64Array,
  size: number,
): EigenDecomposition {
  const matrix = new Float64Array(input);
  const vectors = new Float64Array(size * size);
  for (let index = 0; index < size; index += 1) {
    vectors[index * size + index] = 1;
  }
  let sweeps = 0;
  let converged = size <= 1;
  for (let sweep = 0; sweep < 80 && !converged; sweep += 1) {
    sweeps += 1;
    let largestOffDiagonal = 0;
    for (let row = 0; row < size; row += 1) {
      for (let column = row + 1; column < size; column += 1) {
        const offDiagonal = matrix[row * size + column] ?? 0;
        largestOffDiagonal = Math.max(
          largestOffDiagonal,
          Math.abs(offDiagonal),
        );
        const diagonalRow = matrix[row * size + row] ?? 0;
        const diagonalColumn = matrix[column * size + column] ?? 0;
        const threshold =
          1e-15 +
          1e-14 *
            Math.sqrt(
              Math.max(0, Math.abs(diagonalRow * diagonalColumn)),
            );
        if (Math.abs(offDiagonal) <= threshold) {
          continue;
        }
        const tau =
          (diagonalColumn - diagonalRow) / (2 * offDiagonal);
        const tangent =
          (tau >= 0 ? 1 : -1) /
          (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const cosine = 1 / Math.sqrt(1 + tangent * tangent);
        const sine = tangent * cosine;
        matrix[row * size + row] =
          diagonalRow - tangent * offDiagonal;
        matrix[column * size + column] =
          diagonalColumn + tangent * offDiagonal;
        matrix[row * size + column] = 0;
        matrix[column * size + row] = 0;
        for (let index = 0; index < size; index += 1) {
          if (index !== row && index !== column) {
            const rowValue = matrix[index * size + row] ?? 0;
            const columnValue = matrix[index * size + column] ?? 0;
            const nextRow = cosine * rowValue - sine * columnValue;
            const nextColumn = sine * rowValue + cosine * columnValue;
            matrix[index * size + row] = nextRow;
            matrix[row * size + index] = nextRow;
            matrix[index * size + column] = nextColumn;
            matrix[column * size + index] = nextColumn;
          }
          const vectorRow = vectors[index * size + row] ?? 0;
          const vectorColumn = vectors[index * size + column] ?? 0;
          vectors[index * size + row] =
            cosine * vectorRow - sine * vectorColumn;
          vectors[index * size + column] =
            sine * vectorRow + cosine * vectorColumn;
        }
      }
    }
    converged = largestOffDiagonal <= 1e-12;
  }
  const order = Array.from(
    { length: size },
    (_, index) => index,
  ).sort(
    (a, b) =>
      (matrix[b * size + b] ?? 0) - (matrix[a * size + a] ?? 0) ||
      a - b,
  );
  const values = new Float64Array(size);
  const sortedVectors = new Float64Array(size * size);
  for (let target = 0; target < size; target += 1) {
    const source = order[target] ?? 0;
    values[target] = matrix[source * size + source] ?? 0;
    for (let row = 0; row < size; row += 1) {
      sortedVectors[row * size + target] =
        vectors[row * size + source] ?? 0;
    }
  }
  return { values, vectors: sortedVectors, sweeps, converged };
}

/** Проверяет форму и конечность численного входа. */
function validateBasisInput(arg: {
  basis: Float64Array[];
  target: ArrayLike<number>;
  initialCoefficients: ArrayLike<number>;
}): void {
  if (arg.target.length === 0) {
    throw new Error('Пустой target');
  }
  if (
    arg.basis.length === 0 ||
    arg.basis.length > 100 ||
    arg.basis.length % 2 !== 0 ||
    arg.initialCoefficients.length !== arg.basis.length
  ) {
    throw new Error(
      'Ожидаются 2–100 квадратур и столько же коэффициентов',
    );
  }
  for (const basis of arg.basis) {
    if (basis.length !== arg.target.length) {
      throw new Error('Длина базиса не совпадает с target');
    }
  }
}

/** Возвращает null вместо бесконечного condition number. */
function finiteRatio(
  numerator: number,
  denominator: number,
): number | null {
  if (!(numerator >= 0) || !(denominator > 0)) {
    return null;
  }
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) ? ratio : null;
}

/** Нормы после отсечения нулевых столбцов и их исходные нормы в аудите. */
export interface NormalizedProjectionBasis {
  norms: Float64Array;
  droppedQuadratures: DroppedQuadrature[];
}

/** Нормированные нормальные уравнения одного базиса. */
export interface JointNormalEquations {
  gram: Float64Array;
  rhs: Float64Array;
}

/** Собственный базис и диагностика ранга normalized Gram. */
export interface JointRankAnalysis {
  diagnostics: JointRankDiagnostics;
  eigenvalues: Float64Array;
  eigenvectors: Float64Array;
  retainedEigenvectors: number[];
}

/** Нормирует столбцы и помечает почти нулевые квадратуры. */
export function normalizeProjectionBasis(
  basis: Float64Array[],
): NormalizedProjectionBasis {
  const rawNorms = basis.map((column) =>
    Math.sqrt(dot(column, column)),
  );
  const maxNorm = Math.max(...rawNorms);
  if (!Number.isFinite(maxNorm)) {
    throw new Error('Нечисловой базис');
  }
  const norms = new Float64Array(basis.length);
  const droppedQuadratures: DroppedQuadrature[] = [];
  for (let column = 0; column < basis.length; column += 1) {
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
  return { norms, droppedQuadratures };
}

/** Строит normalized Gram и rhs одним проходом по верхнему треугольнику. */
export function buildJointNormalEquations(arg: {
  basis: Float64Array[];
  target: Float64Array;
  norms: Float64Array;
}): JointNormalEquations {
  const size = arg.basis.length;
  const gram = new Float64Array(size * size);
  const rhs = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    const rowNorm = arg.norms[row] ?? 0;
    const rowBasis = arg.basis[row] ?? new Float64Array();
    if (rowNorm > 0) {
      rhs[row] = dot(rowBasis, arg.target) / rowNorm;
    }
    for (let column = row; column < size; column += 1) {
      const columnNorm = arg.norms[column] ?? 0;
      const value =
        rowNorm > 0 && columnNorm > 0
          ? dot(rowBasis, arg.basis[column] ?? new Float64Array()) /
            (rowNorm * columnNorm)
          : 0;
      gram[row * size + column] = value;
      gram[column * size + row] = value;
    }
  }
  return { gram, rhs };
}

/** Определяет effective rank и собственный базис через Jacobi. */
export function buildJointRankDiagnostics(arg: {
  gram: Float64Array;
  droppedQuadratures: DroppedQuadrature[];
}): JointRankAnalysis {
  const size = Math.sqrt(arg.gram.length);
  if (!Number.isInteger(size)) {
    throw new Error('Gram должен быть квадратной матрицей');
  }
  const eigen = jacobiEigen(arg.gram, size);
  const eigenvalueMax = Math.max(0, eigen.values[0] ?? 0);
  const cutoff = Math.max(
    1e-12,
    eigenvalueMax * RANK_RELATIVE_CUTOFF,
  );
  const retainedEigenvectors: number[] = [];
  for (let column = 0; column < size; column += 1) {
    if ((eigen.values[column] ?? 0) > cutoff) {
      retainedEigenvectors.push(column);
    }
  }
  const positiveEigenvalues = Array.from(eigen.values).filter(
    (value) => value > 0,
  );
  const retainedValues = retainedEigenvectors.map(
    (index) => eigen.values[index] ?? 0,
  );
  const diagonal = Array.from(
    { length: size },
    (_, index) => arg.gram[index * size + index] ?? 0,
  );
  const positiveDiagonal = diagonal.filter((value) => value > 0);
  const eigenvalueMin =
    eigen.values.length > 0
      ? (eigen.values[eigen.values.length - 1] ?? 0)
      : 0;
  const positiveMin = positiveEigenvalues.length
    ? Math.min(...positiveEigenvalues)
    : 0;
  const diagnostics: JointRankDiagnostics = {
    basisColumns: size,
    effectiveRank: retainedEigenvectors.length,
    cutoff,
    condition: finiteRatio(eigenvalueMax, positiveMin),
    retainedCondition:
      retainedValues.length > 0
        ? finiteRatio(
            Math.max(...retainedValues),
            Math.min(...retainedValues),
          )
        : null,
    diagonalMin: Math.min(...diagonal),
    diagonalMax: Math.max(...diagonal),
    diagonalCondition:
      positiveDiagonal.length > 0
        ? finiteRatio(
            Math.max(...positiveDiagonal),
            Math.min(...positiveDiagonal),
          )
        : null,
    eigenvalueMin,
    eigenvalueMax,
    retainedEigenvalueMin:
      retainedValues.length > 0 ? Math.min(...retainedValues) : null,
    retainedEigenvalueMax:
      retainedValues.length > 0 ? Math.max(...retainedValues) : null,
    jacobiSweeps: eigen.sweeps,
    jacobiConverged: eigen.converged,
    droppedQuadratures: arg.droppedQuadratures,
    eigenvalues: Array.from(eigen.values),
  };
  if (
    !Number.isFinite(diagnostics.condition ?? 0) ||
    !Number.isFinite(diagnostics.retainedCondition ?? 0) ||
    diagnostics.eigenvalues.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Нечисловая диагностика ранга');
  }
  return {
    diagnostics,
    eigenvalues: eigen.values,
    eigenvectors: eigen.vectors,
    retainedEigenvectors,
  };
}

/** Собирает problem из нормировки, normal equations и rank-анализа. */
export function prepareJointProjectionProblem(arg: {
  basis: Float64Array[];
  target: ArrayLike<number>;
  initialCoefficients: ArrayLike<number>;
}): JointProjectionProblem {
  validateBasisInput(arg);
  const target = Float64Array.from(arg.target);
  let targetRss = 0;
  for (const value of target) {
    if (!Number.isFinite(value)) {
      throw new Error('Target содержит нечисловое значение');
    }
    targetRss += value * value;
  }
  if (!(targetRss > 0) || !Number.isFinite(targetRss)) {
    throw new Error('Target должен иметь ненулевую конечную энергию');
  }
  const normalized = normalizeProjectionBasis(arg.basis);
  const equations = buildJointNormalEquations({
    basis: arg.basis,
    target,
    norms: normalized.norms,
  });
  const rank = buildJointRankDiagnostics({
    gram: equations.gram,
    droppedQuadratures: normalized.droppedQuadratures,
  });
  return {
    target,
    targetRss,
    basis: arg.basis,
    norms: normalized.norms,
    gram: equations.gram,
    rhs: equations.rhs,
    initialCoefficients: Array.from(arg.initialCoefficients),
    diagnostics: rank.diagnostics,
    eigenvalues: rank.eigenvalues,
    eigenvectors: rank.eigenvectors,
    retainedEigenvectors: rank.retainedEigenvectors,
  };
}

/** Прямой O(NP) пересчёт raw и clipped RSS через базис. */
function evaluateCoefficients(
  problem: JointProjectionProblem,
  coefficients: ArrayLike<number>,
): ClipEvaluation {
  if (coefficients.length !== problem.basis.length) {
    throw new Error('Неверная длина вектора коэффициентов');
  }
  const sampleCount = problem.target.length;
  const raw = new Float64Array(sampleCount);
  const mask = new Uint8Array(sampleCount);
  let rawRss = 0;
  let clippedRss = 0;
  let saturatedSamples = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    let value = problem.fixedOffset?.[sample] ?? 0;
    for (let column = 0; column < problem.basis.length; column += 1) {
      value +=
        (coefficients[column] ?? 0) *
        (problem.basis[column]?.[sample] ?? 0);
    }
    if (!Number.isFinite(value)) {
      throw new Error('Нечисловой линейный кандидат');
    }
    raw[sample] = value;
    const clipped = Math.max(-1, Math.min(1, value));
    const saturated = value <= -1 || value >= 1;
    mask[sample] = saturated ? 1 : 0;
    if (saturated) {
      saturatedSamples += 1;
    }
    const target = problem.target[sample] ?? 0;
    const rawResidual = target - value;
    const clippedResidual = target - clipped;
    rawRss += rawResidual * rawResidual;
    clippedRss += clippedResidual * clippedResidual;
  }
  const targetRms = Math.sqrt(problem.targetRss / sampleCount);
  return {
    coefficients: Array.from(coefficients),
    rawRss,
    clippedRss,
    rawSuppressionPercent:
      100 * (1 - Math.sqrt(rawRss / sampleCount) / targetRms),
    clippedSuppressionPercent:
      100 * (1 - Math.sqrt(clippedRss / sampleCount) / targetRms),
    saturatedSamples,
    raw,
    mask,
  };
}

/** Экспортированный прямой RSS для known-answer и независимой ревизии. */
export function evaluateJointProjectionCoefficients(
  problem: JointProjectionProblem,
  coefficients: ArrayLike<number>,
): JointProjectionObjective {
  const evaluation = evaluateCoefficients(problem, coefficients);
  return {
    coefficients: evaluation.coefficients,
    rawRss: evaluation.rawRss,
    clippedRss: evaluation.clippedRss,
    rawSuppressionPercent: evaluation.rawSuppressionPercent,
    clippedSuppressionPercent: evaluation.clippedSuppressionPercent,
    saturatedSamples: evaluation.saturatedSamples,
  };
}

/** Переводит исходные коэффициенты в нормированные столбцы. */
function toNormalized(
  problem: JointProjectionProblem,
  coefficients: ArrayLike<number>,
): Float64Array {
  return Float64Array.from(
    coefficients,
    (value, index) => value * (problem.norms[index] ?? 0),
  );
}

/** Возвращает коэффициенты исходных базисов из нормированных переменных. */
function fromNormalized(
  problem: JointProjectionProblem,
  normalized: ArrayLike<number>,
): number[] {
  return Array.from(normalized, (value, index) => {
    const norm = problem.norms[index] ?? 0;
    return norm > 0 ? value / norm : 0;
  });
}

/** Квадратичный raw RSS в нормированных переменных, без нового базиса. */
function quadraticRss(
  problem: JointProjectionProblem,
  normalized: ArrayLike<number>,
): number {
  const size = normalized.length;
  let linear = 0;
  let quadratic = 0;
  for (let row = 0; row < size; row += 1) {
    linear += (normalized[row] ?? 0) * (problem.rhs[row] ?? 0);
    for (let column = 0; column < size; column += 1) {
      quadratic +=
        (normalized[row] ?? 0) *
        (problem.gram[row * size + column] ?? 0) *
        (normalized[column] ?? 0);
    }
  }
  return problem.targetRss - 2 * linear + quadratic;
}

/** Решает один ridge в сохранённом собственном базисе. */
function ridgeCoefficients(
  problem: JointProjectionProblem,
  lambda: number,
): number[] {
  const size = problem.basis.length;
  const normalized = new Float64Array(size);
  for (const eigenvector of problem.retainedEigenvectors) {
    const eigenvalue = problem.eigenvalues[eigenvector] ?? 0;
    let projection = 0;
    for (let row = 0; row < size; row += 1) {
      projection +=
        (problem.eigenvectors[row * size + eigenvector] ?? 0) *
        (problem.rhs[row] ?? 0);
    }
    const scale = projection / (eigenvalue + lambda);
    for (let row = 0; row < size; row += 1) {
      normalized[row] =
        (normalized[row] ?? 0) +
        (problem.eigenvectors[row * size + eigenvector] ?? 0) * scale;
    }
  }
  return fromNormalized(problem, normalized);
}

/** Градиент половины raw RSS по нормированным коэффициентам. */
function rawGradient(
  problem: JointProjectionProblem,
  normalized: ArrayLike<number>,
): Float64Array {
  const size = normalized.length;
  const gradient = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    let value = -(problem.rhs[row] ?? 0);
    for (let column = 0; column < size; column += 1) {
      value +=
        (problem.gram[row * size + column] ?? 0) *
        (normalized[column] ?? 0);
    }
    gradient[row] = value;
  }
  return gradient;
}

/** Один монотонный projected-gradient запуск bounded raw solver. */
function optimizeBoundedRawStart(arg: {
  problem: JointProjectionProblem;
  initial: number[];
  start: 'current' | 'unbounded';
}): {
  objective: JointProjectionObjective;
  audit: BoundedSolverAudit['starts'][number];
} {
  const { problem } = arg;
  let coefficients = projectRadialCoefficientPairs(
    arg.initial,
    problem.initialCoefficients,
  );
  let normalized = toNormalized(problem, coefficients);
  let rss = quadraticRss(problem, normalized);
  let iterations = 0;
  let backtracks = 0;
  let violatedBounds = countBoundViolations(arg.initial);
  const largestEigenvalue =
    problem.diagnostics.retainedEigenvalueMax ?? 0;
  const initialStep =
    largestEigenvalue > 0 ? 1 / largestEigenvalue : 0;
  for (
    let iteration = 0;
    iteration < D_MAX_ITERATIONS && initialStep > 0;
    iteration += 1
  ) {
    const gradient = rawGradient(problem, normalized);
    let gradientNorm = 0;
    for (const value of gradient) {
      gradientNorm += value * value;
    }
    if (gradientNorm <= 1e-24) {
      break;
    }
    let accepted = false;
    let step = initialStep;
    for (
      let backtrack = 0;
      backtrack <= MAX_BACKTRACKS;
      backtrack += 1
    ) {
      const proposed = Float64Array.from(
        normalized,
        (value, index) => value - step * (gradient[index] ?? 0),
      );
      const unbounded = fromNormalized(problem, proposed);
      violatedBounds += countBoundViolations(unbounded);
      const candidateCoefficients = projectRadialCoefficientPairs(
        unbounded,
        coefficients,
      );
      const candidateNormalized = toNormalized(
        problem,
        candidateCoefficients,
      );
      const candidateRss = quadraticRss(problem, candidateNormalized);
      const tolerance =
        ACCEPTANCE_EPSILON * Math.max(1, Math.abs(rss));
      if (
        Number.isFinite(candidateRss) &&
        candidateRss <= rss + tolerance
      ) {
        const improvement = rss - candidateRss;
        coefficients = candidateCoefficients;
        normalized = candidateNormalized;
        rss = candidateRss;
        iterations += 1;
        accepted = true;
        if (improvement <= tolerance) {
          iteration = D_MAX_ITERATIONS;
        }
        break;
      }
      backtracks += 1;
      step *= 0.5;
    }
    if (!accepted) {
      break;
    }
  }
  const objective = evaluateJointProjectionCoefficients(
    problem,
    coefficients,
  );
  return {
    objective,
    audit: {
      start: arg.start,
      iterations,
      backtracks,
      violatedBounds,
      rawRss: objective.rawRss,
    },
  };
}

/** Градиент половины clipped RSS; насыщенные отсчёты получают ноль. */
function clippedGradient(
  problem: JointProjectionProblem,
  evaluation: ClipEvaluation,
): Float64Array {
  const size = problem.basis.length;
  const gradient = new Float64Array(size);
  for (let sample = 0; sample < problem.target.length; sample += 1) {
    if ((evaluation.mask[sample] ?? 0) === 1) {
      continue;
    }
    const residual =
      (problem.target[sample] ?? 0) - (evaluation.raw[sample] ?? 0);
    for (let column = 0; column < size; column += 1) {
      const norm = problem.norms[column] ?? 0;
      if (norm > 0) {
        gradient[column] =
          (gradient[column] ?? 0) -
          ((problem.basis[column]?.[sample] ?? 0) * residual) / norm;
      }
    }
  }
  return gradient;
}

/** Число отсчётов, у которых изменилась принадлежность clip-маске. */
function countMaskChanges(a: Uint8Array, b: Uint8Array): number {
  let changes = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      changes += 1;
    }
  }
  return changes;
}

/** Запускает до maxIterations монотонных clip-aware шагов от одной точки. */
function optimizeClippedStart(arg: {
  problem: JointProjectionProblem;
  initial: number[];
  start: 'current' | 'd';
  maxIterations: number;
}): { evaluation: ClipEvaluation; audit: ClipStartAudit } {
  const { problem } = arg;
  let coefficients = projectRadialCoefficientPairs(
    arg.initial,
    problem.initialCoefficients,
  );
  let evaluation = evaluateCoefficients(problem, coefficients);
  const initialRss = evaluation.clippedRss;
  let objectiveEvaluations = 1;
  let maskRecomputations = 1;
  let backtracks = 0;
  let violatedBounds = countBoundViolations(arg.initial);
  const history: ClipIterationAudit[] = [];
  const largestEigenvalue =
    problem.diagnostics.retainedEigenvalueMax ?? 0;
  const initialStep =
    largestEigenvalue > 0 ? 2 / largestEigenvalue : 0;
  for (
    let iteration = 0;
    iteration < arg.maxIterations && initialStep > 0;
    iteration += 1
  ) {
    const normalized = toNormalized(problem, coefficients);
    const gradient = clippedGradient(problem, evaluation);
    let gradientNorm = 0;
    for (const value of gradient) {
      gradientNorm += value * value;
    }
    if (gradientNorm <= 1e-24) {
      break;
    }
    let accepted = false;
    let step = initialStep;
    for (
      let backtrack = 0;
      backtrack <= MAX_BACKTRACKS;
      backtrack += 1
    ) {
      const proposed = Float64Array.from(
        normalized,
        (value, index) => value - step * (gradient[index] ?? 0),
      );
      const unbounded = fromNormalized(problem, proposed);
      const violations = countBoundViolations(unbounded);
      violatedBounds += violations;
      const candidateCoefficients = projectRadialCoefficientPairs(
        unbounded,
        coefficients,
      );
      const candidate = evaluateCoefficients(
        problem,
        candidateCoefficients,
      );
      objectiveEvaluations += 1;
      maskRecomputations += 1;
      const tolerance =
        ACCEPTANCE_EPSILON * Math.max(1, evaluation.clippedRss);
      if (candidate.clippedRss < evaluation.clippedRss - tolerance) {
        const maskChanges = countMaskChanges(
          evaluation.mask,
          candidate.mask,
        );
        history.push({
          iteration: history.length + 1,
          rssBefore: evaluation.clippedRss,
          rssAfter: candidate.clippedRss,
          step,
          backtracks: backtrack,
          violatedBounds: violations,
          saturatedBefore: evaluation.saturatedSamples,
          saturatedAfter: candidate.saturatedSamples,
          maskChanges,
        });
        coefficients = candidateCoefficients;
        evaluation = candidate;
        accepted = true;
        break;
      }
      backtracks += 1;
      step *= 0.5;
    }
    if (!accepted) {
      break;
    }
  }
  return {
    evaluation,
    audit: {
      start: arg.start,
      initialRss,
      finalRss: evaluation.clippedRss,
      iterations: history.length,
      backtracks,
      violatedBounds,
      maskChanges: history.reduce(
        (sum, entry) => sum + entry.maskChanges,
        0,
      ),
      maskRecomputations,
      objectiveEvaluations,
      history,
      coefficients,
    },
  };
}

/** Результат одного clip-aware refit с неизменным внешним вкладом. */
export interface FixedOffsetClipRefitResult {
  objective: JointProjectionObjective;
  audit: ClipStartAudit;
}

/**
 * Уточняет четыре квадратуры пары при фиксированном внешнем вкладе.
 *
 * @param arg - Базисы пары, полный normalized target, внешний raw offset,
 *   стартовые коэффициенты bounded raw winner и предел итераций
 * @returns Прямые метрики полного сигнала и аудит одного E-старта
 * @remarks `fixedOffset` складывается с вкладами пары до hard clip. Поэтому
 *   solver минимизирует RSS полного сигнала против исходного target, а не
 *   клиппирует пару отдельно. Запускается только один старт от переданного
 *   raw fit; полный D/E, ridge и новые базисы здесь не вычисляются.
 */
export function refitClippedQuadraturePair(arg: {
  basis: Float64Array[];
  target: ArrayLike<number>;
  fixedOffset: ArrayLike<number>;
  initialCoefficients: ArrayLike<number>;
  maxIterations?: number;
}): FixedOffsetClipRefitResult {
  if (arg.basis.length !== 4) {
    throw new Error(
      'Clip-aware refit принимает ровно четыре квадратуры',
    );
  }
  const maxIterations = arg.maxIterations ?? JOINT_E_ITERATIONS;
  if (
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > JOINT_E_ITERATIONS
  ) {
    throw new Error('maxIterations должен быть целым от 1 до 25');
  }
  if (arg.fixedOffset.length !== arg.target.length) {
    throw new Error('Фиксированный offset не совпадает с target');
  }
  const fixedOffset = Float64Array.from(arg.fixedOffset);
  if (fixedOffset.some((value) => !Number.isFinite(value))) {
    throw new Error(
      'Фиксированный offset содержит нечисловое значение',
    );
  }
  const prepared = prepareJointProjectionProblem({
    basis: arg.basis,
    target: arg.target,
    initialCoefficients: arg.initialCoefficients,
  });
  const problem: JointProjectionProblem = {
    ...prepared,
    fixedOffset,
  };
  const { evaluation, audit } = optimizeClippedStart({
    problem,
    initial: Array.from(arg.initialCoefficients),
    start: 'd',
    maxIterations,
  });
  return {
    objective: {
      coefficients: evaluation.coefficients,
      rawRss: evaluation.rawRss,
      clippedRss: evaluation.clippedRss,
      rawSuppressionPercent: evaluation.rawSuppressionPercent,
      clippedSuppressionPercent: evaluation.clippedSuppressionPercent,
      saturatedSamples: evaluation.saturatedSamples,
    },
    audit,
  };
}

/**
 * Решает unbounded, D и E на одном подготовленном базисе.
 * Все итоговые RSS пересчитываются прямо, а не берутся из normal equations.
 */
export function solveJointProjectionProblem(
  problem: JointProjectionProblem,
  options: { maxEIterations?: number } = {},
): JointProjectionSolution {
  const maxEIterations = options.maxEIterations ?? JOINT_E_ITERATIONS;
  if (
    !Number.isInteger(maxEIterations) ||
    maxEIterations < 1 ||
    maxEIterations > JOINT_E_ITERATIONS
  ) {
    throw new Error('maxEIterations должен быть целым от 1 до 25');
  }
  let directStateEvaluations = 0;
  const evaluate = (
    coefficients: number[],
  ): JointProjectionObjective => {
    directStateEvaluations += 1;
    return evaluateJointProjectionCoefficients(problem, coefficients);
  };
  const current = evaluate(problem.initialCoefficients);
  const fits = JOINT_RIDGE_LAMBDAS.map((lambda) => ({
    lambda,
    ...evaluate(ridgeCoefficients(problem, lambda)),
  }));
  const best = fits.reduce((winner, candidate) =>
    candidate.rawRss < winner.rawRss ? candidate : winner,
  );
  const boundedStarts = [
    optimizeBoundedRawStart({
      problem,
      initial: problem.initialCoefficients,
      start: 'current',
    }),
    optimizeBoundedRawStart({
      problem,
      initial: best.coefficients,
      start: 'unbounded',
    }),
  ];
  directStateEvaluations += boundedStarts.length;
  const bestBounded = boundedStarts.reduce((winner, candidate) =>
    candidate.objective.rawRss < winner.objective.rawRss
      ? candidate
      : winner,
  );
  const d = {
    ...evaluate(bestBounded.objective.coefficients),
    solver: {
      iterations: boundedStarts.reduce(
        (sum, start) => sum + start.audit.iterations,
        0,
      ),
      backtracks: boundedStarts.reduce(
        (sum, start) => sum + start.audit.backtracks,
        0,
      ),
      violatedBounds: boundedStarts.reduce(
        (sum, start) => sum + start.audit.violatedBounds,
        0,
      ),
      starts: boundedStarts.map((start) => start.audit),
    },
  };
  const clippedStarts = [
    optimizeClippedStart({
      problem,
      initial: problem.initialCoefficients,
      start: 'current',
      maxIterations: maxEIterations,
    }),
    optimizeClippedStart({
      problem,
      initial: d.coefficients,
      start: 'd',
      maxIterations: maxEIterations,
    }),
  ];
  directStateEvaluations += clippedStarts.reduce(
    (sum, start) => sum + start.audit.objectiveEvaluations,
    0,
  );
  const selected = clippedStarts.reduce((winner, candidate) =>
    candidate.evaluation.clippedRss < winner.evaluation.clippedRss
      ? candidate
      : winner,
  );
  const eEvaluation = selected.evaluation;
  const e: ClippedJointSolution = {
    coefficients: eEvaluation.coefficients,
    rawRss: eEvaluation.rawRss,
    clippedRss: eEvaluation.clippedRss,
    rawSuppressionPercent: eEvaluation.rawSuppressionPercent,
    clippedSuppressionPercent: eEvaluation.clippedSuppressionPercent,
    saturatedSamples: eEvaluation.saturatedSamples,
    selectedStart: selected.audit.start,
    starts: clippedStarts.map((start) => start.audit),
    iterations: clippedStarts.reduce(
      (sum, start) => sum + start.audit.iterations,
      0,
    ),
    backtracks: clippedStarts.reduce(
      (sum, start) => sum + start.audit.backtracks,
      0,
    ),
    violatedBounds: clippedStarts.reduce(
      (sum, start) => sum + start.audit.violatedBounds,
      0,
    ),
    maskChanges: clippedStarts.reduce(
      (sum, start) => sum + start.audit.maskChanges,
      0,
    ),
    objectiveEvaluations: clippedStarts.reduce(
      (sum, start) => sum + start.audit.objectiveEvaluations,
      0,
    ),
  };
  return {
    current,
    unbounded: {
      fits,
      bestLambda: best.lambda,
      best,
      diagnosticSuppressionPercent: best.rawSuppressionPercent,
    },
    d,
    e,
    diagnostics: problem.diagnostics,
    directStateEvaluations,
  };
}

/** Строит исходные коэффициенты L·cos(phase), L·sin(phase). */
function initialPatchCoefficients(patch: ArgCreateSynth): {
  coefficients: number[];
  activeOscillatorIndices: number[];
} {
  const coefficients: number[] = [];
  const activeOscillatorIndices: number[] = [];
  for (let index = 0; index < patch.oscillators.length; index += 1) {
    const group = patch.oscillators[index];
    if (group === undefined || !group.osc.on) {
      continue;
    }
    activeOscillatorIndices.push(index);
    coefficients.push(
      group.ampEnv.startLevel * Math.cos(group.osc.phase),
      group.ampEnv.startLevel * Math.sin(group.osc.phase),
    );
  }
  return { coefficients, activeOscillatorIndices };
}

/** Переводит допустимые квадратуры в patch, не трогая off slots и прочие поля. */
export function patchFromJointCoefficients(arg: {
  patch: ArgCreateSynth;
  activeOscillatorIndices: number[];
  coefficients: ArrayLike<number>;
  norms?: ArrayLike<number>;
}): ArgCreateSynth {
  if (
    arg.activeOscillatorIndices.length * 2 !==
    arg.coefficients.length
  ) {
    throw new Error('Индексы и квадратуры не согласованы');
  }
  const patch = clonePatch(arg.patch);
  for (
    let active = 0;
    active < arg.activeOscillatorIndices.length;
    active += 1
  ) {
    const oscillatorIndex = arg.activeOscillatorIndices[active] ?? -1;
    const group = patch.oscillators[oscillatorIndex];
    if (group === undefined || !group.osc.on) {
      throw new Error('Активный слот изменился во время проекции');
    }
    const sine = arg.coefficients[active * 2] ?? 0;
    const cosine = arg.coefficients[active * 2 + 1] ?? 0;
    const bothDropped =
      arg.norms !== undefined &&
      (arg.norms[active * 2] ?? 0) === 0 &&
      (arg.norms[active * 2 + 1] ?? 0) === 0;
    if (bothDropped) {
      continue;
    }
    const norm = Math.hypot(sine, cosine);
    if (!Number.isFinite(norm)) {
      throw new Error('Нечисловой уровень проекции');
    }
    group.ampEnv.startLevel = Math.max(
      MIN_LEVEL,
      Math.min(MAX_LEVEL, norm),
    );
    group.osc.phase =
      norm > 1e-15 ? normalizedPhase(Math.atan2(cosine, sine)) : 0;
  }
  return patch;
}

/** Отличает расхождение PCM от программной ошибки проверки. */
function isCanonicalPcmMismatch(caught: unknown): boolean {
  return (
    caught instanceof Error &&
    caught.message.startsWith('patch.json не совпадает с result.wav:')
  );
}

/**
 * Проверяет canonical WAV и применяет общий global/J guard к current.
 * Только побайтовое расхождение candidate PCM становится rejection. Ошибки
 * candidate render/measure и остальные программные ошибки прерывают сид.
 */
export function canonicalCandidate<
  T extends JointProjectionObjective,
>(arg: {
  kind: 'd' | 'e';
  raw: T;
  proposedPatch: ArgCreateSynth;
  currentPatch: ArgCreateSynth;
  currentSamples: Int16Array;
  baseline: RefitMetrics;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  usefulZone: ReturnType<typeof computeUsefulZone>;
}): JointProjectionCandidate<T> {
  const proposedSamples = renderForTarget(
    arg.proposedPatch,
    arg.target.length,
    arg.phaseModel,
  );
  let valid = true;
  let error: string | null = null;
  try {
    assertPatchMatchesWav(
      arg.proposedPatch,
      proposedSamples,
      arg.phaseModel,
      arg.sampleRate,
      arg.target.length,
    );
  } catch (caught) {
    if (!isCanonicalPcmMismatch(caught)) {
      throw caught;
    }
    valid = false;
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const proposedMetrics = measureMetrics(
    proposedSamples,
    arg.target,
    arg.sampleRate,
    arg.usefulZone,
  );
  const globalDelta =
    proposedMetrics.globalSuppressionPercent -
    arg.baseline.globalSuppressionPercent;
  const windowedDelta =
    proposedMetrics.windowedSuppressionPercent -
    arg.baseline.windowedSuppressionPercent;
  const accepted =
    valid &&
    globalDelta > 1e-10 &&
    proposedMetrics.windowedSuppressionPercent >=
      arg.baseline.windowedSuppressionPercent - 0.05;
  const rejectionReason = accepted
    ? null
    : !valid
      ? 'canonical patch/WAV не совпали'
      : globalDelta <= 1e-10
        ? 'canonical global не вырос'
        : 'canonical J ниже initial−0.05';
  return {
    kind: arg.kind,
    status: accepted ? 'refined' : 'unchanged',
    accepted,
    rejectionReason,
    patch: accepted
      ? arg.proposedPatch
      : clonePatch(arg.currentPatch),
    samples: accepted
      ? proposedSamples
      : new Int16Array(arg.currentSamples),
    coefficients: arg.raw.coefficients,
    raw: arg.raw,
    canonical: {
      ...proposedMetrics,
      globalDelta,
      windowedDelta,
      valid,
      error,
    },
    savedGlobalDelta: accepted ? globalDelta : 0,
    savedWindowedDelta: accepted ? windowedDelta : 0,
    metrics: accepted ? proposedMetrics : arg.baseline,
  };
}

interface PatchJointProjectionProblem {
  currentPatch: ArgCreateSynth;
  target: number[];
  activeOscillatorIndices: number[];
  basisCount: number;
  problem: JointProjectionProblem;
}

interface CurrentJointBaseline {
  patch: ArgCreateSynth;
  samples: Int16Array;
  metrics: RefitMetrics;
  usefulZone: ReturnType<typeof computeUsefulZone>;
}

/** Клонирует patch и строит один численный problem из активных слотов. */
function buildPatchJointProjectionProblem(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  phaseModel: PhaseModel;
}): PatchJointProjectionProblem {
  const currentPatch = clonePatch(arg.patch);
  const { coefficients, activeOscillatorIndices } =
    initialPatchCoefficients(currentPatch);
  if (activeOscillatorIndices.length === 0) {
    throw new Error('Нет активных осцилляторов');
  }
  const target = Array.from(arg.target);
  const targetNormalized = Float64Array.from(
    target,
    (value) => value / MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  );
  const basis: Float64Array[] = [];
  for (const oscillatorIndex of activeOscillatorIndices) {
    const group = currentPatch.oscillators[oscillatorIndex];
    if (group === undefined) {
      throw new Error('Не удалось прочитать активный осциллятор');
    }
    basis.push(
      renderGroup(unitGroup(group, 0), target.length, arg.phaseModel),
      renderGroup(
        unitGroup(group, Math.PI / 2),
        target.length,
        arg.phaseModel,
      ),
    );
  }
  const problem = prepareJointProjectionProblem({
    basis,
    target: targetNormalized,
    initialCoefficients: coefficients,
  });
  return {
    currentPatch,
    target,
    activeOscillatorIndices,
    basisCount: basis.length,
    problem,
  };
}

/** Рендерит и измеряет current до проверки любого candidate. */
function renderCurrentJointBaseline(arg: {
  patch: ArgCreateSynth;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
}): CurrentJointBaseline {
  const samples = renderForTarget(
    arg.patch,
    arg.target.length,
    arg.phaseModel,
  );
  assertPatchMatchesWav(
    arg.patch,
    samples,
    arg.phaseModel,
    arg.sampleRate,
    arg.target.length,
  );
  const usefulZone = computeUsefulZone(arg.target, arg.sampleRate);
  const metrics = measureMetrics(
    samples,
    arg.target,
    arg.sampleRate,
    usefulZone,
  );
  return { patch: arg.patch, samples, metrics, usefulZone };
}

/** Переводит D/E в patch и применяет к каждому независимый canonical guard. */
function guardJointProjectionSolutions(arg: {
  solution: JointProjectionSolution;
  problem: JointProjectionProblem;
  activeOscillatorIndices: number[];
  current: CurrentJointBaseline;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
}): {
  d: JointProjectionOracleResult['d'];
  e: JointProjectionOracleResult['e'];
  eMinusD: JointProjectionOracleResult['eMinusD'];
} {
  const dPatch = patchFromJointCoefficients({
    patch: arg.current.patch,
    activeOscillatorIndices: arg.activeOscillatorIndices,
    coefficients: arg.solution.d.coefficients,
    norms: arg.problem.norms,
  });
  const ePatch = patchFromJointCoefficients({
    patch: arg.current.patch,
    activeOscillatorIndices: arg.activeOscillatorIndices,
    coefficients: arg.solution.e.coefficients,
    norms: arg.problem.norms,
  });
  const common = {
    currentPatch: arg.current.patch,
    currentSamples: arg.current.samples,
    baseline: arg.current.metrics,
    target: arg.target,
    sampleRate: arg.sampleRate,
    phaseModel: arg.phaseModel,
    usefulZone: arg.current.usefulZone,
  };
  const d = canonicalCandidate({
    kind: 'd',
    raw: arg.solution.d,
    proposedPatch: dPatch,
    ...common,
  });
  const e = canonicalCandidate({
    kind: 'e',
    raw: arg.solution.e,
    proposedPatch: ePatch,
    ...common,
  });
  return {
    d,
    e,
    eMinusD: {
      rawRss: arg.solution.e.rawRss - arg.solution.d.rawRss,
      clippedRss:
        arg.solution.e.clippedRss - arg.solution.d.clippedRss,
      canonicalGlobal:
        e.canonical.globalSuppressionPercent -
        d.canonical.globalSuppressionPercent,
      canonicalWindowed:
        e.canonical.windowedSuppressionPercent -
        d.canonical.windowedSuppressionPercent,
    },
  };
}

/** Дирижёр строит problem, запускает solver и проверяет candidate против current. */
export function runJointProjectionOracle(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  maxEIterations?: number;
}): JointProjectionOracleResult {
  const started = Date.now();
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Joint projection поддерживает только 44100 Гц');
  }
  if (arg.target.length === 0) {
    throw new Error('Пустой target');
  }
  const built = buildPatchJointProjectionProblem({
    patch: arg.patch,
    target: arg.target,
    phaseModel,
  });
  const solution = solveJointProjectionProblem(built.problem, {
    maxEIterations: arg.maxEIterations,
  });
  const baseline = renderCurrentJointBaseline({
    patch: built.currentPatch,
    target: built.target,
    sampleRate,
    phaseModel,
  });
  const guarded = guardJointProjectionSolutions({
    solution,
    problem: built.problem,
    activeOscillatorIndices: built.activeOscillatorIndices,
    current: baseline,
    target: built.target,
    sampleRate,
    phaseModel,
  });
  return {
    current: {
      patch: baseline.patch,
      samples: baseline.samples,
      metrics: baseline.metrics,
      raw: solution.current,
    },
    diagnostics: {
      ...solution.diagnostics,
      activeOscillatorIndices: built.activeOscillatorIndices,
    },
    unbounded: solution.unbounded,
    d: guarded.d,
    e: guarded.e,
    eMinusD: guarded.eMinusD,
    cost: {
      activeOscillators: built.activeOscillatorIndices.length,
      unitBasisRenders: built.basisCount,
      gramDotProducts:
        (built.basisCount * (built.basisCount + 1)) / 2,
      directStateEvaluations: solution.directStateEvaluations,
      clipObjectiveEvaluations: solution.e.objectiveEvaluations,
      dIterations: solution.d.solver.iterations,
      eIterations: solution.e.iterations,
      backtracks:
        solution.d.solver.backtracks + solution.e.backtracks,
      canonicalCandidateRenders: 2,
      durationMs: Date.now() - started,
    },
  };
}

/** Сериализуемый аудит кандидата без PCM и повторного patch в JSON. */
function candidateAudit(candidate: JointProjectionCandidate): object {
  return {
    savedGlobalDelta: candidate.savedGlobalDelta,
    savedWindowedDelta: candidate.savedWindowedDelta,
    kind: candidate.kind,
    status: candidate.status,
    accepted: candidate.accepted,
    rejectionReason: candidate.rejectionReason,
    coefficients: candidate.coefficients,
    raw: candidate.raw,
    canonical: candidate.canonical,
    finalMetrics: candidate.metrics,
    artifactIsFallback: !candidate.accepted,
    config: JOINT_PROJECTION_CONFIG,
  };
}

/** Атомарно пишет patch, WAV и аудит уже проверенного final candidate. */
async function saveCandidateArtifacts(arg: {
  directory: string;
  candidate: JointProjectionCandidate;
  sampleRate: number;
  phaseModel: PhaseModel;
  sampleCount: number;
}): Promise<{ patch: string; wav: string; audit: string }> {
  assertPatchMatchesWav(
    arg.candidate.patch,
    arg.candidate.samples,
    arg.phaseModel,
    arg.sampleRate,
    arg.sampleCount,
  );
  mkdirSync(arg.directory, { recursive: true });
  const patch = join(arg.directory, 'patch.json');
  const wav = join(arg.directory, 'result.wav');
  const audit = join(arg.directory, 'audit.json');
  await writeJsonAtomic(patch, arg.candidate.patch);
  writeWav({
    samples: arg.candidate.samples,
    sampleRate: arg.sampleRate,
    filePath: `${wav}.tmp`,
  });
  await rename(`${wav}.tmp`, wav);
  await writeJsonAtomic(audit, candidateAudit(arg.candidate));
  return { patch, wav, audit };
}

/** Сводит кандидат для seed/report без потери метрик отвергнутого canonical. */
function candidateReport(
  candidate: JointProjectionCandidate,
  current: JointProjectionObjective,
  artifacts: { patch: string; wav: string; audit: string },
): CandidateRunReport {
  return {
    status: candidate.status,
    accepted: candidate.accepted,
    rejectionReason: candidate.rejectionReason,
    rawRss: candidate.raw.rawRss,
    rawRssDelta: candidate.raw.rawRss - current.rawRss,
    clippedRss: candidate.raw.clippedRss,
    clippedRssDelta: candidate.raw.clippedRss - current.clippedRss,
    rawSuppressionPercent: candidate.raw.rawSuppressionPercent,
    rawSuppressionDelta:
      candidate.raw.rawSuppressionPercent -
      current.rawSuppressionPercent,
    clippedSuppressionPercent:
      candidate.raw.clippedSuppressionPercent,
    clippedSuppressionDelta:
      candidate.raw.clippedSuppressionPercent -
      current.clippedSuppressionPercent,
    canonicalGlobalSuppressionPercent:
      candidate.canonical.globalSuppressionPercent,
    canonicalWindowedSuppressionPercent:
      candidate.canonical.windowedSuppressionPercent,
    canonicalGlobalDelta: candidate.canonical.globalDelta,
    canonicalWindowedDelta: candidate.canonical.windowedDelta,
    savedGlobalDelta: candidate.savedGlobalDelta,
    savedWindowedDelta: candidate.savedWindowedDelta,
    canonicalValid: candidate.canonical.valid,
    canonicalError: candidate.canonical.error,
    ...artifacts,
  };
}

interface VerifiedJointRun {
  sourceRunDir: string;
  record: RunRecord;
  patch: ArgCreateSynth;
  target: ReturnType<typeof readWav>;
}

interface CandidateArtifacts {
  patch: string;
  wav: string;
  audit: string;
}

/** Читает run.json, отличая отсутствие/другой статус от битого JSON. */
async function readJointRunRecord(
  sourceRunDir: string,
): Promise<RunRecord | null> {
  const path = join(sourceRunDir, 'run.json');
  if (!existsSync(path)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : String(caught);
    throw new Error(
      `Повреждён run.json в ${sourceRunDir}: ${message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `Повреждён run.json в ${sourceRunDir}: не объект`,
    );
  }
  const record = parsed as Partial<RunRecord>;
  if (typeof record.status !== 'string') {
    throw new Error(
      `Повреждён run.json в ${sourceRunDir}: нет status`,
    );
  }
  if (record.status !== 'completed') {
    return null;
  }
  if (typeof record.target !== 'string' || record.target === '') {
    throw new Error(
      `Повреждён run.json в ${sourceRunDir}: нет target`,
    );
  }
  return {
    status: record.status,
    target: record.target,
    globalSuppressionPercent:
      typeof record.globalSuppressionPercent === 'number' ||
      record.globalSuppressionPercent === null
        ? record.globalSuppressionPercent
        : undefined,
  };
}

/** Загружает completed match и заранее проверяет его patch/WAV. */
async function loadVerifiedJointRun(arg: {
  dataset: string;
  slug: string;
  seed: number;
  targetsDir: string;
  phaseModel: PhaseModel;
}): Promise<VerifiedJointRun | null> {
  const sourceRunDir = join(
    arg.dataset,
    arg.slug,
    `seed-${arg.seed}`,
  );
  const record = await readJointRunRecord(sourceRunDir);
  if (record === null) {
    return null;
  }
  const patch = await readJsonOrNull<ArgCreateSynth>(
    join(sourceRunDir, 'patch.json'),
  );
  if (patch === null) {
    throw new Error(`Нет или повреждён patch.json в ${sourceRunDir}`);
  }
  const target = readWav(join(arg.targetsDir, record.target));
  const baselineWav = readWav(join(sourceRunDir, 'result.wav'));
  if (target.sampleRate !== baselineWav.sampleRate) {
    throw new Error(`Разные sample rate в ${sourceRunDir}`);
  }
  if (target.samples.length !== baselineWav.samples.length) {
    throw new Error(`Разные длины target/match в ${sourceRunDir}`);
  }
  assertPatchMatchesWav(
    patch,
    baselineWav.samples,
    arg.phaseModel,
    target.sampleRate,
    target.samples.length,
  );
  return { sourceRunDir, record, patch, target };
}

/** Сохраняет оба проверенных final candidate, включая fallback current. */
async function saveJointCandidateSet(arg: {
  outRunDir: string;
  result: JointProjectionOracleResult;
  sampleRate: number;
  phaseModel: PhaseModel;
  sampleCount: number;
}): Promise<{ d: CandidateArtifacts; e: CandidateArtifacts }> {
  const d = await saveCandidateArtifacts({
    directory: join(arg.outRunDir, 'd'),
    candidate: arg.result.d,
    sampleRate: arg.sampleRate,
    phaseModel: arg.phaseModel,
    sampleCount: arg.sampleCount,
  });
  const e = await saveCandidateArtifacts({
    directory: join(arg.outRunDir, 'e'),
    candidate: arg.result.e,
    sampleRate: arg.sampleRate,
    phaseModel: arg.phaseModel,
    sampleCount: arg.sampleCount,
  });
  return { d, e };
}

/** Создаёт seed report из отдельных current/raw/canonical значений. */
function createJointRunReport(arg: {
  slug: string;
  seed: number;
  loaded: VerifiedJointRun;
  result: JointProjectionOracleResult;
  artifacts: { d: CandidateArtifacts; e: CandidateArtifacts };
  started: number;
}): JointRunReport {
  const { result } = arg;
  return {
    slug: arg.slug,
    seed: arg.seed,
    sourceRunDir: arg.loaded.sourceRunDir,
    savedGlobalSuppressionPercent:
      arg.loaded.record.globalSuppressionPercent ?? null,
    current: {
      globalSuppressionPercent:
        result.current.metrics.globalSuppressionPercent,
      windowedSuppressionPercent:
        result.current.metrics.windowedSuppressionPercent,
      rawRss: result.current.raw.rawRss,
      clippedRss: result.current.raw.clippedRss,
      rawSuppressionPercent: result.current.raw.rawSuppressionPercent,
      clippedSuppressionPercent:
        result.current.raw.clippedSuppressionPercent,
    },
    rank: result.diagnostics,
    unbounded: {
      bestLambda: result.unbounded.bestLambda,
      rawRss: result.unbounded.best.rawRss,
      clippedRss: result.unbounded.best.clippedRss,
      diagnosticSuppressionPercent:
        result.unbounded.diagnosticSuppressionPercent,
      fits: result.unbounded.fits,
    },
    d: {
      ...candidateReport(
        result.d,
        result.current.raw,
        arg.artifacts.d,
      ),
      iterations: result.d.raw.solver.iterations,
      backtracks: result.d.raw.solver.backtracks,
      violatedBounds: result.d.raw.solver.violatedBounds,
    },
    e: {
      ...candidateReport(
        result.e,
        result.current.raw,
        arg.artifacts.e,
      ),
      selectedStart: result.e.raw.selectedStart,
      iterations: result.e.raw.iterations,
      backtracks: result.e.raw.backtracks,
      violatedBounds: result.e.raw.violatedBounds,
      maskChanges: result.e.raw.maskChanges,
      starts: result.e.raw.starts,
    },
    eMinusD: result.eMinusD,
    cost: result.cost,
    durationMs: Date.now() - arg.started,
  };
}

/** Дирижёр одного completed match: загрузка, oracle, сохранение и report. */
async function processRun(arg: {
  dataset: string;
  slug: string;
  seed: number;
  targetsDir: string;
  phaseModel: PhaseModel;
  outDir: string;
}): Promise<JointRunReport | null> {
  const loaded = await loadVerifiedJointRun(arg);
  if (loaded === null) {
    return null;
  }
  const started = Date.now();
  const result = runJointProjectionOracle({
    patch: loaded.patch,
    target: loaded.target.samples,
    sampleRate: loaded.target.sampleRate,
    phaseModel: arg.phaseModel,
  });
  const artifacts = await saveJointCandidateSet({
    outRunDir: join(arg.outDir, arg.slug, `seed-${arg.seed}`),
    result,
    sampleRate: loaded.target.sampleRate,
    phaseModel: arg.phaseModel,
    sampleCount: loaded.target.samples.length,
  });
  return createJointRunReport({
    slug: arg.slug,
    seed: arg.seed,
    loaded,
    result,
    artifacts,
    started,
  });
}

/** Среднее пустого набора равно нулю, как и saved gain отсутствующего accepted. */
function meanOrZero(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Сводит D или E, не подменяя сохранённый прирост proposed-диагностикой. */
function summarizeJointCandidates(
  runs: JointRunReport[],
  kind: 'd' | 'e',
): JointCandidateSummary {
  const candidates: CandidateRunReport[] = runs.map(
    (run) => run[kind],
  );
  return {
    runs: candidates.length,
    meanSavedGlobalDelta: meanOrZero(
      candidates.map((candidate) => candidate.savedGlobalDelta),
    ),
    meanSavedWindowedDelta: meanOrZero(
      candidates.map((candidate) => candidate.savedWindowedDelta),
    ),
    improved: candidates.filter(
      (candidate) =>
        candidate.accepted && candidate.savedGlobalDelta > 0,
    ).length,
    meanProposedGlobalDelta: meanOrZero(
      candidates.map((candidate) => candidate.canonicalGlobalDelta),
    ),
    meanProposedWindowedDelta: meanOrZero(
      candidates.map((candidate) => candidate.canonicalWindowedDelta),
    ),
  };
}

/** Строит отдельные D/E-сводки в порядке первого появления таргета. */
export function summarizeJointProjectionTargets(
  runs: JointRunReport[],
): JointTargetSummary[] {
  const slugs = runs
    .map((run) => run.slug)
    .filter((slug, index, all) => all.indexOf(slug) === index);
  return slugs.map((slug) => {
    const targetRuns = runs.filter((run) => run.slug === slug);
    return {
      slug,
      runs: targetRuns.length,
      d: summarizeJointCandidates(targetRuns, 'd'),
      e: summarizeJointCandidates(targetRuns, 'e'),
    };
  });
}

/** Разделяет proposed и фактически сохранённые метрики в каждой строке. */
export function renderJointProjectionMarkdown(
  runs: JointRunReport[],
  errors: RunError[],
  summaries: JointTargetSummary[],
): string {
  const lines = [
    '# Совместная проекция существующих осцилляторов',
    '',
    'Truncated ridge fit — диагностика, а не upper bound: ridge и отсечённые направления могут скрывать оставшийся запас. D ограничивает норму каждой квадратурной пары, E уменьшает RSS после hard clip. Proposed описывает candidate до guard, saved — фактически сохранённый WAV. Отдельный прогон не доказывает путь к 98% или структурный закон T35.',
    '',
    '| Таргет | Сид | Ранг/P | Truncated ridge fit | D proposed ΔG | D saved ΔG | D saved ΔJ | E proposed ΔG | E saved ΔG | E saved ΔJ | D статус | E статус | Секунд |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |',
  ];
  for (const run of runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${run.rank.effectiveRank}/${run.rank.basisColumns} | ${run.unbounded.diagnosticSuppressionPercent.toFixed(2)} | ${run.d.canonicalGlobalDelta.toFixed(3)} | ${run.d.savedGlobalDelta.toFixed(3)} | ${run.d.savedWindowedDelta.toFixed(3)} | ${run.e.canonicalGlobalDelta.toFixed(3)} | ${run.e.savedGlobalDelta.toFixed(3)} | ${run.e.savedWindowedDelta.toFixed(3)} | ${run.d.status} | ${run.e.status} | ${(run.durationMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push(
    '',
    '## Сводка по таргетам',
    '',
    'Saved mean учитывает rejected как нулевой прирост. Proposed mean остаётся отдельной диагностикой всех кандидатов.',
    '',
    '| Таргет | Сиды | D mean saved ΔG | D mean saved ΔJ | D improved | D mean proposed ΔG | E mean saved ΔG | E mean saved ΔJ | E improved | E mean proposed ΔG |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const summary of summaries) {
    lines.push(
      `| ${summary.slug} | ${summary.runs} | ${summary.d.meanSavedGlobalDelta.toFixed(6)} | ${summary.d.meanSavedWindowedDelta.toFixed(6)} | ${summary.d.improved} | ${summary.d.meanProposedGlobalDelta.toFixed(6)} | ${summary.e.meanSavedGlobalDelta.toFixed(6)} | ${summary.e.meanSavedWindowedDelta.toFixed(6)} | ${summary.e.improved} | ${summary.e.meanProposedGlobalDelta.toFixed(6)} |`,
    );
  }
  if (errors.length > 0) {
    lines.push('', '## Ошибки', '');
    for (const error of errors) {
      lines.push(
        `- ${error.slug}/seed-${error.seed}: ${error.message}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

export interface JointProjectionCliArgs {
  dataset: string;
  outDir: string;
  slugs: string[];
  seeds: number[];
}

export interface JointSeedOutcome {
  run: JointRunReport | null;
  error: RunError | null;
}

/** Разбирает фиксированные аргументы; solver не получает HPO-настроек. */
export function parseJointProjectionCliArgs(
  args: string[],
): JointProjectionCliArgs {
  let dataset = '';
  let outDir = '';
  let slugs = ['GrumU'];
  const seeds = [1, 2, 3, 4];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--dataset') {
      dataset = resolve(value);
    } else if (key === '--out') {
      outDir = resolve(value);
    } else if (key === '--slugs') {
      slugs = value.split(',').filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (dataset === '' || outDir === '' || slugs.length === 0) {
    throw new Error(
      'Usage: joint-projection-oracle --dataset DIR --out DIR [--slugs GrumU,BOg-Disco-Futuro]',
    );
  }
  return { dataset, outDir, slugs, seeds };
}

/** Запрещает смешивать запуск со старыми или чужими файлами в out. */
function requireEmptyJointOutput(outDir: string): void {
  if (!existsSync(outDir)) {
    return;
  }
  if (!statSync(outDir).isDirectory()) {
    throw new Error('--out должен быть каталогом');
  }
  if (readdirSync(outDir).length > 0) {
    throw new Error(
      '--out должен быть пустым; выберите новый каталог вместо повторного использования',
    );
  }
}

/** Выполняет running/completed/skipped/error checkpoint-протокол одного сида. */
export async function processJointSeed(arg: {
  dataset: string;
  slug: string;
  seed: number;
  targetsDir: string;
  phaseModel: PhaseModel;
  outDir: string;
}): Promise<JointSeedOutcome> {
  const { slug, seed } = arg;
  const outRunDir = join(arg.outDir, slug, `seed-${seed}`);
  mkdirSync(outRunDir, { recursive: true });
  await writeJsonAtomic(join(outRunDir, 'checkpoint.json'), {
    status: 'running',
    slug,
    seed,
    startedAt: new Date().toISOString(),
  });
  try {
    const run = await processRun(arg);
    if (run === null) {
      await writeJsonAtomic(join(outRunDir, 'checkpoint.json'), {
        status: 'skipped',
        reason: 'missing or not completed',
        slug,
        seed,
      });
      console.log(
        `SKIP ${slug}/seed-${seed}: missing or not completed`,
      );
      return { run: null, error: null };
    }
    await writeJsonAtomic(join(outRunDir, 'checkpoint.json'), {
      status: 'completed',
      slug,
      seed,
      completedAt: new Date().toISOString(),
      currentGlobal: run.current.globalSuppressionPercent,
      dProposedGlobalDelta: run.d.canonicalGlobalDelta,
      dSavedGlobalDelta: run.d.savedGlobalDelta,
      eProposedGlobalDelta: run.e.canonicalGlobalDelta,
      eSavedGlobalDelta: run.e.savedGlobalDelta,
    });
    console.log(
      `RESULT ${slug} seed=${seed} rank=${run.rank.effectiveRank}/${run.rank.basisColumns} ` +
        `ridge=${run.unbounded.diagnosticSuppressionPercent.toFixed(2)} ` +
        `Dproposed=${run.d.canonicalGlobalDelta.toFixed(3)} ` +
        `Dsaved=${run.d.savedGlobalDelta.toFixed(3)} ` +
        `Eproposed=${run.e.canonicalGlobalDelta.toFixed(3)} ` +
        `Esaved=${run.e.savedGlobalDelta.toFixed(3)} ` +
        `E-Dsaved=${(run.e.savedGlobalDelta - run.d.savedGlobalDelta).toFixed(3)} ` +
        `seconds=${(run.durationMs / 1000).toFixed(1)}`,
    );
    return { run, error: null };
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : String(caught);
    const error = { slug, seed, message };
    await writeJsonAtomic(join(outRunDir, 'error.json'), error);
    await writeJsonAtomic(join(outRunDir, 'checkpoint.json'), {
      status: 'error',
      ...error,
      failedAt: new Date().toISOString(),
    });
    console.warn(`WARN ${slug}/seed-${seed}: ${message}`);
    return { run: null, error };
  }
}

/** Фиксирует HEAD и полный численный конфиг рядом с run/error report. */
function currentCodeRevision(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: resolve(__dirname, '../..'),
    encoding: 'utf8',
  }).trim();
}

/** Атомарно пишет оба общих отчёта после обработки всех сидов. */
async function writeJointProjectionReports(arg: {
  dataset: string;
  outDir: string;
  phaseModel: PhaseModel;
  attackBoost: number;
  runs: JointRunReport[];
  summaries: JointTargetSummary[];
  errors: RunError[];
}): Promise<void> {
  mkdirSync(arg.outDir, { recursive: true });
  await writeJsonAtomic(join(arg.outDir, 'report.json'), {
    version: 2,
    createdAt: new Date().toISOString(),
    codeRevision: currentCodeRevision(),
    dataset: arg.dataset,
    phaseModel: arg.phaseModel,
    attackBoost: arg.attackBoost,
    outputPolicy: 'require-empty-out',
    ridgeLambdas: JOINT_RIDGE_LAMBDAS,
    config: JOINT_PROJECTION_CONFIG,
    runs: arg.runs,
    summaries: arg.summaries,
    errors: arg.errors,
    limitations: [
      'Truncated ridge fit не является patch или upper bound; отсечённые направления могут скрывать запас.',
      'Truncated ridge и projected gradient не доказывают глобальный минимум.',
      'D и E меняют только startLevel/phase существующих активных слотов.',
      'Oracle не доказывает путь к 98% и не проверяет закон T35.',
    ],
  });
  await writeTextAtomic(
    join(arg.outDir, 'report.md'),
    renderJointProjectionMarkdown(
      arg.runs,
      arg.errors,
      arg.summaries,
    ),
  );
}

/** Запускает CLI и возвращает exit code, всегда восстанавливая attackBoost. */
export async function runJointProjectionCli(
  args: string[],
): Promise<number> {
  const parsed = parseJointProjectionCliArgs(args);
  requireEmptyJointOutput(parsed.outDir);
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(parsed.dataset, 'manifest.json'),
  );
  if (manifest === null) {
    throw new Error(
      `Нет или повреждён manifest.json в ${parsed.dataset}`,
    );
  }
  return withAttackBoost(manifest.attackBoost ?? 1, async () => {
    const phaseModel = manifest.phaseModel ?? 'legacy';
    const runs: JointRunReport[] = [];
    const errors: RunError[] = [];
    for (const slug of parsed.slugs) {
      for (const seed of parsed.seeds) {
        const outcome = await processJointSeed({
          dataset: parsed.dataset,
          slug,
          seed,
          targetsDir: manifest.targetsDir,
          phaseModel,
          outDir: parsed.outDir,
        });
        if (outcome.run !== null) {
          runs.push(outcome.run);
        }
        if (outcome.error !== null) {
          errors.push(outcome.error);
        }
      }
    }
    const summaries = summarizeJointProjectionTargets(runs);
    await writeJointProjectionReports({
      dataset: parsed.dataset,
      outDir: parsed.outDir,
      phaseModel,
      attackBoost: manifest.attackBoost ?? 1,
      runs,
      summaries,
      errors,
    });
    console.log(
      `REPORT runs=${runs.length} errors=${errors.length} out=${parsed.outDir}`,
    );
    return errors.length > 0 ? 1 : 0;
  });
}

/** Тонкая точка входа: весь протокол живёт в runJointProjectionCli. */
async function main(): Promise<void> {
  process.exitCode = await runJointProjectionCli(
    process.argv.slice(2),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
