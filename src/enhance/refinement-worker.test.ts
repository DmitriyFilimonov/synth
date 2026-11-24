import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchWithWorker } from '../match-worker';
import { createWaveForm } from '../optimize/evaluate';
import { writeWav } from '../write-wav';
import { readWav } from '../read-wav';
import { createSynth } from '../synth';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../consts';
import { mapSynthConfigToVectorWithFixedDelays } from '../synth-config-to-vector';

const SAMPLE_RATE = 2000;
const NUM_SAMPLES = 1024;

function vector(volume: number): number[] {
  return [1, 0.001, 0.002, 0.4, 0.5, 0.25, 0.4, 0.1, 0.5, volume];
}

test('worker applies C4 anchors and renders the returned patch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'synth-c4-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const targetWavPath = join(dir, 'target.wav');
  const outputWavPath = join(dir, 'result.wav');
  const disabled = vector(0.2).map((value, index) =>
    index === 0 ? 0 : value,
  );
  const initial = [...vector(0.2), ...disabled];
  const targetVector = [...vector(0.4), ...disabled];
  const target = createWaveForm(
    targetVector,
    SAMPLE_RATE,
    NUM_SAMPLES,
    { phaseModel: 'integral' },
  );
  writeWav({
    samples: Int16Array.from(target, (sample) => Math.round(sample)),
    sampleRate: SAMPLE_RATE,
    filePath: targetWavPath,
  });
  assert.equal(readWav(targetWavPath).samples.length, NUM_SAMPLES);

  const result = await matchWithWorker({
    targetWavPath,
    outputWavPath,
    initialVector: initial,
    sampleRate: SAMPLE_RATE,
    maxIterations: 1,
    seed: 7,
    onLog: () => {},
    config: {
      phaseModel: 'integral',
      frozenParameterIndices: [1, 2, 11, 12],
      preserveOscillatorFlags: true,
      earlyExitSuppression: 101,
      saInitialTemp: 0,
      maxRelocationAttemptsPerOsc: 0,
      restartSchedule: [
        { startStep: 0.0025, minStep: 0.0001, label: 'C4_TEST' },
      ],
    },
  });

  assert.equal(result.bestVector[1], initial[1]);
  assert.equal(result.bestVector[2], initial[2]);
  assert.equal(result.bestVector[11], initial[11]);
  assert.equal(result.bestVector[12], initial[12]);
  assert.equal(result.bestVector[10], 0);

  const synth = createSynth(result.synthConfig, {
    phaseModel: 'integral',
  });
  const rendered = Int16Array.from(
    { length: NUM_SAMPLES },
    (_, index) =>
      Math.round(
        synth({ x: index / SAMPLE_RATE }) *
          MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
      ),
  );
  assert.deepEqual(rendered, readWav(outputWavPath).samples);
});

test('worker preserves fixed delays in CD and the final canonical patch/WAV', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'synth-delayed-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const targetWavPath = join(dir, 'target.wav');
  const outputWavPath = join(dir, 'result.wav');
  const disabled = vector(0.2).map((value, index) =>
    index === 0 ? 0 : value,
  );
  const initial = [...vector(0.2), ...disabled];
  const targetVector = [...vector(0.4), ...disabled];
  const fixedDelaySeconds = [0.037, 0.011];
  const target = createWaveForm(
    targetVector,
    SAMPLE_RATE,
    NUM_SAMPLES,
    { phaseModel: 'integral', fixedDelaySeconds },
  );
  writeWav({
    samples: Int16Array.from(target, (sample) => Math.round(sample)),
    sampleRate: SAMPLE_RATE,
    filePath: targetWavPath,
  });

  const result = await matchWithWorker({
    targetWavPath,
    outputWavPath,
    initialVector: initial,
    sampleRate: SAMPLE_RATE,
    maxIterations: 1,
    seed: 7,
    fixedDelaySeconds,
    onLog: () => {},
    config: {
      phaseModel: 'integral',
      frozenParameterIndices: [1, 2, 11, 12],
      preserveOscillatorFlags: true,
      earlyExitSuppression: 101,
      saInitialTemp: 0,
      maxRelocationAttemptsPerOsc: 0,
      restartSchedule: [
        { startStep: 0.0025, minStep: 0.0001, label: 'DELAY_TEST' },
      ],
    },
  });

  assert.equal(result.bestVector.length, initial.length);
  const extracted = mapSynthConfigToVectorWithFixedDelays(
    result.synthConfig,
  );
  assert.deepEqual(
    extracted.fixedDelaySeconds.slice(0, fixedDelaySeconds.length),
    fixedDelaySeconds,
  );
  assert.equal(result.synthConfig.oscillators[1]?.osc.on, false);
  const synth = createSynth(result.synthConfig, {
    phaseModel: 'integral',
  });
  const rendered = Int16Array.from(
    { length: NUM_SAMPLES },
    (_, index) =>
      Math.round(
        synth({ x: index / SAMPLE_RATE }) *
          MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
      ),
  );
  assert.deepEqual(rendered, readWav(outputWavPath).samples);
});
