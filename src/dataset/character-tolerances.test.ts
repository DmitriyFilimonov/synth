import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  renderCharacterTolerancesMarkdown,
  summarizeCharacterTolerances,
  toleranceMetric,
  type CharacterToleranceReport,
} from './character-tolerances';
import type {
  CharacterSpreadReport,
  SpreadStats,
  TargetCharacterSpread,
} from './character-spread';

/** Создаёт готовую тройку медиана/p90/max для численного контроля. */
function stats(
  median: number,
  p90: number,
  max: number,
): SpreadStats {
  return { median, p90, max };
}

/** Минимальный target-level вход для проверки сводки допусков. */
function target(
  slug: string,
  f0P90: number,
  bandP90: number,
): TargetCharacterSpread {
  return {
    slug,
    seeds: [1, 2],
    f0AbsCents: stats(f0P90 / 2, f0P90, f0P90 * 2),
    decayAbsMs: stats(1, 2, 3),
    bands: [
      {
        region: 'body',
        band: 'sub',
        referenceRegionShareMedian: slug === 'a' ? 0.5 : 0.7,
        referenceRegionRelativeEnergyMedian: slug === 'a' ? 0.1 : 0.3,
        absDeltaDb: stats(bandP90 / 2, bandP90, bandP90 + 1),
      },
    ],
  };
}

test('tolerance metric summarizes target-level p90 without a verdict', () => {
  assert.deepEqual(
    toleranceMetric([stats(5, 10, 20), stats(15, 30, 40)]),
    {
      medianTargetP90: 20,
      p90TargetP90: 28,
      maxTargetP90: 30,
      maxObserved: 40,
    },
  );
  assert.deepEqual(toleranceMetric([]), {
    medianTargetP90: null,
    p90TargetP90: null,
    maxTargetP90: null,
    maxObserved: null,
  });
});

test('report keeps band energy context and labels candidates as not agreed', () => {
  const spread: CharacterSpreadReport = {
    version: 1,
    createdAt: '2026-11-22T00:00:00.000Z',
    phaseModel: 'integral',
    codeRevision: 'test',
    runs: [],
    targets: [target('a', 10, 2), target('b', 30, 6)],
  };
  const summary = summarizeCharacterTolerances(spread);
  assert.equal(summary.targetCount, 2);
  assert.deepEqual(summary.f0Cents, {
    medianTargetP90: 20,
    p90TargetP90: 28,
    maxTargetP90: 30,
    maxObserved: 60,
  });
  const band = summary.bands[0];
  assert.ok(band);
  assert.equal(band.medianTargetP90, 4);
  assert.ok(Math.abs((band.p90TargetP90 ?? 0) - 5.6) < 1e-12);
  assert.equal(band.maxTargetP90, 6);
  assert.equal(band.maxObserved, 7);
  assert.equal(band.referenceRegionShareMedian, 0.6);
  const report: CharacterToleranceReport = {
    createdAt: '2026-11-22T00:00:00.000Z',
    ...summary,
  };
  const markdown = renderCharacterTolerancesMarkdown(report);
  assert.match(markdown, /не готовые допуски/);
  assert.match(markdown, /\| a \| 1, 2 \|/);
  assert.match(markdown, /60.000%/);
  assert.ok(
    Math.abs((band.referenceRegionRelativeEnergyMedian ?? 0) - 0.2) <
      1e-12,
  );
});
