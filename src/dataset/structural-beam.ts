/**
 * Чистый deterministic beam scheduler для T38.
 *
 * Модуль не знает об осцилляторах, PCM или coordinate descent. Источник
 * кандидатов, evaluator и comparator задают предметную область снаружи.
 */

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
  work: StructuralBeamWorkLedger;
  skippedGroupSize: StructuralBeamGroupSizeSkip[];
}

/** Вход одного чистого синхронного beam-запуска. */
export interface StructuralBeamOptions<Value, Score> {
  root: StructuralBeamRoot<Value, Score>;
  beamWidth: number;
  maxDepth: number;
  maxGroupSize: number;
  /** Общий бюджет W в caller-defined единицах работы. */
  workBudget: number;
  /** Возвращает предложения только для retained parent-узла. */
  expand: (
    parent: StructuralBeamNode<Value, Score>,
  ) => readonly StructuralBeamCandidate<Value>[];
  /** Возвращает новое значение узла, score и фактическую работу. */
  evaluate: (
    candidate: StructuralBeamCandidate<Value>,
    parent: StructuralBeamNode<Value, Score>,
  ) => StructuralBeamEvaluation<Value, Score>;
  /** Возвращает положительное число, если `a` лучше `b`, и ноль при tie. */
  compareScores: (a: Score, b: Score) => number;
}

interface CandidateProposal<Value, Score> {
  candidate: StructuralBeamCandidate<Value>;
  parent: StructuralBeamNode<Value, Score>;
  sequence: number;
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
function childNodeKey<Value, Score>(
  parent: StructuralBeamNode<Value, Score>,
  candidate: StructuralBeamCandidate<Value>,
): string {
  return JSON.stringify([parent.nodeKey, candidate.key]);
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
function orderedProposals<Value, Score>(
  proposals: CandidateProposal<Value, Score>[],
): CandidateProposal<Value, Score>[] {
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
 * Запускает generic beam search поверх injected candidates и evaluator.
 *
 * Каждая глубина оценивает предложения всех retained parents, а затем
 * оставляет `beamWidth` лучших children этой глубины. Промежуточный узел не
 * обязан улучшать parent или global best. Пустая или слабая ветвь не
 * останавливает остальные parents. Исключения самих callbacks не
 * поглощаются.
 *
 * Canonical candidate keys дедуплицируются глобально. Перед evaluator
 * scheduler проверяет conservative estimate против оставшегося W и при
 * нехватке записывает skip. Фактическая стоимость суммируется после вызова;
 * превышение W является ошибкой. В успешном результате `used <= W` и
 * `unused = W - used`.
 *
 * Единицы W ничего не знают о CD iterations и не приравниваются к числу beam
 * candidates. Модуль не выполняет runner, CD или canonical finalization.
 * Он не сортирует и не изменяет входные массивы, nodes или candidates.
 * Payload остаётся caller-owned, поэтому callbacks должны читать его как
 * readonly, если требуется сквозная неизменность.
 */
export function runStructuralBeam<Value, Score>(
  options: StructuralBeamOptions<Value, Score>,
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
  const skippedBudget: StructuralBeamBudgetSkip[] = [];
  const skippedGroupSize: StructuralBeamGroupSizeSkip[] = [];
  const seenCandidateKeys = new Set<string>([options.root.key]);
  let used = 0;
  let bestAny = root;
  let parents = [root];

  for (let depth = 1; depth <= options.maxDepth; depth += 1) {
    const proposals: CandidateProposal<Value, Score>[] = [];
    let sequence = 0;
    for (const parent of parents) {
      const candidates = options.expand(parent);
      for (const candidate of candidates) {
        assertCandidate(candidate);
        proposals.push({ candidate, parent, sequence });
        sequence += 1;
      }
    }

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
      const remainingWork = options.workBudget - used;
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
      if (used + evaluation.cost > options.workBudget) {
        throw new Error(
          `Structural beam evaluator exceeded W for ${candidate.key}: ` +
            `${used} + ${evaluation.cost} > ${options.workBudget}`,
        );
      }
      used += evaluation.cost;
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
      used,
      unused: options.workBudget - used,
      skippedBudget,
    },
    skippedGroupSize,
  };
}
