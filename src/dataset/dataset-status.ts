/**
 * Сводка прогресса сборки датасета: какие прогоны завершены,
 * какие в работе, какие ещё не начаты, и ETA по средней
 * длительности завершённых. Читает только run.json и manifest.json,
 * запущенный батч не трогает.
 *
 * Запуск:
 *   npx tsx src/dataset/dataset-status.ts --dataset datasets/reference-4
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJsonOrNull } from './shared';

/** Срез run.json для сводки. */
interface RunSlice {
  status: string;
  seed: number;
  durationSec: number;
  globalSuppressionPercent: number | null;
  error: string | null;
}

/** Срез manifest.json для расчёта общего числа прогонов. */
interface ManifestSlice {
  targets: string[];
  seeds: number[];
}

/** Одна строка сводки по таргету. */
interface TargetStatus {
  slug: string;
  completed: number[];
  failed: number[];
}

/** Перечисляет каталоги таргетов в датасете, отсортированно. */
function listSlugDirs(datasetDir: string): string[] {
  return readdirSync(datasetDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Перечисляет номера сидов существующих каталогов прогонов. */
function listSeedDirs(slugDir: string): number[] {
  return readdirSync(slugDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^seed-\d+$/.test(d.name))
    .map((d) => Number(d.name.slice('seed-'.length)))
    .sort((a, b) => a - b);
}

/** Собирает статусы всех прогонов датасета и их длительности. */
async function collectStatus(arg: {
  datasetDir: string;
  slugs: string[];
  expectedSeeds: number[];
}): Promise<{ targets: TargetStatus[]; durations: number[] }> {
  const targets: TargetStatus[] = [];
  const durations: number[] = [];

  for (const slug of arg.slugs) {
    const slugDir = join(arg.datasetDir, slug);
    const status: TargetStatus = { slug, completed: [], failed: [] };
    for (const seed of arg.expectedSeeds) {
      const run = await readJsonOrNull<RunSlice>(
        join(slugDir, `seed-${seed}`, 'run.json'),
      );
      if (run === null) {
        continue;
      }
      if (run.status === 'completed') {
        status.completed.push(seed);
        durations.push(run.durationSec);
      } else if (run.status === 'failed') {
        status.failed.push(seed);
      }
    }
    targets.push(status);
  }
  return { targets, durations };
}

/** Печатает строку статуса одного таргета. */
function printTargetLine(
  status: TargetStatus,
  expectedSeeds: number[],
): void {
  const cells = expectedSeeds.map((seed) => {
    if (status.completed.includes(seed)) {
      return 'done';
    }
    if (status.failed.includes(seed)) {
      return 'FAIL';
    }
    return '....';
  });
  console.log(`  ${status.slug.padEnd(48)} ${cells.join('  ')}`);
}

/** Точка входа: печатает таблицу статусов и ETA. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const datasetIdx = argv.indexOf('--dataset');
  const datasetArg =
    datasetIdx >= 0 ? argv[datasetIdx + 1] : undefined;
  if (datasetArg === undefined) {
    throw new Error('Usage: --dataset <dir>');
  }
  const datasetDir = resolve(datasetArg);

  const manifest = await readJsonOrNull<ManifestSlice>(
    join(datasetDir, 'manifest.json'),
  );
  const expectedSeeds = manifest?.seeds ?? [1, 2, 3, 4];
  const slugs = listSlugDirs(datasetDir);

  console.log(`Датасет: ${datasetDir}`);
  console.log(
    `  ${'таргет'.padEnd(48)} ${expectedSeeds.map((s) => `s${s}`.padStart(4)).join('  ')}`,
  );
  const { targets, durations } = await collectStatus({
    datasetDir,
    slugs,
    expectedSeeds,
  });
  for (const target of targets) {
    printTargetLine(target, expectedSeeds);
  }

  const totalRuns = slugs.length * expectedSeeds.length;
  const doneRuns = durations.length;
  const failedRuns = targets.reduce(
    (acc, t) => acc + t.failed.length,
    0,
  );
  if (durations.length > 0) {
    const meanSec =
      durations.reduce((a, b) => a + b, 0) / durations.length;
    const remaining = totalRuns - doneRuns - failedRuns;
    const etaHours = (remaining * meanSec) / 3600;
    console.log(
      `SUMMARY done=${doneRuns}/${totalRuns} failed=${failedRuns} ` +
        `mean=${(meanSec / 60).toFixed(1)}m/run ` +
        `eta≈${etaHours.toFixed(1)}h (serial estimate)`,
    );
  } else {
    console.log(
      `SUMMARY done=0/${totalRuns} failed=${failedRuns}: ` +
        'ETA появится после первого завершённого прогона',
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
