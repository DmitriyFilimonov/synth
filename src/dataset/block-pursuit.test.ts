import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../consts';
import type { ArgCreateSynth } from '../synth';
import type { QuadratureFit } from './quadrature-refit';
import {
  fitQuadratureBlock,
  pursueResidualBlocks,
} from './block-pursuit';
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

/** Выключенный слот, который блочный pursuit может заполнить. */
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

/** Возвращает кратчайшую разницу двух фаз на окружности. */
function phaseDistance(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

test('joint 4x4 fit recovers two non-orthogonal quadrature atoms', () => {
  const length = 8192;
  const basis = Array.from(
    { length: 4 },
    () => new Float64Array(length),
  );
  const expected = [
    { sine: 0.28, cosine: -0.17 },
    { sine: -0.11, cosine: 0.23 },
  ];
  const target = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const time = index / 44100;
    const firstEnvelope = Math.exp((Math.log(0.001) * time) / 0.1);
    const secondEnvelope = Math.exp(
      Math.log(0.001) * (time / 0.16) ** 1.4,
    );
    const values = [
      Math.sin(2 * Math.PI * 73 * time) * firstEnvelope,
      Math.cos(2 * Math.PI * 73 * time) * firstEnvelope,
      Math.sin(2 * Math.PI * 79 * time) * secondEnvelope,
      Math.cos(2 * Math.PI * 79 * time) * secondEnvelope,
    ];
    for (let column = 0; column < basis.length; column += 1) {
      basis[column]?.set([values[column] ?? 0], index);
      const atomIndex = Math.floor(column / 2);
      const coefficients = expected[atomIndex];
      const coefficient =
        column % 2 === 0
          ? (coefficients?.sine ?? 0)
          : (coefficients?.cosine ?? 0);
      target[index] =
        (target[index] ?? 0) +
        coefficient *
          (values[column] ?? 0) *
          MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
    }
  }
  const pcm = Int16Array.from(target, (value) => Math.round(value));
  const fits = fitQuadratureBlock({
    basis,
    target: pcm,
    rawWithout: new Float64Array(length),
  });
  assert.equal(fits?.length, 2);
  for (
    let atomIndex = 0;
    atomIndex < expected.length;
    atomIndex += 1
  ) {
    const fit: QuadratureFit | undefined = fits?.[atomIndex];
    const coefficients = expected[atomIndex];
    assert.ok(fit !== undefined && coefficients !== undefined);
    assert.ok(
      Math.abs(fit.sineCoefficient - coefficients.sine) < 0.0001,
    );
    assert.ok(
      Math.abs(fit.cosineCoefficient - coefficients.cosine) < 0.0001,
    );
    assert.ok(
      Math.abs(
        fit.startLevel -
          Math.hypot(coefficients.sine, coefficients.cosine),
      ) < 0.0001,
    );
    assert.ok(
      phaseDistance(
        fit.phase,
        Math.atan2(coefficients.cosine, coefficients.sine),
      ) < 0.001,
    );
  }
});

test('joint fit applies active-set level bounds and rejects singular input', () => {
  const length = 4096;
  const sine = new Float64Array(length);
  const cosine = new Float64Array(length);
  const target = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const angle = (2 * Math.PI * 100 * index) / length;
    sine[index] = Math.sin(angle);
    cosine[index] = Math.cos(angle);
    target[index] =
      2 * (sine[index] ?? 0) * MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
  }
  const bounded = fitQuadratureBlock({
    basis: [sine, cosine],
    target,
    rawWithout: new Float64Array(length),
  });
  assert.equal(bounded?.length, 1);
  assert.equal(bounded?.[0]?.startLevel, 1);
  assert.ok(Math.abs(bounded?.[0]?.sineCoefficient ?? 0) > 0.999);
  const singular = fitQuadratureBlock({
    basis: [sine, cosine, sine, cosine],
    target,
    rawWithout: new Float64Array(length),
  });
  assert.equal(singular, null);
  assert.equal(
    fitQuadratureBlock({
      basis: [sine],
      target,
      rawWithout: new Float64Array(length),
    }),
    null,
  );
});

test('bounded fit reoptimizes phase on an anisotropic Gram matrix', () => {
  const sine = Float64Array.from([2, 0]);
  const cosine = Float64Array.from([0, 1]);
  const target = Float64Array.from([
    2 * MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  ]);
  const fit = fitQuadratureBlock({
    basis: [sine, cosine],
    target,
    rawWithout: new Float64Array(2),
  })?.[0];
  assert.ok(fit !== undefined);
  assert.ok(Math.abs(fit.startLevel - 1) < 1e-9);
  assert.ok(fit.sineCoefficient > 0.8);
  assert.ok(fit.cosineCoefficient > 0.5);
  assert.ok(fit.cosineCoefficient < 0.6);
  const gain =
    2 * (4 * fit.sineCoefficient + fit.cosineCoefficient) -
    (4 * fit.sineCoefficient ** 2 + fit.cosineCoefficient ** 2);
  const oldGain = 2 * (4 / Math.sqrt(2) + 1 / Math.sqrt(2)) - 2.5;
  assert.ok(gain > oldGain + 0.05);
});

test('K2 recovers a known low body and high attack in one block', () => {
  const source: ArgCreateSynth = {
    oscillators: [
      atom({ frequency: 80, level: 0.3, phase: 0.4, duration: 0.1 }),
      atom({
        frequency: 6000,
        level: 0.2,
        phase: 0.7,
        duration: 0.005,
      }),
    ],
  };
  const patch: ArgCreateSynth = { oscillators: [off(), off()] };
  const original = structuredClone(patch);
  const result = pursueResidualBlocks({
    patch,
    target: render(source),
    phaseModel: 'integral',
    blockSize: 2,
    maxBlocks: 1,
    diverseShortlist: true,
  });
  assert.equal(result.status, 'refined');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.atoms.length, 2);
  assert.equal(result.replacementCount, 2);
  assert.ok(result.metrics.globalSuppressionPercent > 99);
  const frequencies =
    result.steps[0]?.atoms.map((entry) => entry.frequency) ?? [];
  assert.ok(
    frequencies.some((frequency) => Math.abs(frequency - 80) < 2),
  );
  assert.ok(
    frequencies.some((frequency) => Math.abs(frequency - 6000) < 4),
  );
  assert.ok(result.exactEvaluations <= 8);
  assert.deepEqual(patch, original);
});

test('K1 uses the same dictionary and exact match falls back unchanged', () => {
  const source: ArgCreateSynth = {
    oscillators: [
      atom({ frequency: 800, level: 0.3, phase: 0.7 }),
      atom({
        frequency: 6000,
        level: 0.2,
        phase: 0.2,
        duration: 0.005,
      }),
    ],
  };
  const target = render(source);
  const recovered = pursueResidualBlocks({
    patch: { oscillators: [off(), off()] },
    target,
    phaseModel: 'integral',
    blockSize: 1,
    maxBlocks: 2,
    diverseShortlist: true,
  });
  assert.equal(recovered.status, 'refined');
  assert.ok(recovered.metrics.globalSuppressionPercent > 99);
  assert.ok(recovered.slotSetsEvaluated >= 2);
  const unchanged = pursueResidualBlocks({
    patch: source,
    target,
    phaseModel: 'integral',
    blockSize: 2,
    maxBlocks: 1,
    diverseShortlist: true,
  });
  assert.equal(unchanged.status, 'unchanged');
  assert.deepEqual(unchanged.patch, source);
  assert.equal(unchanged.replacementCount, 0);
  assert.throws(
    () =>
      pursueResidualBlocks({
        patch: source,
        target,
        blockSize: 2,
        maxBlocks: 13,
      }),
    /maxBlocks/,
  );
});
