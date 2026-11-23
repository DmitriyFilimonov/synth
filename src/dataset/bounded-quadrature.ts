/** Совместный квадратурный МНК с границами амплитуды для K=1 или K=2. */
import type { QuadratureFit } from './quadrature-refit';

type BoundState = 'free' | 'min' | 'max';

interface FittedState {
  fits: QuadratureFit[];
  gain: number;
}

interface AngleCandidate extends FittedState {
  angles: number[];
}

const MIN_LEVEL = 0.001;
const MAX_LEVEL = 1;
const TWO_PI = 2 * Math.PI;
const GRID_SIZE_1D = 128;
const GRID_SIZE_2D = 20;
const REFINEMENT_PASSES = 6;
const GOLDEN_ITERATIONS = 24;
const MAX_SEEDS = 4;

/** Решает квадратную систему с выбором главного элемента по столбцу. */
function solveLinearSystem(
  matrix: number[],
  rhs: number[],
  size: number,
): number[] | null {
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
    if (!Number.isFinite(pivotSize) || pivotSize <= 1e-12 * scale) {
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
      const pivotValue = augmented[column]?.[column] ?? 0;
      const factor = (target?.[column] ?? 0) / pivotValue;
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
  const solution = new Array<number>(size).fill(0);
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

/** Превращает пару квадратурных коэффициентов в уровень и фазу. */
function fitFromCoefficients(
  sineCoefficient: number,
  cosineCoefficient: number,
): QuadratureFit | null {
  const startLevel = Math.hypot(sineCoefficient, cosineCoefficient);
  if (
    !Number.isFinite(startLevel) ||
    startLevel <= 1e-12 ||
    !Number.isFinite(sineCoefficient) ||
    !Number.isFinite(cosineCoefficient)
  ) {
    return null;
  }
  const phase =
    ((Math.atan2(cosineCoefficient, sineCoefficient) % TWO_PI) +
      TWO_PI) %
    TWO_PI;
  return {
    sineCoefficient,
    cosineCoefficient,
    startLevel,
    phase,
  };
}

/** Вычисляет прирост RSS `2*c·b − c·G·c` одного набора коэффициентов. */
function stateGain(
  gram: number[],
  rhs: number[],
  coefficients: number[],
): number {
  const size = coefficients.length;
  let linear = 0;
  let quadratic = 0;
  for (let row = 0; row < size; row += 1) {
    linear += (coefficients[row] ?? 0) * (rhs[row] ?? 0);
    for (let column = 0; column < size; column += 1) {
      quadratic +=
        (coefficients[row] ?? 0) *
        (gram[row * size + column] ?? 0) *
        (coefficients[column] ?? 0);
    }
  }
  return 2 * linear - quadratic;
}

/** Нормирует угол на [0, 2π), чтобы соседние ветки поиска совпадали. */
function normalizedAngle(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

/** Возвращает кратчайшее расстояние двух углов на окружности. */
function angleDistance(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

/** Проверяет, что свободные атомы остались внутри границ амплитуды. */
function freeStatesAreFeasible(
  fits: (QuadratureFit | null)[],
  states: BoundState[],
): fits is QuadratureFit[] {
  return fits.every((fit, atom) => {
    if (fit === null) {
      return false;
    }
    return (
      states[atom] !== 'free' ||
      (fit.startLevel >= MIN_LEVEL - 1e-9 &&
        fit.startLevel <= MAX_LEVEL + 1e-9)
    );
  });
}

/** Решает свободные коэффициенты при заданных фазах граничных атомов. */
function evaluateState(arg: {
  gram: number[];
  rhs: number[];
  states: BoundState[];
  angles: number[];
}): FittedState | null {
  const atomCount = arg.states.length;
  const size = atomCount * 2;
  const coefficients = new Array<number>(size).fill(0);
  const freeColumns: number[] = [];
  let angleIndex = 0;
  for (let atom = 0; atom < atomCount; atom += 1) {
    const state = arg.states[atom];
    if (state === 'free') {
      freeColumns.push(atom * 2, atom * 2 + 1);
      continue;
    }
    const level = state === 'max' ? MAX_LEVEL : MIN_LEVEL;
    const angle = arg.angles[angleIndex] ?? 0;
    angleIndex += 1;
    coefficients[atom * 2] = level * Math.cos(angle);
    coefficients[atom * 2 + 1] = level * Math.sin(angle);
  }
  if (freeColumns.length > 0) {
    const subMatrix = freeColumns.flatMap((row) =>
      freeColumns.map((column) => arg.gram[row * size + column] ?? 0),
    );
    const freeSet = new Set(freeColumns);
    const subRhs = freeColumns.map((row) => {
      let value = arg.rhs[row] ?? 0;
      for (let column = 0; column < size; column += 1) {
        if (!freeSet.has(column)) {
          value -=
            (arg.gram[row * size + column] ?? 0) *
            (coefficients[column] ?? 0);
        }
      }
      return value;
    });
    const solution = solveLinearSystem(
      subMatrix,
      subRhs,
      freeColumns.length,
    );
    if (solution === null) {
      return null;
    }
    for (let index = 0; index < freeColumns.length; index += 1) {
      coefficients[freeColumns[index] ?? 0] = solution[index] ?? 0;
    }
  }
  const fits = Array.from({ length: atomCount }, (_, atom) =>
    fitFromCoefficients(
      coefficients[atom * 2] ?? 0,
      coefficients[atom * 2 + 1] ?? 0,
    ),
  );
  if (!freeStatesAreFeasible(fits, arg.states)) {
    return null;
  }
  const gain = stateGain(arg.gram, arg.rhs, coefficients);
  return Number.isFinite(gain) ? { fits, gain } : null;
}

/** Возвращает лучший из двух допустимых кандидатов по приросту RSS. */
function betterAngleCandidate(
  candidate: AngleCandidate | null,
  best: AngleCandidate | null,
): AngleCandidate | null {
  if (candidate === null) {
    return best;
  }
  return best === null || candidate.gain > best.gain
    ? candidate
    : best;
}

/** Уточняет один угол золотым сечением, остальные углы неподвижны. */
function refineOneAngle(arg: {
  evaluate: (angles: number[]) => FittedState | null;
  seed: AngleCandidate;
  dimension: number;
  radius: number;
}): AngleCandidate | null {
  const center = arg.seed.angles[arg.dimension] ?? 0;
  let left = center - arg.radius;
  let right = center + arg.radius;
  const ratio = 0.6180339887498949;
  let x1 = right - ratio * (right - left);
  let x2 = left + ratio * (right - left);
  const evaluateAt = (angle: number): AngleCandidate | null => {
    const angles = [...arg.seed.angles];
    angles[arg.dimension] = normalizedAngle(angle);
    const fitted = arg.evaluate(angles);
    return fitted === null ? null : { ...fitted, angles };
  };
  let first = evaluateAt(x1);
  let second = evaluateAt(x2);
  let best = betterAngleCandidate(
    first,
    betterAngleCandidate(second, arg.seed),
  );
  for (
    let iteration = 0;
    iteration < GOLDEN_ITERATIONS;
    iteration += 1
  ) {
    const firstGain = first?.gain ?? -Infinity;
    const secondGain = second?.gain ?? -Infinity;
    if (firstGain < secondGain) {
      left = x1;
      x1 = x2;
      first = second;
      x2 = left + ratio * (right - left);
      second = evaluateAt(x2);
      best = betterAngleCandidate(second, best);
    } else {
      right = x2;
      x2 = x1;
      second = first;
      x1 = right - ratio * (right - left);
      first = evaluateAt(x1);
      best = betterAngleCandidate(first, best);
    }
  }
  return best;
}

/** Поочередно уточняет все граничные углы с сужающимся радиусом. */
function refineAngles(arg: {
  evaluate: (angles: number[]) => FittedState | null;
  seed: AngleCandidate;
  gridStep: number;
}): AngleCandidate {
  let best = arg.seed;
  for (let pass = 0; pass < REFINEMENT_PASSES; pass += 1) {
    for (
      let dimension = 0;
      dimension < best.angles.length;
      dimension += 1
    ) {
      const refined = refineOneAngle({
        evaluate: arg.evaluate,
        seed: best,
        dimension,
        radius: arg.gridStep / 2 ** pass,
      });
      if (refined !== null) {
        best = refined;
      }
    }
  }
  return best;
}

/** Выбирает до четырёх разнесённых стартов среди лучших точек сетки. */
function selectAngleSeeds(
  candidates: AngleCandidate[],
  separation: number,
): AngleCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.gain - a.gain);
  const selected: AngleCandidate[] = [];
  for (const candidate of sorted) {
    const separated = selected.every((other) =>
      candidate.angles.some(
        (angle, dimension) =>
          angleDistance(angle, other.angles[dimension] ?? 0) >
          separation,
      ),
    );
    if (separated || selected.length === 0) {
      selected.push(candidate);
    }
    if (selected.length === MAX_SEEDS) {
      break;
    }
  }
  return selected;
}

/** Ищет фазы граничных атомов на сетке и уточняет несколько лучших бассейнов. */
function optimizeBoundaryAngles(arg: {
  evaluate: (angles: number[]) => FittedState | null;
  dimension: number;
}): FittedState | null {
  const gridSize = arg.dimension === 1 ? GRID_SIZE_1D : GRID_SIZE_2D;
  const gridStep = TWO_PI / gridSize;
  const combinations = gridSize ** arg.dimension;
  const candidates: AngleCandidate[] = [];
  for (let index = 0; index < combinations; index += 1) {
    let encoded = index;
    const angles = Array.from({ length: arg.dimension }, () => {
      const value = encoded % gridSize;
      encoded = Math.floor(encoded / gridSize);
      return value * gridStep;
    });
    const fitted = arg.evaluate(angles);
    if (fitted !== null) {
      candidates.push({ ...fitted, angles });
    }
  }
  let best: AngleCandidate | null = null;
  for (const seed of selectAngleSeeds(candidates, gridStep * 2)) {
    best = betterAngleCandidate(
      refineAngles({
        evaluate: arg.evaluate,
        seed,
        gridStep,
      }),
      best,
    );
  }
  return best === null ? null : { fits: best.fits, gain: best.gain };
}

/** Перечисляет все наборы free/min/max, кроме уже проверенного free/free. */
function boundaryStates(atomCount: number): BoundState[][] {
  let states: BoundState[][] = [[]];
  for (let atom = 0; atom < atomCount; atom += 1) {
    states = states.flatMap((prefix) =>
      (['free', 'min', 'max'] as BoundState[]).map((state) => [
        ...prefix,
        state,
      ]),
    );
  }
  return states.filter(
    (state) => state.includes('min') || state.includes('max'),
  );
}

/**
 * Решает совместный МНК с нормой квадратур каждого атома в [0.001, 1].
 *
 * @param gram - Матрица Грама sine/cosine-базисов в развёрнутом виде
 * @param rhs - Правая часть нормальной системы
 * @param atomCount - Число атомов: 1 или 2
 * @returns Подобранные квадратуры либо `null`, если вход невалиден,
 *   полный базис вырожден или допустимый кандидат не найден
 * @remarks Сначала проверяет свободное решение. Если оно нарушает
 *   границы, перебирает все активные наборы free/min/max, заново решает
 *   свободные коэффициенты и численно оптимизирует фазы границ. Лучший
 *   допустимый кандидат максимизирует RSS gain. Сетка и локальное
 *   уточнение фаз не гарантируют аналитический глобальный минимум.
 */
export function solveBoundedQuadratureSystem(
  gram: number[],
  rhs: number[],
  atomCount: number,
): QuadratureFit[] | null {
  const size = atomCount * 2;
  if (
    (atomCount !== 1 && atomCount !== 2) ||
    gram.length !== size * size ||
    rhs.length !== size ||
    rhs.every((value) => value === 0)
  ) {
    return null;
  }
  const unconstrained = solveLinearSystem(gram, rhs, size);
  if (unconstrained === null) {
    return null;
  }
  const freeStates = new Array<BoundState>(atomCount).fill('free');
  const freeFits = Array.from({ length: atomCount }, (_, atom) =>
    fitFromCoefficients(
      unconstrained[atom * 2] ?? 0,
      unconstrained[atom * 2 + 1] ?? 0,
    ),
  );
  if (freeStatesAreFeasible(freeFits, freeStates)) {
    return freeFits;
  }
  let best: FittedState | null = null;
  for (const states of boundaryStates(atomCount)) {
    const evaluate = (angles: number[]): FittedState | null =>
      evaluateState({ gram, rhs, states, angles });
    const candidate = optimizeBoundaryAngles({
      evaluate,
      dimension: states.filter((state) => state !== 'free').length,
    });
    if (
      candidate !== null &&
      (best === null || candidate.gain > best.gain)
    ) {
      best = candidate;
    }
  }
  return best?.fits ?? null;
}
