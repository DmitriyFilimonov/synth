/**
 * Чистые offline-варианты высоты для T35.
 *
 * Роли компонентов приходят только из явной разметки. Модуль не
 * классифицирует осцилляторы по частоте или длительности, не запускает
 * синтез и не подключён к match, enhance или HTTP API. Он проверяет
 * механику вмешательства, но не подтверждает акустический закон.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  oscConfigNormales,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';

/** Частотные поля, которые оператор вправе менять. */
export type FrequencyField = 'osc.freqBase' | 'osc.freqStart';

/** Все scalar-поля одного осциллятора в патче. */
export type OscField =
  | 'osc.on'
  | FrequencyField
  | 'osc.duration'
  | 'osc.slope'
  | 'osc.phase'
  | 'osc.delay'
  | 'ampEnv.startLevel'
  | 'ampEnv.endLevel'
  | 'ampEnv.duration'
  | 'ampEnv.slope'
  | 'ampEnv.attack'
  | 'ampEnv.hardStop';

/** Значение scalar-поля; null обозначает отсутствующее optional-поле. */
export type ScalarValue = number | boolean | null;

/** Связь одной attack-компоненты с перестройкой мембраны. */
export interface AttackLinkedOscillator {
  index: number;
  /** Непустой список частот, связанных с перестройкой мембраны. */
  fields: FrequencyField[];
}

/**
 * Явная и полная разметка активных осцилляторов.
 *
 * Несколько допустимых разметок одного патча различает hypothesisId
 * во внешнем runner; этот модуль не выбирает между ними.
 */
export interface StructuralAssignment {
  membrane: number[];
  attackLinked: AttackLinkedOscillator[];
  configuration: number[];
}

/** Происхождение исходного match-патча. */
export interface StructuralVariantSource {
  slug: string;
  seed: number;
  phaseModel: PhaseModel;
  codeRevision: string | null;
  patchSha256: string;
}

/** Конкурирующие операторы перестройки высоты. */
export type StructuralOperator =
  'membrane-only' | 'body-plus-named-attack' | 'all-components';

/** Описание одной гипотезы и её вмешательства. */
export interface StructuralVariantSpec {
  hypothesisId: string;
  source: StructuralVariantSource;
  assignment: StructuralAssignment;
  operator: StructuralOperator;
  frequencyRatio: number;
}

/** Запланированная частотная правка, включая no-op при ratio 1. */
export interface StructuralPlannedEdit {
  oscillatorIndex: number;
  field: FrequencyField;
  from: number;
  to: number;
}

/** Значение, которое кандидат обязан сохранить точно. */
export interface StructuralFrozenField {
  oscillatorIndex: number;
  field: OscField;
  expected: ScalarValue;
}

/** Манифест версии 1: намерение и инварианты известны до синтеза. */
export interface StructuralVariantManifest {
  version: 1;
  spec: StructuralVariantSpec;
  oscillatorCount: number;
  selectedOscillators: number[];
  plannedEdits: StructuralPlannedEdit[];
  frozenFields: StructuralFrozenField[];
}

/** Одно расхождение кандидата с манифестом или исходником. */
export interface InvariantViolation {
  oscillatorIndex: number | null;
  field: OscField | 'oscillatorCount';
  expected: ScalarValue;
  actual: ScalarValue;
}

/** Фактическая scalar-правка; no-op сюда не попадает. */
export interface StructuralActualEdit {
  oscillatorIndex: number;
  field: OscField;
  from: ScalarValue;
  to: ScalarValue;
}

/** Результат внутренней проверки созданного варианта. */
export interface StructuralVariantAudit {
  valid: boolean;
  sourceUnchanged: boolean;
  actualEdits: StructuralActualEdit[];
  violations: InvariantViolation[];
}

/** Патч, манифест намерения и фактический аудит. */
export interface StructuralVariantResult {
  patch: ArgCreateSynth;
  manifest: StructuralVariantManifest;
  audit: StructuralVariantAudit;
}

const FIELD_ORDER: readonly OscField[] = [
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

const FREQUENCY_FIELDS: readonly FrequencyField[] = [
  'osc.freqBase',
  'osc.freqStart',
];

const FIELD_RANK = new Map<OscField, number>(
  FIELD_ORDER.map((field, index) => [field, index]),
);

/** Сравнивает поля в фиксированном порядке схемы патча. */
function compareFields(a: OscField, b: OscField): number {
  return (FIELD_RANK.get(a) ?? -1) - (FIELD_RANK.get(b) ?? -1);
}

/** Сортирует числа, не меняя исходный массив. */
function sortedIndices(indices: number[]): number[] {
  return [...indices].sort((a, b) => a - b);
}

/** Приводит оба числовых нуля к +0 ради стабильного JSON round-trip. */
function canonicalNumber(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Возвращает scalar-поле или `null` для отсутствующего значения.
 *
 * @param patch - Патч, из которого читается поле
 * @param oscillatorIndex - Нулевой индекс осциллятора
 * @param field - Имя scalar-поля
 * @returns Точное значение поля; отсутствующий осциллятор или optional
 *   `endLevel`, `delay`, `attack`, `hardStop` дают `null`
 * @remarks Все числовые нули становятся +0, включая исходный -0. Явные
 *   `osc.delay: 0`, `ampEnv.attack: 0` и `ampEnv.hardStop: false`
 *   остаются значениями, поэтому verifier отличает их от отсутствия поля.
 */
function readField(
  patch: ArgCreateSynth,
  oscillatorIndex: number,
  field: OscField,
): ScalarValue {
  const group = patch.oscillators[oscillatorIndex];
  if (group === undefined) {
    return null;
  }
  switch (field) {
    case 'osc.on':
      return group.osc.on;
    case 'osc.freqBase':
      return canonicalNumber(group.osc.freqBase);
    case 'osc.freqStart':
      return canonicalNumber(group.osc.freqStart);
    case 'osc.duration':
      return canonicalNumber(group.osc.duration);
    case 'osc.slope':
      return canonicalNumber(group.osc.slope);
    case 'osc.phase':
      return canonicalNumber(group.osc.phase);
    case 'osc.delay':
      return group.osc.delay === undefined
        ? null
        : canonicalNumber(group.osc.delay);
    case 'ampEnv.startLevel':
      return canonicalNumber(group.ampEnv.startLevel);
    case 'ampEnv.endLevel':
      return group.ampEnv.endLevel === undefined
        ? null
        : canonicalNumber(group.ampEnv.endLevel);
    case 'ampEnv.duration':
      return canonicalNumber(group.ampEnv.duration);
    case 'ampEnv.slope':
      return canonicalNumber(group.ampEnv.slope);
    case 'ampEnv.attack':
      return group.ampEnv.attack === undefined
        ? null
        : canonicalNumber(group.ampEnv.attack);
    case 'ampEnv.hardStop':
      return group.ampEnv.hardStop ?? null;
    default:
      return null;
  }
}

/** Ключ помогает отличить разрешённую правку от frozen-поля. */
function fieldKey(oscillatorIndex: number, field: OscField): string {
  return `${oscillatorIndex}:${field}`;
}

/**
 * Проверяет полноту разметки и возвращает её каноническую копию.
 * Активный индекс встречается ровно один раз; off-слоты запрещены.
 */
function canonicalizeAssignment(
  source: ArgCreateSynth,
  assignment: StructuralAssignment,
): StructuralAssignment {
  const canonical: StructuralAssignment = {
    membrane: sortedIndices(assignment.membrane),
    attackLinked: assignment.attackLinked
      .map(({ index, fields }) => ({
        index,
        fields: [...fields].sort(compareFields),
      }))
      .sort((a, b) => a.index - b.index),
    configuration: sortedIndices(assignment.configuration),
  };
  const claimed = new Map<number, string>();
  const active = new Set<number>();
  source.oscillators.forEach((group, index) => {
    if (group.osc.on) {
      active.add(index);
    }
  });

  const claim = (index: number, role: string): void => {
    if (!Number.isInteger(index)) {
      throw new Error(`Индекс осциллятора ${index} не целый`);
    }
    const group = source.oscillators[index];
    if (group === undefined) {
      throw new Error(`Осциллятор ${index} не существует`);
    }
    if (!group.osc.on) {
      throw new Error(
        `Выключенный осциллятор ${index} нельзя размечать`,
      );
    }
    const previous = claimed.get(index);
    if (previous !== undefined) {
      throw new Error(
        `Осциллятор ${index} уже размечен как ${previous}; ` +
          'дубликаты и пересечения запрещены',
      );
    }
    claimed.set(index, role);
  };

  for (const index of canonical.membrane) {
    claim(index, 'membrane');
  }
  for (const link of canonical.attackLinked) {
    if (link.fields.length === 0) {
      throw new Error(
        `Поля attackLinked осциллятора ${link.index} ` +
          'не должны быть пустыми',
      );
    }
    claim(link.index, 'attackLinked');
    const seenFields = new Set<FrequencyField>();
    for (const field of link.fields) {
      if (!FREQUENCY_FIELDS.includes(field)) {
        throw new Error(
          `Поле ${field} нельзя связывать с перестройкой атаки`,
        );
      }
      if (seenFields.has(field)) {
        throw new Error(
          `Поля attackLinked осциллятора ${link.index} ` +
            'содержат дубликат',
        );
      }
      seenFields.add(field);
    }
  }
  for (const index of canonical.configuration) {
    claim(index, 'configuration');
  }

  const missing = [...active]
    .filter((index) => !claimed.has(index))
    .sort((a, b) => a - b);
  if (missing.length > 0) {
    throw new Error(
      `Разметка пропускает активные осцилляторы: ${missing.join(', ')}`,
    );
  }
  return canonical;
}

/** Копирует spec и сортирует все массивы разметки. */
function canonicalizeSpec(
  source: ArgCreateSynth,
  spec: StructuralVariantSpec,
): StructuralVariantSpec {
  return {
    hypothesisId: spec.hypothesisId,
    source: {
      slug: spec.source.slug,
      seed: spec.source.seed,
      phaseModel: spec.source.phaseModel,
      codeRevision: spec.source.codeRevision,
      patchSha256: spec.source.patchSha256,
    },
    assignment: canonicalizeAssignment(source, spec.assignment),
    operator: spec.operator,
    frequencyRatio: spec.frequencyRatio,
  };
}

/**
 * Выбирает разрешённые поля и планирует все правки до изменения копии.
 * Любая нефинитная или выходящая за норму частота отклоняет вариант.
 */
function planEdits(
  source: ArgCreateSynth,
  spec: StructuralVariantSpec,
): {
  selectedOscillators: number[];
  plannedEdits: StructuralPlannedEdit[];
} {
  const selected = new Map<number, Set<FrequencyField>>();
  const select = (
    oscillatorIndex: number,
    fields: readonly FrequencyField[],
  ): void => {
    const current =
      selected.get(oscillatorIndex) ?? new Set<FrequencyField>();
    for (const field of fields) {
      current.add(field);
    }
    selected.set(oscillatorIndex, current);
  };

  if (spec.operator === 'all-components') {
    source.oscillators.forEach((group, index) => {
      if (group.osc.on) {
        select(index, FREQUENCY_FIELDS);
      }
    });
  } else {
    for (const index of spec.assignment.membrane) {
      select(index, FREQUENCY_FIELDS);
    }
    if (spec.operator === 'body-plus-named-attack') {
      for (const link of spec.assignment.attackLinked) {
        select(link.index, link.fields);
      }
    } else if (spec.operator !== 'membrane-only') {
      throw new Error('Неизвестный структурный оператор');
    }
  }

  const selectedOscillators = [...selected.keys()].sort(
    (a, b) => a - b,
  );
  const plannedEdits: StructuralPlannedEdit[] = [];
  for (const oscillatorIndex of selectedOscillators) {
    const fields = [
      ...(selected.get(oscillatorIndex) ?? new Set<FrequencyField>()),
    ].sort(compareFields);
    for (const field of fields) {
      const from = readField(source, oscillatorIndex, field);
      if (typeof from !== 'number') {
        throw new Error(
          `Нет исходной частоты ${field} у осциллятора ` +
            `${oscillatorIndex}`,
        );
      }
      const to = from * spec.frequencyRatio;
      const range =
        field === 'osc.freqBase'
          ? oscConfigNormales.freqBase
          : oscConfigNormales.freqStart;
      if (!Number.isFinite(to) || to < range.min || to > range.max) {
        throw new Error(
          `Новая частота ${field} осциллятора ${oscillatorIndex} ` +
            `вне диапазона ${range.min}..${range.max}: ${to}; ` +
            'вариант отклонён',
        );
      }
      plannedEdits.push({ oscillatorIndex, field, from, to });
    }
  }
  return { selectedOscillators, plannedEdits };
}

/** Перечисляет все scalar-поля, кроме разрешённых planned edits. */
function planFrozenFields(
  source: ArgCreateSynth,
  plannedEdits: StructuralPlannedEdit[],
): StructuralFrozenField[] {
  const editable = new Set(
    plannedEdits.map(({ oscillatorIndex, field }) =>
      fieldKey(oscillatorIndex, field),
    ),
  );
  const frozenFields: StructuralFrozenField[] = [];
  source.oscillators.forEach((_, oscillatorIndex) => {
    for (const field of FIELD_ORDER) {
      if (editable.has(fieldKey(oscillatorIndex, field))) {
        continue;
      }
      frozenFields.push({
        oscillatorIndex,
        field,
        expected: readField(source, oscillatorIndex, field),
      });
    }
  });
  return frozenFields;
}

/** Применяет уже проверенный план к независимой копии патча. */
function applyPlannedEdits(
  source: ArgCreateSynth,
  plannedEdits: StructuralPlannedEdit[],
): ArgCreateSynth {
  const patch = structuredClone(source);
  for (const edit of plannedEdits) {
    const group = patch.oscillators[edit.oscillatorIndex];
    if (group === undefined) {
      throw new Error(
        `Нет осциллятора ${edit.oscillatorIndex} в копии патча`,
      );
    }
    if (edit.field === 'osc.freqBase') {
      group.osc.freqBase = edit.to;
    } else {
      group.osc.freqStart = edit.to;
    }
  }
  return patch;
}

/** Добавляет нарушение, если exact-значения различаются. */
function appendMismatch(
  violations: InvariantViolation[],
  oscillatorIndex: number | null,
  field: OscField | 'oscillatorCount',
  expected: ScalarValue,
  actual: ScalarValue,
): void {
  if (!Object.is(expected, actual)) {
    violations.push({ oscillatorIndex, field, expected, actual });
  }
}

/**
 * Проверяет, что исходник и кандидат точно соответствуют манифесту.
 *
 * @param source - Исходный патч, от которого построен манифест
 * @param candidate - Проверяемый вариант
 * @param manifest - Манифест с planned и frozen scalar-полями
 * @returns Список расхождений; пустой массив означает совпадение
 * @remarks Сверяет число осцилляторов, исходные и новые значения
 *   запланированных частот и точные значения всех замороженных полей
 *   в обоих патчах. Не запускает синтез и не оценивает акустический
 *   закон.
 */
export function verifyStructuralVariant(
  source: ArgCreateSynth,
  candidate: ArgCreateSynth,
  manifest: StructuralVariantManifest,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  appendMismatch(
    violations,
    null,
    'oscillatorCount',
    manifest.oscillatorCount,
    source.oscillators.length,
  );
  appendMismatch(
    violations,
    null,
    'oscillatorCount',
    manifest.oscillatorCount,
    candidate.oscillators.length,
  );

  for (const edit of manifest.plannedEdits) {
    appendMismatch(
      violations,
      edit.oscillatorIndex,
      edit.field,
      edit.from,
      readField(source, edit.oscillatorIndex, edit.field),
    );
    appendMismatch(
      violations,
      edit.oscillatorIndex,
      edit.field,
      edit.to,
      readField(candidate, edit.oscillatorIndex, edit.field),
    );
  }
  for (const frozen of manifest.frozenFields) {
    appendMismatch(
      violations,
      frozen.oscillatorIndex,
      frozen.field,
      frozen.expected,
      readField(source, frozen.oscillatorIndex, frozen.field),
    );
    appendMismatch(
      violations,
      frozen.oscillatorIndex,
      frozen.field,
      frozen.expected,
      readField(candidate, frozen.oscillatorIndex, frozen.field),
    );
  }
  return violations;
}

/** Собирает только реальные scalar-изменения в стабильном порядке. */
function collectActualEdits(
  source: ArgCreateSynth,
  candidate: ArgCreateSynth,
): StructuralActualEdit[] {
  const edits: StructuralActualEdit[] = [];
  const count = Math.max(
    source.oscillators.length,
    candidate.oscillators.length,
  );
  for (
    let oscillatorIndex = 0;
    oscillatorIndex < count;
    oscillatorIndex += 1
  ) {
    for (const field of FIELD_ORDER) {
      const from = readField(source, oscillatorIndex, field);
      const to = readField(candidate, oscillatorIndex, field);
      if (!Object.is(from, to)) {
        edits.push({ oscillatorIndex, field, from, to });
      }
    }
  }
  return edits;
}

/**
 * Строит детерминированный offline-вариант высоты по явной разметке.
 *
 * @param source - Исходный match-патч; функция его не изменяет
 * @param spec - Гипотеза, оператор и множитель частоты
 * @returns Независимый патч, манифест запланированных правок и аудит
 * @throws Error если разметка неполна или противоречива, множитель
 *   частоты не конечен либо не положителен, выбран неизвестный оператор
 *   или хотя бы одна новая частота выходит за `oscConfigNormales`
 * @remarks Чистая механика T35: не выполняет I/O и синтез и не
 *   подтверждает акустический закон. Роли берёт только из
 *   `spec.assignment`, без эвристик по частоте или длительности.
 *   Операторы меняют только разрешённые `freqBase` и `freqStart`:
 *   `membrane-only` затрагивает мембрану, `body-plus-named-attack`
 *   добавляет явно связанные поля атаки, а `all-components`
 *   перестраивает все активные осцилляторы. Выход любой новой частоты
 *   за нормы отклоняет весь вариант без обрезки значений. При
 *   `frequencyRatio = 1` planned edits остаются в манифесте, но патч
 *   совпадает с исходником, а `actualEdits` пуст. Поля `osc.delay`,
 *   `ampEnv.attack` и `ampEnv.hardStop` всегда заморожены: verifier
 *   различает отсутствующее значение, явный ноль и false. Входной `spec`
 *   также остаётся неизменным.
 */
export function makeStructuralVariant(
  source: ArgCreateSynth,
  spec: StructuralVariantSpec,
): StructuralVariantResult {
  const sourceSnapshot = structuredClone(source);
  if (
    !Number.isFinite(spec.frequencyRatio) ||
    spec.frequencyRatio <= 0
  ) {
    throw new Error(
      'frequencyRatio должен быть конечным и больше нуля',
    );
  }
  const canonicalSpec = canonicalizeSpec(source, spec);
  const { selectedOscillators, plannedEdits } = planEdits(
    source,
    canonicalSpec,
  );
  const manifest: StructuralVariantManifest = {
    version: 1,
    spec: canonicalSpec,
    oscillatorCount: source.oscillators.length,
    selectedOscillators,
    plannedEdits,
    frozenFields: planFrozenFields(source, plannedEdits),
  };
  const patch = applyPlannedEdits(source, plannedEdits);
  const violations = verifyStructuralVariant(source, patch, manifest);
  const actualEdits = collectActualEdits(source, patch);
  const sourceUnchanged = isDeepStrictEqual(source, sourceSnapshot);
  return {
    patch,
    manifest,
    audit: {
      valid: violations.length === 0 && sourceUnchanged,
      sourceUnchanged,
      actualEdits,
      violations,
    },
  };
}
