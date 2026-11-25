import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareOrderTokens,
  jsonArrayOrderToken,
  jsonStringOrderToken,
  orderTokenFromRaw,
  orderTokenStats,
  stringifyOrderToken,
  type StructuralKeyOrderToken,
} from './structural-key-order';

/** Возвращает знак legacy JS string comparison без locale-dependent правил. */
function compareRaw(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Сравнивает знаки comparator results, не требуя одинаковую дельту. */
function sign(value: number): number {
  return Math.sign(value);
}

const RAW_CASES = [
  '',
  'a',
  'aa',
  'prefix',
  'prefix\\"',
  '"',
  '\\',
  '\\\\',
  '\b\t\n\f\r\0\v',
  '😀',
  '\ud800',
  '\udfff',
  'x\ud800y',
  'a\u2028b',
] as const;

test('JSON token escaping matches JSON.stringify for raw edge cases', () => {
  for (const raw of RAW_CASES) {
    const token = jsonStringOrderToken(orderTokenFromRaw(raw));
    assert.equal(
      stringifyOrderToken(token),
      JSON.stringify(raw),
      raw,
    );
    assert.equal(compareOrderTokens(token, token), 0);
  }
});

test('recursive generic and native tokens exactly match small legacy strings', () => {
  const generic: Array<{
    raw: string;
    token: StructuralKeyOrderToken;
  }> = [];
  const native: Array<{
    raw: string;
    token: StructuralKeyOrderToken;
  }> = [];
  let genericRaw = 'root"\\\n😀';
  let genericToken = orderTokenFromRaw(genericRaw);
  let nativeRaw = genericRaw;
  let nativeToken = genericToken;

  const genericCases = ['', 'a', '"', '\\', '\n', '😀'];
  for (const candidate of genericCases) {
    const candidateToken = orderTokenFromRaw(candidate);
    genericRaw = JSON.stringify([genericRaw, candidate]);
    genericToken = jsonArrayOrderToken([
      jsonStringOrderToken(genericToken),
      jsonStringOrderToken(candidateToken),
    ]);
    assert.equal(stringifyOrderToken(genericToken), genericRaw);
    generic.push({ raw: genericRaw, token: genericToken });
  }
  const nativeCases = ['prefix\\"', '\\', '\0', '\ud800'];
  for (const [depth, candidate] of nativeCases.entries()) {
    const slots = [depth, depth + 1];
    const shapeKeys = [candidate, `shape:${candidate}`];
    const legacyCandidate = JSON.stringify([
      nativeRaw,
      slots,
      shapeKeys,
    ]);
    const candidateOrderToken = jsonArrayOrderToken([
      jsonStringOrderToken(nativeToken),
      orderTokenFromRaw(JSON.stringify(slots)),
      orderTokenFromRaw(JSON.stringify(shapeKeys)),
    ]);
    assert.equal(
      stringifyOrderToken(candidateOrderToken),
      legacyCandidate,
    );
    nativeRaw = JSON.stringify([nativeRaw, legacyCandidate]);
    nativeToken = jsonArrayOrderToken([
      jsonStringOrderToken(nativeToken),
      jsonStringOrderToken(candidateOrderToken),
    ]);
    assert.equal(stringifyOrderToken(nativeToken), nativeRaw);
    native.push({ raw: nativeRaw, token: nativeToken });
  }

  for (const family of [generic, native]) {
    for (const [aIndex, a] of family.entries()) {
      for (const [bIndex, b] of family.entries()) {
        assert.equal(
          sign(compareOrderTokens(a.token, b.token)),
          compareRaw(a.raw, b.raw),
          `${aIndex}/${bIndex}`,
        );
        assert.equal(
          compareOrderTokens(a.token, b.token) === 0,
          a.raw === b.raw,
        );
      }
    }
  }
});

test('backslash RLE stays flat and compares equal deep tokens without expansion', () => {
  let legacy = '\\';
  let token = orderTokenFromRaw(legacy);
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = orderTokenFromRaw('\\');
    token = jsonArrayOrderToken([
      jsonStringOrderToken(token),
      jsonStringOrderToken(candidate),
    ]);
    if (depth < 5) {
      legacy = JSON.stringify([legacy, '\\']);
      assert.equal(stringifyOrderToken(token), legacy);
    }
    const stats = orderTokenStats(token);
    assert.ok(stats.nodes <= 10 + 10 * depth);
    assert.ok(stats.textUnits <= 16 + 8 * depth);
  }
  const stats = orderTokenStats(token);
  assert.ok(stats.maxEscapeDepth >= 16);
  assert.equal(compareOrderTokens(token, token), 0);
});

test('native shared rope keeps unique raw text bounded at depth20', () => {
  let legacy = 'native-root';
  let token = orderTokenFromRaw(legacy);
  for (let depth = 1; depth <= 20; depth += 1) {
    const candidate = jsonArrayOrderToken([
      jsonStringOrderToken(token),
      orderTokenFromRaw('[0]'),
      orderTokenFromRaw('["shape"]'),
    ]);
    token = jsonArrayOrderToken([
      jsonStringOrderToken(token),
      jsonStringOrderToken(candidate),
    ]);
    if (depth <= 3) {
      const legacyCandidate = JSON.stringify([
        legacy,
        [0],
        ['shape'],
      ]);
      legacy = JSON.stringify([legacy, legacyCandidate]);
      assert.equal(stringifyOrderToken(token), legacy);
    }
    const stats = orderTokenStats(token);
    assert.ok(stats.nodes <= 20 + 20 * depth);
    assert.ok(stats.textUnits <= 50 + 100 * depth);
    assert.ok(stats.maxEscapeDepth <= 2 * depth + 2);
  }
  assert.equal(compareOrderTokens(token, token), 0);
});

/** Строит generic parent с глубоким JSON/backslash/unicode nesting. */
function genericDeepParent(depth: number): StructuralKeyOrderToken {
  let token = orderTokenFromRaw('root"\\\n😀');
  for (let index = 0; index < depth; index += 1) {
    const candidate = orderTokenFromRaw(
      index % 2 === 0 ? '\\' : `candidate:${index}`,
    );
    token = jsonArrayOrderToken([
      jsonStringOrderToken(token),
      jsonStringOrderToken(candidate),
    ]);
  }
  return token;
}

/** Строит native parent, где candidate повторяет parent перед slots/shapes. */
function nativeDeepParent(depth: number): StructuralKeyOrderToken {
  let token = orderTokenFromRaw('native-root');
  for (let index = 0; index < depth; index += 1) {
    const candidate = jsonArrayOrderToken([
      jsonStringOrderToken(token),
      orderTokenFromRaw(JSON.stringify([index % 3])),
      orderTokenFromRaw(JSON.stringify([`shape:${index}\\"`])),
    ]);
    token = jsonArrayOrderToken([
      jsonStringOrderToken(token),
      jsonStringOrderToken(candidate),
    ]);
  }
  return token;
}

test('generic deep shared parent reaches suffix order with distinct token objects', () => {
  const parent = genericDeepParent(24);
  const left = jsonArrayOrderToken([
    jsonStringOrderToken(parent),
    jsonStringOrderToken(orderTokenFromRaw('a')),
  ]);
  const right = jsonArrayOrderToken([
    jsonStringOrderToken(parent),
    jsonStringOrderToken(orderTokenFromRaw('b')),
  ]);
  const expected = compareRaw(
    JSON.stringify('a'),
    JSON.stringify('b'),
  );

  assert.notEqual(left, right);
  assert.ok(orderTokenStats(left).nodes > 24);
  assert.equal(Math.sign(compareOrderTokens(left, right)), expected);
  assert.equal(Math.sign(compareOrderTokens(right, left)), -expected);
});

test('native deep shared parent reaches shape suffix order with distinct token objects', () => {
  const parent = nativeDeepParent(24);
  const left = jsonArrayOrderToken([
    jsonStringOrderToken(parent),
    orderTokenFromRaw('[4]'),
    orderTokenFromRaw('["z"]'),
  ]);
  const right = jsonArrayOrderToken([
    jsonStringOrderToken(parent),
    orderTokenFromRaw('[4]'),
    orderTokenFromRaw('["a"]'),
  ]);
  const expected = compareRaw(
    JSON.stringify([4, ['z']]),
    JSON.stringify([4, ['a']]),
  );

  assert.notEqual(left, right);
  assert.ok(orderTokenStats(left).nodes > 24);
  assert.equal(Math.sign(compareOrderTokens(left, right)), expected);
  assert.equal(Math.sign(compareOrderTokens(right, left)), -expected);
});
