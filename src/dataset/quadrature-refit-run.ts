/* eslint-disable no-console */
/**
 * Парный offline A/B квадратурного refit на готовых match-прогонах.
 * Не запускает coordinate descent. По умолчанию обрабатывает BOg и
 * GrumU seeds 1–4 и сохраняет patch, WAV, аудит и сводку по таргетам.
 *
 * npx tsx src/dataset/quadrature-refit-run.ts --dataset datasets/ref --out datasets/refit
 */
import { mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { attackWeighting } from '../optimize/evaluate';
import { compareCharacter } from '../character-metrics';
import { readWav } from '../read-wav';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { compareWaveformBands } from '../waveform-bands';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  pursueResidualAtoms,
  type PursuitResult,
} from './matching-pursuit';
import {
  refitPatchQuadratures,
  type QuadratureRefitResult,
} from './quadrature-refit';
import {
  quantile,
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

type PostPassMode = 'refit' | 'pursuit';
type PostPassResult = QuadratureRefitResult | PursuitResult;

interface DatasetManifest {
  targetsDir: string;
  phaseModel?: PhaseModel;
  attackBoost?: number;
}

interface RunRecord {
  status: string;
  target: string;
  globalSuppressionPercent?: number | null;
}

interface RefitRunReport {
  slug: string;
  seed: number;
  status: PostPassResult['status'];
  sourceRunDir: string;
  patch: string;
  wav: string;
  savedGlobalSuppressionPercent: number | null;
  baselineGlobalSuppressionPercent: number;
  globalSuppressionPercent: number;
  globalDelta: number;
  baselineWindowedSuppressionPercent: number;
  windowedSuppressionPercent: number;
  windowedDelta: number;
  changes: number;
  stagesCompleted: number;
  durationMs: number;
  character: ReturnType<typeof compareCharacter>;
  bands: ReturnType<typeof compareWaveformBands>;
}

interface TargetSummary {
  slug: string;
  runs: number;
  meanGlobalDelta: number;
  medianGlobalDelta: number | null;
  sampleSdGlobalDelta: number | null;
  improved: number;
  meanWindowedDelta: number;
  meanAbove46: boolean;
  atLeastThreeImproved: boolean;
}

/**
 * Временно задаёт attackBoost датасета и возвращает прежнее состояние.
 * Восстановление происходит и после ошибки внутри action.
 */
export async function withAttackBoost<T>(
  boost: number,
  action: () => T | Promise<T>,
): Promise<T> {
  if (!Number.isFinite(boost) || boost < 0) {
    throw new Error(
      'attackBoost должен быть конечным и неотрицательным',
    );
  }
  const previous = attackWeighting.boost;
  attackWeighting.boost = boost;
  try {
    return await action();
  } finally {
    attackWeighting.boost = previous;
  }
}

/** Среднее непустого числового ряда. */
function mean(values: number[]): number {
  return (
    values.reduce((sum, value) => sum + value, 0) / values.length
  );
}

/** Выборочное SD; один или ноль наблюдений дают null. */
function sampleSd(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const center = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
      (values.length - 1),
  );
}

/** Сводит только парные разницы одного таргета, без объединения таргетов. */
export function summarizeRefitTarget(
  slug: string,
  runs: RefitRunReport[],
): TargetSummary {
  const global = runs.map((run) => run.globalDelta);
  const windowed = runs.map((run) => run.windowedDelta);
  const meanGlobalDelta = global.length > 0 ? mean(global) : 0;
  const improved = runs.filter(
    (run) => run.status === 'refined' && run.globalDelta > 0,
  ).length;
  return {
    slug,
    runs: runs.length,
    meanGlobalDelta,
    medianGlobalDelta: quantile(global, 0.5),
    sampleSdGlobalDelta: sampleSd(global),
    improved,
    meanWindowedDelta: windowed.length > 0 ? mean(windowed) : 0,
    meanAbove46: runs.length === 4 && meanGlobalDelta > 4.6,
    atLeastThreeImproved: runs.length === 4 && improved >= 3,
  };
}

/** Атомарно сохраняет главный patch и обязательный WAV одного сида. */
async function saveRunArtifacts(arg: {
  outRunDir: string;
  result: PostPassResult;
  sampleRate: number;
}): Promise<{ patch: string; wav: string }> {
  mkdirSync(arg.outRunDir, { recursive: true });
  const patch = join(arg.outRunDir, 'patch.json');
  const wav = join(arg.outRunDir, 'result.wav');
  await writeJsonAtomic(patch, arg.result.patch);
  writeWav({
    samples: arg.result.samples,
    sampleRate: arg.sampleRate,
    filePath: `${wav}.tmp`,
  });
  await rename(`${wav}.tmp`, wav);
  return { patch, wav };
}

/** Обрабатывает один completed match и сохраняет его кандидат. */
async function processRun(arg: {
  dataset: string;
  slug: string;
  seed: number;
  targetsDir: string;
  phaseModel: PhaseModel;
  outDir: string;
  maxPasses: number;
  mode: PostPassMode;
  maxSteps: number;
  diverseShortlist: boolean;
}): Promise<RefitRunReport | null> {
  const sourceRunDir = join(
    arg.dataset,
    arg.slug,
    `seed-${arg.seed}`,
  );
  const record = await readJsonOrNull<RunRecord>(
    join(sourceRunDir, 'run.json'),
  );
  if (record?.status !== 'completed') {
    return null;
  }
  const patch = await readJsonOrNull<ArgCreateSynth>(
    join(sourceRunDir, 'patch.json'),
  );
  if (patch === null) {
    throw new Error(`Нет patch.json в ${sourceRunDir}`);
  }
  const target = readWav(join(arg.targetsDir, record.target));
  const baselineWav = readWav(join(sourceRunDir, 'result.wav'));
  if (target.sampleRate !== baselineWav.sampleRate) {
    throw new Error(`Разные sample rate в ${sourceRunDir}`);
  }
  if (target.samples.length !== baselineWav.samples.length) {
    throw new Error(`Разные длины target/match в ${sourceRunDir}`);
  }
  assertPatchMatchesWav(
    patch,
    baselineWav.samples,
    arg.phaseModel,
    baselineWav.sampleRate,
    target.samples.length,
  );
  const started = Date.now();
  const postPassArg = {
    patch,
    target: target.samples,
    sampleRate: target.sampleRate,
    phaseModel: arg.phaseModel,
  };
  const result: PostPassResult =
    arg.mode === 'pursuit'
      ? pursueResidualAtoms({
          ...postPassArg,
          maxSteps: arg.maxSteps,
          diverseShortlist: arg.diverseShortlist,
        })
      : refitPatchQuadratures({
          ...postPassArg,
          maxPasses: arg.maxPasses,
        });
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    arg.phaseModel,
    target.sampleRate,
    target.samples.length,
  );
  const outRunDir = join(arg.outDir, arg.slug, `seed-${arg.seed}`);
  const artifacts = await saveRunArtifacts({
    outRunDir,
    result,
    sampleRate: target.sampleRate,
  });
  const report: RefitRunReport = {
    slug: arg.slug,
    seed: arg.seed,
    status: result.status,
    sourceRunDir,
    ...artifacts,
    savedGlobalSuppressionPercent:
      record.globalSuppressionPercent ?? null,
    baselineGlobalSuppressionPercent:
      result.baseline.globalSuppressionPercent,
    globalSuppressionPercent: result.metrics.globalSuppressionPercent,
    globalDelta:
      result.metrics.globalSuppressionPercent -
      result.baseline.globalSuppressionPercent,
    baselineWindowedSuppressionPercent:
      result.baseline.windowedSuppressionPercent,
    windowedSuppressionPercent:
      result.metrics.windowedSuppressionPercent,
    windowedDelta:
      result.metrics.windowedSuppressionPercent -
      result.baseline.windowedSuppressionPercent,
    changes:
      'steps' in result ? result.steps.length : result.changes.length,
    stagesCompleted:
      'steps' in result
        ? result.steps.length
        : result.passesCompleted,
    durationMs: Date.now() - started,
    character: compareCharacter(
      target.samples,
      result.samples,
      target.sampleRate,
    ),
    bands: compareWaveformBands(
      target.samples,
      result.samples,
      target.sampleRate,
    ),
  };
  await writeJsonAtomic(join(outRunDir, 'audit.json'), {
    ...report,
    algorithm: arg.mode,
    postPassChanges:
      'changes' in result ? result.changes : result.steps,
  });
  return report;
}

/** Возвращает Markdown с сидами и отдельными критериями по таргетам. */
export function renderRefitReportMarkdown(
  runs: RefitRunReport[],
  summaries: TargetSummary[],
  mode: PostPassMode = 'refit',
): string {
  const lines = [
    mode === 'pursuit'
      ? '# Residual matching pursuit готовых match-патчей'
      : '# Квадратурный refit готовых match-патчей',
    '',
    mode === 'pursuit'
      ? 'Каждый кандидат сравнивается со своим исходным match без нового CD. Pursuit меняет состав в выбранных слотах по полному остатку; это не автоматическая перестройка атаки и не доказательство структурного закона T35.'
      : 'Каждый кандидат сравнивается со своим исходным match. Новый coordinate descent не запускался. Метод меняет только startLevel и phase существующих осцилляторов, поэтому не доказывает структурный закон T35.',
    '',
    '| Таргет | Сид | Статус | Global до | Global после | Δ global | Δ J | Изменений | Секунд |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const run of runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${run.status} | ${run.baselineGlobalSuppressionPercent.toFixed(2)} | ${run.globalSuppressionPercent.toFixed(2)} | ${run.globalDelta.toFixed(3)} | ${run.windowedDelta.toFixed(3)} | ${run.changes} | ${(run.durationMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push(
    '',
    '| Таргет | Прогонов | Среднее Δ global | Медиана | SD | Улучшено | Среднее >4.6 | Минимум 3/4 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  );
  for (const summary of summaries) {
    lines.push(
      `| ${summary.slug} | ${summary.runs} | ${summary.meanGlobalDelta.toFixed(3)} | ${summary.medianGlobalDelta?.toFixed(3) ?? '—'} | ${summary.sampleSdGlobalDelta?.toFixed(3) ?? '—'} | ${summary.improved} | ${summary.meanAbove46 ? 'да' : 'нет'} | ${summary.atLeastThreeImproved ? 'да' : 'нет'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Разбирает CLI и запускает один последовательный парный A/B. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dataset = '';
  let outDir = '';
  let slugs = ['BOg-Disco-Futuro', 'GrumU'];
  const seeds = [1, 2, 3, 4];
  let maxPasses = 2;
  let maxSteps = 12;
  let mode: PostPassMode = 'refit';
  let diverseShortlist = false;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--dataset') {
      dataset = resolve(value);
    } else if (key === '--out') {
      outDir = resolve(value);
    } else if (key === '--slugs') {
      slugs = value.split(',').filter(Boolean);
    } else if (key === '--passes') {
      maxPasses = Number(value);
    } else if (key === '--steps') {
      maxSteps = Number(value);
    } else if (key === '--mode') {
      if (value !== 'refit' && value !== 'pursuit') {
        throw new Error('--mode должен быть refit или pursuit');
      }
      mode = value;
    } else if (key === '--diverse') {
      if (value !== '0' && value !== '1') {
        throw new Error('--diverse должен быть 0 или 1');
      }
      diverseShortlist = value === '1';
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (dataset === '' || outDir === '') {
    throw new Error(
      'Usage: quadrature-refit-run --dataset DIR --out DIR [--slugs a,b] [--mode refit|pursuit] [--passes 2] [--steps 12] [--diverse 0|1]',
    );
  }
  if (
    !Number.isInteger(maxPasses) ||
    maxPasses < 1 ||
    maxPasses > 8
  ) {
    throw new Error('--passes должен быть целым от 1 до 8');
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 48) {
    throw new Error('--steps должен быть целым от 1 до 48');
  }
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(dataset, 'manifest.json'),
  );
  if (manifest === null) {
    throw new Error(`Нет manifest.json в ${dataset}`);
  }
  return withAttackBoost(manifest.attackBoost ?? 1, async () => {
    const phaseModel = manifest.phaseModel ?? 'legacy';
    const runs: RefitRunReport[] = [];
    for (const slug of slugs) {
      for (const seed of seeds) {
        try {
          const run = await processRun({
            dataset,
            slug,
            seed,
            targetsDir: manifest.targetsDir,
            phaseModel,
            outDir,
            maxPasses,
            mode,
            maxSteps,
            diverseShortlist,
          });
          if (run === null) {
            console.log(`SKIP ${slug}/seed-${seed}: not completed`);
            continue;
          }
          runs.push(run);
          console.log(
            `RESULT ${slug} seed=${seed} ${run.status} ` +
              `global=${run.baselineGlobalSuppressionPercent.toFixed(2)}->${run.globalSuppressionPercent.toFixed(2)} ` +
              `delta=${run.globalDelta.toFixed(3)} Jdelta=${run.windowedDelta.toFixed(3)} ` +
              `changes=${run.changes} seconds=${(run.durationMs / 1000).toFixed(1)}`,
          );
        } catch (error) {
          console.warn(
            `WARN ${slug}/seed-${seed}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const summaries = slugs.map((slug) =>
      summarizeRefitTarget(
        slug,
        runs.filter((run) => run.slug === slug),
      ),
    );
    for (const summary of summaries) {
      console.log(
        `SUMMARY ${summary.slug} runs=${summary.runs} meanDelta=${summary.meanGlobalDelta.toFixed(3)} ` +
          `sd=${summary.sampleSdGlobalDelta?.toFixed(3) ?? 'null'} improved=${summary.improved} ` +
          `meanAbove4.6=${summary.meanAbove46} atLeast3=${summary.atLeastThreeImproved}`,
      );
    }
    mkdirSync(outDir, { recursive: true });
    await writeJsonAtomic(join(outDir, 'report.json'), {
      version: 1,
      createdAt: new Date().toISOString(),
      dataset,
      phaseModel,
      attackBoost: manifest.attackBoost ?? 1,
      mode,
      maxPasses,
      maxSteps,
      diverseShortlist,
      runs,
      summaries,
    });
    await writeTextAtomic(
      join(outDir, 'report.md'),
      renderRefitReportMarkdown(runs, summaries, mode),
    );
    console.log(`REPORT ${outDir}: ${runs.length} runs`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
