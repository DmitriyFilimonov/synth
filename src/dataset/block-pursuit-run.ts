/* eslint-disable no-console */
/**
 * Парный screening K1, K2, K2-VP и clip-aware K2-VP на готовых
 * match-прогонах. Все режимы стартуют с одного patch и используют один
 * словарь.
 * Новый coordinate descent не запускается, production-сервис не меняется.
 *
 * npx tsx src/dataset/block-pursuit-run.ts --dataset datasets/ref --out datasets/block-screen
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

interface CandidateMetricsReport {
  globalSuppressionPercent: number;
  windowedSuppressionPercent: number;
  globalDelta: number;
  windowedDelta: number;
}

interface ProposedExactCandidateReport extends CandidateMetricsReport {
  step: number;
  pass: number;
}

interface SavedResultReport extends CandidateMetricsReport {
  status: BlockPursuitResult['status'];
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
  variableProjection: boolean;
  clipAwareNavigation: boolean;
  clipObjectiveEvaluations: number;
  proposedExact: ProposedExactCandidateReport | null;
  saved: SavedResultReport;
  variableProjectionAudit?: BlockPursuitResult['variableProjection'];
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
  k2Vp: ModeRunReport;
  k2VpClip: ModeRunReport;
  pairGlobalDelta: number;
  vpMinusK2: number;
  vpMinusK1: number;
  rawVpMinusClipVpProposedGlobal: number | null;
  rawVpMinusClipVpProposedWindowed: number | null;
  rawVpMinusClipVpSavedGlobal: number;
  rawVpMinusClipVpSavedWindowed: number;
}

interface BlockTargetSummary {
  slug: string;
  runs: number;
  k1MeanGlobalDelta: number;
  k2MeanGlobalDelta: number;
  k2VpMeanGlobalDelta: number;
  k2VpClipMeanGlobalDelta: number;
  meanRawVpMinusClipVpSavedGlobal: number;
  meanPairGlobalDelta: number;
  meanVpMinusK2: number;
  meanVpMinusK1: number;
  medianPairGlobalDelta: number | null;
  sampleSdPairGlobalDelta: number | null;
  k1Improved: number;
  k2Improved: number;
  k2VpImproved: number;
  k2VpClipImproved: number;
  k2Wins: number;
  k2VpWinsAgainstK2: number;
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
 * Сводит результаты K1, K2, K2-VP и clip-aware K2-VP по таргету.
 *
 * @param slug - Имя таргета в датасете
 * @param runs - Парные прогоны всех доступных сидов этого таргета
 * @returns Средние приросты, различия режимов и итог screening для K2
 * @remarks `k2PassesScreen` по-прежнему проверяет только обычный K2:
 *   четыре сида, средний прирост не меньше 0.5 п.п. и минимум два
 *   улучшенных сида. Метрики VP описывают эксперимент и не меняют
 *   этот порог.
 */
export function summarizeBlockTarget(
  slug: string,
  runs: PairedBlockRun[],
): BlockTargetSummary {
  const pair = runs.map((run) => run.pairGlobalDelta);
  const k2MeanGlobalDelta = mean(
    runs.map((run) => run.k2.globalDelta),
  );
  const k2VpMeanGlobalDelta = mean(
    runs.map((run) => run.k2Vp.globalDelta),
  );
  const k2Improved = runs.filter(
    (run) => run.k2.status === 'refined' && run.k2.globalDelta > 0,
  ).length;
  return {
    slug,
    runs: runs.length,
    k1MeanGlobalDelta: mean(runs.map((run) => run.k1.globalDelta)),
    k2MeanGlobalDelta,
    k2VpMeanGlobalDelta,
    k2VpClipMeanGlobalDelta: mean(
      runs.map((run) => run.k2VpClip.globalDelta),
    ),
    meanRawVpMinusClipVpSavedGlobal: mean(
      runs.map((run) => run.rawVpMinusClipVpSavedGlobal),
    ),
    meanPairGlobalDelta: mean(pair),
    meanVpMinusK2: mean(runs.map((run) => run.vpMinusK2)),
    meanVpMinusK1: mean(runs.map((run) => run.vpMinusK1)),
    medianPairGlobalDelta: quantile(pair, 0.5),
    sampleSdPairGlobalDelta: sampleSd(pair),
    k1Improved: runs.filter(
      (run) => run.k1.status === 'refined' && run.k1.globalDelta > 0,
    ).length,
    k2Improved,
    k2VpImproved: runs.filter(
      (run) =>
        run.k2Vp.status === 'refined' && run.k2Vp.globalDelta > 0,
    ).length,
    k2VpClipImproved: runs.filter(
      (run) =>
        run.k2VpClip.status === 'refined' &&
        run.k2VpClip.globalDelta > 0,
    ).length,
    k2Wins: runs.filter((run) => run.pairGlobalDelta > 1e-9).length,
    k2VpWinsAgainstK2: runs.filter((run) => run.vpMinusK2 > 1e-9)
      .length,
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

/**
 * Запускает один режим и проверяет его канонический WAV.
 *
 * @param arg - Общие параметры block pursuit и необязательные флаги VP
 *   и clip-aware навигации
 * @returns Результат поиска и его длительность в миллисекундах
 * @remarks Без `variableProjection` выполняется стандартный K1/K2.
 *   Clip-флаг передаётся только четвёртому режиму; canonical assert
 *   одинаков для всех режимов.
 * @throws Error если WAV не совпадает с каноническим рендером patch
 */
function executeBlockMode(arg: {
  patch: ArgCreateSynth;
  target: Int16Array;
  sampleRate: number;
  phaseModel: PhaseModel;
  blockSize: PursuitBlockSize;
  maxBlocks: number;
  diverseShortlist: boolean;
  variableProjection?: boolean;
  clipAwareNavigation?: boolean;
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

/**
 * Находит лучший exact-кандидат среди победителей VP-проходов до guard.
 * Сравнение повторяет `betterCandidate`: сначала global, затем windowed J.
 */
function findProposedExactCandidate(
  result: BlockPursuitResult,
): Omit<
  ProposedExactCandidateReport,
  'globalDelta' | 'windowedDelta'
> | null {
  let best: Omit<
    ProposedExactCandidateReport,
    'globalDelta' | 'windowedDelta'
  > | null = null;
  for (const attempt of result.variableProjection?.attempts ?? []) {
    for (const pass of attempt.passes) {
      const globalSuppressionPercent = pass.globalSuppressionPercent;
      const windowedSuppressionPercent =
        pass.windowedSuppressionPercent;
      if (
        globalSuppressionPercent === null ||
        windowedSuppressionPercent === null
      ) {
        continue;
      }
      const candidate = {
        step: attempt.step,
        pass: pass.pass,
        globalSuppressionPercent,
        windowedSuppressionPercent,
      };
      if (best === null) {
        best = candidate;
        continue;
      }
      const globalDelta =
        candidate.globalSuppressionPercent -
        best.globalSuppressionPercent;
      if (
        globalDelta > 1e-9 ||
        (Math.abs(globalDelta) <= 1e-9 &&
          candidate.windowedSuppressionPercent >
            best.windowedSuppressionPercent)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

/** Считает absolute global/J и их отличия от общего baseline. */
function createCandidateMetricsReport(arg: {
  globalSuppressionPercent: number;
  windowedSuppressionPercent: number;
  baseline: BlockPursuitResult['baseline'];
}): CandidateMetricsReport {
  return {
    globalSuppressionPercent: arg.globalSuppressionPercent,
    windowedSuppressionPercent: arg.windowedSuppressionPercent,
    globalDelta:
      arg.globalSuppressionPercent -
      arg.baseline.globalSuppressionPercent,
    windowedDelta:
      arg.windowedSuppressionPercent -
      arg.baseline.windowedSuppressionPercent,
  };
}

/**
 * Строит DTO режима и измеряет характер итогового WAV.
 *
 * @param arg - Результат, target, параметры режима, явный clip-флаг
 *   и пути артефактов
 * @returns Метрики global/J, характер, стоимость и аудит VP
 * @remarks Полный `variableProjectionAudit` присутствует только при
 *   включённом VP. `proposedExact` выбирает лучший exact-победитель
 *   проходов до guard, а `saved` описывает фактически сохранённый
 *   результат. При unchanged обе saved-дельты равны нулю.
 */
function createModeRunReport(arg: {
  result: BlockPursuitResult;
  target: Int16Array;
  sampleRate: number;
  blockSize: PursuitBlockSize;
  durationMs: number;
  clipAwareNavigation: boolean;
  artifacts: { patch: string; wav: string };
}): ModeRunReport {
  const { result } = arg;
  const proposed = findProposedExactCandidate(result);
  const proposedExact =
    proposed === null
      ? null
      : {
          ...proposed,
          ...createCandidateMetricsReport({
            ...proposed,
            baseline: result.baseline,
          }),
        };
  const saved: SavedResultReport = {
    status: result.status,
    ...createCandidateMetricsReport({
      ...result.metrics,
      baseline: result.baseline,
    }),
  };
  const clipObjectiveEvaluations =
    result.variableProjection?.clipObjectiveEvaluations ?? 0;
  return {
    blockSize: arg.blockSize,
    status: result.status,
    ...arg.artifacts,
    baselineGlobalSuppressionPercent:
      result.baseline.globalSuppressionPercent,
    globalSuppressionPercent: result.metrics.globalSuppressionPercent,
    globalDelta: saved.globalDelta,
    baselineWindowedSuppressionPercent:
      result.baseline.windowedSuppressionPercent,
    windowedSuppressionPercent:
      result.metrics.windowedSuppressionPercent,
    windowedDelta: saved.windowedDelta,
    blocks: result.steps.length,
    replacements: result.replacementCount,
    durationMs: arg.durationMs,
    localEvaluations: result.localEvaluations,
    jointEvaluations: result.jointEvaluations,
    exactEvaluations: result.exactEvaluations,
    basisRenders: result.basisRenders,
    slotSetsEvaluated: result.slotSetsEvaluated,
    variableProjection: result.variableProjection !== undefined,
    clipAwareNavigation: arg.clipAwareNavigation,
    clipObjectiveEvaluations,
    proposedExact,
    saved,
    ...(result.variableProjection === undefined
      ? {}
      : { variableProjectionAudit: result.variableProjection }),
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

/**
 * Выполняет режим и сохраняет patch, WAV, отчёт и аудит.
 *
 * @param arg - Параметры поиска, флаги VP/clip и каталог режима
 * @returns DTO режима со ссылками на сохранённые артефакты
 * @remarks Для обоих VP-режимов в `audit.json` попадают пошаговые
 *   записи, proposed/saved-сводка и стоимость. Coordinate descent и
 *   production API здесь не запускаются.
 */
async function processMode(arg: {
  patch: ArgCreateSynth;
  target: Int16Array;
  sampleRate: number;
  phaseModel: PhaseModel;
  blockSize: PursuitBlockSize;
  maxBlocks: number;
  diverseShortlist: boolean;
  variableProjection?: boolean;
  clipAwareNavigation?: boolean;
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
    clipAwareNavigation: arg.clipAwareNavigation ?? false,
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
 * Запускает K1, K2, K2-VP и K2-VP-clip от проверенного исходника.
 *
 * @param arg - Координаты match-сида, manifest и параметры screening
 * @returns Отчёт четырёх режимов или `null` для незавершённого match
 * @remarks K1 получает двойной лимит одиночных блоков, а остальные
 *   режимы — один лимит пар, поэтому все режимы могут заменить
 *   одинаковое число слотов. Третий режим включает VP, четвёртый
 *   дополнительно включает clip-aware навигацию. Парные поля хранят
 *   raw VP минус clip VP отдельно для proposed global/J и saved
 *   global/J. Все режимы получают один проверенный patch и target.
 * @throws Error если исходник противоречит WAV или режимы получили
 *   разный baseline global/J
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
  const k2Vp = await processMode({
    ...common,
    maxBlocks: arg.maxBlocks,
    blockSize: 2,
    variableProjection: true,
    directory: join(pairDir, 'k2-vp'),
  });
  const k2VpClip = await processMode({
    ...common,
    maxBlocks: arg.maxBlocks,
    blockSize: 2,
    variableProjection: true,
    clipAwareNavigation: true,
    directory: join(pairDir, 'k2-vp-clip'),
  });
  if (
    k1.baselineGlobalSuppressionPercent !==
      k2.baselineGlobalSuppressionPercent ||
    k1.baselineWindowedSuppressionPercent !==
      k2.baselineWindowedSuppressionPercent ||
    k1.baselineGlobalSuppressionPercent !==
      k2Vp.baselineGlobalSuppressionPercent ||
    k1.baselineWindowedSuppressionPercent !==
      k2Vp.baselineWindowedSuppressionPercent ||
    k1.baselineGlobalSuppressionPercent !==
      k2VpClip.baselineGlobalSuppressionPercent ||
    k1.baselineWindowedSuppressionPercent !==
      k2VpClip.baselineWindowedSuppressionPercent
  ) {
    throw new Error(
      `K1, K2, K2-VP и K2-VP-clip получили разные baseline в ${pairDir}`,
    );
  }
  const proposedGlobal =
    k2Vp.proposedExact === null || k2VpClip.proposedExact === null
      ? null
      : k2Vp.proposedExact.globalSuppressionPercent -
        k2VpClip.proposedExact.globalSuppressionPercent;
  const proposedWindowed =
    k2Vp.proposedExact === null || k2VpClip.proposedExact === null
      ? null
      : k2Vp.proposedExact.windowedSuppressionPercent -
        k2VpClip.proposedExact.windowedSuppressionPercent;
  return {
    slug: arg.slug,
    seed: arg.seed,
    sourceRunDir: source.sourceRunDir,
    savedGlobalSuppressionPercent:
      source.record.globalSuppressionPercent ?? null,
    k1,
    k2,
    k2Vp,
    k2VpClip,
    pairGlobalDelta:
      k2.globalSuppressionPercent - k1.globalSuppressionPercent,
    vpMinusK2:
      k2Vp.globalSuppressionPercent - k2.globalSuppressionPercent,
    vpMinusK1:
      k2Vp.globalSuppressionPercent - k1.globalSuppressionPercent,
    rawVpMinusClipVpProposedGlobal: proposedGlobal,
    rawVpMinusClipVpProposedWindowed: proposedWindowed,
    rawVpMinusClipVpSavedGlobal:
      k2Vp.saved.globalSuppressionPercent -
      k2VpClip.saved.globalSuppressionPercent,
    rawVpMinusClipVpSavedWindowed:
      k2Vp.saved.windowedSuppressionPercent -
      k2VpClip.saved.windowedSuppressionPercent,
  };
}

/**
 * Строит Markdown с четырьмя режимами и парой raw/clip VP.
 *
 * @param runs - Парные результаты по всем обработанным сидам
 * @param summaries - Сводки по таргетам для тех же прогонов
 * @param maxBlocks - Общий лимит пар K2 и обоих VP-режимов;
 *   K1 получает двойной лимит блоков
 * @returns Таблицы прогонов и таргетов с пояснением порога screening
 * @remarks Отчёт описывает offline-диагностику вне production. Порог
 *   разрешает следующий эксперимент, но не доказывает закон T35 или
 *   общий эффект VP и не показывает, что suppression достиг 98%.
 */
export function renderBlockReportMarkdown(
  runs: PairedBlockRun[],
  summaries: BlockTargetSummary[],
  maxBlocks: number,
): string {
  const lines = [
    '# Screening K1, K2, K2-VP и clip-aware K2-VP',
    '',
    `K1, K2, K2-VP и K2-VP-clip стартуют с одного match и используют один словарь v3. K1 выполняет до ${maxBlocks * 2} одиночных блоков, а остальные режимы — до ${maxBlocks} пар с общим МНК 4×4, поэтому каждый режим может заменить не более ${maxBlocks * 2} слотов. Оба VP-режима делают пять проходов нелинейного уточнения выбранной пары и после каждого прохода проверяют полный global/J guard. Clip-режим выбирает направление и победителя по RSS полного клиппированного PCM, но сохраняет результат только через прежний guard. Это offline-диагностика, не закон T35 и не подключение к production.`,
    '',
    '| Таргет | Сид | Global до | K1 после | K1 Δ | K2 после | K2 Δ | K2−K1 | K2-VP после | K2-VP Δ | VP−K2 | VP−K1 | K1 с | K2 с | VP с |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const run of runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${run.k1.baselineGlobalSuppressionPercent.toFixed(2)} | ${run.k1.globalSuppressionPercent.toFixed(2)} | ${run.k1.globalDelta.toFixed(3)} | ${run.k2.globalSuppressionPercent.toFixed(2)} | ${run.k2.globalDelta.toFixed(3)} | ${run.pairGlobalDelta.toFixed(3)} | ${run.k2Vp.globalSuppressionPercent.toFixed(2)} | ${run.k2Vp.globalDelta.toFixed(3)} | ${run.vpMinusK2.toFixed(3)} | ${run.vpMinusK1.toFixed(3)} | ${(run.k1.durationMs / 1000).toFixed(1)} | ${(run.k2.durationMs / 1000).toFixed(1)} | ${(run.k2Vp.durationMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push(
    '',
    '### Raw VP против clip-aware VP',
    '',
    'Proposed описывает лучший exact-победитель проходов до guard. Saved описывает только итоговый canonical patch/WAV; при unchanged его дельта равна нулю. Во всех колонках разницы стоит raw VP минус clip VP.',
    '',
    '| Таргет | Сид | Proposed VP global | Proposed clip global | Proposed Δ global | Saved VP global | Saved clip global | Saved Δ global | Proposed Δ J | Saved Δ J | Clip evaluations | Clip basis | Clip exact | Clip objective | Clip с |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const run of runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${run.k2Vp.proposedExact?.globalSuppressionPercent.toFixed(3) ?? '—'} | ${run.k2VpClip.proposedExact?.globalSuppressionPercent.toFixed(3) ?? '—'} | ${run.rawVpMinusClipVpProposedGlobal?.toFixed(3) ?? '—'} | ${run.k2Vp.saved.globalSuppressionPercent.toFixed(3)} | ${run.k2VpClip.saved.globalSuppressionPercent.toFixed(3)} | ${run.rawVpMinusClipVpSavedGlobal.toFixed(3)} | ${run.rawVpMinusClipVpProposedWindowed?.toFixed(3) ?? '—'} | ${run.rawVpMinusClipVpSavedWindowed.toFixed(3)} | ${run.k2VpClip.variableProjectionAudit?.evaluations ?? 0} | ${run.k2VpClip.basisRenders + (run.k2VpClip.variableProjectionAudit?.unitBasisRenders ?? 0)} | ${run.k2VpClip.exactEvaluations + (run.k2VpClip.variableProjectionAudit?.exactCandidates ?? 0)} | ${run.k2VpClip.clipObjectiveEvaluations} | ${(run.k2VpClip.durationMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push(
    '',
    '| Таргет | Прогонов | K1 среднее Δ | K2 среднее Δ | K2-VP среднее Δ | Clip-VP среднее Δ | VP−clip saved среднее | K2−K1 среднее | VP−K2 среднее | VP−K1 среднее | K1 улучшено | K2 улучшено | VP улучшено | Clip улучшено | K2 выигрышей | VP выигрышей у K2 | K2 проходит screening |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  for (const summary of summaries) {
    lines.push(
      `| ${summary.slug} | ${summary.runs} | ${summary.k1MeanGlobalDelta.toFixed(3)} | ${summary.k2MeanGlobalDelta.toFixed(3)} | ${summary.k2VpMeanGlobalDelta.toFixed(3)} | ${summary.k2VpClipMeanGlobalDelta.toFixed(3)} | ${summary.meanRawVpMinusClipVpSavedGlobal.toFixed(3)} | ${summary.meanPairGlobalDelta.toFixed(3)} | ${summary.meanVpMinusK2.toFixed(3)} | ${summary.meanVpMinusK1.toFixed(3)} | ${summary.k1Improved} | ${summary.k2Improved} | ${summary.k2VpImproved} | ${summary.k2VpClipImproved} | ${summary.k2Wins} | ${summary.k2VpWinsAgainstK2} | ${summary.k2PassesScreen ? 'да' : 'нет'} |`,
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
              `K2VP=${run.k2Vp.globalDelta.toFixed(3)} ` +
              `K2VPclip=${run.k2VpClip.globalDelta.toFixed(3)} ` +
              `pair=${run.pairGlobalDelta.toFixed(3)} ` +
              `VP-K2=${run.vpMinusK2.toFixed(3)} VP-K1=${run.vpMinusK1.toFixed(3)} ` +
              `VP-clipSaved=${run.rawVpMinusClipVpSavedGlobal.toFixed(3)} ` +
              `K1status=${run.k1.status} K2status=${run.k2.status} VPstatus=${run.k2Vp.status} clipStatus=${run.k2VpClip.status} ` +
              `seconds=${((run.k1.durationMs + run.k2.durationMs + run.k2Vp.durationMs + run.k2VpClip.durationMs) / 1000).toFixed(1)}`,
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
        `K2VP=${summary.k2VpMeanGlobalDelta.toFixed(3)} ` +
        `K2VPclip=${summary.k2VpClipMeanGlobalDelta.toFixed(3)} ` +
        `pair=${summary.meanPairGlobalDelta.toFixed(3)} ` +
        `VP-K2=${summary.meanVpMinusK2.toFixed(3)} VP-K1=${summary.meanVpMinusK1.toFixed(3)} ` +
        `VP-clipSaved=${summary.meanRawVpMinusClipVpSavedGlobal.toFixed(3)} ` +
        `K1improved=${summary.k1Improved} K2improved=${summary.k2Improved} VPimproved=${summary.k2VpImproved} clipImproved=${summary.k2VpClipImproved} ` +
        `VPwins=${summary.k2VpWinsAgainstK2} pass=${summary.k2PassesScreen}`,
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
