/* eslint-disable no-console */
/**
 * Парный offline screening дополнительного CD поверх canonical delayed patch.
 * Delayed-ветка хранит onset в fixedDelaySeconds; контроль стартует из
 * исходного match без delay с тем же seed и бюджетом. Production не вызывается.
 *
 * Первый небольшой screening (команда только для явного запуска):
 * npx tsx src/dataset/delayed-cd-run.ts --dataset datasets/reference-integral --delayed datasets/delayed-patches-bog400 --out datasets/delayed-cd-bog5 --iterations 5 --seeds 1,2,3,4
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareCharacter } from '../character-metrics';
import {
  matchWithWorker,
  type MatchWorkerProgress,
  type MatchWorkerResult,
} from '../match-worker';
import { computeUsefulZone } from '../optimize/evaluate';
import { readWav } from '../read-wav';
import {
  mapSynthConfigToVector,
  mapSynthConfigToVectorWithFixedDelays,
} from '../synth-config-to-vector';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { compareWaveformBands } from '../waveform-bands';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  measureMetrics,
  type RefitMetrics,
} from './quadrature-refit';
import { withAttackBoost } from './quadrature-refit-run';
import {
  quantile,
  readJsonOrNull,
  writeJsonAtomic,
  writeJsonAtomicSync,
  writeTextAtomic,
} from './shared';

interface DatasetManifest {
  targetsDir: string;
  phaseModel?: PhaseModel;
  attackBoost?: number;
}

interface SourceRunRecord {
  status: string;
  target: string;
}

interface DelayedCdOptions {
  dataset: string;
  delayed: string;
  outDir: string;
  iterations: number;
  seeds: number[];
  slugs: string[];
}

interface LoadedPair {
  sourceRunDir: string;
  delayedSourceRunDir: string;
  targetWavPath: string;
  target: ReturnType<typeof readWav>;
  originalPatch: ArgCreateSynth;
  delayedPatch: ArgCreateSynth;
  originalVector: number[];
  delayedVector: number[];
  fixedDelaySeconds: number[];
  originalBaseline: RefitMetrics;
  delayedBaseline: RefitMetrics;
}

interface DelayedSourceAudit {
  status?: 'refined' | 'unchanged';
}

type DelayedCdSkipReason =
  'source not completed' | 'no eligible delayed pair';

interface DelayedCdSkip {
  slug: string;
  seed: number;
  status: 'skipped';
  reason: DelayedCdSkipReason;
  detail: string;
}

interface ArmReport {
  mode: 'delayed' | 'original';
  status: 'completed';
  sourceRunDir: string;
  patch: string;
  wav: string;
  seed: number;
  maxIterations: number;
  iterationsCompleted: number;
  phaseModel: PhaseModel;
  attackBoost: number;
  fixedDelaySeconds: number[] | null;
  baselineGlobalSuppressionPercent: number;
  baselineWindowedSuppressionPercent: number;
  suppressionPercent: number;
  globalSuppressionPercent: number;
  windowedSuppressionPercent: number;
  globalDeltaFromSource: number;
  windowedDeltaFromSource: number;
  targetInfo: MatchWorkerResult['targetInfo'];
  bestVector: number[];
  durationMs: number;
  character: ReturnType<typeof compareCharacter>;
  bands: ReturnType<typeof compareWaveformBands>;
}

interface PairedDelayedCdRun {
  slug: string;
  seed: number;
  status: 'completed';
  sourceRunDir: string;
  delayedSourceRunDir: string;
  iterations: number;
  original: ArmReport;
  delayed: ArmReport;
  delayedMinusControlGlobal: number;
  delayedMinusControlWindowed: number;
  durationMs: number;
}

interface DelayedCdError {
  slug: string;
  seed: number;
  message: string;
}

interface DelayedCdSummary {
  slug: string;
  runs: number;
  meanDelayedGlobalDelta: number;
  meanControlGlobalDelta: number;
  meanDelayedMinusControlGlobal: number;
  medianDelayedMinusControlGlobal: number | null;
  meanDelayedMinusControlWindowed: number;
  delayedWins: number;
}

interface DelayedCdReport {
  version: 1;
  createdAt: string;
  dataset: string;
  delayed: string;
  phaseModel: PhaseModel;
  attackBoost: number;
  iterations: number;
  seeds: number[];
  pairedBudget: true;
  productionConnected: false;
  finished: boolean;
  errors: DelayedCdError[];
  skips: DelayedCdSkip[];
  runs: PairedDelayedCdRun[];
  summaries: DelayedCdSummary[];
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Считает фактически завершённые итерации без повторной финальной записи. */
function countCompletedIterations(
  history: MatchWorkerResult['history'],
): number {
  return history.reduce(
    (maximum, entry) => Math.max(maximum, entry.iteration),
    0,
  );
}

/** Проверяет, что финальный delayed patch сохранил каждый исходный onset. */
function assertFixedDelaysPreserved(
  patch: ArgCreateSynth,
  expected: readonly number[],
): void {
  const actual =
    mapSynthConfigToVectorWithFixedDelays(patch).fixedDelaySeconds;
  if (
    actual.length < expected.length ||
    expected.some((value, index) => actual[index] !== value) ||
    actual.slice(expected.length).some((value) => value !== 0)
  ) {
    throw new Error('Финальный CD patch изменил fixedDelaySeconds');
  }
}

/** Создаёт сохраняемый skip без превращения отсутствия candidate в ошибку. */
function skipPair(
  slug: string,
  seed: number,
  reason: DelayedCdSkipReason,
  detail: string,
): DelayedCdSkip {
  return { slug, seed, status: 'skipped', reason, detail };
}

/**
 * Читает допустимую пару либо возвращает skip с причиной.
 *
 * Отсутствие delayed candidate и unchanged без onset не считаются сбоем.
 * Напротив, audit со status=refined обещает onset и согласованный WAV:
 * потеря любого из них вызывает ошибку. Допустимая пара проходит полную
 * canonical проверку до вычисления baseline global/J.
 */
async function loadPair(arg: {
  options: DelayedCdOptions;
  manifest: DatasetManifest;
  slug: string;
  seed: number;
}): Promise<LoadedPair | DelayedCdSkip> {
  const sourceRunDir = join(
    arg.options.dataset,
    arg.slug,
    `seed-${arg.seed}`,
  );
  const delayedSourceRunDir = join(
    arg.options.delayed,
    arg.slug,
    `seed-${arg.seed}`,
  );
  const record = await readJsonOrNull<SourceRunRecord>(
    join(sourceRunDir, 'run.json'),
  );
  if (record?.status !== 'completed') {
    return skipPair(
      arg.slug,
      arg.seed,
      'source not completed',
      sourceRunDir,
    );
  }
  const originalPatch = await readJsonOrNull<ArgCreateSynth>(
    join(sourceRunDir, 'patch.json'),
  );
  if (originalPatch === null) {
    throw new Error(`Нет исходного patch.json в ${sourceRunDir}`);
  }
  const delayedAudit = await readJsonOrNull<DelayedSourceAudit>(
    join(delayedSourceRunDir, 'audit.json'),
  );
  const claimedRefined = delayedAudit?.status === 'refined';
  const delayedPatch = await readJsonOrNull<ArgCreateSynth>(
    join(delayedSourceRunDir, 'patch.json'),
  );
  if (delayedPatch === null) {
    if (claimedRefined) {
      throw new Error(
        `Refined delayed source потерял patch.json: ${delayedSourceRunDir}`,
      );
    }
    return skipPair(
      arg.slug,
      arg.seed,
      'no eligible delayed pair',
      'delayed candidate отсутствует',
    );
  }
  const delayed = mapSynthConfigToVectorWithFixedDelays(delayedPatch);
  if (delayed.fixedDelaySeconds.every((delay) => delay === 0)) {
    if (claimedRefined) {
      throw new Error(
        `Refined delayed source потерял onset: ${delayedSourceRunDir}`,
      );
    }
    return skipPair(
      arg.slug,
      arg.seed,
      'no eligible delayed pair',
      'canonical unchanged без onset',
    );
  }
  const targetWavPath = join(arg.manifest.targetsDir, record.target);
  const target = readWav(targetWavPath);
  const originalWav = readWav(join(sourceRunDir, 'result.wav'));
  const delayedWav = readWav(join(delayedSourceRunDir, 'result.wav'));
  if (
    target.sampleRate !== originalWav.sampleRate ||
    target.sampleRate !== delayedWav.sampleRate ||
    target.samples.length !== originalWav.samples.length ||
    target.samples.length !== delayedWav.samples.length
  ) {
    throw new Error(
      `Разные target/source WAV для ${arg.slug}/seed-${arg.seed}`,
    );
  }
  const phaseModel = arg.manifest.phaseModel ?? 'legacy';
  assertPatchMatchesWav(
    originalPatch,
    originalWav.samples,
    phaseModel,
    target.sampleRate,
    target.samples.length,
  );
  assertPatchMatchesWav(
    delayedPatch,
    delayedWav.samples,
    phaseModel,
    target.sampleRate,
    target.samples.length,
  );
  const originalVector = mapSynthConfigToVector(originalPatch);
  if (originalVector.length !== delayed.vector.length) {
    throw new Error(
      `Разные размеры векторов для ${arg.slug}/seed-${arg.seed}`,
    );
  }
  const targetValues = Array.from(target.samples);
  const usefulZone = computeUsefulZone(
    targetValues,
    target.sampleRate,
  );
  return {
    sourceRunDir,
    delayedSourceRunDir,
    targetWavPath,
    target,
    originalPatch,
    delayedPatch,
    originalVector,
    delayedVector: delayed.vector,
    fixedDelaySeconds: delayed.fixedDelaySeconds,
    originalBaseline: measureMetrics(
      originalWav.samples,
      targetValues,
      target.sampleRate,
      usefulZone,
    ),
    delayedBaseline: measureMetrics(
      delayedWav.samples,
      targetValues,
      target.sampleRate,
      usefulZone,
    ),
  };
}

/** Пишет небольшой атомарный checkpoint; ошибка не останавливает CD. */
function writeProgressCheckpoint(arg: {
  directory: string;
  mode: ArmReport['mode'];
  seed: number;
  iterations: number;
  fixedDelaySeconds: readonly number[] | undefined;
  entry?: MatchWorkerProgress;
  bestVector?: readonly number[];
}): void {
  try {
    writeJsonAtomicSync(join(arg.directory, 'checkpoint.json'), {
      status: 'running',
      mode: arg.mode,
      seed: arg.seed,
      maxIterations: arg.iterations,
      iteration: arg.entry?.iteration ?? 0,
      suppressionPercent: arg.entry?.suppressionPercent ?? null,
      bestVector:
        arg.bestVector === undefined ? null : [...arg.bestVector],
      fixedDelaySeconds:
        arg.fixedDelaySeconds === undefined
          ? null
          : [...arg.fixedDelaySeconds],
    });
  } catch (error) {
    console.warn(
      `WARN checkpoint ${arg.mode}/seed-${arg.seed}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface RunArmArgs {
  pair: LoadedPair;
  mode: ArmReport['mode'];
  directory: string;
  options: DelayedCdOptions;
  manifest: DatasetManifest;
  slug: string;
  seed: number;
}

interface ResolvedArmInput extends RunArmArgs {
  initialVector: number[];
  sourceRunDir: string;
  sourcePatch: ArgCreateSynth;
  baseline: RefitMetrics;
  fixedDelaySeconds?: readonly number[];
  phaseModel: PhaseModel;
  attackBoost: number;
  candidateWav: string;
  resultWav: string;
}

/** Выбирает source, sidecar и пути одной ветки без запуска CD. */
function resolveArmInput(arg: RunArmArgs): ResolvedArmInput {
  const delayed = arg.mode === 'delayed';
  return {
    ...arg,
    initialVector: delayed
      ? arg.pair.delayedVector
      : arg.pair.originalVector,
    sourceRunDir: delayed
      ? arg.pair.delayedSourceRunDir
      : arg.pair.sourceRunDir,
    sourcePatch: delayed
      ? arg.pair.delayedPatch
      : arg.pair.originalPatch,
    baseline: delayed
      ? arg.pair.delayedBaseline
      : arg.pair.originalBaseline,
    fixedDelaySeconds: delayed
      ? arg.pair.fixedDelaySeconds
      : undefined,
    phaseModel: arg.manifest.phaseModel ?? 'legacy',
    attackBoost: arg.manifest.attackBoost ?? 1,
    candidateWav: join(arg.directory, 'candidate.wav'),
    resultWav: join(arg.directory, 'result.wav'),
  };
}

interface ExecutedArm {
  result: MatchWorkerResult;
  startedMs: number;
}

/** Запускает worker с resolved sidecar и пишет только progress/log/checkpoint. */
async function executeArmWorker(
  input: ResolvedArmInput,
): Promise<ExecutedArm> {
  mkdirSync(input.directory, { recursive: true });
  let latestBestVector: readonly number[] = input.initialVector;
  writeProgressCheckpoint({
    directory: input.directory,
    mode: input.mode,
    seed: input.seed,
    iterations: input.options.iterations,
    fixedDelaySeconds: input.fixedDelaySeconds,
    bestVector: latestBestVector,
  });
  const startedMs = Date.now();
  const result = await matchWithWorker({
    targetWavPath: input.pair.targetWavPath,
    outputWavPath: input.candidateWav,
    initialVector: input.initialVector,
    sampleRate: input.pair.target.sampleRate,
    maxIterations: input.options.iterations,
    attackBoost: input.attackBoost,
    seed: input.seed,
    phaseModel: input.phaseModel,
    fixedDelaySeconds: input.fixedDelaySeconds,
    config: { earlyExitSuppression: 101 },
    onLog: (line) => {
      try {
        appendFileSync(
          join(input.directory, 'worker.log'),
          `${line}\n`,
        );
      } catch (error) {
        console.warn(
          `WARN log ${input.slug}/seed-${input.seed}/${input.mode}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    onProgress: (entry) => {
      if (entry.bestVector !== undefined) {
        latestBestVector = entry.bestVector;
      }
      writeProgressCheckpoint({
        directory: input.directory,
        mode: input.mode,
        seed: input.seed,
        iterations: input.options.iterations,
        fixedDelaySeconds: input.fixedDelaySeconds,
        entry,
        bestVector: latestBestVector,
      });
    },
  });
  return { result, startedMs };
}

interface ValidatedArm extends ExecutedArm {
  output: ReturnType<typeof readWav>;
}

/** Проверяет длину vector, неизменные onset и canonical WAV worker'а. */
function validateArmResult(
  input: ResolvedArmInput,
  executed: ExecutedArm,
): ValidatedArm {
  const { result } = executed;
  if (result.bestVector.length !== input.initialVector.length) {
    throw new Error(`CD изменил длину вектора в ${input.directory}`);
  }
  if (input.mode === 'delayed') {
    assertFixedDelaysPreserved(
      result.synthConfig,
      input.pair.fixedDelaySeconds,
    );
  } else {
    mapSynthConfigToVector(result.synthConfig);
  }
  const output = readWav(input.candidateWav);
  assertPatchMatchesWav(
    result.synthConfig,
    output.samples,
    input.phaseModel,
    input.pair.target.sampleRate,
    input.pair.target.samples.length,
  );
  return { ...executed, output };
}

interface MeasuredArm extends ValidatedArm {
  metrics: RefitMetrics;
  character: ReturnType<typeof compareCharacter>;
  bands: ReturnType<typeof compareWaveformBands>;
}

/** Измеряет финальные global/J, character и bands по одному canonical WAV. */
function measureArmResult(
  input: ResolvedArmInput,
  validated: ValidatedArm,
): MeasuredArm {
  const targetValues = Array.from(input.pair.target.samples);
  const metrics = measureMetrics(
    validated.output.samples,
    targetValues,
    input.pair.target.sampleRate,
    computeUsefulZone(targetValues, input.pair.target.sampleRate),
  );
  return {
    ...validated,
    metrics,
    character: compareCharacter(
      input.pair.target.samples,
      validated.output.samples,
      input.pair.target.sampleRate,
    ),
    bands: compareWaveformBands(
      input.pair.target.samples,
      validated.output.samples,
      input.pair.target.sampleRate,
    ),
  };
}

/** Атомарно сохраняет неизменённый набор полей patch/WAV/run/audit/history. */
async function persistArmArtifacts(
  input: ResolvedArmInput,
  measured: MeasuredArm,
): Promise<ArmReport> {
  const { result, metrics, startedMs } = measured;
  await rename(input.candidateWav, input.resultWav);
  const patchPath = join(input.directory, 'patch.json');
  await writeJsonAtomic(patchPath, result.synthConfig);
  await writeJsonAtomic(
    join(input.directory, 'history.json'),
    result.history,
  );
  const report: ArmReport = {
    mode: input.mode,
    status: 'completed',
    sourceRunDir: input.sourceRunDir,
    patch: patchPath,
    wav: input.resultWav,
    seed: input.seed,
    maxIterations: input.options.iterations,
    iterationsCompleted: countCompletedIterations(result.history),
    phaseModel: input.phaseModel,
    attackBoost: input.attackBoost,
    fixedDelaySeconds:
      input.fixedDelaySeconds === undefined
        ? null
        : [...input.fixedDelaySeconds],
    baselineGlobalSuppressionPercent:
      input.baseline.globalSuppressionPercent,
    baselineWindowedSuppressionPercent:
      input.baseline.windowedSuppressionPercent,
    suppressionPercent: result.suppressionPercent,
    globalSuppressionPercent: metrics.globalSuppressionPercent,
    windowedSuppressionPercent: metrics.windowedSuppressionPercent,
    globalDeltaFromSource:
      metrics.globalSuppressionPercent -
      input.baseline.globalSuppressionPercent,
    windowedDeltaFromSource:
      metrics.windowedSuppressionPercent -
      input.baseline.windowedSuppressionPercent,
    targetInfo: result.targetInfo,
    bestVector: result.bestVector,
    durationMs: Date.now() - startedMs,
    character: measured.character,
    bands: measured.bands,
  };
  await writeJsonAtomic(join(input.directory, 'run.json'), report);
  await writeJsonAtomic(join(input.directory, 'audit.json'), {
    algorithm: 'delayed-cd',
    experimental: true,
    productionConnected: false,
    mode: input.mode,
    slug: input.slug,
    seed: input.seed,
    sourcePatch: input.sourcePatch,
    initialVector: input.initialVector,
    fixedDelaySeconds: report.fixedDelaySeconds,
    baseline: input.baseline,
    metrics,
    iterationsCompleted: report.iterationsCompleted,
    character: report.character,
    bands: report.bands,
  });
  return report;
}

/** Связывает resolve, worker, canonical validation, измерения и сохранение. */
async function runArm(arg: RunArmArgs): Promise<ArmReport> {
  const input = resolveArmInput(arg);
  const executed = await executeArmWorker(input);
  const validated = validateArmResult(input, executed);
  const measured = measureArmResult(input, validated);
  return persistArmArtifacts(input, measured);
}

/** Выполняет допустимую пару либо возвращает сохраняемый skip. */
async function processPair(arg: {
  options: DelayedCdOptions;
  manifest: DatasetManifest;
  slug: string;
  seed: number;
}): Promise<PairedDelayedCdRun | DelayedCdSkip> {
  const loaded = await loadPair(arg);
  if ('status' in loaded) {
    return loaded;
  }
  const pair = loaded;
  const started = Date.now();
  const pairDir = join(
    arg.options.outDir,
    arg.slug,
    `seed-${arg.seed}`,
  );
  const delayed = await runArm({
    ...arg,
    pair,
    mode: 'delayed',
    directory: join(pairDir, 'delayed'),
  });
  const original = await runArm({
    ...arg,
    pair,
    mode: 'original',
    directory: join(pairDir, 'original'),
  });
  if (delayed.iterationsCompleted !== original.iterationsCompleted) {
    throw new Error(
      `Парный CD завершил разные итерации: delayed=${delayed.iterationsCompleted}, control=${original.iterationsCompleted}`,
    );
  }
  const report: PairedDelayedCdRun = {
    slug: arg.slug,
    seed: arg.seed,
    status: 'completed',
    sourceRunDir: pair.sourceRunDir,
    delayedSourceRunDir: pair.delayedSourceRunDir,
    iterations: delayed.iterationsCompleted,
    original,
    delayed,
    delayedMinusControlGlobal:
      delayed.globalSuppressionPercent -
      original.globalSuppressionPercent,
    delayedMinusControlWindowed:
      delayed.windowedSuppressionPercent -
      original.windowedSuppressionPercent,
    durationMs: Date.now() - started,
  };
  await writeJsonAtomic(join(pairDir, 'run.json'), report);
  return report;
}

/** Сводит только парные результаты одного таргета. */
function summarizeTarget(
  slug: string,
  runs: PairedDelayedCdRun[],
): DelayedCdSummary {
  const pairGlobal = runs.map((run) => run.delayedMinusControlGlobal);
  return {
    slug,
    runs: runs.length,
    meanDelayedGlobalDelta: mean(
      runs.map((run) => run.delayed.globalDeltaFromSource),
    ),
    meanControlGlobalDelta: mean(
      runs.map((run) => run.original.globalDeltaFromSource),
    ),
    meanDelayedMinusControlGlobal: mean(pairGlobal),
    medianDelayedMinusControlGlobal: quantile(pairGlobal, 0.5),
    meanDelayedMinusControlWindowed: mean(
      runs.map((run) => run.delayedMinusControlWindowed),
    ),
    delayedWins: runs.filter(
      (run) => run.delayedMinusControlGlobal > 0,
    ).length,
  };
}

function makeReport(arg: {
  options: DelayedCdOptions;
  manifest: DatasetManifest;
  runs: PairedDelayedCdRun[];
  errors: DelayedCdError[];
  skips: DelayedCdSkip[];
  finished: boolean;
}): DelayedCdReport {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    dataset: arg.options.dataset,
    delayed: arg.options.delayed,
    phaseModel: arg.manifest.phaseModel ?? 'legacy',
    attackBoost: arg.manifest.attackBoost ?? 1,
    iterations: arg.options.iterations,
    seeds: arg.options.seeds,
    pairedBudget: true,
    productionConnected: false,
    finished: arg.finished,
    errors: arg.errors,
    skips: arg.skips,
    runs: arg.runs,
    summaries: arg.options.slugs.map((slug) =>
      summarizeTarget(
        slug,
        arg.runs.filter((run) => run.slug === slug),
      ),
    ),
  };
}

/** Markdown описывает эксперимент и не объявляет доказанный выигрыш. */
function renderMarkdown(report: DelayedCdReport): string {
  const lines = [
    '# Дополнительный CD с fixed-delay sidecar',
    '',
    `Delayed и исходный match получают одинаковый бюджет ${report.iterations} итераций и один seed. Ранний выход по suppression отключён; пары с разным фактическим числом итераций отклоняются. Это offline-эксперимент, а не доказанный выигрыш и не подключение к production.`,
    '',
    '| Таргет | Сид | Итерации | Delayed global до/после | Control global до/после | Delayed−control global | Delayed−control J | Секунд |',
    '| --- | ---: | ---: | --- | --- | ---: | ---: | ---: |',
  ];
  for (const run of report.runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${run.iterations} | ${run.delayed.baselineGlobalSuppressionPercent.toFixed(3)} / ${run.delayed.globalSuppressionPercent.toFixed(3)} | ${run.original.baselineGlobalSuppressionPercent.toFixed(3)} / ${run.original.globalSuppressionPercent.toFixed(3)} | ${run.delayedMinusControlGlobal.toFixed(3)} | ${run.delayedMinusControlWindowed.toFixed(3)} | ${(run.durationMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push(
    '',
    'Global и J измерены заново по финальному canonical WAV. Character и bands обеих веток сохранены в run.json и audit.json. Разброс CD требует сравнения средних по сидам; один прогон не доказывает эффект.',
    '',
    '| Таргет | Пар | Delayed среднее Δ от source | Control среднее Δ от source | Delayed−control global | Delayed−control J | Delayed выигрышей |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const summary of report.summaries) {
    lines.push(
      `| ${summary.slug} | ${summary.runs} | ${summary.meanDelayedGlobalDelta.toFixed(3)} | ${summary.meanControlGlobalDelta.toFixed(3)} | ${summary.meanDelayedMinusControlGlobal.toFixed(3)} | ${summary.meanDelayedMinusControlWindowed.toFixed(3)} | ${summary.delayedWins} |`,
    );
  }
  if (report.skips.length > 0) {
    lines.push(
      '',
      '## Пропущенные пары',
      '',
      'Skip не является ошибкой и не повышает exit code. Refined delayed source с потерянным onset или несовпадающим WAV попадает в errors, а не в эту таблицу.',
      '',
      '| Таргет | Сид | Причина | Деталь |',
      '| --- | ---: | --- | --- |',
    );
    for (const skip of report.skips) {
      lines.push(
        `| ${skip.slug} | ${skip.seed} | ${skip.reason} | ${skip.detail} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Атомарно обновляет общий JSON и Markdown после каждой пары. */
async function writeReportCheckpoint(
  outDir: string,
  report: DelayedCdReport,
): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await writeJsonAtomic(join(outDir, 'report.json'), report);
  await writeTextAtomic(
    join(outDir, 'report.md'),
    renderMarkdown(report),
  );
}

/** Последовательно обрабатывает сиды при уже установленном attackBoost. */
async function runDelayedCdScreeningLoop(
  options: DelayedCdOptions,
  manifest: DatasetManifest,
): Promise<DelayedCdReport> {
  const runs: PairedDelayedCdRun[] = [];
  const errors: DelayedCdError[] = [];
  const skips: DelayedCdSkip[] = [];
  for (const slug of options.slugs) {
    for (const seed of options.seeds) {
      try {
        const outcome = await processPair({
          options,
          manifest,
          slug,
          seed,
        });
        if (outcome.status === 'skipped') {
          skips.push(outcome);
          console.log(
            `SKIP ${slug}/seed-${seed}: ${outcome.reason} (${outcome.detail})`,
          );
        } else {
          const run = outcome;
          runs.push(run);
          console.log(
            `RESULT ${slug} seed=${seed} iterations=${run.iterations} ` +
              `delayedDelta=${run.delayed.globalDeltaFromSource.toFixed(3)} ` +
              `controlDelta=${run.original.globalDeltaFromSource.toFixed(3)} ` +
              `delayed-control=${run.delayedMinusControlGlobal.toFixed(3)} ` +
              `J=${run.delayedMinusControlWindowed.toFixed(3)}`,
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        errors.push({ slug, seed, message });
        const pairDir = join(options.outDir, slug, `seed-${seed}`);
        mkdirSync(pairDir, { recursive: true });
        await writeJsonAtomic(join(pairDir, 'run.json'), {
          slug,
          seed,
          status: 'failed',
          error: message,
          maxIterations: options.iterations,
        });
        console.warn(`WARN ${slug}/seed-${seed}: ${message}`);
      }
      await writeReportCheckpoint(
        options.outDir,
        makeReport({
          options,
          manifest,
          runs,
          errors,
          skips,
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
    skips,
    finished: true,
  });
  await writeReportCheckpoint(options.outDir, report);
  return report;
}

/**
 * Запускает парный screening и сам задаёт parent metric из manifest.
 *
 * Прямой вызов и CLI используют одинаковый attackBoost. withAttackBoost
 * восстанавливает прежнее значение после успеха, skip и ошибки, поэтому
 * вызывающему не нужен внешний wrapper и двойного изменения состояния нет.
 */
export async function runDelayedCdScreening(
  options: DelayedCdOptions,
  manifest: DatasetManifest,
): Promise<DelayedCdReport> {
  return withAttackBoost(manifest.attackBoost ?? 1, () =>
    runDelayedCdScreeningLoop(options, manifest),
  );
}

/** Разбирает обязательные пути и явный парный бюджет без запуска CD. */
function parseDelayedCdArgs(args: string[]): DelayedCdOptions {
  const options: DelayedCdOptions = {
    dataset: '',
    delayed: '',
    outDir: '',
    iterations: 0,
    seeds: [1, 2, 3, 4],
    slugs: ['BOg-Disco-Futuro'],
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--dataset') {
      options.dataset = resolve(value);
    } else if (key === '--delayed') {
      options.delayed = resolve(value);
    } else if (key === '--out') {
      options.outDir = resolve(value);
    } else if (key === '--iterations') {
      options.iterations = Number(value);
    } else if (key === '--seeds') {
      options.seeds = value
        .split(',')
        .filter(Boolean)
        .map((seed) => Number(seed));
    } else if (key === '--slugs') {
      options.slugs = value.split(',').filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (
    options.dataset === '' ||
    options.delayed === '' ||
    options.outDir === '' ||
    options.iterations === 0
  ) {
    throw new Error(
      'Usage: delayed-cd-run --dataset DIR --delayed DIR --out DIR --iterations N [--seeds 1,2,3,4] [--slugs BOg-Disco-Futuro]',
    );
  }
  if (
    !Number.isInteger(options.iterations) ||
    options.iterations < 1
  ) {
    throw new Error('--iterations должен быть положительным целым');
  }
  if (
    options.seeds.length === 0 ||
    options.seeds.some(
      (seed) => !Number.isInteger(seed) || seed < 1,
    ) ||
    options.slugs.length === 0
  ) {
    throw new Error('--seeds и --slugs не должны быть пустыми');
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseDelayedCdArgs(process.argv.slice(2));
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(options.dataset, 'manifest.json'),
  );
  if (manifest === null) {
    throw new Error(`Нет manifest.json в ${options.dataset}`);
  }
  const report = await runDelayedCdScreening(options, manifest);
  for (const summary of report.summaries) {
    console.log(
      `SUMMARY ${summary.slug} runs=${summary.runs} ` +
        `delayed=${summary.meanDelayedGlobalDelta.toFixed(3)} ` +
        `control=${summary.meanControlGlobalDelta.toFixed(3)} ` +
        `pair=${summary.meanDelayedMinusControlGlobal.toFixed(3)} ` +
        `wins=${summary.delayedWins}`,
    );
  }
  console.log(
    `REPORT ${options.outDir}: runs=${report.runs.length} skips=${report.skips.length} errors=${report.errors.length}`,
  );
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
