import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAMPLE_RATE } from '../consts';
import type { ArgCreateSynth } from '../synth';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  countDelayedAtoms,
  patchFromDelayedCandidate,
  realizeDelayedCandidate,
  type DelayedCandidate,
} from './delayed-patch';
import { renderSamples } from './shared';

/**
 * Создаёт короткий тон с заданным onset для known-answer target.
 *
 * @param delaySamples - Onset в отсчётах при 44100 Гц
 * @returns Патч одного отложенного тона
 */
function targetPatch(delaySamples: number): ArgCreateSynth {
  return {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 6000,
          freqStart: 6000,
          duration: 0.005,
          slope: 1,
          phase: 0.7,
          delay: delaySamples / SAMPLE_RATE,
        },
        ampEnv: {
          startLevel: 0.3,
          endLevel: 0.001,
          duration: 0.005,
          slope: 2,
        },
      },
    ],
  };
}

/**
 * Создаёт выключенный слот для проверки добавления delayed-атома.
 *
 * @returns Патч с одним выключенным осциллятором
 */
function offPatch(): ArgCreateSynth {
  return {
    oscillators: [
      {
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
      },
    ],
  };
}

/**
 * Создаёт candidate с известными огибающей, уровнем, фазой и onset.
 *
 * @param delaySamples - Onset атома в отсчётах; ноль задаёт zero-control
 * @returns Кандидат K1 для замены нулевого слота
 */
function candidate(delaySamples: number): DelayedCandidate {
  const phase = 0.7;
  const startLevel = 0.3;
  return {
    mode: 'K1',
    slots: [0],
    atoms: [
      {
        slot: 0,
        description: {
          frequency: 6000,
          freqStart: 6000,
          duration: 0.005,
          slope: 2,
          oscDuration: 0.005,
          oscSlope: 1,
          window: 'attack',
          localGain: 1,
          peakMagnitude: 1,
          sweepTemplateIndex: null,
        },
        delaySamples,
        fit: {
          sineCoefficient: startLevel * Math.cos(phase),
          cosineCoefficient: startLevel * Math.sin(phase),
          startLevel,
          phase,
        },
      },
    ],
  };
}

test('delayed candidate becomes a canonical patch and WAV above 99%', () => {
  const delaySamples = Math.round(0.037 * SAMPLE_RATE);
  const source = offPatch();
  const snapshot = structuredClone(source);
  const target = renderSamples(targetPatch(delaySamples), 0.2, {
    phaseModel: 'integral',
  });
  const result = realizeDelayedCandidate({
    source,
    candidate: candidate(delaySamples),
    target,
    phaseModel: 'integral',
  });
  assert.equal(result.status, 'refined');
  assert.ok(result.metrics.globalSuppressionPercent > 99);
  assert.equal(
    result.patch.oscillators[0]?.osc.delay,
    delaySamples / SAMPLE_RATE,
  );
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    'integral',
    SAMPLE_RATE,
    target.length,
  );
  assert.deepEqual(source, snapshot);
});

test('zero onset omits delay and worse candidate falls back to source', () => {
  const zeroSource = offPatch();
  const zeroTarget = renderSamples(targetPatch(0), 0.2, {
    phaseModel: 'integral',
  });
  const zero = realizeDelayedCandidate({
    source: zeroSource,
    candidate: candidate(0),
    target: zeroTarget,
    phaseModel: 'integral',
  });
  assert.equal(zero.status, 'refined');
  assert.equal(zero.patch.oscillators[0]?.osc.delay, undefined);

  const latePatch = targetPatch(Math.round(0.037 * SAMPLE_RATE));
  const lateTarget = renderSamples(latePatch, 0.2, {
    phaseModel: 'integral',
  });
  const fallback = realizeDelayedCandidate({
    source: latePatch,
    candidate: candidate(0),
    target: lateTarget,
    phaseModel: 'integral',
  });
  assert.equal(fallback.status, 'unchanged');
  assert.deepEqual(fallback.patch, latePatch);
  assert.deepEqual(fallback.samples, lateTarget);
});

test('mixed pair reports only its actually delayed atom', () => {
  const mixed = candidate(300);
  const zero = candidate(0).atoms[0];
  const first = mixed.atoms[0];
  assert.ok(zero !== undefined && first !== undefined);
  mixed.mode = 'K2';
  mixed.slots = [0, 1];
  mixed.atoms = [first, { ...zero, slot: 1 }];
  assert.equal(countDelayedAtoms(mixed), 1);
  assert.equal(countDelayedAtoms(candidate(0)), 0);
});

test('invalid slots and delays are rejected before synthesis', () => {
  const source = offPatch();
  const duplicate = candidate(1);
  duplicate.slots = [0, 0];
  const first = duplicate.atoms[0];
  assert.ok(first !== undefined);
  duplicate.atoms = [first, { ...first }];
  assert.throws(
    () => patchFromDelayedCandidate(source, duplicate),
    /повторный слот/,
  );
  assert.throws(
    () => patchFromDelayedCandidate(source, candidate(-1)),
    /delaySamples/,
  );
});
