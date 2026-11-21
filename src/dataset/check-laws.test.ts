/**
 * Проверки метрик и leave-one-out: пороги обязаны строиться без
 * проверяемого таргета, иначе тест подтверждает сам себя.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateTarget,
  checkTarget,
  computeRunMetrics,
  deriveThresholds,
  leaveOneOut,
  type LawOsc,
} from './check-laws';

function osc(partial: Partial<LawOsc>): LawOsc {
  return {
    role: 'sustain',
    freqBase: 50,
    freqStartToBase: 1.5,
    ampStartLevel: 0.5,
    decaySecToDb: { db20: 0.1 },
    ...partial,
  };
}

test('energy hierarchy uses level squared times decay', () => {
  const m = computeRunMetrics([
    osc({ freqBase: 50, ampStartLevel: 0.9 }),
    osc({ freqBase: 60, ampStartLevel: 0.8 }),
    osc({ freqBase: 70, ampStartLevel: 0.7 }),
    osc({ freqBase: 400, ampStartLevel: 0.1 }),
  ]);
  assert.equal(m.top3MaxFreq, 70);
  assert.ok(m.top3Share !== null && m.top3Share > 0.9);
});

test('near-integer fraction counts partials within 30 cents', () => {
  const m = computeRunMetrics([
    osc({ freqBase: 50 }),
    osc({ freqBase: 100 }), // точная кратная
    osc({ freqBase: 150 }), // точная кратная
    osc({ freqBase: 173 }), // ×3.46 — не кратная
  ]);
  assert.equal(m.nearIntegerFraction, 0.75);
});

test('sweep metrics split body and upper layers', () => {
  const m = computeRunMetrics([
    osc({ freqBase: 50, freqStartToBase: 1.8 }),
    osc({ freqBase: 90, freqStartToBase: 1.4 }),
    osc({ freqBase: 300, freqStartToBase: 1.0 }),
    osc({ role: 'transient', freqBase: 3000, freqStartToBase: 1.02 }),
  ]);
  assert.equal(m.lowSweepMedian, 1.8);
  assert.equal(m.highSweepMedian, 1.02);
});

test('held-out target does not set its own thresholds', () => {
  const train = ['a', 'b', 'c'].map((slug) =>
    aggregateTarget(slug, [
      {
        top3Share: 0.8,
        top3MaxFreq: 80,
        lowSweepMedian: 1.5,
        highSweepMedian: 1.0,
        nearIntegerFraction: 0.2,
      },
    ]),
  );
  const outlier = aggregateTarget('outlier', [
    {
      top3Share: 0.2,
      top3MaxFreq: 500,
      lowSweepMedian: 0.7,
      highSweepMedian: 2.0,
      nearIntegerFraction: 0.9,
    },
  ]);
  const rows = leaveOneOut([...train, outlier]);
  const outlierRow = rows.find((r: { slug: string }) => r.slug === 'outlier');
  assert.ok(
    outlierRow !== undefined && outlierRow.violations.length >= 4,
  );
  // Эталоны не должны нарушать пороги, построенные с учётом выброса:
  // выброс не входит в их обучающую часть? Нет, входит — поэтому
  // здесь проверяем другое: пороги для выброса строятся по эталонам.
  const thresholds = deriveThresholds(train);
  assert.equal(thresholds.minTop3Share, 0.8);
  assert.equal(thresholds.maxTop3Freq, 80);
  assert.ok(checkTarget(outlier, thresholds).length >= 4);
});

test('a target inside the family passes leave-one-out', () => {
  const targets = ['a', 'b', 'c'].map((slug) =>
    aggregateTarget(slug, [
      {
        top3Share: 0.8,
        top3MaxFreq: 80,
        lowSweepMedian: 1.5,
        highSweepMedian: 1.0,
        nearIntegerFraction: 0.2,
      },
    ]),
  );
  const rows: { slug: string; violations: string[] }[] = leaveOneOut(targets);
  for (const row: { slug: string; violations: string[] } of rows) {
    assert.deepEqual(row.violations, []);
  }
});
