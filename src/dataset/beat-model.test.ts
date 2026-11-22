import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderGroundTruth } from './ground-truth';
import {
  fitDampedBeat,
  measureTrainingF0,
  removeFittedComponent,
} from './beat-model';

const DECAY = { decayRate: 1, durationSec: 0.2 } as const;

test('single tone does not become a beat', () => {
  const result = fitDampedBeat(
    renderGroundTruth([{ freqHz: 50, level: 0.5, ...DECAY }], 0.5),
    50,
  );
  assert.ok(result);
  assert.ok(result.singleTrainR2 > 0.999);
  assert.ok(result.depth < 0.05);
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons.includes('depth'));
});

test('equal 50/54 pair recovers beating and generalizes', () => {
  const result = fitDampedBeat(
    renderGroundTruth(
      [
        { freqHz: 50, level: 0.25, ...DECAY },
        { freqHz: 54, level: 0.25, ...DECAY },
      ],
      0.5,
    ),
    52.7,
  );
  assert.ok(result);
  assert.ok(Math.abs(Math.abs(result.f2 - result.f1) - 4) < 0.75);
  assert.ok(result.depth > 0.9);
  assert.ok(result.pairValR2 > 0.8);
  assert.ok(result.valGain > 0.5);
  assert.equal(result.accepted, true);
});

test('unequal 50/58 pair recovers delta and analytic depth', () => {
  const result = fitDampedBeat(
    renderGroundTruth(
      [
        { freqHz: 50, level: 0.4, ...DECAY },
        { freqHz: 58, level: 0.1, ...DECAY },
      ],
      0.5,
    ),
    50.9,
  );
  assert.ok(result);
  assert.ok(Math.abs(Math.abs(result.f2 - result.f1) - 8) < 0.75);
  assert.ok(Math.abs(result.depth - 0.4) < 0.1);
  assert.ok(result.deltaHz <= 8);
  assert.ok(result.pairValR2 > 0.8);
  assert.equal(result.accepted, true);
});

test('removing the second fitted component hides the beat', () => {
  const samples = renderGroundTruth(
    [
      { freqHz: 50, level: 0.25, ...DECAY },
      { freqHz: 54, level: 0.25, ...DECAY },
    ],
    0.5,
  );
  const fit = fitDampedBeat(samples, 52.7);
  assert.ok(fit?.accepted);
  const changed = removeFittedComponent(samples, fit, 'second');
  const after = fitDampedBeat(changed, 52.7);
  assert.ok(after);
  assert.equal(after.accepted, false);
});

test('strong sweep does not validate as a beat', () => {
  const result = fitDampedBeat(
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
    56.7,
  );
  assert.ok(result);
  assert.ok(result.pairValR2 < 0.5);
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons.includes('validation-r2<0.5'));
});

test('removing a high 200/204 component compensates filter gain', () => {
  const samples = renderGroundTruth(
    [
      { freqHz: 200, level: 0.25, ...DECAY },
      { freqHz: 204, level: 0.25, ...DECAY },
    ],
    0.5,
  );
  const fit = fitDampedBeat(samples, 202);
  assert.ok(fit?.accepted);
  const changed = removeFittedComponent(samples, fit, 'second');
  const after = fitDampedBeat(changed, 202);
  assert.ok(after);
  assert.equal(after.accepted, false);
});

test('silence has zero metrics and never becomes a beat', () => {
  const result = fitDampedBeat(new Int16Array(44100), 50);
  assert.ok(result);
  assert.equal(result.singleTrainR2, 0);
  assert.equal(result.pairTrainR2, 0);
  assert.equal(result.singleValR2, 0);
  assert.equal(result.pairValR2, 0);
  assert.equal(result.trainGain, 0);
  assert.equal(result.valGain, 0);
  assert.equal(result.depth, 0);
  assert.equal(result.accepted, false);
});

test('training f0 ignores everything after 180 ms', () => {
  const first = renderGroundTruth(
    [{ freqHz: 50, level: 0.5, ...DECAY }],
    0.5,
  );
  const changed = Int16Array.from(first);
  const validation = renderGroundTruth(
    [{ freqHz: 100, level: 0.5, ...DECAY }],
    0.5,
  );
  changed.set(
    validation.subarray(Math.round(0.18 * 44100)),
    Math.round(0.18 * 44100),
  );
  const beforeF0 = measureTrainingF0(first, 44100);
  const afterF0 = measureTrainingF0(changed, 44100);
  assert.ok(beforeF0 !== null);
  assert.equal(afterF0, beforeF0);
  assert.ok(Math.abs(beforeF0 - 50) < 1);
});

test('short input returns null and invalid parameters throw', () => {
  assert.equal(fitDampedBeat(new Int16Array(100), 50), null);
  assert.throws(() => fitDampedBeat(new Int16Array(44100), 0));
  assert.throws(() => fitDampedBeat(new Int16Array(44100), 50, 0));
});
