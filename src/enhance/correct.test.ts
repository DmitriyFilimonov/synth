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
function makePriors(): PriorsFile {
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

test('out-of-range freqBase moves to the boundary at strength 1', () => {
  const result = correctPatch({
    patch: makePatch(),
    priors: makePriors(),
    strength: 1,
  });
  const osc = result.patch.oscillators[0];
  assert.equal(osc?.osc.freqBase, 45);
});

test('sweep ratio survives the correction', () => {
  const result = correctPatch({
    patch: makePatch(),
    priors: makePriors(),
    strength: 1,
  });
  const osc = result.patch.oscillators[0];
  const ratio = (osc?.osc.freqStart ?? 0) / (osc?.osc.freqBase ?? 1);
  assert.ok(
    Math.abs(ratio - 5) < 1e-9,
    `ratio should stay 5, got ${ratio}`,
  );
});

test('strength 0.5 moves halfway toward the boundary', () => {
  const result = correctPatch({
    patch: makePatch(),
    priors: makePriors(),
    strength: 0.5,
  });
  const osc = result.patch.oscillators[0];
  assert.ok(Math.abs((osc?.osc.freqBase ?? 0) - 37.5) < 1e-9);
});

test('over-long envelope shortens to the upper boundary', () => {
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

test('input patch is never mutated', () => {
  const patch = makePatch();
  const snapshot = JSON.stringify(patch);
  correctPatch({ patch, priors: makePriors(), strength: 1 });
  assert.equal(JSON.stringify(patch), snapshot);
});
