/* eslint-disable no-console */
/**
 * Считает кандидаты допусков Q4 по уже наблюдаемому разбросу match-сидов.
 * Не выдаёт PASS/FAIL: порог нужно выбрать и согласовать после отчёта.
 *
 * npx tsx src/dataset/character-tolerances.ts --dataset datasets/ref
 */
import { join, resolve } from 'node:path';
import {
  quantile,
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';
import type {
  CharacterSpreadReport,
  SpreadStats,
  TargetCharacterSpread,
} from './character-spread';

/** Варианты порога: центр и хвост распределения target-level p90. */
export interface ToleranceMetric {
  medianTargetP90: number | null;
  p90TargetP90: number | null;
  maxTargetP90: number | null;
  maxObserved: number | null;
}

/** Кандидат допуска одной полосы с контекстом её энергии. */
export interface BandTolerance extends ToleranceMetric {
  region: string;
  band: string;
  referenceRegionShareMedian: number | null;
  referenceRegionRelativeEnergyMedian: number | null;
}

/** Полный отчёт наблюдений, а не выбранный численный закон. */
export interface CharacterToleranceReport {
  version: 1;
  createdAt: string;
  phaseModel: string | null;
  codeRevision: string | null;
  targetCount: number;
  f0Cents: ToleranceMetric;
  decayMs: ToleranceMetric;
  bands: BandTolerance[];
  targets: TargetCharacterSpread[];
}

function finite(values: (number | null)[]): number[] {
  return values.filter(
    (value): value is number =>
      value !== null && Number.isFinite(value),
  );
}

/**
 * Сводит target-level p90 и максимумы в четыре наблюдаемых варианта порога.
 *
 * @param stats - Распределения абсолютных отклонений по отдельным таргетам
 * @returns Медиану и p90 target-level p90, максимум p90 и максимум наблюдений;
 *   пустой вход даёт null во всех полях
 */
export function toleranceMetric(
  stats: SpreadStats[],
): ToleranceMetric {
  const p90Values = finite(stats.map((item) => item.p90));
  const maxValues = finite(stats.map((item) => item.max));
  return {
    medianTargetP90: quantile(p90Values, 0.5),
    p90TargetP90: quantile(p90Values, 0.9),
    maxTargetP90:
      p90Values.length > 0 ? Math.max(...p90Values) : null,
    maxObserved: maxValues.length > 0 ? Math.max(...maxValues) : null,
  };
}

/**
 * Строит кандидаты f0, спада и полос без выбора одного из них автоматически.
 *
 * @param spread - Сырые и агрегированные отклонения character-spread
 * @returns Отчёт без createdAt с исходными target-level распределениями,
 *   численными кандидатами и энергетическим контекстом полос
 */
export function summarizeCharacterTolerances(
  spread: CharacterSpreadReport,
): Omit<CharacterToleranceReport, 'createdAt'> {
  const keys = [
    ...new Set(
      spread.targets.flatMap((target) =>
        target.bands.map((band) => `${band.region}\n${band.band}`),
      ),
    ),
  ].sort();
  const bands = keys.map((key) => {
    const [region = '', band = ''] = key.split('\n');
    const selected = spread.targets.flatMap((target) =>
      target.bands.filter(
        (item) => item.region === region && item.band === band,
      ),
    );
    return {
      region,
      band,
      ...toleranceMetric(selected.map((item) => item.absDeltaDb)),
      referenceRegionShareMedian: quantile(
        finite(
          selected.map((item) => item.referenceRegionShareMedian),
        ),
        0.5,
      ),
      referenceRegionRelativeEnergyMedian: quantile(
        finite(
          selected.map(
            (item) => item.referenceRegionRelativeEnergyMedian,
          ),
        ),
        0.5,
      ),
    };
  });
  return {
    version: 1,
    phaseModel: spread.phaseModel,
    codeRevision: spread.codeRevision,
    targetCount: spread.targets.length,
    f0Cents: toleranceMetric(
      spread.targets.map((target) => target.f0AbsCents),
    ),
    decayMs: toleranceMetric(
      spread.targets.map((target) => target.decayAbsMs),
    ),
    bands,
    targets: spread.targets,
  };
}

function format(value: number | null, digits = 2): string {
  return value === null ? '—' : value.toFixed(digits);
}

function formatMetric(metric: ToleranceMetric): string {
  return `${format(metric.medianTargetP90)} / ${format(metric.p90TargetP90)} / ${format(metric.maxTargetP90)} / ${format(metric.maxObserved)}`;
}

/**
 * Возвращает Markdown с явным обозначением, что это ещё не допуски Q4.
 *
 * @param report - Кандидаты допусков и исходные распределения по таргетам
 * @returns Markdown-строка; файлы записывает только CLI main
 */
export function renderCharacterTolerancesMarkdown(
  report: CharacterToleranceReport,
): string {
  const lines = [
    '# Кандидаты допусков Q4 по разбросу match-сидов',
    '',
    'Столбцы: медиана target-level p90 / p90 target-level p90 / максимум target-level p90 / максимум наблюдений. Это варианты для согласования, а не готовые допуски и не вердикт качества.',
    '',
    `- Таргетов: ${report.targetCount}.`,
    `- f0, центы: ${formatMetric(report.f0Cents)}.`,
    `- Спад −20 дБ, мс: ${formatMetric(report.decayMs)}.`,
    '',
    '## По таргетам',
    '',
    'Значения f0 и спада: медиана / p90 / максимум абсолютного отклонения от исходника.',
    '',
    '| Таргет | Сиды | f0, центы | Спад, мс |',
    '| --- | --- | --- | --- |',
  ];
  for (const target of report.targets) {
    const stats = (values: SpreadStats): string =>
      `${format(values.median)} / ${format(values.p90)} / ${format(values.max)}`;
    lines.push(
      `| ${target.slug} | ${target.seeds.join(', ')} | ${stats(target.f0AbsCents)} | ${stats(target.decayAbsMs)} |`,
    );
  }
  lines.push(
    '',
    '## Полосы',
    '',
    'Доли полосы и энергии участка помогают не придавать тихим полосам вес громких. Сами по себе они не задают вес закона.',
    '',
    '| Участок | Полоса | Доля полосы | Энергия участка | Кандидаты, дБ |',
    '| --- | --- | ---: | ---: | --- |',
  );
  for (const band of report.bands) {
    lines.push(
      `| ${band.region} | ${band.band} | ${band.referenceRegionShareMedian === null ? '—' : format(band.referenceRegionShareMedian * 100, 3) + '%'} | ${band.referenceRegionRelativeEnergyMedian === null ? '—' : format(band.referenceRegionRelativeEnergyMedian * 100, 3) + '%'} | ${formatMetric(band)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Читает character-spread.json и атомарно пишет character-tolerances.json/md. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--dataset') {
    throw new Error('Usage: character-tolerances --dataset DIR');
  }
  const dataset = resolve(args[1] ?? '');
  const spread = await readJsonOrNull<CharacterSpreadReport>(
    join(dataset, 'character-spread.json'),
  );
  if (spread === null) {
    throw new Error(`Нет character-spread.json в ${dataset}`);
  }
  const report: CharacterToleranceReport = {
    createdAt: new Date().toISOString(),
    ...summarizeCharacterTolerances(spread),
  };
  await writeJsonAtomic(
    join(dataset, 'character-tolerances.json'),
    report,
  );
  await writeTextAtomic(
    join(dataset, 'character-tolerances.md'),
    renderCharacterTolerancesMarkdown(report),
  );
  console.log(
    `REPORT character-tolerances: ${report.targetCount} targets`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
