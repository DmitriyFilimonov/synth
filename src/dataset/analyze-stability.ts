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
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MIN } from '../envelope';
import { type ArgCreateSynth } from '../synth';
import { mapVectorToSynthConfigForOsc } from '../vector-to-synth-config';
import {
  quantile,
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

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

/** Срез run.json, который читает этот анализ. */
interface RunRecordSlice {
  status: string;
  seed: number;
  suppressionPercent: number | null;
  globalSuppressionPercent: number | null;
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

/**
 * Дескриптор параметра дрейфа: как его прочитать и каков порог
 * «не двигается» в денормализованных единицах. Одна таблица вместо
 * связанных switch и Record порогов (замечание ревизии декомпозиции).
 */
interface DriftParamDescriptor {
  read: (source: OscParamSource) => number;
  eps: number;
}

/** Таблица дескрипторов девяти оптимизируемых параметров. */
const DRIFT_PARAM_DESCRIPTORS: Record<string, DriftParamDescriptor> =
  {
    freqBase: { read: (s) => s.osc.freqBase, eps: 0.5 },
    freqStart: { read: (s) => s.osc.freqStart, eps: 0.5 },
    slope: { read: (s) => s.osc.slope, eps: 0.02 },
    duration: { read: (s) => s.osc.duration, eps: 0.005 },
    phase: { read: (s) => s.osc.phase, eps: 0.05 },
    ampEnvDuration: { read: (s) => s.ampEnv.duration, eps: 0.005 },
    endLevel: { read: (s) => s.ampEnv.endLevel ?? MIN, eps: 0.002 },
    ampEnvSlope: { read: (s) => s.ampEnv.slope, eps: 0.02 },
    startLevel: { read: (s) => s.ampEnv.startLevel, eps: 0.005 },
  };

/** Имена параметров дрейфа в порядке обхода таблицы. */
const DRIFT_PARAMS = Object.keys(DRIFT_PARAM_DESCRIPTORS);

/**
 * Загружает один прогон: run.json, patch.json, features.json.
 * Возвращает null для незавершённых и битых прогонов (их время
 * ещё не пришло — анализ терпим к неполному датасету).
 */
async function loadRun(arg: {
  slug: string;
  seedDir: string;
  runDir: string;
  initVector: number[] | null;
}): Promise<LoadedRun | null> {
  const label = `${arg.slug}/${arg.seedDir}`;
  const run = await readJsonOrNull<RunRecordSlice>(
    join(arg.runDir, 'run.json'),
  );
  if (run === null || run.status !== 'completed') {
    return null;
  }
  const patch = await readJsonOrNull<ArgCreateSynth>(
    join(arg.runDir, 'patch.json'),
  );
  if (patch === null) {
    console.log(`WARN ${label}: no patch.json, skipped`);
    return null;
  }
  const features = await readJsonOrNull<RunFeatures>(
    join(arg.runDir, 'features.json'),
  );
  if (features === null) {
    console.log(`WARN ${label}: no features.json, scalar limited`);
  }
  return {
    slug: arg.slug,
    seed: run.seed,
    suppressionPercent: run.suppressionPercent,
    globalSuppressionPercent: run.globalSuppressionPercent,
    patch,
    initVector: arg.initVector,
    features,
  };
}

/** Обходит каталог датасета и загружает все завершённые прогоны. */
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
    const initVector = await readJsonOrNull<number[]>(
      join(slugDir, 'init-vector.json'),
    );
    const seedDirs = readdirSync(slugDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('seed-'))
      .map((d) => d.name)
      .sort();
    for (const seedDir of seedDirs) {
      const run = await loadRun({
        slug,
        seedDir,
        runDir: join(slugDir, seedDir),
        initVector,
      });
      if (run !== null) {
        runs.push(run);
      }
    }
  }
  return runs;
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
    add(
      'freqBase_p10',
      run.slug,
      quantile(
        oscs.map((o) => o.freqBase),
        0.1,
      ),
    );
    add(
      'freqBase_p50',
      run.slug,
      quantile(
        oscs.map((o) => o.freqBase),
        0.5,
      ),
    );
    add(
      'freqStartToBase_p50',
      run.slug,
      quantile(
        oscs.map((o) => o.freqStartToBase),
        0.5,
      ),
    );
    add(
      'freqStartToBase_p90',
      run.slug,
      quantile(
        oscs.map((o) => o.freqStartToBase),
        0.9,
      ),
    );
    add(
      'ampEnvDuration_p50',
      run.slug,
      quantile(
        oscs.map((o) => o.ampEnvDurationSec),
        0.5,
      ),
    );
    add(
      'ampStartLevel_p90',
      run.slug,
      quantile(
        oscs.map((o) => o.ampStartLevel),
        0.9,
      ),
    );
    add(
      'decayDb20_p50',
      run.slug,
      quantile(
        oscs
          .map((o) => o.decaySecToDb.db20)
          .filter((d): d is number => d !== null),
        0.5,
      ),
    );
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
        const descriptor = DRIFT_PARAM_DESCRIPTORS[param];
        if (descriptor === undefined) {
          continue;
        }
        const drift = Math.abs(
          descriptor.read(group) - descriptor.read(initGroup),
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
    const eps = DRIFT_PARAM_DESCRIPTORS[param ?? '']?.eps ?? 0;
    return {
      oscIndex: parseInt(oscIndex ?? '0', 10),
      param: param ?? '',
      activeRuns: drifts.length,
      maxDrift,
      meanDrift: drifts.reduce((a, b) => a + b, 0) / drifts.length,
      artifact: maxDrift < eps,
    };
  });
}

/** Секция отчёта: global suppression по сидам каждого таргета. */
function formatSuppressionBySeedSection(runs: LoadedRun[]): string[] {
  const bySlug = new Map<string, number[]>();
  for (const run of runs) {
    if (run.globalSuppressionPercent === null) {
      continue;
    }
    if (!bySlug.has(run.slug)) {
      bySlug.set(run.slug, []);
    }
    (bySlug.get(run.slug) ?? []).push(run.globalSuppressionPercent);
  }
  const lines = ['## Global suppression по сидам', ''];
  lines.push('| Таргет | Среднее | Размах | Прогонов |');
  lines.push('| --- | --- | --- | --- |');
  for (const [slug, values] of [...bySlug.entries()].sort()) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const range = Math.max(...values) - Math.min(...values);
    lines.push(
      `| ${slug} | ${mean.toFixed(2)}% | ${range.toFixed(2)} п.п. | ${values.length} |`,
    );
  }
  return lines;
}

/** Секция отчёта: вердикты стабильности метрик уровня прогона. */
function formatVerdictSection(verdicts: MetricVerdict[]): string[] {
  const lines = ['## Стабильность метрик уровня прогона', ''];
  lines.push(
    '| Метрика | Разброс внутри (средн.) | Разброс внутри (макс.) | Разброс между | Вердикт |',
  );
  lines.push('| --- | --- | --- | --- | --- |');
  for (const v of verdicts) {
    lines.push(
      `| ${v.name} | ${v.withinMeanRange.toFixed(3)} | ${v.withinMaxRange.toFixed(3)} | ${v.betweenRange.toFixed(3)} | ${v.verdict} |`,
    );
  }
  return lines;
}

/** Секция отчёта: параметры-артефакты init по типам. */
function formatArtifactSection(drift: DriftCell[]): string[] {
  const artifacts = drift.filter((d) => d.artifact);
  const byParam = new Map<string, number>();
  for (const cell of artifacts) {
    byParam.set(cell.param, (byParam.get(cell.param) ?? 0) + 1);
  }
  const lines = [
    '## Параметры, которые init не двигает (по слотам)',
    '',
  ];
  lines.push(
    `Слотов с max-дрейфом ниже порога: ${artifacts.length} из ${drift.length}.`,
  );
  lines.push('');
  lines.push('| Параметр | Слотов-«замороженных» | Порог |');
  lines.push('| --- | --- | --- |');
  for (const param of DRIFT_PARAMS) {
    const eps = DRIFT_PARAM_DESCRIPTORS[param]?.eps ?? 0;
    lines.push(`| ${param} | ${byParam.get(param) ?? 0} | ${eps} |`);
  }
  return lines;
}

/** Собирает markdown-отчёт из секций. */
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
  lines.push(...formatSuppressionBySeedSection(arg.runs));
  lines.push('');
  lines.push(...formatVerdictSection(arg.verdicts));
  lines.push('');
  lines.push(...formatArtifactSection(arg.drift));
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

  await writeJsonAtomic(join(datasetDir, 'stability.json'), {
    verdicts,
    drift,
  });
  await writeTextAtomic(
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
