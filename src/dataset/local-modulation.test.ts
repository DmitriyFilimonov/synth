import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeWav } from '../write-wav';
import { renderGroundTruth } from './ground-truth';
import {
  createLocalModulationFoldPartitions,
  filterSupportIntersectsRawHeldOut,
  screenLocalModulation,
  type LocalModulationResult,
} from './local-modulation';
import {
  renderLocalModulationMarkdown,
  runLocalModulationReport,
} from './local-modulation-report';
import { readJsonOrNull } from './shared';

const OPTIONS = {
  startSec: 0.08,
  endSec: 0.32,
  blockSec: 0.04,
  smoothing: 0.08,
} as const;
const DECAY = { decayRate: 1, durationSec: 0.2 } as const;

function singleTone(): Int16Array {
  return renderGroundTruth(
    [{ freqHz: 50, level: 0.5, ...DECAY }],
    0.5,
  );
}

function amplitudeModulated(
  modulation: (timeSec: number) => number,
): Int16Array {
  const out = new Int16Array(Math.floor(0.5 * 44100));
  let phase = 0;
  for (let index = 1; index < out.length; index += 1) {
    phase += (2 * Math.PI * 50) / 44100;
    const timeSec = index / 44100;
    const amplitude =
      0.35 * Math.exp(-5 * timeSec) * modulation(timeSec);
    out[index] = Math.round(32767 * amplitude * Math.sin(phase));
  }
  return out;
}

function requireOk(
  result: LocalModulationResult,
): asserts result is LocalModulationResult & {
  status: 'ok';
} {
  assert.equal(result.status, 'ok');
  assert.equal(result.folds.length, 4);
}

test('single decaying tone gives no pooled H1 win', () => {
  const result = screenLocalModulation(singleTone(), 44100, OPTIONS);
  requireOk(result);
  assert.ok(result.summary.pooledHeldOutRssGain < -0.01);
  assert.ok(result.summary.h0PooledHeldOutRss < 1e-8);
  assert.ok(result.summary.medianFoldRssGain < 0);
  assert.ok(result.summary.maxFoldRssGain < 0);
  assert.equal(result.descriptiveFit?.nuisance.sweepDeltaHz, 0);
});

test('pure exponential sweep is absorbed by shared D and phase', () => {
  const result = screenLocalModulation(
    renderGroundTruth(
      [
        {
          freqHz: 50,
          freqStartHz: 800,
          freqTauSec: 0.025,
          level: 0.5,
          ...DECAY,
        },
      ],
      0.5,
    ),
    44100,
    OPTIONS,
  );
  requireOk(result);
  assert.ok(result.summary.pooledHeldOutRssGain < -0.2);
  assert.ok(result.summary.h0PooledHeldOutRss < 1e-8);
  const nuisance = result.descriptiveFit?.nuisance;
  assert.ok(nuisance);
  assert.ok(Math.abs(nuisance.frequencyHz - 50) < 0.01);
  assert.ok(Math.abs(nuisance.sweepDeltaHz - 750) < 2);
  assert.ok(Math.abs(nuisance.sweepTauSec - 0.025) < 0.0001);
});

test('stationary 50/54 pair predicts held-out blocks better with H1', () => {
  const result = screenLocalModulation(
    renderGroundTruth(
      [
        { freqHz: 50, level: 0.25, ...DECAY },
        { freqHz: 54, level: 0.25, ...DECAY },
      ],
      0.5,
    ),
    44100,
    OPTIONS,
  );
  requireOk(result);
  assert.ok(result.summary.pooledHeldOutRssGain > 0.7);
  assert.equal(result.summary.positiveGainFoldCount, 4);
  for (const fold of result.folds) {
    assert.ok(fold.heldOutRssGain > 0.6);
    assert.equal(fold.h1Coefficients.length, 14);
  }
});

test('50/54 components with different decays retain held-out gain', () => {
  const result = screenLocalModulation(
    renderGroundTruth(
      [
        {
          freqHz: 50,
          level: 0.3,
          decayRate: 1,
          durationSec: 0.4,
        },
        {
          freqHz: 54,
          level: 0.3,
          decayRate: 3,
          durationSec: 0.2,
        },
      ],
      0.5,
    ),
    44100,
    OPTIONS,
  );
  requireOk(result);
  assert.ok(result.summary.pooledHeldOutRssGain > 0.85);
  assert.ok(result.summary.minFoldRssGain > 0.7);
  assert.ok(result.descriptiveFit);
  assert.ok(
    result.descriptiveFit.h1Rss < 0.2 * result.descriptiveFit.h0Rss,
  );
});

test('one local AM impulse has gain around its known location', () => {
  const result = screenLocalModulation(
    amplitudeModulated(
      (timeSec) =>
        1 + 0.7 * Math.exp(-0.5 * ((timeSec - 0.18) / 0.03) ** 2),
    ),
    44100,
    OPTIONS,
  );
  requireOk(result);
  assert.ok(result.summary.pooledHeldOutRssGain > 0.75);
  assert.ok(result.summary.minFoldRssGain > 0.45);
  const impulseFold = result.folds.find(
    (fold) => fold.startSec === 0.16,
  );
  assert.ok(impulseFold);
  assert.ok(impulseFold.heldOutRssGain > 0.8);
});

test('AM with changing speed generalizes and keeps trajectories', () => {
  const result = screenLocalModulation(
    amplitudeModulated(
      (timeSec) =>
        1 +
        0.45 *
          Math.sin(2 * Math.PI * (2 * timeSec + 10 * timeSec ** 2)),
    ),
    44100,
    OPTIONS,
  );
  requireOk(result);
  assert.ok(result.summary.pooledHeldOutRssGain > 0.7);
  assert.ok(result.summary.minFoldRssGain > 0.6);
  const trajectory = result.descriptiveFit?.trajectory ?? [];
  assert.equal(trajectory.length, 7);
  const amplitudes = trajectory.map((point) => point.h1Amplitude);
  assert.ok(Math.max(...amplitudes) - Math.min(...amplitudes) > 0.01);
  assert.ok(
    result.summary.maxFoldRssGain - result.summary.minFoldRssGain >
      0.15,
  );
  const amplitudeAt200 = trajectory.find(
    (point) => Math.abs(point.timeSec - 0.2) < 1e-12,
  );
  const amplitudeAt240 = trajectory.find(
    (point) => Math.abs(point.timeSec - 0.24) < 1e-12,
  );
  assert.ok(amplitudeAt200);
  assert.ok(amplitudeAt240);
  assert.ok(
    amplitudeAt240.h1Amplitude - amplitudeAt200.h1Amplitude > 0.02,
  );
  for (const point of trajectory) {
    assert.ok(point.h1TotalFrequencyHz !== null);
    assert.ok(Math.abs(point.h1TotalFrequencyHz ?? 0) < 100);
  }
});

test('fold splits purge causal support for 40 and 30 ms blocks', () => {
  const samples = singleTone();
  for (const blockSec of [0.04, 0.03]) {
    const partitions = createLocalModulationFoldPartitions(
      samples,
      44100,
      { ...OPTIONS, blockSec },
    );
    const expectedCount = blockSec === 0.04 ? 4 : 6;
    assert.equal(partitions.length, expectedCount);
    const last = partitions[partitions.length - 1];
    assert.ok(last);
    assert.equal(last.index, expectedCount);
    assert.ok(
      Math.abs(last.endSec - (blockSec === 0.04 ? 0.28 : 0.29)) <
        1e-12,
    );
    for (const partition of partitions) {
      assert.equal(partition.filterPastSamples, 189);
      assert.equal(partition.filterFutureSamples, 0);
      assert.equal(
        partition.filterPastSamples +
          partition.filterFutureSamples +
          1,
        190,
      );
      assert.ok(partition.heldOutIndices.length > 0);
      assert.ok(partition.trainIndices.length >= 8);
      assert.ok(partition.purgedTrainIndices.length > 0);
      for (const rawIndex of partition.trainRawSampleIndices) {
        assert.equal(
          filterSupportIntersectsRawHeldOut(
            rawIndex,
            partition.rawHeldOutStartIndex,
            partition.rawHeldOutEndIndex,
            partition.filterPastSamples,
            partition.filterFutureSamples,
          ),
          false,
        );
      }
      for (const rawIndex of partition.purgedTrainRawSampleIndices) {
        assert.equal(
          filterSupportIntersectsRawHeldOut(
            rawIndex,
            partition.rawHeldOutStartIndex,
            partition.rawHeldOutEndIndex,
            partition.filterPastSamples,
            partition.filterFutureSamples,
          ),
          true,
        );
      }
      assert.ok(
        partition.purgedTrainRawSampleIndices.some(
          (rawIndex) => rawIndex >= partition.rawHeldOutEndIndex,
        ),
      );
      for (const rawIndex of partition.heldOutRawSampleIndices) {
        assert.ok(rawIndex >= partition.rawHeldOutStartIndex);
        assert.ok(rawIndex < partition.rawHeldOutEndIndex);
      }
    }
  }
  const first = createLocalModulationFoldPartitions(
    samples,
    44100,
    OPTIONS,
  )[0];
  assert.ok(first);
  assert.equal(
    filterSupportIntersectsRawHeldOut(
      first.rawHeldOutStartIndex - 1,
      first.rawHeldOutStartIndex,
      first.rawHeldOutEndIndex,
      189,
      0,
    ),
    false,
  );
  assert.equal(
    filterSupportIntersectsRawHeldOut(
      first.rawHeldOutStartIndex - 1,
      first.rawHeldOutStartIndex,
      first.rawHeldOutEndIndex,
      189,
      1,
    ),
    true,
  );
  assert.equal(
    filterSupportIntersectsRawHeldOut(
      first.rawHeldOutEndIndex + 188,
      first.rawHeldOutStartIndex,
      first.rawHeldOutEndIndex,
      189,
    ),
    true,
  );
  assert.equal(
    filterSupportIntersectsRawHeldOut(
      first.rawHeldOutEndIndex + 189,
      first.rawHeldOutStartIndex,
      first.rawHeldOutEndIndex,
      189,
    ),
    false,
  );
});

test('silence and short input return explicit zero-metric states', () => {
  const silence = screenLocalModulation(
    new Int16Array(22050),
    44100,
    OPTIONS,
  );
  assert.equal(silence.status, 'silence');
  assert.equal(silence.folds.length, 0);
  assert.equal(silence.summary.pooledHeldOutRssGain, 0);
  assert.equal(silence.summary.h0PooledHeldOutRss, 0);
  assert.equal(silence.descriptiveFit, null);
  const short = screenLocalModulation(
    new Int16Array(100),
    44100,
    OPTIONS,
  );
  assert.equal(short.status, 'insufficient-data');
  assert.equal(short.analysisEndSec, 0.08);
  assert.throws(() =>
    screenLocalModulation(new Int16Array(22050), 0, OPTIONS),
  );
  assert.throws(() =>
    screenLocalModulation(new Int16Array(22050), 44100, {
      ...OPTIONS,
      blockSec: 0.01,
    }),
  );
});

test('all folds below train minimum return insufficient-data', () => {
  const samples = new Int16Array(32).fill(1000);
  const partitions = createLocalModulationFoldPartitions(
    samples,
    100,
    OPTIONS,
  );
  assert.equal(partitions.length, 4);
  for (const partition of partitions) {
    assert.ok(partition.heldOutIndices.length > 0);
    assert.ok(partition.trainIndices.length < 8);
  }
  const result = screenLocalModulation(samples, 100, OPTIONS);
  assert.equal(result.status, 'insufficient-data');
  assert.equal(result.folds.length, 0);
  assert.equal(result.summary.h0PooledHeldOutRss, 0);
  assert.equal(result.summary.h1PooledHeldOutRss, 0);
  assert.equal(result.descriptiveFit, null);
});

test('held-out values cannot change coefficients or train normalization', () => {
  const samples = renderGroundTruth(
    [
      { freqHz: 50, level: 0.25, ...DECAY },
      { freqHz: 54, level: 0.25, ...DECAY },
    ],
    0.5,
  );
  const before = screenLocalModulation(samples, 44100, OPTIONS);
  requireOk(before);
  const changed = Int16Array.from(samples);
  for (let index = 0; index < changed.length; index += 1) {
    const timeSec = index / 44100;
    if (timeSec >= 0.12 && timeSec < 0.16) {
      changed[index] = -(samples[index] ?? 0);
    }
  }
  const after = screenLocalModulation(changed, 44100, OPTIONS);
  requireOk(after);
  const originalFold = before.folds.find((fold) => fold.index === 1);
  const changedFold = after.folds.find((fold) => fold.index === 1);
  assert.ok(originalFold);
  assert.ok(changedFold);
  assert.equal(originalFold.startSec, 0.12);
  assert.equal(changedFold.startSec, 0.12);
  assert.ok(originalFold.purgedTrainSampleCount > 0);
  assert.equal(
    changedFold.purgedTrainSampleCount,
    originalFold.purgedTrainSampleCount,
  );
  assert.deepEqual(changedFold.nuisance, originalFold.nuisance);
  assert.deepEqual(
    changedFold.h0Coefficients,
    originalFold.h0Coefficients,
  );
  assert.deepEqual(
    changedFold.h1Coefficients,
    originalFold.h1Coefficients,
  );
  assert.equal(changedFold.h0TrainRss, originalFold.h0TrainRss);
  assert.equal(changedFold.h1TrainRss, originalFold.h1TrainRss);
  assert.equal(
    changedFold.h0HeldOutCenterPrediction,
    originalFold.h0HeldOutCenterPrediction,
  );
  assert.equal(
    changedFold.h1HeldOutCenterPrediction,
    originalFold.h1HeldOutCenterPrediction,
  );
  assert.ok(
    Math.abs(changedFold.h1HeldOutRss - originalFold.h1HeldOutRss) >
      1e-4,
  );
});

test('screening is deterministic and report writes only JSON and Markdown', async () => {
  const samples = singleTone();
  const first = screenLocalModulation(samples, 44100, OPTIONS);
  const second = screenLocalModulation(samples, 44100, OPTIONS);
  assert.deepEqual(second, first);
  const root = mkdtempSync(join(tmpdir(), 'local-modulation-'));
  const wavPath = join(root, 'single.wav');
  const outDir = join(root, 'out');
  writeWav({ samples, sampleRate: 44100, filePath: wavPath });
  const report = await runLocalModulationReport(
    [wavPath],
    outDir,
    OPTIONS,
  );
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0]?.result.status, 'ok');
  assert.deepEqual(readdirSync(outDir).sort(), [
    'report.json',
    'report.md',
  ]);
  const saved = await readJsonOrNull<typeof report>(
    join(outDir, 'report.json'),
  );
  assert.deepEqual(saved, report);
  const markdown = renderLocalModulationMarkdown(report);
  assert.ok(markdown.includes('common-nuisance'));
  assert.ok(markdown.includes('Gain'));
  assert.equal('Q1' in report, false);
  assert.equal('accepted' in report, false);
});
