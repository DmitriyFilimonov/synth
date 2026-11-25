import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../consts';
import {
  solveJointKQuadrature,
  type JointKQuadratureInput,
} from './joint-k-quadrature';

const SCALE = MAX_AMPLITUDE_16_BIT_WAV_ENCODED;

/** Квантует известный коэффициент до построения continuous target. */
function q(value: number): number {
  return Math.round(SCALE * value) / SCALE;
}

/** Строит N=2K поэлементно ортонормированных sine/cosine-столбцов. */
function orthonormalBasis(atomCount: number): Float64Array[] {
  const sampleCount = atomCount * 2;
  return Array.from({ length: sampleCount }, (_, column) => {
    const values = new Float64Array(sampleCount);
    values[column] = 1;
    return values;
  });
}

/** Точный known-answer без clipping; каждый начальный коэффициент равен 0.01. */
function exactInput(atomCount: number): {
  input: JointKQuadratureInput;
  expectedCoefficients: number[];
  expectedPcm: Int16Array;
} {
  const basis = orthonormalBasis(atomCount);
  const expectedCoefficients = Array.from(
    { length: atomCount * 2 },
    (_, column) => {
      const atom = Math.floor(column / 2);
      const phase = 0.19 + atom * 0.73;
      const level = 0.015 + 0.002 * (atom % 11);
      return q(
        level *
          (column % 2 === 0 ? Math.cos(phase) : Math.sin(phase)),
      );
    },
  );
  const target = new Float64Array(atomCount * 2);
  for (let sample = 0; sample < target.length; sample += 1) {
    let value = 0;
    for (let column = 0; column < basis.length; column += 1) {
      value +=
        (basis[column]?.[sample] ?? 0) *
        (expectedCoefficients[column] ?? 0);
    }
    target[sample] = value;
  }
  return {
    input: {
      basis,
      target,
      fixedOffset: new Float64Array(target.length),
      initialCoefficients: new Array<number>(
        expectedCoefficients.length,
      ).fill(0.01),
      maxInner: 4,
      maxBacktracks: 8,
    },
    expectedCoefficients,
    expectedPcm: Int16Array.from(target, (value) =>
      Math.round(value * SCALE),
    ),
  };
}

/** K=2,N=3 fixture с accepted backtrack, mask change и ненулевым остатком. */
function workFixture(
  maxInner: number,
  maxJacobiSweeps?: number,
): JointKQuadratureInput {
  return {
    basis: [
      Float64Array.from([0.5, -1, 0.5]),
      Float64Array.from([0, -1, 0]),
      Float64Array.from([0.5, 0, -1]),
      Float64Array.from([-0.5, 0.5, 1]),
    ],
    target: [
      -0.3242680444382131, -0.8359837220050395, -0.14471111865714192,
    ],
    fixedOffset: [
      0.43277033884078264, -0.5094605176709592, -0.14486215496435761,
    ],
    initialCoefficients: [
      0.4625129152089358, 0.7968961115926505, 0.16318506971001626,
      0.5342655211687088,
    ],
    maxInner,
    maxBacktracks: 8,
    ...(maxJacobiSweeps === undefined ? {} : { maxJacobiSweeps }),
  };
}

for (const atomCount of [4, 5, 20, 50]) {
  test(`exact orthonormal K=${atomCount} recovers coefficients and PCM`, () => {
    const { input, expectedCoefficients, expectedPcm } =
      exactInput(atomCount);
    const result = solveJointKQuadrature(input);
    assert.ok(result.diagnostics !== null);
    assert.equal(result.diagnostics.atomCount, atomCount);
    assert.equal(result.diagnostics.basisColumns, atomCount * 2);
    assert.equal(result.diagnostics.effectiveRank, atomCount * 2);
    assert.equal(result.diagnostics.rankDeficiency, 0);
    assert.equal(result.stopReason, 'converged');
    assert.equal(result.quantizedPcmRss, 0);
    assert.deepEqual(result.samples, expectedPcm);
    assert.equal(
      result.coefficients.length,
      expectedCoefficients.length,
    );
    for (
      let column = 0;
      column < expectedCoefficients.length;
      column += 1
    ) {
      const actual = result.coefficients[column] ?? 0;
      const expected = expectedCoefficients[column] ?? 0;
      assert.ok(
        Math.abs(actual - expected) <= 1e-9,
        `column ${column}: ${actual} != ${expected}`,
      );
      assert.ok(Number.isFinite(actual));
    }
  });
}

test('rank collapse K=20,N=2 returns the minimum-norm pair split', () => {
  const target = Float64Array.from([q(0.4), q(-0.2)]);
  const basis = Array.from({ length: 40 }, (_, column) => {
    const values = new Float64Array(2);
    values[column % 2] = 1;
    return values;
  });
  const result = solveJointKQuadrature({
    basis,
    target,
    initialCoefficients: new Array<number>(40).fill(0.01),
    maxInner: 3,
  });
  assert.ok(result.diagnostics !== null);
  assert.equal(result.diagnostics.effectiveRank, 2);
  assert.equal(result.diagnostics.rankDeficiency, 38);
  assert.equal(result.quantizedPcmRss, 0);
  assert.deepEqual(
    result.samples,
    Int16Array.from(target, (value) => Math.round(value * SCALE)),
  );
  const minimum = result.minimumNormCoefficients;
  assert.ok(minimum !== null);
  for (let atom = 0; atom < 20; atom += 1) {
    const sine = result.coefficients[atom * 2] ?? 0;
    const cosine = result.coefficients[atom * 2 + 1] ?? 0;
    assert.ok(Math.abs(sine - (target[0] ?? 0) / 20) < 1e-12);
    assert.ok(Math.abs(cosine - (target[1] ?? 0) / 20) < 1e-12);
    assert.ok(Number.isFinite(sine));
    assert.ok(Number.isFinite(cosine));
    assert.ok(Math.abs((minimum[atom * 2] ?? 0) - sine) < 1e-12);
    assert.ok(
      Math.abs((minimum[atom * 2 + 1] ?? 0) - cosine) < 1e-12,
    );
  }
  const restored = result.coefficients.reduce(
    (sums, value, column) => {
      sums[column % 2] = (sums[column % 2] ?? 0) + value;
      return sums;
    },
    [0, 0],
  );
  assert.ok(Math.abs((restored[0] ?? 0) - (target[0] ?? 0)) < 1e-12);
  assert.ok(Math.abs((restored[1] ?? 0) - (target[1] ?? 0)) < 1e-12);
});

test('zero-support atom is rejected instead of becoming audible 0.001', () => {
  const sine = Float64Array.from([1, 0]);
  const cosine = Float64Array.from([0, 1]);
  const zero = new Float64Array(2);
  assert.throws(
    () =>
      solveJointKQuadrature({
        basis: [sine, cosine, zero, zero],
        target: [q(0.2), q(-0.1)],
        initialCoefficients: [0.01, 0.01, 0.01, 0.01],
      }),
    /Zero-support structural atom 1/,
  );
});

test('globally supported atom fully hidden by the clip mask keeps its pair', () => {
  const target = Float64Array.from([1, q(0.4)]);
  const result = solveJointKQuadrature({
    basis: [
      Float64Array.from([0, 1]),
      new Float64Array(2),
      Float64Array.from([1, 0]),
      new Float64Array(2),
    ],
    target,
    fixedOffset: [1.2, 0],
    initialCoefficients: [0.01, 0, 0.02, 0],
    maxInner: 2,
  });
  assert.equal(result.stopReason, 'converged');
  assert.equal(result.work.acceptedIterations, 1);
  assert.ok(result.diagnostics !== null);
  assert.equal(result.diagnostics.effectiveRank, 1);
  assert.ok(
    result.diagnostics.droppedColumns.some(
      (entry) => entry.atom === 1 && entry.kind === 'sine',
    ),
  );
  assert.equal(result.coefficients[2], 0.02);
  assert.equal(result.fits[1]?.startLevel, 0.02);
  assert.deepEqual(
    result.samples,
    Int16Array.from(target, (value) => Math.round(value * SCALE)),
  );
});

test('radial lower and upper bounds preserve phase and report projections', () => {
  const basis = orthonormalBasis(1);
  const lower = solveJointKQuadrature({
    basis,
    target: [q(1 / SCALE), 0],
    initialCoefficients: [0.01, 0.01],
    maxInner: 2,
  });
  assert.equal(lower.fits[0]?.startLevel, 0.001);
  assert.ok(lower.work.boundaryProjections > 0);
  assert.ok(lower.coefficients.every(Number.isFinite));

  const scaledBasis = basis.map((column) =>
    Float64Array.from(column, (value) => value * 0.25),
  );
  const upper = solveJointKQuadrature({
    basis: scaledBasis,
    target: [q(0.4), q(-0.2)],
    initialCoefficients: [0.01, 0.01],
    maxInner: 2,
  });
  const minimum = upper.minimumNormCoefficients;
  assert.ok(minimum !== null);
  assert.ok(Math.hypot(minimum[0] ?? 0, minimum[1] ?? 0) > 1);
  assert.equal(upper.fits[0]?.startLevel, 1);
  assert.ok(upper.work.boundaryProjections > 0);
  const expectedRatio = (minimum[1] ?? 0) / (minimum[0] ?? 1);
  const actualRatio =
    (upper.coefficients[1] ?? 0) / (upper.coefficients[0] ?? 1);
  assert.ok(Math.abs(actualRatio - expectedRatio) < 1e-12);
});

test('zero initial radial norm projects to MIN_LEVEL, never MAX_LEVEL', () => {
  const result = solveJointKQuadrature({
    basis: orthonormalBasis(1),
    target: [q(0.2), q(-0.1)],
    initialCoefficients: [0, 0],
    maxInner: 0,
  });
  assert.equal(result.fits[0]?.startLevel, 0.001);
  assert.equal(result.fits[0]?.phase, 0);
  assert.equal(result.work.boundaryProjections, 1);
  assert.ok(
    Math.abs(
      Math.hypot(
        result.coefficients[0] ?? 0,
        result.coefficients[1] ?? 0,
      ) - 0.001,
    ) < 1e-18,
  );
  assert.deepEqual(result.samples, Int16Array.from([33, 0]));
});

test('zero target moves a nonzero initial pair downward and lowers PCM RSS', () => {
  const result = solveJointKQuadrature({
    basis: orthonormalBasis(1),
    target: [0, 0],
    initialCoefficients: [0.2, -0.1],
    maxInner: 1,
  });
  assert.equal(result.fits[0]?.startLevel, 0.001);
  assert.ok(result.initialQuantizedPcmRss > 0);
  assert.ok(result.quantizedPcmRss < result.initialQuantizedPcmRss);
  assert.equal(result.work.normalEquationBuilds, 1);
  assert.equal(result.work.acceptedIterations, 1);
  assert.equal(result.stopReason, 'iteration-limit');
});

test('fixedOffset normal equations use target minus fixedOffset', () => {
  const target = Float64Array.from([q(0.4), q(-0.2)]);
  const fixedOffset = Float64Array.from([q(0.1), q(-0.05)]);
  const result = solveJointKQuadrature({
    basis: orthonormalBasis(1),
    target,
    fixedOffset,
    initialCoefficients: [0.01, 0.01],
    maxInner: 2,
  });
  const expected = [
    (target[0] ?? 0) - (fixedOffset[0] ?? 0),
    (target[1] ?? 0) - (fixedOffset[1] ?? 0),
  ];
  assert.ok(
    Math.abs((result.coefficients[0] ?? 0) - (expected[0] ?? 0)) <
      1e-12,
  );
  assert.ok(
    Math.abs((result.coefficients[1] ?? 0) - (expected[1] ?? 0)) <
      1e-12,
  );
  // Без вычитания fixedOffset в rhs solver вернул бы сам target.
  assert.ok(
    Math.abs((result.coefficients[0] ?? 0) - (target[0] ?? 0)) > 0.09,
  );
  assert.equal(result.quantizedPcmRss, 0);
  assert.deepEqual(
    result.samples,
    Int16Array.from(target, (value) => Math.round(value * SCALE)),
  );
});

test('clip trap optimizes the full fixed offset, not a standalone atom', () => {
  const shape = Float64Array.from([1, 0.5]);
  const zero = new Float64Array(2);
  const target = Float64Array.from([1, q(0.75)]);
  const fixedOffset = Float64Array.from([0.2, 0.1]);
  const result = solveJointKQuadrature({
    basis: [shape, zero, shape, zero],
    target,
    fixedOffset,
    initialCoefficients: [0.01, 0, 0.01, 0],
    maxInner: 5,
    maxBacktracks: 12,
  });
  const total =
    (result.coefficients[0] ?? 0) + (result.coefficients[2] ?? 0);
  const expectedTotal = 2 * ((target[1] ?? 0) - 0.1);
  assert.ok(Math.abs(total - expectedTotal) < 1e-10);
  assert.ok(Math.abs(total - 1.5) > 0.19);
  assert.equal(result.stopReason, 'converged');
  assert.equal(result.quantizedPcmRss, 0);
  assert.equal(result.saturatedSamples, 1);
  assert.equal(result.samples[0], SCALE);
  assert.equal(
    result.samples[1],
    Math.round((target[1] ?? 0) * SCALE),
  );
  assert.ok(result.diagnostics !== null);
  assert.equal(result.diagnostics.effectiveRank, 1);
  assert.ok(result.history.some((entry) => entry.maskChanges > 0));
});

test('continuous target is not quantized into a second target PCM', () => {
  const target = Float64Array.from([
    1000.25 / SCALE,
    -2000.25 / SCALE,
  ]);
  const result = solveJointKQuadrature({
    basis: orthonormalBasis(1),
    target,
    initialCoefficients: [0.01, 0.01],
    maxInner: 2,
  });
  assert.ok(
    Math.abs((result.coefficients[0] ?? 0) - (target[0] ?? 0)) <
      1e-12,
  );
  assert.ok(
    Math.abs((result.coefficients[1] ?? 0) - (target[1] ?? 0)) <
      1e-12,
  );
  assert.deepEqual(result.samples, Int16Array.from([1000, -2000]));
  const expectedRss = 2 * (0.25 / SCALE) ** 2;
  assert.ok(result.quantizedPcmRss > 0);
  assert.ok(Math.abs(result.quantizedPcmRss - expectedRss) < 1e-20);
});

test('continuous descent on equal Int16 PCM is a plateau, not an accept', () => {
  const initial = 0.01;
  const target = Float64Array.from([initial - 0.1 / SCALE]);
  const result = solveJointKQuadrature({
    basis: [Float64Array.from([1]), Float64Array.from([0])],
    target,
    initialCoefficients: [initial, 0],
    maxInner: 3,
    maxBacktracks: 4,
  });
  assert.equal(result.stopReason, 'quantized-plateau');
  assert.equal(result.history.length, 0);
  assert.equal(result.work.backtracks, 5);
  assert.equal(result.work.objectiveEvaluations, 6);
  assert.equal(result.coefficients[0], initial);
  assert.ok(
    Math.abs(
      (result.minimumNormCoefficients?.[0] ?? 0) - (target[0] ?? 0),
    ) < 1e-15,
  );
  assert.equal(result.samples[0], Math.round(initial * SCALE));
});

test('maxInner=0 skips normal equations and eigen work entirely', () => {
  const result = solveJointKQuadrature(workFixture(0));
  assert.equal(result.stopReason, 'iteration-limit');
  assert.equal(result.diagnostics, null);
  assert.equal(result.work.normalEquationBuilds, 0);
  assert.equal(result.work.eigenDecompositions, 0);
  assert.equal(result.work.pseudoInverseSolves, 0);
  assert.equal(result.work.objectiveEvaluations, 1);
  assert.deepEqual(result.work.sampleWork, {
    validation: 27,
    basis: 0,
    mixing: 12,
    quantize: 3,
    metric: 3,
    gram: 0,
    mask: 3,
    offset: 3,
    total: 51,
  });
  assert.ok(
    Object.values(result.work.denseWork).every(
      (value) => value === 0,
    ),
  );
});

test('maxInner=1 stops after one accepted step without a final Gram', () => {
  const result = solveJointKQuadrature(workFixture(1));
  assert.equal(result.stopReason, 'iteration-limit');
  assert.ok(result.quantizedPcmRss > 0);
  assert.equal(result.work.acceptedIterations, 1);
  assert.equal(result.work.normalEquationBuilds, 1);
  assert.equal(result.work.eigenDecompositions, 1);
  assert.equal(result.work.pseudoInverseSolves, 1);
  assert.equal(result.work.objectiveEvaluations, 3);
  assert.equal(result.work.backtracks, 1);
  assert.equal(result.work.maskChanges, 1);
  assert.equal(result.work.sampleWork.gram, 39);
  assert.equal(result.work.sampleWork.total, 141);
  assert.ok(result.diagnostics !== null);
  assert.equal(result.diagnostics.effectiveRank, 2);
});

test('K=2 backtrack and mask change have absolute complete work counts', () => {
  const result = solveJointKQuadrature(workFixture(2));
  assert.equal(result.stopReason, 'iteration-limit');
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0]?.backtracks, 1);
  assert.equal(result.history[0]?.maskChanges, 1);
  assert.equal(result.history[1]?.backtracks, 0);
  assert.equal(result.work.objectiveEvaluations, 4);
  assert.equal(result.work.backtracks, 1);
  assert.equal(result.work.maskChanges, 1);
  assert.equal(result.work.normalEquationBuilds, 2);
  assert.deepEqual(result.work.sampleWork, {
    validation: 27,
    basis: 0,
    mixing: 48,
    quantize: 12,
    metric: 12,
    gram: 93,
    mask: 18,
    offset: 12,
    total: 222,
  });
  const sample = result.work.sampleWork;
  assert.equal(
    sample.total,
    sample.validation +
      sample.basis +
      sample.mixing +
      sample.quantize +
      sample.metric +
      sample.gram +
      sample.mask +
      sample.offset,
  );
  assert.deepEqual(result.work.denseWork, {
    gramCellUpdates: 40,
    jacobiMatrixEntries: 88,
    jacobiOffDiagonalScans: 66,
    jacobiRotations: 35,
    jacobiRotationElementUpdates: 700,
    pseudoInverseEntries: 48,
  });
});

test('Jacobi sweep limit returns eigen-limit without a pseudo-inverse', () => {
  const result = solveJointKQuadrature(workFixture(1, 1));
  assert.equal(result.stopReason, 'eigen-limit');
  assert.ok(result.diagnostics !== null);
  assert.equal(result.diagnostics.jacobiConverged, false);
  assert.equal(result.diagnostics.jacobiSweeps, 1);
  assert.equal(result.work.eigenDecompositions, 1);
  assert.equal(result.work.pseudoInverseSolves, 0);
  assert.equal(result.work.objectiveEvaluations, 1);
  assert.equal(result.history.length, 0);
  assert.ok(result.work.denseWork.jacobiRotations > 0);
});

test('work counters and repeated output are deterministic and monotone', () => {
  const { input } = exactInput(5);
  const first = solveJointKQuadrature(input);
  const second = solveJointKQuadrature(input);
  assert.deepEqual(first, second);
  assert.equal(first.work.objectiveEvaluations, 2);
  assert.equal(first.work.acceptedIterations, 1);
  assert.equal(first.work.pseudoInverseSolves, 1);
  assert.equal(first.work.normalEquationBuilds, 1);
  assert.equal(first.work.eigenDecompositions, 1);
  assert.equal(first.work.backtracks, 0);
  assert.equal(first.work.maskRecomputations, 2);
  assert.equal(
    first.work.objectiveSampleEvaluations,
    first.work.objectiveEvaluations * 10,
  );
  let previous = first.initialQuantizedPcmRss;
  for (const iteration of first.history) {
    assert.equal(iteration.rssBefore, previous);
    assert.ok(iteration.rssAfter < iteration.rssBefore);
    previous = iteration.rssAfter;
  }
  assert.equal(previous, first.quantizedPcmRss);
});

test('odd columns and excessive K are rejected before numerical work', () => {
  assert.throws(
    () =>
      solveJointKQuadrature({
        basis: [Float64Array.from([1])],
        target: [0.1],
        initialCoefficients: [0.01],
      }),
    /Invalid joint-K dimensions/,
  );
  const basis = Array.from({ length: 102 }, () =>
    Float64Array.from([1]),
  );
  assert.throws(
    () =>
      solveJointKQuadrature({
        basis,
        target: [0.1],
        initialCoefficients: new Array<number>(102).fill(0.01),
      }),
    /Invalid joint-K dimensions/,
  );
});
