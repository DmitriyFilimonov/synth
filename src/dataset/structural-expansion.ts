/**
 * Измерения и ledger для одного expansion в generic structural beam.
 *
 * Модуль не знает, выполняет proposer FFT, dense-анализ или другую
 * операцию. Caller сам выбирает единицы estimate/cost и согласует их
 * с общим W.
 */

/**
 * Результат expansion с фактической стоимостью источника кандидатов.
 */
export interface StructuralExpansion<Candidate> {
  candidates: readonly Candidate[];
  /**
   * Фактическая работа proposer; в score и candidate payload не
   * входит.
   */
  cost: number;
}

/**
 * Прежний массив означает нулевую стоимость; объект измеряет
 * expansion.
 */
export type StructuralExpansionResult<Candidate> =
  readonly Candidate[] | StructuralExpansion<Candidate>;

/**
 * Аудит одного вызванного expansion, включая пустой список
 * кандидатов.
 */
export interface StructuralExpansionRecord {
  parentKey: string;
  depth: number;
  estimatedWork: number;
  cost: number;
  /** Stable lexical keys, включая предложенные duplicates. */
  candidateKeys: string[];
}

/**
 * Parent, для которого conservative estimate не поместился в
 * остаток W.
 */
export interface StructuralExpansionBudgetSkip {
  parentKey: string;
  depth: number;
  estimatedWork: number;
  remainingWork: number;
}

/** Независимые суммы после фактического списания expansion. */
export interface StructuralExpansionCharge {
  used: number;
  expansionWork: number;
}

/**
 * Проверяет conservative estimate до вызова proposer.
 *
 * @param value - Оценка работы expansion в единицах общего W
 * @returns Ничего не возвращает
 * @throws Error если значение не конечно или отрицательно
 */
export function assertStructuralExpansionEstimate(
  value: number,
): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      'expansion.estimate must be a finite non-negative number',
    );
  }
}

/**
 * Нормализует прежний или measured результат без поглощения ошибок
 * proposer.
 *
 * @param result - Массив candidates либо объект
 *   `{ candidates, cost }`
 * @returns Expansion с исходными candidates и проверенной стоимостью
 * @throws Error если результат не содержит массив candidates либо
 *   cost не конечен или отрицателен
 * @remarks Массив получает нулевую стоимость. Положительный measured
 * cost требует отдельного conservative estimate: scheduler иначе
 * принимает estimate за ноль и отклонит это списание.
 */
export function normalizeStructuralExpansion<Candidate>(
  result: StructuralExpansionResult<Candidate>,
): StructuralExpansion<Candidate> {
  if (Array.isArray(result)) {
    return {
      candidates: result as readonly Candidate[],
      cost: 0,
    };
  }
  const measured = result as StructuralExpansion<Candidate>;
  if (
    typeof measured !== 'object' ||
    measured === null ||
    !Array.isArray(measured.candidates)
  ) {
    throw new Error(
      'Structural expansion must return candidates or { candidates, cost }',
    );
  }
  if (!Number.isFinite(measured.cost) || measured.cost < 0) {
    throw new Error(
      'expansion.cost must be a finite non-negative number',
    );
  }
  return { candidates: measured.candidates, cost: measured.cost };
}

/**
 * Списывает фактический expansion в общий W и отдельный
 * expansionWork.
 *
 * @param arg - Текущие суммы, лимит W, ключ parent, estimate и cost
 * @returns Новые `used` и `expansionWork` после списания cost
 * @throws Error если estimate/cost невалидны, cost превышает estimate
 *   или сумма `used + cost` превышает W
 * @remarks Estimate ограничивает фактическую стоимость, а W
 * ограничивает сумму уже списанных evaluator/expansion работ. Разница
 * estimate−cost не резервируется.
 */
export function chargeStructuralExpansion(arg: {
  budget: number;
  used: number;
  expansionWork: number;
  parentKey: string;
  estimatedWork: number;
  cost: number;
}): StructuralExpansionCharge {
  assertStructuralExpansionEstimate(arg.estimatedWork);
  if (!Number.isFinite(arg.cost) || arg.cost < 0) {
    throw new Error(
      'expansion.cost must be a finite non-negative number',
    );
  }
  if (arg.cost > arg.estimatedWork) {
    throw new Error(
      `Structural beam expansion ${arg.parentKey} exceeded estimate: ` +
        `${arg.cost} > ${arg.estimatedWork}`,
    );
  }
  if (arg.used + arg.cost > arg.budget) {
    throw new Error(
      `Structural beam expansion ${arg.parentKey} exceeded W: ` +
        `${arg.used} + ${arg.cost} > ${arg.budget}`,
    );
  }
  return {
    used: arg.used + arg.cost,
    expansionWork: arg.expansionWork + arg.cost,
  };
}
