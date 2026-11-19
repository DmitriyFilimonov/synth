import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { envelopeCreator, MIN } from '../envelope';
import {
  ampEnvConfigNormales,
  oscConfigNormales,
  type ArgCreateSynth,
} from '../synth';
import {
  addTransientClick,
  boostOscillator,
  extendTail,
  removeOscillator,
  retuneOscillator,
  setEndLevel,
  type TransformAudit,
  type TransformResult,
} from './transforms';

/**
 * Собирает минимальный патч: два включённых осциллятора (тело и
 * слабая гармоника) и два свободных слота.
 */
const createTestPatch = (): ArgCreateSynth => ({
  oscillators: [
    {
      osc: {
        on: true,
        freqBase: 50,
        freqStart: 150,
        duration: 0.3,
        slope: 1,
        phase: 0.25,
      },
      ampEnv: {
        startLevel: 0.5,
        endLevel: 0.01,
        duration: 0.25,
        slope: 0.8,
      },
    },
    {
      osc: {
        on: true,
        freqBase: 100,
        freqStart: 100,
        duration: 0.2,
        slope: 1,
        phase: 0,
      },
      ampEnv: {
        startLevel: 0.25,
        endLevel: 0.001,
        duration: 0.1,
        slope: 1.5,
      },
    },
    {
      osc: {
        on: false,
        freqBase: 440,
        freqStart: 440,
        duration: 0.5,
        slope: 1,
        phase: 0,
      },
      ampEnv: {
        startLevel: 0.5,
        endLevel: 0.001,
        duration: 0.5,
        slope: 1,
      },
    },
    {
      osc: {
        on: false,
        freqBase: 660,
        freqStart: 660,
        duration: 0.5,
        slope: 1,
        phase: 0,
      },
      ampEnv: {
        startLevel: 0.5,
        endLevel: 0.001,
        duration: 0.5,
        slope: 1,
      },
    },
  ],
});

/** Проверяет, что правка применилась, и возвращает запись журнала. */
const assertApplied = (
  result: TransformResult,
  patch: ArgCreateSynth,
): TransformAudit => {
  assert.notEqual(
    result.patch,
    patch,
    'правка должна вернуть новый патч',
  );
  const audit = result.audit;
  assert.ok(audit, 'правка должна записаться в журнал');
  return audit;
};

/** Проверяет отказ: журнал пуст, патч вернулся тем же объектом. */
const assertSkipped = (
  result: TransformResult,
  patch: ArgCreateSynth,
  reasonPattern: RegExp,
): void => {
  assert.equal(result.audit, null);
  assert.equal(
    result.patch,
    patch,
    'при отказе патч должен вернуться нетронутым',
  );
  assert.match(result.skipReason ?? '', reasonPattern);
};

/** Проверяет, что все параметры патча лежат в допустимых диапазонах. */
const assertPatchWithinNormales = (patch: ArgCreateSynth): void => {
  patch.oscillators.forEach(({ osc, ampEnv }, index) => {
    const checks: [number, { min: number; max: number }, string][] = [
      [osc.freqBase, oscConfigNormales.freqBase, 'osc.freqBase'],
      [osc.freqStart, oscConfigNormales.freqStart, 'osc.freqStart'],
      [osc.duration, oscConfigNormales.duration, 'osc.duration'],
      [osc.slope, oscConfigNormales.slope, 'osc.slope'],
      [osc.phase, oscConfigNormales.phase, 'osc.phase'],
      [
        ampEnv.duration,
        ampEnvConfigNormales.duration,
        'ampEnv.duration',
      ],
      [ampEnv.slope, ampEnvConfigNormales.slope, 'ampEnv.slope'],
      [
        ampEnv.startLevel,
        ampEnvConfigNormales.startLevel,
        'ampEnv.startLevel',
      ],
    ];
    checks.forEach(([value, range, label]) => {
      assert.ok(
        value >= range.min && value <= range.max,
        `osc[${index}].${label} = ${value} вне ` +
          `${range.min}..${range.max}`,
      );
    });
    if (ampEnv.endLevel !== undefined) {
      assert.ok(
        ampEnv.endLevel >= ampEnvConfigNormales.endLevel.min &&
          ampEnv.endLevel <= ampEnvConfigNormales.endLevel.max,
        `osc[${index}].ampEnv.endLevel вне диапазона`,
      );
    }
  });
};

void test('extendTail lengthens the envelope and audits the change', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = extendTail(patch, 0, 1.5);
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  assert.equal(result.patch.oscillators[0]?.ampEnv.duration, 0.375);
  assert.equal(result.patch.oscillators[1]?.ampEnv.duration, 0.1);
  assert.equal(audit.name, 'extendTail');
  assert.equal(audit.oscillatorIndex, 0);
  assert.match(audit.detail, /продлил/);
  assert.match(audit.detail, /0\.375/);
});

void test('extendTail clamps the duration to the allowed maximum', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = extendTail(patch, 0, 4);
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  assert.equal(
    result.patch.oscillators[0]?.ampEnv.duration,
    ampEnvConfigNormales.duration.max,
  );
  assert.match(audit.detail, /обрезал/);
  assertPatchWithinNormales(result.patch);
});

void test('extendTail skips inactive oscillators and bad factors', () => {
  const patch = createTestPatch();

  assertSkipped(extendTail(patch, 2, 2), patch, /выключен/);
  assertSkipped(extendTail(patch, 99, 2), patch, /нет осциллятора/);
  assertSkipped(extendTail(patch, 0, 1), patch, /не продлевает/);
  assertSkipped(extendTail(patch, 0, 0.5), patch, /не продлевает/);
  assertSkipped(
    extendTail(patch, 0, Number.NaN),
    patch,
    /не продлевает/,
  );

  const maxed = createTestPatch();
  const first = maxed.oscillators[0];
  assert.ok(first);
  first.ampEnv.duration = ampEnvConfigNormales.duration.max;
  assertSkipped(extendTail(maxed, 0, 2), maxed, /не пускает/);
});

void test('boostOscillator raises the start level', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = boostOscillator(patch, 1, 2);
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  assert.equal(result.patch.oscillators[1]?.ampEnv.startLevel, 0.5);
  assert.equal(result.patch.oscillators[0]?.ampEnv.startLevel, 0.5);
  assert.equal(audit.name, 'boostOscillator');
  assert.equal(audit.oscillatorIndex, 1);
  assert.match(audit.detail, /усилил/);
});

void test('boostOscillator clamps the level and reports the clamp', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = boostOscillator(patch, 0, 4);
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  assert.equal(
    result.patch.oscillators[0]?.ampEnv.startLevel,
    ampEnvConfigNormales.startLevel.max,
  );
  assert.match(audit.detail, /обрезал/);
  assertPatchWithinNormales(result.patch);
});

void test('boostOscillator skips when there is nothing to boost', () => {
  const patch = createTestPatch();
  const first = patch.oscillators[0];
  assert.ok(first);
  first.ampEnv.startLevel = ampEnvConfigNormales.startLevel.max;

  assertSkipped(boostOscillator(patch, 0, 2), patch, /некуда/);
  assertSkipped(boostOscillator(patch, 0, 1), patch, /не усиливает/);
  assertSkipped(boostOscillator(patch, 2, 2), patch, /выключен/);
  assertSkipped(boostOscillator(patch, 0.5, 2), patch, /не целый/);
});

void test('setEndLevel sets the relative final level', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = setEndLevel(patch, 0, 0.001);
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  const group = result.patch.oscillators[0];
  assert.ok(group);
  assert.equal(group.ampEnv.endLevel, 0.001);
  assert.equal(audit.name, 'setEndLevel');
  assert.match(audit.detail, /конечный уровень/);
  assert.match(audit.detail, /было: 0\.0100/);

  const envelope = envelopeCreator({
    max: group.ampEnv.startLevel,
    min: group.ampEnv.endLevel,
    duration: group.ampEnv.duration,
    slope: group.ampEnv.slope,
  });
  const finalLevel = envelope({ x: group.ampEnv.duration });
  assert.ok(
    Math.abs(finalLevel - group.ampEnv.startLevel * 0.001) < 1e-9,
    'конечный уровень огибающей равен startLevel × endLevel',
  );
});

void test('setEndLevel clamps the value into the allowed range', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const low = setEndLevel(patch, 0, 0);
  assert.equal(low.patch.oscillators[0]?.ampEnv.endLevel, MIN);
  assert.match(low.audit?.detail ?? '', /обрезал/);

  const high = setEndLevel(patch, 0, 10);
  assert.equal(
    high.patch.oscillators[0]?.ampEnv.endLevel,
    ampEnvConfigNormales.endLevel.max,
  );

  assert.deepEqual(patch, snapshot);
  assertPatchWithinNormales(low.patch);
  assertPatchWithinNormales(high.patch);
});

void test('setEndLevel skips no-op writes and bad input', () => {
  const patch = createTestPatch();

  assertSkipped(setEndLevel(patch, 0, 0.01), patch, /уже/);
  assertSkipped(
    setEndLevel(patch, 0, Number.NaN),
    patch,
    /не конечен/,
  );
  assertSkipped(setEndLevel(patch, 2, 0.001), patch, /выключен/);
});

void test('addTransientClick fills the first free slot', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = addTransientClick(patch, {
    freqHz: 8000,
    level: 0.3,
  });
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  assert.equal(audit.name, 'addTransientClick');
  assert.equal(audit.oscillatorIndex, 2);
  assert.match(audit.detail, /щелчок/);
  assert.match(audit.detail, /8000/);

  const group = result.patch.oscillators[2];
  assert.ok(group);
  assert.equal(group.osc.on, true);
  assert.equal(group.osc.freqBase, 8000);
  assert.equal(group.osc.freqStart, 8000);
  assert.equal(group.osc.phase, 0);
  assert.equal(group.ampEnv.duration, 0.04);
  assert.equal(group.ampEnv.slope, 2);
  assert.equal(group.ampEnv.startLevel, 0.3);
  assert.equal(group.ampEnv.endLevel, MIN);

  assert.equal(result.patch.oscillators[3]?.osc.on, false);
  assertPatchWithinNormales(result.patch);
});

void test('addTransientClick clamps frequency and level', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = addTransientClick(patch, {
    freqHz: 40000,
    level: 5,
  });
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  const group = result.patch.oscillators[2];
  assert.ok(group);
  assert.equal(group.osc.freqBase, oscConfigNormales.freqBase.max);
  assert.equal(
    group.ampEnv.startLevel,
    ampEnvConfigNormales.startLevel.max,
  );
  assert.match(audit.detail, /обрезал/);
  assertPatchWithinNormales(result.patch);
});

void test('addTransientClick refuses when no slot is free', () => {
  const patch = createTestPatch();
  patch.oscillators.forEach((group) => {
    group.osc.on = true;
  });
  const snapshot = structuredClone(patch);

  const result = addTransientClick(patch, {
    freqHz: 8000,
    level: 0.3,
  });

  assertSkipped(result, patch, /нет свободного слота/);
  assert.deepEqual(patch, snapshot);
});

void test('removeOscillator turns the oscillator off but keeps params', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = removeOscillator(
    patch,
    0,
    'гудение от чужого микса',
  );
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  const group = result.patch.oscillators[0];
  assert.ok(group);
  assert.equal(group.osc.on, false);
  assert.equal(group.osc.freqBase, 50);
  assert.equal(group.osc.freqStart, 150);
  assert.equal(group.ampEnv.startLevel, 0.5);
  assert.equal(audit.name, 'removeOscillator');
  assert.equal(audit.oscillatorIndex, 0);
  assert.match(audit.detail, /гудение от чужого микса/);
  assert.match(audit.detail, /сохранил/);
});

void test('removeOscillator skips an already inactive oscillator', () => {
  const patch = createTestPatch();

  assertSkipped(
    removeOscillator(patch, 2, 'тихий'),
    patch,
    /выключен/,
  );
  assertSkipped(
    removeOscillator(patch, 7, 'нет'),
    patch,
    /нет осциллятора/,
  );
});

void test('retuneOscillator keeps the start frequency ratio', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = retuneOscillator(patch, 0, 100);
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  const group = result.patch.oscillators[0];
  assert.ok(group);
  assert.equal(group.osc.freqBase, 100);
  assert.equal(group.osc.freqStart, 300);
  assert.equal(audit.name, 'retuneOscillator');
  assert.match(audit.detail, /перестроил/);
  assert.match(audit.detail, /отношение 3\.000/);
});

void test('retuneOscillator without keepRatio keeps the start', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = retuneOscillator(patch, 0, 100, false);
  assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  const group = result.patch.oscillators[0];
  assert.ok(group);
  assert.equal(group.osc.freqBase, 100);
  assert.equal(group.osc.freqStart, 150);
});

void test('retuneOscillator clamps both frequencies to the ranges', () => {
  const patch = createTestPatch();
  const snapshot = structuredClone(patch);

  const result = retuneOscillator(patch, 0, 25000);
  const audit = assertApplied(result, patch);

  assert.deepEqual(patch, snapshot);
  const group = result.patch.oscillators[0];
  assert.ok(group);
  assert.equal(group.osc.freqBase, oscConfigNormales.freqBase.max);
  assert.equal(group.osc.freqStart, oscConfigNormales.freqStart.max);
  assert.match(audit.detail, /обрезал/);
  assertPatchWithinNormales(result.patch);

  const low = retuneOscillator(patch, 0, 5);
  assert.equal(
    low.patch.oscillators[0]?.osc.freqBase,
    oscConfigNormales.freqBase.min,
  );
  assertPatchWithinNormales(low.patch);
});

void test('retuneOscillator skips no-op retunes and bad input', () => {
  const patch = createTestPatch();

  assertSkipped(retuneOscillator(patch, 0, 50), patch, /уже/);
  assertSkipped(
    retuneOscillator(patch, 0, Number.NaN),
    patch,
    /не конечна/,
  );
  assertSkipped(retuneOscillator(patch, 2, 100), patch, /выключен/);
});
