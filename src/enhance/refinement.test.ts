import assert from 'node:assert/strict';
import { test } from 'node:test';
import { synthPreset1 } from '../presets';
import { DEFAULT_IDENTIFIABILITY } from './defaults';
import {
  createRefinementPlan,
  limitRefinementPeak,
} from './refinement';
import type { IdentifiabilityMap } from './engine';

test('C4 starts from the enhanced patch and freezes default anchors', () => {
  const patch = structuredClone(synthPreset1);
  const second = patch.oscillators[1];
  assert.ok(second);
  second.osc.on = false;
  const before = structuredClone(patch);

  const plan = createRefinementPlan(patch, DEFAULT_IDENTIFIABILITY);
  assert.equal(plan.initialVector.length, 20);
  assert.equal(plan.initialVector[0], 1);
  assert.equal(plan.initialVector[10], 0);
  assert.deepEqual(
    plan.config.frozenParameterIndices,
    [1, 2, 11, 12],
  );
  assert.equal(plan.config.preserveOscillatorFlags, true);
  assert.equal(plan.config.maxRelocationAttemptsPerOsc, 0);
  assert.equal(plan.config.saInitialTemp, 0);
  assert.equal(plan.config.restartSchedule?.length, 1);
  assert.equal(
    plan.config.restartSchedule?.[0]?.label,
    'C4_REFINEMENT',
  );
  assert.deepEqual(patch, before);
});

test('unknown and missing verdicts stay anchored; prior-owned stays free', () => {
  const identifiability: IdentifiabilityMap = {
    version: 1,
    params: {
      freqBase: { verdict: 'unknown' },
      freqStart: { verdict: 'free' },
      slope: { verdict: 'free' },
      duration: { verdict: 'free' },
      ampEnvDuration: { verdict: 'free' },
      endLevel: { verdict: 'prior-owned' },
      ampEnvSlope: { verdict: 'free' },
      startLevel: { verdict: 'free' },
    },
  };
  const plan = createRefinementPlan(synthPreset1, identifiability);
  assert.deepEqual(
    plan.config.frozenParameterIndices,
    [1, 5, 11, 15],
  );
});

test('peak limiting never overwrites an anchored start level', () => {
  const identifiability = structuredClone(DEFAULT_IDENTIFIABILITY);
  const startLevel = identifiability.params.startLevel;
  assert.ok(startLevel);
  startLevel.verdict = 'anchored';
  const result = limitRefinementPeak(synthPreset1, identifiability, {
    phaseModel: 'integral',
  });
  assert.equal(result.patch, synthPreset1);
  assert.equal(result.skipped, true);
  assert.match(result.skipReason ?? '', /anchored/);

  const free = limitRefinementPeak(
    synthPreset1,
    DEFAULT_IDENTIFIABILITY,
    { phaseModel: 'integral' },
  );
  assert.equal(free.skipped, false);
});
