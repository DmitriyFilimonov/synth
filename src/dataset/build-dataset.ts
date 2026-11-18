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
 *     --iterations 400 --seeds 1,2,3,4 --oscillators 50 --parallel 2
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
  existsSync,
  mkdirSync,
  readdirSync,
  type WriteStream,
} from 'node:fs';
import {
  copyFile,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAMPLE_RATE } from '../consts';
import { dualWindowInitVector } from '../dual-window-init-vector';
import { matchWithWorker } from '../match-worker';
import { readWav } from '../read-wav';

/** Аргументы командной строки сборщика. */
interface CliArgs {
  targets: string;
  out: string;
  iterations: number;
  seeds: number[];
  oscillators: number;
  parallel: number;
  only?: string;
}

/** Один прогон датасета: таргет × сид. */
interface RunTask {
  targetFile: string;
  targetPath: string;
  slug: string;
  seed: number;
  runDir: string;
}

/** Содержимое `run.json` — главный метаданный артефакт прогона. */
interface RunRecord {
  status: 'completed' | 'failed';
  target: string;
  seed: number;
  maxIterations: number;
  numOscillators: number;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  suppressionPercent: number | null;
  globalSuppressionPercent: number | null;
  error: string | null;
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
  codeRevision: string | null;
  platform: string;
  nodeVersion: string;
}

/** Частота строк прогресса в логе: одна строка на столько итераций. */
const PROGRESS_LOG_EVERY = 25;

/**
 * Разбирает аргументы командной строки в {@link CliArgs}.
 * Неизвестный ключ или отсутствующее значение — ошибка с подсказкой.
 */
function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    targets: 'targets',
    out: 'datasets/default',
    iterations: 400,
    seeds: [1, 2, 3, 4],
    oscillators: 50,
    parallel: Math.max(1, cpus().length),
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
      case '--parallel':
        args.parallel = parsePositiveInt(key, value);
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

/** Пишет JSON атомарно: временный файл + rename. */
async function writeJsonAtomic(
  path: string,
  data: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
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
 * Проверяет, завершён ли прогон: `run.json` существует, читается
 * и содержит `status: "completed"`. Битый или чужой файл считаем
 * незавершённым прогоном и пересчитываем.
 */
async function isRunCompleted(runDir: string): Promise<boolean> {
  const runPath = join(runDir, 'run.json');
  if (!existsSync(runPath)) {
    return false;
  }
  try {
    const raw = await readFile(runPath, 'utf8');
    const record = JSON.parse(raw) as Partial<RunRecord>;
    return record.status === 'completed';
  } catch {
    return false;
  }
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
 * Выполняет один прогон: оптимизация в worker-потоке с заданным
 * сидом, затем атомарная запись patch.json, run.json и result.wav.
 * Ошибка прогона не роняет сборку: пишем failed-запись и идём дальше.
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
      onLog: (line) => {
        logStream.write(line + '\n');
      },
      onProgress: (entry) => {
        if (entry.iteration % PROGRESS_LOG_EVERY === 0) {
          console.log(
            `PROGRESS ${task.slug} seed=${task.seed} ` +
              `iter=${entry.iteration}/${args.iterations} ` +
              `J=${entry.suppressionPercent.toFixed(2)}%`,
          );
        }
      },
    });

    const durationSec = (Date.now() - startedMs) / 1000;
    await writeJsonAtomic(
      join(task.runDir, 'patch.json'),
      result.synthConfig,
    );
    const record: RunRecord = {
      status: 'completed',
      target: task.targetFile,
      seed: task.seed,
      maxIterations: args.iterations,
      numOscillators: args.oscillators,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationSec,
      suppressionPercent: result.suppressionPercent,
      globalSuppressionPercent: result.globalSuppressionPercent,
      error: null,
      history: result.history.map((h) => ({
        iteration: h.iteration,
        suppressionPercent: h.suppressionPercent,
      })),
    };
    await writeJsonAtomic(join(task.runDir, 'run.json'), record);
    await copyFile(tempOutput, join(task.runDir, 'result.wav'));
    console.log(
      `DONE ${task.slug} seed=${task.seed} ` +
        `global=${(result.globalSuppressionPercent ?? NaN).toFixed(2)}% ` +
        `J=${result.suppressionPercent.toFixed(2)}% ` +
        `dur=${durationSec.toFixed(0)}s`,
    );
    return 'completed';
  } catch (error) {
    const durationSec = (Date.now() - startedMs) / 1000;
    const message =
      error instanceof Error ? error.message : String(error);
    const record: RunRecord = {
      status: 'failed',
      target: task.targetFile,
      seed: task.seed,
      maxIterations: args.iterations,
      numOscillators: args.oscillators,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationSec,
      suppressionPercent: null,
      globalSuppressionPercent: null,
      error: message,
      history: [],
    };
    await writeJsonAtomic(join(task.runDir, 'run.json'), record);
    console.log(`FAIL ${task.slug} seed=${task.seed}: ${message}`);
    return 'failed';
  } finally {
    logStream.end();
    await unlink(tempOutput).catch(() => {});
  }
}

/**
 * Точка входа: читает таргеты, считает init-векторы, гоняет прогоны
 * пулом в `--parallel` worker'ов, пишет manifest и сводку.
 */
async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const targetsDir = resolve(args.targets);
  const outDir = resolve(args.out);

  const files = readdirSync(targetsDir)
    .filter((f) => f.toLowerCase().endsWith('.wav'))
    .filter((f) =>
      args.only === undefined
        ? true
        : f.toLowerCase().includes(args.only),
    )
    .sort();
  if (files.length === 0) {
    throw new Error(`No WAV targets found in ${targetsDir}`);
  }

  const slugs = slugifyTargets(files);
  mkdirSync(outDir, { recursive: true });

  const manifest: DatasetManifest = {
    createdAt: new Date().toISOString(),
    finishedAt: null,
    targetsDir,
    targets: files,
    seeds: args.seeds,
    maxIterations: args.iterations,
    numOscillators: args.oscillators,
    codeRevision: readCodeRevision(),
    platform: process.platform,
    nodeVersion: process.version,
  };
  await writeJsonAtomic(join(outDir, 'manifest.json'), manifest);

  const initVectors = new Map<string, number[]>();
  for (const file of files) {
    const slug = slugs.get(file) ?? file;
    const targetDir = join(outDir, slug);
    mkdirSync(targetDir, { recursive: true });
    const initPath = join(targetDir, 'init-vector.json');
    if (existsSync(initPath)) {
      const raw = await readFile(initPath, 'utf8');
      initVectors.set(slug, JSON.parse(raw) as number[]);
      console.log(`INIT ${slug}: reused saved vector`);
    } else {
      const vector = await computeAndSaveInitVector({
        targetPath: join(targetsDir, file),
        targetDir,
        slug,
        oscillators: args.oscillators,
      });
      initVectors.set(slug, vector);
    }
  }

  const tasks: RunTask[] = [];
  for (const file of files) {
    const slug = slugs.get(file) ?? file;
    for (const seed of args.seeds) {
      tasks.push({
        targetFile: file,
        targetPath: join(targetsDir, file),
        slug,
        seed,
        runDir: join(outDir, slug, `seed-${seed}`),
      });
    }
  }

  const wallStartMs = Date.now();
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let next = 0;

  const pool = Array.from({ length: args.parallel }, async () => {
    for (;;) {
      const task = tasks[next];
      next += 1;
      if (task === undefined) {
        return;
      }
      mkdirSync(task.runDir, { recursive: true });
      if (await isRunCompleted(task.runDir)) {
        skipped += 1;
        console.log(`SKIP ${task.slug} seed=${task.seed}: done`);
        continue;
      }
      const initVector = initVectors.get(task.slug);
      if (initVector === undefined) {
        failed += 1;
        console.log(`FAIL ${task.slug}: no init vector`);
        continue;
      }
      const status = await runSingleTask(task, initVector, args);
      if (status === 'completed') {
        completed += 1;
      } else {
        failed += 1;
      }
    }
  });
  await Promise.all(pool);

  const wallMin = (Date.now() - wallStartMs) / 60000;
  manifest.finishedAt = new Date().toISOString();
  await writeJsonAtomic(join(outDir, 'manifest.json'), manifest);
  console.log(
    `SUMMARY done=${completed} failed=${failed} skipped=${skipped} ` +
      `wall=${wallMin.toFixed(1)}m`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
