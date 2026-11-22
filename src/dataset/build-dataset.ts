/**
 * Батч-сборщик датасета стабильности (этап 1 плана
 * `docs/plan-kick-enhancement.md`): прогоняет каждый WAV из
 * директории таргетов с каждым сидом и складывает артефакты
 * прогонов в дерево каталогов.
 *
 * Переобучение на новом наборе — тот же запуск с другой
 * директорией: завершённые прогоны пропускаются (resume),
 * недостающие досчитываются.
 *
 * Запуск:
 *   npx tsx src/dataset/build-dataset.ts \
 *     --targets targets --out datasets/reference-4 \
 *     --iterations 300 --seeds 1,2,3,4 --oscillators 50 --parallel 2
 *   Необязательный `--attack-boost N` усиливает окна первых 10 мс;
 *   по умолчанию 1, то есть обычный match не меняется.
 *
 * Живой прогресс в чате:
 *   ... 2>&1 | grep --line-buffered -E 'INIT|RUN|PROGRESS|DONE|FAIL|SKIP|SUMMARY'
 *
 * Раскладка артефактов:
 *   <out>/manifest.json                    — конфигурация сборки
 *   <out>/<slug>/init-vector.json          — init-вектор (общий для всех сидов)
 *   <out>/<slug>/seed-<N>/run.json         — метаданные + история прогресса
 *   <out>/<slug>/seed-<N>/patch.json       — ArgCreateSynth
 *   <out>/<slug>/seed-<N>/result.wav
 *   <out>/<slug>/seed-<N>/worker.log       — логи оптимизатора
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  type WriteStream,
} from 'node:fs';
import { copyFile, unlink } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAMPLE_RATE } from '../consts';
import { dualWindowInitVector } from '../dual-window-init-vector';
import {
  matchWithWorker,
  type MatchWorkerProgress,
  type MatchWorkerResult,
} from '../match-worker';
import { readWav } from '../read-wav';
import type { PhaseModel } from '../synth';
import { readJsonOrNull, writeJsonAtomic } from './shared';

/** Аргументы командной строки сборщика. */
interface CliArgs {
  targets: string;
  out: string;
  iterations: number;
  seeds: number[];
  oscillators: number;
  parallel: number;
  /** Модель фазы синтеза; по умолчанию legacy, как у прежних сборок. */
  phase: PhaseModel;
  /** Вес окон атаки; 1 сохраняет обычную метрику. */
  attackBoost: number;
  only?: string;
}

/** Один прогон датасета: таргет × сид. */
interface RunTask {
  targetFile: string;
  targetPath: string;
  slug: string;
  seed: number;
  runDir: string;
  /** Номер итерации чекпоинта, с которого поднимаемся; нет — с нуля. */
  resumedFromIteration?: number;
}

/** Содержимое `run.json` — главный метаданный артефакт прогона. */
interface RunRecord {
  status: 'completed' | 'failed';
  target: string;
  seed: number;
  maxIterations: number;
  numOscillators: number;
  /** Вес атаки, записанный в каждый прогон для воспроизводимости. */
  attackBoost: number;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  suppressionPercent: number | null;
  globalSuppressionPercent: number | null;
  targetInfo: MatchWorkerResult['targetInfo'] | null;
  error: string | null;
  /** Итерация чекпоинта, с которой прогон подняли; null — шёл с нуля. */
  resumedFromIteration: number | null;
  history: { iteration: number; suppressionPercent: number }[];
}

/** Манифест сборки: конфигурация, платформа и версия кода. */
interface DatasetManifest {
  createdAt: string;
  finishedAt: string | null;
  targetsDir: string;
  targets: string[];
  seeds: number[];
  maxIterations: number;
  numOscillators: number;
  /** Модель фазы, на которой собран датасет: смешивать нельзя. */
  phaseModel: PhaseModel;
  /** Вес окон атаки; 1 соответствует обычному match. */
  attackBoost: number;
  codeRevision: string | null;
  platform: string;
  nodeVersion: string;
}

/** Сводка пула прогонов: сколько завершилось, упало, пропущено. */
interface PoolSummary {
  completed: number;
  failed: number;
  skipped: number;
}

/** Частота строк прогресса в логе: одна строка на столько итераций. */
const PROGRESS_LOG_EVERY = 25;

/**
 * Разбирает аргументы командной строки и применяет значения по
 * умолчанию, включая нейтральный `--attack-boost 1`.
 *
 * @param argv - Пары «ключ — значение» без пути к скрипту
 * @returns Аргументы сборки датасета
 * @throws Error если ключ неизвестен, значение отсутствует или
 *   числовой параметр не проходит проверку
 */
function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    targets: 'targets',
    out: 'datasets/default',
    iterations: 400,
    seeds: [1, 2, 3, 4],
    oscillators: 50,
    parallel: Math.max(1, cpus().length),
    phase: 'legacy',
    attackBoost: 1,
  };

  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for argument: ${key}`);
    }
    switch (key) {
      case '--targets':
        args.targets = value;
        break;
      case '--out':
        args.out = value;
        break;
      case '--iterations':
        args.iterations = parsePositiveInt(key, value);
        break;
      case '--seeds':
        args.seeds = value
          .split(',')
          .map((s) => parsePositiveInt('--seeds', s.trim()));
        break;
      case '--oscillators':
        args.oscillators = parsePositiveInt(key, value);
        break;
      case '--phase':
        if (value !== 'legacy' && value !== 'integral') {
          throw new Error('--phase must be legacy or integral');
        }
        args.phase = value;
        break;
      case '--parallel':
        args.parallel = parsePositiveInt(key, value);
        break;
      case '--attack-boost':
        args.attackBoost = parsePositiveInt(key, value);
        break;
      case '--only':
        args.only = value.toLowerCase();
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (args.oscillators < 1 || args.oscillators > 50) {
    throw new Error('--oscillators must be between 1 and 50');
  }
  return args;
}

/**
 * Парсит положительное целое; бросает понятную ошибку с именем ключа.
 */
function parsePositiveInt(key: string, value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new Error(
      `${key} must be a positive integer, got: ${value}`,
    );
  }
  return n;
}

/**
 * Перечисляет WAV-файлы таргетов: фильтрует по расширению и
 * подстроке `--only`, сортирует для детерминированного обхода.
 */
function listTargetFiles(
  targetsDir: string,
  only?: string,
): string[] {
  const files = readdirSync(targetsDir)
    .filter((f) => f.toLowerCase().endsWith('.wav'))
    .filter((f) =>
      only === undefined ? true : f.toLowerCase().includes(only),
    )
    .sort();
  if (files.length === 0) {
    throw new Error(`No WAV targets found in ${targetsDir}`);
  }
  return files;
}

/**
 * Переводит имена WAV-файлов в безопасные slug'и каталогов.
 * Коллизии после очистки разрешает суффиксами `-2`, `-3`, …
 */
function slugifyTargets(files: string[]): Map<string, string> {
  const slugs = new Map<string, string>();
  for (const file of files) {
    const base = file
      .replace(/\.wav$/i, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    let slug = base || 'target';
    for (let n = 2; [...slugs.values()].includes(slug); n += 1) {
      slug = `${base}-${n}`;
    }
    slugs.set(file, slug);
  }
  return slugs;
}

/** Читает ревизию кода из git; при недоступности git — null. */
function readCodeRevision(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Собирает манифест сборки и сохраняет в нём вес атаки.
 *
 * @param args - Аргументы командной строки
 * @param targetsDir - Абсолютный путь к каталогу таргетов
 * @param files - Имена WAV-файлов, вошедших в сборку
 * @returns Манифест с параметрами прогонов и версией кода
 */
function buildManifest(
  args: CliArgs,
  targetsDir: string,
  files: string[],
): DatasetManifest {
  return {
    createdAt: new Date().toISOString(),
    finishedAt: null,
    targetsDir,
    targets: files,
    seeds: args.seeds,
    maxIterations: args.iterations,
    numOscillators: args.oscillators,
    phaseModel: args.phase,
    attackBoost: args.attackBoost,
    codeRevision: readCodeRevision(),
    platform: process.platform,
    nodeVersion: process.version,
  };
}

/**
 * Проверяет, завершён ли прогон: `run.json` существует, читается
 * и содержит `status: "completed"`. Битый или чужой файл считаем
 * незавершённым прогоном и пересчитываем.
 */
async function isRunCompleted(runDir: string): Promise<boolean> {
  const runPath = join(runDir, 'run.json');
  const record = await readJsonOrNull<Partial<RunRecord>>(runPath);
  return record?.status === 'completed';
}

/**
 * Строит init-вектор таргета и сохраняет его в каталог таргета.
 * Init детерминирован по таргету, поэтому считаем один раз на
 * таргет, а не на прогон.
 */
async function computeAndSaveInitVector(arg: {
  targetPath: string;
  targetDir: string;
  slug: string;
  oscillators: number;
}): Promise<number[]> {
  const wav = readWav(arg.targetPath);
  if (wav.sampleRate !== SAMPLE_RATE) {
    throw new Error(
      `${arg.slug}: sample rate ${wav.sampleRate} != ${SAMPLE_RATE}`,
    );
  }
  const initVector = dualWindowInitVector(
    wav.samples,
    SAMPLE_RATE,
    arg.oscillators,
  );
  await writeJsonAtomic(
    join(arg.targetDir, 'init-vector.json'),
    initVector,
  );
  console.log(`INIT ${arg.slug}: ${initVector.length} values`);
  return initVector;
}

/**
 * Готовит init-векторы всех таргетов: читает сохранённые, недостающие
 * считает. Возвращает карту slug → вектор.
 */
async function prepareInitVectors(arg: {
  files: string[];
  slugs: Map<string, string>;
  targetsDir: string;
  outDir: string;
  oscillators: number;
}): Promise<Map<string, number[]>> {
  const initVectors = new Map<string, number[]>();
  for (const file of arg.files) {
    const slug = arg.slugs.get(file) ?? file;
    const targetDir = join(arg.outDir, slug);
    mkdirSync(targetDir, { recursive: true });
    const initPath = join(targetDir, 'init-vector.json');
    const saved = await readJsonOrNull<number[]>(initPath);
    if (saved !== null) {
      initVectors.set(slug, saved);
      console.log(`INIT ${slug}: reused saved vector`);
      continue;
    }
    const vector = await computeAndSaveInitVector({
      targetPath: join(arg.targetsDir, file),
      targetDir,
      slug,
      oscillators: arg.oscillators,
    });
    initVectors.set(slug, vector);
  }
  return initVectors;
}

/** Строит список прогонов: каждый таргет с каждым сидом. */
function buildRunTasks(arg: {
  files: string[];
  slugs: Map<string, string>;
  seeds: number[];
  targetsDir: string;
  outDir: string;
}): RunTask[] {
  const tasks: RunTask[] = [];
  for (const file of arg.files) {
    const slug = arg.slugs.get(file) ?? file;
    for (const seed of arg.seeds) {
      tasks.push({
        targetFile: file,
        targetPath: join(arg.targetsDir, file),
        slug,
        seed,
        runDir: join(arg.outDir, slug, `seed-${seed}`),
      });
    }
  }
  return tasks;
}

/**
 * Возвращает колбэк прогресса: печатает строку раз в
 * {@link PROGRESS_LOG_EVERY} итераций и пишет checkpoint.json с
 * лучшим геномом — убийство процесса стоит минуты, а не часы
 * (T12). Запись fire-and-forget: её ошибка не роняет оптимизацию.
 */
function createProgressHandler(arg: {
  slug: string;
  seed: number;
  iterations: number;
  runDir: string;
}): (entry: MatchWorkerProgress) => void {
  return (entry) => {
    if (entry.iteration % PROGRESS_LOG_EVERY !== 0) {
      return;
    }
    console.log(
      `PROGRESS ${arg.slug} seed=${arg.seed} ` +
        `iter=${entry.iteration}/${arg.iterations} ` +
        `J=${entry.suppressionPercent.toFixed(2)}%`,
    );
    if (entry.bestVector !== undefined) {
      const checkpoint = {
        iteration: entry.iteration,
        bestVector: [...entry.bestVector],
      };
      void writeJsonAtomic(
        join(arg.runDir, 'checkpoint.json'),
        checkpoint,
      ).catch(() => {});
    }
  };
}

/** Читает чекпоинт прогона; при отсутствии или битом файле — null. */
async function readCheckpoint(
  runDir: string,
): Promise<{ iteration: number; bestVector: number[] } | null> {
  const data = await readJsonOrNull<{
    iteration?: unknown;
    bestVector?: unknown;
  }>(join(runDir, 'checkpoint.json'));
  if (
    data === null ||
    typeof data.iteration !== 'number' ||
    !Array.isArray(data.bestVector) ||
    data.bestVector.length === 0
  ) {
    return null;
  }
  return {
    iteration: data.iteration,
    bestVector: data.bestVector as number[],
  };
}

/**
 * Собирает запись `run.json` и фиксирует вес атаки в каждом прогоне.
 *
 * @param arg - Статус, задача, аргументы сборки, время и результат
 *   либо текст ошибки
 * @returns Для завершённого прогона — обе метрики, `targetInfo` и
 *   история, для упавшего — `null` в полях результата, текст ошибки
 *   и пустая история
 */
function buildRunRecord(arg: {
  status: 'completed' | 'failed';
  task: RunTask;
  args: CliArgs;
  startedAt: Date;
  durationSec: number;
  result?: MatchWorkerResult;
  error?: string;
}): RunRecord {
  const base = {
    status: arg.status,
    target: arg.task.targetFile,
    seed: arg.task.seed,
    maxIterations: arg.args.iterations,
    numOscillators: arg.args.oscillators,
    attackBoost: arg.args.attackBoost,
    startedAt: arg.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationSec: arg.durationSec,
    resumedFromIteration: arg.task.resumedFromIteration ?? null,
  };
  if (arg.status === 'completed' && arg.result !== undefined) {
    return {
      ...base,
      suppressionPercent: arg.result.suppressionPercent,
      globalSuppressionPercent: arg.result.globalSuppressionPercent,
      targetInfo: arg.result.targetInfo,
      error: null,
      history: arg.result.history.map((h) => ({
        iteration: h.iteration,
        suppressionPercent: h.suppressionPercent,
      })),
    };
  }
  return {
    ...base,
    suppressionPercent: null,
    globalSuppressionPercent: null,
    targetInfo: null,
    error: arg.error ?? 'unknown error',
    history: [],
  };
}

/**
 * Сохраняет артефакты успешного прогона: patch.json, run.json и
 * result.wav (переносит из временного пути), затем логирует DONE.
 */
async function persistSuccessArtifacts(arg: {
  task: RunTask;
  result: MatchWorkerResult;
  record: RunRecord;
  tempOutput: string;
}): Promise<void> {
  await writeJsonAtomic(
    join(arg.task.runDir, 'patch.json'),
    arg.result.synthConfig,
  );
  await writeJsonAtomic(
    join(arg.task.runDir, 'run.json'),
    arg.record,
  );
  await copyFile(arg.tempOutput, join(arg.task.runDir, 'result.wav'));
  console.log(
    `DONE ${arg.task.slug} seed=${arg.task.seed} ` +
      `global=${(arg.result.globalSuppressionPercent ?? NaN).toFixed(2)}% ` +
      `J=${arg.result.suppressionPercent.toFixed(2)}% ` +
      `dur=${arg.record.durationSec.toFixed(0)}s`,
  );
}

/** Сохраняет failed-запись упавшего прогона и логирует FAIL. */
async function persistFailureRecord(arg: {
  task: RunTask;
  record: RunRecord;
}): Promise<void> {
  await writeJsonAtomic(
    join(arg.task.runDir, 'run.json'),
    arg.record,
  );
  console.log(
    `FAIL ${arg.task.slug} seed=${arg.task.seed}: ${arg.record.error}`,
  );
}

/**
 * Выполняет один прогон в worker-потоке и сохраняет его артефакты.
 *
 * @param task - Таргет, сид и каталог прогона
 * @param initVector - Начальный вектор или геном из чекпоинта
 * @param args - Параметры оптимизации, включая вес атаки для worker
 * @returns Итоговый статус прогона
 * @remarks Ошибка оптимизации не роняет сборку: функция пишет
 *   failed-запись и возвращает `failed`, чтобы пул шёл дальше.
 */
async function runSingleTask(
  task: RunTask,
  initVector: number[],
  args: CliArgs,
): Promise<'completed' | 'failed'> {
  const startedAt = new Date();
  const startedMs = Date.now();
  const tempOutput = join(tmpdir(), `${randomUUID()}_result.wav`);
  const logStream: WriteStream = createWriteStream(
    join(task.runDir, 'worker.log'),
  );
  console.log(`RUN ${task.slug} seed=${task.seed}`);

  try {
    const result = await matchWithWorker({
      targetWavPath: task.targetPath,
      outputWavPath: tempOutput,
      initialVector: initVector,
      sampleRate: SAMPLE_RATE,
      maxIterations: args.iterations,
      seed: task.seed,
      phaseModel: args.phase,
      attackBoost: args.attackBoost,
      onLog: (line) => {
        logStream.write(line + '\n');
      },
      onProgress: createProgressHandler({
        slug: task.slug,
        seed: task.seed,
        iterations: args.iterations,
        runDir: task.runDir,
      }),
    });
    const record = buildRunRecord({
      status: 'completed',
      task,
      args,
      startedAt,
      durationSec: (Date.now() - startedMs) / 1000,
      result,
    });
    await persistSuccessArtifacts({
      task,
      result,
      record,
      tempOutput,
    });
    return 'completed';
  } catch (error) {
    const record = buildRunRecord({
      status: 'failed',
      task,
      args,
      startedAt,
      durationSec: (Date.now() - startedMs) / 1000,
      error: error instanceof Error ? error.message : String(error),
    });
    await persistFailureRecord({ task, record });
    return 'failed';
  } finally {
    logStream.end();
    await unlink(tempOutput).catch(() => {});
  }
}

/**
 * Гоняет прогоны пулом в `parallel` worker'ов: курсор по списку
 * задач, завершённые пропускает (resume), считает итоги.
 */
async function runTaskPool(arg: {
  tasks: RunTask[];
  parallel: number;
  args: CliArgs;
  initVectors: Map<string, number[]>;
}): Promise<PoolSummary> {
  const summary: PoolSummary = {
    completed: 0,
    failed: 0,
    skipped: 0,
  };
  let next = 0;

  const workers = Array.from({ length: arg.parallel }, async () => {
    for (;;) {
      const task = arg.tasks[next];
      next += 1;
      if (task === undefined) {
        return;
      }
      mkdirSync(task.runDir, { recursive: true });
      if (await isRunCompleted(task.runDir)) {
        summary.skipped += 1;
        console.log(`SKIP ${task.slug} seed=${task.seed}: done`);
        continue;
      }
      const checkpoint = await readCheckpoint(task.runDir);
      if (checkpoint !== null) {
        console.log(
          `RESUME ${task.slug} seed=${task.seed} ` +
            `from iter=${checkpoint.iteration}`,
        );
      }
      const initVector =
        checkpoint?.bestVector ?? arg.initVectors.get(task.slug);
      if (initVector === undefined) {
        summary.failed += 1;
        console.log(`FAIL ${task.slug}: no init vector`);
        continue;
      }
      const status = await runSingleTask(
        { ...task, resumedFromIteration: checkpoint?.iteration },
        initVector,
        arg.args,
      );
      if (status === 'completed') {
        summary.completed += 1;
      } else {
        summary.failed += 1;
      }
    }
  });
  await Promise.all(workers);
  return summary;
}

/**
 * Завершает сборку: проставляет finishedAt в манифесте, печатает
 * сводку и помечает процесс упавшим, если были failed-прогоны.
 */
async function finalizeBuild(arg: {
  outDir: string;
  manifest: DatasetManifest;
  summary: PoolSummary;
  wallStartMs: number;
}): Promise<void> {
  arg.manifest.finishedAt = new Date().toISOString();
  await writeJsonAtomic(
    join(arg.outDir, 'manifest.json'),
    arg.manifest,
  );
  const wallMin = (Date.now() - arg.wallStartMs) / 60000;
  console.log(
    `SUMMARY done=${arg.summary.completed} ` +
      `failed=${arg.summary.failed} skipped=${arg.summary.skipped} ` +
      `wall=${wallMin.toFixed(1)}m`,
  );
  if (arg.summary.failed > 0) {
    process.exitCode = 1;
  }
}

/**
 * Точка входа: читает таргеты, готовит init-векторы, гоняет прогоны
 * пулом, пишет манифест и сводку.
 */
async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const targetsDir = resolve(args.targets);
  const outDir = resolve(args.out);

  const files = listTargetFiles(targetsDir, args.only);
  const slugs = slugifyTargets(files);
  mkdirSync(outDir, { recursive: true });

  const manifest = buildManifest(args, targetsDir, files);
  await writeJsonAtomic(join(outDir, 'manifest.json'), manifest);

  const initVectors = await prepareInitVectors({
    files,
    slugs,
    targetsDir,
    outDir,
    oscillators: args.oscillators,
  });
  const tasks = buildRunTasks({
    files,
    slugs,
    seeds: args.seeds,
    targetsDir,
    outDir,
  });

  const wallStartMs = Date.now();
  const summary = await runTaskPool({
    tasks,
    parallel: args.parallel,
    args,
    initVectors,
  });
  await finalizeBuild({ outDir, manifest, summary, wallStartMs });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
