/* eslint-disable no-console */
/**
 * Выбирает лучший preserved match-сид по global suppression. Никогда
 * не выбирает introduced/lost и не меняет патч или WAV.
 *
 * npx tsx src/dataset/beat-select.ts --dataset datasets/ref --out datasets/selected
 */
import { mkdirSync } from 'node:fs';
import { copyFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { BeatSeedReport, BeatSeedRun } from './beat-seed-report';
import {
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

/** Кандидат с метаданными исходного match-прогона. */
export interface BeatSelectionCandidate {
  run: BeatSeedRun;
  globalSuppressionPercent: number | null;
}

/** Выбранный артефакт либо честное отсутствие preserved-кандидата. */
export interface BeatSelection {
  slug: string;
  target: string;
  status: 'selected' | 'no-candidate';
  seed: number | null;
  sourceRunDir: string | null;
  patch: string | null;
  wav: string | null;
  globalSuppressionPercent: number | null;
  pairValR2: number | null;
  deltaHz: number | null;
  depth: number | null;
}

interface RunRecord {
  status: string;
  globalSuppressionPercent?: number | null;
}

/**
 * Выбирает максимум global только среди preserved. При равенстве и
 * отсутствии global побеждает меньший сид для воспроизводимости.
 */
export function selectBestPreserved(
  candidates: BeatSelectionCandidate[],
): BeatSelectionCandidate | null {
  const preserved = candidates.filter(
    ({ run }) => run.outcome === 'preserved',
  );
  preserved.sort((a, b) => {
    const globalA = a.globalSuppressionPercent ?? -Infinity;
    const globalB = b.globalSuppressionPercent ?? -Infinity;
    if (globalA !== globalB) {
      return globalB - globalA;
    }
    return a.run.seed - b.run.seed;
  });
  return preserved[0] ?? null;
}

/** Копирует файл как байты и атомарно заменяет целевой путь. */
async function copyFileAtomic(
  source: string,
  destination: string,
): Promise<void> {
  const temporary = `${destination}.tmp`;
  await copyFile(source, temporary);
  await rename(temporary, destination);
}

/** Копирует выбранные артефакты без изменения содержимого. */
export async function saveSelection(arg: {
  candidate: BeatSelectionCandidate | null;
  slug: string;
  target: string;
  outDir: string;
}): Promise<BeatSelection> {
  const { candidate } = arg;
  if (candidate === null) {
    return {
      slug: arg.slug,
      target: arg.target,
      status: 'no-candidate',
      seed: null,
      sourceRunDir: null,
      patch: null,
      wav: null,
      globalSuppressionPercent: null,
      pairValR2: null,
      deltaHz: null,
      depth: null,
    };
  }
  const sourceRunDir = dirname(candidate.run.resultWav);
  const outRunDir = join(arg.outDir, arg.slug);
  mkdirSync(outRunDir, { recursive: true });
  const patchPath = join(outRunDir, 'patch.json');
  const wavPath = join(outRunDir, 'result.wav');
  await copyFileAtomic(join(sourceRunDir, 'patch.json'), patchPath);
  await copyFileAtomic(candidate.run.resultWav, wavPath);
  return {
    slug: arg.slug,
    target: arg.target,
    status: 'selected',
    seed: candidate.run.seed,
    sourceRunDir,
    patch: patchPath,
    wav: wavPath,
    globalSuppressionPercent: candidate.globalSuppressionPercent,
    pairValR2: candidate.run.pairValR2,
    deltaHz: candidate.run.deltaHz,
    depth: candidate.run.depth,
  };
}

/** Строит сводку выбора; no-candidate не маскируется под успех. */
export function renderBeatSelectionMarkdown(
  selections: BeatSelection[],
): string {
  const lines = [
    '# Выбор preserved match-сидов',
    '',
    'В выбор попадают только preserved. Ранжирование идёт по global suppression; introduced и lost исключены. Патчи и WAV копируются без изменений.',
    '',
    '| Таргет | Сид | Global | Val R² | Δf | Глубина | Итог |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const selection of selections) {
    lines.push(
      `| ${selection.slug} | ${selection.seed ?? '—'} | ${selection.globalSuppressionPercent?.toFixed(2) ?? '—'} | ${selection.pairValR2?.toFixed(3) ?? '—'} | ${selection.deltaHz?.toFixed(2) ?? '—'} | ${selection.depth?.toFixed(3) ?? '—'} | ${selection.status} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Читает датасет и сохраняет лучшие preserved-патчи и WAV. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== '--dataset' ||
    args[2] !== '--out'
  ) {
    throw new Error('Usage: beat-select --dataset DIR --out DIR');
  }
  const dataset = resolve(args[1] ?? '');
  const outDir = resolve(args[3] ?? '');
  const report = await readJsonOrNull<BeatSeedReport>(
    join(dataset, 'beat-seed-report.json'),
  );
  if (report === null) {
    throw new Error(`Нет beat-seed-report.json в ${dataset}`);
  }
  const candidates: BeatSelectionCandidate[] = [];
  for (const run of report.runs) {
    const record = await readJsonOrNull<RunRecord>(
      join(dirname(run.resultWav), 'run.json'),
    );
    if (record?.status !== 'completed') {
      continue;
    }
    candidates.push({
      run,
      globalSuppressionPercent:
        record.globalSuppressionPercent ?? null,
    });
  }
  const slugs = [
    ...new Set(candidates.map(({ run }) => run.slug)),
  ].sort();
  const selections: BeatSelection[] = [];
  for (const slug of slugs) {
    const selected = candidates.filter(
      ({ run }) => run.slug === slug,
    );
    const best = selectBestPreserved(selected);
    const target = selected[0]?.run.target ?? slug;
    const selection = await saveSelection({
      candidate: best,
      slug,
      target,
      outDir,
    });
    selections.push(selection);
    console.log(
      `${slug}: ${selection.status}` +
        (selection.seed === null
          ? ''
          : ` seed=${selection.seed} global=${selection.globalSuppressionPercent?.toFixed(2)}`),
    );
  }
  mkdirSync(outDir, { recursive: true });
  await writeJsonAtomic(join(outDir, 'selection.json'), {
    version: 1,
    createdAt: new Date().toISOString(),
    dataset,
    selections,
  });
  await writeTextAtomic(
    join(outDir, 'selection.md'),
    renderBeatSelectionMarkdown(selections),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
