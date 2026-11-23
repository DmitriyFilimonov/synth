/* eslint-disable no-console */
/**
 * Парный screening K1 против K2 на готовых match-прогонах.
 * Оба режима стартуют с одного patch и используют один словарь.
 * Новый coordinate descent не запускается, production-сервис не меняется.
 * Результат screening не доказывает закон T35.
 *
 * npx tsx src/dataset/block-pursuit-run.ts \
 *   --dataset datasets/ref --out datasets/block-screen
 */
import { mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareCharacter } from '../character-metrics';
import { readWav } from '../read-wav';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { compareWaveformBands } from '../waveform-bands';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  MAX_BLOCKS,
  pursueResidualBlocks,
  type BlockPursuitResult,
  type PursuitBlockSize,
} from './block-pursuit';
import { withAttackBoost } from './quadrature-refit-run';
import {
  quantile,
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

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

interface BlockScreeningOptions {
  dataset: string;
  outDir: string;
  slugs: string[];
  maxBlocks: number;
  diverseShortlist: boolean;
}

interface BlockRunError {
  slug: string;
  seed: number;
  message: string;
}

interface ModeRunReport {
  blockSize: PursuitBlockSize;
  status: BlockPursuitResult['status'];
  patch: string;
  wav: string;
  baselineGlobalSuppressionPercent: number;
  globalSuppressionPercent: number;
  globalDelta: number;
  baselineWindowedSuppressionPercent: number;
  windowedSuppressionPercent: number;
  windowedDelta: number;
  blocks: number;
  replacements: number;
  durationMs: number;
  localEvaluations: number;
  jointEvaluations: number;
  exactEvaluations: number;
  basisRenders: number;
  slotSetsEvaluated: number;
  character: ReturnType<typeof compareCharacter>;
  bands: ReturnType<typeof compareWaveformBands>;
}

interface PairedBlockRun {
  slug: string;
  seed: number;
  sourceRunDir: string;
  savedGlobalSuppressionPercent: number | null;
  k1: ModeRunReport;
  k2: ModeRunReport;
  pairGlobalDelta: number;
}

interface BlockTargetSummary {
  slug: string;
  runs: number;
  k1MeanGlobalDelta: number;
  k2MeanGlobalDelta: number;
  meanPairGlobalDelta: number;
  medianPairGlobalDelta: number | null;
  sampleSdPairGlobalDelta: number | null;
  k1Improved: number;
  k2Improved: number;
  k2Wins: number;
  k2PassesScreen: boolean;
}

interface BlockReport {
  version: 1;
  createdAt: string;
  dataset: string;
  phaseModel: PhaseModel;
  attackBoost: number;
  maxBlocks: number;
  k1MaxBlocks: number;
  diverseShortlist: boolean;
  finished: boolean;
  errors: BlockRunError[];
  runs: PairedBlockRun[];
  summaries: BlockTargetSummary[];
}

/** Среднее непустого числового ряда; пустой ряд даёт ноль. */
function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
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

/**
 * Сводит парную разницу K2−K1 и проверяет порог продолжения.
 *
 * @param slug - Слаг таргета
 * @param runs - Парные результаты доступных сидов этого таргета
 * @returns Средние приросты, разброс K2−K1 и итог screening
 * @remarks K2 проходит screening только на четырёх прогонах при среднем
 *   приросте не меньше 0.5 п.п. и минимум двух улучшенных сидах. Этот
 *   порог разрешает следующий эксперимент, но не доказывает закон T35.
 */
export function summarizeBlockTarget(
  slug: string,
  runs: PairedBlockRun[],
): BlockTargetSummary {
  const pair = runs.map((run) => run.pairGlobalDelta);
  const k2MeanGlobalDelta = mean(
    runs.map((run) => run.k2.globalDelta),
  );
  const k2Improved = runs.filter(
    (run) => run.k2.status === 'refined' && run.k2.globalDelta > 0,
  ).length;
  return {
    slug,
    runs: runs.length,
    k1MeanGlobalDelta: mean(runs.map((run) => run.k1.globalDelta)),
    k2MeanGlobalDelta,
    meanPairGlobalDelta: mean(pair),
    medianPairGlobalDelta: quantile(pair, 0.5),
    sampleSdPairGlobalDelta: sampleSd(pair),
    k1Improved: runs.filter(
      (run) => run.k1.status === 'refined' && run.k1.globalDelta > 0,
    ).length,
    k2Improved,
    k2Wins: runs.filter((run) => run.pairGlobalDelta > 1e-9).length,
    k2PassesScreen:
      runs.length === 4 &&
      k2MeanGlobalDelta >= 0.5 &&
      k2Improved >= 2,
  };
}

/** Атомарно сохраняет patch и обязательный WAV одного режима. */
async function saveModeArtifacts(arg: {
  directory: string;
  result: BlockPursuitResult;
  sampleRate: number;
}): Promise<{ patch: string; wav: string }> {
  mkdirSync(arg.directory, { recursive: true });
  const patch = join(arg.directory, 'patch.json');
  const wav = join(arg.directory, 'result.wav');
  await writeJsonAtomic(patch, arg.result.patch);
  writeWav({
    samples: arg.result.samples,
    sampleRate: arg.sampleRate,
    filePath: `${wav}.tmp`,
  });
  await rename(`${wav}.tmp`, wav);
  return { patch, wav };
}

/** Запускает один режим и проверяет его канонический WAV. */
function executeBlockMode(arg: {
  patch: ArgCreateSynth;
  target: Int16Array;
  sampleRate: number;
  phaseModel: PhaseModel;
  blockSize: PursuitBlockSize;
  maxBlocks: number;
  diverseShortlist: boolean;
}): { result: BlockPursuitResult; durationMs: number } {
  const started = Date.now();
  const result = pursueResidualBlocks(arg);
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    arg.phaseModel,
    arg.sampleRate,
    arg.target.length,
  );
  return { result, durationMs: Date.now() - started };
}

/** Строит DTO режима и измеряет характер итогового WAV. */
function createModeRunReport(arg: {
  result: BlockPursuitResult;
  target: Int16Array;
  sampleRate: number;
  blockSize: PursuitBlockSize;
  durationMs: number;
  artifacts: { patch: string; wav: string };
}): ModeRunReport {
  const { result } = arg;
  return {
    blockSize: arg.blockSize,
    status: result.status,
    ...arg.artifacts,
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
    blocks: result.steps.length,
    replacements: result.replacementCount,
    durationMs: arg.durationMs,
    localEvaluations: result.localEvaluations,
    jointEvaluations: result.jointEvaluations,
    exactEvaluations: result.exactEvaluations,
    basisRenders: result.basisRenders,
    slotSetsEvaluated: result.slotSetsEvaluated,
    character: compareCharacter(
      arg.target,
      result.samples,
      arg.sampleRate,
    ),
    bands: compareWaveformBands(
      arg.target,
      result.samples,
      arg.sampleRate,
    ),
  };
}

/** Сохраняет расширенный аудит одного выполненного режима. */
async function saveModeAudit(arg: {
  directory: string;
  report: ModeRunReport;
  result: BlockPursuitResult;
  maxBlocks: number;
  diverseShortlist: boolean;
}): Promise<void> {
  await writeJsonAtomic(join(arg.directory, 'audit.json'), {
    ...arg.report,
    algorithm: 'block-pursuit',
    blockSize: arg.report.blockSize,
    maxBlocks: arg.maxBlocks,
    diverseShortlist: arg.diverseShortlist,
    steps: arg.result.steps,
  });
}

/** Выполняет один режим и связывает его артефакты, отчёт и аудит. */
async function processMode(arg: {
  patch: ArgCreateSynth;
  target: Int16Array;
  sampleRate: number;
  phaseModel: PhaseModel;
  blockSize: PursuitBlockSize;
  maxBlocks: number;
  diverseShortlist: boolean;
  directory: string;
}): Promise<ModeRunReport> {
  const executed = executeBlockMode(arg);
  const artifacts = await saveModeArtifacts({
    directory: arg.directory,
    result: executed.result,
    sampleRate: arg.sampleRate,
  });
  const report = createModeRunReport({
    result: executed.result,
    target: arg.target,
    sampleRate: arg.sampleRate,
    blockSize: arg.blockSize,
    durationMs: executed.durationMs,
    artifacts,
  });
  await saveModeAudit({
    directory: arg.directory,
    report,
    result: executed.result,
    maxBlocks: arg.maxBlocks,
    diverseShortlist: arg.diverseShortlist,
  });
  return report;
}

/** Читает completed match и проверяет исходный patch против его WAV. */
async function loadVerifiedMatchRun(arg: {
  dataset: string;
  slug: string;
  seed: number;
  targetsDir: string;
  phaseModel: PhaseModel;
}): Promise<{
  sourceRunDir: string;
  record: RunRecord;
  patch: ArgCreateSynth;
  target: ReturnType<typeof readWav>;
} | null> {
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
  return { sourceRunDir, record, patch, target };
}

/**
 * Запускает K1 и K2 от одного проверенного исходника.
 *
 * @param arg - Координаты исходного match и общие параметры поиска
 * @returns Парный отчёт либо `null` для незавершённого исходного match
 * @remarks K1 получает вдвое больше блоков, чем K2. Поэтому оба режима
 *   могут заменить не более `2 * maxBlocks` слотов. Так сравнение
 *   получает равный предел замен при разном числе блоков.
 */
async function processPair(arg: {
  dataset: string;
  slug: string;
  seed: number;
  targetsDir: string;
  phaseModel: PhaseModel;
  outDir: string;
  maxBlocks: number;
  diverseShortlist: boolean;
}): Promise<PairedBlockRun | null> {
  const source = await loadVerifiedMatchRun(arg);
  if (source === null) {
    return null;
  }
  const common = {
    patch: source.patch,
    target: source.target.samples,
    sampleRate: source.target.sampleRate,
    phaseModel: arg.phaseModel,
    maxBlocks: arg.maxBlocks,
    diverseShortlist: arg.diverseShortlist,
  };
  const pairDir = join(arg.outDir, arg.slug, `seed-${arg.seed}`);
  const k1 = await processMode({
    ...common,
    maxBlocks: arg.maxBlocks * 2,
    blockSize: 1,
    directory: join(pairDir, 'k1'),
  });
  const k2 = await processMode({
    ...common,
    maxBlocks: arg.maxBlocks,
    blockSize: 2,
    directory: join(pairDir, 'k2'),
  });
  if (
    k1.baselineGlobalSuppressionPercent !==
      k2.baselineGlobalSuppressionPercent ||
    k1.baselineWindowedSuppressionPercent !==
      k2.baselineWindowedSuppressionPercent
  ) {
    throw new Error(`K1 и K2 получили разные baseline в ${pairDir}`);
  }
  return {
    slug: arg.slug,
    seed: arg.seed,
    sourceRunDir: source.sourceRunDir,
    savedGlobalSuppressionPercent:
      source.record.globalSuppressionPercent ?? null,
    k1,
    k2,
    pairGlobalDelta:
      k2.globalSuppressionPercent - k1.globalSuppressionPercent,
  };
}

/**
 * Возвращает Markdown с абсолютными global и парной разницей K2−K1.
 *
 * @param runs - Парные результаты по таргетам и сидам
 * @param summaries - Сводки, рассчитанные по этим результатам
 * @param maxBlocks - Бюджет пар K2; K1 получает удвоенный бюджет блоков
 * @returns Текст отчёта с детальными строками и порогом продолжения
 * @remarks Отчёт фиксирует равный предел замен у K1 и K2. Он описывает
 *   offline-диагностику, не подключение к production и не доказательство
 *   закона T35.
 */
export function renderBlockReportMarkdown(
  runs: PairedBlockRun[],
  summaries: BlockTargetSummary[],
  maxBlocks: number,
): string {
  const lines = [
    '# Screening совместного K=2 residual pursuit',
    '',
    `K1 и K2 стартуют с одного match и используют один словарь v3. K1 выполняет до ${maxBlocks * 2} одиночных блоков, K2 — до ${maxBlocks} пар с общим МНК 4×4, поэтому оба могут заменить не более ${maxBlocks * 2} слотов. Оба проверяют несколько слотов и принимают только полный global/J guard. Это offline-диагностика, не закон T35 и не подключение к production.`,
    '',
    '| Таргет | Сид | Global до | K1 после | K1 Δ | K2 после | K2 Δ | K2−K1 | K1 с | K2 с |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const run of runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${run.k1.baselineGlobalSuppressionPercent.toFixed(2)} | ${run.k1.globalSuppressionPercent.toFixed(2)} | ${run.k1.globalDelta.toFixed(3)} | ${run.k2.globalSuppressionPercent.toFixed(2)} | ${run.k2.globalDelta.toFixed(3)} | ${run.pairGlobalDelta.toFixed(3)} | ${(run.k1.durationMs / 1000).toFixed(1)} | ${(run.k2.durationMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push(
    '',
    '| Таргет | Прогонов | K1 среднее Δ | K2 среднее Δ | K2−K1 среднее | K1 улучшено | K2 улучшено | K2 выигрышей | K2 проходит screening |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  for (const summary of summaries) {
    lines.push(
      `| ${summary.slug} | ${summary.runs} | ${summary.k1MeanGlobalDelta.toFixed(3)} | ${summary.k2MeanGlobalDelta.toFixed(3)} | ${summary.meanPairGlobalDelta.toFixed(3)} | ${summary.k1Improved} | ${summary.k2Improved} | ${summary.k2Wins} | ${summary.k2PassesScreen ? 'да' : 'нет'} |`,
    );
  }
  lines.push(
    '',
    'Порог продолжения: четыре прогона, средний прирост K2 не меньше 0.5 п.п. и минимум два улучшенных сида. Он разрешает следующий эксперимент, но не доказывает общий эффект или путь к 98%.',
    '',
  );
  return lines.join('\n');
}

/** Строит текущий отчёт и используется после каждого сида как чекпоинт. */
function makeReport(arg: {
  options: BlockScreeningOptions;
  manifest: DatasetManifest;
  runs: PairedBlockRun[];
  errors: BlockRunError[];
  finished: boolean;
}): BlockReport {
  const { options, manifest } = arg;
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    dataset: options.dataset,
    phaseModel: manifest.phaseModel ?? 'legacy',
    attackBoost: manifest.attackBoost ?? 1,
    maxBlocks: options.maxBlocks,
    k1MaxBlocks: options.maxBlocks * 2,
    diverseShortlist: options.diverseShortlist,
    finished: arg.finished,
    errors: arg.errors,
    runs: arg.runs,
    summaries: options.slugs.map((slug) =>
      summarizeBlockTarget(
        slug,
        arg.runs.filter((run) => run.slug === slug),
      ),
    ),
  };
}

/** Атомарно обновляет JSON и Markdown текущего состояния прогона. */
async function checkpoint(
  outDir: string,
  report: BlockReport,
): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await writeJsonAtomic(join(outDir, 'report.json'), report);
  await writeTextAtomic(
    join(outDir, 'report.md'),
    renderBlockReportMarkdown(
      report.runs,
      report.summaries,
      report.maxBlocks,
    ),
  );
}

/** Разбирает и проверяет аргументы CLI без запуска вычислений. */
function parseBlockPursuitArgs(
  args: string[],
): BlockScreeningOptions {
  const options: BlockScreeningOptions = {
    dataset: '',
    outDir: '',
    slugs: ['BOg-Disco-Futuro', 'GrumU'],
    maxBlocks: 1,
    diverseShortlist: true,
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--dataset') {
      options.dataset = resolve(value);
    } else if (key === '--out') {
      options.outDir = resolve(value);
    } else if (key === '--slugs') {
      options.slugs = value.split(',').filter(Boolean);
    } else if (key === '--blocks') {
      options.maxBlocks = Number(value);
    } else if (key === '--diverse') {
      if (value !== '0' && value !== '1') {
        throw new Error('--diverse должен быть 0 или 1');
      }
      options.diverseShortlist = value === '1';
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (options.dataset === '' || options.outDir === '') {
    throw new Error(
      'Usage: block-pursuit-run --dataset DIR --out DIR [--slugs a,b] [--blocks 1] [--diverse 1]',
    );
  }
  if (
    !Number.isInteger(options.maxBlocks) ||
    options.maxBlocks < 1 ||
    options.maxBlocks > MAX_BLOCKS / 2
  ) {
    throw new Error(
      `--blocks должен быть целым от 1 до ${MAX_BLOCKS / 2}`,
    );
  }
  return options;
}

/** Читает обязательный manifest датасета. */
async function readBlockDatasetManifest(
  dataset: string,
): Promise<DatasetManifest> {
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(dataset, 'manifest.json'),
  );
  if (manifest === null) {
    throw new Error(`Нет manifest.json в ${dataset}`);
  }
  return manifest;
}

/** Последовательно обрабатывает сиды и сохраняет чекпоинт после каждого. */
async function runBlockScreening(
  options: BlockScreeningOptions,
  manifest: DatasetManifest,
): Promise<BlockReport> {
  const runs: PairedBlockRun[] = [];
  const errors: BlockRunError[] = [];
  for (const slug of options.slugs) {
    for (const seed of [1, 2, 3, 4]) {
      try {
        const run = await processPair({
          dataset: options.dataset,
          slug,
          seed,
          targetsDir: manifest.targetsDir,
          phaseModel: manifest.phaseModel ?? 'legacy',
          outDir: options.outDir,
          maxBlocks: options.maxBlocks,
          diverseShortlist: options.diverseShortlist,
        });
        if (run === null) {
          console.log(`SKIP ${slug}/seed-${seed}: not completed`);
        } else {
          runs.push(run);
          console.log(
            `RESULT ${slug} seed=${seed} ` +
              `K1=${run.k1.globalDelta.toFixed(3)} K2=${run.k2.globalDelta.toFixed(3)} ` +
              `pair=${run.pairGlobalDelta.toFixed(3)} ` +
              `K1status=${run.k1.status} K2status=${run.k2.status} ` +
              `seconds=${((run.k1.durationMs + run.k2.durationMs) / 1000).toFixed(1)}`,
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        errors.push({ slug, seed, message });
        console.warn(`WARN ${slug}/seed-${seed}: ${message}`);
      }
      await checkpoint(
        options.outDir,
        makeReport({
          options,
          manifest,
          runs,
          errors,
          finished: false,
        }),
      );
    }
  }
  const report = makeReport({
    options,
    manifest,
    runs,
    errors,
    finished: true,
  });
  await checkpoint(options.outDir, report);
  return report;
}

/** Печатает итоговые сводки и число ошибок выполненного screening. */
function printBlockScreeningSummary(report: BlockReport): void {
  for (const summary of report.summaries) {
    console.log(
      `SUMMARY ${summary.slug} runs=${summary.runs} ` +
        `K1=${summary.k1MeanGlobalDelta.toFixed(3)} K2=${summary.k2MeanGlobalDelta.toFixed(3)} ` +
        `pair=${summary.meanPairGlobalDelta.toFixed(3)} ` +
        `K1improved=${summary.k1Improved} K2improved=${summary.k2Improved} ` +
        `pass=${summary.k2PassesScreen}`,
    );
  }
  console.log(
    `REPORT runs=${report.runs.length} errors=${report.errors.length}`,
  );
}

/** Связывает CLI, manifest, attackBoost и парный screening. */
async function main(): Promise<void> {
  const options = parseBlockPursuitArgs(process.argv.slice(2));
  const manifest = await readBlockDatasetManifest(options.dataset);
  const report = await withAttackBoost(
    manifest.attackBoost ?? 1,
    () => runBlockScreening(options, manifest),
  );
  printBlockScreeningSummary(report);
  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
