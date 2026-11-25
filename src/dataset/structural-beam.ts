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
import {
  compareOrderTokens,
  jsonArrayOrderToken,
  jsonStringOrderToken,
  orderTokenFromRaw,
  type StructuralKeyOrderToken,
} from './structural-key-order';

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
  /**
   * Lazy exact legacy candidate-key ordering для compact; full игнорирует
   * это поле. Если его нет, compact строит token из `candidate.key`.
   */
  orderToken?: StructuralKeyOrderToken;
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
  /**
   * Full хранит legacy recursive key, compact — bounded sequence identity.
   * Compact ID не задаёт ordering. У root вместо ID сохраняется исходный
   * `root.key`.
   */
  nodeKey: string;
  /**
   * Non-enumerable lazy rope точного legacy recursive JSON key compact node;
   * full его не создаёт. Light evaluated/history nodes token не получают.
   */
  orderToken?: StructuralKeyOrderToken;
  /**
   * Non-enumerable lazy rope точного candidate key для candidate-first
   * comparator. Light evaluated/history nodes token не получают.
   */
  candidateOrderToken?: StructuralKeyOrderToken;
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

/**
 * Лёгкий узел compact-аудита.
 *
 * Metadata и score повторяют полный узел, а `value` создаёт injected
 * compaction adapter. Scheduler никогда не передаёт этот узел в expand или
 * evaluator: им нужны полные retained values. Runtime snapshot не содержит
 * `orderToken` и `candidateOrderToken`.
 */
export type StructuralBeamCompactNode<Value, Score, AuditValue> =
  Omit<StructuralBeamNode<Value, Score>, 'value'> & {
    value: AuditValue;
  };

/** Лучшие retained-узлы одной глубины в порядке beam-ранжирования. */
export interface StructuralBeamDepth<Value, Score> {
  depth: number;
  nodes: StructuralBeamNode<Value, Score>[];
}

/** Лёгкие retained-узлы одной глубины compact-аудита. */
export interface StructuralBeamCompactDepth<
  Value,
  Score,
  AuditValue,
> {
  depth: number;
  nodes: StructuralBeamCompactNode<Value, Score, AuditValue>[];
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

/**
 * Результат opt-in compact-аудита без heavy history всего поиска.
 *
 * Root и `bestAny` остаются полными для finalization. Путь, depths и evaluated
 * содержат только значения, возвращённые compaction adapter.
 */
export interface StructuralBeamCompactResult<
  Value,
  Score,
  AuditValue,
> {
  root: StructuralBeamNode<Value, Score>;
  bestAny: StructuralBeamNode<Value, Score>;
  bestPath: StructuralBeamCompactNode<Value, Score, AuditValue>[];
  depths: StructuralBeamCompactDepth<Value, Score, AuditValue>[];
  evaluated: StructuralBeamCompactNode<Value, Score, AuditValue>[];
  work: StructuralBeamWorkLedger;
  evaluatorWork: number;
  expansionWork: number;
  expansions: StructuralBeamExpansionRecord[];
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

/** Разделяет lifecycle полного узла и его лёгкого audit-снимка. */
export interface StructuralBeamCompaction<Value, Score, AuditValue> {
  /**
   * Убирает caller-owned heavy state из одного узла аудита.
   *
   * Вызывается для root один раз и для каждого evaluated node сразу после его
   * evaluator. Возвращаемое значение не должно ссылаться на освобождаемые
   * N-мерные buffers, если caller рассчитывает на bounded history.
   *
   * @param value - Полное canonical value текущего узла
   * @param node - Metadata и score того же узла
   * @returns Лёгкое значение для evaluated/depths/path
   */
  compactValue: (
    value: Value,
    node: Readonly<StructuralBeamNode<Value, Score>>,
  ) => AuditValue;
  /**
   * Сохраняет отдельного подробного победителя до освобождения node.
   *
   * Hook видит полный evaluated node, но не становится parent и не меняет
   * порядок поиска. Он нужен, когда root выиграл `bestAny`, а лучший evaluated
   * candidate всё равно требуется для proposed/finalization.
   *
   * @param node - Полный evaluated node до освобождения heavy state
   */
  onEvaluated?: (node: StructuralBeamNode<Value, Score>) => void;
}

/** Вход beam с явно включённым compact-аудитом. */
export type StructuralBeamCompactOptions<
  Value,
  Score,
  CandidateValue,
  AuditValue,
> = StructuralBeamOptions<Value, Score, CandidateValue> & {
  compact: StructuralBeamCompaction<Value, Score, AuditValue>;
};

interface CandidateProposal<Value, Score, CandidateValue> {
  candidate: StructuralBeamCandidate<CandidateValue>;
  parent: StructuralBeamNode<Value, Score>;
  sequence: number;
  candidateOrderToken?: StructuralKeyOrderToken;
  parentOrderToken?: StructuralKeyOrderToken;
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

const NODE_SEQUENCE_WIDTH = 20;

/**
 * Строит bounded identity evaluated node по порядку evaluator calls.
 *
 * Формат ID: `<root-length>:<root-key>:<20-значный sequence>`.
 * Parent/candidate strings в ID не входят, поэтому его длина не зависит от
 * глубины или размера proposal. ID служит только identity: orderedProposals
 * и compareNodes используют отдельный exact legacy order token, а не sequence.
 * Parent chain сохраняется через `parentKey`.
 *
 * @param rootKey - Исходный key корня текущего запуска
 * @param sequence - Порядковый номер фактического evaluator call
 * @returns Bounded public identity evaluated node
 */
function childNodeKey(rootKey: string, sequence: number): string {
  return `${rootKey.length}:${rootKey}:${String(sequence).padStart(NODE_SEQUENCE_WIDTH, '0')}`;
}

/** Восстанавливает прежний full legacy recursive key без изменений. */
function legacyChildNodeKey<Value, Score, CandidateValue>(
  parent: StructuralBeamNode<Value, Score>,
  candidate: StructuralBeamCandidate<CandidateValue>,
): string {
  return JSON.stringify([parent.nodeKey, candidate.key]);
}

/**
 * Сохраняет оба lazy exact token как non-enumerable свойства полного node.
 * Public JSON/audit serialization эти свойства не видит.
 */
function defineOrderTokens(
  node: StructuralBeamNode<unknown, unknown>,
  orderToken: StructuralKeyOrderToken,
  candidateOrderToken: StructuralKeyOrderToken,
): void {
  Object.defineProperties(node, {
    orderToken: { value: orderToken, enumerable: false },
    candidateOrderToken: {
      value: candidateOrderToken,
      enumerable: false,
    },
  });
}

/** Возвращает обязательный compact node token без fallback на public ID. */
function requiredNodeOrderToken(
  node: StructuralBeamNode<unknown, unknown>,
): StructuralKeyOrderToken {
  const token = node.orderToken;
  if (token === undefined) {
    throw new Error(
      'Compact structural node has no legacy order token',
    );
  }
  return token;
}

/** Возвращает обязательный compact candidate token без public-key ordering. */
function requiredCandidateOrderToken(
  node: StructuralBeamNode<unknown, unknown>,
): StructuralKeyOrderToken {
  const token = node.candidateOrderToken;
  if (token === undefined) {
    throw new Error(
      'Compact structural node has no candidate order token',
    );
  }
  return token;
}

/** Сохраняет heavy bestAny и оба exact tokens при compact snapshot. */
function cloneNodeWithOrderTokens<Value, Score>(
  node: StructuralBeamNode<Value, Score>,
): StructuralBeamNode<Value, Score> {
  const clone = { ...node };
  defineOrderTokens(
    clone,
    requiredNodeOrderToken(node),
    requiredCandidateOrderToken(node),
  );
  return clone;
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
    const compact = 'compact' in arg.options;
    const parentOrderToken = compact
      ? requiredNodeOrderToken(parent)
      : undefined;
    for (const candidate of expansion.candidates) {
      assertCandidate(candidate);
      candidateKeys.push(candidate.key);
      proposals.push({
        candidate,
        parent,
        sequence,
        candidateOrderToken: compact
          ? (candidate.orderToken ?? orderTokenFromRaw(candidate.key))
          : undefined,
        parentOrderToken,
      });
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
 * глубины full сравнивает raw candidateKey и nodeKey, а compact — точные
 * legacy tokens; bounded public ID в сравнении не участвует.
 */
function compareNodes<Value, Score>(
  a: StructuralBeamNode<Value, Score>,
  b: StructuralBeamNode<Value, Score>,
  compareScores: (a: Score, b: Score) => number,
  compact = false,
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
  const candidateOrder = compact
    ? compareOrderTokens(
        requiredCandidateOrderToken(a),
        requiredCandidateOrderToken(b),
      )
    : compareText(a.candidateKey ?? '', b.candidateKey ?? '');
  if (candidateOrder !== 0) {
    return -candidateOrder;
  }
  return compact
    ? -compareOrderTokens(
        requiredNodeOrderToken(a),
        requiredNodeOrderToken(b),
      )
    : -compareText(a.nodeKey, b.nodeKey);
}

/** Сортирует копию предложений, не меняя массивы источника кандидатов. */
function orderedProposals<Value, Score, CandidateValue>(
  proposals: CandidateProposal<Value, Score, CandidateValue>[],
  compact = false,
): CandidateProposal<Value, Score, CandidateValue>[] {
  return [...proposals].sort((a, b) => {
    const candidateOrder = compact
      ? compareOrderTokens(
          a.candidateOrderToken ?? orderTokenFromRaw(a.candidate.key),
          b.candidateOrderToken ?? orderTokenFromRaw(b.candidate.key),
        )
      : compareText(a.candidate.key, b.candidate.key);
    if (candidateOrder !== 0) {
      return candidateOrder;
    }
    const parentOrder = compact
      ? compareOrderTokens(
          a.parentOrderToken ?? requiredNodeOrderToken(a.parent),
          b.parentOrderToken ?? requiredNodeOrderToken(b.parent),
        )
      : compareText(a.parent.nodeKey, b.parent.nodeKey);
    if (parentOrder !== 0) {
      return parentOrder;
    }
    return a.sequence - b.sequence;
  });
}

/**
 * Создаёт лёгкий snapshot, сохраняя canonical metadata без изменений.
 * Явный список полей не переносит non-enumerable order tokens в light history.
 */
function compactStructuralNode<Value, Score, AuditValue>(
  node: StructuralBeamNode<Value, Score>,
  compaction: StructuralBeamCompaction<Value, Score, AuditValue>,
): StructuralBeamCompactNode<Value, Score, AuditValue> {
  return {
    nodeKey: node.nodeKey,
    candidateKey: node.candidateKey,
    parentKey: node.parentKey,
    depth: node.depth,
    value: compaction.compactValue(node.value, node),
    score: node.score,
    groupSize: node.groupSize,
    estimatedWork: node.estimatedWork,
    cost: node.cost,
  };
}

interface CompactRetainedChild<Value, Score, AuditValue> {
  node: StructuralBeamNode<Value, Score>;
  audit: StructuralBeamCompactNode<Value, Score, AuditValue>;
}

/**
 * Оставляет полные values только у будущих retained parents.
 *
 * Остальные children освобождаются сразу, а не после сортировки всей глубины.
 * Компаратор и tie-break те же, что у полного режима; общий evaluated order
 * по-прежнему задаёт `orderedProposals`, а не это ранжирование.
 */
function retainCompactChild<Value, Score, AuditValue>(
  retained: CompactRetainedChild<Value, Score, AuditValue>[],
  child: CompactRetainedChild<Value, Score, AuditValue>,
  beamWidth: number,
  compareScores: (a: Score, b: Score) => number,
): CompactRetainedChild<Value, Score, AuditValue>[] {
  return [...retained, child]
    .sort((a, b) => compareNodes(b.node, a.node, compareScores, true))
    .slice(0, beamWidth);
}

interface StructuralBeamPathNode {
  nodeKey: string;
  parentKey: string | null;
}

/** Восстанавливает путь через сохранённые parent keys полного или light audit. */
function buildBestPath<Node extends StructuralBeamPathNode>(
  root: Node,
  bestAny: StructuralBeamPathNode,
  evaluated: readonly Node[],
): Node[] {
  const nodesByKey = new Map<string, Node>();
  nodesByKey.set(root.nodeKey, root);
  for (const node of evaluated) {
    nodesByKey.set(node.nodeKey, node);
  }
  const first = nodesByKey.get(bestAny.nodeKey);
  if (first === undefined) {
    throw new Error(
      'Structural beam best node is missing from history',
    );
  }
  const path: Node[] = [];
  let current: Node | undefined = first;
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
 * @param options - Root, пределы beam/W, callbacks предметной области и
 *   optional compact adapter
 * @returns Прежний full результат либо opt-in compact audit с раздельным
 *   учётом evaluator и expansion
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
 *
 * Без `compact` сохраняется полностью legacy-поведение: все nodes хранят
 * canonical values и recursive keys, comparator читает raw strings, tokens
 * не создаются, а compact adapter не вызывается.
 *
 * Compact использует bounded public IDs только как identity. Non-enumerable
 * `orderToken` и `candidateOrderToken` хранят lazy persistent ropes и повторяют
 * exact legacy candidate-first/parent-first ordering и dedup owner без
 * развёртывания recursive strings. Light evaluated/depths/bestPath и
 * производная history не получают tokens. Adapter вызывается сразу после
 * каждого evaluator; scheduler хранит полные values только у retained parents,
 * текущих лучших children и отдельного bestAny. Compact не меняет candidate
 * order, score, dedup, W или solver calls.
 */
export function runStructuralBeam<
  Value,
  Score,
  CandidateValue = Value,
  AuditValue = Value,
>(
  options: StructuralBeamCompactOptions<
    Value,
    Score,
    CandidateValue,
    AuditValue
  >,
): StructuralBeamCompactResult<Value, Score, AuditValue>;
export function runStructuralBeam<
  Value,
  Score,
  CandidateValue = Value,
>(
  options: StructuralBeamOptions<Value, Score, CandidateValue>,
): StructuralBeamResult<Value, Score>;
export function runStructuralBeam<
  Value,
  Score,
  CandidateValue = Value,
  AuditValue = Value,
>(
  options:
    | StructuralBeamOptions<Value, Score, CandidateValue>
    | StructuralBeamCompactOptions<
        Value,
        Score,
        CandidateValue,
        AuditValue
      >,
):
  | StructuralBeamResult<Value, Score>
  | StructuralBeamCompactResult<Value, Score, AuditValue> {
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

  const compaction =
    'compact' in options ? options.compact : undefined;
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
  if (compaction !== undefined) {
    defineOrderTokens(
      root,
      orderTokenFromRaw(options.root.key),
      orderTokenFromRaw(''),
    );
  }
  const compactRoot =
    compaction === undefined
      ? null
      : compactStructuralNode(root, compaction);
  const depths: StructuralBeamDepth<Value, Score>[] = [
    { depth: 0, nodes: [root] },
  ];
  const compactDepths: StructuralBeamCompactDepth<
    Value,
    Score,
    AuditValue
  >[] =
    compactRoot === null ? [] : [{ depth: 0, nodes: [compactRoot] }];
  const evaluated: StructuralBeamNode<Value, Score>[] = [];
  const compactEvaluated: StructuralBeamCompactNode<
    Value,
    Score,
    AuditValue
  >[] = [];
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
  let evaluatedSequence = 0;

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
    let compactChildren: CompactRetainedChild<
      Value,
      Score,
      AuditValue
    >[] = [];
    let childCount = 0;
    for (const proposal of orderedProposals(
      proposals,
      compaction !== undefined,
    )) {
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
      evaluatedSequence += 1;
      const node: StructuralBeamNode<Value, Score> = {
        nodeKey:
          compaction === undefined
            ? legacyChildNodeKey(parent, candidate)
            : childNodeKey(options.root.key, evaluatedSequence),
        candidateKey: candidate.key,
        parentKey: parent.nodeKey,
        depth,
        value: evaluation.value,
        score: evaluation.score,
        groupSize: candidate.groupSize,
        estimatedWork: candidate.estimatedWork,
        cost: evaluation.cost,
      };
      if (compaction !== undefined) {
        const candidateOrderToken =
          proposal.candidateOrderToken ??
          orderTokenFromRaw(candidate.key);
        const parentOrderToken =
          proposal.parentOrderToken ?? requiredNodeOrderToken(parent);
        defineOrderTokens(
          node,
          jsonArrayOrderToken([
            jsonStringOrderToken(parentOrderToken),
            jsonStringOrderToken(candidateOrderToken),
          ]),
          candidateOrderToken,
        );
      }
      childCount += 1;
      let audit: StructuralBeamCompactNode<
        Value,
        Score,
        AuditValue
      > | null = null;
      if (compaction === undefined) {
        children.push(node);
        evaluated.push(node);
      } else {
        audit = compactStructuralNode(node, compaction);
        compactEvaluated.push(audit);
      }
      if (
        compareNodes(
          node,
          bestAny,
          options.compareScores,
          compaction !== undefined,
        ) > 0
      ) {
        bestAny =
          compaction === undefined
            ? node
            : cloneNodeWithOrderTokens(node);
      }
      if (compaction !== undefined && audit !== null) {
        compaction.onEvaluated?.(node);
        compactChildren = retainCompactChild(
          compactChildren,
          { node, audit },
          options.beamWidth,
          options.compareScores,
        );
      }
    }

    if (childCount === 0) {
      break;
    }
    if (compaction === undefined) {
      children.sort((a, b) =>
        compareNodes(b, a, options.compareScores),
      );
      parents = children.slice(0, options.beamWidth);
      depths.push({ depth, nodes: [...parents] });
    } else {
      parents = compactChildren.map((child) => child.node);
      compactDepths.push({
        depth,
        nodes: compactChildren.map((child) => child.audit),
      });
    }
  }

  const work: StructuralBeamWorkLedger = {
    budget: options.workBudget,
    used: totals.used,
    unused: options.workBudget - totals.used,
    skippedBudget,
  };
  if (compaction !== undefined && compactRoot !== null) {
    return {
      root,
      bestAny,
      bestPath: buildBestPath(compactRoot, bestAny, compactEvaluated),
      depths: compactDepths,
      evaluated: compactEvaluated,
      work,
      evaluatorWork: totals.evaluatorWork,
      expansionWork: totals.expansionWork,
      expansions,
      skippedExpansionBudget,
      skippedGroupSize,
    };
  }
  return {
    root,
    bestAny,
    bestPath: buildBestPath(root, bestAny, evaluated),
    depths,
    evaluated,
    work,
    evaluatorWork: totals.evaluatorWork,
    expansionWork: totals.expansionWork,
    expansions,
    skippedExpansionBudget,
    skippedGroupSize,
  };
}
