import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SAMPLE_RATE } from './consts';
import { renderGroundTruth } from './dataset/ground-truth';
import { match, type MatchResult } from './match';
import { writeMatchArtifacts } from './match-metadata';
import { readWav } from './read-wav';
import { mapSynthConfigToVector } from './synth-config-to-vector';
import { writeWav } from './write-wav';

test('direct match returns and writes the complete run artifacts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'match-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const targetPath = join(dir, 'target.wav');
  const outputPath = join(dir, 'result.wav');
  const targetSamples = renderGroundTruth(
    [
      {
        freqHz: 50,
        level: 0.2,
        decayRate: 1,
        durationSec: 0.1,
      },
    ],
    0.1,
  );
  writeWav({
    samples: targetSamples,
    sampleRate: SAMPLE_RATE,
    filePath: targetPath,
  });
  const initialVector = mapSynthConfigToVector({
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 50,
          freqStart: 50,
          slope: 1,
          duration: 0.1,
          phase: 0,
        },
        ampEnv: {
          duration: 0.1,
          endLevel: Math.exp(-1),
          slope: 1,
          startLevel: 0.2,
        },
      },
    ],
  });

  const result = match({
    targetWavPath: targetPath,
    outputWavPath: outputPath,
    initialVector,
    maxIterations: 1,
  });
  const artifacts = writeMatchArtifacts(outputPath, result);
  const params = JSON.parse(
    readFileSync(artifacts.paramsPath, 'utf8'),
  ) as MatchResult['optimizedConfig'];
  const metadata = JSON.parse(
    readFileSync(artifacts.metadataPath, 'utf8'),
  ) as {
    wavFile: string;
    paramsFile: string;
    suppressionPercent: number;
    globalSuppressionPercent: number | null;
    history: MatchResult['history'];
    targetInfo: MatchResult['targetInfo'];
    bestVector: number[];
  };
  const wav = readWav(outputPath);

  assert.ok(result.history.length > 0);
  assert.equal(
    result.suppressionPercent,
    result.history[result.history.length - 1]?.suppressionPercent,
  );
  assert.ok(Number.isFinite(result.globalSuppressionPercent));
  assert.equal(result.targetInfo.numSamples, targetSamples.length);
  assert.deepEqual(params, result.optimizedConfig);
  assert.equal(metadata.wavFile, 'result.wav');
  assert.equal(metadata.paramsFile, 'result.wav.params.json');
  assert.equal(
    metadata.suppressionPercent,
    result.suppressionPercent,
  );
  assert.equal(
    metadata.globalSuppressionPercent,
    result.globalSuppressionPercent,
  );
  assert.deepEqual(metadata.history, result.history);
  assert.deepEqual(metadata.targetInfo, result.targetInfo);
  assert.deepEqual(metadata.bestVector, result.optimizedVector);
  assert.equal(wav.samples.length, targetSamples.length);
});
