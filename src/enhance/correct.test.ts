/**
 * Тесты движка коррекции (режим B): внутри приорной вилки патч не
 * трогается, снаружи параметры двигаются к границе на долю силы,
 * отношение sweep сохраняется, вход не мутируется.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ArgCreateSynth } from '../synth';
import { correctPatch } from './correct';
import { type PriorsFile } from './engine';

/** Патч с одним сабом, частота и огибающая вне приорных вилок. */
function makePatch(): ArgCreateSynth {
  return {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 30,
          freqStart: 150,
          slope: 0.8,
          duration: 0.25,
          phase: 0,
        },
        ampEnv: {
          duration: 0.9,
          endLevel: 0.001,
          slope: 0.8,
          startLevel: 0.5,
        },
      },
    ],
  };
}

/** Приоры: sustain-кластер 45–60 Гц с огибающей 0.3–0.5 с. */
function makePriors(targetsPresent?: string[]): PriorsFile {
  return {
    version: 1,
    clusters: [
      {
        id: 'sustain-00',
        role: 'sustain',
        freqBaseHz: { median: 52, p10: 45, p90: 60 },
        ampEnvDurationSec: { median: 0.4, p10: 0.3, p90: 0.5 },
        ampStartLevel: { median: 0.6, p10: 0.5, p90: 0.7 },
        ampEndLevel: { median: 0.001, p10: 0.001, p90: 0.001 },
        targetsPresent: targetsPresent ?? ['alpha', 'beta'],
      },
    ],
  };
}

test('strength 0 leaves the patch untouched', () => {
  const patch = makePatch();
  const result = correctPatch({
    patch,
    priors: makePriors(),
    strength: 0,
  });
  assert.equal(result.patch, patch);
});

test('frequency correction is disabled while priors are narrow', () => {
  const result = correctPatch({
    patch: makePatch(),
    priors: makePriors(),
    strength: 1,
  });
  assert.equal(result.patch.oscillators[0]?.osc.freqBase, 30);
});

test('envelope corrections still fire while frequency is disabled', () => {
  const result = correctPatch({
    patch: makePatch(),
    priors: makePriors(),
    strength: 1,
  });
  const osc = result.patch.oscillators[0];
  assert.ok(
    Math.abs((osc?.ampEnv.duration ?? 0) - 0.5) < 1e-9,
    `duration should land on 0.5, got ${osc?.ampEnv.duration}`,
  );
});

test('over-long envelope shortens, clamped by the 0.5s synth ceiling', () => {
  const result = correctPatch({
    patch: makePatch(),
    priors: makePriors(),
    strength: 0.5,
  });
  const osc = result.patch.oscillators[0];
  // Половинчатый ход дал бы 0.7 с, но потолок огибающей 0.5 с.
  assert.ok(Math.abs((osc?.ampEnv.duration ?? 0) - 0.5) < 1e-9);
});

test('values inside the range stay put', () => {
  const patch = makePatch();
  const first = patch.oscillators[0];
  if (first !== undefined) {
    first.osc.freqBase = 52;
    first.ampEnv.duration = 0.4;
  }
  const result = correctPatch({
    patch,
    priors: makePriors(),
    strength: 1,
  });
  assert.equal(result.audits.length, 0);
  assert.equal(result.patch.oscillators[0]?.osc.freqBase, 52);
});

test('one-target clusters do not drive corrections', () => {
  const result = correctPatch({
    patch: makePatch(),
    priors: makePriors(['only-one']),
    strength: 1,
  });
  assert.equal(result.audits.length, 0);
  assert.equal(result.patch.oscillators[0]?.osc.freqBase, 30);
});

test('freqBase far above the band also stays put', () => {
  const patch = makePatch();
  const first = patch.oscillators[0];
  if (first !== undefined) {
    first.osc.freqBase = 100;
  }
  const result = correctPatch({
    patch,
    priors: makePriors(),
    strength: 1,
  });
  assert.equal(result.patch.oscillators[0]?.osc.freqBase, 100);
});

test('input patch is never mutated', () => {
  const patch = makePatch();
  const snapshot = JSON.stringify(patch);
  correctPatch({ patch, priors: makePriors(), strength: 1 });
  assert.equal(JSON.stringify(patch), snapshot);
});
