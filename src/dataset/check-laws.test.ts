/**
 * Тесты метрик закона и leave-one-out: пороги не должны зависеть от
 * проверяемого таргета, иначе проверка подтверждает сама себя.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeLawMetrics,
  pooledBodyClusters,
  evaluateHoldoutRules,
  type LawOsc,
  type HoldoutTarget,
} from './law-metrics';

function osc(partial: Partial<LawOsc>): LawOsc {
  return {
    role: 'sustain',
    freqBase: 50,
    freqStartToBase: 1.5,
    ampStartLevel: 0.5,
    decayDb20Sec: 0.1,
    ...partial,
  };
}

test('energy hierarchy uses level squared times decay', () => {
  const m = computeLawMetrics([
    osc({ freqBase: 50, ampStartLevel: 0.9 }),
    osc({ freqBase: 60, ampStartLevel: 0.8 }),
    osc({ freqBase: 70, ampStartLevel: 0.7 }),
    osc({ freqBase: 400, ampStartLevel: 0.1 }),
  ]);
  assert.equal(m.top3MaxFreq, 70);
  assert.ok(m.top3Share !== null && m.top3Share > 0.9);
});

test('sweep metrics split body and upper layers', () => {
  const m = computeLawMetrics([
    osc({ freqBase: 50, freqStartToBase: 1.8 }),
    osc({ freqBase: 300, freqStartToBase: 1.0 }),
    osc({ role: 'transient', freqBase: 3000, freqStartToBase: 1.02 }),
  ]);
  assert.equal(m.bodySweepMedian, 1.8);
  assert.ok(m.upperSweepMedian !== null && m.upperSweepMedian < 1.1);
});

test('pooled clusters require seed coverage', () => {
  const many = pooledBodyClusters([
    [45, 90],
    [46, 91],
    [47, 89],
    [45.5, 90.5],
  ]);
  assert.equal(many.count, 2);
  const oneSeed = pooledBodyClusters([[45, 200], [46], [47], [45.5]]);
  assert.equal(oneSeed.count, 1);
});

function target(
  slug: string,
  over: Partial<HoldoutTarget['metrics']> = {},
): HoldoutTarget {
  return {
    slug,
    metrics: {
      bodySweepMedian: 1.6,
      upperSweepMedian: 1.0,
      nearIntFraction: 0.2,
      top3Share: 0.8,
      top3MaxFreq: 80,
      sustainCount: 10,
      ...over,
    },
    bodyClusters: 3,
    bodyClusterSpread: 0.1,
  };
}

test('held-out target is judged by thresholds from the others', () => {
  const results = evaluateHoldoutRules([
    target('a'),
    target('b'),
    target('outlier', {
      bodySweepMedian: 0.7,
      upperSweepMedian: 2.5,
      nearIntFraction: 0.9,
      top3Share: 0.2,
      top3MaxFreq: 500,
    }),
  ]);
  for (const r of results) {
    if (r.name === 'bodyClusters') {
      assert.equal(r.heldOutPassed, 3);
    } else {
      assert.equal(
        r.heldOutPassed,
        2,
        `${r.name} must reject the outlier`,
      );
    }
  }
});

test('family members pass on held-out evaluation', () => {
  const results = evaluateHoldoutRules([
    target('a'),
    target('b'),
    target('c'),
  ]);
  for (const r of results) {
    assert.equal(r.heldOutPassed, 3, r.name);
  }
});
