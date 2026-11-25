/**
 * Чистый deterministic beam scheduler для T38.
 *
 * Модуль не знает об осцилляторах, PCM или coordinate descent. Источник
 * кандидатов, evaluator и comparator задают предметную область снаружи.
 */
import {
  assertStructuralExpansionEstimate,
  chargeStructuralExpansion,
  normalizeStructuralExpansion,
  type StructuralExpansion as GenericStructuralExpansion,
  type StructuralExpansionBudgetSkip as StructuralBeamExpansionBudgetSkip,
  type StructuralExpansionRecord as StructuralBeamExpansionRecord,
  type StructuralExpansionResult as GenericStructuralExpansionResult,
} from './structural-expansion';

export type {
  StructuralExpansionBudgetSkip as StructuralBeamExpansionBudgetSkip,
  StructuralExpansionRecord as StructuralBeamExpansionRecord,
} from './structural-expansion';

/** Исходный узел поиска; его score уже известен и evaluator не нужен. */
export interface StructuralBeamRoot<Value, Score> {
  /** Стабильный canonical key исходного состояния. */
  key: string;
  value: Value;
  score: Score;
}

/** Предложение перехода из parent в новое состояние. */
export interface StructuralBeamCandidate<Value> {
  /**
   * Canonical key состояния, а не номер предложения.
   *
   * Повторный key обозначает тот же кандидат независимо от parent и не
   * вызывает повторный evaluator.
   */
  key: string;
  value: Value;
  /** Число компонентов группы; scheduler не ограничивает её парой. */
  groupSize: number;
  /** Консервативная оценка работы в единицах общего бюджета W. */
  estimatedWork: number;
}

/**
 * Measured expansion с typed beam candidates и фактической
 * стоимостью.
 */
export type StructuralBeamExpansion<CandidateValue> =
  GenericStructuralExpansion<StructuralBeamCandidate<CandidateValue>>;

/**
 * Прежний candidate array либо measured expansion того же
 * candidate type.
 */
export type StructuralBeamExpansionResult<CandidateValue> =
  GenericStructuralExpansionResult<
    StructuralBeamCandidate<CandidateValue>
  >;

/** Фактический результат одного вызова evaluator. */
export interface StructuralBeamEvaluation<Value, Score> {
  /** Итоговое значение узла; evaluator может вернуть новый native patch. */
  value: Value;
  score: Score;
  /** Фактически выполненная работа в тех же единицах, что и W. */
  cost: number;
}

/** Сохранённый узел вместе с происхождением и фактической стоимостью. */
export interface StructuralBeamNode<Value, Score> {
  /** Стабильный key конкретного пути к canonical candidate. */
  nodeKey: string;
  /** Canonical candidate key; у исходного узла равен `null`. */
  candidateKey: string | null;
  /** Key parent-узла; у исходного узла равен `null`. */
  parentKey: string | null;
  depth: number;
  value: Value;
  score: Score;
  groupSize: number;
  estimatedWork: number;
  /** Фактическая стоимость evaluator; исходный узел стоит ноль. */
  cost: number;
}

/** Кандидат, которому не хватило оставшегося W до вызова evaluator. */
export interface StructuralBeamBudgetSkip {
  parentKey: string;
  candidateKey: string;
  depth: number;
  estimatedWork: number;
  remainingWork: number;
}

/** Кандидат, отклонённый только порогом `maxGroupSize`. */
export interface StructuralBeamGroupSizeSkip {
  parentKey: string;
  candidateKey: string;
  depth: number;
  groupSize: number;
  maxGroupSize: number;
}

/** Явный учёт работы; единицы измерения задаёт вызывающая сторона. */
export interface StructuralBeamWorkLedger {
  budget: number;
  used: number;
  unused: number;
  skippedBudget: StructuralBeamBudgetSkip[];
}

/** Лучшие retained-узлы одной глубины в порядке beam-ранжирования. */
export interface StructuralBeamDepth<Value, Score> {
  depth: number;
  nodes: StructuralBeamNode<Value, Score>[];
}

/** Полный deterministic результат поиска. */
export interface StructuralBeamResult<Value, Score> {
  root: StructuralBeamNode<Value, Score>;
  /** Лучший узел среди root и всех оценённых кандидатов. */
  bestAny: StructuralBeamNode<Value, Score>;
  /** Путь от root до `bestAny`, включая оба конца. */
  bestPath: StructuralBeamNode<Value, Score>[];
  /** Retained beam каждой достигнутой глубины, включая root на глубине 0. */
  depths: StructuralBeamDepth<Value, Score>[];
  /** Все оценённые узлы в точном порядке вызовов evaluator. */
  evaluated: StructuralBeamNode<Value, Score>[];
  /** Прежний общий W: `used = evaluatorWork + expansionWork`. */
  work: StructuralBeamWorkLedger;
  /** Фактические затраты evaluator, отдельно от работы proposer. */
  evaluatorWork: number;
  /** Фактические затраты expansion, отдельно от evaluator. */
  expansionWork: number;
  /** Все вызванные expansions в deterministic порядке. */
  expansions: StructuralBeamExpansionRecord[];
  /**
   * Expansions, пропущенные до callback из-за conservative estimate.
   */
  skippedExpansionBudget: StructuralBeamExpansionBudgetSkip[];
  skippedGroupSize: StructuralBeamGroupSizeSkip[];
}

/** Вход одного чистого синхронного beam-запуска. */
export interface StructuralBeamOptions<
  Value,
  Score,
  CandidateValue = Value,
> {
  root: StructuralBeamRoot<Value, Score>;
  beamWidth: number;
  maxDepth: number;
  maxGroupSize: number;
  /**
   * Общий бюджет W в caller-defined единицах работы evaluator и
   * expansion. Scheduler не знает, какие физические операции измеряет
   * caller.
   */
  workBudget: number;
  /**
   * Возвращает conservative estimate expansion до вызова `expand`.
   * Отсутствие estimator означает нулевой estimate и допускает только
   * прежний массив candidates либо measured expansion с нулевой
   * фактической ценой.
   *
   * @param parent - Retained parent, который scheduler собирается
   *   расширить
   * @returns Конечный неотрицательный верхний предел фактической цены
   */
  estimateExpansion?: (
    parent: StructuralBeamNode<Value, Score>,
  ) => number;
  /**
   * Возвращает предложения только для retained parent-узла.
   * Прежний массив сохраняет нулевую expansion cost; объект явно
   * возвращает `{ candidates, cost }` и не меняет score или payload
   * кандидатов.
   *
   * @param parent - Retained parent текущей глубины
   * @returns Массив candidates либо measured `{ candidates, cost }`
   */
  expand: (
    parent: StructuralBeamNode<Value, Score>,
  ) => StructuralBeamExpansionResult<CandidateValue>;
  /** Возвращает новое значение узла, score и фактическую работу. */
  evaluate: (
    candidate: StructuralBeamCandidate<CandidateValue>,
    parent: StructuralBeamNode<Value, Score>,
  ) => StructuralBeamEvaluation<Value, Score>;
  /** Возвращает положительное число, если `a` лучше `b`, и ноль при tie. */
  compareScores: (a: Score, b: Score) => number;
}

interface CandidateProposal<Value, Score, CandidateValue> {
  candidate: StructuralBeamCandidate<CandidateValue>;
  parent: StructuralBeamNode<Value, Score>;
  sequence: number;
}

/** Внутренние фактические суммы; публичный legacy `work` не расширяется. */
interface StructuralBeamWorkTotals {
  used: number;
  evaluatorWork: number;
  expansionWork: number;
}

/** Сравнивает строки без locale-dependent порядка. */
function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Проверяет конечное неотрицательное количество работы. */
function assertWork(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

/** Проверяет целый параметр поиска до первого expand/evaluate. */
function assertInteger(
  value: number,
  label: string,
  minimum: number,
): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
}

/** Проверяет metadata до дедупликации и до любого бюджетного решения. */
function assertCandidate<Value>(
  candidate: StructuralBeamCandidate<Value>,
): void {
  if (
    typeof candidate.key !== 'string' ||
    candidate.key.length === 0
  ) {
    throw new Error(
      'Structural beam candidate key must be non-empty',
    );
  }
  assertInteger(candidate.groupSize, 'candidate.groupSize', 1);
  assertWork(candidate.estimatedWork, 'candidate.estimatedWork');
}

/** Строит однозначный key пути без небезопасной склейки строк. */
function childNodeKey<Value, Score, CandidateValue>(
  parent: StructuralBeamNode<Value, Score>,
  candidate: StructuralBeamCandidate<CandidateValue>,
): string {
  return JSON.stringify([parent.nodeKey, candidate.key]);
}

/**
 * Расширяет каждый retained parent не более одного раза за запуск.
 *
 * Estimate проверяется до callback. После callback helper списывает только
 * фактический cost, поэтому неизрасходованная часть estimate доступна следующим
 * parents и candidates. Исключения estimator/proposer идут вызывающему коду.
 */
function expandStructuralParents<Value, Score, CandidateValue>(arg: {
  options: StructuralBeamOptions<Value, Score, CandidateValue>;
  parents: readonly StructuralBeamNode<Value, Score>[];
  depth: number;
  totals: StructuralBeamWorkTotals;
  expandedParentKeys: Set<string>;
}): {
  proposals: CandidateProposal<Value, Score, CandidateValue>[];
  expansions: StructuralBeamExpansionRecord[];
  skippedBudget: StructuralBeamExpansionBudgetSkip[];
} {
  const proposals: CandidateProposal<Value, Score, CandidateValue>[] =
    [];
  const expansions: StructuralBeamExpansionRecord[] = [];
  const skippedBudget: StructuralBeamExpansionBudgetSkip[] = [];
  let sequence = 0;
  for (const parent of arg.parents) {
    if (arg.expandedParentKeys.has(parent.nodeKey)) {
      continue;
    }
    arg.expandedParentKeys.add(parent.nodeKey);
    const estimateExpansion = arg.options.estimateExpansion;
    const estimatedWork =
      estimateExpansion === undefined ? 0 : estimateExpansion(parent);
    assertStructuralExpansionEstimate(estimatedWork);
    const remainingWork = arg.options.workBudget - arg.totals.used;
    if (estimatedWork > remainingWork) {
      skippedBudget.push({
        parentKey: parent.nodeKey,
        depth: arg.depth,
        estimatedWork,
        remainingWork,
      });
      continue;
    }

    const expansion = normalizeStructuralExpansion(
      arg.options.expand(parent),
    );
    const charge = chargeStructuralExpansion({
      budget: arg.options.workBudget,
      used: arg.totals.used,
      expansionWork: arg.totals.expansionWork,
      parentKey: parent.nodeKey,
      estimatedWork,
      cost: expansion.cost,
    });
    arg.totals.used = charge.used;
    arg.totals.expansionWork = charge.expansionWork;
    const candidateKeys: string[] = [];
    for (const candidate of expansion.candidates) {
      assertCandidate(candidate);
      candidateKeys.push(candidate.key);
      proposals.push({ candidate, parent, sequence });
      sequence += 1;
    }
    candidateKeys.sort(compareText);
    expansions.push({
      parentKey: parent.nodeKey,
      depth: arg.depth,
      estimatedWork,
      cost: expansion.cost,
      candidateKeys,
    });
  }
  return { proposals, expansions, skippedBudget };
}

/**
 * Сравнивает узлы: сначала injected score, затем глубину и stable keys.
 *
 * При равном score более мелкий узел выигрывает bestAny. Внутри одной
 * глубины лексикографически меньшие candidateKey и nodeKey идут первыми.
 */
function compareNodes<Value, Score>(
  a: StructuralBeamNode<Value, Score>,
  b: StructuralBeamNode<Value, Score>,
  compareScores: (a: Score, b: Score) => number,
): number {
  const scoreOrder = compareScores(a.score, b.score);
  if (!Number.isFinite(scoreOrder)) {
    throw new Error('compareScores must return a finite number');
  }
  if (scoreOrder !== 0) {
    return scoreOrder;
  }
  if (a.depth !== b.depth) {
    return b.depth - a.depth;
  }
  const candidateOrder = compareText(
    a.candidateKey ?? '',
    b.candidateKey ?? '',
  );
  if (candidateOrder !== 0) {
    return -candidateOrder;
  }
  return -compareText(a.nodeKey, b.nodeKey);
}

/** Сортирует копию предложений, не меняя массивы источника кандидатов. */
function orderedProposals<Value, Score, CandidateValue>(
  proposals: CandidateProposal<Value, Score, CandidateValue>[],
): CandidateProposal<Value, Score, CandidateValue>[] {
  return [...proposals].sort((a, b) => {
    const candidateOrder = compareText(
      a.candidate.key,
      b.candidate.key,
    );
    if (candidateOrder !== 0) {
      return candidateOrder;
    }
    const parentOrder = compareText(
      a.parent.nodeKey,
      b.parent.nodeKey,
    );
    if (parentOrder !== 0) {
      return parentOrder;
    }
    return a.sequence - b.sequence;
  });
}

/** Восстанавливает путь через сохранённые parent keys. */
function buildBestPath<Value, Score>(
  root: StructuralBeamNode<Value, Score>,
  bestAny: StructuralBeamNode<Value, Score>,
  evaluated: StructuralBeamNode<Value, Score>[],
): StructuralBeamNode<Value, Score>[] {
  const nodesByKey = new Map<
    string,
    StructuralBeamNode<Value, Score>
  >();
  nodesByKey.set(root.nodeKey, root);
  for (const node of evaluated) {
    nodesByKey.set(node.nodeKey, node);
  }
  const path: StructuralBeamNode<Value, Score>[] = [];
  let current: StructuralBeamNode<Value, Score> | undefined = bestAny;
  while (current !== undefined) {
    path.unshift(current);
    if (current.parentKey === null) {
      break;
    }
    current = nodesByKey.get(current.parentKey);
    if (current === undefined) {
      throw new Error('Structural beam parent chain is incomplete');
    }
  }
  return path;
}

/**
 * Запускает generic beam search поверх injected candidates и
 * evaluator.
 *
 * @param options - Root, пределы beam/W и callbacks предметной
 *   области
 * @returns Полный deterministic результат с раздельным учётом
 *   evaluator и expansion
 * @throws Error при невалидных параметрах, ключах, estimate/cost или
 *   превышении conservative estimate/W; ошибки callbacks пробрасываются
 *   без изменений
 * @remarks Каждая глубина оценивает предложения всех retained
 * parents, а затем оставляет `beamWidth` лучших children этой глубины.
 * Промежуточный узел не обязан улучшать parent или global best.
 * Пустая или слабая ветвь не останавливает остальные parents.
 *
 * Canonical candidate keys дедуплицируются глобально. Перед evaluator
 * scheduler проверяет conservative estimate против оставшегося W
 * и при нехватке записывает skip. Фактическая стоимость суммируется после
 * вызова; превышение candidate estimate или W является ошибкой до списания
 * и обновления bestAny. Аналогичный estimate/cost
 * контракт покрывает expansion: его skip происходит до `expand`, а
 * фактическая цена сразу уменьшает W для candidates и следующих
 * parents.
 * Отдельные `evaluatorWork` и `expansionWork` не смешивают аудит двух
 * видов операций. В успешном результате
 * `used = evaluatorWork + expansionWork <= W`, а `unused = W - used`.
 *
 * Единицы W ничего не знают о CD iterations, FFT,
 * dense-операциях и не приравниваются к числу beam candidates. Модуль
 * не выполняет runner, CD или canonical finalization. Он не сортирует
 * и не изменяет входные массивы, nodes или candidates. Payload остаётся
 * caller-owned, поэтому callbacks должны читать его как readonly, если
 * требуется сквозная неизменность.
 */
export function runStructuralBeam<
  Value,
  Score,
  CandidateValue = Value,
>(
  options: StructuralBeamOptions<Value, Score, CandidateValue>,
): StructuralBeamResult<Value, Score> {
  assertInteger(options.beamWidth, 'beamWidth', 1);
  assertInteger(options.maxDepth, 'maxDepth', 0);
  assertInteger(options.maxGroupSize, 'maxGroupSize', 1);
  assertWork(options.workBudget, 'workBudget');
  if (
    typeof options.root.key !== 'string' ||
    options.root.key.length === 0
  ) {
    throw new Error('Structural beam root key must be non-empty');
  }

  const root: StructuralBeamNode<Value, Score> = {
    nodeKey: options.root.key,
    candidateKey: null,
    parentKey: null,
    depth: 0,
    value: options.root.value,
    score: options.root.score,
    groupSize: 0,
    estimatedWork: 0,
    cost: 0,
  };
  const depths: StructuralBeamDepth<Value, Score>[] = [
    { depth: 0, nodes: [root] },
  ];
  const evaluated: StructuralBeamNode<Value, Score>[] = [];
  const expansions: StructuralBeamExpansionRecord[] = [];
  const skippedBudget: StructuralBeamBudgetSkip[] = [];
  const skippedExpansionBudget: StructuralBeamExpansionBudgetSkip[] =
    [];
  const skippedGroupSize: StructuralBeamGroupSizeSkip[] = [];
  const seenCandidateKeys = new Set<string>([options.root.key]);
  const expandedParentKeys = new Set<string>();
  const totals: StructuralBeamWorkTotals = {
    used: 0,
    evaluatorWork: 0,
    expansionWork: 0,
  };
  let bestAny = root;
  let parents = [root];

  for (let depth = 1; depth <= options.maxDepth; depth += 1) {
    const expanded = expandStructuralParents({
      options,
      parents,
      depth,
      totals,
      expandedParentKeys,
    });
    const { proposals } = expanded;
    expansions.push(...expanded.expansions);
    skippedExpansionBudget.push(...expanded.skippedBudget);

    const children: StructuralBeamNode<Value, Score>[] = [];
    for (const proposal of orderedProposals(proposals)) {
      const { candidate, parent } = proposal;
      if (seenCandidateKeys.has(candidate.key)) {
        continue;
      }
      seenCandidateKeys.add(candidate.key);
      if (candidate.groupSize > options.maxGroupSize) {
        skippedGroupSize.push({
          parentKey: parent.nodeKey,
          candidateKey: candidate.key,
          depth,
          groupSize: candidate.groupSize,
          maxGroupSize: options.maxGroupSize,
        });
        continue;
      }
      const remainingWork = options.workBudget - totals.used;
      if (candidate.estimatedWork > remainingWork) {
        skippedBudget.push({
          parentKey: parent.nodeKey,
          candidateKey: candidate.key,
          depth,
          estimatedWork: candidate.estimatedWork,
          remainingWork,
        });
        continue;
      }

      const evaluation = options.evaluate(candidate, parent);
      assertWork(evaluation.cost, 'evaluation.cost');
      if (totals.used + evaluation.cost > options.workBudget) {
        throw new Error(
          `Structural beam evaluator exceeded W for ${candidate.key}: ` +
            `${totals.used} + ${evaluation.cost} > ${options.workBudget}`,
        );
      }
      if (evaluation.cost > candidate.estimatedWork) {
        throw new Error(
          `Structural beam evaluator exceeded estimate for ${candidate.key}: ` +
            `${evaluation.cost} > ${candidate.estimatedWork}`,
        );
      }
      totals.used += evaluation.cost;
      totals.evaluatorWork += evaluation.cost;
      const node: StructuralBeamNode<Value, Score> = {
        nodeKey: childNodeKey(parent, candidate),
        candidateKey: candidate.key,
        parentKey: parent.nodeKey,
        depth,
        value: evaluation.value,
        score: evaluation.score,
        groupSize: candidate.groupSize,
        estimatedWork: candidate.estimatedWork,
        cost: evaluation.cost,
      };
      children.push(node);
      evaluated.push(node);
      if (compareNodes(node, bestAny, options.compareScores) > 0) {
        bestAny = node;
      }
    }

    if (children.length === 0) {
      break;
    }
    children.sort((a, b) =>
      compareNodes(b, a, options.compareScores),
    );
    parents = children.slice(0, options.beamWidth);
    depths.push({ depth, nodes: [...parents] });
  }

  return {
    root,
    bestAny,
    bestPath: buildBestPath(root, bestAny, evaluated),
    depths,
    evaluated,
    work: {
      budget: options.workBudget,
      used: totals.used,
      unused: options.workBudget - totals.used,
      skippedBudget,
    },
    evaluatorWork: totals.evaluatorWork,
    expansionWork: totals.expansionWork,
    expansions,
    skippedExpansionBudget,
    skippedGroupSize,
  };
}
