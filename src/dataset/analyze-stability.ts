/**
 * Анализ стабильности датасета (этап 1 → карта идентифицируемости,
 * план `docs/plan-kick-enhancement.md`).
 *
 * Отвечает на два вопроса:
 *
 * 1. Что восстанавливается устойчиво? Для каждой метрики уровня
 *    прогона сравниваем разброс между сидами одного таргета с
 *    разбросом между таргетами. Метрика, стабильная внутри таргета
 *    и различающаяся между таргетами, — кандидат в характер звука.
 *    Метрика, гуляющая между сидами, — неидентифицируема.
 * 2. Что оптимизатор не двигает вовсе? Для каждого параметра
 *    каждого осциллятора считаем дрейф |финал − init|. Параметр,
 *    который не двигается ни в одном прогоне, — артефакт
 *    инициализации, а не закон природы.
 *
 * Запуск:
 *   npx tsx src/dataset/analyze-stability.ts --dataset datasets/reference-4
 *
 * Артефакты: stability.json (машинный отчёт) и stability.md
 * (таблицы для чтения) в каталоге датасета.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MIN } from '../envelope';
import { type ArgCreateSynth } from '../synth';
import { mapVectorToSynthConfigForOsc } from '../vector-to-synth-config';

/**
 * Структурный минимум для чтения параметров осциллятора: подходят
 * и группа из патча, и результат денормализации вектора.
 */
interface OscParamSource {
  osc: {
    freqBase: number;
    freqStart: number;
    slope: number;
    duration: number;
    phase: number;
  };
  ampEnv: {
    duration: number;
    endLevel?: number;
    slope: number;
    startLevel: number;
  };
}

/** Минимальный срез features.json, который читает этот анализ. */
interface OscFeatures {
  index: number;
  role: 'sustain' | 'transient';
  freqBase: number;
  freqStartToBase: number;
  ampStartLevel: number;
  ampEnvDurationSec: number;
  decaySecToDb: { db20: number | null };
}

/** Минимальный срез features.json уровня прогона. */
interface RunFeatures {
  oscillators: OscFeatures[];
}

/** Загруженный прогон: метаданные, патч, init-вектор, признаки. */
interface LoadedRun {
  slug: string;
  seed: number;
  suppressionPercent: number | null;
  globalSuppressionPercent: number | null;
  patch: ArgCreateSynth;
  initVector: number[] | null;
  features: RunFeatures | null;
}

/** Скалярная метрика прогона для анализа стабильности. */
interface ScalarMetric {
  name: string;
  values: Map<string, number[]>;
}

/** Вердикт стабильности одной метрики. */
interface MetricVerdict {
  name: string;
  withinMaxRange: number;
  withinMeanRange: number;
  betweenRange: number;
  verdict: 'character' | 'invariant' | 'non-identifiable' | 'sparse';
}

/** Дрейф одного параметра одного слота по всем прогонам. */
interface DriftCell {
  oscIndex: number;
  param: string;
  activeRuns: number;
  maxDrift: number;
  meanDrift: number;
  artifact: boolean;
}

/** Пороги «не двигается» по типам параметров, в денормализованных единицах. */
const DRIFT_EPS: Record<string, number> = {
  freqBase: 0.5,
  freqStart: 0.5,
  slope: 0.02,
  duration: 0.005,
  phase: 0.05,
  ampEnvDuration: 0.005,
  endLevel: 0.002,
  ampEnvSlope: 0.02,
  startLevel: 0.005,
};

/** Имена девяти оптимизируемых параметров осциллятора. */
const DRIFT_PARAMS = [
  'freqBase',
  'freqStart',
  'slope',
  'duration',
  'phase',
  'ampEnvDuration',
  'endLevel',
  'ampEnvSlope',
  'startLevel',
] as const;

/** Читает JSON-файл; при отсутствии или битом содержимом — null. */
async function readJsonOrNull<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Пишет текст или JSON атомарно: временный файл + rename. */
async function writeAtomic(
  path: string,
  data: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * Загружает все завершённые прогоны датасета. Прогон без features.json
 * включаем с features=null — дрейф init-вектора считается и без
 * признаков.
 */
async function loadCompletedRuns(
  datasetDir: string,
): Promise<LoadedRun[]> {
  const runs: LoadedRun[] = [];
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
      const runDir = join(slugDir, seedDir);
      const run = await readJsonOrNull<{
        status: string;
        seed: number;
        suppressionPercent: number | null;
        globalSuppressionPercent: number | null;
      }>(join(runDir, 'run.json'));
      if (run === null || run.status !== 'completed') {
        continue;
      }
      const patch = await readJsonOrNull<ArgCreateSynth>(
        join(runDir, 'patch.json'),
      );
      if (patch === null) {
        console.log(
          `WARN ${slug}/${seedDir}: no patch.json, skipped`,
        );
        continue;
      }
      const features = await readJsonOrNull<RunFeatures>(
        join(runDir, 'features.json'),
      );
      if (features === null) {
        console.log(
          `WARN ${slug}/${seedDir}: no features.json, ` +
            'scalar stats limited',
        );
      }
      runs.push({
        slug,
        seed: run.seed,
        suppressionPercent: run.suppressionPercent,
        globalSuppressionPercent: run.globalSuppressionPercent,
        patch,
        initVector: await readJsonOrNull<number[]>(
          join(slugDir, 'init-vector.json'),
        ),
        features,
      });
    }
  }
  return runs;
}

/** Считает квантиль с линейной интерполяцией; пустой ввод — null. */
function quantile(values: number[], q: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const lower = sorted[lo] ?? 0;
  const upper = sorted[hi] ?? lower;
  return lower + (upper - lower) * (pos - lo);
}

/** Собирает скалярные метрики прогона из run.json и features.json. */
function collectScalarMetrics(runs: LoadedRun[]): ScalarMetric[] {
  const metrics = new Map<string, Map<string, number[]>>();
  const add = (name: string, slug: string, value: number | null) => {
    if (value === null || Number.isNaN(value)) {
      return;
    }
    if (!metrics.has(name)) {
      metrics.set(name, new Map());
    }
    const bySlug = metrics.get(name) ?? new Map<string, number[]>();
    if (!bySlug.has(slug)) {
      bySlug.set(slug, []);
    }
    (bySlug.get(slug) ?? []).push(value);
  };

  for (const run of runs) {
    add(
      'globalSuppressionPercent',
      run.slug,
      run.globalSuppressionPercent,
    );
    add('suppressionPercent', run.slug, run.suppressionPercent);
    if (run.features === null) {
      continue;
    }
    const oscs = run.features.oscillators;
    add('activeOscillators', run.slug, oscs.length);
    add(
      'activeSustain',
      run.slug,
      oscs.filter((o) => o.role === 'sustain').length,
    );
    add(
      'activeTransient',
      run.slug,
      oscs.filter((o) => o.role === 'transient').length,
    );
    const freqBases = oscs.map((o) => o.freqBase);
    const ratios = oscs.map((o) => o.freqStartToBase);
    const ampDurs = oscs.map((o) => o.ampEnvDurationSec);
    const levels = oscs.map((o) => o.ampStartLevel);
    const decays = oscs
      .map((o) => o.decaySecToDb.db20)
      .filter((d): d is number => d !== null);
    add('freqBase_p10', run.slug, quantile(freqBases, 0.1));
    add('freqBase_p50', run.slug, quantile(freqBases, 0.5));
    add('freqStartToBase_p50', run.slug, quantile(ratios, 0.5));
    add('freqStartToBase_p90', run.slug, quantile(ratios, 0.9));
    add('ampEnvDuration_p50', run.slug, quantile(ampDurs, 0.5));
    add('ampStartLevel_p90', run.slug, quantile(levels, 0.9));
    add('decayDb20_p50', run.slug, quantile(decays, 0.5));
  }

  return [...metrics.entries()].map(([name, values]) => ({
    name,
    values,
  }));
}

/**
 * Классифицирует метрику: разброс между сидами одного таргета
 * против разброса между таргетами. Порог character: средний
 * внутритаргетный разброс меньше половины межтаргетного. Порог
 * invariant: межтаргетный разброс меньше удвоенного внутритаргетного.
 */
function classifyMetric(metric: ScalarMetric): MetricVerdict {
  const perTargetMeans: number[] = [];
  const perTargetRanges: number[] = [];
  for (const values of metric.values.values()) {
    if (values.length === 0) {
      continue;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    perTargetRanges.push(max - min);
    perTargetMeans.push(
      values.reduce((a, b) => a + b, 0) / values.length,
    );
  }
  const withinMaxRange =
    perTargetRanges.length > 0 ? Math.max(...perTargetRanges) : 0;
  const withinMeanRange =
    perTargetRanges.length > 0
      ? perTargetRanges.reduce((a, b) => a + b, 0) /
        perTargetRanges.length
      : 0;
  const betweenRange =
    perTargetMeans.length > 1
      ? Math.max(...perTargetMeans) - Math.min(...perTargetMeans)
      : 0;

  let verdict: MetricVerdict['verdict'];
  const anySingleSeed = [...metric.values.values()].some(
    (v) => v.length < 2,
  );
  if (anySingleSeed || perTargetMeans.length < 2) {
    verdict = 'sparse';
  } else if (withinMeanRange * 2 < betweenRange) {
    verdict = 'character';
  } else if (betweenRange < withinMeanRange * 2) {
    verdict = 'invariant';
  } else {
    verdict = 'non-identifiable';
  }
  return {
    name: metric.name,
    withinMaxRange,
    withinMeanRange,
    betweenRange,
    verdict,
  };
}

/** Читает денормализованное значение одного параметра осциллятора. */
function readParam(
  group: OscParamSource,
  param: (typeof DRIFT_PARAMS)[number],
): number {
  switch (param) {
    case 'freqBase':
      return group.osc.freqBase;
    case 'freqStart':
      return group.osc.freqStart;
    case 'slope':
      return group.osc.slope;
    case 'duration':
      return group.osc.duration;
    case 'phase':
      return group.osc.phase;
    case 'ampEnvDuration':
      return group.ampEnv.duration;
    case 'endLevel':
      return group.ampEnv.endLevel ?? MIN;
    case 'ampEnvSlope':
      return group.ampEnv.slope;
    case 'startLevel':
      return group.ampEnv.startLevel;
  }
}

/**
 * Считает дрейф init → final по каждому параметру каждого слота.
 * Осциллятор участвует, только если он активен в финальном патче:
 * выключенные слоты патч хранит обнулёнными, и дрейф по ним
 * бессмыслен.
 */
function computeInitDrift(runs: LoadedRun[]): DriftCell[] {
  const cells = new Map<string, number[]>();

  for (const run of runs) {
    const initVector = run.initVector;
    if (initVector === null) {
      continue;
    }
    run.patch.oscillators.forEach((group, i) => {
      if (!group.osc.on) {
        return;
      }
      const initGroup = mapVectorToSynthConfigForOsc(initVector, i);
      for (const param of DRIFT_PARAMS) {
        const finalValue = readParam(
          { osc: group.osc, ampEnv: group.ampEnv },
          param,
        );
        const drift = Math.abs(
          finalValue - readParam(initGroup, param),
        );
        const key = `${i}:${param}`;
        if (!cells.has(key)) {
          cells.set(key, []);
        }
        (cells.get(key) ?? []).push(drift);
      }
    });
  }

  return [...cells.entries()].map(([key, drifts]) => {
    const [oscIndex, param] = key.split(':');
    const maxDrift = Math.max(...drifts);
    return {
      oscIndex: parseInt(oscIndex ?? '0', 10),
      param: param ?? '',
      activeRuns: drifts.length,
      maxDrift,
      meanDrift: drifts.reduce((a, b) => a + b, 0) / drifts.length,
      artifact: maxDrift < (DRIFT_EPS[param ?? ''] ?? 0),
    };
  });
}

/** Строит markdown-таблицы отчёта. */
function buildMarkdownReport(arg: {
  runs: LoadedRun[];
  verdicts: MetricVerdict[];
  drift: DriftCell[];
}): string {
  const lines: string[] = [];
  lines.push('# Отчёт стабильности датасета');
  lines.push('');
  lines.push(
    `Прогонов: ${arg.runs.length}; таргетов: ${new Set(arg.runs.map((r) => r.slug)).size}.`,
  );
  lines.push('');
  lines.push('## Global suppression по сидам');
  lines.push('');
  lines.push('| Таргет | Среднее | Размах | Прогонов |');
  lines.push('| --- | --- | --- | --- |');
  const bySlug = new Map<string, number[]>();
  for (const run of arg.runs) {
    if (run.globalSuppressionPercent === null) {
      continue;
    }
    if (!bySlug.has(run.slug)) {
      bySlug.set(run.slug, []);
    }
    (bySlug.get(run.slug) ?? []).push(run.globalSuppressionPercent);
  }
  for (const [slug, values] of [...bySlug.entries()].sort()) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const range = Math.max(...values) - Math.min(...values);
    lines.push(
      `| ${slug} | ${mean.toFixed(2)}% | ${range.toFixed(2)} п.п. | ${values.length} |`,
    );
  }
  lines.push('');
  lines.push('## Стабильность метрик уровня прогона');
  lines.push('');
  lines.push(
    '| Метрика | Разброс внутри (средн.) | Разброс внутри (макс.) | Разброс между | Вердикт |',
  );
  lines.push('| --- | --- | --- | --- | --- |');
  for (const v of arg.verdicts) {
    lines.push(
      `| ${v.name} | ${v.withinMeanRange.toFixed(3)} | ${v.withinMaxRange.toFixed(3)} | ${v.betweenRange.toFixed(3)} | ${v.verdict} |`,
    );
  }
  lines.push('');
  lines.push('## Параметры, которые init не двигает (по слотам)');
  lines.push('');
  const artifacts = arg.drift
    .filter((d) => d.artifact)
    .sort((a, b) => a.oscIndex - b.oscIndex);
  lines.push(
    `Слотов с max-дрейфом ниже порога: ${artifacts.length} из ${arg.drift.length}.`,
  );
  lines.push('');
  const byParam = new Map<string, number>();
  for (const cell of artifacts) {
    byParam.set(cell.param, (byParam.get(cell.param) ?? 0) + 1);
  }
  lines.push('| Параметр | Слотов-«замороженных» | Порог |');
  lines.push('| --- | --- | --- |');
  for (const param of DRIFT_PARAMS) {
    lines.push(
      `| ${param} | ${byParam.get(param) ?? 0} | ${DRIFT_EPS[param]} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Точка входа: грузит прогоны, считает анализы, пишет отчёты. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const datasetIdx = argv.indexOf('--dataset');
  const datasetArg =
    datasetIdx >= 0 ? argv[datasetIdx + 1] : undefined;
  if (datasetArg === undefined) {
    throw new Error('Usage: --dataset <dir>');
  }
  const datasetDir = resolve(datasetArg);

  const runs = await loadCompletedRuns(datasetDir);
  console.log(`REPORT loaded ${runs.length} completed runs`);

  const verdicts = collectScalarMetrics(runs).map(classifyMetric);
  const drift = computeInitDrift(runs);

  await writeAtomic(
    join(datasetDir, 'stability.json'),
    JSON.stringify({ verdicts, drift }, null, 2),
  );
  await writeAtomic(
    join(datasetDir, 'stability.md'),
    buildMarkdownReport({ runs, verdicts, drift }),
  );
  console.log(
    `REPORT wrote stability.json and stability.md to ${datasetDir}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
