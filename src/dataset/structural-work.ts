/**
 * Общий ledger synthetic structural-вычислений.
 *
 * Sample-work считает явные проходы длины N по категориям. Dense-work хранит
 * P×P и Jacobi-операции отдельно: их нельзя незаметно сложить с sampleWork и
 * назвать общим W. Модуль не импортирует renderer или solver, поэтому оба могут
 * заполнять один ledger без циклической зависимости.
 */

/** Явные проходы длины N. `total` равен сумме всех остальных полей. */
export interface StructuralSampleWork {
  /** Копии и проверки входа, support-сканы, проверки базиса. */
  validation: number;
  /** Native unit-basis renders; две квадратуры дают 2K*N. */
  basis: number;
  /** Смешивание 2K базисных колонок на каждую objective-пробу. */
  mixing: number;
  /** Production clip и Int16-квантование candidate. */
  quantize: number;
  /** Raw, continuous и quantized RSS текущего candidate. */
  metric: number;
  /** Маскированные нормы и dot products нормальных уравнений. */
  gram: number;
  /** Перестроение clip-маски и сравнение масок принятых шагов. */
  mask: number;
  /** Чтение fixedOffset при создании raw-суммы каждой пробы. */
  offset: number;
  total: number;
}

/** Отдельные dense-счётчики; эти значения не входят в sampleWork.total. */
export interface StructuralDenseWork {
  /** Фактические записи обеих симметричных ячеек Gram. */
  gramCellUpdates: number;
  /** Копии и записи матриц/собственных векторов Jacobi. */
  jacobiMatrixEntries: number;
  /** Посещения верхнего треугольника во всех Jacobi-sweeps. */
  jacobiOffDiagonalScans: number;
  jacobiRotations: number;
  /** Записи матрицы и собственных векторов на поворот. */
  jacobiRotationElementUpdates: number;
  /** Элементы проекций, обновлений и денормализации pseudo-inverse. */
  pseudoInverseEntries: number;
}

/** Разделяемый renderer/solver ledger без глобального состояния. */
export interface StructuralWorkLedger {
  sampleWork: StructuralSampleWork;
  denseWork: StructuralDenseWork;
}

export type StructuralSampleWorkCategory = Exclude<
  keyof StructuralSampleWork,
  'total'
>;

export type StructuralDenseWorkCategory = keyof StructuralDenseWork;

/** Создаёт независимый нулевой ledger. */
export function createStructuralWorkLedger(): StructuralWorkLedger {
  return {
    sampleWork: {
      validation: 0,
      basis: 0,
      mixing: 0,
      quantize: 0,
      metric: 0,
      gram: 0,
      mask: 0,
      offset: 0,
      total: 0,
    },
    denseWork: {
      gramCellUpdates: 0,
      jacobiMatrixEntries: 0,
      jacobiOffDiagonalScans: 0,
      jacobiRotations: 0,
      jacobiRotationElementUpdates: 0,
      pseudoInverseEntries: 0,
    },
  };
}

/** Добавляет `passes` явных проходов длины `sampleCount`. */
export function addStructuralSampleWork(
  ledger: StructuralWorkLedger,
  category: StructuralSampleWorkCategory,
  sampleCount: number,
  passes = 1,
): void {
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 0 ||
    !Number.isSafeInteger(passes) ||
    passes < 0
  ) {
    throw new Error('Invalid structural sample-work increment');
  }
  const work = sampleCount * passes;
  if (!Number.isSafeInteger(work)) {
    throw new Error('Structural sample-work overflow');
  }
  ledger.sampleWork[category] += work;
  ledger.sampleWork.total += work;
}

/** Добавляет точное число dense cell/scalar операций одной категории. */
export function addStructuralDenseWork(
  ledger: StructuralWorkLedger,
  category: StructuralDenseWorkCategory,
  count: number,
): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Invalid structural dense-work increment');
  }
  ledger.denseWork[category] += count;
}

/** Снимает независимую копию, которую поздний runner не сможет изменить. */
export function snapshotStructuralWork(
  ledger: StructuralWorkLedger,
): StructuralWorkLedger {
  return {
    sampleWork: { ...ledger.sampleWork },
    denseWork: { ...ledger.denseWork },
  };
}
