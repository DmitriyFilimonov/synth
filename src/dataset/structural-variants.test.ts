import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ArgCreateSynth } from '../synth';
import { renderSamples } from './shared';
import {
  makeStructuralVariant,
  verifyStructuralVariant,
  type InvariantViolation,
  type OscField,
  type ScalarValue,
  type StructuralAssignment,
  type StructuralVariantManifest,
  type StructuralVariantResult,
  type StructuralVariantSpec,
} from './structural-variants';

const ALL_FIELDS: readonly OscField[] = [
  'osc.on',
  'osc.freqBase',
  'osc.freqStart',
  'osc.duration',
  'osc.slope',
  'osc.phase',
  'osc.delay',
  'ampEnv.startLevel',
  'ampEnv.endLevel',
  'ampEnv.duration',
  'ampEnv.slope',
  'ampEnv.attack',
  'ampEnv.hardStop',
];

/**
 * Создаёт патч с мембраной, двумя attack-компонентами,
 * configuration и одним off-слотом.
 *
 * @returns Патч с четырьмя активными осцилляторами
 */
function createTestPatch(): ArgCreateSynth {
  return {
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
          freqBase: 4000,
          freqStart: 6000,
          duration: 0.04,
          slope: 2,
          phase: 1.1,
        },
        ampEnv: {
          startLevel: 0.3,
          endLevel: 0.001,
          duration: 0.04,
          slope: 2,
          attack: 0.002,
          hardStop: true,
        },
      },
      {
        osc: {
          on: true,
          freqBase: 300,
          freqStart: 450,
          duration: 0.08,
          slope: 1.2,
          phase: 2.2,
        },
        ampEnv: {
          startLevel: 0.2,
          duration: 0.1,
          slope: 1.4,
        },
      },
      {
        osc: {
          on: true,
          freqBase: 80,
          freqStart: 80,
          duration: 0.4,
          slope: 0.9,
          phase: 0.5,
        },
        ampEnv: {
          startLevel: 0.4,
          endLevel: 0.02,
          duration: 0.45,
          slope: 0.7,
        },
      },
      {
        osc: {
          on: false,
          freqBase: 900,
          freqStart: 1200,
          duration: 0.2,
          slope: 1,
          phase: 1.7,
        },
        ampEnv: {
          startLevel: 0.15,
          duration: 0.2,
          slope: 1,
        },
      },
    ],
  };
}

/**
 * Создаёт намеренно не отсортированную полную разметку активных слотов.
 *
 * @returns Разметка для проверки канонизации манифеста
 */
function createAssignment(): StructuralAssignment {
  return {
    membrane: [0],
    attackLinked: [
      {
        index: 2,
        fields: ['osc.freqStart', 'osc.freqBase'],
      },
      {
        index: 1,
        fields: ['osc.freqStart', 'osc.freqBase'],
      },
    ],
    configuration: [3],
  };
}

/**
 * Создаёт базовую спецификацию варианта для механических тестов.
 *
 * @param overrides - Поля, которые заменяют значения по умолчанию
 * @returns Спецификация с применёнными `overrides`
 * @remarks По умолчанию выбран оператор body-plus-named-attack,
 *   а множитель частоты равен 1.2.
 */
function createSpec(
  overrides: Partial<StructuralVariantSpec> = {},
): StructuralVariantSpec {
  return {
    hypothesisId: 'membrane-hypothesis-a',
    source: {
      slug: 'known-answer',
      seed: 7,
      phaseModel: 'integral',
      codeRevision: null,
      patchSha256: 'fixture-sha256',
    },
    assignment: createAssignment(),
    operator: 'body-plus-named-attack',
    frequencyRatio: 1.2,
    ...overrides,
  };
}

/**
 * Возвращает осциллятор и проверяет, что индекс существует.
 *
 * @param patch - Патч с осцилляторами
 * @param index - Нулевой индекс осциллятора
 * @returns Группа параметров осциллятора
 * @throws AssertionError если осциллятор отсутствует
 */
function groupAt(
  patch: ArgCreateSynth,
  index: number,
): ArgCreateSynth['oscillators'][number] {
  const group = patch.oscillators[index];
  assert.ok(group, `нет осциллятора ${index}`);
  return group;
}

function key(oscillatorIndex: number, field: OscField): string {
  return `${oscillatorIndex}:${field}`;
}

/**
 * Ищет расхождение по координатам scalar-поля.
 *
 * @param violations - Расхождения, найденные verifier
 * @param oscillatorIndex - Индекс осциллятора или null для всего патча
 * @param field - Имя scalar-поля или oscillatorCount
 * @returns Первое подходящее расхождение либо `undefined`
 */
function findViolation(
  violations: InvariantViolation[],
  oscillatorIndex: number | null,
  field: OscField | 'oscillatorCount',
): InvariantViolation | undefined {
  return violations.find(
    (violation) =>
      violation.oscillatorIndex === oscillatorIndex &&
      violation.field === field,
  );
}

/**
 * Меняет любое scalar-поле и возвращает его новое точное значение.
 *
 * @param patch - Мутируемый тестовый кандидат
 * @param oscillatorIndex - Индекс изменяемого осциллятора
 * @param field - Изменяемое поле
 * @returns Новое значение поля после порчи
 * @throws AssertionError если осциллятор отсутствует
 */
function overwriteField(
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  field: OscField,
): ScalarValue {
  const group = groupAt(patch, oscillatorIndex);
  switch (field) {
    case 'osc.on':
      group.osc.on = !group.osc.on;
      return group.osc.on;
    case 'osc.freqBase':
      group.osc.freqBase += 0.125;
      return group.osc.freqBase;
    case 'osc.freqStart':
      group.osc.freqStart += 0.125;
      return group.osc.freqStart;
    case 'osc.duration':
      group.osc.duration += 0.125;
      return group.osc.duration;
    case 'osc.slope':
      group.osc.slope += 0.125;
      return group.osc.slope;
    case 'osc.phase':
      group.osc.phase += 0.125;
      return group.osc.phase;
    case 'osc.delay':
      group.osc.delay = 0.125;
      return group.osc.delay;
    case 'ampEnv.startLevel':
      group.ampEnv.startLevel += 0.125;
      return group.ampEnv.startLevel;
    case 'ampEnv.endLevel':
      group.ampEnv.endLevel = 0.125;
      return group.ampEnv.endLevel;
    case 'ampEnv.duration':
      group.ampEnv.duration += 0.125;
      return group.ampEnv.duration;
    case 'ampEnv.slope':
      group.ampEnv.slope += 0.125;
      return group.ampEnv.slope;
    case 'ampEnv.attack':
      group.ampEnv.attack = 0.125;
      return group.ampEnv.attack;
    case 'ampEnv.hardStop':
      group.ampEnv.hardStop = !group.ampEnv.hardStop;
      return group.ampEnv.hardStop;
  }
}

/**
 * Строит вариант, где у обеих attack-компонентов связан только freqBase.
 *
 * @param source - Исходный патч
 * @returns Вариант body-plus-named-attack с частичной связью атаки
 */
function createPartialBodyVariant(
  source: ArgCreateSynth,
): StructuralVariantResult {
  const assignment = createAssignment();
  assignment.attackLinked = [
    { index: 2, fields: ['osc.freqBase'] },
    { index: 1, fields: ['osc.freqBase'] },
  ];
  return makeStructuralVariant(source, createSpec({ assignment }));
}

void test('three operators edit only their explicitly selected frequencies', () => {
  const source = createTestPatch();
  const snapshot = structuredClone(source);

  const membrane = makeStructuralVariant(
    source,
    createSpec({ operator: 'membrane-only' }),
  );
  assert.equal(groupAt(membrane.patch, 0).osc.freqBase, 60);
  assert.equal(groupAt(membrane.patch, 0).osc.freqStart, 180);
  assert.deepEqual(membrane.manifest.selectedOscillators, [0]);
  for (const index of [1, 2, 3, 4]) {
    assert.deepEqual(
      membrane.patch.oscillators[index],
      source.oscillators[index],
    );
  }

  const body = makeStructuralVariant(source, createSpec());
  assert.equal(groupAt(body.patch, 0).osc.freqBase, 60);
  assert.equal(groupAt(body.patch, 0).osc.freqStart, 180);
  assert.equal(groupAt(body.patch, 1).osc.freqBase, 4800);
  assert.equal(groupAt(body.patch, 1).osc.freqStart, 7200);
  assert.equal(groupAt(body.patch, 2).osc.freqBase, 360);
  assert.equal(groupAt(body.patch, 2).osc.freqStart, 540);
  assert.deepEqual(body.manifest.selectedOscillators, [0, 1, 2]);
  assert.deepEqual(body.patch.oscillators[3], source.oscillators[3]);
  assert.deepEqual(body.patch.oscillators[4], source.oscillators[4]);

  const all = makeStructuralVariant(
    source,
    createSpec({ operator: 'all-components' }),
  );
  assert.deepEqual(all.manifest.selectedOscillators, [0, 1, 2, 3]);
  for (const index of [0, 1, 2, 3]) {
    const original = groupAt(source, index);
    const changed = groupAt(all.patch, index);
    assert.equal(changed.osc.freqBase, original.osc.freqBase * 1.2);
    assert.equal(changed.osc.freqStart, original.osc.freqStart * 1.2);
  }
  assert.deepEqual(all.patch.oscillators[4], source.oscillators[4]);

  assert.deepEqual(source, snapshot);
  assert.equal(membrane.audit.valid, true);
  assert.equal(body.audit.valid, true);
  assert.equal(all.audit.valid, true);
});

void test('explicit roles override frequency and duration heuristics', () => {
  const source = createTestPatch();
  const assignment: StructuralAssignment = {
    membrane: [1],
    attackLinked: [{ index: 0, fields: ['osc.freqBase'] }],
    configuration: [2, 3],
  };
  const result = makeStructuralVariant(
    source,
    createSpec({ assignment, operator: 'membrane-only' }),
  );

  assert.deepEqual(
    result.patch.oscillators[0],
    source.oscillators[0],
  );
  assert.equal(groupAt(result.patch, 1).osc.freqBase, 4800);
  assert.equal(groupAt(result.patch, 1).osc.freqStart, 7200);
  assert.deepEqual(
    result.patch.oscillators[2],
    source.oscillators[2],
  );
  assert.deepEqual(
    result.patch.oscillators[3],
    source.oscillators[3],
  );
});

void test('body-plus-named-attack can link only osc.freqBase', () => {
  const source = createTestPatch();
  const result = createPartialBodyVariant(source);

  for (const index of [1, 2]) {
    assert.equal(
      groupAt(result.patch, index).osc.freqBase,
      groupAt(source, index).osc.freqBase * 1.2,
    );
    assert.equal(
      groupAt(result.patch, index).osc.freqStart,
      groupAt(source, index).osc.freqStart,
    );
  }
  assert.equal(
    result.audit.actualEdits.filter(
      ({ field }) => field === 'osc.freqStart',
    ).length,
    1,
    'только membrane меняет freqStart',
  );
  assert.deepEqual(result.audit.actualEdits, [
    {
      oscillatorIndex: 0,
      field: 'osc.freqBase',
      from: 50,
      to: 60,
    },
    {
      oscillatorIndex: 0,
      field: 'osc.freqStart',
      from: 150,
      to: 180,
    },
    {
      oscillatorIndex: 1,
      field: 'osc.freqBase',
      from: 4000,
      to: 4800,
    },
    {
      oscillatorIndex: 2,
      field: 'osc.freqBase',
      from: 300,
      to: 360,
    },
  ]);
});

void test('manifest canonically sorts assignments, selections and edits', () => {
  const source = createTestPatch();
  const firstAssignment: StructuralAssignment = {
    membrane: [3, 0],
    attackLinked: [
      {
        index: 2,
        fields: ['osc.freqStart', 'osc.freqBase'],
      },
      {
        index: 1,
        fields: ['osc.freqStart', 'osc.freqBase'],
      },
    ],
    configuration: [],
  };
  const secondAssignment: StructuralAssignment = {
    membrane: [0, 3],
    attackLinked: [
      {
        index: 1,
        fields: ['osc.freqBase', 'osc.freqStart'],
      },
      {
        index: 2,
        fields: ['osc.freqBase', 'osc.freqStart'],
      },
    ],
    configuration: [],
  };
  const first = makeStructuralVariant(
    source,
    createSpec({ assignment: firstAssignment }),
  );
  const second = makeStructuralVariant(
    source,
    createSpec({ assignment: secondAssignment }),
  );

  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.patch, second.patch);
  assert.deepEqual(first.manifest.spec.assignment.membrane, [0, 3]);
  assert.deepEqual(
    first.manifest.spec.assignment.attackLinked.map(
      ({ index }) => index,
    ),
    [1, 2],
  );
  for (const link of first.manifest.spec.assignment.attackLinked) {
    assert.deepEqual(link.fields, ['osc.freqBase', 'osc.freqStart']);
  }
  assert.deepEqual(first.manifest.selectedOscillators, [0, 1, 2, 3]);
  assert.deepEqual(
    first.manifest.plannedEdits.map(({ oscillatorIndex, field }) =>
      key(oscillatorIndex, field),
    ),
    [0, 1, 2, 3].flatMap((index) => [
      key(index, 'osc.freqBase'),
      key(index, 'osc.freqStart'),
    ]),
  );
});

void test('planned and frozen fields cover every scalar exactly once', () => {
  const source = createTestPatch();
  const result = createPartialBodyVariant(source);
  const { manifest } = result;
  const planned = new Map(
    manifest.plannedEdits.map((edit) => [
      key(edit.oscillatorIndex, edit.field),
      edit,
    ]),
  );
  const frozen = new Map(
    manifest.frozenFields.map((field) => [
      key(field.oscillatorIndex, field.field),
      field,
    ]),
  );

  assert.equal(planned.size, manifest.plannedEdits.length);
  assert.equal(frozen.size, manifest.frozenFields.length);
  assert.equal(
    planned.size + frozen.size,
    source.oscillators.length * ALL_FIELDS.length,
  );
  source.oscillators.forEach((_, oscillatorIndex) => {
    for (const field of ALL_FIELDS) {
      const fieldKey = key(oscillatorIndex, field);
      assert.equal(
        planned.has(fieldKey) || frozen.has(fieldKey),
        true,
        `пропущено ${fieldKey}`,
      );
      assert.equal(
        planned.has(fieldKey) && frozen.has(fieldKey),
        false,
        `поле одновременно planned и frozen: ${fieldKey}`,
      );
    }
  });
  assert.equal(
    frozen.has(key(4, 'osc.on')),
    true,
    'off-слот тоже полностью заморожен',
  );
  assert.equal(frozen.get(key(2, 'ampEnv.endLevel'))?.expected, null);
  assert.deepEqual(
    verifyStructuralVariant(source, result.patch, manifest),
    [],
  );
  assert.equal(result.audit.valid, true);
});

void test('verifier detects tampering of every frozen scalar field', () => {
  const source = createTestPatch();
  const result = createPartialBodyVariant(source);

  for (const frozen of result.manifest.frozenFields) {
    const candidate = structuredClone(result.patch);
    const actual = overwriteField(
      candidate,
      frozen.oscillatorIndex,
      frozen.field,
    );
    const violations = verifyStructuralVariant(
      source,
      candidate,
      result.manifest,
    );
    const violation = findViolation(
      violations,
      frozen.oscillatorIndex,
      frozen.field,
    );
    assert.ok(
      violation,
      `не замечена подмена ${key(frozen.oscillatorIndex, frozen.field)}`,
    );
    assert.ok(Object.is(violation.expected, frozen.expected));
    assert.ok(Object.is(violation.actual, actual));
  }
});

void test('verifier detects wrong planned values and oscillator count', () => {
  const source = createTestPatch();
  const result = createPartialBodyVariant(source);

  for (const edit of result.manifest.plannedEdits) {
    const candidate = structuredClone(result.patch);
    const group = groupAt(candidate, edit.oscillatorIndex);
    const actual = edit.to + 1;
    if (edit.field === 'osc.freqBase') {
      group.osc.freqBase = actual;
    } else {
      group.osc.freqStart = actual;
    }
    const violations = verifyStructuralVariant(
      source,
      candidate,
      result.manifest,
    );
    const violation = findViolation(
      violations,
      edit.oscillatorIndex,
      edit.field,
    );
    assert.ok(violation);
    assert.equal(violation.expected, edit.to);
    assert.equal(violation.actual, actual);
  }

  const shortened = structuredClone(result.patch);
  shortened.oscillators.pop();
  const countViolation = findViolation(
    verifyStructuralVariant(source, shortened, result.manifest),
    null,
    'oscillatorCount',
  );
  assert.ok(countViolation);
  assert.equal(countViolation.expected, source.oscillators.length);
  assert.equal(countViolation.actual, shortened.oscillators.length);

  const shortenedSource = structuredClone(source);
  shortenedSource.oscillators.pop();
  const sourceCountViolation = findViolation(
    verifyStructuralVariant(
      shortenedSource,
      result.patch,
      result.manifest,
    ),
    null,
    'oscillatorCount',
  );
  assert.ok(sourceCountViolation);
  assert.equal(
    sourceCountViolation.expected,
    result.manifest.oscillatorCount,
  );
  assert.equal(
    sourceCountViolation.actual,
    shortenedSource.oscillators.length,
  );
});

void test('invalid specs reject the whole variant without partial edits', () => {
  const outOfRange = createSpec({
    operator: 'all-components',
    frequencyRatio: 4,
  });
  const belowRange = createSpec({
    operator: 'membrane-only',
    frequencyRatio: 0.01,
  });
  const overlapAssignment = createAssignment();
  overlapAssignment.membrane = [0, 3];
  overlapAssignment.configuration = [3];
  const missingAssignment = createAssignment();
  missingAssignment.configuration = [];
  const offAssignment = createAssignment();
  offAssignment.configuration = [3, 4];
  const offMembraneAssignment = createAssignment();
  offMembraneAssignment.membrane = [0, 4];
  const offAttackAssignment = createAssignment();
  offAttackAssignment.attackLinked = [
    ...offAttackAssignment.attackLinked,
    { index: 4, fields: ['osc.freqBase'] },
  ];
  const nonexistentAssignment = createAssignment();
  nonexistentAssignment.configuration = [3, 99];
  const nonIntegerAssignment = createAssignment();
  nonIntegerAssignment.configuration = [3, 1.5];
  const duplicateAssignment = createAssignment();
  duplicateAssignment.membrane = [0, 0];
  const duplicateAttackAssignment = createAssignment();
  duplicateAttackAssignment.attackLinked = [
    { index: 2, fields: ['osc.freqBase'] },
    { index: 1, fields: ['osc.freqBase'] },
    { index: 2, fields: ['osc.freqStart'] },
  ];
  const duplicateFieldAssignment = createAssignment();
  duplicateFieldAssignment.attackLinked = [
    {
      index: 2,
      fields: ['osc.freqBase', 'osc.freqBase'],
    },
    { index: 1, fields: ['osc.freqBase'] },
  ];
  const emptyAttackFieldsAssignment = createAssignment();
  emptyAttackFieldsAssignment.attackLinked = [
    { index: 2, fields: [] },
    { index: 1, fields: ['osc.freqBase'] },
  ];
  const cases: {
    name: string;
    spec: StructuralVariantSpec;
    pattern: RegExp;
  }[] = [
    {
      name: 'above frequency range',
      spec: outOfRange,
      pattern: /вне диапазона/,
    },
    {
      name: 'below frequency range',
      spec: belowRange,
      pattern: /вне диапазона/,
    },
    {
      name: 'overlap',
      spec: createSpec({ assignment: overlapAssignment }),
      pattern: /пересечения/,
    },
    {
      name: 'missing active oscillator',
      spec: createSpec({ assignment: missingAssignment }),
      pattern: /пропускает/,
    },
    {
      name: 'off oscillator in configuration',
      spec: createSpec({ assignment: offAssignment }),
      pattern: /Выключенный/,
    },
    {
      name: 'off index in membrane',
      spec: createSpec({ assignment: offMembraneAssignment }),
      pattern: /Выключенный/,
    },
    {
      name: 'off index in attackLinked',
      spec: createSpec({ assignment: offAttackAssignment }),
      pattern: /Выключенный/,
    },
    {
      name: 'nonexistent index',
      spec: createSpec({ assignment: nonexistentAssignment }),
      pattern: /не существует/,
    },
    {
      name: 'non-integer index',
      spec: createSpec({ assignment: nonIntegerAssignment }),
      pattern: /не целый/,
    },
    {
      name: 'duplicate oscillator',
      spec: createSpec({ assignment: duplicateAssignment }),
      pattern: /дубликаты/,
    },
    {
      name: 'duplicate index inside attackLinked',
      spec: createSpec({ assignment: duplicateAttackAssignment }),
      pattern: /дубликаты/,
    },
    {
      name: 'duplicate attack field',
      spec: createSpec({ assignment: duplicateFieldAssignment }),
      pattern: /дубликат/,
    },
    {
      name: 'empty attackLinked fields',
      spec: createSpec({ assignment: emptyAttackFieldsAssignment }),
      pattern: /не должны быть пустыми/,
    },
    {
      name: 'zero ratio',
      spec: createSpec({ frequencyRatio: 0 }),
      pattern: /больше нуля/,
    },
    {
      name: 'NaN ratio',
      spec: createSpec({ frequencyRatio: Number.NaN }),
      pattern: /конечным/,
    },
  ];

  for (const { name, spec, pattern } of cases) {
    const source = createTestPatch();
    const sourceSnapshot = structuredClone(source);
    const specSnapshot = structuredClone(spec);
    assert.throws(
      () => makeStructuralVariant(source, spec),
      pattern,
      name,
    );
    assert.deepEqual(source, sourceSnapshot, name);
    assert.deepEqual(spec, specSnapshot, name);
  }
});

void test('manifest JSON round-trip preserves optional localized fields', () => {
  const source = createTestPatch();
  const result = createPartialBodyVariant(source);
  const serialized = JSON.stringify(result.manifest);
  const parsed = JSON.parse(serialized) as StructuralVariantManifest;

  assert.deepEqual(parsed, result.manifest);
  assert.equal(serialized.includes('undefined'), false);
  const missingEndLevel = parsed.frozenFields.find(
    ({ oscillatorIndex, field }) =>
      oscillatorIndex === 2 && field === 'ampEnv.endLevel',
  );
  assert.ok(missingEndLevel);
  assert.equal(missingEndLevel.expected, null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(missingEndLevel, 'expected'),
    true,
  );
  for (const field of [
    'ampEnv.attack',
    'ampEnv.hardStop',
  ] as OscField[]) {
    const missing = parsed.frozenFields.find(
      (entry) => entry.oscillatorIndex === 2 && entry.field === field,
    );
    assert.ok(missing);
    assert.equal(missing.expected, null);
    const explicit = parsed.frozenFields.find(
      (entry) => entry.oscillatorIndex === 1 && entry.field === field,
    );
    assert.ok(explicit);
    assert.equal(
      explicit.expected,
      field === 'ampEnv.attack' ? 0.002 : true,
    );
  }
  assert.deepEqual(
    verifyStructuralVariant(source, result.patch, parsed),
    [],
  );
});

void test('negative zero survives JSON round-trip as canonical positive zero', () => {
  const source = createTestPatch();
  groupAt(source, 3).osc.phase = -0;
  assert.ok(Object.is(groupAt(source, 3).osc.phase, -0));

  const result = makeStructuralVariant(
    source,
    createSpec({ frequencyRatio: 1 }),
  );
  const frozenPhase = result.manifest.frozenFields.find(
    ({ oscillatorIndex, field }) =>
      oscillatorIndex === 3 && field === 'osc.phase',
  );
  assert.ok(frozenPhase);
  assert.ok(Object.is(frozenPhase.expected, 0));

  const parsedManifest = JSON.parse(
    JSON.stringify(result.manifest),
  ) as StructuralVariantManifest;
  const parsedPatch = JSON.parse(
    JSON.stringify(result.patch),
  ) as ArgCreateSynth;
  assert.ok(Object.is(groupAt(parsedPatch, 3).osc.phase, 0));
  assert.deepEqual(parsedManifest, result.manifest);
  assert.deepEqual(
    verifyStructuralVariant(source, parsedPatch, parsedManifest),
    [],
  );
  assert.deepEqual(result.audit.actualEdits, []);
  assert.equal(result.audit.valid, true);
});

void test('ratio 1 preserves patch and rendered PCM bytes; audit has no edits', () => {
  const source = createTestPatch();
  const result = makeStructuralVariant(
    source,
    createSpec({ frequencyRatio: 1 }),
  );

  assert.deepEqual(result.patch, source);
  assert.deepEqual(result.audit.actualEdits, []);
  assert.equal(result.audit.valid, true);
  assert.equal(result.audit.sourceUnchanged, true);
  assert.ok(result.manifest.plannedEdits.length > 0);

  const sourceSamples = renderSamples(source, 0.03, {
    phaseModel: 'integral',
  });
  const variantSamples = renderSamples(result.patch, 0.03, {
    phaseModel: 'integral',
  });
  const sourceBytes = Buffer.from(
    sourceSamples.buffer,
    sourceSamples.byteOffset,
    sourceSamples.byteLength,
  );
  const variantBytes = Buffer.from(
    variantSamples.buffer,
    variantSamples.byteOffset,
    variantSamples.byteLength,
  );
  assert.ok(sourceBytes.equals(variantBytes));
});

void test('source and spec remain unchanged; repeated calls are deterministic', () => {
  const source = createTestPatch();
  const spec = createSpec();
  const sourceSnapshot = structuredClone(source);
  const specSnapshot = structuredClone(spec);

  const first = makeStructuralVariant(source, spec);
  const second = makeStructuralVariant(source, spec);

  assert.deepEqual(source, sourceSnapshot);
  assert.deepEqual(spec, specSnapshot);
  assert.deepEqual(first, second);
  assert.equal(first.audit.sourceUnchanged, true);
  assert.notEqual(first.patch, source);
  assert.notEqual(first.patch.oscillators[0], source.oscillators[0]);
});

void test('empty attackLinked makes the first two operators equivalent', () => {
  const source = createTestPatch();
  const assignment: StructuralAssignment = {
    membrane: [0],
    attackLinked: [],
    configuration: [1, 2, 3],
  };
  const membrane = makeStructuralVariant(
    source,
    createSpec({ assignment, operator: 'membrane-only' }),
  );
  const body = makeStructuralVariant(
    source,
    createSpec({ assignment, operator: 'body-plus-named-attack' }),
  );

  assert.deepEqual(body.patch, membrane.patch);
  assert.deepEqual(
    body.manifest.selectedOscillators,
    membrane.manifest.selectedOscillators,
  );
  assert.deepEqual(
    body.manifest.plannedEdits,
    membrane.manifest.plannedEdits,
  );
  assert.deepEqual(
    body.manifest.frozenFields,
    membrane.manifest.frozenFields,
  );
  assert.deepEqual(
    body.audit.actualEdits,
    membrane.audit.actualEdits,
  );
  // Это один механический контроль, а не два независимых подтверждения закона.
});
