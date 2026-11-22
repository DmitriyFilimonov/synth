/* eslint-disable no-console */
/**
 * Измеряет разброс характера match-сидов против исходного WAV.
 * Отчёт даёт исходные данные для допусков Q4, но не выносит вердикт
 * и не назначает пороги автоматически.
 *
 * Запуск: npx tsx src/dataset/character-spread.ts --dataset datasets/ref
 * Результат: character-spread.json и character-spread.md в датасете.
 */
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  compareCharacter,
  type CharacterDelta,
} from '../character-metrics';
import { readWav } from '../read-wav';
import { compareWaveformBands } from '../waveform-bands';
import {
  quantile,
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

/** Три наблюдаемых квантиля абсолютного отклонения. */
export interface SpreadStats {
  median: number | null;
  p90: number | null;
  max: number | null;
}

/** Полосовое отклонение одного сида с контекстом его значимости. */
export interface CharacterBandSpread {
  region: string;
  band: string;
  deltaDb: number | null;
  /** Доля полосы в энергии своего участка, 0..1. */
  referenceRegionShare: number;
  /** Энергия всего участка относительно самого громкого участка. */
  referenceRegionRelativeEnergy: number;
}

/** Измерения одного match-сида против его исходника. */
export interface CharacterRunSpread extends CharacterDelta {
  slug: string;
  seed: number;
  bands: CharacterBandSpread[];
}

/** Агрегат одной полосы по всем доступным сидам таргета. */
export interface CharacterBandSpreadSummary {
  region: string;
  band: string;
  referenceRegionShareMedian: number | null;
  referenceRegionRelativeEnergyMedian: number | null;
  absDeltaDb: SpreadStats;
}

/** Разброс одного таргета; это ещё не допуски Q4. */
export interface TargetCharacterSpread {
  slug: string;
  seeds: number[];
  f0AbsCents: SpreadStats;
  decayAbsMs: SpreadStats;
  bands: CharacterBandSpreadSummary[];
}

/** Полный машиночитаемый отчёт датасета. */
export interface CharacterSpreadReport {
  version: 1;
  createdAt: string;
  phaseModel: string | null;
  codeRevision: string | null;
  runs: CharacterRunSpread[];
  targets: TargetCharacterSpread[];
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
 * Считает медиану, p90 и максимум выборки.
 *
 * @param values - Подготовленные числовые значения; массив
 *   не меняется
 * @returns Три статистики; для пустой выборки все они равны `null`
 * @remarks Медиана и p90 используют линейную интерполяцию между
 *   соседними отсортированными значениями.
 */
export function spreadStats(values: number[]): SpreadStats {
  return {
    median: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    max: values.length > 0 ? Math.max(...values) : null,
  };
}

function absoluteFinite(values: (number | null)[]): number[] {
  return values
    .filter(
      (value): value is number =>
        value !== null && Number.isFinite(value),
    )
    .map(Math.abs);
}

/**
 * Группирует измерения по таргетам и считает абсолютный разброс.
 *
 * @param runs - Измерения сидов против их исходных WAV
 * @returns Агрегаты таргетов, отсортированные по `slug`
 * @remarks Возвращает отклонения f0 в центах, спада в миллисекундах
 *   и полос в децибелах. Значения `null` и нечисловые отклонения не
 *   попадают в статистики. Сиды и полосы сортируются; доля полосы
 *   и относительная энергия участка представлены медианами.
 */
export function summarizeCharacterSpread(
  runs: CharacterRunSpread[],
): TargetCharacterSpread[] {
  const slugs = [...new Set(runs.map((run) => run.slug))].sort();
  return slugs.map((slug) => {
    const selected = runs
      .filter((run) => run.slug === slug)
      .sort((a, b) => a.seed - b.seed);
    const keys = [
      ...new Set(
        selected.flatMap((run) =>
          run.bands.map((band) => `${band.region}\n${band.band}`),
        ),
      ),
    ].sort();
    const bands = keys.map((key) => {
      const [region = '', band = ''] = key.split('\n');
      const rows = selected.flatMap((run) =>
        run.bands.filter(
          (item) => item.region === region && item.band === band,
        ),
      );
      return {
        region,
        band,
        referenceRegionShareMedian: quantile(
          rows.map((row) => row.referenceRegionShare),
          0.5,
        ),
        referenceRegionRelativeEnergyMedian: quantile(
          rows.map((row) => row.referenceRegionRelativeEnergy),
          0.5,
        ),
        absDeltaDb: spreadStats(
          absoluteFinite(rows.map((row) => row.deltaDb)),
        ),
      };
    });
    return {
      slug,
      seeds: selected.map((run) => run.seed),
      f0AbsCents: spreadStats(
        absoluteFinite(selected.map((run) => run.bodyF0DeltaCents)),
      ),
      decayAbsMs: spreadStats(
        absoluteFinite(
          selected.map((run) => run.decayDb20DeltaSec),
        ).map((value) => value * 1000),
      ),
      bands,
    };
  });
}

/**
 * Измеряет один сохранённый match против исходного таргета.
 *
 * @param arg - Слаг, сид, каталог прогона и манифест датасета
 * @returns Отклонения характера и полос либо `null`, если прогон не
 *   завершён, его WAV не читаются, их частоты дискретизации
 *   различаются или измерение не удалось
 * @remarks Для каждой полосы сохраняет её долю в энергии эталонного
 *   участка и отношение энергии участка к самому громкому участку.
 *   Ошибку измерения печатает как предупреждение и не передаёт выше.
 */
async function measureRun(arg: {
  slug: string;
  seed: number;
  runDir: string;
  manifest: DatasetManifest;
}): Promise<CharacterRunSpread | null> {
  const record = await readJsonOrNull<RunRecord>(
    join(arg.runDir, 'run.json'),
  );
  if (record?.status !== 'completed') {
    return null;
  }
  try {
    const reference = readWav(
      join(arg.manifest.targetsDir, record.target),
    );
    const candidate = readWav(join(arg.runDir, 'result.wav'));
    if (reference.sampleRate !== candidate.sampleRate) {
      throw new Error(
        `sample rate ${reference.sampleRate} != ${candidate.sampleRate}`,
      );
    }
    const character = compareCharacter(
      reference.samples,
      candidate.samples,
      reference.sampleRate,
    );
    const waveform = compareWaveformBands(
      reference.samples,
      candidate.samples,
      reference.sampleRate,
    );
    const regionTotals = new Map<string, number>();
    for (const row of waveform) {
      regionTotals.set(
        row.region,
        (regionTotals.get(row.region) ?? 0) + row.referenceEnergy,
      );
    }
    const maxRegionTotal = Math.max(0, ...regionTotals.values());
    const bands = waveform.map((row) => {
      const regionTotal = regionTotals.get(row.region) ?? 0;
      return {
        region: row.region,
        band: row.name,
        deltaDb: row.deltaDb,
        referenceRegionShare:
          regionTotal > 0 ? row.referenceEnergy / regionTotal : 0,
        referenceRegionRelativeEnergy:
          maxRegionTotal > 0 ? regionTotal / maxRegionTotal : 0,
      };
    });
    return {
      slug: arg.slug,
      seed: arg.seed,
      ...character,
      bands,
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

/**
 * Читает все completed-прогоны датасета в стабильном порядке.
 *
 * @param dataset - Каталог датасета
 * @param manifest - Манифест с путём к исходным WAV
 * @returns Успешно измеренные прогоны; повреждённые и незавершённые
 *   прогоны пропущены
 * @throws Error если не удалось прочитать каталоги датасета
 */
async function measureDataset(
  dataset: string,
  manifest: DatasetManifest,
): Promise<CharacterRunSpread[]> {
  const targets = await readdir(dataset, { withFileTypes: true });
  const runs: CharacterRunSpread[] = [];
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
        manifest,
      });
      if (run !== null) {
        runs.push(run);
      }
    }
  }
  return runs;
}

function format(value: number | null, digits = 2): string {
  return value === null ? '—' : value.toFixed(digits);
}

function formatStats(stats: SpreadStats): string {
  return `${format(stats.median)} / ${format(stats.p90)} / ${format(stats.max)}`;
}

/**
 * Строит человекочитаемый Markdown-отчёт без вердикта PASS/FAIL.
 *
 * @param report - Сырые измерения и агрегаты датасета
 * @returns Markdown с медианой, p90 и максимумом по каждому таргету
 * @remarks Доли полос и относительную энергию участков печатает в
 *   процентах. Отклонения показывают по модулю; функция не назначает
 *   допуски Q4 и не оценивает качество.
 */
export function renderCharacterSpreadMarkdown(
  report: CharacterSpreadReport,
): string {
  const lines = [
    '# Разброс характера по match-сидам',
    '',
    'Значения — медиана / p90 / максимум абсолютного отклонения от исходного WAV. Это наблюдения для выбора допусков Q4, а не готовые пороги или вердикт качества.',
    '',
  ];
  for (const target of report.targets) {
    lines.push(
      `## ${target.slug}`,
      '',
      `Сиды: ${target.seeds.join(', ')}.`,
      '',
      `- |Δf0|, центы: ${formatStats(target.f0AbsCents)}.`,
      `- |Δ спада −20 дБ|, мс: ${formatStats(target.decayAbsMs)}.`,
      '',
      '| Участок | Полоса | Доля полосы в участке | Энергия участка относительно пика | Абсолютная дельта, дБ |',
      '| --- | --- | ---: | ---: | ---: |',
    );
    for (const band of target.bands) {
      lines.push(
        `| ${band.region} | ${band.band} | ` +
          `${format(band.referenceRegionShareMedian === null ? null : band.referenceRegionShareMedian * 100, 3)}% | ` +
          `${format(band.referenceRegionRelativeEnergyMedian === null ? null : band.referenceRegionRelativeEnergyMedian * 100, 3)}% | ` +
          `${formatStats(band.absDeltaDb)} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Запускает измерение датасета и атомарно сохраняет оба отчёта.
 *
 * @throws Error если аргументы неверны, манифест не читается или
 *   запись отчёта не удалась
 * @remarks Ожидает аргументы `--dataset DIR`, читает `manifest.json`
 *   и пишет `character-spread.json` и `character-spread.md` в каталог
 *   датасета. Каждый файл заменяет прежнюю версию атомарно. Датасет
 *   без измеримых completed-прогонов не считается ошибкой: функция
 *   сохраняет отчёт с пустыми `runs` и `targets`.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--dataset') {
    throw new Error('Usage: character-spread --dataset DIR');
  }
  const dataset = resolve(args[1] ?? '');
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(dataset, 'manifest.json'),
  );
  if (manifest === null) {
    throw new Error(`Нет читаемого manifest.json в ${dataset}`);
  }
  const runs = await measureDataset(dataset, manifest);
  const report: CharacterSpreadReport = {
    version: 1,
    createdAt: new Date().toISOString(),
    phaseModel: manifest.phaseModel ?? null,
    codeRevision: manifest.codeRevision ?? null,
    runs,
    targets: summarizeCharacterSpread(runs),
  };
  await writeJsonAtomic(
    join(dataset, 'character-spread.json'),
    report,
  );
  await writeTextAtomic(
    join(dataset, 'character-spread.md'),
    renderCharacterSpreadMarkdown(report),
  );
  console.log(
    `REPORT character-spread: ${runs.length} runs, ${report.targets.length} targets`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
