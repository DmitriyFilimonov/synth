import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runStructuralBeam,
  type StructuralBeamCandidate,
  type StructuralBeamNode,
  type StructuralBeamOptions,
  type StructuralBeamResult,
} from './structural-beam';

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
      candidate('twenty', 20),
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
