import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPatchMatchesWav } from './beat-transfer-run';
import { groundTruthToPatch } from './ground-truth';
import { renderSamples } from './shared';

const patch = groundTruthToPatch({
  freqHz: 50,
  level: 0.25,
  decayRate: 1,
  durationSec: 0.2,
});
const expected = renderSamples(patch, 0.5, {
  phaseModel: 'legacy',
});

test('patch check accepts exact samples and rejects wrong lengths', () => {
  assert.doesNotThrow(() =>
    assertPatchMatchesWav(
      patch,
      expected,
      'legacy',
      44100,
      expected.length,
    ),
  );
  assert.throws(
    () =>
      assertPatchMatchesWav(
        patch,
        expected.slice(0, expected.length - 1),
        'legacy',
        44100,
        expected.length,
      ),
    /Длина patch/,
  );
  const extended = new Int16Array(expected.length + 1);
  extended.set(expected);
  assert.throws(
    () =>
      assertPatchMatchesWav(
        patch,
        extended,
        'legacy',
        44100,
        expected.length,
      ),
    /Длина patch/,
  );
});

test('patch check renders exactly the target sample count', () => {
  const shorter = expected.slice(0, 20046);
  assert.equal(shorter.length, 20046);
  assert.doesNotThrow(() =>
    assertPatchMatchesWav(
      patch,
      shorter,
      'legacy',
      44100,
      shorter.length,
    ),
  );
});

test('patch check rejects wrong sample rate and changed samples', () => {
  assert.throws(
    () =>
      assertPatchMatchesWav(
        patch,
        expected,
        'legacy',
        48000,
        expected.length,
      ),
    /sample rate/,
  );
  const changed = Int16Array.from(expected);
  changed[100] = (changed[100] ?? 0) + 1;
  assert.throws(
    () =>
      assertPatchMatchesWav(
        patch,
        changed,
        'legacy',
        44100,
        expected.length,
      ),
    /не совпадает с result.wav/,
  );
});
