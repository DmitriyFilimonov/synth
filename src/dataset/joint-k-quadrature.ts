/**
 * Обобщённый fixed-offset solver совместных квадратур для synthetic T38.
 *
 * На каждый атом приходят ровно два базисных столбца; target остаётся
 * непрерывным и нормированным. Каждый принятый шаг оценивается по quantized
 * PCM полной суммы `fixedOffset + basis * coefficients` после production hard
 * clip. Старые K1/K2, exponential active-set и квантование target не
 * используются. Модуль решает только численную задачу и не запускает beam/CD.
 */
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../consts';
import { ampEnvConfigNormales } from '../synth';
import { quantizeRaw, type QuadratureFit } from './quadrature-refit';
import {
  addStructuralDenseWork,
  addStructuralSampleWork,
  createStructuralWorkLedger,
  snapshotStructuralWork,
  type StructuralDenseWork,
  type StructuralSampleWork,
  type StructuralWorkLedger,
} from './structural-work';

/** Вход одного совместного решения с K>=1 и не более чем 50 атомами. */
export interface JointKQuadratureInput {
  /** Ровно 2K столбцов в порядке `[sine0, cosine0, ...]`. */
  basis: readonly ArrayLike<number>[];
  /** Continuous normalized target, который никогда не становится Int16. */
  target: ArrayLike<number>;
  /** Сырой нормированный вклад всех атомов вне этого решения. */
  fixedOffset?: ArrayLike<number>;
  initialCoefficients: ArrayLike<number>;
  /** Максимум попыток построить нормальные уравнения по clip-маске. */
  maxInner?: number;
  /** Число отклонённых делений шага пополам после первой пробы итерации. */
  maxBacktracks?: number;
  /** Независимый предел Jacobi-sweeps; 0 запрещает sweeps. */
  maxJacobiSweeps?: number;
  /** Общий ledger, уже содержащий работу renderStructuralBasis. */
  work?: StructuralWorkLedger;
}

/** Столбец выпадает, когда его численная норма на маске равна нулю. */
export interface JointKDroppedColumn {
  column: number;
  atom: number;
  kind: 'sine' | 'cosine';
  norm: number;
}

/** Ранг и обусловленность нормированной masked-матрицы Грама. */
export interface JointKRankDiagnostics {
  atomCount: number;
  basisColumns: number;
  effectiveRank: number;
  rankDeficiency: number;
  cutoff: number;
  condition: number | null;
  retainedCondition: number | null;
  eigenvalueMin: number;
  eigenvalueMax: number;
  retainedEigenvalueMin: number | null;
  retainedEigenvalueMax: number | null;
  eigenvalues: number[];
  droppedColumns: JointKDroppedColumn[];
  jacobiSweeps: number;
  jacobiConverged: boolean;
}

/** Прежние детальные счётчики без утверждения, что их сумма равна W. */
export interface JointKDetailedCounters {
  normalEquationBuilds: number;
  normEvaluations: number;
  gramDotProducts: number;
  gramSampleEvaluations: number;
  eigenDecompositions: number;
  pseudoInverseSolves: number;
  objectiveEvaluations: number;
  objectiveSampleEvaluations: number;
  maskRecomputations: number;
  maskChanges: number;
  acceptedIterations: number;
  backtracks: number;
  boundaryProjections: number;
}

/** Полный N-pass ledger и отдельные dense/Jacobi-счётчики. */
export type JointKWorkCounters = JointKDetailedCounters & {
  sampleWork: StructuralSampleWork;
  denseWork: StructuralDenseWork;
};

/** Один принятый шаг спуска по quantized PCM. */
export interface JointKIteration {
  iteration: number;
  rssBefore: number;
  rssAfter: number;
  backtracks: number;
  saturatedBefore: number;
  saturatedAfter: number;
  maskChanges: number;
  rank: number;
}

/** Результат в лучшем состоянии, принятом монотонным PCM-спуском. */
export interface JointKQuadratureResult {
  /** Canonical native-коэффициенты, восстановленные из возвращаемых fits. */
  coefficients: number[];
  fits: QuadratureFit[];
  /** Последнее решение truncated pseudo-inverse до радиальной проекции. */
  minimumNormCoefficients: number[] | null;
  raw: Float64Array;
  samples: Int16Array;
  /** RSS в нормированных единицах: `(sample / 32767 - continuousTarget)^2`. */
  quantizedPcmRss: number;
  initialQuantizedPcmRss: number;
  rawRss: number;
  saturatedSamples: number;
  /** Диагностика последних построенных уравнений; null, если их не было. */
  diagnostics: JointKRankDiagnostics | null;
  stopReason:
    | 'converged'
    | 'stationary'
    | 'zero-rank'
    | 'quantized-plateau'
    | 'iteration-limit'
    | 'backtrack-limit'
    | 'eigen-limit';
  history: JointKIteration[];
  work: JointKWorkCounters;
}

interface EigenDecomposition {
  values: Float64Array;
  vectors: Float64Array;
  sweeps: number;
  converged: boolean;
}

interface RankAnalysis {
  diagnostics: JointKRankDiagnostics;
  eigenvalues: Float64Array;
  eigenvectors: Float64Array;
  retainedEigenvectors: number[];
}

interface NormalEquations {
  gram: Float64Array;
  rhs: Float64Array;
  norms: Float64Array;
  rank: RankAnalysis;
}

interface InnerState {
  coefficients: number[];
  fits: QuadratureFit[];
  raw: Float64Array;
  samples: Int16Array;
  mask: Uint8Array;
  quantizedPcmRss: number;
  rawRss: number;
  continuousClippedRss: number;
  saturatedSamples: number;
}

interface CanonicalPairs {
  coefficients: number[];
  fits: QuadratureFit[];
  boundaryProjections: number;
}

interface JointStepProposal {
  desired: CanonicalPairs;
  minimumNormCoefficients: number[];
  stationary: boolean;
}

interface QuantizedBacktrackResult {
  state: InnerState;
  accepted: boolean;
  rejectionStop: 'quantized-plateau' | 'backtrack-limit' | null;
}

interface SolverContext {
  basis: Float64Array[];
  target: Float64Array;
  residualTarget: Float64Array;
  fixedOffset: Float64Array;
  maxInner: number;
  maxBacktracks: number;
  maxJacobiSweeps: number;
  work: JointKDetailedCounters;
  ledger: StructuralWorkLedger;
}

const MIN_LEVEL = ampEnvConfigNormales.startLevel.min;
const MAX_LEVEL = ampEnvConfigNormales.startLevel.max;
const TWO_PI = 2 * Math.PI;
const NORM_RELATIVE_CUTOFF = 1e-12;
const NORM_ABSOLUTE_CUTOFF = 1e-15;
const RANK_RELATIVE_CUTOFF = 1e-10;
const RANK_ABSOLUTE_CUTOFF = 1e-12;
const FIT_BOUNDARY_TOLERANCE = 4 * Number.EPSILON;
const MAX_JACOBI_SWEEPS = 100;

/** Пределы работы по умолчанию; solver не смотрит на часы. */
export const DEFAULT_JOINT_K_QUADRATURE_OPTIONS = {
  maxInner: 12,
  maxBacktracks: 16,
  maxJacobiSweeps: MAX_JACOBI_SWEEPS,
} as const;

/** Создаёт нулевые детерминированные счётчики одного решения. */
function emptyWork(): JointKDetailedCounters {
  return {
    normalEquationBuilds: 0,
    normEvaluations: 0,
    gramDotProducts: 0,
    gramSampleEvaluations: 0,
    eigenDecompositions: 0,
    pseudoInverseSolves: 0,
    objectiveEvaluations: 0,
    objectiveSampleEvaluations: 0,
    maskRecomputations: 0,
    maskChanges: 0,
    acceptedIterations: 0,
    backtracks: 0,
    boundaryProjections: 0,
  };
}

/** Копирует вектор нужной длины и отклоняет нечисловые значения. */
function finiteVector(
  input: ArrayLike<number>,
  length: number,
  name: string,
  sampleLedger?: StructuralWorkLedger,
): Float64Array {
  if (input.length !== length) {
    throw new Error(`${name} has an inconsistent length`);
  }
  const output = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const value = input[index] ?? 0;
    if (!Number.isFinite(value)) {
      throw new Error(`${name} contains a non-finite value`);
    }
    output[index] = value;
  }
  if (sampleLedger !== undefined) {
    addStructuralSampleWork(sampleLedger, 'validation', length);
  }
  return output;
}

/** Проверяет размеры и создаёт собственные массивы без квантования target. */
function prepareContext(arg: JointKQuadratureInput): {
  context: SolverContext;
  initialCoefficients: Float64Array;
} {
  const atomCount = arg.basis.length / 2;
  const maxInner =
    arg.maxInner ?? DEFAULT_JOINT_K_QUADRATURE_OPTIONS.maxInner;
  const maxBacktracks =
    arg.maxBacktracks ??
    DEFAULT_JOINT_K_QUADRATURE_OPTIONS.maxBacktracks;
  const maxJacobiSweeps =
    arg.maxJacobiSweeps ??
    DEFAULT_JOINT_K_QUADRATURE_OPTIONS.maxJacobiSweeps;
  if (
    !Number.isInteger(atomCount) ||
    atomCount < 1 ||
    atomCount > 50 ||
    arg.target.length < 1 ||
    !Number.isSafeInteger(maxInner) ||
    maxInner < 0 ||
    !Number.isSafeInteger(maxBacktracks) ||
    maxBacktracks < 0 ||
    !Number.isSafeInteger(maxJacobiSweeps) ||
    maxJacobiSweeps < 0
  ) {
    throw new Error('Invalid joint-K dimensions or work limits');
  }
  const sampleCount = arg.target.length;
  const ledger = arg.work ?? createStructuralWorkLedger();
  const target = finiteVector(
    arg.target,
    sampleCount,
    'target',
    ledger,
  );
  const fixedOffset = finiteVector(
    arg.fixedOffset ?? new Float64Array(sampleCount),
    sampleCount,
    'fixedOffset',
    ledger,
  );
  const basis = arg.basis.map((column) =>
    finiteVector(column, sampleCount, 'basis column', ledger),
  );
  const initialCoefficients = finiteVector(
    arg.initialCoefficients,
    arg.basis.length,
    'initialCoefficients',
  );
  for (let atom = 0; atom < atomCount; atom += 1) {
    const sine = basis[atom * 2] ?? new Float64Array();
    const cosine = basis[atom * 2 + 1] ?? new Float64Array();
    let supported = false;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      if ((sine[sample] ?? 0) !== 0 || (cosine[sample] ?? 0) !== 0) {
        supported = true;
      }
    }
    addStructuralSampleWork(ledger, 'validation', sampleCount);
    if (!supported) {
      throw new Error(`Zero-support structural atom ${atom}`);
    }
  }
  // Это вычитание задаёт raw и каждую masked правую часть.
  const residualTarget = Float64Array.from(
    target,
    (value, index) => value - (fixedOffset[index] ?? 0),
  );
  addStructuralSampleWork(ledger, 'validation', sampleCount);
  return {
    context: {
      basis,
      target,
      residualTarget,
      fixedOffset,
      maxInner,
      maxBacktracks,
      maxJacobiSweeps,
      work: emptyWork(),
      ledger,
    },
    initialCoefficients,
  };
}

/** Устойчивая Euclidean-норма по отсчётам вне текущего clipping. */
function maskedNorm(
  values: ArrayLike<number>,
  mask: Uint8Array,
  context: SolverContext,
): number {
  let scale = 0;
  let scaledSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    if ((mask[index] ?? 0) === 1) {
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
  context.work.normEvaluations += 1;
  context.work.gramSampleEvaluations += values.length;
  addStructuralSampleWork(context.ledger, 'gram', values.length);
  const norm = scale === 0 ? 0 : scale * Math.sqrt(scaledSquares);
  if (!Number.isFinite(norm)) {
    throw new Error('Non-finite joint-K column norm');
  }
  return norm;
}

/** Скалярное произведение по маске нормированной матрицы Грама. */
function maskedDot(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  mask: Uint8Array,
  context: SolverContext,
): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    if ((mask[index] ?? 0) === 0) {
      sum += (a[index] ?? 0) * (b[index] ?? 0);
    }
  }
  context.work.gramDotProducts += 1;
  context.work.gramSampleEvaluations += a.length;
  addStructuralSampleWork(context.ledger, 'gram', a.length);
  if (!Number.isFinite(sum)) {
    throw new Error('Non-finite joint-K dot product');
  }
  return sum;
}

/** Циклический Jacobi для симметричной P×P матрицы Грама, P<=100. */
function jacobiEigen(
  input: Float64Array,
  size: number,
  context: SolverContext,
): EigenDecomposition {
  const matrix = new Float64Array(input);
  const vectors = new Float64Array(size * size);
  for (let index = 0; index < size; index += 1) {
    vectors[index * size + index] = 1;
  }
  addStructuralDenseWork(
    context.ledger,
    'jacobiMatrixEntries',
    size * size + size,
  );
  let sweeps = 0;
  let converged = size <= 1;
  for (
    let sweep = 0;
    sweep < context.maxJacobiSweeps && !converged;
    sweep += 1
  ) {
    sweeps += 1;
    let largestOffDiagonal = 0;
    for (let row = 0; row < size; row += 1) {
      for (let column = row + 1; column < size; column += 1) {
        addStructuralDenseWork(
          context.ledger,
          'jacobiOffDiagonalScans',
          1,
        );
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
        addStructuralDenseWork(context.ledger, 'jacobiRotations', 1);
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
        addStructuralDenseWork(
          context.ledger,
          'jacobiRotationElementUpdates',
          6 * size - 4,
        );
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
  addStructuralDenseWork(
    context.ledger,
    'jacobiMatrixEntries',
    size * size + 2 * size,
  );
  return { values, vectors: sortedVectors, sweeps, converged };
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

/** Измеряет ранг и выбирает направления для truncated inverse. */
function analyzeRank(
  gram: Float64Array,
  size: number,
  droppedColumns: JointKDroppedColumn[],
  context: SolverContext,
): RankAnalysis {
  context.work.eigenDecompositions += 1;
  const eigen = jacobiEigen(gram, size, context);
  const eigenvalueMax = Math.max(0, eigen.values[0] ?? 0);
  const cutoff = Math.max(
    RANK_ABSOLUTE_CUTOFF,
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
  const positiveMin = positiveEigenvalues.length
    ? Math.min(...positiveEigenvalues)
    : 0;
  const diagnostics: JointKRankDiagnostics = {
    atomCount: size / 2,
    basisColumns: size,
    effectiveRank: retainedEigenvectors.length,
    rankDeficiency: size - retainedEigenvectors.length,
    cutoff,
    condition: finiteRatio(eigenvalueMax, positiveMin),
    retainedCondition:
      retainedValues.length > 0
        ? finiteRatio(
            Math.max(...retainedValues),
            Math.min(...retainedValues),
          )
        : null,
    eigenvalueMin:
      eigen.values.length > 0
        ? (eigen.values[eigen.values.length - 1] ?? 0)
        : 0,
    eigenvalueMax,
    retainedEigenvalueMin:
      retainedValues.length > 0 ? Math.min(...retainedValues) : null,
    retainedEigenvalueMax:
      retainedValues.length > 0 ? Math.max(...retainedValues) : null,
    eigenvalues: Array.from(eigen.values),
    droppedColumns,
    jacobiSweeps: eigen.sweeps,
    jacobiConverged: eigen.converged,
  };
  if (
    diagnostics.eigenvalues.some(
      (value) => !Number.isFinite(value),
    ) ||
    !Number.isFinite(diagnostics.condition ?? 0) ||
    !Number.isFinite(diagnostics.retainedCondition ?? 0)
  ) {
    throw new Error('Non-finite joint-K rank diagnostics');
  }
  return {
    diagnostics,
    eigenvalues: eigen.values,
    eigenvectors: eigen.vectors,
    retainedEigenvectors,
  };
}

/**
 * Строит normalized masked normal equations явно по `target - fixedOffset`.
 * Offset никогда не превращается во второй target PCM.
 */
function buildNormalEquations(
  mask: Uint8Array,
  context: SolverContext,
): NormalEquations {
  context.work.normalEquationBuilds += 1;
  const size = context.basis.length;
  const rawNorms = context.basis.map((column) =>
    maskedNorm(column, mask, context),
  );
  const maxNorm = Math.max(0, ...rawNorms);
  const norms = new Float64Array(size);
  const droppedColumns: JointKDroppedColumn[] = [];
  for (let column = 0; column < size; column += 1) {
    const norm = rawNorms[column] ?? 0;
    if (
      norm > NORM_RELATIVE_CUTOFF * maxNorm &&
      norm > NORM_ABSOLUTE_CUTOFF
    ) {
      norms[column] = norm;
    } else {
      droppedColumns.push({
        column,
        atom: Math.floor(column / 2),
        kind: column % 2 === 0 ? 'sine' : 'cosine',
        norm,
      });
    }
  }
  const gram = new Float64Array(size * size);
  const rhs = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    const rowNorm = norms[row] ?? 0;
    const rowBasis = context.basis[row] ?? new Float64Array();
    if (rowNorm > 0) {
      rhs[row] =
        maskedDot(rowBasis, context.residualTarget, mask, context) /
        rowNorm;
    }
    for (let column = row; column < size; column += 1) {
      const columnNorm = norms[column] ?? 0;
      const value =
        rowNorm > 0 && columnNorm > 0
          ? maskedDot(
              rowBasis,
              context.basis[column] ?? new Float64Array(),
              mask,
              context,
            ) /
            (rowNorm * columnNorm)
          : 0;
      gram[row * size + column] = value;
      gram[column * size + row] = value;
    }
  }
  addStructuralDenseWork(
    context.ledger,
    'gramCellUpdates',
    size * (size + 1),
  );
  const rank = analyzeRank(gram, size, droppedColumns, context);
  return { gram, rhs, norms, rank };
}

/** Минимальнормативный truncated pseudo-inverse в normalized-координатах. */
function unconstrainedCoefficients(
  equations: NormalEquations,
  context: SolverContext,
): number[] {
  context.work.pseudoInverseSolves += 1;
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
        (equations.rhs[row] ?? 0);
    }
    const scale = projection / eigenvalue;
    for (let row = 0; row < size; row += 1) {
      normalized[row] =
        (normalized[row] ?? 0) +
        (equations.rank.eigenvectors[row * size + eigenvector] ?? 0) *
          scale;
    }
    addStructuralDenseWork(
      context.ledger,
      'pseudoInverseEntries',
      2 * size,
    );
  }
  addStructuralDenseWork(
    context.ledger,
    'pseudoInverseEntries',
    size,
  );
  return Array.from(normalized, (value, index) => {
    const norm = equations.norms[index] ?? 0;
    return norm > 0 ? value / norm : 0;
  });
}

/** Переводит projected-пару в fit и исправляет только ulp-выход уровня. */
function fitFromProjectedPair(
  sineCoefficient: number,
  cosineCoefficient: number,
  boundaryLevel: number | null,
): QuadratureFit {
  const fittedLevel = Math.hypot(sineCoefficient, cosineCoefficient);
  if (
    !Number.isFinite(fittedLevel) ||
    fittedLevel < MIN_LEVEL - FIT_BOUNDARY_TOLERANCE ||
    fittedLevel > MAX_LEVEL + FIT_BOUNDARY_TOLERANCE
  ) {
    throw new Error('Infeasible joint-K quadrature pair');
  }
  const startLevel =
    boundaryLevel ??
    (fittedLevel < MIN_LEVEL
      ? MIN_LEVEL
      : fittedLevel > MAX_LEVEL
        ? MAX_LEVEL
        : fittedLevel);
  const phase =
    ((Math.atan2(cosineCoefficient, sineCoefficient) % TWO_PI) +
      TWO_PI) %
    TWO_PI;
  return {
    sineCoefficient: startLevel * Math.cos(phase),
    cosineCoefficient: startLevel * Math.sin(phase),
    startLevel,
    phase,
  };
}

/** Проецирует пары по радиусу и возвращает согласованные fit/коэффициенты. */
function canonicalPairs(
  coefficients: ArrayLike<number>,
  fallback: ArrayLike<number>,
): CanonicalPairs {
  if (
    coefficients.length !== fallback.length ||
    coefficients.length % 2 !== 0
  ) {
    throw new Error('Joint-K radial dimensions disagree');
  }
  const canonical: number[] = [];
  const fits: QuadratureFit[] = [];
  let boundaryProjections = 0;
  for (let offset = 0; offset < coefficients.length; offset += 2) {
    let sine = coefficients[offset] ?? 0;
    let cosine = coefficients[offset + 1] ?? 0;
    let norm = Math.hypot(sine, cosine);
    let boundaryLevel: number | null = null;
    if (!Number.isFinite(norm)) {
      throw new Error('Non-finite joint-K quadrature pair');
    }
    if (norm < MIN_LEVEL || norm > MAX_LEVEL) {
      boundaryProjections += 1;
      // Сохраняем границу исходной нормы до выбора направления нулевого
      // вектора: fallback меняет только фазу, но не превращает 0 в MAX_LEVEL.
      boundaryLevel = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, norm));
      if (!(norm > 1e-15)) {
        const fallbackSine = fallback[offset] ?? 0;
        const fallbackCosine = fallback[offset + 1] ?? 0;
        const fallbackNorm = Math.hypot(fallbackSine, fallbackCosine);
        if (Number.isFinite(fallbackNorm) && fallbackNorm > 1e-15) {
          sine = fallbackSine / fallbackNorm;
          cosine = fallbackCosine / fallbackNorm;
        } else {
          sine = 1;
          cosine = 0;
        }
        norm = 1;
      }
      sine = (sine / norm) * boundaryLevel;
      cosine = (cosine / norm) * boundaryLevel;
    }
    const fit = fitFromProjectedPair(sine, cosine, boundaryLevel);
    fits.push(fit);
    canonical.push(fit.sineCoefficient, fit.cosineCoefficient);
  }
  return { coefficients: canonical, fits, boundaryProjections };
}

/** Строит один bounded proposal, не меняя текущее состояние или clip-маску. */
function proposeJointStep(
  equations: NormalEquations,
  state: InnerState,
  context: SolverContext,
): JointStepProposal {
  const desiredRaw = unconstrainedCoefficients(equations, context);
  for (let atom = 0; atom < context.basis.length / 2; atom += 1) {
    if (
      (equations.norms[atom * 2] ?? 0) === 0 &&
      (equations.norms[atom * 2 + 1] ?? 0) === 0
    ) {
      desiredRaw[atom * 2] = state.coefficients[atom * 2] ?? 0;
      desiredRaw[atom * 2 + 1] =
        state.coefficients[atom * 2 + 1] ?? 0;
    }
  }
  const desired = canonicalPairs(desiredRaw, state.coefficients);
  context.work.boundaryProjections += desired.boundaryProjections;
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
    throw new Error('Non-finite joint-K descent direction');
  }
  return {
    desired,
    minimumNormCoefficients: desiredRaw,
    stationary: directionNorm <= 1e-28,
  };
}

/** Считает отсчёты, которые сменили принадлежность hard-clip маске. */
function countMaskChanges(
  a: Uint8Array,
  b: Uint8Array,
  context: SolverContext,
): number {
  let changes = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      changes += 1;
    }
  }
  addStructuralSampleWork(context.ledger, 'mask', a.length);
  return changes;
}

/** Оценивает полную сумму offset+атомы, production clip и Int16 PCM. */
function evaluateCoefficients(
  canonical: CanonicalPairs,
  context: SolverContext,
): InnerState {
  const sampleCount = context.target.length;
  const raw = new Float64Array(sampleCount);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    let value = context.fixedOffset[sample] ?? 0;
    for (let column = 0; column < context.basis.length; column += 1) {
      value +=
        (canonical.coefficients[column] ?? 0) *
        (context.basis[column]?.[sample] ?? 0);
    }
    if (!Number.isFinite(value)) {
      throw new Error('Non-finite joint-K candidate');
    }
    raw[sample] = value;
  }
  addStructuralSampleWork(context.ledger, 'offset', sampleCount);
  addStructuralSampleWork(
    context.ledger,
    'mixing',
    sampleCount,
    context.basis.length,
  );
  const samples = quantizeRaw(raw);
  addStructuralSampleWork(context.ledger, 'quantize', sampleCount);
  const mask = new Uint8Array(sampleCount);
  let quantizedPcmRss = 0;
  let rawRss = 0;
  let continuousClippedRss = 0;
  let saturatedSamples = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = raw[sample] ?? 0;
    const saturated = value <= -1 || value >= 1;
    mask[sample] = saturated ? 1 : 0;
    if (saturated) {
      saturatedSamples += 1;
    }
    const target = context.target[sample] ?? 0;
    const rawResidual = target - value;
    rawRss += rawResidual * rawResidual;
    const clipped = Math.max(-1, Math.min(1, value));
    const clippedResidual = target - clipped;
    continuousClippedRss += clippedResidual * clippedResidual;
    // Target остаётся непрерывным. Только candidate квантуется один раз на
    // пробу, а его фактическое Int16-значение определяет принятие шага.
    const pcmResidual =
      (samples[sample] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      target;
    quantizedPcmRss += pcmResidual * pcmResidual;
  }
  addStructuralSampleWork(context.ledger, 'metric', sampleCount);
  addStructuralSampleWork(context.ledger, 'mask', sampleCount);
  if (
    !Number.isFinite(quantizedPcmRss) ||
    !Number.isFinite(rawRss) ||
    !Number.isFinite(continuousClippedRss)
  ) {
    throw new Error('Non-finite joint-K objective');
  }
  context.work.objectiveEvaluations += 1;
  context.work.objectiveSampleEvaluations += sampleCount;
  context.work.maskRecomputations += 1;
  return {
    coefficients: canonical.coefficients,
    fits: canonical.fits,
    raw,
    samples,
    mask,
    quantizedPcmRss,
    rawRss,
    continuousClippedRss,
    saturatedSamples,
  };
}

/** Проверяет proposal по полному quantized PCM и принимает строгое улучшение. */
function backtrackQuantizedStep(arg: {
  state: InnerState;
  desired: CanonicalPairs;
  rank: number;
  history: JointKIteration[];
  context: SolverContext;
}): QuantizedBacktrackResult {
  const { state, desired, rank, history, context } = arg;
  let sawPcmPlateau = false;
  let sawContinuousDecrease = false;
  for (
    let backtrack = 0;
    backtrack <= context.maxBacktracks;
    backtrack += 1
  ) {
    const step = 1 / 2 ** backtrack;
    const interpolated = state.coefficients.map(
      (value, column) =>
        value +
        step * ((desired.coefficients[column] ?? value) - value),
    );
    // Полный шаг берёт сам desired fit: `a + (b - a)` способно сдвинуть
    // точную радиальную границу на один ulp. Дробные шаги по-прежнему
    // получают собственную радиальную проекцию.
    const projected =
      backtrack === 0
        ? desired
        : canonicalPairs(interpolated, state.coefficients);
    if (backtrack > 0) {
      context.work.boundaryProjections +=
        projected.boundaryProjections;
    }
    const candidate = evaluateCoefficients(projected, context);
    sawPcmPlateau ||=
      candidate.quantizedPcmRss === state.quantizedPcmRss;
    sawContinuousDecrease ||=
      candidate.continuousClippedRss < state.continuousClippedRss;
    if (candidate.quantizedPcmRss < state.quantizedPcmRss) {
      const maskChanges = countMaskChanges(
        state.mask,
        candidate.mask,
        context,
      );
      history.push({
        iteration: history.length + 1,
        rssBefore: state.quantizedPcmRss,
        rssAfter: candidate.quantizedPcmRss,
        backtracks: backtrack,
        saturatedBefore: state.saturatedSamples,
        saturatedAfter: candidate.saturatedSamples,
        maskChanges,
        rank,
      });
      context.work.acceptedIterations += 1;
      context.work.maskChanges += maskChanges;
      return {
        state: candidate,
        accepted: true,
        rejectionStop: null,
      };
    }
    context.work.backtracks += 1;
  }
  return {
    state,
    accepted: false,
    rejectionStop:
      sawPcmPlateau || sawContinuousDecrease
        ? 'quantized-plateau'
        : 'backtrack-limit',
  };
}

/** Собирает итог без нового рендера или повторного квантования target. */
function resultFromState(
  state: InnerState,
  initialQuantizedPcmRss: number,
  minimumNormCoefficients: number[] | null,
  diagnostics: JointKRankDiagnostics | null,
  stopReason: JointKQuadratureResult['stopReason'],
  history: JointKIteration[],
  work: JointKDetailedCounters,
  ledger: StructuralWorkLedger,
): JointKQuadratureResult {
  return {
    coefficients: [...state.coefficients],
    fits: state.fits.map((fit) => ({ ...fit })),
    minimumNormCoefficients:
      minimumNormCoefficients === null
        ? null
        : [...minimumNormCoefficients],
    // Внутренние массивы после завершения больше не меняются; передаём их
    // без скрытых N-pass копий вне work ledger.
    raw: state.raw,
    samples: state.samples,
    quantizedPcmRss: state.quantizedPcmRss,
    initialQuantizedPcmRss,
    rawRss: state.rawRss,
    saturatedSamples: state.saturatedSamples,
    diagnostics,
    stopReason,
    history,
    work: { ...work, ...snapshotStructuralWork(ledger) },
  };
}

/**
 * Совместно подгоняет K квадратур с радиальными уровнями 0.001..1.
 *
 * @param arg - Ровно 2K базисных столбцов, continuous normalized target,
 *   raw fixed offset, начальные коэффициенты и пределы работы
 * @returns Лучшее quantized-PCM состояние монотонного backtracking,
 *   минимальнормативное truncated-решение, ранг и точные счётчики
 * @throws Error при неверных или нечисловых размерах, нечётном числе столбцов,
 *   более чем 50 атомах либо нулевой поддержке обеих колонок любого атома
 * @remarks Начальные коэффициенты при необходимости проецируются по радиусу.
 * Если атом теряет поддержку только на текущей clip-маске, solver сохраняет
 * его текущую пару вместо вымышленного fit 0.001. При частичной потере ранга
 * используются все retained eigenvectors без ridge. Каждая проба включает
 * полный fixed offset до hard clip и квантования. `diagnostics` описывает
 * последние действительно построенные уравнения; при maxInner=0 он равен null.
 * `work.sampleWork.total` суммирует все учтённые N-pass категории, а dense
 * P×P/Jacobi работа остаётся отдельно в `work.denseWork`.
 */
export function solveJointKQuadrature(
  arg: JointKQuadratureInput,
): JointKQuadratureResult {
  const { context, initialCoefficients } = prepareContext(arg);
  const initialCanonical = canonicalPairs(
    initialCoefficients,
    initialCoefficients,
  );
  context.work.boundaryProjections +=
    initialCanonical.boundaryProjections;
  let state = evaluateCoefficients(initialCanonical, context);
  const initialQuantizedPcmRss = state.quantizedPcmRss;
  let diagnostics: JointKRankDiagnostics | null = null;
  let minimumNormCoefficients: number[] | null = null;
  const history: JointKIteration[] = [];
  let stopReason: JointKQuadratureResult['stopReason'] =
    'iteration-limit';

  if (state.quantizedPcmRss === 0) {
    stopReason = 'converged';
  } else {
    for (let attempt = 0; attempt < context.maxInner; attempt += 1) {
      // Каждый build принадлежит реальной ограниченной попытке. После
      // accepted с исчерпанным maxInner новый Gram не нужен для завершения.
      const equations = buildNormalEquations(state.mask, context);
      diagnostics = equations.rank.diagnostics;
      if (!diagnostics.jacobiConverged) {
        stopReason = 'eigen-limit';
        break;
      }
      if (diagnostics.effectiveRank === 0) {
        stopReason = 'zero-rank';
        break;
      }
      const proposal = proposeJointStep(equations, state, context);
      minimumNormCoefficients = proposal.minimumNormCoefficients;
      if (proposal.stationary) {
        stopReason = 'stationary';
        break;
      }
      const backtracked = backtrackQuantizedStep({
        state,
        desired: proposal.desired,
        rank: diagnostics.effectiveRank,
        history,
        context,
      });
      state = backtracked.state;
      if (!backtracked.accepted) {
        stopReason = backtracked.rejectionStop ?? 'backtrack-limit';
        break;
      }
      if (state.quantizedPcmRss === 0) {
        stopReason = 'converged';
        break;
      }
    }
  }

  return resultFromState(
    state,
    initialQuantizedPcmRss,
    minimumNormCoefficients,
    diagnostics,
    stopReason,
    history,
    context.work,
    context.ledger,
  );
}
