/**
 * Проверка кандидатов в закон качества по датасету (T15/T16).
 *
 * Главное отличие от разведки: каждый таргет проверяется как
 * отложенный. Пороги правила считаются по остальным таргетам, а
 * проверяемый в них не участвует. Поэтому отчёт показывает, что
 * правило обобщается, а не что оно подогнано под всю выборку.
 *
 * Запуск:
 *   npx tsx src/dataset/check-laws.ts --dataset datasets/reference-4
 *
 * Артефакты: law-report.json и law-report.md в каталоге датасета.
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  computeLawMetrics,
  evaluateHoldoutRules,
  pooledBodyClusters,
  type LawMetrics,
  type LawOsc,
} from './law-metrics';
import {
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

/** Осциллятор features.json в срезе, нужном метрикам. */
interface FeatureOsc {
  role: 'sustain' | 'transient';
  freqBase: number;
  freqStartToBase: number;
  ampStartLevel: number;
  decaySecToDb?: { db20: number | null };
}

interface RunFeatures {
  oscillators: FeatureOsc[];
}

/** Метрики одного таргета: медианы по сидам плюс пул кластеров. */
interface TargetReport {
  slug: string;
  seeds: number;
  metrics: LawMetrics;
  bodyClusters: number;
  bodyClusterSpread: number | null;
}

function toLawOsc(o: FeatureOsc): LawOsc {
  return {
    role: o.role,
    freqBase: o.freqBase,
    freqStartToBase: o.freqStartToBase,
    ampStartLevel: o.ampStartLevel,
    decayDb20Sec: o.decaySecToDb?.db20 ?? null,
  };
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function medianField(
  runs: LawMetrics[],
  pick: (m: LawMetrics) => number | null,
): number | null {
  return medianOf(
    runs.map(pick).filter((v): v is number => v !== null),
  );
}

function buildMarkdown(
  targets: TargetReport[],
  rules: import('./law-metrics').HoldoutRuleResult[],
): string {
  const lines: string[] = [];
  lines.push('# Проверка кандидатов в закон (leave-one-out)');
  lines.push('');
  lines.push(
    'Пороги каждого правила считаются без проверяемого таргета.',
  );
  lines.push('');
  lines.push(
    '| Правило | Прошло отложенных | Всего | Что проверяем |',
  );
  lines.push('| --- | --- | --- | --- |');
  for (const r of rules) {
    lines.push(
      `| ${r.name} | ${r.heldOutPassed} | ${r.targets} | ${r.description} |`,
    );
  }
  lines.push('');
  for (const r of rules) {
    lines.push(`## ${r.name}`);
    for (const d of r.details) {
      lines.push(`- ${d}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--dataset');
  const datasetArg = idx >= 0 ? argv[idx + 1] : undefined;
  if (datasetArg === undefined) {
    throw new Error('Usage: --dataset <dir>');
  }
  const datasetDir = resolve(datasetArg);

  const targets: TargetReport[] = [];
  for (const entry of readdirSync(datasetDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const slugDir = join(datasetDir, entry.name);
    const runMetrics: LawMetrics[] = [];
    const perSeedFreqs: number[][] = [];
    const seedDirs = readdirSync(slugDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('seed-'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const seedDir of seedDirs) {
      const features = await readJsonOrNull<RunFeatures>(
        join(slugDir, seedDir.name, 'features.json'),
      );
      if (features === null) {
        continue;
      }
      const oscs = features.oscillators.map(toLawOsc);
      runMetrics.push(computeLawMetrics(oscs));
      perSeedFreqs.push(
        oscs
          .filter((o) => o.role === 'sustain')
          .map((o) => o.freqBase),
      );
    }
    if (runMetrics.length === 0) {
      continue;
    }
    const pooled = pooledBodyClusters(
      perSeedFreqs,
      Math.min(3, runMetrics.length),
    );
    targets.push({
      slug: entry.name,
      seeds: runMetrics.length,
      metrics: {
        bodySweepMedian: medianField(
          runMetrics,
          (m) => m.bodySweepMedian,
        ),
        upperSweepMedian: medianField(
          runMetrics,
          (m) => m.upperSweepMedian,
        ),
        nearIntFraction: medianField(
          runMetrics,
          (m) => m.nearIntFraction,
        ),
        top3Share: medianField(runMetrics, (m) => m.top3Share),
        top3MaxFreq: medianField(runMetrics, (m) => m.top3MaxFreq),
        sustainCount: Math.round(
          medianField(runMetrics, (m) => m.sustainCount) ?? 0,
        ),
      },
      bodyClusters: pooled.count,
      bodyClusterSpread: pooled.maxSpread,
    });
  }

  const rules = evaluateHoldoutRules(targets);
  await writeJsonAtomic(join(datasetDir, 'law-report.json'), {
    targets,
    rules,
  });
  await writeTextAtomic(
    join(datasetDir, 'law-report.md'),
    buildMarkdown(targets, rules),
  );
  for (const r of rules) {
    console.log(
      `LAW ${r.name}: ${r.heldOutPassed}/${r.targets} отложенных таргетов`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
