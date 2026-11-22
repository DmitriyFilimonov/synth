import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArgCreateSynth } from '../synth';
import { fitDampedBeat, measureTrainingF0 } from './beat-model';
import {
  repairExistingBeatPair,
  restoreBeatPair,
} from './beat-transfer';
import {
  groundTruthToPatch,
  renderGroundTruth,
} from './ground-truth';
import { renderSamples } from './shared';

const DECAY = { decayRate: 1, durationSec: 0.2 } as const;
const TARGET = renderGroundTruth(
  [
    { freqHz: 50, level: 0.25, ...DECAY },
    { freqHz: 54, level: 0.25, ...DECAY },
  ],
  0.5,
);
const FIT = fitDampedBeat(TARGET, 52.7);
if (FIT === null || !FIT.accepted) {
  throw new Error('Не удалось построить эталонную пару для тестов');
}

/** Выключает один слот с нейтральными параметрами. */
function offGroup(): ArgCreateSynth['oscillators'][number] {
  return {
    osc: {
      on: false,
      freqBase: 50,
      freqStart: 50,
      duration: 0.5,
      slope: 1,
      phase: 0,
    },
    ampEnv: {
      startLevel: 0.001,
      endLevel: 0.001,
      duration: 0.5,
      slope: 1,
    },
  };
}

test('bounded transfer restores a known pair and validates', () => {
  const result = restoreBeatPair({
    patch: { oscillators: [offGroup(), offGroup()] },
    target: TARGET,
    fit: FIT,
  });
  assert.equal(result.status, 'candidate');
  assert.deepEqual(result.audit?.replacedOscillators, []);
  assert.ok(result.audit !== null);
  assert.equal(result.audit.applied, true);
  for (const level of result.audit.startLevels) {
    assert.ok(level >= 0.001 && level <= 1);
  }
  assert.ok(result.audit.endLevel >= 0.001);
  const f0 = measureTrainingF0(result.samples, 44100);
  assert.ok(f0 !== null);
  const after = fitDampedBeat(result.samples, f0);
  assert.ok(after);
  assert.equal(after.accepted, true);
});

test('slot selection keeps a useful 100 Hz oscillator', () => {
  const target = renderGroundTruth(
    [
      { freqHz: 100, level: 0.02, ...DECAY },
      { freqHz: 50, level: 0.25, ...DECAY },
      { freqHz: 54, level: 0.25, ...DECAY },
    ],
    0.5,
  );
  const fit = fitDampedBeat(target, 52.7);
  assert.ok(fit?.accepted);
  const base = groundTruthToPatch({
    freqHz: 100,
    level: 0.02,
    ...DECAY,
  });
  base.oscillators.push(offGroup(), offGroup());
  const result = restoreBeatPair({ patch: base, target, fit });
  assert.equal(result.status, 'candidate');
  assert.deepEqual(result.audit?.replacedOscillators, []);
  assert.equal(result.patch.oscillators[0]?.osc.freqBase, 100);
  assert.equal(result.patch.oscillators[0]?.osc.on, true);
});

test('transfer reports no feasible replacement instead of clipping', () => {
  const patch = groundTruthToPatch({
    freqHz: 50,
    level: 0.25,
    ...DECAY,
  });
  const result = restoreBeatPair({ patch, target: TARGET, fit: FIT });
  assert.equal(result.status, 'no-feasible-replacement');
  assert.equal(result.audit, null);
  assert.equal(result.patch.oscillators.length, 1);
});

test('phase repair keeps envelopes and restores known phases', () => {
  const target = renderGroundTruth(
    [
      { freqHz: 50, level: 0.25, phaseRad: 0.7, ...DECAY },
      { freqHz: 54, level: 0.25, phaseRad: 1.2, ...DECAY },
    ],
    0.5,
  );
  const fit = fitDampedBeat(target, 52.7);
  assert.ok(fit?.accepted);
  const first = groundTruthToPatch({
    freqHz: 50,
    level: 0.25,
    phaseRad: 0,
    ...DECAY,
  });
  const second = groundTruthToPatch({
    freqHz: 54,
    level: 0.25,
    phaseRad: 0,
    ...DECAY,
  });
  const patch = {
    oscillators: [first.oscillators[0], second.oscillators[0]].filter(
      (group) => group !== undefined,
    ),
  };
  const result = repairExistingBeatPair({ patch, target, fit });
  assert.equal(result.status, 'candidate');
  assert.equal(result.audit?.mode, 'phase-repair');
  assert.deepEqual(result.audit?.startLevels, [0.25, 0.25]);
  const f0 = measureTrainingF0(result.samples, 44100);
  assert.ok(f0 !== null);
  const after = fitDampedBeat(result.samples, f0);
  assert.ok(after);
  assert.equal(after.accepted, true);
  const envelopePatch = structuredClone(patch);
  const secondGroup = envelopePatch.oscillators[1];
  assert.ok(secondGroup !== undefined);
  secondGroup.ampEnv.duration = 0.25;
  const refined = repairExistingBeatPair({
    patch: envelopePatch,
    target,
    fit,
    refineEnvelopes: true,
  });
  assert.equal(refined.status, 'candidate');
  assert.equal(refined.audit?.mode, 'envelope-repair');
  assert.notDeepEqual(
    refined.patch.oscillators[1]?.ampEnv,
    secondGroup.ampEnv,
  );
  assert.ok(
    (refined.audit?.candidateSelectionRss ?? Infinity) <
      (refined.audit?.baselineSelectionRss ?? 0),
  );
});

test('phase repair requires two existing low oscillators', () => {
  const patch = groundTruthToPatch({
    freqHz: 50,
    level: 0.25,
    ...DECAY,
  });
  const result = repairExistingBeatPair({
    patch,
    target: TARGET,
    fit: FIT,
  });
  assert.equal(result.status, 'no-feasible-replacement');
});

test('default phase model matches legacy for swept patches', () => {
  const patch = groundTruthToPatch({
    freqHz: 50,
    level: 0.25,
    ...DECAY,
  });
  const group = patch.oscillators[0];
  assert.ok(group !== undefined);
  group.osc.freqStart = 100;
  const expected = renderSamples(patch, 0.5, {
    phaseModel: 'legacy',
  });
  const replaced = restoreBeatPair({
    patch,
    target: TARGET,
    fit: FIT,
  });
  assert.equal(replaced.status, 'no-feasible-replacement');
  assert.deepEqual(replaced.samples, expected);
  const repaired = repairExistingBeatPair({
    patch,
    target: TARGET,
    fit: FIT,
  });
  assert.equal(repaired.status, 'no-feasible-replacement');
  assert.deepEqual(repaired.samples, expected);
});

test('baseline rendering preserves the target sample count', () => {
  const patch = groundTruthToPatch({
    freqHz: 50,
    level: 0.25,
    ...DECAY,
  });
  const shortTarget = TARGET.slice(0, 20046);
  const replaced = restoreBeatPair({
    patch,
    target: shortTarget,
    fit: FIT,
  });
  assert.equal(replaced.samples.length, 20046);
  const repaired = repairExistingBeatPair({
    patch,
    target: shortTarget,
    fit: FIT,
  });
  assert.equal(repaired.samples.length, 20046);
});

test('rejected source model cannot be transferred', () => {
  assert.throws(
    () =>
      restoreBeatPair({
        patch: { oscillators: [offGroup(), offGroup()] },
        target: TARGET,
        fit: { ...FIT, accepted: false },
      }),
    /отклонённую модель/,
  );
});
