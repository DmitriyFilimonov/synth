import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../consts';
import { SAMPLE_RATE } from '../consts';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { solveJointKQuadrature } from './joint-k-quadrature';
import { renderForTarget, renderGroup } from './quadrature-refit';
import { createStructuralWorkLedger } from './structural-work';
import {
  groupFromStructuralAtom,
  patchFromStructuralCandidate,
  renderStructuralBasis,
  structuralAtomShapeKey,
  structuralFitFromCoefficients,
  type StructuralAtomShape,
} from './structural-atom';

type Group = ArgCreateSynth['oscillators'][number];

const SCALE = MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
const TWO_PI = 2 * Math.PI;
const DELAYS = [
  0, 1, 17, 221, 3, 29, 47, 89, 5, 131, 7, 53, 233, 13, 71, 307, 19,
  101, 2, 37,
];
const FREQUENCIES = [
  73, 6000, 140, 73.2, 41, 55, 91, 127, 179, 251, 337, 479, 811, 1200,
  1800, 2600, 3600, 4800, 7500, 10000,
];

/** Детерминированный набор полных форм с близкими тонами и localized-полями. */
function structuralShapes(atomCount: number): StructuralAtomShape[] {
  return Array.from({ length: atomCount }, (_, index) => {
    const freqBase = FREQUENCIES[index] ?? 100 + index * 31;
    const constant = index === 0 || index === 3;
    const freqStart = constant
      ? freqBase
      : index === 1
        ? 9000
        : freqBase * (index % 2 === 0 ? 1.31 : 0.72);
    return {
      freqBase,
      freqStart,
      oscDuration: 0.012 + 0.004 * (index % 5),
      oscSlope: 0.45 + 0.09 * (index % 8),
      ampDuration: 0.025 + 0.011 * (index % 7),
      ampEndLevel: 0.01 + 0.015 * (index % 6),
      ampSlope: 0.35 + 0.11 * (index % 9),
      delaySamples: DELAYS[index] ?? index,
      attackSamples: [0, 3, 5, 11][index] ?? (index * 7) % 29,
      hardStop: index % 3 === 0 || index === 3,
    };
  });
}

/** Квантованная level/phase-пара в sine/cosine-соглашении solver. */
function coefficients(
  level: number,
  phase: number,
): [number, number] {
  return [level * Math.cos(phase), level * Math.sin(phase)];
}

/** Истинные коэффициенты заранее квантуются в PCM перед native-синтезом. */
function trueCoefficient(atom: number): [number, number] {
  const level = 0.011 + 0.002 * (atom % 7);
  const phase = (0.21 + atom * 0.618) % TWO_PI;
  return coefficients(level, phase).map(
    (value) => Math.round(value * SCALE) / SCALE,
  ) as [number, number];
}

/** От known-answer источника отличается только линейный fit. */
function initialCoefficient(atom: number): [number, number] {
  return coefficients(
    0.021 + 0.001 * (atom % 4),
    (2.17 + atom * 0.83) % TWO_PI,
  );
}

/** Off-слоты несут optional-поля, которые candidate обязан сохранить. */
function offGroup(index: number): Group {
  return {
    osc: {
      on: false,
      freqBase: 200 + index,
      freqStart: 500 + index,
      duration: 0.021 + index * 0.0001,
      slope: 1.4,
      phase: 0.37 + index * 0.01,
      ...(index % 4 === 0
        ? { delay: 0 }
        : index % 4 === 1
          ? { delay: 3 / SAMPLE_RATE }
          : {}),
    },
    ampEnv: {
      startLevel: 0.02,
      ...(index % 5 === 0 ? {} : { endLevel: 0.04 }),
      duration: 0.032 + index * 0.0001,
      slope: 1.1,
      ...(index % 6 === 0
        ? { attack: 0 }
        : index % 6 === 1
          ? { attack: 2 / SAMPLE_RATE }
          : {}),
      ...(index % 7 === 0
        ? { hardStop: false }
        : index % 7 === 1
          ? { hardStop: true }
          : {}),
    },
  };
}

/** Пятьдесят off-слотов отделяют replacement от vector conversion. */
function offSource(): ArgCreateSynth {
  return {
    oscillators: Array.from({ length: 50 }, (_, index) =>
      offGroup(index),
    ),
  };
}

/** Считает native global suppression против фактического target PCM. */
function globalSuppression(
  target: Int16Array,
  samples: Int16Array,
): number {
  let targetSquares = 0;
  let residualSquares = 0;
  for (let index = 0; index < target.length; index += 1) {
    const targetValue = target[index] ?? 0;
    const residual = targetValue - (samples[index] ?? 0);
    targetSquares += targetValue * targetValue;
    residualSquares += residual * residual;
  }
  assert.ok(targetSquares > 0);
  return 100 * (1 - Math.sqrt(residualSquares / targetSquares));
}

/** Требует точного совпадения всех нелинейных и optional-полей. */
function assertOnlyFitChanged(before: Group, after: Group): void {
  const normalized = structuredClone(after);
  normalized.osc.phase = before.osc.phase;
  normalized.ampEnv.startLevel = before.ampEnv.startLevel;
  assert.deepEqual(normalized, before);
}

test('shape keys are stable and zero/default optional fields stay absent', () => {
  const shape = structuralShapes(1)[0];
  assert.ok(shape !== undefined);
  const reordered: StructuralAtomShape = {
    hardStop: shape.hardStop,
    attackSamples: shape.attackSamples,
    delaySamples: shape.delaySamples,
    ampSlope: shape.ampSlope,
    ampEndLevel: shape.ampEndLevel,
    ampDuration: shape.ampDuration,
    oscSlope: shape.oscSlope,
    oscDuration: shape.oscDuration,
    freqStart: shape.freqStart,
    freqBase: shape.freqBase,
  };
  assert.equal(
    structuralAtomShapeKey(shape),
    structuralAtomShapeKey(reordered),
  );
  assert.notEqual(
    structuralAtomShapeKey(shape),
    structuralAtomShapeKey({ ...shape, attackSamples: 1 }),
  );
  const zeroShape: StructuralAtomShape = {
    ...shape,
    delaySamples: 0,
    attackSamples: 0,
    hardStop: false,
  };
  const fit = structuralFitFromCoefficients([0.2, -0.1]);
  assert.ok(fit !== null);
  const group = groupFromStructuralAtom(zeroShape, fit);
  assert.equal('delay' in group.osc, false);
  assert.equal('attack' in group.ampEnv, false);
  assert.equal('hardStop' in group.ampEnv, false);

  const localized = structuralShapes(4)[3];
  assert.ok(localized !== undefined);
  const delayed = groupFromStructuralAtom(localized, fit);
  assert.equal(delayed.osc.delay, 221 / SAMPLE_RATE);
  assert.equal(delayed.ampEnv.attack, 11 / SAMPLE_RATE);
  assert.equal(delayed.ampEnv.hardStop, true);
});

test('native fields and fit reject substantive norm violations without clamp', () => {
  const shape = structuralShapes(1)[0];
  assert.ok(shape !== undefined);
  const fit = structuralFitFromCoefficients([0.2, 0]);
  assert.ok(fit !== null);
  assert.throws(
    () =>
      groupFromStructuralAtom({ ...shape, freqBase: 19.999 }, fit),
    /freqBase/,
  );
  assert.throws(
    () =>
      groupFromStructuralAtom(
        { ...shape, delaySamples: 0.5 * SAMPLE_RATE + 1 },
        fit,
      ),
    /delaySamples/,
  );
  assert.equal(
    structuralFitFromCoefficients([1.000000000001, 0]),
    null,
  );
  const ulp = structuralFitFromCoefficients([1 + Number.EPSILON, 0]);
  assert.ok(ulp !== null);
  assert.equal(ulp.startLevel, 1);
});

test('native basis fills the shared ledger with 2K*N render work', () => {
  const work = createStructuralWorkLedger();
  const sampleCount = 64;
  const basis = renderStructuralBasis({
    shapes: structuralShapes(2),
    sampleCount,
    phaseModel: 'integral',
    work,
  });
  assert.equal(basis.length, 4);
  assert.deepEqual(work.sampleWork, {
    validation: 256,
    basis: 256,
    mixing: 0,
    quantize: 0,
    metric: 0,
    gram: 0,
    mask: 0,
    offset: 0,
    total: 512,
  });
  assert.ok(
    Object.values(work.denseWork).every((value) => value === 0),
  );
});

for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
  for (const atomCount of [4, 5, 20]) {
    test(`native joint K=${atomCount} restores ${phaseModel} canonical PCM`, () => {
      const shapes = structuralShapes(atomCount);
      const slots = Array.from(
        { length: atomCount },
        (_, index) => index,
      );
      const trueCoefficients = Array.from(
        { length: atomCount },
        (_, atom) => trueCoefficient(atom),
      ).flat();
      const initialCoefficients = Array.from(
        { length: atomCount },
        (_, atom) => initialCoefficient(atom),
      ).flat();
      const source = offSource();
      const truePatch = patchFromStructuralCandidate(source, {
        slots,
        shapes,
        coefficients: trueCoefficients,
      });
      const initialPatch = patchFromStructuralCandidate(source, {
        slots,
        shapes,
        coefficients: initialCoefficients,
      });
      const sampleCount = atomCount === 20 ? 8192 : 4096;
      const targetPcm = renderForTarget(
        truePatch,
        sampleCount,
        phaseModel,
      );
      const initialPcm = renderForTarget(
        initialPatch,
        sampleCount,
        phaseModel,
      );
      const target = Float64Array.from(
        targetPcm,
        (value) => value / SCALE,
      );
      const basis = renderStructuralBasis({
        shapes,
        sampleCount,
        phaseModel,
      });
      const sourceSnapshot = structuredClone(source);
      const initialSnapshot = structuredClone(initialPatch);
      const shapeSnapshot = structuredClone(shapes);
      const coefficientSnapshot = [...initialCoefficients];
      const result = solveJointKQuadrature({
        basis,
        target,
        fixedOffset: new Float64Array(sampleCount),
        initialCoefficients,
        maxInner: 8,
        maxBacktracks: 16,
      });
      const patch = patchFromStructuralCandidate(initialPatch, {
        slots,
        shapes,
        coefficients: result.coefficients,
      });
      const canonical = renderForTarget(
        patch,
        sampleCount,
        phaseModel,
      );
      assert.ok(result.diagnostics !== null);
      const global = globalSuppression(targetPcm, canonical);
      assert.ok(
        global > 99,
        `${phaseModel} K=${atomCount}: global=${global}, rss=${result.quantizedPcmRss}, rank=${result.diagnostics.effectiveRank}`,
      );
      assert.ok(
        result.quantizedPcmRss < result.initialQuantizedPcmRss,
      );
      assert.ok(
        globalSuppression(targetPcm, canonical) >
          globalSuppression(targetPcm, initialPcm),
      );
      assert.deepEqual(result.samples, canonical);
      assert.ok(result.diagnostics.effectiveRank > 0);
      assert.ok(result.diagnostics.effectiveRank <= atomCount * 2);
      assert.ok(Number.isFinite(result.diagnostics.condition ?? 0));
      assert.ok(Number.isFinite(result.quantizedPcmRss));
      if (atomCount < 20) {
        assert.equal(result.diagnostics.effectiveRank, atomCount * 2);
      }
      for (let slot = 0; slot < atomCount; slot += 1) {
        const before = truePatch.oscillators[slot];
        const after = patch.oscillators[slot];
        assert.ok(before !== undefined);
        assert.ok(after !== undefined);
        assertOnlyFitChanged(before, after);
      }
      for (let slot = atomCount; slot < 50; slot += 1) {
        assert.deepEqual(
          patch.oscillators[slot],
          source.oscillators[slot],
        );
      }
      assert.deepEqual(source, sourceSnapshot);
      assert.deepEqual(initialPatch, initialSnapshot);
      assert.deepEqual(shapes, shapeSnapshot);
      assert.deepEqual(initialCoefficients, coefficientSnapshot);
    });
  }
}

for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
  test(`native max-boundary coefficients roundtrip with fixedOffset in ${phaseModel}`, () => {
    const background: Group = {
      osc: {
        on: true,
        freqBase: 311,
        freqStart: 311,
        duration: 0.05,
        slope: 1,
        phase: 0.31,
      },
      ampEnv: {
        startLevel: 0.08,
        endLevel: 0.7,
        duration: 0.09,
        slope: 1.2,
      },
    };
    const shape: StructuralAtomShape = {
      freqBase: 73,
      freqStart: 120,
      oscDuration: 0.017,
      oscSlope: 1.1,
      ampDuration: 0.04,
      ampEndLevel: 0.2,
      ampSlope: 0.8,
      delaySamples: 17,
      attackSamples: 5,
      hardStop: true,
    };
    const source: ArgCreateSynth = {
      oscillators: [background, offGroup(1)],
    };
    const sourceSnapshot = structuredClone(source);
    const sampleCount = 1024;
    const work = createStructuralWorkLedger();
    const fixedOffset = renderGroup(
      background,
      sampleCount,
      phaseModel,
    );
    const basis = renderStructuralBasis({
      shapes: [shape],
      sampleCount,
      phaseModel,
      work,
    });
    const sine = basis[0];
    const cosine = basis[1];
    assert.ok(sine !== undefined);
    assert.ok(cosine !== undefined);
    const target = Float64Array.from(
      { length: sampleCount },
      (_, index) =>
        (fixedOffset[index] ?? 0) +
        1.2 * (sine[index] ?? 0) +
        0.4 * (cosine[index] ?? 0),
    );
    const result = solveJointKQuadrature({
      basis,
      target,
      fixedOffset,
      initialCoefficients: [0.05, 0.03],
      maxInner: 4,
      work,
    });
    assert.equal(result.fits[0]?.startLevel, 1);
    assert.ok(result.work.acceptedIterations > 0);
    const patch = patchFromStructuralCandidate(source, {
      slots: [1],
      shapes: [shape],
      coefficients: result.coefficients,
    });
    assert.equal(patch.oscillators[1]?.ampEnv.startLevel, 1);
    assert.equal(patch.oscillators[1]?.osc.delay, 17 / SAMPLE_RATE);
    assert.equal(
      patch.oscillators[1]?.ampEnv.attack,
      5 / SAMPLE_RATE,
    );
    const canonical = renderForTarget(patch, sampleCount, phaseModel);
    assert.deepEqual(canonical, result.samples);
    assert.deepEqual(source, sourceSnapshot);
    assert.equal(result.work.sampleWork.basis, sampleCount * 2);
  });
}

/** Валидные active/off-группы с различимыми optional-полями для слотов. */
function activeGroup(index: number, on = true): Group {
  const group = offGroup(index);
  group.osc.on = on;
  return group;
}

test('50 active atoms plus replacement 20 remains exactly 50', () => {
  const source: ArgCreateSynth = {
    oscillators: Array.from({ length: 50 }, (_, index) =>
      activeGroup(index),
    ),
  };
  const snapshot = structuredClone(source);
  const shapes = structuralShapes(20);
  const slots = Array.from({ length: 20 }, (_, index) => index + 10);
  const untouched = [0, 9, 30, 49];
  const patch = patchFromStructuralCandidate(source, {
    slots,
    shapes,
    coefficients: Array.from({ length: 20 }, (_, atom) =>
      trueCoefficient(atom),
    ).flat(),
  });
  assert.equal(patch.oscillators.length, 50);
  assert.equal(
    patch.oscillators.filter((group) => group.osc.on).length,
    50,
  );
  for (const slot of untouched) {
    assert.deepEqual(
      patch.oscillators[slot],
      source.oscillators[slot],
    );
  }
  assert.deepEqual(source, snapshot);
});

test('40 existing plus 20 appended atoms is rejected before a solve', () => {
  const source: ArgCreateSynth = {
    oscillators: Array.from({ length: 40 }, (_, index) =>
      activeGroup(index),
    ),
  };
  const shapes = structuralShapes(20);
  assert.throws(
    () =>
      patchFromStructuralCandidate(source, {
        slots: Array.from({ length: 20 }, (_, index) => index + 40),
        shapes,
        coefficients: new Array<number>(40).fill(0.01),
      }),
    /exceeds 50 slots/,
  );
});

test('valid contiguous appends fill the budget and duplicate slots fail', () => {
  const source: ArgCreateSynth = {
    oscillators: Array.from({ length: 45 }, (_, index) =>
      activeGroup(index),
    ),
  };
  const patch = patchFromStructuralCandidate(source, {
    slots: [45, 46, 47, 48, 49],
    shapes: structuralShapes(5),
    coefficients: Array.from({ length: 5 }, (_, atom) =>
      trueCoefficient(atom),
    ).flat(),
  });
  assert.equal(patch.oscillators.length, 50);
  assert.equal(
    patch.oscillators.filter((group) => group.osc.on).length,
    50,
  );
  assert.throws(
    () =>
      patchFromStructuralCandidate(offSource(), {
        slots: [0, 0],
        shapes: structuralShapes(2),
        coefficients: [0.01, 0.01, 0.01, 0.01],
      }),
    /duplicate structural candidate slot/,
  );
  assert.throws(
    () =>
      patchFromStructuralCandidate(source, {
        slots: [45, 47],
        shapes: structuralShapes(2),
        coefficients: [0.01, 0.01, 0.01, 0.01],
      }),
    /must not contain gaps/,
  );
});
