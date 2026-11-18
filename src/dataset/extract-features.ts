/* eslint-disable no-console */
/**
 * Извлекает канонические признаки осцилляторов из дерева прогонов
 * датасета стабильности (задача T4 плана
 * `docs/plan-kick-enhancement.md`, этап 2 «Каноническое
 * представление и чистка»).
 *
 * Читает дерево, которое пишет `build-dataset.ts`:
 *
 *   <dataset>/manifest.json
 *   <dataset>/<slug>/init-vector.json
 *   <dataset>/<slug>/seed-<N>/run.json
 *   <dataset>/<slug>/seed-<N>/patch.json
 *
 * и складывает признаки рядом с прогонами:
 *
 *   <out>/<slug>/seed-<N>/features.json
 *   <out>/features.csv
 *
 * Обрабатывает только прогоны со status "completed" и только
 * включённые осцилляторы (`osc.on === true`). Повреждённые файлы
 * пропускает с предупреждением: один битый прогон не должен ронять
 * обход всего датасета. Порядок обхода детерминирован: имена
 * каталогов сортируются.
 *
 * Семантика огибающих (по `src/envelope.ts` и `src/synth.ts`):
 * амплитудная — amp(x) = startLevel * e^(ln(endLevel) *
 * (x/duration)^slope), то есть endLevel — относительный множитель,
 * конечный уровень равен startLevel * endLevel; частотная —
 * freq(x) = freqBase + (freqStart - freqBase) * e^(ln(0.001) *
 * (x/duration)^slope): осциллятор стартует на freqStart и
 * стягивается к freqBase.
 *
 * Запуск:
 *   npx tsx src/dataset/extract-features.ts --dataset datasets/ref-4
 *   npx tsx src/dataset/extract-features.ts \
 *     --dataset datasets/ref-4 --out /tmp/features
 */
import { existsSync } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MIN } from '../envelope';
import type { ArgCreateSynth } from '../synth';
import { mapVectorToSynthConfigForOsc } from '../vector-to-synth-config';

/** Аргументы командной строки. */
interface CliArgs {
  dataset: string;
  out: string;
}

/** Роль слота по provenance инициализации (dual-window). */
export type OscillatorRole = 'sustain' | 'transient';

/** Времена спада амплитудной огибающей до −20/−40/−60 дБ. */
export interface DecaySecToDb {
  db20: number | null;
  db40: number | null;
  db60: number | null;
}

/** Канонические признаки одного включённого осциллятора. */
export interface OscillatorFeatures {
  /** Исходный индекс слота 0..49 в патче. */
  index: number;
  role: OscillatorRole;
  freqBase: number;
  freqStart: number;
  freqEnvSlope: number;
  freqEnvDurationSec: number;
  phaseRad: number;
  phaseSin: number;
  phaseCos: number;
  ampStartLevel: number;
  /**
   * Относительный конечный уровень огибающей: конечная амплитуда
   * равна ampStartLevel * ampEndLevel (см. `src/synth.ts`).
   */
  ampEndLevel: number;
  ampEnvSlope: number;
  ampEnvDurationSec: number;
  /** Натуральный логарифм freqBase. */
  logFreqBase: number;
  /** Натуральный логарифм freqStart. */
  logFreqStart: number;
  /** Отношение freqStart / freqBase. */
  freqStartToBase: number;
  decaySecToDb: DecaySecToDb;
}

/** Признаки одного прогона — содержимое features.json. */
export interface RunFeatures {
  target: string;
  slug: string;
  seed: number;
  suppressionPercent: number | null;
  globalSuppressionPercent: number | null;
  oscillators: OscillatorFeatures[];
}

/** Один осциллятор внутри ArgCreateSynth. */
type OscillatorGroup = ArgCreateSynth['oscillators'][number];

/** Slope амплитудной огибающей sustain-слота в dual-window init. */
const SUSTAIN_INIT_AMP_SLOPE = 0.8;

/** Slope амплитудной огибающей transient-слота в dual-window init. */
const TRANSIENT_INIT_AMP_SLOPE = 2.0;

/**
 * Порог классификации роли: середина между sustain- и
 * transient-сигнатурами init-огибающей.
 */
const ROLE_SLOPE_THRESHOLD =
  (SUSTAIN_INIT_AMP_SLOPE + TRANSIENT_INIT_AMP_SLOPE) / 2;

/**
 * Считает, за сколько секунд амплитудная огибающая падает до доли
 * `ratio` от стартового уровня. Решает аналитически формулу из
 * `src/envelope.ts`:
 *
 *   amp(x) = startLevel * e^(ln(endLevel) * (x / duration)^slope)
 *
 * endLevel здесь — относительный множитель, поэтому startLevel
 * сокращается: x = duration * (ln(ratio) / ln(endLevel))^(1/slope).
 * Возвращает null в трёх случаях: огибающая не спадает вовсе
 * (endLevel >= 1), конечный уровень лежит выше целевой доли
 * (endLevel > ratio — огибающая клампится раньше, чем успевает
 * опуститься), либо входные значения нефизичны. Границу
 * endLevel === ratio считаем достижимой и возвращаем duration:
 * иначе колонка db60 обнулялась бы у всех осцилляторов с
 * endLevel = MIN = 0.001, а такой endLevel у большинства патчей.
 */
export function computeDecayTimeSec(arg: {
  endLevel: number;
  slope: number;
  durationSec: number;
  ratio: number;
}): number | null {
  const { endLevel, slope, durationSec, ratio } = arg;
  if (
    !(endLevel > 0 && endLevel < 1) ||
    !(slope > 0) ||
    !(durationSec > 0) ||
    !(ratio > 0 && ratio < 1)
  ) {
    return null;
  }
  if (ratio < endLevel) {
    return null;
  }
  const power = Math.log(ratio) / Math.log(endLevel);
  const t = durationSec * power ** (1 / slope);
  return t <= durationSec ? t : null;
}

/**
 * Считает времена спада до −20/−40/−60 дБ (доли 0.1 / 0.01 / 0.001
 * от стартового уровня) для амплитудной огибающей осциллятора.
 */
export function computeDecaySecToDb(arg: {
  endLevel: number;
  slope: number;
  durationSec: number;
}): DecaySecToDb {
  return {
    db20: computeDecayTimeSec({ ...arg, ratio: 10 ** (-20 / 20) }),
    db40: computeDecayTimeSec({ ...arg, ratio: 10 ** (-40 / 20) }),
    db60: computeDecayTimeSec({ ...arg, ratio: 10 ** (-60 / 20) }),
  };
}

/**
 * Определяет роль слота по init-вектору таргета, а не по финальному
 * патчу: `dualWindowInitVector` размечает sustain-слоты длинной
 * огибающей со slope 0.8, transient-слоты — огибающей на ~40 мс со
 * slope 2.0, а coordinate descent слоты не переупорядочивает.
 * Денормализует слот тем же маппингом, что и оптимизатор
 * (`mapVectorToSynthConfigForOsc`), и сравнивает init-slope с
 * порогом посередине между сигнатурами — запас в 0.6 с каждой
 * стороны прощает ошибку округления денормализации. Слоты,
 * выключенные в init-векторе (slope денормализуется в 0.2), и
 * слоты за пределами короткого вектора получают роль sustain.
 */
export function classifyOscillatorRole(
  initVector: readonly number[],
  oscIndex: number,
): OscillatorRole {
  const initSlot = mapVectorToSynthConfigForOsc(initVector, oscIndex);
  return initSlot.ampEnv.slope >= ROLE_SLOPE_THRESHOLD
    ? 'transient'
    : 'sustain';
}

/**
 * Переводит один осциллятор финального патча в канонические
 * признаки: физические единицы (герцы, секунды, радианы) плюс
 * производные отношения и времена спада. Отсутствующий endLevel
 * трактует как MIN — так поступает и рантайм-синтез. Возвращает
 * null, если частота или стартовый уровень неположительны:
 * логарифм и отношение для них не определены, патч повреждён.
 */
export function extractOscillatorFeatures(arg: {
  group: OscillatorGroup;
  index: number;
  role: OscillatorRole;
}): OscillatorFeatures | null {
  const { group, index, role } = arg;
  const freqBase = group.osc.freqBase;
  const freqStart = group.osc.freqStart;
  const ampStartLevel = group.ampEnv.startLevel;
  const ampEndLevel = group.ampEnv.endLevel ?? MIN;
  if (!(freqBase > 0) || !(freqStart > 0) || !(ampStartLevel > 0)) {
    return null;
  }
  return {
    index,
    role,
    freqBase,
    freqStart,
    freqEnvSlope: group.osc.slope,
    freqEnvDurationSec: group.osc.duration,
    phaseRad: group.osc.phase,
    phaseSin: Math.sin(group.osc.phase),
    phaseCos: Math.cos(group.osc.phase),
    ampStartLevel,
    ampEndLevel,
    ampEnvSlope: group.ampEnv.slope,
    ampEnvDurationSec: group.ampEnv.duration,
    logFreqBase: Math.log(freqBase),
    logFreqStart: Math.log(freqStart),
    freqStartToBase: freqStart / freqBase,
    decaySecToDb: computeDecaySecToDb({
      endLevel: ampEndLevel,
      slope: group.ampEnv.slope,
      durationSec: group.ampEnv.duration,
    }),
  };
}

/**
 * Собирает признаки прогона: метаданные из run.json плюс признаки
 * всех включённых осцилляторов патча. Роль каждого слота берёт из
 * init-вектора таргета.
 */
export function buildRunFeatures(arg: {
  target: string;
  slug: string;
  seed: number;
  suppressionPercent: number | null;
  globalSuppressionPercent: number | null;
  patch: ArgCreateSynth;
  initVector: readonly number[];
}): RunFeatures {
  const oscillators: OscillatorFeatures[] = [];
  for (const [index, group] of arg.patch.oscillators.entries()) {
    if (group.osc.on !== true) {
      continue;
    }
    const features = extractOscillatorFeatures({
      group,
      index,
      role: classifyOscillatorRole(arg.initVector, index),
    });
    if (features === null) {
      console.warn(
        `WARN ${arg.slug}/seed-${arg.seed}: osc[${index}] ` +
          'skipped (non-positive freqBase/freqStart/startLevel)',
      );
      continue;
    }
    oscillators.push(features);
  }
  return {
    target: arg.target,
    slug: arg.slug,
    seed: arg.seed,
    suppressionPercent: arg.suppressionPercent,
    globalSuppressionPercent: arg.globalSuppressionPercent,
    oscillators,
  };
}

/** Имена колонок features.csv в фиксированном порядке. */
const CSV_COLUMNS = [
  'target',
  'slug',
  'seed',
  'suppressionPercent',
  'globalSuppressionPercent',
  'index',
  'role',
  'freqBase',
  'freqStart',
  'freqEnvSlope',
  'freqEnvDurationSec',
  'phaseRad',
  'phaseSin',
  'phaseCos',
  'ampStartLevel',
  'ampEndLevel',
  'ampEnvSlope',
  'ampEnvDurationSec',
  'logFreqBase',
  'logFreqStart',
  'freqStartToBase',
  'decaySecToDb.db20',
  'decaySecToDb.db40',
  'decaySecToDb.db60',
] as const;

/** Плоская строка CSV: вложенные поля расплющены через точку. */
export type FeaturesCsvRow = Record<string, string | number | null>;

/**
 * Расплющивает признаки осциллятора в строку CSV: run-метаданные
 * повторяются в каждой строке, вложенный `decaySecToDb` получает
 * имена колонок через точку.
 */
export function flattenFeaturesRow(arg: {
  run: RunFeatures;
  osc: OscillatorFeatures;
}): FeaturesCsvRow {
  const { run, osc } = arg;
  return {
    target: run.target,
    slug: run.slug,
    seed: run.seed,
    suppressionPercent: run.suppressionPercent,
    globalSuppressionPercent: run.globalSuppressionPercent,
    index: osc.index,
    role: osc.role,
    freqBase: osc.freqBase,
    freqStart: osc.freqStart,
    freqEnvSlope: osc.freqEnvSlope,
    freqEnvDurationSec: osc.freqEnvDurationSec,
    phaseRad: osc.phaseRad,
    phaseSin: osc.phaseSin,
    phaseCos: osc.phaseCos,
    ampStartLevel: osc.ampStartLevel,
    ampEndLevel: osc.ampEndLevel,
    ampEnvSlope: osc.ampEnvSlope,
    ampEnvDurationSec: osc.ampEnvDurationSec,
    logFreqBase: osc.logFreqBase,
    logFreqStart: osc.logFreqStart,
    freqStartToBase: osc.freqStartToBase,
    'decaySecToDb.db20': osc.decaySecToDb.db20,
    'decaySecToDb.db40': osc.decaySecToDb.db40,
    'decaySecToDb.db60': osc.decaySecToDb.db60,
  };
}

/**
 * Экранирует ячейку CSV по RFC 4180: значение с запятой, кавычкой
 * или переводом строки оборачивается в кавычки, внутренние кавычки
 * удваиваются.
 */
function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Сериализует значение в ячейку CSV; null — пустая ячейка. */
function csvCell(value: string | number | null): string {
  if (value === null) {
    return '';
  }
  return escapeCsvCell(String(value));
}

/**
 * Собирает весь features.csv: заголовок плюс по одной строке на
 * каждый включённый осциллятор каждого обработанного прогона.
 */
function renderFeaturesCsv(rows: readonly FeaturesCsvRow[]): string {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      CSV_COLUMNS.map((col) => csvCell(row[col] ?? null)).join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** Пишет текст атомарно: временный файл + rename. */
async function writeTextAtomic(
  path: string,
  data: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Пишет JSON атомарно: временный файл + rename. */
async function writeJsonAtomic(
  path: string,
  data: unknown,
): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(data, null, 2));
}

/**
 * Читает и разбирает JSON-файл. При любой ошибке (нет файла,
 * битый JSON) возвращает null — вызывающий решает, что пропустить.
 */
async function readJsonSafe(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Проверяет, что значение — массив конечных чисел. */
function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

/** Проверяет, что значение — конечное число. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Проверяет структуру patch.json: объект с массивом осцилляторов,
 * у каждого есть osc и ampEnv с числовыми полями, которые читает
 * извлечение. endLevel опционален — рантайм подставляет MIN.
 */
function isValidPatch(value: unknown): value is ArgCreateSynth {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { oscillators } = value as { oscillators?: unknown };
  if (!Array.isArray(oscillators)) {
    return false;
  }
  return oscillators.every((group: unknown) => {
    if (typeof group !== 'object' || group === null) {
      return false;
    }
    const { osc, ampEnv } = group as {
      osc?: Record<string, unknown>;
      ampEnv?: Record<string, unknown>;
    };
    if (
      typeof osc !== 'object' ||
      osc === null ||
      typeof ampEnv !== 'object' ||
      ampEnv === null
    ) {
      return false;
    }
    return (
      typeof osc.on === 'boolean' &&
      isFiniteNumber(osc.freqBase) &&
      isFiniteNumber(osc.freqStart) &&
      isFiniteNumber(osc.slope) &&
      isFiniteNumber(osc.duration) &&
      isFiniteNumber(osc.phase) &&
      isFiniteNumber(ampEnv.startLevel) &&
      isFiniteNumber(ampEnv.slope) &&
      isFiniteNumber(ampEnv.duration) &&
      (ampEnv.endLevel === undefined ||
        isFiniteNumber(ampEnv.endLevel))
    );
  });
}

/**
 * Разбирает аргументы командной строки в {@link CliArgs}.
 * `--dataset` обязателен, `--out` по умолчанию совпадает с ним.
 */
function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dataset: '', out: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for argument: ${key}`);
    }
    switch (key) {
      case '--dataset':
        args.dataset = value;
        break;
      case '--out':
        args.out = value;
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (args.dataset === '') {
    throw new Error(
      'Usage: npx tsx src/dataset/extract-features.ts ' +
        '--dataset <dir> [--out <dir>]',
    );
  }
  if (args.out === '') {
    args.out = args.dataset;
  }
  return args;
}

/**
 * Читает run.json и извлекает нужные поля с защитой от мусора:
 * нечисловые метрики заменяет на null, отсутствующий seed — на
 * номер из имени каталога. Возвращает null, если файл битый.
 */
async function readRunRecord(
  runDir: string,
  fallbackSeed: number,
): Promise<{
  status: string;
  target: string;
  seed: number;
  suppressionPercent: number | null;
  globalSuppressionPercent: number | null;
} | null> {
  const raw = await readJsonSafe(join(runDir, 'run.json'));
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    status: typeof record.status === 'string' ? record.status : '',
    target: typeof record.target === 'string' ? record.target : '',
    seed: isFiniteNumber(record.seed) ? record.seed : fallbackSeed,
    suppressionPercent: isFiniteNumber(record.suppressionPercent)
      ? record.suppressionPercent
      : null,
    globalSuppressionPercent: isFiniteNumber(
      record.globalSuppressionPercent,
    )
      ? record.globalSuppressionPercent
      : null,
  };
}

/**
 * Точка входа: обходит дерево датасета в отсортированном порядке,
 * пишет features.json каждого completed-прогона и сводный
 * features.csv. Битые артефакты пропускает с предупреждениями.
 */
async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const datasetDir = resolve(args.dataset);
  const outDir = resolve(args.out);
  if (!existsSync(datasetDir)) {
    throw new Error(`Dataset directory not found: ${datasetDir}`);
  }

  const slugNames = (
    await readdir(datasetDir, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        !name.startsWith('.') &&
        resolve(join(datasetDir, name)) !== outDir,
    )
    .sort();

  const csvRows: FeaturesCsvRow[] = [];
  let runsProcessed = 0;
  let runsSkipped = 0;
  let oscillatorsTotal = 0;

  for (const slug of slugNames) {
    const targetDir = join(datasetDir, slug);
    const initVector = await readJsonSafe(
      join(targetDir, 'init-vector.json'),
    );
    if (!isNumberArray(initVector)) {
      console.warn(
        `WARN ${slug}: init-vector.json missing or invalid, ` +
          'target skipped',
      );
      continue;
    }

    const runDirNames = (
      await readdir(targetDir, { withFileTypes: true })
    )
      .filter(
        (entry) =>
          entry.isDirectory() && /^seed-\d+$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort(
        (a, b) =>
          Number(a.slice('seed-'.length)) -
          Number(b.slice('seed-'.length)),
      );

    for (const runDirName of runDirNames) {
      const runDir = join(targetDir, runDirName);
      const fallbackSeed = Number(runDirName.slice('seed-'.length));
      const record = await readRunRecord(runDir, fallbackSeed);
      if (record === null) {
        console.warn(
          `WARN ${slug}/${runDirName}: broken run.json, skipped`,
        );
        runsSkipped += 1;
        continue;
      }
      if (record.status !== 'completed') {
        continue;
      }
      const patch = await readJsonSafe(join(runDir, 'patch.json'));
      if (!isValidPatch(patch)) {
        console.warn(
          `WARN ${slug}/${runDirName}: broken patch.json, skipped`,
        );
        runsSkipped += 1;
        continue;
      }

      const features = buildRunFeatures({
        target: record.target === '' ? slug : record.target,
        slug,
        seed: record.seed,
        suppressionPercent: record.suppressionPercent,
        globalSuppressionPercent: record.globalSuppressionPercent,
        patch,
        initVector,
      });
      const outRunDir = join(outDir, slug, runDirName);
      await mkdir(outRunDir, { recursive: true });
      await writeJsonAtomic(
        join(outRunDir, 'features.json'),
        features,
      );
      for (const osc of features.oscillators) {
        csvRows.push(flattenFeaturesRow({ run: features, osc }));
      }
      runsProcessed += 1;
      oscillatorsTotal += features.oscillators.length;
      console.log(
        `OK ${slug}/${runDirName}: ` +
          `${features.oscillators.length} oscillators`,
      );
    }
  }

  await mkdir(outDir, { recursive: true });
  await writeTextAtomic(
    join(outDir, 'features.csv'),
    renderFeaturesCsv(csvRows),
  );
  console.log(
    `SUMMARY runs=${runsProcessed} skipped=${runsSkipped} ` +
      `oscillators=${oscillatorsTotal} rows=${csvRows.length}`,
  );
}

// Запускаем CLI только при прямом вызове: импорт модуля (тесты,
// фикстуры) не должен стартовать обход датасета.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
