/**
 * Тесты модели фазы осциллятора (T21).
 *
 * `legacy` обязан остаться побитово прежним: его хэш зафиксирован до
 * правки. `integral` обязан давать фазу, равную интегралу частоты:
 * сверяем с численным интегралом Симпсона на мелкой сетке. При
 * постоянной частоте модели совпадают.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createCyclePhase,
  createSynth,
  frequencyEnvelopeCreator,
  type ArgCreateSynth,
} from './synth';
import { renderSamples } from './dataset/shared';

/** Патч со свипом и постоянным компонентом для регрессионного хэша. */
function regressionPatch(): ArgCreateSynth {
  return {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 46,
          freqStart: 800,
          slope: 0.8,
          duration: 0.09,
          phase: 0.4,
        },
        ampEnv: {
          duration: 0.35,
          endLevel: 0.001,
          slope: 0.8,
          startLevel: 0.6,
        },
      },
      {
        osc: {
          on: true,
          freqBase: 61,
          freqStart: 61,
          slope: 1.2,
          duration: 0.2,
          phase: 2.1,
        },
        ampEnv: {
          duration: 0.3,
          endLevel: 0.01,
          slope: 1,
          startLevel: 0.3,
        },
      },
      {
        osc: {
          on: false,
          freqBase: 900,
          freqStart: 2000,
          slope: 1,
          duration: 0.05,
          phase: 0,
        },
        ampEnv: {
          duration: 0.05,
          endLevel: 0.001,
          slope: 2,
          startLevel: 0.2,
        },
      },
    ],
  };
}

test('legacy render stays bit-identical to the pre-fix baseline', () => {
  const digest = createHash('sha256')
    .update(Buffer.from(renderSamples(regressionPatch(), 0.5).buffer))
    .digest('hex');
  assert.equal(
    digest,
    'a67f1c7c4131b732b1bf87575edc7d1e60d9f9611497eb28f1bd04f9159b2658',
  );
});

test('constant frequency renders identically in both phase models', () => {
  const flat: ArgCreateSynth = {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 73,
          freqStart: 73,
          slope: 1,
          duration: 0.2,
          phase: 1.1,
        },
        ampEnv: {
          duration: 0.3,
          endLevel: 0.2,
          slope: 0.8,
          startLevel: 0.4,
        },
      },
    ],
  };
  const a = renderSamples(flat, 0.3, { phaseModel: 'legacy' });
  const b = renderSamples(flat, 0.3, { phaseModel: 'integral' });
  assert.deepEqual([...b], [...a]);
});

test('integral phase matches a fine Simpson integral of frequency', () => {
  const { frequencyEnvelop } = frequencyEnvelopeCreator({
    base: 50,
    modulation: 50,
    duration: 0.1,
    slope: 0.8,
  });
  const cyclesAt = createCyclePhase(frequencyEnvelop);
  const fineIntegral = (x: number): number => {
    const n = 2000;
    const h = x / n;
    let sum = frequencyEnvelop({ x: 0 }) + frequencyEnvelop({ x });
    for (let k = 1; k < n; k++) {
      sum += (k % 2 === 0 ? 2 : 4) * frequencyEnvelop({ x: k * h });
    }
    return (sum * h) / 3;
  };
  for (const t of [0.005, 0.02, 0.05, 0.12, 0.3, 0.5]) {
    const err = Math.abs(cyclesAt(t) - fineIntegral(t));
    assert.ok(
      err < 1e-4,
      `phase error at ${t}s must stay below 1e-4 cycles, got ${err}`,
    );
  }
});

test('swept oscillator differs between models (option has an effect)', () => {
  const a = renderSamples(regressionPatch(), 0.5, {
    phaseModel: 'legacy',
  });
  const b = renderSamples(regressionPatch(), 0.5, {
    phaseModel: 'integral',
  });
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff = Math.max(diff, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  assert.ok(
    diff > 100,
    `models must diverge on a sweep, got ${diff} LSB`,
  );
});

test('createSynth default options keep the legacy model', () => {
  const viaDefault = createSynth(regressionPatch());
  const viaLegacy = createSynth(regressionPatch(), {
    phaseModel: 'legacy',
  });
  for (const x of [0.01, 0.05, 0.2]) {
    assert.equal(viaDefault({ x }), viaLegacy({ x }));
  }
});
