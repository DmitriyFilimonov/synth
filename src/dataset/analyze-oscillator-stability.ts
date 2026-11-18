/**
 * Поосцилляторная стабильность: сопоставляет осцилляторы разных
 * сидов одного таргета по близости log-частоты и меряет разброс
 * признаков внутри сопоставленных пар (план
 * `docs/plan-kick-enhancement.md`, этап 1 → карта идентифицируемости).
 *
 * Метрики уровня прогона (analyze-stability.ts) отвечают на вопрос
 * «устойчив ли патч как целое», а этот анализ — на вопрос «устойчив
 * ли каждый компонент». Если осцилляторы одного таргета не
 * сопоставляются между сидами, структура патча не восстанавливается,
 * и искать закономерности надо на уровне семейств траекторий, а не
 * отдельных параметров.
 *
 * Запуск:
 *   npx tsx src/dataset/analyze-oscillator-stability.ts \
 *     --dataset datasets/reference-4
 *
 * Артефакты: oscillator-stability.json и oscillator-stability.md
 * в каталоге датасета.
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  quantile,
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

/** Срез features.json, который читает этот анализ. */
interface OscFeatures {
  index: number;
  role: 'sustain' | 'transient';
  freqBase: number;
  freqStartToBase: number;
  ampStartLevel: number;
  ampEnvDurationSec: number;
  phaseRad: number;
  decaySecToDb: { db20: number | null };
}

/** Признаки одного прогона. */
interface RunFeatures {
  slug: string;
  seed: number;
  oscillators: OscFeatures[];
}

/** Сопоставленная пара осцилляторов из двух прогонов. */
interface MatchedPair {
  a: OscFeatures;
  b: OscFeatures;
  logFreqDistance: number;
}

/** Разницы признаков внутри одной сопоставленной пары. */
interface PairDelta {
  slug: string;
  seedA: number;
  seedB: number;
  dLogFreqBase: number;
  dLogFreqStartToBase: number;
  dLogAmpEnvDuration: number;
  dLogAmpStartLevel: number;
  dPhaseCircular: number;
  dDecayDb20: number | null;
  sameRole: boolean;
}

/** Сводка покрытия сопоставления для пары прогонов. */
interface MatchCoverage {
  slug: string;
  seedA: number;
  seedB: number;
  matched: number;
  totalA: number;
  totalB: number;
}

/**
 * Порог сопоставления по log-частоте: 0.25 ≈ 28% разницы частот.
 * Больше — осцилляторы считаем разными компонентами.
 */
const MATCH_MAX_LOG_FREQ_DISTANCE = 0.25;

/**
 * Пороги вердиктов по медиане разницы признака. Стартовые значения,
 * уточняются по мере накопления датасета.
 */
const VERDICT_EPS = {
  dLogFreqBase: 0.05,
  dLogFreqStartToBase: 0.15,
  dLogAmpEnvDuration: 0.25,
  dLogAmpStartLevel: 0.25,
  dPhaseCircular: 0.35,
  dDecayDb20: 0.3,
} as const;

/** Загружает features.json всех завершённых прогонов датасета. */
async function loadRunFeatures(
  datasetDir: string,
): Promise<RunFeatures[]> {
  const runs: RunFeatures[] = [];
  const slugs = readdirSync(datasetDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const slug of slugs) {
    const slugDir = join(datasetDir, slug);
    const seedDirs = readdirSync(slugDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('seed-'))
      .map((d) => d.name)
      .sort();
    for (const seedDir of seedDirs) {
      const features = await readJsonOrNull<RunFeatures>(
        join(slugDir, seedDir, 'features.json'),
      );
      if (features !== null) {
        runs.push(features);
      }
    }
  }
  return runs;
}

/**
 * Сопоставляет осцилляторы двух прогонов жадно: строит пары по
 * возрастанию расстояния в log-частоте, берёт каждый осциллятор
 * не более одного раза. Пары дальше порога отбрасывает.
 */
function matchOscillators(
  a: OscFeatures[],
  b: OscFeatures[],
): MatchedPair[] {
  const candidates: { i: number; j: number; dist: number }[] = [];
  a.forEach((oa, i) => {
    b.forEach((ob, j) => {
      candidates.push({
        i,
        j,
        dist: Math.abs(Math.log(oa.freqBase) - Math.log(ob.freqBase)),
      });
    });
  });
  candidates.sort((x, y) => x.dist - y.dist);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: MatchedPair[] = [];
  for (const c of candidates) {
    if (c.dist > MATCH_MAX_LOG_FREQ_DISTANCE) {
      break;
    }
    if (usedA.has(c.i) || usedB.has(c.j)) {
      continue;
    }
    usedA.add(c.i);
    usedB.add(c.j);
    const oa = a[c.i];
    const ob = b[c.j];
    if (oa === undefined || ob === undefined) {
      continue;
    }
    pairs.push({ a: oa, b: ob, logFreqDistance: c.dist });
  }
  return pairs;
}

/** Круговое расстояние фаз в радианах, 0..π. */
function circularPhaseDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % (2 * Math.PI);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

/** Считает разницы признаков для одной сопоставленной пары. */
function computePairDelta(arg: {
  slug: string;
  seedA: number;
  seedB: number;
  pair: MatchedPair;
}): PairDelta {
  const { a, b } = arg.pair;
  const decayA = a.decaySecToDb.db20;
  const decayB = b.decaySecToDb.db20;
  return {
    slug: arg.slug,
    seedA: arg.seedA,
    seedB: arg.seedB,
    dLogFreqBase: arg.pair.logFreqDistance,
    dLogFreqStartToBase: Math.abs(
      Math.log(a.freqStartToBase) - Math.log(b.freqStartToBase),
    ),
    dLogAmpEnvDuration: Math.abs(
      Math.log(a.ampEnvDurationSec) - Math.log(b.ampEnvDurationSec),
    ),
    dLogAmpStartLevel: Math.abs(
      Math.log(a.ampStartLevel) - Math.log(b.ampStartLevel),
    ),
    dPhaseCircular: circularPhaseDistance(a.phaseRad, b.phaseRad),
    dDecayDb20:
      decayA !== null && decayB !== null
        ? Math.abs(Math.log(decayA) - Math.log(decayB))
        : null,
    sameRole: a.role === b.role,
  };
}

/** Сводит разницы одного признака: медиана, p90, вердикт по порогу. */
function summarizeDelta(
  values: number[],
  eps: number,
): { median: number | null; p90: number | null; verdict: string } {
  const median = quantile(values, 0.5);
  const p90 = quantile(values, 0.9);
  let verdict = 'sparse';
  if (median !== null) {
    verdict = median < eps ? 'stable' : 'unstable';
  }
  return { median, p90, verdict };
}

/** Строит строки markdown-таблицы сводки по признакам. */
function buildSummaryRows(deltas: PairDelta[]): string[] {
  const rows: string[] = [];
  const fields: {
    name: string;
    pick: (d: PairDelta) => number | null;
    eps: number;
  }[] = [
    {
      name: 'dLogFreqBase',
      pick: (d) => d.dLogFreqBase,
      eps: VERDICT_EPS.dLogFreqBase,
    },
    {
      name: 'dLogFreqStartToBase',
      pick: (d) => d.dLogFreqStartToBase,
      eps: VERDICT_EPS.dLogFreqStartToBase,
    },
    {
      name: 'dLogAmpEnvDuration',
      pick: (d) => d.dLogAmpEnvDuration,
      eps: VERDICT_EPS.dLogAmpEnvDuration,
    },
    {
      name: 'dLogAmpStartLevel',
      pick: (d) => d.dLogAmpStartLevel,
      eps: VERDICT_EPS.dLogAmpStartLevel,
    },
    {
      name: 'dPhaseCircular',
      pick: (d) => d.dPhaseCircular,
      eps: VERDICT_EPS.dPhaseCircular,
    },
    {
      name: 'dDecayDb20',
      pick: (d) => d.dDecayDb20,
      eps: VERDICT_EPS.dDecayDb20,
    },
  ];
  for (const field of fields) {
    const values = deltas
      .map(field.pick)
      .filter((v): v is number => v !== null);
    const summary = summarizeDelta(values, field.eps);
    rows.push(
      `| ${field.name} | ${summary.median?.toFixed(3) ?? '—'} | ` +
        `${summary.p90?.toFixed(3) ?? '—'} | ${field.eps} | ` +
        `${summary.verdict} | ${values.length} |`,
    );
  }
  return rows;
}

/** Строит markdown-отчёт: покрытие сопоставления и сводку разниц. */
function buildMarkdownReport(arg: {
  deltas: PairDelta[];
  coverage: MatchCoverage[];
}): string {
  const lines: string[] = [];
  lines.push('# Поосцилляторная стабильность');
  lines.push('');
  lines.push('## Покрытие сопоставления по парам сидов');
  lines.push('');
  lines.push(
    '| Таргет | Сиды | Сопоставлено | Всего A | Всего B | Доля |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const cov of arg.coverage) {
    const total = Math.max(cov.totalA, cov.totalB);
    const share = total > 0 ? (cov.matched / total) * 100 : 0;
    lines.push(
      `| ${cov.slug} | ${cov.seedA}–${cov.seedB} | ${cov.matched} | ` +
        `${cov.totalA} | ${cov.totalB} | ${share.toFixed(0)}% |`,
    );
  }
  lines.push('');
  lines.push('## Разброс признаков в сопоставленных парах');
  lines.push('');
  const roleAgreement =
    arg.deltas.length > 0
      ? (arg.deltas.filter((d) => d.sameRole).length /
          arg.deltas.length) *
        100
      : 0;
  lines.push(
    `Совпадение роли в парах: ${roleAgreement.toFixed(0)}% ` +
      `(${arg.deltas.length} пар).`,
  );
  lines.push('');
  lines.push('| Признак | Медиана | p90 | Порог | Вердикт | Пар |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  lines.push(...buildSummaryRows(arg.deltas));
  lines.push('');
  return lines.join('\n');
}

/** Точка входа: грузит признаки, сопоставляет, пишет отчёты. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const datasetIdx = argv.indexOf('--dataset');
  const datasetArg =
    datasetIdx >= 0 ? argv[datasetIdx + 1] : undefined;
  if (datasetArg === undefined) {
    throw new Error('Usage: --dataset <dir>');
  }
  const datasetDir = resolve(datasetArg);

  const runs = await loadRunFeatures(datasetDir);
  console.log(`REPORT loaded ${runs.length} feature sets`);

  const bySlug = new Map<string, RunFeatures[]>();
  for (const run of runs) {
    if (!bySlug.has(run.slug)) {
      bySlug.set(run.slug, []);
    }
    (bySlug.get(run.slug) ?? []).push(run);
  }

  const deltas: PairDelta[] = [];
  const coverage: MatchCoverage[] = [];
  for (const [slug, slugRuns] of [...bySlug.entries()].sort()) {
    for (let i = 0; i < slugRuns.length; i += 1) {
      for (let j = i + 1; j < slugRuns.length; j += 1) {
        const runA = slugRuns[i];
        const runB = slugRuns[j];
        if (runA === undefined || runB === undefined) {
          continue;
        }
        const pairs = matchOscillators(
          runA.oscillators,
          runB.oscillators,
        );
        coverage.push({
          slug,
          seedA: runA.seed,
          seedB: runB.seed,
          matched: pairs.length,
          totalA: runA.oscillators.length,
          totalB: runB.oscillators.length,
        });
        for (const pair of pairs) {
          deltas.push(
            computePairDelta({
              slug,
              seedA: runA.seed,
              seedB: runB.seed,
              pair,
            }),
          );
        }
      }
    }
  }

  await writeJsonAtomic(
    join(datasetDir, 'oscillator-stability.json'),
    {
      deltas,
      coverage,
    },
  );
  await writeTextAtomic(
    join(datasetDir, 'oscillator-stability.md'),
    buildMarkdownReport({ deltas, coverage }),
  );
  console.log(
    `REPORT ${deltas.length} matched pairs across ` +
      `${coverage.length} seed pairs; reports in ${datasetDir}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
