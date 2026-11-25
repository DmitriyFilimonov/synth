import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runStructuralBeam,
  type StructuralBeamCandidate,
  type StructuralBeamEvaluation,
  type StructuralBeamExpansionRecord,
  type StructuralBeamExpansionResult,
  type StructuralBeamNode,
  type StructuralBeamOptions,
  type StructuralBeamResult,
} from './structural-beam';
import { stringifyOrderToken } from './structural-key-order';

type NumberCandidate = StructuralBeamCandidate<string>;
type NumberNode = StructuralBeamNode<string, number>;
type NumberResult = StructuralBeamResult<string, number>;
type NumberOptions = StructuralBeamOptions<string, number>;

/** Создаёт строковый synthetic candidate без предметной аудио-логики. */
function candidate(
  key: string,
  groupSize = 1,
  estimatedWork = 1,
): NumberCandidate {
  return { key, value: key, groupSize, estimatedWork };
}

/** Сравнивает bestAny semantics и exact legacy token compact узла. */
function assertCompactBestAny<Value, Score>(
  full: StructuralBeamNode<Value, Score>,
  compact: StructuralBeamNode<Value, Score>,
): void {
  assert.equal(compact.candidateKey, full.candidateKey);
  assert.equal(compact.depth, full.depth);
  assert.deepEqual(compact.score, full.score);
  assert.equal(compact.groupSize, full.groupSize);
  assert.equal(compact.estimatedWork, full.estimatedWork);
  assert.equal(compact.cost, full.cost);
  assert.deepEqual(compact.value, full.value);
  const token = compact.orderToken;
  assert.ok(token !== undefined);
  assert.equal(stringifyOrderToken(token), full.nodeKey);
}

/** Сравнивает expansion semantics без identity parent node. */
function expansionSemantics(
  expansion: StructuralBeamExpansionRecord,
): unknown {
  return {
    depth: expansion.depth,
    estimatedWork: expansion.estimatedWork,
    cost: expansion.cost,
    candidateKeys: expansion.candidateKeys,
  };
}

/** Возвращает читаемое имя synthetic node для проверки точных путей. */
function nodeName(node: NumberNode): string {
  return node.candidateKey ?? node.value;
}

/** Фиксирует retained keys каждой глубины без остального аудита. */
function depthKeys(result: NumberResult): string[][] {
  return result.depths.map((level) => level.nodes.map(nodeName));
}

/** Сравнение чисел: больший score лучше. */
function descending(a: number, b: number): number {
  return a - b;
}

/** Запускает таблицу empty0/A50/B40/C30 и трёх групп. */
function runScoreTable(beamWidth: number): {
  result: NumberResult;
  calls: string[];
} {
  const scores = new Map([
    ['A', 50],
    ['B', 40],
    ['C', 30],
    ['A+B', 60],
    ['A+C', 55],
    ['B+C', 90],
  ]);
  const expansions = new Map<string, NumberCandidate[]>([
    ['empty', [candidate('A'), candidate('B'), candidate('C')]],
    ['A', [candidate('A+B', 2), candidate('A+C', 2)]],
    ['B', [candidate('B+C', 2)]],
    ['C', []],
  ]);
  const calls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth,
    maxDepth: 2,
    maxGroupSize: 2,
    workBudget: 20,
    expand: (parent) => expansions.get(parent.value) ?? [],
    evaluate: (next, parent) => {
      calls.push(`${parent.value}:${next.key}`);
      const score = scores.get(next.key);
      assert.ok(score !== undefined);
      return { value: next.value, score, cost: 1 };
    },
    compareScores: descending,
  });
  return { result, calls };
}

test('width 1 follows A to A+B and width 2 retains B to find B+C', () => {
  const narrow = runScoreTable(1);
  assert.deepEqual(narrow.calls, [
    'empty:A',
    'empty:B',
    'empty:C',
    'A:A+B',
    'A:A+C',
  ]);
  assert.deepEqual(narrow.result.bestPath.map(nodeName), [
    'empty',
    'A',
    'A+B',
  ]);
  assert.equal(narrow.result.bestAny.score, 60);
  assert.equal(narrow.result.bestAny.depth, 2);
  assert.equal(narrow.result.bestAny.parentKey, '["empty","A"]');
  assert.deepEqual(depthKeys(narrow.result), [
    ['empty'],
    ['A'],
    ['A+B'],
  ]);
  assert.equal(narrow.result.evaluated.length, 5);

  const wide = runScoreTable(2);
  assert.deepEqual(wide.calls, [
    'empty:A',
    'empty:B',
    'empty:C',
    'A:A+B',
    'A:A+C',
    'B:B+C',
  ]);
  assert.deepEqual(wide.result.bestPath.map(nodeName), [
    'empty',
    'B',
    'B+C',
  ]);
  assert.equal(wide.result.bestAny.score, 90);
  assert.equal(wide.result.bestAny.depth, 2);
  assert.equal(wide.result.bestAny.groupSize, 2);
  assert.equal(wide.result.bestAny.cost, 1);
  assert.deepEqual(depthKeys(wide.result), [
    ['empty'],
    ['A', 'B'],
    ['B+C', 'A+B'],
  ]);
  assert.equal(wide.result.evaluated.length, 6);
});

test('a larger group does not outrank a better actual singleton score', () => {
  const calls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 20,
    workBudget: 2,
    expand: () => [candidate('large', 20), candidate('single', 1)],
    evaluate: (next) => {
      calls.push(next.key);
      return {
        value: next.value,
        score: next.key === 'single' ? 61 : 60,
        cost: 1,
      };
    },
    compareScores: descending,
  });

  assert.deepEqual(calls, ['large', 'single']);
  assert.equal(result.bestAny.candidateKey, 'single');
  assert.equal(result.bestAny.groupSize, 1);
  assert.deepEqual(depthKeys(result), [['empty'], ['single']]);
});

test('a temporary score regression remains expandable to a winning child', () => {
  const scores = new Map([
    ['start', 50],
    ['down', 10],
    ['winner', 80],
  ]);
  const expansions = new Map<string, NumberCandidate[]>([
    ['empty', [candidate('start')]],
    ['start', [candidate('down')]],
    ['down', [candidate('winner')]],
    ['winner', []],
  ]);
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 1,
    maxDepth: 3,
    maxGroupSize: 2,
    workBudget: 3,
    expand: (parent) => expansions.get(parent.value) ?? [],
    evaluate: (next) => {
      const score = scores.get(next.key);
      assert.ok(score !== undefined);
      return { value: next.value, score, cost: 1 };
    },
    compareScores: descending,
  });

  assert.equal(result.evaluated[1]?.score, 10);
  assert.equal(result.bestAny.candidateKey, 'winner');
  assert.equal(result.bestAny.score, 80);
  assert.deepEqual(result.bestPath.map(nodeName), [
    'empty',
    'start',
    'down',
    'winner',
  ]);
  assert.deepEqual(result.evaluated.map(nodeName), [
    'start',
    'down',
    'winner',
  ]);
});

test('a bad child and an empty parent do not stop a sibling branch', () => {
  const scores = new Map([
    ['A', 10],
    ['B', 9],
    ['A-bad', -20],
    ['B-step', 8],
    ['B-win', 70],
  ]);
  const expansions = new Map<string, NumberCandidate[]>([
    ['empty', [candidate('A'), candidate('B')]],
    ['A', [candidate('A-bad')]],
    ['B', [candidate('B-step')]],
    ['A-bad', []],
    ['B-step', [candidate('B-win')]],
    ['B-win', []],
  ]);
  const calls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 2,
    maxDepth: 3,
    maxGroupSize: 2,
    workBudget: 5,
    expand: (parent) => expansions.get(parent.value) ?? [],
    evaluate: (next) => {
      calls.push(next.key);
      const score = scores.get(next.key);
      assert.ok(score !== undefined);
      return { value: next.value, score, cost: 1 };
    },
    compareScores: descending,
  });

  assert.deepEqual(calls, ['A', 'B', 'A-bad', 'B-step', 'B-win']);
  assert.deepEqual(result.bestPath.map(nodeName), [
    'empty',
    'B',
    'B-step',
    'B-win',
  ]);
  assert.equal(result.bestAny.candidateKey, 'B-win');
});

/** Повторяет duplicate/tie fixture с обратным порядком входного массива. */
function runDuplicateAndTie(reverse: boolean): {
  result: NumberResult;
  calls: string[];
} {
  const roots = [
    candidate('tie-B'),
    candidate('tie-A'),
    candidate('tie-A'),
  ];
  const calls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 2,
    maxDepth: 2,
    maxGroupSize: 2,
    workBudget: 10,
    expand: (parent) => {
      if (parent.value === 'empty') {
        return reverse ? [...roots].reverse() : roots;
      }
      return [candidate('leaf')];
    },
    evaluate: (next, parent) => {
      calls.push(`${parent.value}:${next.key}`);
      return { value: next.value, score: 10, cost: 1 };
    },
    compareScores: descending,
  });
  return { result, calls };
}

test('canonical duplicates and ties have stable work, path and call order', () => {
  const first = runDuplicateAndTie(false);
  const second = runDuplicateAndTie(true);
  const expectedCalls = ['empty:tie-A', 'empty:tie-B', 'tie-A:leaf'];

  assert.deepEqual(first.calls, expectedCalls);
  assert.deepEqual(second.calls, expectedCalls);
  assert.equal(first.result.evaluated.length, 3);
  assert.equal(first.result.work.used, 3);
  assert.equal(first.result.work.unused, 7);
  assert.deepEqual(first.result, second.result);
  assert.deepEqual(first.result.bestPath.map(nodeName), [
    'empty',
    'tie-A',
  ]);
  assert.deepEqual(depthKeys(first.result), [
    ['empty'],
    ['tie-A', 'tie-B'],
    ['leaf'],
  ]);
  assert.equal(
    first.result.evaluated[2]?.parentKey,
    '["empty","tie-A"]',
  );
});

test('budget skips avoid evaluator and preserve used, unused and estimates', () => {
  const calls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 2,
    maxDepth: 1,
    maxGroupSize: 20,
    workBudget: 5,
    expand: () => [
      candidate('last', 1, 4),
      candidate('expensive', 1, 6),
      candidate('cheap', 1, 2),
    ],
    evaluate: (next) => {
      calls.push(next.key);
      return { value: next.value, score: 1, cost: 2 };
    },
    compareScores: descending,
  });

  assert.deepEqual(calls, ['cheap']);
  assert.equal(result.work.budget, 5);
  assert.equal(result.work.used, 2);
  assert.equal(result.work.unused, 3);
  assert.ok(result.work.used <= result.work.budget);
  assert.deepEqual(result.work.skippedBudget, [
    {
      parentKey: 'empty',
      candidateKey: 'expensive',
      depth: 1,
      estimatedWork: 6,
      remainingWork: 3,
    },
    {
      parentKey: 'empty',
      candidateKey: 'last',
      depth: 1,
      estimatedWork: 4,
      remainingWork: 3,
    },
  ]);
});

test('actual evaluator work above W throws after the guarded call', () => {
  let calls = 0;
  assert.throws(
    () =>
      runStructuralBeam({
        root: { key: 'empty', value: 'empty', score: 0 },
        beamWidth: 1,
        maxDepth: 1,
        maxGroupSize: 2,
        workBudget: 5,
        expand: () => [candidate('over', 1, 2)],
        evaluate: () => {
          calls += 1;
          return { value: 'over', score: 1, cost: 6 };
        },
        compareScores: descending,
      }),
    /exceeded W/,
  );
  assert.equal(calls, 1);
});

test('actual evaluator work above estimate throws before used and bestAny update', () => {
  let evaluations = 0;
  let comparisons = 0;
  assert.throws(
    () =>
      runStructuralBeam({
        root: { key: 'empty', value: 'empty', score: 0 },
        beamWidth: 1,
        maxDepth: 1,
        maxGroupSize: 2,
        workBudget: 2,
        expand: () => [candidate('over-estimate', 1, 1)],
        evaluate: () => {
          evaluations += 1;
          return { value: 'over-estimate', score: 100, cost: 2 };
        },
        compareScores: (a, b) => {
          comparisons += 1;
          return descending(a, b);
        },
      }),
    /evaluator exceeded estimate for over-estimate: 2 > 1/,
  );

  assert.equal(evaluations, 1);
  // Comparator вызывается только после списания и создания node. Его отсутствие
  // подтверждает, что rejected candidate не прошёл путь обновления bestAny.
  assert.equal(comparisons, 0);
});

/** Создаёт минимальный валидный вход для focused validation tests. */
function validationOptions(): NumberOptions {
  return {
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 2,
    workBudget: 5,
    expand: () => [candidate('A')],
    evaluate: () => ({ value: 'A', score: 1, cost: 1 }),
    compareScores: descending,
  };
}

test('zero width, negative depth and invalid work estimates are rejected', () => {
  assert.throws(
    () => runStructuralBeam({ ...validationOptions(), beamWidth: 0 }),
    /beamWidth/,
  );
  assert.throws(
    () => runStructuralBeam({ ...validationOptions(), maxDepth: -1 }),
    /maxDepth/,
  );
  assert.throws(
    () =>
      runStructuralBeam({ ...validationOptions(), maxGroupSize: 0 }),
    /maxGroupSize/,
  );
  assert.throws(
    () =>
      runStructuralBeam({ ...validationOptions(), workBudget: -1 }),
    /workBudget/,
  );

  for (const estimate of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let calls = 0;
    assert.throws(
      () =>
        runStructuralBeam({
          ...validationOptions(),
          expand: () => [candidate('bad', 1, estimate)],
          evaluate: () => {
            calls += 1;
            return { value: 'bad', score: 1, cost: 1 };
          },
        }),
      /estimatedWork/,
    );
    assert.equal(calls, 0);
  }
});

test('K=20 is evaluated at the explicit limit without a hidden K1/K2 cap', () => {
  const calls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 20,
    workBudget: 3,
    expand: () => [
      candidate('twenty-one', 21),
      candidate('twenty', 20, 3),
    ],
    evaluate: (next) => {
      calls.push(next.key);
      return { value: next.value, score: 20, cost: 3 };
    },
    compareScores: descending,
  });

  assert.deepEqual(calls, ['twenty']);
  assert.equal(result.bestAny.candidateKey, 'twenty');
  assert.equal(result.bestAny.groupSize, 20);
  assert.equal(result.work.used, 3);
  assert.equal(result.work.unused, 0);
  assert.deepEqual(result.skippedGroupSize, [
    {
      parentKey: 'empty',
      candidateKey: 'twenty-one',
      depth: 1,
      groupSize: 21,
      maxGroupSize: 20,
    },
  ]);
});

test('input root, candidate arrays and candidate objects stay unchanged', () => {
  interface Value {
    labels: string[];
  }
  const root = {
    key: 'empty',
    value: { labels: ['empty'] },
    score: 0,
  };
  const candidates: StructuralBeamCandidate<Value>[] = [
    {
      key: 'B',
      value: { labels: ['B'] },
      groupSize: 2,
      estimatedWork: 2,
    },
    {
      key: 'A',
      value: { labels: ['A'] },
      groupSize: 1,
      estimatedWork: 1,
    },
  ];
  const snapshot = structuredClone({ root, candidates });
  const result = runStructuralBeam({
    root,
    beamWidth: 2,
    maxDepth: 1,
    maxGroupSize: 2,
    workBudget: 3,
    expand: () => candidates,
    evaluate: (next) => ({
      value: { labels: [...next.value.labels, 'evaluated'] },
      score: next.key === 'A' ? 2 : 1,
      cost: next.estimatedWork,
    }),
    compareScores: descending,
  });

  assert.deepEqual({ root, candidates }, snapshot);
  assert.deepEqual(
    result.bestPath.map((node) => node.value.labels),
    [['empty'], ['A', 'evaluated']],
  );
});

test('actual cost below estimate releases budget to the next candidate', () => {
  const calls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 2,
    workBudget: 5,
    expand: () => [
      candidate('second', 1, 4),
      candidate('first', 1, 4),
    ],
    evaluate: (next) => {
      calls.push(next.key);
      return {
        value: next.value,
        score: next.key === 'second' ? 2 : 1,
        cost: 1,
      };
    },
    compareScores: descending,
  });

  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(
    result.evaluated.map((node) => node.estimatedWork),
    [4, 4],
  );
  assert.deepEqual(
    result.evaluated.map((node) => node.cost),
    [1, 1],
  );
  assert.equal(result.work.used, 2);
  assert.equal(result.work.unused, 3);
  assert.deepEqual(result.work.skippedBudget, []);
  assert.equal(result.bestAny.candidateKey, 'second');
});

test('root stays bestAny and owns the path when every candidate is worse', () => {
  const calls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 100 },
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 2,
    workBudget: 2,
    expand: () => [candidate('A'), candidate('B')],
    evaluate: (next) => {
      calls.push(next.key);
      return {
        value: next.value,
        score: next.key === 'A' ? -50 : -10,
        cost: 1,
      };
    },
    compareScores: descending,
  });

  assert.deepEqual(calls, ['A', 'B']);
  assert.equal(result.bestAny, result.root);
  assert.deepEqual(result.bestPath, [result.root]);
  assert.deepEqual(depthKeys(result), [['empty'], ['B']]);
  assert.equal(result.work.used, 2);
});

test('maxDepth zero returns root without expand or evaluate', () => {
  let expansions = 0;
  let evaluations = 0;
  const result = runStructuralBeam({
    ...validationOptions(),
    maxDepth: 0,
    expand: () => {
      expansions += 1;
      return [candidate('A')];
    },
    evaluate: () => {
      evaluations += 1;
      return { value: 'A', score: 1, cost: 1 };
    },
  });

  assert.equal(expansions, 0);
  assert.equal(evaluations, 0);
  assert.equal(result.bestAny, result.root);
  assert.deepEqual(result.bestPath, [result.root]);
  assert.deepEqual(result.depths, [
    { depth: 0, nodes: [result.root] },
  ]);
  assert.deepEqual(result.evaluated, []);
  assert.deepEqual(result.work, {
    budget: 5,
    used: 0,
    unused: 5,
    skippedBudget: [],
  });
});

test('invalid evaluation costs and NaN comparator results are rejected', () => {
  for (const cost of [-1, Number.NaN]) {
    let evaluations = 0;
    assert.throws(
      () =>
        runStructuralBeam({
          ...validationOptions(),
          evaluate: () => {
            evaluations += 1;
            return { value: 'A', score: 1, cost };
          },
        }),
      /evaluation.cost/,
    );
    assert.equal(evaluations, 1);
  }

  let evaluations = 0;
  assert.throws(
    () =>
      runStructuralBeam({
        ...validationOptions(),
        evaluate: () => {
          evaluations += 1;
          return { value: 'A', score: 1, cost: 1 };
        },
        compareScores: () => Number.NaN,
      }),
    /compareScores/,
  );
  assert.equal(evaluations, 1);
});

test('measured expansion shares W and releases every unused estimate', () => {
  const estimates = new Map([
    ['empty', 5],
    ['A', 4],
    ['B', 3],
  ]);
  const evaluationCosts = new Map([
    ['A', 1],
    ['B', 1],
    ['A-next', 3],
    ['B-next', 2],
  ]);
  const expansionCalls: string[] = [];
  const evaluationCalls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 2,
    maxDepth: 2,
    maxGroupSize: 2,
    workBudget: 10,
    estimateExpansion: (parent) => estimates.get(parent.value) ?? 0,
    expand: (parent) => {
      expansionCalls.push(parent.value);
      if (parent.value === 'empty') {
        return {
          candidates: [candidate('B'), candidate('A')],
          cost: 1,
        };
      }
      return {
        candidates: [
          candidate(
            `${parent.value}-next`,
            1,
            parent.value === 'A' ? 3 : 2,
          ),
        ],
        cost: 1,
      };
    },
    evaluate: (next) => {
      evaluationCalls.push(next.key);
      return {
        value: next.value,
        score: next.key === 'B-next' ? 12 : 10,
        cost: evaluationCosts.get(next.key) ?? 0,
      };
    },
    compareScores: descending,
  });

  // A-next/B-next получают явные estimates 3/2 вместо helper default 1.
  for (const expansion of result.expansions.slice(1)) {
    const key = expansion.candidateKeys[0] ?? '';
    const proposal = key === 'A-next' ? 3 : 2;
    assert.equal(
      result.evaluated.find((node) => node.candidateKey === key)
        ?.estimatedWork,
      proposal,
    );
  }
  assert.deepEqual(expansionCalls, ['empty', 'A', 'B']);
  assert.deepEqual(evaluationCalls, ['A', 'B', 'A-next', 'B-next']);
  assert.equal(result.expansionWork, 3);
  assert.equal(result.evaluatorWork, 7);
  assert.equal(result.work.used, 10);
  assert.equal(result.work.unused, 0);
  assert.deepEqual(result.work.skippedBudget, []);
  assert.deepEqual(result.skippedExpansionBudget, []);
  assert.deepEqual(
    result.expansions.map((expansion) => ({
      parentKey: expansion.parentKey,
      depth: expansion.depth,
      estimatedWork: expansion.estimatedWork,
      cost: expansion.cost,
      candidateKeys: expansion.candidateKeys,
    })),
    [
      {
        parentKey: 'empty',
        depth: 1,
        estimatedWork: 5,
        cost: 1,
        candidateKeys: ['A', 'B'],
      },
      {
        parentKey: '["empty","A"]',
        depth: 2,
        estimatedWork: 4,
        cost: 1,
        candidateKeys: ['A-next'],
      },
      {
        parentKey: '["empty","B"]',
        depth: 2,
        estimatedWork: 3,
        cost: 1,
        candidateKeys: ['B-next'],
      },
    ],
  );
});

test('expansion estimate above remaining W skips expand without evaluation', () => {
  let estimates = 0;
  let expansions = 0;
  let evaluations = 0;
  const result = runStructuralBeam({
    ...validationOptions(),
    workBudget: 2,
    estimateExpansion: () => {
      estimates += 1;
      return 3;
    },
    expand: () => {
      expansions += 1;
      return { candidates: [candidate('A')], cost: 1 };
    },
    evaluate: () => {
      evaluations += 1;
      return { value: 'A', score: 1, cost: 1 };
    },
  });

  assert.equal(estimates, 1);
  assert.equal(expansions, 0);
  assert.equal(evaluations, 0);
  assert.deepEqual(result.expansions, []);
  assert.deepEqual(result.skippedExpansionBudget, [
    {
      parentKey: 'empty',
      depth: 1,
      estimatedWork: 3,
      remainingWork: 2,
    },
  ]);
  assert.equal(result.work.used, 0);
  assert.equal(result.work.unused, 2);
  assert.equal(result.evaluatorWork, 0);
  assert.equal(result.expansionWork, 0);
});

test('candidate estimates and skips use W left after measured expansion', () => {
  const calls: string[] = [];
  const result = runStructuralBeam({
    root: { key: 'empty', value: 'empty', score: 0 },
    beamWidth: 1,
    maxDepth: 1,
    maxGroupSize: 2,
    workBudget: 5,
    estimateExpansion: () => 2,
    expand: () => ({
      candidates: [
        candidate('expensive', 1, 4),
        candidate('cheap', 1, 3),
      ],
      cost: 2,
    }),
    evaluate: (next) => {
      calls.push(next.key);
      return { value: next.value, score: 1, cost: 3 };
    },
    compareScores: descending,
  });

  assert.deepEqual(calls, ['cheap']);
  assert.equal(result.expansionWork, 2);
  assert.equal(result.evaluatorWork, 3);
  assert.equal(result.work.used, 5);
  assert.equal(result.work.unused, 0);
  assert.deepEqual(result.work.skippedBudget, [
    {
      parentKey: 'empty',
      candidateKey: 'expensive',
      depth: 1,
      estimatedWork: 4,
      remainingWork: 0,
    },
  ]);
  assert.deepEqual(result.expansions, [
    {
      parentKey: 'empty',
      depth: 1,
      estimatedWork: 2,
      cost: 2,
      candidateKeys: ['cheap', 'expensive'],
    },
  ]);
});

test('invalid expansion measurements and actual cost above estimate throw', () => {
  for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let evaluations = 0;
    assert.throws(
      () =>
        runStructuralBeam({
          ...validationOptions(),
          estimateExpansion: () => 1,
          expand: () => ({ candidates: [], cost }),
          evaluate: () => {
            evaluations += 1;
            return { value: 'A', score: 1, cost: 1 };
          },
        }),
      /expansion.cost/,
    );
    assert.equal(evaluations, 0);
  }
  for (const estimate of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let expansions = 0;
    assert.throws(
      () =>
        runStructuralBeam({
          ...validationOptions(),
          estimateExpansion: () => estimate,
          expand: () => {
            expansions += 1;
            return { candidates: [], cost: 0 };
          },
        }),
      /expansion.estimate/,
    );
    assert.equal(expansions, 0);
  }
  assert.throws(
    () =>
      runStructuralBeam({
        ...validationOptions(),
        estimateExpansion: () => 2,
        expand: () => ({ candidates: [], cost: 3 }),
      }),
    /exceeded estimate: 3 > 2/,
  );

  const callbackError = new Error('proposer failed');
  assert.throws(
    () =>
      runStructuralBeam({
        ...validationOptions(),
        estimateExpansion: () => 1,
        expand: () => {
          throw callbackError;
        },
      }),
    (caught) => caught === callbackError,
  );
});

test('an empty measured expansion charges cost and records parent once', () => {
  let estimates = 0;
  let expansions = 0;
  const result = runStructuralBeam({
    ...validationOptions(),
    maxDepth: 4,
    workBudget: 5,
    estimateExpansion: () => {
      estimates += 1;
      return 3;
    },
    expand: () => {
      expansions += 1;
      return { candidates: [], cost: 2 };
    },
  });

  assert.equal(estimates, 1);
  assert.equal(expansions, 1);
  assert.deepEqual(result.evaluated, []);
  assert.deepEqual(result.expansions, [
    {
      parentKey: 'empty',
      depth: 1,
      estimatedWork: 3,
      cost: 2,
      candidateKeys: [],
    },
  ]);
  assert.equal(result.expansionWork, 2);
  assert.equal(result.evaluatorWork, 0);
  assert.equal(result.work.used, 2);
  assert.equal(result.work.unused, 3);
});

/** Создаёт measured duplicates fixture с точным callback order. */
function measuredDuplicateOptions(): {
  options: NumberOptions;
  events: string[];
} {
  const events: string[] = [];
  return {
    events,
    options: {
      root: { key: 'empty', value: 'empty', score: 0 },
      beamWidth: 2,
      maxDepth: 2,
      maxGroupSize: 2,
      workBudget: 20,
      estimateExpansion: (parent): number => {
        events.push(`estimate:${parent.value}`);
        return 2;
      },
      expand: (parent): StructuralBeamExpansionResult<string> => {
        events.push(`expand:${parent.value}`);
        if (parent.value === 'empty') {
          return {
            candidates: [
              candidate('tie-B'),
              candidate('tie-A'),
              candidate('tie-A'),
            ],
            cost: 1,
          };
        }
        if (parent.value === 'tie-A') {
          return {
            candidates: [candidate('leaf'), candidate('leaf')],
            cost: 1,
          };
        }
        return {
          candidates: [candidate('leaf'), candidate('B-leaf')],
          cost: 1,
        };
      },
      evaluate: (
        next,
        parent,
      ): StructuralBeamEvaluation<string, number> => {
        events.push(`evaluate:${parent.value}:${next.key}`);
        const scores = new Map([
          ['tie-A', 10],
          ['tie-B', 9],
          ['leaf', 11],
          ['B-leaf', 8],
        ]);
        return {
          value: next.value,
          score: scores.get(next.key) ?? 0,
          cost: 1,
        };
      },
      compareScores: descending,
    },
  };
}

/** Прогоняет measured duplicates и сохраняет точный callback order. */
function runMeasuredDuplicateFixture(): {
  result: NumberResult;
  events: string[];
} {
  const fixture = measuredDuplicateOptions();
  return {
    result: runStructuralBeam(fixture.options),
    events: fixture.events,
  };
}

test('measured duplicates preserve path, work and call order across runs', () => {
  const first = runMeasuredDuplicateFixture();
  const second = runMeasuredDuplicateFixture();
  const expectedEvents = [
    'estimate:empty',
    'expand:empty',
    'evaluate:empty:tie-A',
    'evaluate:empty:tie-B',
    'estimate:tie-A',
    'expand:tie-A',
    'estimate:tie-B',
    'expand:tie-B',
    'evaluate:tie-B:B-leaf',
    'evaluate:tie-A:leaf',
  ];

  assert.deepEqual(first.events, expectedEvents);
  assert.deepEqual(second.events, expectedEvents);
  assert.deepEqual(first.result, second.result);
  assert.deepEqual(first.result.bestPath.map(nodeName), [
    'empty',
    'tie-A',
    'leaf',
  ]);
  assert.deepEqual(
    first.result.evaluated.map(
      (node) => `${node.parentKey ?? ''}:${node.candidateKey ?? ''}`,
    ),
    [
      'empty:tie-A',
      'empty:tie-B',
      '["empty","tie-B"]:B-leaf',
      '["empty","tie-A"]:leaf',
    ],
  );
  assert.deepEqual(first.result.expansions[0]?.candidateKeys, [
    'tie-A',
    'tie-A',
    'tie-B',
  ]);
  assert.equal(first.result.expansions.length, 3);
  assert.equal(first.result.expansionWork, 3);
  assert.equal(first.result.evaluatorWork, 4);
  assert.equal(first.result.work.used, 7);
  assert.equal(first.result.work.unused, 13);
});

test('compact preserves measured duplicates, ties and expansion charging', () => {
  const fullFixture = measuredDuplicateOptions();
  const full = runStructuralBeam(fullFixture.options);
  const compactFixture = measuredDuplicateOptions();
  const compact = runStructuralBeam<
    string,
    number,
    string,
    { length: number }
  >({
    ...compactFixture.options,
    compact: {
      compactValue: (value) => ({ length: value.length }),
    },
  });
  const semantics = (
    node: Pick<
      NumberNode,
      | 'candidateKey'
      | 'depth'
      | 'score'
      | 'groupSize'
      | 'estimatedWork'
      | 'cost'
    >,
  ): unknown => ({
    candidateKey: node.candidateKey,
    depth: node.depth,
    score: node.score,
    groupSize: node.groupSize,
    estimatedWork: node.estimatedWork,
    cost: node.cost,
  });

  assert.deepEqual(compactFixture.events, fullFixture.events);
  assert.deepEqual(
    compact.evaluated.map(semantics),
    full.evaluated.map(semantics),
  );
  assert.deepEqual(
    compact.bestPath.map(semantics),
    full.bestPath.map(semantics),
  );
  assert.deepEqual(
    compact.depths.map((level) => ({
      depth: level.depth,
      nodes: level.nodes.map(semantics),
    })),
    full.depths.map((level) => ({
      depth: level.depth,
      nodes: level.nodes.map(semantics),
    })),
  );
  assertCompactBestAny(full.bestAny, compact.bestAny);
  assert.deepEqual(compact.work, full.work);
  assert.deepEqual(
    compact.expansions.map(expansionSemantics),
    full.expansions.map(expansionSemantics),
  );
  assert.equal(compact.expansionWork, full.expansionWork);
  assert.equal(compact.evaluatorWork, full.evaluatorWork);
});

interface HeavyBeamValue {
  name: string;
  pcm: Float64Array;
}

/** Строит одинаковый measured fixture с N-мерным payload для A/B. */
function heavyBeamOptions(beamWidth: number): {
  options: StructuralBeamOptions<HeavyBeamValue, number>;
  events: string[];
} {
  const value = (name: string): HeavyBeamValue => ({
    name,
    pcm: new Float64Array(128).fill(name.length),
  });
  const candidate = (
    name: string,
    groupSize = 1,
    estimatedWork = 1,
  ): StructuralBeamCandidate<HeavyBeamValue> => ({
    key: name,
    value: value(name),
    groupSize,
    estimatedWork,
  });
  const scores = new Map([
    ['A', 50],
    ['B', 40],
    ['C', 30],
    ['A+B', 60],
    ['A+C', 55],
    ['B+C', 90],
  ]);
  const expansions = new Map<
    string,
    StructuralBeamCandidate<HeavyBeamValue>[]
  >([
    ['empty', [candidate('A'), candidate('B'), candidate('C')]],
    ['A', [candidate('A+B', 2), candidate('A+C', 2)]],
    ['B', [candidate('B+C', 2)]],
    ['C', []],
  ]);
  const events: string[] = [];
  return {
    events,
    options: {
      root: { key: 'empty', value: value('empty'), score: 0 },
      beamWidth,
      maxDepth: 2,
      maxGroupSize: 2,
      workBudget: 20,
      estimateExpansion: (parent): number => {
        events.push(`estimate:${parent.value.name}`);
        return 0;
      },
      expand: (
        parent,
      ): StructuralBeamExpansionResult<HeavyBeamValue> => {
        events.push(`expand:${parent.value.name}`);
        return expansions.get(parent.value.name) ?? [];
      },
      evaluate: (
        next,
        parent,
      ): StructuralBeamEvaluation<HeavyBeamValue, number> => {
        events.push(`evaluate:${parent.value.name}:${next.key}`);
        const score = scores.get(next.key);
        assert.ok(score !== undefined);
        return { value: next.value, score, cost: 1 };
      },
      compareScores: descending,
    },
  };
}

/** Оставляет только search semantics для сравнения full и compact узлов. */
function beamNodeSemantics(
  node: Pick<
    StructuralBeamNode<HeavyBeamValue, number>,
    | 'candidateKey'
    | 'depth'
    | 'score'
    | 'groupSize'
    | 'estimatedWork'
    | 'cost'
  >,
): unknown {
  return {
    candidateKey: node.candidateKey,
    depth: node.depth,
    score: node.score,
    groupSize: node.groupSize,
    estimatedWork: node.estimatedWork,
    cost: node.cost,
  };
}

test('compact lifecycle matches full order, paths, width and work without heavy history', () => {
  for (const beamWidth of [1, 2]) {
    const fullFixture = heavyBeamOptions(beamWidth);
    const full = runStructuralBeam(fullFixture.options);
    const compactFixture = heavyBeamOptions(beamWidth);
    const compacted: string[] = [];
    const evaluatedHook: string[] = [];
    const legacyOrder: string[] = [];
    const compact = runStructuralBeam<
      HeavyBeamValue,
      number,
      HeavyBeamValue,
      { name: string }
    >({
      ...compactFixture.options,
      compact: {
        compactValue: (value, node) => {
          compacted.push(node.nodeKey);
          return { name: value.name };
        },
        onEvaluated: (node) => {
          evaluatedHook.push(node.nodeKey);
          const token = node.orderToken;
          assert.ok(token !== undefined);
          legacyOrder.push(stringifyOrderToken(token));
        },
      },
    });

    assert.deepEqual(compactFixture.events, fullFixture.events);
    assert.deepEqual(
      compact.evaluated.map(beamNodeSemantics),
      full.evaluated.map(beamNodeSemantics),
    );
    assert.deepEqual(
      compact.bestPath.map(beamNodeSemantics),
      full.bestPath.map(beamNodeSemantics),
    );
    assert.deepEqual(
      compact.depths.map((level) => ({
        depth: level.depth,
        nodes: level.nodes.map(beamNodeSemantics),
      })),
      full.depths.map((level) => ({
        depth: level.depth,
        nodes: level.nodes.map(beamNodeSemantics),
      })),
    );
    assertCompactBestAny(full.bestAny, compact.bestAny);
    assert.deepEqual(compact.work, full.work);
    assert.equal(compact.evaluatorWork, full.evaluatorWork);
    assert.equal(compact.expansionWork, full.expansionWork);
    assert.deepEqual(
      compact.expansions.map(expansionSemantics),
      full.expansions.map(expansionSemantics),
    );
    assert.deepEqual(
      compact.skippedExpansionBudget,
      full.skippedExpansionBudget,
    );
    assert.deepEqual(compact.skippedGroupSize, full.skippedGroupSize);
    assert.deepEqual(evaluatedHook, compacted.slice(1));
    assert.deepEqual(
      compacted.slice(1),
      compact.evaluated.map((node) => node.nodeKey),
    );
    assert.deepEqual(
      legacyOrder,
      full.evaluated.map((node) => node.nodeKey),
    );
    assert.ok(
      full.evaluated.every((node) => node.value.pcm.length === 128),
    );
    assert.ok(
      compact.evaluated.every(
        (node) =>
          Object.keys(node.value).length === 1 &&
          !('pcm' in node.value),
      ),
    );
    assert.equal(compact.bestAny.value.pcm.length, 128);
  }
});

interface DeepChainValue {
  depth: number;
}

/** Создаёт 24-уровневую цепь с длинными, но одинаковыми candidate keys. */
function deepChainOptions(): {
  options: StructuralBeamOptions<DeepChainValue, number>;
  events: string[];
} {
  const events: string[] = [];
  const candidate = (
    depth: number,
  ): StructuralBeamCandidate<DeepChainValue> => ({
    key: `${'x'.repeat(180)}:${String(depth).padStart(2, '0')}`,
    value: { depth },
    groupSize: 1,
    estimatedWork: 1,
  });
  return {
    events,
    options: {
      root: { key: 'deep-root', value: { depth: 0 }, score: 0 },
      beamWidth: 1,
      maxDepth: 24,
      maxGroupSize: 1,
      workBudget: 24,
      expand: (
        parent,
      ): StructuralBeamExpansionResult<DeepChainValue> => {
        const depth = parent.value.depth + 1;
        events.push(`expand:${depth}`);
        return [candidate(depth)];
      },
      evaluate: (
        next,
      ): StructuralBeamEvaluation<DeepChainValue, number> => {
        events.push(`evaluate:${next.value.depth}`);
        return {
          value: next.value,
          score: next.value.depth,
          cost: 1,
        };
      },
      compareScores: descending,
    },
  };
}

test('bounded identities preserve a depth24 chain, order, path and work', (t) => {
  const fullFixture = deepChainOptions();
  const full = runStructuralBeam(fullFixture.options);
  const compactFixture = deepChainOptions();
  const compact = runStructuralBeam<
    DeepChainValue,
    number,
    DeepChainValue,
    DeepChainValue
  >({
    ...compactFixture.options,
    compact: { compactValue: (value) => ({ ...value }) },
  });

  assert.deepEqual(compactFixture.events, fullFixture.events);
  assert.equal(full.evaluated.length, 24);
  assert.equal(full.bestPath.length, 25);
  assert.equal(full.bestAny.score, 24);
  assert.equal(full.bestAny.depth, 24);
  assert.equal(full.work.used, 24);
  assert.equal(full.work.unused, 0);
  assert.equal(full.evaluatorWork, 24);
  assert.equal(full.expansionWork, 0);
  assert.equal(
    new Set(full.evaluated.map((node) => node.nodeKey)).size,
    24,
  );
  for (const result of [full, compact]) {
    for (const node of result.evaluated) {
      assert.equal(node.candidateKey?.length, 183);
    }
    assert.equal(result.bestPath.length, 25);
    for (let index = 1; index < result.bestPath.length; index += 1) {
      const node = result.bestPath[index];
      const parent = result.bestPath[index - 1];
      assert.ok(node !== undefined && parent !== undefined);
      assert.equal(node.depth, index);
      assert.equal(node.parentKey, parent.nodeKey);
    }
    assert.deepEqual(result.work, full.work);
  }
  for (const node of compact.evaluated) {
    assert.ok(node.nodeKey.length <= 40, node.nodeKey);
    assert.ok((node.parentKey ?? '').length <= 40);
  }
  const semantics = (node: {
    candidateKey: string | null;
    depth: number;
    score: number;
    groupSize: number;
    estimatedWork: number;
    cost: number;
  }): unknown => ({
    candidateKey: node.candidateKey,
    depth: node.depth,
    score: node.score,
    groupSize: node.groupSize,
    estimatedWork: node.estimatedWork,
    cost: node.cost,
  });
  assert.deepEqual(
    compact.evaluated.map(semantics),
    full.evaluated.map(semantics),
  );
  assert.deepEqual(
    compact.bestPath.map(semantics),
    full.bestPath.map(semantics),
  );
  assertCompactBestAny(full.bestAny, compact.bestAny);
  const maxNodeKey = Math.max(
    ...compact.evaluated.map((node) => node.nodeKey.length),
  );
  const maxParentKey = Math.max(
    ...compact.evaluated.map((node) => node.parentKey?.length ?? 0),
  );
  t.diagnostic(
    `generic depth24: max node key=${maxNodeKey}, ` +
      `max parent key=${maxParentKey}, candidate key=183, evaluations=24`,
  );
});

/** Создаёт parent-first dedup regression B:a, A:z и общий X/Y. */
function parentFirstDedupOptions(): {
  options: NumberOptions;
  events: string[];
} {
  const events: string[] = [];
  const expansions = new Map<string, NumberCandidate[]>([
    ['empty', [candidate('A'), candidate('B')]],
    ['A', [candidate('z')]],
    ['B', [candidate('a')]],
    ['A:z', [candidate('X'), candidate('Y', 1, 10)]],
    ['B:a', [candidate('X'), candidate('Y', 1, 10)]],
  ]);
  return {
    events,
    options: {
      root: { key: 'empty', value: 'empty', score: 0 },
      beamWidth: 2,
      maxDepth: 3,
      maxGroupSize: 1,
      workBudget: 10,
      expand: (parent): StructuralBeamExpansionResult<string> =>
        expansions.get(parent.value) ?? [],
      evaluate: (
        next,
        parent,
      ): StructuralBeamEvaluation<string, number> => {
        events.push(`${parent.value}:${next.key}`);
        const value =
          parent.depth === 0
            ? next.key
            : `${parent.value}:${next.key}`;
        return {
          value,
          score: next.key === 'X' ? 100 : 10,
          cost: 1,
        };
      },
      compareScores: descending,
    },
  };
}

test('legacy full and compact keep parent-first dedup owner and budget skips', () => {
  const fullFixture = parentFirstDedupOptions();
  const full = runStructuralBeam(fullFixture.options);
  const compactFixture = parentFirstDedupOptions();
  const compact = runStructuralBeam<string, number, string, string>({
    ...compactFixture.options,
    compact: { compactValue: (value) => value },
  });
  const expectedCalls = ['empty:A', 'empty:B', 'B:a', 'A:z', 'A:z:X'];

  assert.deepEqual(fullFixture.events, expectedCalls);
  assert.deepEqual(compactFixture.events, expectedCalls);
  assert.deepEqual(full.evaluated.map(nodeName), [
    'A',
    'B',
    'a',
    'z',
    'X',
  ]);
  assert.deepEqual(compact.evaluated.map(nodeName), [
    'A',
    'B',
    'a',
    'z',
    'X',
  ]);
  for (const result of [full, compact]) {
    assert.equal(result.bestAny.value, 'A:z:X');
    assert.equal(result.bestAny.score, 100);
    assert.deepEqual(result.bestPath.map(nodeName), [
      'empty',
      'A',
      'z',
      'X',
    ]);
    assert.equal(result.work.used, 5);
    assert.equal(result.work.unused, 5);
    assert.equal(result.evaluatorWork, 5);
    assert.equal(result.expansionWork, 0);
    assert.equal(result.work.skippedBudget.length, 1);
    const skip = result.work.skippedBudget[0];
    assert.ok(skip !== undefined);
    assert.equal(skip.parentKey, result.bestAny.parentKey);
    assert.equal(skip.candidateKey, 'Y');
    assert.equal(skip.depth, 3);
    assert.equal(skip.estimatedWork, 10);
    assert.equal(skip.remainingWork, 5);
  }
  assertCompactBestAny(full.bestAny, compact.bestAny);
  assert.ok(
    full.evaluated.every((node) => node.orderToken === undefined),
  );
  assert.ok(
    compact.evaluated.every(
      (node) =>
        !('orderToken' in node) && !('candidateOrderToken' in node),
    ),
  );
});
