import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coordinateDescent } from './optimize/coordinate-descent';
import type { CoordinateDescentConfig } from './optimize/coordinate-descent';
import {
  createWaveForm,
  evaluateSuppressionWindowed,
  WaveformCache,
} from './optimize/evaluate';
import {
  mapSynthConfigToVector,
  mapSynthConfigToVectorWithFixedDelays,
} from './synth-config-to-vector';
import {
  mapVectorToSynthConfig,
  mapVectorToSynthConfigForOsc,
} from './vector-to-synth-config';

const SAMPLE_RATE = 2000;
const NUM_SAMPLES = 1024;
const DELAY_SECONDS = 0.037;

function vector(volume = 0.2): number[] {
  return [1, 0.001, 0.002, 0.4, 0.5, 0.25, 0.4, 0.1, 0.5, volume];
}

function testConfig(
  fixedDelaySeconds?: readonly number[],
): Partial<CoordinateDescentConfig> {
  return {
    earlyExitSuppression: 101,
    saInitialTemp: 0,
    maxRelocationAttemptsPerOsc: 0,
    restartSchedule: [
      { startStep: 0.01, minStep: 0.001, label: 'TEST' },
    ],
    ...(fixedDelaySeconds === undefined ? {} : { fixedDelaySeconds }),
  };
}

test('delayed patch extraction keeps vector length and disabled-slot onset', () => {
  const initial = [
    ...vector(),
    ...vector().map((value, index) => (index === 0 ? 0 : value)),
  ];
  const patch = mapVectorToSynthConfig(initial);
  patch.oscillators = patch.oscillators.slice(0, 2);
  const first = patch.oscillators[0];
  const second = patch.oscillators[1];
  assert.ok(first !== undefined && second !== undefined);
  first.osc.delay = DELAY_SECONDS;
  second.osc.delay = 0.011;

  assert.throws(
    () => mapSynthConfigToVector(patch),
    /cannot be mapped/,
  );
  const snapshot = structuredClone(patch);
  const extracted = mapSynthConfigToVectorWithFixedDelays(patch);
  assert.equal(extracted.vector.length, 20);
  assert.deepEqual(extracted.fixedDelaySeconds, [
    DELAY_SECONDS,
    0.011,
  ]);
  assert.deepEqual(patch, snapshot);

  const restored = mapVectorToSynthConfig(
    extracted.vector,
    extracted.fixedDelaySeconds,
  );
  assert.equal(restored.oscillators[0]?.osc.delay, DELAY_SECONDS);
  assert.equal(restored.oscillators[1]?.osc.delay, 0.011);
  assert.equal(restored.oscillators[1]?.osc.on, false);
  const roundTrip = mapSynthConfigToVectorWithFixedDelays(restored);
  for (let index = 0; index < extracted.vector.length; index += 1) {
    assert.ok(
      Math.abs(
        (roundTrip.vector[index] ?? 0) -
          (extracted.vector[index] ?? 0),
      ) < 1e-12,
      `vector offset ${index} changed during delayed round trip`,
    );
  }
  assert.deepEqual(
    roundTrip.fixedDelaySeconds.slice(0, 2),
    extracted.fixedDelaySeconds,
  );
});

test('WaveformCache applies sidecar initially, on off/on and rebuild', () => {
  const genome = [...vector(), ...vector(0.3)];
  const delays = [DELAY_SECONDS, 0.011];
  const cache = new WaveformCache(
    genome,
    SAMPLE_RATE,
    NUM_SAMPLES,
    'legacy',
    delays,
  );
  const expected = (current: readonly number[]): number[] =>
    createWaveForm(current, SAMPLE_RATE, NUM_SAMPLES, {
      fixedDelaySeconds: delays,
    });
  const assertWaveformClose = (current: readonly number[]): void => {
    const actual = cache.getWaveform();
    const reference = expected(current);
    for (let index = 0; index < reference.length; index += 1) {
      assert.ok(
        Math.abs((actual[index] ?? 0) - (reference[index] ?? 0)) <
          1e-9,
        `waveform sample ${index} lost its fixed delay`,
      );
    }
  };

  assertWaveformClose(genome);
  cache.setParam(9, 0.4);
  assertWaveformClose(cache.getGenome());
  cache.setParam(0, 0);
  assertWaveformClose(cache.getGenome());
  cache.setParam(0, 1);
  assertWaveformClose(cache.getGenome());
  const restarted = genome.map((value, index) =>
    index % 10 === 0 ? value : ((index + 3) % 10) / 10,
  );
  cache.rebuild(restarted);
  assertWaveformClose(restarted);
  assert.deepEqual(delays, [DELAY_SECONDS, 0.011]);
});

test('CD keeps a frozen delayed onset while fitting a free volume and scale', () => {
  const initial = vector(0.2);
  const targetVector = vector(0.4);
  const delays = [DELAY_SECONDS];
  const target = createWaveForm(
    targetVector,
    SAMPLE_RATE,
    NUM_SAMPLES,
    { fixedDelaySeconds: delays },
  );
  const result = coordinateDescent(
    initial,
    target,
    SAMPLE_RATE,
    2,
    undefined,
    undefined,
    undefined,
    {
      ...testConfig(delays),
      frozenParameterIndices: [1, 2, 3, 4, 5, 6, 7, 8],
      preserveOscillatorFlags: true,
    },
  );

  assert.equal(result.vector.length, 10);
  assert.notEqual(result.vector[9], initial[9]);
  const patch = mapVectorToSynthConfig(result.vector, delays);
  assert.equal(patch.oscillators[0]?.osc.delay, DELAY_SECONDS);
  const canonical = createWaveForm(
    result.vector,
    SAMPLE_RATE,
    NUM_SAMPLES,
    { fixedDelaySeconds: delays },
  );
  assert.ok(
    canonical
      .slice(0, Math.round(DELAY_SECONDS * SAMPLE_RATE))
      .every((sample) => sample === 0),
  );
  const finalScore = evaluateSuppressionWindowed(
    canonical,
    target,
    SAMPLE_RATE,
  );
  assert.equal(
    result.history[result.history.length - 1]?.suppressionPercent,
    finalScore,
  );
});

test('random restart and best-genome restore retain delayed synthesis', () => {
  const initial = vector(0.2);
  const delays = [DELAY_SECONDS];
  const target = createWaveForm(initial, SAMPLE_RATE, NUM_SAMPLES, {
    fixedDelaySeconds: delays,
  });
  const result = coordinateDescent(
    initial,
    target,
    SAMPLE_RATE,
    4,
    undefined,
    undefined,
    undefined,
    {
      ...testConfig(delays),
      plateauRestartThreshold: 1,
      maxRestartsBeforeRandomRestart: 2,
      restartSchedule: [
        { startStep: 0.01, minStep: 0.001, label: 'EXPLORE' },
        { startStep: 0.005, minStep: 0.001, label: 'PRECISE' },
      ],
    },
  );
  assert.deepEqual(result.vector, initial);
  assert.equal(
    mapVectorToSynthConfig(result.vector, delays).oscillators[0]?.osc
      .delay,
    DELAY_SECONDS,
  );
  assert.deepEqual(
    createWaveForm(result.vector, SAMPLE_RATE, NUM_SAMPLES, {
      fixedDelaySeconds: delays,
    }),
    target,
  );
});

test('zero-iteration scale fitting and final mapping retain the same sidecar', () => {
  const initial = vector(0.2);
  const delays = [DELAY_SECONDS];
  const target = createWaveForm(
    vector(0.4),
    SAMPLE_RATE,
    NUM_SAMPLES,
    { fixedDelaySeconds: delays },
  );
  const result = coordinateDescent(
    initial,
    target,
    SAMPLE_RATE,
    0,
    undefined,
    undefined,
    undefined,
    testConfig(delays),
  );
  assert.notEqual(result.vector[9], initial[9]);
  const patch = mapVectorToSynthConfig(result.vector, delays);
  assert.equal(patch.oscillators[0]?.osc.delay, DELAY_SECONDS);
  const canonical = createWaveForm(
    result.vector,
    SAMPLE_RATE,
    NUM_SAMPLES,
    { fixedDelaySeconds: delays },
  );
  assert.equal(
    result.history[result.history.length - 1]?.suppressionPercent,
    evaluateSuppressionWindowed(canonical, target, SAMPLE_RATE),
  );
});

test('exploration preview rescale keeps the delayed best genome', () => {
  const initial = vector(0.2);
  const delays = [DELAY_SECONDS];
  const target = createWaveForm(initial, SAMPLE_RATE, NUM_SAMPLES, {
    fixedDelaySeconds: delays,
  });
  const result = coordinateDescent(
    initial,
    target,
    SAMPLE_RATE,
    1,
    undefined,
    undefined,
    undefined,
    {
      ...testConfig(delays),
      explorationWindowStride: 2,
      plateauRestartThreshold: 1,
      maxRestartsBeforeRandomRestart: 99,
      kickFallbackThreshold: Number.NEGATIVE_INFINITY,
      restartSchedule: [
        { startStep: 0.01, minStep: 0.001, label: 'EXPLORE' },
        { startStep: 0.005, minStep: 0.001, label: 'PRECISE' },
      ],
    },
  );

  assert.deepEqual(result.vector, initial);
  const canonical = createWaveForm(
    result.vector,
    SAMPLE_RATE,
    NUM_SAMPLES,
    { fixedDelaySeconds: delays },
  );
  assert.deepEqual(canonical, target);
  assert.equal(
    result.history[result.history.length - 1]?.suppressionPercent,
    evaluateSuppressionWindowed(canonical, target, SAMPLE_RATE),
  );
});

test('invalid sidecar length, NaN and range fail before delayed CD', () => {
  const initial = vector();
  const target = createWaveForm(initial, SAMPLE_RATE, NUM_SAMPLES);
  for (const delays of [
    [],
    [Number.NaN],
    [-0.001],
    [0.501],
    [0, 0],
  ]) {
    assert.throws(
      () =>
        coordinateDescent(
          initial,
          target,
          SAMPLE_RATE,
          1,
          undefined,
          undefined,
          undefined,
          testConfig(delays),
        ),
      /fixedDelaySeconds/,
    );
  }
  assert.throws(
    () => mapVectorToSynthConfig(initial, [Number.NaN]),
    /fixedDelaySeconds/,
  );
  assert.throws(
    () => mapVectorToSynthConfigForOsc(initial, 0, 0.501),
    /fixedDelaySeconds/,
  );
  assert.throws(
    () =>
      new WaveformCache(
        initial,
        SAMPLE_RATE,
        NUM_SAMPLES,
        'legacy',
        [],
      ),
    /fixedDelaySeconds/,
  );
});

test('a delayed run does not leak its sidecar into the next default run', () => {
  const initial = vector(0.2);
  const plainTarget = createWaveForm(
    vector(0.4),
    SAMPLE_RATE,
    NUM_SAMPLES,
  );
  const delayedTarget = createWaveForm(
    vector(0.4),
    SAMPLE_RATE,
    NUM_SAMPLES,
    { fixedDelaySeconds: [DELAY_SECONDS] },
  );
  const baseline = coordinateDescent(
    initial,
    plainTarget,
    SAMPLE_RATE,
    1,
  );
  coordinateDescent(
    initial,
    delayedTarget,
    SAMPLE_RATE,
    1,
    undefined,
    undefined,
    undefined,
    testConfig([DELAY_SECONDS]),
  );
  const after = coordinateDescent(
    initial,
    plainTarget,
    SAMPLE_RATE,
    1,
  );
  assert.deepEqual(after, baseline);
  assert.deepEqual(
    createWaveForm(initial, SAMPLE_RATE, NUM_SAMPLES),
    createWaveForm(initial, SAMPLE_RATE, NUM_SAMPLES, {
      fixedDelaySeconds: undefined,
    }),
  );
});
