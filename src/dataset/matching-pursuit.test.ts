import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArgCreateSynth } from '../synth';
import { pursueResidualAtoms } from './matching-pursuit';
import { renderSamples } from './shared';

/** Короткий атом с известной частотой, огибающей и фазой. */
function atom(arg: {
  frequency: number;
  level: number;
  phase: number;
  duration?: number;
}): ArgCreateSynth['oscillators'][number] {
  const duration = arg.duration ?? 0.02;
  return {
    osc: {
      on: true,
      freqBase: arg.frequency,
      freqStart: arg.frequency,
      duration,
      slope: 1,
      phase: arg.phase,
    },
    ampEnv: {
      startLevel: arg.level,
      endLevel: 0.001,
      duration,
      slope: 2,
    },
  };
}

/** Выключенный слот, который pursuit может заполнить. */
function off(): ArgCreateSynth['oscillators'][number] {
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

/** Рендерит 200 мс known-answer target. */
function render(patch: ArgCreateSynth): Int16Array {
  return renderSamples(patch, 0.2, { phaseModel: 'integral' });
}

test('pursuit adds a known short atom into a free slot', () => {
  const source: ArgCreateSynth = {
    oscillators: [atom({ frequency: 800, level: 0.3, phase: 0.7 })],
  };
  const target = render(source);
  const result = pursueResidualAtoms({
    patch: { oscillators: [off()] },
    target,
    phaseModel: 'integral',
    maxSteps: 1,
  });
  assert.equal(result.status, 'refined');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.slot, 0);
  assert.ok(result.metrics.globalSuppressionPercent > 99);
  assert.ok(Math.abs((result.steps[0]?.frequency ?? 0) - 800) < 1);
  assert.equal(result.patch.oscillators.length, 1);
  assert.equal(result.exactEvaluations <= 16, true);
});

test('pursuit recovers a known 6 kHz five-millisecond attack atom', () => {
  const source: ArgCreateSynth = {
    oscillators: [
      atom({
        frequency: 6000,
        level: 0.3,
        phase: 0.7,
        duration: 0.005,
      }),
    ],
  };
  const result = pursueResidualAtoms({
    patch: { oscillators: [off()] },
    target: render(source),
    phaseModel: 'integral',
    maxSteps: 1,
  });
  assert.equal(result.status, 'refined');
  assert.ok(result.metrics.globalSuppressionPercent > 99);
  assert.ok(Math.abs((result.steps[0]?.frequency ?? 0) - 6000) < 3);
  assert.equal(result.steps[0]?.window, 'attack');
});

test('pursuit replaces a harmful oscillator when no slot is free', () => {
  const source: ArgCreateSynth = {
    oscillators: [atom({ frequency: 800, level: 0.3, phase: 0.7 })],
  };
  const wrong = atom({ frequency: 500, level: 0.4, phase: 2 });
  const result = pursueResidualAtoms({
    patch: { oscillators: [wrong] },
    target: render(source),
    phaseModel: 'integral',
    maxSteps: 1,
  });
  assert.equal(result.status, 'refined');
  assert.equal(result.steps[0]?.replacedFrequency, 500);
  assert.ok(result.metrics.globalSuppressionPercent > 99);
});

test('pursuit uses a low sweep template without retuning the source', () => {
  const swept = (
    frequency: number,
    phase: number,
  ): ArgCreateSynth['oscillators'][number] => ({
    osc: {
      on: true,
      freqBase: frequency,
      freqStart: frequency * 1.5,
      duration: 0.1,
      slope: 1,
      phase,
    },
    ampEnv: {
      startLevel: 0.2,
      endLevel: 0.001,
      duration: 0.1,
      slope: 1,
    },
  });
  const template = swept(80, 0.3);
  const missing = swept(50, 0.8);
  const result = pursueResidualAtoms({
    patch: { oscillators: [template, off()] },
    target: render({ oscillators: [template, missing] }),
    phaseModel: 'integral',
    maxSteps: 1,
  });
  assert.equal(result.status, 'refined');
  assert.equal(result.steps[0]?.sweepTemplateIndex, 0);
  assert.ok(result.metrics.globalSuppressionPercent > 99);
  assert.equal(result.patch.oscillators[0]?.osc.freqBase, 80);
  assert.equal(result.patch.oscillators[0]?.osc.freqStart, 120);
});

test('exact match returns unchanged and invalid input throws', () => {
  const source: ArgCreateSynth = {
    oscillators: [atom({ frequency: 800, level: 0.3, phase: 0.7 })],
  };
  const target = render(source);
  const result = pursueResidualAtoms({
    patch: source,
    target,
    phaseModel: 'integral',
    maxSteps: 1,
  });
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.patch, source);
  assert.throws(
    () => pursueResidualAtoms({ patch: source, target: [] }),
    /Пустой target/,
  );
  assert.throws(
    () =>
      pursueResidualAtoms({
        patch: source,
        target,
        maxSteps: 49,
      }),
    /maxSteps/,
  );
});
