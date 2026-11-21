/**
 * Проверки метрик закона на синтетических осцилляторах с известным
 * ответом. Здесь же фиксируем границы: что считается телом, как
 * считается энергия и как кластеризуется пул сидов.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeLawMetrics,
  pooledBodyClusters,
  type LawOsc,
} from './law-metrics';

function osc(partial: Partial<LawOsc>): LawOsc {
  return {
    role: 'sustain',
    freqBase: 50,
    freqStartToBase: 1,
    ampStartLevel: 0.1,
    decayDb20Sec: 0.1,
    ...partial,
  };
}

test('body sweep uses only low sustain oscillators', () => {
  const m = computeLawMetrics([
    osc({ freqBase: 50, freqStartToBase: 1.8 }),
    osc({ freqBase: 70, freqStartToBase: 1.6 }),
    osc({ freqBase: 300, freqStartToBase: 1.0 }),
    osc({ role: 'transient', freqBase: 3000, freqStartToBase: 1.02 }),
  ]);
  assert.ok(Math.abs((m.bodySweepMedian ?? 0) - 1.7) < 1e-9);
  assert.equal(m.upperSweepMedian, 1.01);
});

test('near-integer fraction counts cents around multiples of f0', () => {
  const m = computeLawMetrics([
    osc({ freqBase: 50 }),
    osc({ freqBase: 100 }), // точная октава: кратная
    osc({ freqBase: 151 }), // ×3.02: внутри 30 центов
    osc({ freqBase: 173 }), // ×3.46: вне
  ]);
  assert.equal(m.nearIntFraction, 0.75);
});

test('top-3 energy share and its frequency ceiling', () => {
  const m = computeLawMetrics([
    osc({ freqBase: 50, ampStartLevel: 0.9, decayDb20Sec: 0.2 }),
    osc({ freqBase: 60, ampStartLevel: 0.8, decayDb20Sec: 0.2 }),
    osc({ freqBase: 70, ampStartLevel: 0.7, decayDb20Sec: 0.2 }),
    osc({ freqBase: 400, ampStartLevel: 0.05, decayDb20Sec: 0.02 }),
  ]);
  const total =
    (0.9 ** 2 + 0.8 ** 2 + 0.7 ** 2) * 0.2 + 0.05 ** 2 * 0.02;
  assert.ok(
    m.top3Share !== null &&
      Math.abs(m.top3Share - (total - 0.00005) / total) < 1e-9,
  );
  assert.equal(m.top3MaxFreq, 70);
});

test('empty input yields nulls, not NaN', () => {
  const m = computeLawMetrics([]);
  assert.equal(m.bodySweepMedian, null);
  assert.equal(m.nearIntFraction, null);
  assert.equal(m.top3Share, null);
  assert.equal(m.sustainCount, 0);
});

test('pooled clusters require seed coverage, not just density', () => {
  // Два кластера: 45–47 Гц во всех четырёх сидах и 90 Гц только в одном.
  const perSeed = [
    [45, 90],
    [46, 45.5],
    [47, 46.5],
    [45.2, 46.8],
  ];
  const result = pooledBodyClusters(perSeed, 3);
  assert.equal(result.count, 1);
  assert.ok(result.maxSpread !== null && result.maxSpread < 0.1);
});

test('clusters split on gaps larger than six percent', () => {
  const perSeed = [
    [45, 60],
    [45.2, 60.5],
    [45.5, 61],
    [45.3, 60.2],
  ];
  const result = pooledBodyClusters(perSeed, 3);
  assert.equal(result.count, 2);
});
