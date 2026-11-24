import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAMPLE_RATE } from '../consts';
import { MIN } from '../envelope';
import {
  createOscillatorGroup,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import {
  buildFullPatchJacobian,
  FULL_PATCH_OUTER_BOUNDS,
  FULL_PATCH_OUTER_FIELDS,
  type FullPatchColumnDiagnostic,
  type FullPatchJacobianResult,
  type FullPatchOuterField,
  type FullPatchQuadratureCoefficients,
} from './full-patch-jacobian';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

/** Возвращает обычный активный тон с полями, удобными для known-answer. */
function tone(): OscillatorGroup {
  return {
    osc: {
      on: true,
      freqBase: 95,
      freqStart: 170,
      duration: 0.02,
      slope: 1.3,
      phase: 0.37,
    },
    ampEnv: {
      startLevel: 0.42,
      endLevel: 0.07,
      duration: 0.018,
      slope: 1.2,
    },
  };
}

/** Переводит startLevel/phase в линейные коэффициенты VP. */
function coefficientsFor(
  patch: ArgCreateSynth,
): FullPatchQuadratureCoefficients[] {
  return patch.oscillators.flatMap((group, oscillatorIndex) =>
    group.osc.on
      ? [
          {
            oscillatorIndex,
            sineCoefficient:
              group.ampEnv.startLevel * Math.cos(group.osc.phase),
            cosineCoefficient:
              group.ampEnv.startLevel * Math.sin(group.osc.phase),
          },
        ]
      : [],
  );
}

/** Строит Jacobian без дорогой rank-диагностики в численных пробах. */
function build(
  patch: ArgCreateSynth,
  coefficients: readonly FullPatchQuadratureCoefficients[],
  sampleCount: number,
  phaseModel: PhaseModel,
): FullPatchJacobianResult {
  return buildFullPatchJacobian({
    patch,
    coefficients,
    sampleCount,
    phaseModel,
    rankDiagnostics: false,
  });
}

/** Проверяет абсолютный и относительный допуск без потери контекста. */
function close(
  actual: number,
  expected: number,
  absolute = 1e-12,
  relative = 1e-10,
): void {
  const tolerance = absolute + relative * Math.abs(expected);
  assert.ok(
    Number.isFinite(actual) &&
      Number.isFinite(expected) &&
      Math.abs(actual - expected) <= tolerance,
    `actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
  );
}

/** Сверяет вклад с фактическим renderer одной группы. */
function assertCanonicalParity(
  group: OscillatorGroup,
  contribution: Float64Array,
  phaseModel: PhaseModel,
): void {
  const canonical = createOscillatorGroup(group, { phaseModel });
  for (let index = 0; index < contribution.length; index += 1) {
    const expected = canonical({ x: index / SAMPLE_RATE });
    close(contribution[index] ?? 0, expected, 5e-14, 5e-13);
  }
}

/** Вычисляет независимый canonical отсчёт для численной производной. */
function canonicalAt(
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  sampleIndex: number,
  phaseModel: PhaseModel,
): number {
  const group = patch.oscillators[oscillatorIndex];
  assert.ok(group !== undefined);
  return createOscillatorGroup(group, { phaseModel })({
    x: sampleIndex / SAMPLE_RATE,
  });
}

/** Возвращает номер столбца по публичному порядку полей. */
function fieldColumn(field: FullPatchOuterField): number {
  const index = FULL_PATCH_OUTER_FIELDS.indexOf(field);
  assert.ok(index >= 0);
  return index;
}

/** Меняет одну log-координату в независимой копии patch. */
function shiftedPatch(
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  field: FullPatchOuterField,
  logShift: number,
): ArgCreateSynth {
  const shifted = structuredClone(patch);
  const group = shifted.oscillators[oscillatorIndex];
  assert.ok(group !== undefined);
  const scale = Math.exp(logShift);
  if (field === 'freqBase') {
    group.osc.freqBase *= scale;
  } else if (field === 'freqStart') {
    group.osc.freqStart *= scale;
  } else if (field === 'osc.slope') {
    group.osc.slope *= scale;
  } else if (field === 'osc.duration') {
    group.osc.duration *= scale;
  } else if (field === 'ampEnv.duration') {
    group.ampEnv.duration *= scale;
  } else if (field === 'ampEnv.endLevel') {
    group.ampEnv.endLevel = (group.ampEnv.endLevel ?? MIN) * scale;
  } else {
    group.ampEnv.slope *= scale;
  }
  return shifted;
}

/** Проверяет нулевое значение и все семь производных в одном отсчёте. */
function assertZeroSample(
  row: {
    contribution: Float64Array;
    jacobian: Float64Array[];
  },
  index: number,
): void {
  assert.equal(row.contribution[index], 0);
  for (const column of row.jacobian) {
    assert.equal(column[index], 0);
  }
}

test('constant tone has canonical value and phase derivative in both models', () => {
  const group = tone();
  group.osc.freqBase = 73;
  group.osc.freqStart = 73;
  group.osc.duration = 0.004;
  group.ampEnv.endLevel = 1;
  const patch: ArgCreateSynth = { oscillators: [group] };
  const coefficients = coefficientsFor(patch);
  const coefficient = coefficients[0];
  assert.ok(coefficient !== undefined);
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const result = build(patch, coefficients, 64, phaseModel);
    const row = result.oscillators[0];
    assert.ok(row !== undefined);
    assertCanonicalParity(group, row.contribution, phaseModel);
    const base = fieldColumn('freqBase');
    const start = fieldColumn('freqStart');
    for (const index of [0, 1, 7, 31, 63]) {
      const x = index / SAMPLE_RATE;
      const angle = x * 73 * TWO_PI;
      const quadrature =
        coefficient.sineCoefficient * Math.sin(angle) +
        coefficient.cosineCoefficient * Math.sin(angle + HALF_PI);
      close(row.contribution[index] ?? 0, quadrature, 2e-14, 2e-13);
      const phaseDerivative =
        coefficient.sineCoefficient * Math.cos(angle) +
        coefficient.cosineCoefficient * Math.cos(angle + HALF_PI);
      const expectedSum = TWO_PI * x * 73 * phaseDerivative;
      const actualSum =
        (row.jacobian[base]?.[index] ?? 0) +
        (row.jacobian[start]?.[index] ?? 0);
      close(actualSum, expectedSum, 2e-9, 2e-10);
    }
  }
});

test('central differences match all seven log axes in smooth regions', () => {
  const group = tone();
  group.osc.delay = 13.37 / SAMPLE_RATE;
  group.ampEnv.attack = 31.19 / SAMPLE_RATE;
  const patch: ArgCreateSynth = { oscillators: [group] };
  const coefficients = coefficientsFor(patch);
  const sampleCount = 160;
  const smoothStart = Math.ceil(
    SAMPLE_RATE *
      ((group.osc.delay ?? 0) + (group.ampEnv.attack ?? 0) + 0.0005),
  );
  const step = 1e-5;
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const baseline = build(
      patch,
      coefficients,
      sampleCount,
      phaseModel,
    );
    const row = baseline.oscillators[0];
    assert.ok(row !== undefined);
    for (
      let fieldIndex = 0;
      fieldIndex < FULL_PATCH_OUTER_FIELDS.length;
      fieldIndex += 1
    ) {
      const field = FULL_PATCH_OUTER_FIELDS[fieldIndex];
      assert.ok(field !== undefined);
      const plus = shiftedPatch(patch, 0, field, step);
      const minus = shiftedPatch(patch, 0, field, -step);
      for (
        let index = smoothStart;
        index < sampleCount;
        index += 13
      ) {
        const numerical =
          (canonicalAt(plus, 0, index, phaseModel) -
            canonicalAt(minus, 0, index, phaseModel)) /
          (2 * step);
        close(
          row.jacobian[fieldIndex]?.[index] ?? 0,
          numerical,
          2e-7,
          2e-7,
        );
      }
    }
  }
});

test('clamps preserve endLevel and MIN frequency tails with one-sided kinks', () => {
  const group = tone();
  group.osc.freqBase = 110;
  group.osc.freqStart = 190;
  group.osc.duration = 20 / SAMPLE_RATE;
  group.osc.slope = 1.4;
  group.ampEnv.startLevel = 0.3;
  group.ampEnv.endLevel = 0.08;
  group.ampEnv.duration = 40 / SAMPLE_RATE;
  group.ampEnv.slope = 1.2;
  const patch: ArgCreateSynth = { oscillators: [group] };
  const coefficients = coefficientsFor(patch);
  const coefficient = coefficients[0];
  assert.ok(coefficient !== undefined);
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const result = build(patch, coefficients, 80, phaseModel);
    const row = result.oscillators[0];
    assert.ok(row !== undefined);
    assertCanonicalParity(group, row.contribution, phaseModel);
    const ampDuration = fieldColumn('ampEnv.duration');
    const ampSlope = fieldColumn('ampEnv.slope');
    const ampEnd = fieldColumn('ampEnv.endLevel');
    assert.notEqual(row.jacobian[ampDuration]?.[20], 0);
    assert.notEqual(row.jacobian[ampSlope]?.[20], 0);
    for (const index of [41, 60, 79]) {
      assert.equal(row.jacobian[ampDuration]?.[index], 0);
      assert.equal(row.jacobian[ampSlope]?.[index], 0);
      close(
        row.jacobian[ampEnd]?.[index] ?? 0,
        row.contribution[index] ?? 0,
        2e-14,
        2e-13,
      );
    }

    const boundary = 40;
    assert.equal(row.jacobian[ampDuration]?.[boundary], 0);
    const shorter = shiftedPatch(patch, 0, 'ampEnv.duration', -1e-6);
    close(
      canonicalAt(shorter, 0, boundary, phaseModel),
      row.contribution[boundary] ?? 0,
      5e-14,
      5e-13,
    );

    const tailIndex = 60;
    const x = tailIndex / SAMPLE_RATE;
    const tailFrequency = 110 + MIN * (190 - 110);
    const angle = x * tailFrequency * TWO_PI;
    const amplitude = 0.3 * 0.08;
    const phaseDerivative =
      amplitude *
      ((coefficient.sineCoefficient / 0.3) * Math.cos(angle) +
        (coefficient.cosineCoefficient / 0.3) *
          Math.cos(angle + HALF_PI));
    if (phaseModel === 'legacy') {
      close(
        row.jacobian[fieldColumn('freqBase')]?.[tailIndex] ?? 0,
        TWO_PI * x * 110 * (1 - MIN) * phaseDerivative,
        2e-11,
        2e-10,
      );
      close(
        row.jacobian[fieldColumn('freqStart')]?.[tailIndex] ?? 0,
        TWO_PI * x * 190 * MIN * phaseDerivative,
        2e-11,
        2e-10,
      );
      assert.equal(
        row.jacobian[fieldColumn('osc.duration')]?.[tailIndex],
        0,
      );
      assert.equal(
        row.jacobian[fieldColumn('osc.slope')]?.[tailIndex],
        0,
      );
    }

    const tailStep = 1e-6;
    for (const field of FULL_PATCH_OUTER_FIELDS) {
      const plus = shiftedPatch(patch, 0, field, tailStep);
      const minus = shiftedPatch(patch, 0, field, -tailStep);
      const numerical =
        (canonicalAt(plus, 0, tailIndex, phaseModel) -
          canonicalAt(minus, 0, tailIndex, phaseModel)) /
        (2 * tailStep);
      close(
        row.jacobian[fieldColumn(field)]?.[tailIndex] ?? 0,
        numerical,
        5e-7,
        5e-7,
      );
    }

    const frequencyBoundary = 20;
    const shorterFrequency = shiftedPatch(
      patch,
      0,
      'osc.duration',
      -tailStep,
    );
    const oneSided =
      (canonicalAt(patch, 0, frequencyBoundary, phaseModel) -
        canonicalAt(
          shorterFrequency,
          0,
          frequencyBoundary,
          phaseModel,
        )) /
      tailStep;
    close(
      row.jacobian[fieldColumn('osc.duration')]?.[
        frequencyBoundary
      ] ?? 0,
      oneSided,
      3e-6,
      3e-6,
    );
  }
});

test('delay, attack and hard support mask values and derivatives exactly', () => {
  const group = tone();
  group.osc.freqBase = 500;
  group.osc.freqStart = 900;
  group.osc.duration = 7 / SAMPLE_RATE;
  group.osc.delay = 17 / SAMPLE_RATE;
  group.ampEnv.attack = 5 / SAMPLE_RATE;
  group.ampEnv.duration = 11 / SAMPLE_RATE;
  group.ampEnv.hardStop = true;
  const patch: ArgCreateSynth = { oscillators: [group] };
  const coefficients = coefficientsFor(patch);
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const result = build(patch, coefficients, 45, phaseModel);
    const row = result.oscillators[0];
    assert.ok(row !== undefined);
    assertCanonicalParity(group, row.contribution, phaseModel);
    for (let index = 0; index < 17; index += 1) {
      assertZeroSample(row, index);
    }
    for (const field of [
      'ampEnv.duration',
      'ampEnv.endLevel',
      'ampEnv.slope',
    ] as FullPatchOuterField[]) {
      assert.equal(row.jacobian[fieldColumn(field)]?.[19], 0);
    }
    for (const field of [
      'ampEnv.duration',
      'ampEnv.endLevel',
      'ampEnv.slope',
    ] as FullPatchOuterField[]) {
      const column: Float64Array | undefined =
        row.jacobian[fieldColumn(field)];
      assert.ok(column !== undefined);
      assert.ok(
        [23, 24, 25, 26].some((index) => (column[index] ?? 0) !== 0),
        `${field} must leave attack after its end`,
      );
    }
    for (let index = 33; index < 45; index += 1) {
      assertZeroSample(row, index);
    }
    assert.equal(row.supportSampleCount, 16);
    assert.equal(row.zeroSupport, false);
  }
});

test('exact mixed patch matches canonical groups and never mutates input', () => {
  const constant = tone();
  constant.osc.freqBase = 73;
  constant.osc.freqStart = 73;
  const swept = tone();
  swept.osc.freqBase = 55;
  swept.osc.freqStart = 230;
  swept.osc.slope = 0.8;
  const delayed = tone();
  delayed.osc.freqBase = 1300;
  delayed.osc.freqStart = 800;
  delayed.osc.delay = 9.37 / SAMPLE_RATE;
  delayed.ampEnv.attack = 4 / SAMPLE_RATE;
  delayed.ampEnv.duration = 20 / SAMPLE_RATE;
  delayed.ampEnv.hardStop = true;
  const off = tone();
  off.osc.on = false;
  off.osc.delay = 0.01;
  const patch: ArgCreateSynth = {
    oscillators: [constant, swept, delayed, off],
  };
  const coefficients = coefficientsFor(patch);
  const patchSnapshot = structuredClone(patch);
  const coefficientSnapshot = structuredClone(coefficients);
  const result = build(patch, coefficients, 96, 'integral');
  assert.equal(result.oscillators.length, 3);
  assert.deepEqual(
    result.oscillators.map((row) => row.oscillatorIndex),
    [0, 1, 2],
  );
  for (const row of result.oscillators) {
    const group = patch.oscillators[row.oscillatorIndex];
    assert.ok(group !== undefined);
    assertCanonicalParity(group, row.contribution, 'integral');
    assert.ok(row.contribution.every(Number.isFinite));
    assert.ok(
      row.jacobian.every((column) => column.every(Number.isFinite)),
    );
  }
  assert.deepEqual(patch, patchSnapshot);
  assert.deepEqual(coefficients, coefficientSnapshot);
});

test('rank diagnostics mark duplicates, zero support and near collinearity', () => {
  const original = tone();
  original.osc.freqBase = 87;
  original.osc.freqStart = 143;
  original.osc.duration = 0.013;
  original.ampEnv.duration = 0.017;
  const duplicate = structuredClone(original);
  const unsupported = structuredClone(original);
  unsupported.osc.delay = 0.01;
  const nearby = structuredClone(original);
  nearby.osc.freqBase *= 1 + 1e-6;
  nearby.osc.freqStart *= 1 + 1e-6;
  const patch: ArgCreateSynth = {
    oscillators: [original, duplicate, unsupported, nearby],
  };
  const result = buildFullPatchJacobian({
    patch,
    coefficients: coefficientsFor(patch),
    sampleCount: 64,
    phaseModel: 'integral',
  });
  const diagnostics = result.diagnostics;
  assert.ok(diagnostics !== null);
  assert.equal(diagnostics.columnCount, 28);
  assert.ok(diagnostics.rank < diagnostics.columnCount);
  const duplicateBase = diagnostics.columns[7];
  assert.ok(duplicateBase !== undefined);
  assert.equal(duplicateBase.field, 'freqBase');
  assert.equal(duplicateBase.dependent, true);
  assert.equal(duplicateBase.duplicateOf, 0);
  const unsupportedRow = result.oscillators[2];
  assert.ok(unsupportedRow !== undefined);
  assert.equal(unsupportedRow.zeroSupport, true);
  assert.equal(unsupportedRow.supportSampleCount, 0);
  for (let column = 14; column < 21; column += 1) {
    const diagnostic: FullPatchColumnDiagnostic | undefined =
      diagnostics.columns[column];
    assert.ok(diagnostic !== undefined);
    assert.equal(diagnostic.zero, true);
    assert.equal(diagnostic.dependent, true);
    assert.ok(diagnostics.zeroColumns.includes(column));
  }
  const nearbyBase = diagnostics.columns[21];
  assert.ok(nearbyBase !== undefined);
  assert.equal(nearbyBase.field, 'freqBase');
  assert.equal(nearbyBase.dependent, true);
  assert.equal(
    nearbyBase.duplicateOf,
    null,
    JSON.stringify(nearbyBase),
  );
  assert.ok(
    nearbyBase.residualRatio > diagnostics.duplicateTolerance,
  );
  assert.ok(nearbyBase.residualRatio <= diagnostics.rankTolerance);
  for (const diagnostic of diagnostics.columns) {
    assert.ok(Number.isFinite(diagnostic.norm));
    assert.ok(Number.isFinite(diagnostic.residualRatio));
  }
});

test('finite guards and explicit log bounds reject ambiguous solver input', () => {
  const patch: ArgCreateSynth = { oscillators: [tone()] };
  const coefficients = coefficientsFor(patch);
  assert.equal(FULL_PATCH_OUTER_BOUNDS.length, 7);
  for (const bound of FULL_PATCH_OUTER_BOUNDS) {
    close(
      Math.exp(bound.logMinimum),
      bound.nativeMinimum,
      1e-14,
      1e-14,
    );
    close(
      Math.exp(bound.logMaximum),
      bound.nativeMaximum,
      1e-14,
      1e-14,
    );
  }
  assert.throws(
    () =>
      buildFullPatchJacobian({
        patch,
        coefficients: [],
        sampleCount: 8,
      }),
    /Every active oscillator/,
  );
  const invalid = structuredClone(coefficients);
  const first = invalid[0];
  assert.ok(first !== undefined);
  first.sineCoefficient = Number.NaN;
  assert.throws(
    () =>
      buildFullPatchJacobian({
        patch,
        coefficients: invalid,
        sampleCount: 8,
      }),
    /must be finite/,
  );
  const empty = buildFullPatchJacobian({
    patch,
    coefficients,
    sampleCount: 0,
  });
  assert.equal(empty.oscillators[0]?.zeroSupport, true);
  assert.equal(empty.diagnostics?.rank, 0);
  assert.equal(empty.diagnostics?.zeroColumns.length, 7);
});
