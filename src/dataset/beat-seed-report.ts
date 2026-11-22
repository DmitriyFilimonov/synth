/* eslint-disable no-console */
/**
 * Сравнивает биение в исходных WAV и completed match-прогонах.
 * Отдельно показывает потерю признака и его появление только после
 * синтеза, чтобы не принять одно за другое.
 *
 * Запуск: npx tsx src/dataset/beat-seed-report.ts --dataset datasets/ref
 * Сначала нужен beat-report.json той же модели в корне датасета.
 */
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readWav } from '../read-wav';
import {
  fitDampedBeat,
  measureTrainingF0,
  type DampedBeatFit,
} from './beat-model';
import type { BeatReport } from './beat-report';
import {
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

/** Чем исход match отличается от исходника по правилу биения. */
export type BeatSeedOutcome =
  'preserved' | 'lost' | 'introduced' | 'absent';

/** Измерение одного match-WAV против исходного таргета. */
export interface BeatSeedRun {
  slug: string;
  seed: number;
  target: string;
  resultWav: string;
  originalAccepted: boolean;
  matchAccepted: boolean;
  f0: number | null;
  deltaHz: number | null;
  depth: number | null;
  pairValR2: number | null;
  valGain: number | null;
  rejectionReasons: string[];
  outcome: BeatSeedOutcome;
}

/** Сводка по всем измеренным сидам одного исходника. */
export interface BeatSeedTarget {
  slug: string;
  target: string;
  originalAccepted: boolean;
  seeds: number[];
  acceptedSeeds: number[];
  preserved: number;
  lost: number;
  introduced: number;
  absent: number;
}

/** Полный отчёт; исходы не означают улучшение или ухудшение звука. */
export interface BeatSeedReport {
  version: 1;
  createdAt: string;
  phaseModel: string | null;
  codeRevision: string | null;
  runs: BeatSeedRun[];
  targets: BeatSeedTarget[];
}

interface DatasetManifest {
  targetsDir: string;
  phaseModel?: string;
  codeRevision?: string | null;
}

interface RunRecord {
  status: string;
  target: string;
}

/**
 * Индексирует модели по полному resolved-пути. Одинаковые basename
 * у основного таргета и --extra не заменяют друг друга.
 */
export function buildBeatReferenceMap(
  entries: BeatReport['entries'],
): Map<string, BeatReport['entries'][number]> {
  return new Map(
    entries.map((entry) => [resolve(entry.file), entry] as const),
  );
}

/** Определяет исход только из двух бинарных вердиктов, не из числа осцилляторов. */
export function classifyBeatSeedOutcome(
  originalAccepted: boolean,
  matchAccepted: boolean,
): BeatSeedOutcome {
  if (originalAccepted) {
    return matchAccepted ? 'preserved' : 'lost';
  }
  return matchAccepted ? 'introduced' : 'absent';
}

/**
 * Группирует сиды по исходникам и считает каждый из четырёх исходов.
 * Пустой список даёт пустой отчёт.
 */
export function summarizeBeatSeedRuns(
  runs: BeatSeedRun[],
): BeatSeedTarget[] {
  const slugs = [...new Set(runs.map((run) => run.slug))].sort();
  return slugs.map((slug) => {
    const selected = runs
      .filter((run) => run.slug === slug)
      .sort((a, b) => a.seed - b.seed);
    const first = selected[0];
    const count = (outcome: BeatSeedOutcome): number =>
      selected.filter((run) => run.outcome === outcome).length;
    return {
      slug,
      target: first?.target ?? slug,
      originalAccepted: first?.originalAccepted ?? false,
      seeds: selected.map((run) => run.seed),
      acceptedSeeds: selected
        .filter((run) => run.matchAccepted)
        .map((run) => run.seed),
      preserved: count('preserved'),
      lost: count('lost'),
      introduced: count('introduced'),
      absent: count('absent'),
    };
  });
}

function metric(
  fit: DampedBeatFit | null,
): Pick<
  BeatSeedRun,
  'deltaHz' | 'depth' | 'pairValR2' | 'valGain' | 'rejectionReasons'
> {
  return {
    deltaHz: fit?.deltaHz ?? null,
    depth: fit?.depth ?? null,
    pairValR2: fit?.pairValR2 ?? null,
    valGain: fit?.valGain ?? null,
    rejectionReasons: fit?.rejectionReasons ?? ['no-model'],
  };
}

/**
 * Измеряет один completed match. Незавершённый или нечитаемый
 * run.json пропускает без предупреждения; ошибки чтения и анализа
 * completed-записи печатает как WARN и тоже пропускает.
 */
async function measureRun(arg: {
  slug: string;
  seed: number;
  runDir: string;
  targetsDir: string;
  references: Map<string, BeatReport['entries'][number]>;
}): Promise<BeatSeedRun | null> {
  const record = await readJsonOrNull<RunRecord>(
    join(arg.runDir, 'run.json'),
  );
  if (record?.status !== 'completed') {
    return null;
  }
  try {
    const reference = arg.references.get(
      resolve(arg.targetsDir, record.target),
    );
    if (reference === undefined) {
      throw new Error(`нет исходной модели для ${record.target}`);
    }
    const resultWav = join(arg.runDir, 'result.wav');
    const wav = readWav(resultWav);
    const f0 = measureTrainingF0(wav.samples, wav.sampleRate);
    const fit =
      f0 === null
        ? null
        : fitDampedBeat(wav.samples, f0, wav.sampleRate);
    const originalAccepted = reference.fit?.accepted ?? false;
    const matchAccepted = fit?.accepted ?? false;
    return {
      slug: arg.slug,
      seed: arg.seed,
      target: record.target,
      resultWav,
      originalAccepted,
      matchAccepted,
      f0,
      ...metric(fit),
      outcome: classifyBeatSeedOutcome(
        originalAccepted,
        matchAccepted,
      ),
    };
  } catch (error) {
    console.warn(
      `WARN ${arg.slug}/seed-${arg.seed}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/** Читает completed-прогоны в стабильном порядке; неполный датасет допустим. */
async function measureDataset(
  dataset: string,
  targetsDir: string,
  references: Map<string, BeatReport['entries'][number]>,
): Promise<BeatSeedRun[]> {
  const targets = await readdir(dataset, { withFileTypes: true });
  const runs: BeatSeedRun[] = [];
  for (const target of targets.sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!target.isDirectory()) {
      continue;
    }
    const targetDir = join(dataset, target.name);
    const seeds = await readdir(targetDir, { withFileTypes: true });
    for (const seedDir of seeds.sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const match = /^seed-(\d+)$/.exec(seedDir.name);
      if (match === null || !seedDir.isDirectory()) {
        continue;
      }
      const run = await measureRun({
        slug: target.name,
        seed: Number(match[1]),
        runDir: join(targetDir, seedDir.name),
        targetsDir,
        references,
      });
      if (run !== null) {
        runs.push(run);
      }
    }
  }
  return runs;
}

function format(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

/** Строит Markdown с исходами по сидам без вердикта о качестве звука. */
export function renderBeatSeedReportMarkdown(
  report: BeatSeedReport,
): string {
  const lines = [
    '# Биение в match-прогонах против исходников',
    '',
    'Preserved — признак был и остался, lost — исчез, introduced — появился только после синтеза, absent — отсутствует в обоих. Эти классы не оценивают качество звука и не доказывают закон.',
    '',
    '| Таргет | Исходник | Сиды | Принято в match | Preserved | Lost | Introduced | Absent |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const target of report.targets) {
    lines.push(
      `| ${target.slug} | ${target.originalAccepted ? 'кандидат' : 'нет'} | ${target.seeds.join(', ') || '—'} | ${target.acceptedSeeds.join(', ') || '—'} | ${target.preserved} | ${target.lost} | ${target.introduced} | ${target.absent} |`,
    );
  }
  lines.push(
    '',
    '| Таргет | Сид | Δf | Глубина | Val R² | Val gain | Исход |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  for (const run of report.runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${format(run.deltaHz)} | ${format(run.depth)} | ${format(run.pairValR2)} | ${format(run.valGain)} | ${run.outcome} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Запускает измерение и атомарно пишет beat-seed-report.json/md. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--dataset') {
    throw new Error('Usage: beat-seed-report --dataset DIR');
  }
  const dataset = resolve(args[1] ?? '');
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(dataset, 'manifest.json'),
  );
  const beatReport = await readJsonOrNull<BeatReport>(
    join(dataset, 'beat-report.json'),
  );
  if (manifest === null) {
    throw new Error(`Нет читаемого manifest.json в ${dataset}`);
  }
  if (beatReport === null || beatReport.modelVersion !== 2) {
    throw new Error(`Нужен beat-report.json модели 2 в ${dataset}`);
  }
  const references = buildBeatReferenceMap(beatReport.entries);
  const runs = await measureDataset(
    dataset,
    manifest.targetsDir,
    references,
  );
  const report: BeatSeedReport = {
    version: 1,
    createdAt: new Date().toISOString(),
    phaseModel: manifest.phaseModel ?? null,
    codeRevision: manifest.codeRevision ?? null,
    runs,
    targets: summarizeBeatSeedRuns(runs),
  };
  await writeJsonAtomic(
    join(dataset, 'beat-seed-report.json'),
    report,
  );
  await writeTextAtomic(
    join(dataset, 'beat-seed-report.md'),
    renderBeatSeedReportMarkdown(report),
  );
  const accepted = runs.filter((run) => run.matchAccepted).length;
  const count = (outcome: BeatSeedOutcome): number =>
    runs.filter((run) => run.outcome === outcome).length;
  console.log(
    `REPORT beat-seed: ${runs.length} runs, accepted=${accepted}, ` +
      `preserved=${count('preserved')}, lost=${count('lost')}, ` +
      `introduced=${count('introduced')}, absent=${count('absent')}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
