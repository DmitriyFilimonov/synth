import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { coordinateDescent } from './coordinate-descent';
import type { CoordinateDescentConfig } from './coordinate-descent';
import { initGenome, OSC_PARAMS } from './consts';
import { createWaveForm } from './evaluate';
import { mapSynthConfigToVector } from '../synth-config-to-vector';
import { mapVectorToSynthConfig } from '../vector-to-synth-config';

const SAMPLE_RATE = 2000;
const NUM_SAMPLES = 1024;

function vector(over: Record<number, number> = {}): number[] {
  const base = [1, 0.001, 0.002, 0.4, 0.5, 0.25, 0.4, 0.1, 0.5, 0.2];
  return base.map((value, index) => over[index] ?? value);
}

function allContinuousIndices(length: number): number[] {
  return Array.from({ length }, (_, index) => index).filter(
    (index) => index % OSC_PARAMS !== 0,
  );
}

function run(
  initial: number[],
  target: number[],
  config: Partial<CoordinateDescentConfig>,
  maxIterations = 2,
): ReturnType<typeof coordinateDescent> {
  return coordinateDescent(
    initial,
    target,
    SAMPLE_RATE,
    maxIterations,
    undefined,
    undefined,
    undefined,
    {
      earlyExitSuppression: 101,
      saInitialTemp: 0,
      maxRelocationAttemptsPerOsc: 0,
      restartSchedule: [
        { startStep: 0.01, minStep: 0.001, label: 'TEST' },
      ],
      ...config,
    },
  );
}

test('empty anchors preserve the default run exactly', () => {
  const initial = vector({ 9: 0.2 });
  const target = createWaveForm(
    vector({ 9: 0.4 }),
    SAMPLE_RATE,
    NUM_SAMPLES,
  );
  const baseline = coordinateDescent(initial, target, SAMPLE_RATE, 1);
  const withEmptyAnchors = coordinateDescent(
    initial,
    target,
    SAMPLE_RATE,
    1,
    undefined,
    undefined,
    undefined,
    { frozenParameterIndices: [], preserveOscillatorFlags: false },
  );
  assert.deepEqual(withEmptyAnchors, baseline);
});

test('default run matches the v1.4.0 golden vector and history', () => {
  const initial = vector({ 9: 0.2 });
  const target = createWaveForm(
    vector({ 9: 0.4 }),
    SAMPLE_RATE,
    NUM_SAMPLES,
  );
  const result = coordinateDescent(initial, target, SAMPLE_RATE, 1);
  const digest = createHash('sha256')
    .update(JSON.stringify(result))
    .digest('hex');
  assert.equal(
    digest,
    'cf20232dede75c84c82cafdf3eb1766eb673eeaf271940dedebeaf4d5557973a',
  );
});

test('plateau kicks and random restarts match the v1.4.0 golden', () => {
  const initial = vector({ 9: 0.2 });
  const target = createWaveForm(initial, SAMPLE_RATE, NUM_SAMPLES);
  const result = coordinateDescent(
    initial,
    target,
    SAMPLE_RATE,
    4,
    undefined,
    undefined,
    undefined,
    {
      earlyExitSuppression: 101,
      saInitialTemp: 0,
      maxRelocationAttemptsPerOsc: 0,
      plateauRestartThreshold: 1,
      maxRestartsBeforeRandomRestart: 2,
      restartSchedule: [
        { startStep: 0.01, minStep: 0.001, label: 'EXPLORE' },
        { startStep: 0.005, minStep: 0.001, label: 'PRECISE' },
      ],
    },
  );
  const digest = createHash('sha256')
    .update(JSON.stringify(result))
    .digest('hex');
  assert.equal(
    digest,
    'cfd4d09b35826f19f71083c6518b557f5045e51b05efe4b285ed8084743fa89f',
  );
});

test('both converters preserve the ten shared vector offsets', () => {
  const source = [
    1, 0.01, 0.12, 0.23, 0.34, 0.45, 0.56, 0.67, 0.78, 0.89,
  ];
  const patch = mapVectorToSynthConfig(source);
  const roundTrip = mapSynthConfigToVector(patch).slice(
    0,
    source.length,
  );
  assert.equal(roundTrip.length, source.length);
  for (let index = 0; index < source.length; index++) {
    assert.ok(
      Math.abs((roundTrip[index] ?? 0) - (source[index] ?? 0)) <
        1e-12,
      `offset ${index} changed during round trip`,
    );
  }
});

test('normal descent keeps frequency anchors but moves a free volume', () => {
  const initial = vector({ 9: 0.2 });
  const target = createWaveForm(
    vector({ 9: 0.4 }),
    SAMPLE_RATE,
    NUM_SAMPLES,
  );
  const result = run(initial, target, {
    frozenParameterIndices: [1, 2],
    preserveOscillatorFlags: true,
  });
  assert.equal(result.vector[1], initial[1]);
  assert.equal(result.vector[2], initial[2]);
  assert.notEqual(result.vector[9], initial[9]);
});

test('plateau kicks cannot move anchors or resurrect disabled slots', () => {
  const initial = [
    ...vector(),
    ...vector().map((v, i) => (i === 0 ? 0 : v)),
  ];
  const normalized = initGenome(initial, true);
  const target = createWaveForm(normalized, SAMPLE_RATE, NUM_SAMPLES);
  const result = run(initial, target, {
    frozenParameterIndices: allContinuousIndices(initial.length),
    preserveOscillatorFlags: true,
    plateauRestartThreshold: 1,
    maxRestartsBeforeRandomRestart: 99,
  });
  assert.deepEqual(result.vector, normalized);
  assert.equal(result.vector[10], 0);
});

test('random restart restores every frozen value and scale cannot move volume', () => {
  const initial = vector({ 9: 0.001 });
  const target = createWaveForm(
    vector({ 1: 0.002, 2: 0.003, 9: 0.4 }),
    SAMPLE_RATE,
    NUM_SAMPLES,
  );
  const result = run(
    initial,
    target,
    {
      frozenParameterIndices: allContinuousIndices(initial.length),
      preserveOscillatorFlags: true,
      plateauRestartThreshold: 1,
      maxRestartsBeforeRandomRestart: 1,
      restartSchedule: [
        { startStep: 0.01, minStep: 0.001, label: 'EXPLORE' },
        { startStep: 0.005, minStep: 0.001, label: 'PRECISE' },
      ],
    },
    2,
  );
  assert.deepEqual(result.vector, initGenome(initial, true));
});

test('relocation cannot rewrite an oscillator with frozen parameters', () => {
  const initial = vector({ 1: 0.005, 2: 0.005, 9: 0.001 });
  const target = createWaveForm(
    vector({ 1: 0.001, 2: 0.001, 9: 0.4 }),
    SAMPLE_RATE,
    NUM_SAMPLES,
  );
  const result = run(
    initial,
    target,
    {
      frozenParameterIndices: allContinuousIndices(initial.length),
      maxRelocationAttemptsPerOsc: 3,
      plateauRestartThreshold: 99,
    },
    1,
  );
  assert.equal(result.vector[1], initial[1]);
  assert.equal(result.vector[2], initial[2]);
  assert.equal(result.vector[9], initial[9]);
});

test('invalid frozen indices fail before optimization', () => {
  const initial = vector();
  const target = createWaveForm(initial, SAMPLE_RATE, NUM_SAMPLES);
  assert.throws(
    () => run(initial, target, { frozenParameterIndices: [0] }, 1),
    /Invalid frozen parameter index/,
  );
  assert.throws(
    () => run(initial, target, { frozenParameterIndices: [10] }, 1),
    /Invalid frozen parameter index/,
  );
});
