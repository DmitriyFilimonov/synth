/* eslint-disable no-console */
/**
 * Offline screening одного localized high-only атома поверх сохранённого A+B2.
 * Новый CD, K2 и VP не запускаются; production match/enhance/API не вызываются.
 *
 * npx tsx src/dataset/localized-transient-run.ts \
 *   --dataset datasets/reference-integral \
 *   --base datasets/block-pursuit-ab-blocks2-grumu \
 *   --out datasets/localized-transient-grumu --seeds 1,2,3,4
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  compareCharacter,
  type CharacterDelta,
} from '../character-metrics';
import { readWav } from '../read-wav';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import {
  compareWaveformBands,
  type WaveformBandDelta,
} from '../waveform-bands';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  LOCALIZED_CONTINUATION_GATE,
  LOCALIZED_TRANSIENT_LIMITS,
  localizedContinuationGate,
  runLocalizedTransientExperiment,
  type LocalizedProposalAudit,
  type LocalizedTransientResult,
} from './localized-transient';
import { withAttackBoost } from './quadrature-refit-run';
import {
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

const BASE_MODE = 'k2-vp-clip-seed-refit';
const SLUG = 'GrumU';

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

/** Аргументы единственного GrumU A+B2 screening. */
export interface LocalizedTransientCliOptions {
  dataset: string;
  base: string;
  outDir: string;
  seeds: number[];
}

interface RunError {
  slug: string;
  seed: number;
  message: string;
}

/** Сохранённый canonical результат и аудит характера одного сида. */
export interface LocalizedTransientRunReport {
  slug: string;
  seed: number;
  status: 'refined' | 'unchanged';
  sourceBaseDir: string;
  sourceRunDir: string;
  patch: string;
  wav: string;
  audit: string;
  savedGlobalSuppressionPercent: number | null;
  baselineGlobal: number;
  baselineWindowed: number;
  savedGlobal: number;
  savedWindowed: number;
  savedGlobalDelta: number;
  savedWindowedDelta: number;
  proposedRaw: LocalizedProposalAudit | null;
  proposedRefit: LocalizedProposalAudit | null;
  savedKind: LocalizedTransientResult['saved']['kind'];
  savedHigh: LocalizedTransientResult['saved']['high'];
  savedClipping: LocalizedTransientResult['saved']['clipping'];
  acceptedHighGuard: boolean;
  selectedCells: LocalizedTransientResult['selectedCells'];
  slots: LocalizedTransientResult['slots'];
  baselineCharacter: CharacterDelta;
  character: CharacterDelta;
  baselineBands: WaveformBandDelta[];
  bands: WaveformBandDelta[];
  warnings: string[];
  q4Pass: null;
  cost: LocalizedTransientResult['cost'];
}

interface LocalizedTargetSummary {
  slug: string;
  runs: number;
  meanSavedGlobalDelta: number;
  meanSavedWindowedDelta: number;
  improvedSeeds: number;
}

/** Полный checkpoint; gate продолжения не зависит от wall-clock. */
export interface LocalizedTransientScreeningReport {
  version: 1;
  experiment: 'localized-high-only-atom';
  hypothesisOnly: true;
  dataset: string;
  base: string;
  baseMode: typeof BASE_MODE;
  phaseModel: PhaseModel;
  attackBoost: number;
  seeds: number[];
  limits: typeof LOCALIZED_TRANSIENT_LIMITS;
  continuationGate: typeof LOCALIZED_CONTINUATION_GATE & {
    pass: boolean;
    runs: number;
    meanSavedGlobalDelta: number;
    improvedSeeds: number;
  };
  q4Pass: null;
  finished: boolean;
  errors: RunError[];
  skips: Array<{ slug: string; seed: number; reason: string }>;
  runs: LocalizedTransientRunReport[];
  summaries: LocalizedTargetSummary[];
}

export const LOCALIZED_TRANSIENT_RUN_USAGE =
  'Usage: localized-transient-run --dataset DIR --base DIR --out DIR [--seeds 1,2,3,4]';

/** Разбирает CLI без запуска вычислений. */
export function parseLocalizedTransientArgs(
  args: string[],
): LocalizedTransientCliOptions {
  const options: LocalizedTransientCliOptions = {
    dataset: '',
    base: '',
    outDir: '',
    seeds: [1, 2, 3, 4],
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--dataset') {
      options.dataset = resolve(value);
    } else if (key === '--base') {
      options.base = resolve(value);
    } else if (key === '--out') {
      options.outDir = resolve(value);
    } else if (key === '--seeds') {
      options.seeds = value.split(',').map(Number);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (
    options.dataset === '' ||
    options.base === '' ||
    options.outDir === ''
  ) {
    throw new Error(LOCALIZED_TRANSIENT_RUN_USAGE);
  }
  if (
    options.seeds.length === 0 ||
    options.seeds.some(
      (seed) => !Number.isInteger(seed) || seed < 1 || seed > 4,
    ) ||
    new Set(options.seeds).size !== options.seeds.length
  ) {
    throw new Error('--seeds должен содержать уникальные целые 1–4');
  }
  return options;
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function worseAbsolute(
  before: number | null,
  after: number | null,
): boolean {
  if (before === null) {
    return false;
  }
  return after === null || Math.abs(after) > Math.abs(before) + 1e-12;
}

/** Q4 не выносит PASS: заметные потери низа/f0/decay становятся WARN. */
export function localizedCharacterWarnings(arg: {
  baselineCharacter: CharacterDelta;
  character: CharacterDelta;
  baselineBands: WaveformBandDelta[];
  bands: WaveformBandDelta[];
}): string[] {
  const warnings: string[] = [];
  if (
    worseAbsolute(
      arg.baselineCharacter.bodyF0DeltaCents,
      arg.character.bodyF0DeltaCents,
    )
  ) {
    warnings.push('WARN: отклонение f0 от исходника ухудшилось');
  }
  if (
    worseAbsolute(
      arg.baselineCharacter.decayDb20DeltaSec,
      arg.character.decayDb20DeltaSec,
    )
  ) {
    warnings.push('WARN: отклонение decay −20 dB ухудшилось');
  }
  for (const baseline of arg.baselineBands) {
    if (baseline.maxHz > 300 || baseline.deltaDb === null) {
      continue;
    }
    const candidate = arg.bands.find(
      (band) =>
        band.region === baseline.region &&
        band.name === baseline.name,
    );
    if (
      candidate !== undefined &&
      worseAbsolute(baseline.deltaDb, candidate.deltaDb)
    ) {
      warnings.push(
        `WARN: низ ${baseline.region}/${baseline.name} отклонился сильнее A+B2`,
      );
    }
  }
  return warnings;
}

function highGuardHolds(result: LocalizedTransientResult): boolean {
  if (result.status === 'unchanged') {
    return true;
  }
  const high = result.saved.high;
  return (
    high !== null &&
    high.selectedCellRssAfter < high.selectedCellRssBefore &&
    high.totalHighRssAfter < high.totalHighRssBefore
  );
}

async function saveRunArtifacts(arg: {
  directory: string;
  result: LocalizedTransientResult;
  sampleRate: number;
  audit: unknown;
}): Promise<{ patch: string; wav: string; audit: string }> {
  mkdirSync(arg.directory, { recursive: true });
  const patch = join(arg.directory, 'patch.json');
  const wav = join(arg.directory, 'result.wav');
  const audit = join(arg.directory, 'audit.json');
  await writeJsonAtomic(patch, arg.result.patch);
  writeWav({
    samples: arg.result.samples,
    sampleRate: arg.sampleRate,
    filePath: `${wav}.tmp`,
  });
  await rename(`${wav}.tmp`, wav);
  await writeJsonAtomic(audit, arg.audit);
  return { patch, wav, audit };
}

async function assertSavedCanonicalRoundTrip(arg: {
  patchPath: string;
  wavPath: string;
  result: LocalizedTransientResult;
  phaseModel: PhaseModel;
  sampleRate: number;
  sampleCount: number;
}): Promise<void> {
  const patch = await readJsonOrNull<ArgCreateSynth>(arg.patchPath);
  if (patch === null || !isDeepStrictEqual(patch, arg.result.patch)) {
    throw new Error(
      'Saved localized patch не пережил JSON round-trip',
    );
  }
  const wav = readWav(arg.wavPath);
  if (
    wav.sampleRate !== arg.sampleRate ||
    !isDeepStrictEqual(wav.samples, arg.result.samples)
  ) {
    throw new Error(
      'Saved localized WAV не совпал с canonical result',
    );
  }
  assertPatchMatchesWav(
    patch,
    wav.samples,
    arg.phaseModel,
    arg.sampleRate,
    arg.sampleCount,
  );
}

interface VerifiedLocalizedBase {
  sourceRunDir: string;
  sourceBaseDir: string;
  record: RunRecord;
  patch: ArgCreateSynth;
  target: ReturnType<typeof readWav>;
  baselineWav: ReturnType<typeof readWav>;
  phaseModel: PhaseModel;
}

/** Читает completed match и canonical A+B2, не запуская поиск. */
async function loadVerifiedLocalizedBase(arg: {
  options: LocalizedTransientCliOptions;
  manifest: DatasetManifest;
  seed: number;
}): Promise<VerifiedLocalizedBase | null> {
  const sourceRunDir = join(
    arg.options.dataset,
    SLUG,
    `seed-${arg.seed}`,
  );
  const record = await readJsonOrNull<RunRecord>(
    join(sourceRunDir, 'run.json'),
  );
  if (record?.status !== 'completed') {
    return null;
  }
  const sourceBaseDir = join(
    arg.options.base,
    SLUG,
    `seed-${arg.seed}`,
    BASE_MODE,
  );
  const patch = await readJsonOrNull<ArgCreateSynth>(
    join(sourceBaseDir, 'patch.json'),
  );
  if (patch === null) {
    throw new Error(`Нет A+B2 patch.json в ${sourceBaseDir}`);
  }
  const target = readWav(
    join(arg.manifest.targetsDir, record.target),
  );
  const baselineWav = readWav(join(sourceBaseDir, 'result.wav'));
  if (
    target.sampleRate !== baselineWav.sampleRate ||
    target.samples.length !== baselineWav.samples.length
  ) {
    throw new Error(
      `A+B2 и target не согласованы в ${sourceBaseDir}`,
    );
  }
  const phaseModel = arg.manifest.phaseModel ?? 'legacy';
  assertPatchMatchesWav(
    patch,
    baselineWav.samples,
    phaseModel,
    baselineWav.sampleRate,
    target.samples.length,
  );
  return {
    sourceRunDir,
    sourceBaseDir,
    record,
    patch,
    target,
    baselineWav,
    phaseModel,
  };
}

interface LocalizedDiagnostics {
  baselineCharacter: CharacterDelta;
  character: CharacterDelta;
  baselineBands: WaveformBandDelta[];
  bands: WaveformBandDelta[];
  warnings: string[];
}

/** Измеряет характер и полосы после завершения canonical результата. */
function measureLocalizedDiagnostics(arg: {
  target: Int16Array;
  baseline: Int16Array;
  result: Int16Array;
  sampleRate: number;
}): LocalizedDiagnostics {
  const baselineCharacter = compareCharacter(
    arg.target,
    arg.baseline,
    arg.sampleRate,
  );
  const character = compareCharacter(
    arg.target,
    arg.result,
    arg.sampleRate,
  );
  const baselineBands = compareWaveformBands(
    arg.target,
    arg.baseline,
    arg.sampleRate,
  );
  const bands = compareWaveformBands(
    arg.target,
    arg.result,
    arg.sampleRate,
  );
  return {
    baselineCharacter,
    character,
    baselineBands,
    bands,
    warnings: localizedCharacterWarnings({
      baselineCharacter,
      character,
      baselineBands,
      bands,
    }),
  };
}

/** Собирает run DTO из проверенных артефактов и diagnostics. */
function createLocalizedRunReport(arg: {
  seed: number;
  loaded: VerifiedLocalizedBase;
  result: LocalizedTransientResult;
  diagnostics: LocalizedDiagnostics;
  artifacts: { patch: string; wav: string; audit: string };
}): LocalizedTransientRunReport {
  const { loaded, result, diagnostics } = arg;
  return {
    slug: SLUG,
    seed: arg.seed,
    status: result.status,
    sourceBaseDir: loaded.sourceBaseDir,
    sourceRunDir: loaded.sourceRunDir,
    ...arg.artifacts,
    savedGlobalSuppressionPercent:
      loaded.record.globalSuppressionPercent ?? null,
    baselineGlobal: result.baseline.globalSuppressionPercent,
    baselineWindowed: result.baseline.windowedSuppressionPercent,
    savedGlobal: result.metrics.globalSuppressionPercent,
    savedWindowed: result.metrics.windowedSuppressionPercent,
    savedGlobalDelta: result.saved.globalDelta,
    savedWindowedDelta: result.saved.windowedDelta,
    proposedRaw: result.proposedRaw,
    proposedRefit: result.proposedRefit,
    savedKind: result.saved.kind,
    savedHigh: result.saved.high,
    savedClipping: result.saved.clipping,
    acceptedHighGuard: highGuardHolds(result),
    selectedCells: result.selectedCells,
    slots: result.slots,
    ...diagnostics,
    q4Pass: null,
    cost: result.cost,
  };
}

/** Загружает базу, выполняет offline-поиск и сохраняет проверенный результат. */
async function processLocalizedRun(arg: {
  options: LocalizedTransientCliOptions;
  manifest: DatasetManifest;
  seed: number;
}): Promise<LocalizedTransientRunReport | null> {
  const loaded = await loadVerifiedLocalizedBase(arg);
  if (loaded === null) {
    return null;
  }
  const { target, baselineWav, phaseModel } = loaded;
  const result = runLocalizedTransientExperiment({
    patch: loaded.patch,
    target: target.samples,
    sampleRate: target.sampleRate,
    phaseModel,
  });
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    phaseModel,
    target.sampleRate,
    target.samples.length,
  );
  const diagnostics = measureLocalizedDiagnostics({
    target: target.samples,
    baseline: baselineWav.samples,
    result: result.samples,
    sampleRate: target.sampleRate,
  });
  const directory = join(
    arg.options.outDir,
    SLUG,
    `seed-${arg.seed}`,
  );
  const artifacts = await saveRunArtifacts({
    directory,
    result,
    sampleRate: target.sampleRate,
    audit: {
      algorithm: 'localized-high-only-atom',
      hypothesisOnly: true,
      sourceBaseDir: loaded.sourceBaseDir,
      sourceRunDir: loaded.sourceRunDir,
      phaseModel,
      attackBoost: arg.manifest.attackBoost ?? 1,
      result,
      ...diagnostics,
      q4Pass: null,
    },
  });
  await assertSavedCanonicalRoundTrip({
    patchPath: artifacts.patch,
    wavPath: artifacts.wav,
    result,
    phaseModel,
    sampleRate: target.sampleRate,
    sampleCount: target.samples.length,
  });
  return createLocalizedRunReport({
    seed: arg.seed,
    loaded,
    result,
    diagnostics,
    artifacts,
  });
}

function makeReport(arg: {
  options: LocalizedTransientCliOptions;
  manifest: DatasetManifest;
  runs: LocalizedTransientRunReport[];
  errors: RunError[];
  skips: LocalizedTransientScreeningReport['skips'];
  finished: boolean;
}): LocalizedTransientScreeningReport {
  const gate = localizedContinuationGate(
    arg.runs.map((run) => ({
      status: run.status,
      savedGlobalDelta: run.savedGlobalDelta,
      savedWindowed: run.savedWindowed,
      baselineWindowed: run.baselineWindowed,
      acceptedHighGuard: run.acceptedHighGuard,
    })),
  );
  return {
    version: 1,
    experiment: 'localized-high-only-atom',
    hypothesisOnly: true,
    dataset: arg.options.dataset,
    base: arg.options.base,
    baseMode: BASE_MODE,
    phaseModel: arg.manifest.phaseModel ?? 'legacy',
    attackBoost: arg.manifest.attackBoost ?? 1,
    seeds: [...arg.options.seeds],
    limits: LOCALIZED_TRANSIENT_LIMITS,
    continuationGate: {
      ...LOCALIZED_CONTINUATION_GATE,
      ...gate,
    },
    q4Pass: null,
    finished: arg.finished,
    errors: arg.errors,
    skips: arg.skips,
    runs: arg.runs,
    summaries:
      arg.runs.length === 0
        ? []
        : [
            {
              slug: SLUG,
              runs: arg.runs.length,
              meanSavedGlobalDelta: mean(
                arg.runs.map((run) => run.savedGlobalDelta),
              ),
              meanSavedWindowedDelta: mean(
                arg.runs.map((run) => run.savedWindowedDelta),
              ),
              improvedSeeds: gate.improvedSeeds,
            },
          ],
  };
}

function renderMarkdown(
  report: LocalizedTransientScreeningReport,
): string {
  const lines = [
    '# Localized high-only атом поверх A+B2',
    '',
    'Это проверка гипотезы, а не результат улучшения и не PASS Q4. Raw, clip-refit и сохранённый canonical WAV разделены. При любом проигрыше остаётся A+B2.',
    '',
    `Gate продолжения зафиксирован заранее: четыре сида, mean saved global ≥ ${LOCALIZED_CONTINUATION_GATE.minMeanSavedGlobalDelta} п.п., улучшено ≥ ${LOCALIZED_CONTINUATION_GATE.minImprovedSeeds}; J ≥ initial−0.05, а selected и total high RSS у каждого accepted уменьшаются.`,
    '',
    `Итог gate: **${report.continuationGate.pass ? 'PASS' : 'NO GO'}**; runs=${report.continuationGate.runs}, mean=${report.continuationGate.meanSavedGlobalDelta.toFixed(6)}, improved=${report.continuationGate.improvedSeeds}.`,
    '',
    '| Сид | Статус | Δ global | Δ J | Exact | Warnings |',
    '| ---: | --- | ---: | ---: | ---: | --- |',
  ];
  for (const run of report.runs) {
    lines.push(
      `| ${run.seed} | ${run.status} | ${run.savedGlobalDelta.toFixed(6)} | ${run.savedWindowedDelta.toFixed(6)} | ${run.cost.exactEvaluations} | ${run.warnings.length} |`,
    );
  }
  const warnings = report.runs.flatMap((run) =>
    run.warnings.map((warning) => `- seed ${run.seed}: ${warning}`),
  );
  if (warnings.length > 0) {
    lines.push('', '## Warnings', '', ...warnings);
  }
  if (report.errors.length > 0) {
    lines.push('', '## Ошибки', '');
    for (const error of report.errors) {
      lines.push(`- seed ${error.seed}: ${error.message}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function checkpoint(
  outDir: string,
  report: LocalizedTransientScreeningReport,
): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await writeJsonAtomic(join(outDir, 'report.json'), report);
  await writeTextAtomic(
    join(outDir, 'report.md'),
    renderMarkdown(report),
  );
}

function assertEmptyOut(outDir: string): void {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(
      `--out должен отсутствовать или быть пустым: ${outDir}`,
    );
  }
}

/**
 * Последовательно обрабатывает выбранные сиды и пишет checkpoint после каждого.
 */
export async function runLocalizedTransientScreening(
  options: LocalizedTransientCliOptions,
): Promise<LocalizedTransientScreeningReport> {
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(options.dataset, 'manifest.json'),
  );
  if (manifest === null) {
    throw new Error(`Нет manifest.json в ${options.dataset}`);
  }
  assertEmptyOut(options.outDir);
  return withAttackBoost(manifest.attackBoost ?? 1, async () => {
    const runs: LocalizedTransientRunReport[] = [];
    const errors: RunError[] = [];
    const skips: LocalizedTransientScreeningReport['skips'] = [];
    for (const seed of options.seeds) {
      try {
        const run = await processLocalizedRun({
          options,
          manifest,
          seed,
        });
        if (run === null) {
          skips.push({
            slug: SLUG,
            seed,
            reason: 'исходный match не completed',
          });
          console.log(`SKIP ${SLUG}/seed-${seed}: not completed`);
        } else {
          runs.push(run);
          console.log(
            `RESULT ${SLUG} seed=${seed} ${run.status} ` +
              `global=${run.savedGlobalDelta.toFixed(6)} ` +
              `J=${run.savedWindowedDelta.toFixed(6)} ` +
              `exact=${run.cost.exactEvaluations} warnings=${run.warnings.length}`,
          );
        }
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error);
        errors.push({
          slug: SLUG,
          seed,
          message: `seed=${seed} ${detail}`,
        });
        console.warn(`WARN ${SLUG}/seed-${seed}: ${detail}`);
      }
      await checkpoint(
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
    const report = makeReport({
      options,
      manifest,
      runs,
      errors,
      skips,
      finished: true,
    });
    await checkpoint(options.outDir, report);
    return report;
  });
}

async function main(): Promise<void> {
  const options = parseLocalizedTransientArgs(process.argv.slice(2));
  const report = await runLocalizedTransientScreening(options);
  console.log(
    `REPORT runs=${report.runs.length} errors=${report.errors.length} ` +
      `gate=${report.continuationGate.pass ? 'PASS' : 'NO_GO'} ` +
      `mean=${report.continuationGate.meanSavedGlobalDelta.toFixed(6)}`,
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
