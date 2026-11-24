/* eslint-disable no-console */
/**
 * Offline full-patch VP с canonical source, no-op и additional CD control.
 * Не вызывает production match/enhance/API и не выносит Q4 PASS.
 *
 * npx tsx src/dataset/full-patch-vp-run.ts --dataset grumu \
 *   --grumu-base /opt/synth/datasets/block-pursuit-ab-blocks2-grumu \
 *   --out datasets/full-patch-grumu --seeds 1,2,3,4 \
 *   --max-outer 24 --max-inner 12 --max-backtracks 16
 *
 * npx tsx src/dataset/full-patch-vp-run.ts --dataset match \
 *   --match-base DATASET_DIR --match-slug water_15_kick \
 *   --out datasets/full-patch-water --seeds 1,2,3,4 \
 *   --max-outer 4 --max-inner 12 --max-backtracks 16
 *
 * BOg выбирается через `--dataset bog --bog-base DIR`. Direct match
 * выбирается через `--dataset match --match-base DIR --match-slug SLUG`;
 * его source и original match совпадают. `--dataset all` последовательно
 * обрабатывает только GrumU и BOg. `--mode no-op` только проверяет source
 * и сохраняет baseline; заранее зафиксированный gate при этом не проходит.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compareCharacter } from '../character-metrics';
import {
  coordinateDescent,
  type CoordinateDescentConfig,
} from '../optimize/coordinate-descent';
import { computeUsefulZone } from '../optimize/evaluate';
import {
  sampleWorkFromProgress,
  type CoordinateDescentSampleWork,
} from '../optimize/sample-work';
import type { ProgressEntry } from '../optimize/types';
import { readWav } from '../read-wav';
import {
  mapSynthConfigToVector,
  mapSynthConfigToVectorWithFixedDelays,
} from '../synth-config-to-vector';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { mapVectorToSynthConfig } from '../vector-to-synth-config';
import { compareWaveformBands } from '../waveform-bands';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  FULL_PATCH_FINALIZATION_SAMPLE_PASSES,
  passesFullPatchCanonicalGuard,
  runFullPatchVariableProjection,
  type FullPatchVpCost,
  type FullPatchVpResult,
} from './full-patch-vp';
import {
  clonePatch,
  measureMetrics,
  renderForTarget,
  type RefitMetrics,
} from './quadrature-refit';
import { withAttackBoost } from './quadrature-refit-run';
import {
  readJsonOrNull,
  writeJsonAtomic,
  writeJsonAtomicSync,
  writeTextAtomic,
} from './shared';

export const FULL_PATCH_VP_RUN_USAGE =
  'full-patch-vp-run --dataset grumu|bog|match|all --out DIR ' +
  '[--grumu-base DIR] [--bog-base DIR] [--match-base DIR] ' +
  '[--match-slug SLUG] [--seeds 1,2,3,4] ' +
  '[--max-outer 24] [--max-inner 12] [--max-backtracks 16] ' +
  '[--mode vp|no-op]';

export const FULL_PATCH_VP_GATE = {
  requiredRuns: 4,
  minImprovedRuns: 3,
  minMeanSavedGlobalDelta: 4.6,
  minMeanResidualRmsReductionPercent: 25,
  jFloorDelta: 0.05,
} as const;

type DatasetKind = 'grumu' | 'bog' | 'match';
type DatasetSelection = DatasetKind | 'all';
type RunnerMode = 'vp' | 'no-op';

export interface FullPatchVpCliOptions {
  dataset: DatasetSelection;
  grumuBase: string;
  bogBase: string;
  matchBase: string;
  matchSlug: string;
  outDir: string;
  seeds: number[];
  maxOuter: number;
  maxInner: number;
  maxBacktracks: number;
  mode: RunnerMode;
}

interface DatasetManifest {
  targetsDir: string;
  phaseModel?: PhaseModel;
  attackBoost?: number;
}

interface SourceRunRecord {
  status: string;
  target: string;
}

interface SourceReportRun {
  slug: string;
  seed: number;
  sourceRunDir?: string;
  patch?: string;
  wav?: string;
  k2VpClipSeedRefit?: {
    patch: string;
    wav: string;
  };
}

interface SourceReport {
  dataset?: string;
  sourceReport?: string;
  runs: SourceReportRun[];
}

interface LoadedSource {
  datasetKind: DatasetKind;
  slug: string;
  seed: number;
  sourceRunDir: string;
  originalMatchRunDir: string;
  targetWavPath: string;
  patch: ArgCreateSynth;
  samples: Int16Array;
  target: Int16Array;
  sampleRate: number;
  phaseModel: PhaseModel;
  attackBoost: number;
  usefulZone: ReturnType<typeof computeUsefulZone>;
  baseline: RefitMetrics;
}

interface MetricReport extends RefitMetrics {
  residualRms: number;
  globalDelta: number;
  windowedDelta: number;
  residualRmsReductionPercent: number;
}

interface ArtifactPaths {
  patch: string;
  wav: string;
  audit: string;
}

interface GuardReport {
  sourceCanonical: boolean;
  savedCanonical: boolean;
  globalJ: boolean;
  immutable: boolean;
  withinWorkBudget: boolean;
}

interface CharacterBandsReport {
  character: ReturnType<typeof compareCharacter>;
  bands: ReturnType<typeof compareWaveformBands>;
}

interface NoOpArmReport extends ArtifactPaths, CharacterBandsReport {
  kind: 'no-op';
  metrics: MetricReport;
  workBudget: 0;
  sampleWork: 0;
  wallTimeMs: 0;
}

interface VpArmReport extends ArtifactPaths, CharacterBandsReport {
  kind: 'vp';
  status: FullPatchVpResult['status'];
  history: string;
  checkpoint: string;
  proposed: MetricReport | null;
  saved: MetricReport;
  rejectionReason: string | null;
  workBudget: number;
  sampleWork: FullPatchVpCost['sampleWork'];
  wallTimeMs: number;
  outerIterations: number;
  innerIterations: number;
  innerSolves: number;
  backtracks: number;
  clip: {
    initialSaturatedSamples: number;
    finalSaturatedSamples: number;
    maskChanges: number;
    maskRecomputations: number;
  };
  rank: {
    initialCoefficientRank: number | null;
    minOuterRank: number | null;
    maxOuterRank: number | null;
  };
  cost: FullPatchVpCost;
  guards: GuardReport;
  warnings: string[];
}

interface ControlArmReport
  extends ArtifactPaths, CharacterBandsReport {
  kind: 'additional-cd';
  status: 'completed' | 'skip-control';
  skipReason: string | null;
  history: string | null;
  checkpoint: string;
  fixedDelaySeconds: number[] | null;
  proposed: MetricReport | null;
  saved: MetricReport;
  workBudget: number;
  internalWorkBudget: number;
  canonicalGuardWork: number;
  unusedWork: number;
  sampleWork: CoordinateDescentSampleWork;
  wallTimeMs: number;
  iterationsCompleted: number;
  finalStagesSkipped: boolean;
  guards: GuardReport;
  warnings: string[];
}

export interface FullPatchVpSeedReport {
  datasetKind: DatasetKind;
  slug: string;
  seed: number;
  status: 'completed';
  sourceRunDir: string;
  originalMatchRunDir: string;
  targetWavPath: string;
  phaseModel: PhaseModel;
  attackBoost: number;
  noOp: NoOpArmReport;
  vp: VpArmReport | null;
  control: ControlArmReport | null;
  warnings: string[];
  q4Verdict: 'not-evaluated';
}

interface RunSkip {
  datasetKind: DatasetKind;
  slug: string;
  seed: number;
  status: 'skipped';
  reason: 'source-run-absent' | 'source-not-completed';
  detail: string;
}

interface RunError {
  datasetKind: DatasetKind;
  slug: string;
  seed: number;
  message: string;
}

export interface FullPatchVpTargetSummary {
  datasetKind: DatasetKind;
  slug: string;
  runs: number;
  improved: number;
  meanSavedGlobalDelta: number;
  meanResidualRmsReductionPercent: number;
  minThreeOfFourImproved: boolean;
  meanSavedGlobalAtLeast46: boolean;
  meanResidualReductionAtLeast25: boolean;
  canonicalGlobalJImmutableGuards: boolean;
  warningsNotHidden: boolean;
  gatePass: boolean;
}

interface FullPatchVpReport {
  version: 1;
  createdAt: string;
  mode: RunnerMode;
  outDir: string;
  seeds: number[];
  limits: {
    maxOuter: number;
    maxInner: number;
    maxBacktracks: number;
  };
  gate: typeof FULL_PATCH_VP_GATE;
  productionConnected: false;
  q4Verdict: 'not-evaluated';
  finished: boolean;
  runs: FullPatchVpSeedReport[];
  skips: RunSkip[];
  errors: RunError[];
  summaries: FullPatchVpTargetSummary[];
  warnings: string[];
}

interface RunnerDependencies {
  runVp: typeof runFullPatchVariableProjection;
  runCd: typeof coordinateDescent;
}

const DEFAULT_DEPENDENCIES: RunnerDependencies = {
  runVp: runFullPatchVariableProjection,
  runCd: coordinateDescent,
};

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function residualRms(
  samples: ArrayLike<number>,
  target: ArrayLike<number>,
): number {
  if (samples.length !== target.length || samples.length === 0) {
    throw new Error('Residual RMS требует одинаковые непустые PCM');
  }
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const residual = (target[index] ?? 0) - (samples[index] ?? 0);
    sum += residual * residual;
  }
  return Math.sqrt(sum / samples.length);
}

function metricReport(arg: {
  metrics: RefitMetrics;
  samples: Int16Array;
  target: Int16Array;
  baseline: RefitMetrics;
  baselineResidualRms: number;
}): MetricReport {
  const residual = residualRms(arg.samples, arg.target);
  const reduction =
    arg.baselineResidualRms > 0
      ? 100 * (1 - residual / arg.baselineResidualRms)
      : 0;
  const report = {
    ...arg.metrics,
    residualRms: residual,
    globalDelta:
      arg.metrics.globalSuppressionPercent -
      arg.baseline.globalSuppressionPercent,
    windowedDelta:
      arg.metrics.windowedSuppressionPercent -
      arg.baseline.windowedSuppressionPercent,
    residualRmsReductionPercent: reduction,
  };
  if (
    Object.values(report).some(
      (value) => typeof value === 'number' && !Number.isFinite(value),
    )
  ) {
    throw new Error('Нечисловые global/J/residual metrics');
  }
  return report;
}

function characterBands(
  target: Int16Array,
  samples: Int16Array,
  sampleRate: number,
): CharacterBandsReport {
  const report = {
    character: compareCharacter(target, samples, sampleRate),
    bands: compareWaveformBands(target, samples, sampleRate),
  };
  for (const band of report.bands) {
    if (
      !Number.isFinite(band.energy) ||
      !Number.isFinite(band.referenceEnergy) ||
      !Number.isFinite(band.candidateEnergy) ||
      (band.deltaDb !== null && !Number.isFinite(band.deltaDb))
    ) {
      throw new Error(
        `Нечисловая band metric ${band.region}/${band.name}`,
      );
    }
  }
  return report;
}

function diagnosticWarnings(
  character: CharacterBandsReport,
  extra: string[],
): string[] {
  const warnings = [...extra];
  if (character.character.bodyF0DeltaCents === null) {
    warnings.push('character: body f0 unavailable');
  }
  if (character.character.decayDb20DeltaSec === null) {
    warnings.push('character: decay unavailable');
  }
  return warnings;
}

/** Сравнивает все поля, которые соответствующий solver не имеет права менять. */
export function assertFullPatchImmutableFields(
  source: ArgCreateSynth,
  candidate: ArgCreateSynth,
  mode: 'vp' | 'cd',
): void {
  if (source.oscillators.length !== candidate.oscillators.length) {
    throw new Error('Solver изменил число oscillator slots');
  }
  const vpMutableOsc = new Set([
    'freqBase',
    'freqStart',
    'slope',
    'duration',
    'phase',
  ]);
  const vpMutableAmp = new Set([
    'startLevel',
    'duration',
    'endLevel',
    'slope',
  ]);
  const cdMutableOsc = new Set([...vpMutableOsc, 'on']);
  const cdMutableAmp = vpMutableAmp;
  const projection = (
    patch: ArgCreateSynth,
  ): Record<string, unknown>[] =>
    patch.oscillators.map((group) => {
      const active = group.osc.on;
      const oscAllowed =
        mode === 'cd'
          ? cdMutableOsc
          : active
            ? vpMutableOsc
            : new Set<string>();
      const ampAllowed =
        active || mode === 'cd' ? cdMutableAmp : new Set<string>();
      const strip = (
        value: object,
        allowed: Set<string>,
      ): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => !allowed.has(key)),
        );
      return {
        osc: strip(group.osc, oscAllowed),
        ampEnv: strip(group.ampEnv, ampAllowed),
      };
    });
  if (!isDeepStrictEqual(projection(source), projection(candidate))) {
    throw new Error(`Нарушены immutable ${mode} fields`);
  }
}

function restoreFixedOptionalFields(
  source: ArgCreateSynth,
  mapped: ArgCreateSynth,
): ArgCreateSynth {
  const patch: ArgCreateSynth = {
    oscillators: mapped.oscillators
      .slice(0, source.oscillators.length)
      .map((group, index) => {
        const original = source.oscillators[index];
        if (original === undefined) {
          throw new Error('CD потерял исходный oscillator slot');
        }
        const osc = { ...group.osc };
        const ampEnv = { ...group.ampEnv };
        if (
          Object.prototype.hasOwnProperty.call(original.osc, 'delay')
        ) {
          osc.delay = original.osc.delay ?? 0;
        } else {
          delete osc.delay;
        }
        if (
          Object.prototype.hasOwnProperty.call(
            original.ampEnv,
            'attack',
          )
        ) {
          ampEnv.attack = original.ampEnv.attack ?? 0;
        } else {
          delete ampEnv.attack;
        }
        if (
          Object.prototype.hasOwnProperty.call(
            original.ampEnv,
            'hardStop',
          )
        ) {
          ampEnv.hardStop = original.ampEnv.hardStop ?? false;
        } else {
          delete ampEnv.hardStop;
        }
        return { osc, ampEnv };
      }),
  };
  return patch;
}

async function writeWavAtomic(
  filePath: string,
  samples: Int16Array,
  sampleRate: number,
): Promise<void> {
  writeWav({ samples, sampleRate, filePath: `${filePath}.tmp` });
  await rename(`${filePath}.tmp`, filePath);
}

async function saveCanonicalArm(arg: {
  directory: string;
  patch: ArgCreateSynth;
  samples: Int16Array;
  sampleRate: number;
  phaseModel: PhaseModel;
}): Promise<ArtifactPaths> {
  mkdirSync(arg.directory, { recursive: true });
  const paths = {
    patch: join(arg.directory, 'patch.json'),
    wav: join(arg.directory, 'result.wav'),
    audit: join(arg.directory, 'audit.json'),
  };
  await writeJsonAtomic(paths.patch, arg.patch);
  await writeWavAtomic(paths.wav, arg.samples, arg.sampleRate);
  const written = readWav(paths.wav);
  assertPatchMatchesWav(
    arg.patch,
    written.samples,
    arg.phaseModel,
    arg.sampleRate,
    arg.samples.length,
  );
  return paths;
}

function countIterations(history: readonly ProgressEntry[]): number {
  return history.reduce(
    (maximum, entry) => Math.max(maximum, entry.iteration),
    0,
  );
}

function writeProgressCheckpoint(arg: {
  directory: string;
  checkpoint: string;
  value: unknown;
  warnings: string[];
}): void {
  try {
    writeJsonAtomicSync(arg.checkpoint, arg.value);
  } catch (error) {
    const message = `checkpoint write failed: ${error instanceof Error ? error.message : String(error)}`;
    if (!arg.warnings.includes(message)) {
      arg.warnings.push(message);
    }
    console.warn(`WARN ${arg.directory}: ${message}`);
  }
}

async function loadOriginalTarget(arg: {
  originalDataset: string;
  originalMatchRunDir: string;
}): Promise<{
  target: ReturnType<typeof readWav>;
  targetWavPath: string;
  manifest: DatasetManifest;
} | null> {
  const recordPath = join(arg.originalMatchRunDir, 'run.json');
  const record = await readJsonOrNull<SourceRunRecord>(recordPath);
  if (record === null) {
    if (existsSync(recordPath)) {
      throw new Error(`Битый JSON ${recordPath}`);
    }
    return null;
  }
  if (record.status !== 'completed') {
    return null;
  }
  if (
    typeof record.target !== 'string' ||
    record.target.length === 0
  ) {
    throw new Error(
      `Нет target в ${arg.originalMatchRunDir}/run.json`,
    );
  }
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(arg.originalDataset, 'manifest.json'),
  );
  if (manifest === null || typeof manifest.targetsDir !== 'string') {
    throw new Error(
      `Нет manifest.json/targetsDir в ${arg.originalDataset}`,
    );
  }
  const targetWavPath = join(manifest.targetsDir, record.target);
  return {
    target: readWav(targetWavPath),
    targetWavPath,
    manifest,
  };
}

interface SourceLocation {
  datasetKind: DatasetKind;
  slug: string;
  seed: number;
  sourceRunDir: string;
  originalDataset: string;
  originalMatchRunDir: string;
  patchPath: string;
  wavPath: string;
}

interface SourcePayload extends SourceLocation {
  patch: ArgCreateSynth;
  samples: Int16Array;
  sourceSampleRate: number;
  original: {
    target: ReturnType<typeof readWav>;
    targetWavPath: string;
    manifest: DatasetManifest;
  };
}

type VerifiedSource = Omit<LoadedSource, 'usefulZone' | 'baseline'>;

function sourceSlug(
  options: FullPatchVpCliOptions,
  datasetKind: DatasetKind,
): string {
  if (datasetKind === 'grumu') {
    return 'GrumU';
  }
  return datasetKind === 'bog'
    ? 'BOg-Disco-Futuro'
    : options.matchSlug;
}

/** Создаёт direct-match location без report-цепочек. */
function resolveDirectMatchLocation(arg: {
  options: FullPatchVpCliOptions;
  seed: number;
}): SourceLocation {
  const { matchBase, matchSlug } = arg.options;
  if (matchBase.length === 0 || matchSlug.length === 0) {
    throw new Error('Direct match требует matchBase и matchSlug');
  }
  const sourceRunDir = join(matchBase, matchSlug, `seed-${arg.seed}`);
  return {
    datasetKind: 'match',
    slug: matchSlug,
    seed: arg.seed,
    sourceRunDir,
    originalDataset: matchBase,
    originalMatchRunDir: sourceRunDir,
    patchPath: join(sourceRunDir, 'patch.json'),
    wavPath: join(sourceRunDir, 'result.wav'),
  };
}

/** Разрешает direct match или candidate по report, не смешивая их с target. */
async function resolveSourceLocation(arg: {
  options: FullPatchVpCliOptions;
  datasetKind: DatasetKind;
  seed: number;
}): Promise<SourceLocation | RunSkip> {
  if (arg.datasetKind === 'match') {
    return resolveDirectMatchLocation(arg);
  }
  const base =
    arg.datasetKind === 'grumu'
      ? arg.options.grumuBase
      : arg.options.bogBase;
  const slug = sourceSlug(arg.options, arg.datasetKind);
  const reportPath = join(base, 'report.json');
  const report = await readJsonOrNull<SourceReport>(reportPath);
  if (report === null || !Array.isArray(report.runs)) {
    throw new Error(`Нет валидного report.json в ${base}`);
  }
  const reportRun = report.runs.find(
    (run) => run.slug === slug && run.seed === arg.seed,
  );
  if (reportRun === undefined) {
    return {
      datasetKind: arg.datasetKind,
      slug,
      seed: arg.seed,
      status: 'skipped',
      reason: 'source-run-absent',
      detail: reportPath,
    };
  }
  const sourceRunDir =
    arg.datasetKind === 'grumu'
      ? join(base, slug, `seed-${arg.seed}`, 'k2-vp-clip-seed-refit')
      : join(base, slug, `seed-${arg.seed}`);
  const patchPath =
    arg.datasetKind === 'grumu'
      ? reportRun.k2VpClipSeedRefit?.patch
      : reportRun.patch;
  const wavPath =
    arg.datasetKind === 'grumu'
      ? reportRun.k2VpClipSeedRefit?.wav
      : reportRun.wav;
  if (patchPath === undefined || wavPath === undefined) {
    throw new Error(`Нет patch/WAV paths у ${slug}/seed-${arg.seed}`);
  }
  if (resolve(patchPath) !== join(sourceRunDir, 'patch.json')) {
    throw new Error(`Patch path не соответствует ${sourceRunDir}`);
  }
  if (resolve(wavPath) !== join(sourceRunDir, 'result.wav')) {
    throw new Error(`WAV path не соответствует ${sourceRunDir}`);
  }

  let originalDataset: string;
  let originalMatchRunDir: string;
  if (arg.datasetKind === 'grumu') {
    if (
      typeof report.dataset !== 'string' ||
      typeof reportRun.sourceRunDir !== 'string'
    ) {
      throw new Error(
        'GrumU report не связывает dataset и sourceRunDir',
      );
    }
    originalDataset = report.dataset;
    originalMatchRunDir = reportRun.sourceRunDir;
  } else {
    if (typeof report.sourceReport !== 'string') {
      throw new Error('BOg delayed report не содержит sourceReport');
    }
    const onsetReport = await readJsonOrNull<SourceReport>(
      report.sourceReport,
    );
    if (onsetReport === null || !Array.isArray(onsetReport.runs)) {
      throw new Error(
        `Нет валидного onset report ${report.sourceReport}`,
      );
    }
    const onsetRun = onsetReport.runs.find(
      (run) => run.slug === slug && run.seed === arg.seed,
    );
    if (
      typeof onsetReport.dataset !== 'string' ||
      typeof onsetRun?.sourceRunDir !== 'string'
    ) {
      throw new Error('BOg onset report не связывает original match');
    }
    originalDataset = onsetReport.dataset;
    originalMatchRunDir = onsetRun.sourceRunDir;
  }
  return {
    datasetKind: arg.datasetKind,
    slug,
    seed: arg.seed,
    sourceRunDir,
    originalDataset,
    originalMatchRunDir,
    patchPath,
    wavPath,
  };
}

/** Читает candidate patch/WAV и target только после source resolution. */
async function readSourcePayload(
  location: SourceLocation,
): Promise<SourcePayload | RunSkip> {
  const original = await loadOriginalTarget({
    originalDataset: location.originalDataset,
    originalMatchRunDir: location.originalMatchRunDir,
  });
  if (original === null) {
    return {
      datasetKind: location.datasetKind,
      slug: location.slug,
      seed: location.seed,
      status: 'skipped',
      reason: 'source-not-completed',
      detail: location.originalMatchRunDir,
    };
  }
  const patch = await readJsonOrNull<ArgCreateSynth>(
    location.patchPath,
  );
  if (patch === null) {
    throw new Error(
      `Нет валидного source patch ${location.patchPath}`,
    );
  }
  const sourceWav = readWav(location.wavPath);
  return {
    ...location,
    patch,
    samples: sourceWav.samples,
    sourceSampleRate: sourceWav.sampleRate,
    original,
  };
}

/** Проверяет canonical source и одинаковый формат source/target до solver. */
function verifySourcePayload(payload: SourcePayload): VerifiedSource {
  const phaseModel = payload.original.manifest.phaseModel ?? 'legacy';
  const sampleRate = payload.sourceSampleRate;
  assertPatchMatchesWav(
    payload.patch,
    payload.samples,
    phaseModel,
    sampleRate,
    payload.samples.length,
  );
  if (
    sampleRate !== payload.original.target.sampleRate ||
    payload.samples.length !== payload.original.target.samples.length
  ) {
    throw new Error(
      `Source/target WAV не совпадают у ${payload.slug}/seed-${payload.seed}`,
    );
  }
  return {
    datasetKind: payload.datasetKind,
    slug: payload.slug,
    seed: payload.seed,
    sourceRunDir: payload.sourceRunDir,
    originalMatchRunDir: payload.originalMatchRunDir,
    targetWavPath: payload.original.targetWavPath,
    patch: payload.patch,
    samples: payload.samples,
    target: payload.original.target.samples,
    sampleRate,
    phaseModel,
    attackBoost: payload.original.manifest.attackBoost ?? 1,
  };
}

/** Связывает resolve, read, canonical verify и baseline с manifest boost. */
async function loadSource(arg: {
  options: FullPatchVpCliOptions;
  datasetKind: DatasetKind;
  seed: number;
}): Promise<LoadedSource | RunSkip> {
  const location = await resolveSourceLocation(arg);
  if ('status' in location) {
    return location;
  }
  const payload = await readSourcePayload(location);
  if ('status' in payload) {
    return payload;
  }
  const verified = verifySourcePayload(payload);
  return withAttackBoost(verified.attackBoost, () => {
    const targetValues = Array.from(verified.target);
    const usefulZone = computeUsefulZone(
      targetValues,
      verified.sampleRate,
    );
    const baseline = measureMetrics(
      verified.samples,
      targetValues,
      verified.sampleRate,
      usefulZone,
    );
    return { ...verified, usefulZone, baseline };
  });
}

async function saveNoOp(
  source: LoadedSource,
  outDir: string,
): Promise<NoOpArmReport> {
  const started = Date.now();
  const artifacts = await saveCanonicalArm({
    directory: join(outDir, 'no-op'),
    patch: clonePatch(source.patch),
    samples: new Int16Array(source.samples),
    sampleRate: source.sampleRate,
    phaseModel: source.phaseModel,
  });
  const baselineResidual = residualRms(source.samples, source.target);
  const report: NoOpArmReport = {
    kind: 'no-op',
    ...artifacts,
    metrics: metricReport({
      metrics: source.baseline,
      samples: source.samples,
      target: source.target,
      baseline: source.baseline,
      baselineResidualRms: baselineResidual,
    }),
    ...characterBands(
      source.target,
      source.samples,
      source.sampleRate,
    ),
    workBudget: 0,
    sampleWork: 0,
    wallTimeMs: 0,
  };
  await writeJsonAtomic(artifacts.audit, {
    algorithm: 'canonical-no-op',
    sourceRunDir: source.sourceRunDir,
    originalMatchRunDir: source.originalMatchRunDir,
    targetWavPath: source.targetWavPath,
    phaseModel: source.phaseModel,
    attackBoost: source.attackBoost,
    metrics: report.metrics,
    character: report.character,
    bands: report.bands,
    canonicalSourceVerifiedBeforeSolver: true,
    elapsedMsNotWork: Date.now() - started,
  });
  return report;
}

function summarizeVpClip(
  result: FullPatchVpResult,
): VpArmReport['clip'] {
  const initial = result.initialInner;
  const lastInner = [...result.history]
    .reverse()
    .find((entry) => entry.inner !== null)?.inner;
  return {
    initialSaturatedSamples: initial?.finalSaturatedSamples ?? 0,
    finalSaturatedSamples:
      lastInner?.finalSaturatedSamples ??
      initial?.finalSaturatedSamples ??
      0,
    maskChanges:
      (initial?.maskChanges ?? 0) +
      result.history.reduce(
        (sum, entry) => sum + (entry.inner?.maskChanges ?? 0),
        0,
      ),
    maskRecomputations:
      (initial?.maskRecomputations ?? 0) +
      result.history.reduce(
        (sum, entry) => sum + (entry.inner?.maskRecomputations ?? 0),
        0,
      ),
  };
}

interface VpExecution {
  source: LoadedSource;
  result: FullPatchVpResult;
  wallTimeMs: number;
  directory: string;
  checkpoint: string;
  warnings: string[];
}

interface CheckedVpExecution extends VpExecution {
  proposed: MetricReport | null;
  saved: MetricReport;
  globalJ: boolean;
}

interface SavedVpExecution extends CheckedVpExecution {
  artifacts: ArtifactPaths;
  historyPath: string;
}

/** Запускает VP и оставляет running checkpoint до всех последующих checks. */
function runVp(arg: {
  source: LoadedSource;
  outDir: string;
  options: FullPatchVpCliOptions;
  dependencies: RunnerDependencies;
}): VpExecution {
  const directory = join(arg.outDir, 'vp');
  mkdirSync(directory, { recursive: true });
  const checkpoint = join(directory, 'checkpoint.json');
  const warnings: string[] = [];
  writeProgressCheckpoint({
    directory,
    checkpoint,
    warnings,
    value: {
      status: 'running',
      maxOuter: arg.options.maxOuter,
      maxInner: arg.options.maxInner,
      maxBacktracks: arg.options.maxBacktracks,
      outerIterations: 0,
    },
  });
  const started = Date.now();
  const result = arg.dependencies.runVp({
    patch: arg.source.patch,
    target: arg.source.target,
    sampleRate: arg.source.sampleRate,
    phaseModel: arg.source.phaseModel,
    maxOuter: arg.options.maxOuter,
    maxInner: arg.options.maxInner,
    maxBacktracks: arg.options.maxBacktracks,
  });
  return {
    source: arg.source,
    result,
    wallTimeMs: Date.now() - started,
    directory,
    checkpoint,
    warnings,
  };
}

/**
 * Проверяет patch/WAV и заново измеряет PCM вместо доверия solver metrics.
 * Именно эти remeasured global/J проходят guard и позже попадают в gate.
 */
function checkAndMeasureVp(
  execution: VpExecution,
): CheckedVpExecution {
  const { source, result } = execution;
  assertFullPatchImmutableFields(source.patch, result.patch, 'vp');
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    source.phaseModel,
    source.sampleRate,
    source.target.length,
  );
  if (result.proposed !== null) {
    assertFullPatchImmutableFields(
      source.patch,
      result.proposed.patch,
      'vp',
    );
  }
  const target = Array.from(source.target);
  const proposedMetrics =
    result.proposed === null
      ? null
      : measureMetrics(
          result.proposed.samples,
          target,
          source.sampleRate,
          source.usefulZone,
        );
  const savedMetrics = measureMetrics(
    result.samples,
    target,
    source.sampleRate,
    source.usefulZone,
  );
  const globalJ =
    result.status === 'refined'
      ? result.proposed !== null &&
        passesFullPatchCanonicalGuard(source.baseline, savedMetrics)
      : savedMetrics.globalSuppressionPercent ===
          source.baseline.globalSuppressionPercent &&
        savedMetrics.windowedSuppressionPercent ===
          source.baseline.windowedSuppressionPercent;
  if (!globalJ) {
    throw new Error('VP proposed/saved не прошли global/J guard');
  }
  const baselineResidual = residualRms(source.samples, source.target);
  return {
    ...execution,
    proposed:
      result.proposed === null || proposedMetrics === null
        ? null
        : metricReport({
            metrics: proposedMetrics,
            samples: result.proposed.samples,
            target: source.target,
            baseline: source.baseline,
            baselineResidualRms: baselineResidual,
          }),
    saved: metricReport({
      metrics: savedMetrics,
      samples: result.samples,
      target: source.target,
      baseline: source.baseline,
      baselineResidualRms: baselineResidual,
    }),
    globalJ,
  };
}

/** Сохраняет именно проверенные saved PCM и полную outer history. */
async function saveVpExecution(
  execution: CheckedVpExecution,
): Promise<SavedVpExecution> {
  const artifacts = await saveCanonicalArm({
    directory: execution.directory,
    patch: execution.result.patch,
    samples: execution.result.samples,
    sampleRate: execution.source.sampleRate,
    phaseModel: execution.source.phaseModel,
  });
  const historyPath = join(execution.directory, 'history.json');
  await writeJsonAtomic(historyPath, execution.result.history);
  return { ...execution, artifacts, historyPath };
}

/** Собирает DTO только из remeasured candidate/saved PCM и фактической стоимости. */
function createVpReport(execution: SavedVpExecution): VpArmReport {
  const { source, result } = execution;
  const measured = characterBands(
    source.target,
    result.samples,
    source.sampleRate,
  );
  if (result.rejectionReason !== null) {
    execution.warnings.push(`VP fallback: ${result.rejectionReason}`);
  }
  if (result.initialInner?.success === false) {
    execution.warnings.push(
      `Initial inner: ${result.initialInner.stopReason}`,
    );
  }
  if (result.proposed?.canonicalError) {
    execution.warnings.push(
      `Proposed canonical: ${result.proposed.canonicalError}`,
    );
  }
  const ranks = result.history.map((entry) => entry.rank);
  return {
    kind: 'vp',
    status: result.status,
    ...execution.artifacts,
    history: execution.historyPath,
    checkpoint: execution.checkpoint,
    proposed: execution.proposed,
    saved: execution.saved,
    rejectionReason: result.rejectionReason,
    workBudget: result.cost.sampleWork.total,
    sampleWork: result.cost.sampleWork,
    wallTimeMs: execution.wallTimeMs,
    outerIterations: result.history.length,
    innerIterations:
      (result.initialInner?.iterations ?? 0) +
      result.history.reduce(
        (sum, entry) => sum + (entry.inner?.iterations ?? 0),
        0,
      ),
    innerSolves: result.cost.innerSolves,
    backtracks:
      (result.initialInner?.backtracks ?? 0) +
      result.history.reduce(
        (sum, entry) => sum + (entry.inner?.backtracks ?? 0),
        0,
      ),
    clip: summarizeVpClip(result),
    rank: {
      initialCoefficientRank:
        result.initialInner?.diagnostics?.effectiveRank ?? null,
      minOuterRank: ranks.length > 0 ? Math.min(...ranks) : null,
      maxOuterRank: ranks.length > 0 ? Math.max(...ranks) : null,
    },
    cost: result.cost,
    ...measured,
    guards: {
      sourceCanonical: true,
      savedCanonical: true,
      globalJ: execution.globalJ,
      immutable: true,
      withinWorkBudget: true,
    },
    warnings: diagnosticWarnings(measured, execution.warnings),
  };
}

/** Сохраняет solver metrics отдельно от remeasured report/gate metrics. */
async function auditVpExecution(
  execution: SavedVpExecution,
  report: VpArmReport,
): Promise<void> {
  const { source, result } = execution;
  await writeJsonAtomic(execution.artifacts.audit, {
    algorithm: 'full-patch-vp',
    productionConnected: false,
    sourceRunDir: source.sourceRunDir,
    originalMatchRunDir: source.originalMatchRunDir,
    targetWavPath: source.targetWavPath,
    phaseModel: source.phaseModel,
    attackBoost: source.attackBoost,
    baseline: source.baseline,
    solverMetrics: {
      baseline: result.baseline,
      proposed: result.proposed?.metrics ?? null,
      saved: result.metrics,
    },
    initialInner: result.initialInner,
    proposed: report.proposed,
    saved: report.saved,
    rejectionReason: result.rejectionReason,
    cost: result.cost,
    canonicalFinalizationSamplePasses:
      FULL_PATCH_FINALIZATION_SAMPLE_PASSES,
    clip: report.clip,
    rank: report.rank,
    character: report.character,
    bands: report.bands,
    guards: report.guards,
    warnings: report.warnings,
    q4Verdict: 'not-evaluated',
  });
}

/** Связывает run, checks/measure, save, checkpoint и audit без production. */
async function executeVp(arg: {
  source: LoadedSource;
  outDir: string;
  options: FullPatchVpCliOptions;
  dependencies: RunnerDependencies;
}): Promise<VpArmReport> {
  const executed = runVp(arg);
  const checked = checkAndMeasureVp(executed);
  const saved = await saveVpExecution(checked);
  const report = createVpReport(saved);
  writeProgressCheckpoint({
    directory: saved.directory,
    checkpoint: saved.checkpoint,
    warnings: report.warnings,
    value: {
      status: 'completed',
      outerIterations: report.outerIterations,
      innerIterations: report.innerIterations,
      sampleWork: report.sampleWork,
      wallTimeMs: report.wallTimeMs,
    },
  });
  await auditVpExecution(saved, report);
  return report;
}

interface ControlExecutionInput {
  source: LoadedSource;
  outDir: string;
  workBudget: number;
  dependencies: RunnerDependencies;
}

interface ControlRepresentation {
  vector: number[];
  fixedDelaySeconds: number[] | null;
}

interface ControlBudget {
  workBudget: number;
  internalBudget: number;
  canonicalGuardWork: number;
}

/**
 * Строит только допустимое representation; localized-поля не удаляет.
 * BOg и direct match передают delay отдельным неизменным sidecar.
 */
function representControlSource(
  source: LoadedSource,
): ControlRepresentation {
  if (source.datasetKind === 'grumu') {
    return {
      vector: mapSynthConfigToVector(source.patch),
      fixedDelaySeconds: null,
    };
  }
  const delayed = mapSynthConfigToVectorWithFixedDelays(source.patch);
  return {
    vector: delayed.vector,
    fixedDelaySeconds: delayed.fixedDelaySeconds,
  };
}

/** Заранее резервирует те же 6N, которые VP тратит на canonical finalization. */
function createControlBudget(
  source: LoadedSource,
  workBudget: number,
): ControlBudget {
  const canonicalGuardWork =
    FULL_PATCH_FINALIZATION_SAMPLE_PASSES * source.target.length;
  return {
    workBudget,
    internalBudget: workBudget - canonicalGuardWork,
    canonicalGuardWork,
  };
}

/** Единый skip-control для непредставимого source и слишком маленького W. */
async function saveSkippedControl(arg: {
  source: LoadedSource;
  directory: string;
  checkpoint: string;
  budget: ControlBudget;
  reason: string;
}): Promise<ControlArmReport> {
  const { source, budget } = arg;
  const artifacts = await saveCanonicalArm({
    directory: arg.directory,
    patch: clonePatch(source.patch),
    samples: new Int16Array(source.samples),
    sampleRate: source.sampleRate,
    phaseModel: source.phaseModel,
  });
  const savedMetrics = measureMetrics(
    source.samples,
    Array.from(source.target),
    source.sampleRate,
    source.usefulZone,
  );
  const baselineResidual = residualRms(source.samples, source.target);
  const measured = characterBands(
    source.target,
    source.samples,
    source.sampleRate,
  );
  const report: ControlArmReport = {
    kind: 'additional-cd',
    status: 'skip-control',
    skipReason: arg.reason,
    ...artifacts,
    history: null,
    checkpoint: arg.checkpoint,
    fixedDelaySeconds:
      source.datasetKind === 'grumu'
        ? null
        : source.patch.oscillators.map(
            (group) => group.osc.delay ?? 0,
          ),
    proposed: null,
    saved: metricReport({
      metrics: savedMetrics,
      samples: source.samples,
      target: source.target,
      baseline: source.baseline,
      baselineResidualRms: baselineResidual,
    }),
    workBudget: budget.workBudget,
    internalWorkBudget: budget.internalBudget,
    canonicalGuardWork: budget.canonicalGuardWork,
    unusedWork: budget.workBudget,
    sampleWork: { synth: 0, evaluation: 0, cache: 0, total: 0 },
    wallTimeMs: 0,
    iterationsCompleted: 0,
    finalStagesSkipped: false,
    ...measured,
    guards: {
      sourceCanonical: true,
      savedCanonical: true,
      globalJ: true,
      immutable: true,
      withinWorkBudget: true,
    },
    warnings: [`skip-control: ${arg.reason}`],
  };
  await writeJsonAtomic(artifacts.audit, {
    algorithm: 'additional-cd-control',
    status: 'skip-control',
    reason: arg.reason,
    sourcePatchPreserved: true,
    workBudget: budget.workBudget,
    internalBudget: budget.internalBudget,
    canonicalGuardWork: budget.canonicalGuardWork,
    unusedWork: budget.workBudget,
    character: report.character,
    bands: report.bands,
    warnings: report.warnings,
  });
  return report;
}

interface BudgetedControlExecution {
  cd: ReturnType<typeof coordinateDescent>;
  internalWork: CoordinateDescentSampleWork;
  maxIterations: number;
  startedMs: number;
  warnings: string[];
}

/** Выполняет CD внутри internalBudget и пишет progress после целых iter. */
function runBudgetedControl(arg: {
  source: LoadedSource;
  representation: ControlRepresentation;
  budget: ControlBudget;
  directory: string;
  checkpoint: string;
  dependencies: RunnerDependencies;
}): BudgetedControlExecution {
  const { source, representation, budget } = arg;
  const warnings: string[] = [];
  const maxIterations = Math.max(
    1,
    Math.min(Number.MAX_SAFE_INTEGER, Math.floor(budget.workBudget)),
  );
  const config: Partial<CoordinateDescentConfig> = {
    phaseModel: source.phaseModel,
    seed: source.seed,
    earlyExitSuppression: 101,
    maxSampleWork: budget.internalBudget,
    ...(representation.fixedDelaySeconds === null
      ? {}
      : { fixedDelaySeconds: representation.fixedDelaySeconds }),
  };
  writeProgressCheckpoint({
    directory: arg.directory,
    checkpoint: arg.checkpoint,
    warnings,
    value: {
      status: 'running',
      iteration: 0,
      workBudget: budget.workBudget,
      internalBudget: budget.internalBudget,
      canonicalGuardWork: budget.canonicalGuardWork,
      fixedDelaySeconds: representation.fixedDelaySeconds,
    },
  });
  const startedMs = Date.now();
  const cd = arg.dependencies.runCd(
    representation.vector,
    Array.from(source.target),
    source.sampleRate,
    maxIterations,
    (entry) => {
      writeProgressCheckpoint({
        directory: arg.directory,
        checkpoint: arg.checkpoint,
        warnings,
        value: {
          status: 'running',
          iteration: entry.iteration,
          suppressionPercent: entry.suppressionPercent,
          sampleWork: entry.sampleWork ?? null,
          fixedDelaySeconds: representation.fixedDelaySeconds,
        },
      });
    },
    undefined,
    undefined,
    config,
  );
  return {
    cd,
    internalWork: sampleWorkFromProgress(cd.history),
    maxIterations,
    startedMs,
    warnings,
  };
}

interface GuardedControlExecution extends BudgetedControlExecution {
  accepted: boolean;
  proposedPatch: ArgCreateSynth;
  proposedSamples: Int16Array;
  proposedMetrics: RefitMetrics;
  savedPatch: ArgCreateSynth;
  savedSamples: Int16Array;
  savedMetrics: RefitMetrics;
  sampleWork: CoordinateDescentSampleWork;
  wallTimeMs: number;
}

/** Делает canonical global/J guard и заново измеряет оба фактических PCM. */
function guardControlCandidate(arg: {
  source: LoadedSource;
  representation: ControlRepresentation;
  budget: ControlBudget;
  execution: BudgetedControlExecution;
}): GuardedControlExecution {
  const { source, representation, budget, execution } = arg;
  const n = source.target.length;
  const proposedPatch =
    execution.cd.history.length === 0
      ? clonePatch(source.patch)
      : restoreFixedOptionalFields(
          source.patch,
          mapVectorToSynthConfig(
            execution.cd.vector,
            representation.fixedDelaySeconds ?? undefined,
          ),
        );
  assertFullPatchImmutableFields(source.patch, proposedPatch, 'cd');
  const proposedSamples = renderForTarget(
    proposedPatch,
    n,
    source.phaseModel,
  );
  const proposedMetrics = measureMetrics(
    proposedSamples,
    Array.from(source.target),
    source.sampleRate,
    source.usefulZone,
  );
  const accepted = passesFullPatchCanonicalGuard(
    source.baseline,
    proposedMetrics,
  );
  const savedPatch = accepted
    ? proposedPatch
    : clonePatch(source.patch);
  const savedSamples = accepted
    ? proposedSamples
    : new Int16Array(source.samples);
  const savedMetrics = measureMetrics(
    savedSamples,
    Array.from(source.target),
    source.sampleRate,
    source.usefulZone,
  );
  assertFullPatchImmutableFields(source.patch, savedPatch, 'cd');
  assertPatchMatchesWav(
    savedPatch,
    savedSamples,
    source.phaseModel,
    source.sampleRate,
    n,
  );
  const sampleWork: CoordinateDescentSampleWork = {
    synth: execution.internalWork.synth + 2 * n,
    evaluation: execution.internalWork.evaluation + 4 * n,
    cache: execution.internalWork.cache,
    total: execution.internalWork.total + budget.canonicalGuardWork,
  };
  if (sampleWork.total > budget.workBudget) {
    throw new Error(
      `CD control превысил W: ${sampleWork.total} > ${budget.workBudget}`,
    );
  }
  return {
    ...execution,
    accepted,
    proposedPatch,
    proposedSamples,
    proposedMetrics,
    savedPatch,
    savedSamples,
    savedMetrics,
    sampleWork,
    wallTimeMs: Date.now() - execution.startedMs,
  };
}

interface SavedControlExecution extends GuardedControlExecution {
  artifacts: ArtifactPaths;
  historyPath: string;
}

/** Сохраняет saved patch/WAV и history после успешного canonical guard. */
async function saveControlExecution(arg: {
  source: LoadedSource;
  directory: string;
  execution: GuardedControlExecution;
}): Promise<SavedControlExecution> {
  const artifacts = await saveCanonicalArm({
    directory: arg.directory,
    patch: arg.execution.savedPatch,
    samples: arg.execution.savedSamples,
    sampleRate: arg.source.sampleRate,
    phaseModel: arg.source.phaseModel,
  });
  const historyPath = join(arg.directory, 'history.json');
  await writeJsonAtomic(historyPath, arg.execution.cd.history);
  return { ...arg.execution, artifacts, historyPath };
}

/** Создаёт control DTO из remeasured PCM, явного reserve и недобора W. */
function createControlReport(arg: {
  source: LoadedSource;
  representation: ControlRepresentation;
  budget: ControlBudget;
  directory: string;
  checkpoint: string;
  execution: SavedControlExecution;
}): ControlArmReport {
  const { source, budget, execution } = arg;
  const baselineResidual = residualRms(source.samples, source.target);
  const proposed = metricReport({
    metrics: execution.proposedMetrics,
    samples: execution.proposedSamples,
    target: source.target,
    baseline: source.baseline,
    baselineResidualRms: baselineResidual,
  });
  const saved = metricReport({
    metrics: execution.savedMetrics,
    samples: execution.savedSamples,
    target: source.target,
    baseline: source.baseline,
    baselineResidualRms: baselineResidual,
  });
  const measured = characterBands(
    source.target,
    execution.savedSamples,
    source.sampleRate,
  );
  if (!execution.accepted) {
    execution.warnings.push('CD proposed rejected by global/J guard');
  }
  const finalStagesSkipped =
    execution.cd.history.length === 0 ||
    execution.cd.history[execution.cd.history.length - 1]
      ?.finalStagesSkipped === true;
  if (execution.cd.history.length === 0) {
    execution.warnings.push(
      'CD startup skipped by sample-work budget',
    );
  }
  return {
    kind: 'additional-cd',
    status: 'completed',
    skipReason: null,
    ...execution.artifacts,
    history: execution.historyPath,
    checkpoint: arg.checkpoint,
    fixedDelaySeconds: arg.representation.fixedDelaySeconds,
    proposed,
    saved,
    workBudget: budget.workBudget,
    internalWorkBudget: budget.internalBudget,
    canonicalGuardWork: budget.canonicalGuardWork,
    unusedWork: budget.workBudget - execution.sampleWork.total,
    sampleWork: execution.sampleWork,
    wallTimeMs: execution.wallTimeMs,
    iterationsCompleted: countIterations(execution.cd.history),
    finalStagesSkipped,
    ...measured,
    guards: {
      sourceCanonical: true,
      savedCanonical: true,
      globalJ: true,
      immutable: true,
      withinWorkBudget: true,
    },
    warnings: diagnosticWarnings(measured, execution.warnings),
  };
}

/** Записывает доказательства work parity и remeasured/solver разделение. */
async function auditControlExecution(arg: {
  source: LoadedSource;
  representation: ControlRepresentation;
  budget: ControlBudget;
  report: ControlArmReport;
  execution: SavedControlExecution;
}): Promise<void> {
  await writeJsonAtomic(arg.execution.artifacts.audit, {
    algorithm: 'additional-cd-control',
    productionConnected: false,
    sourceRunDir: arg.source.sourceRunDir,
    originalMatchRunDir: arg.source.originalMatchRunDir,
    targetWavPath: arg.source.targetWavPath,
    phaseModel: arg.source.phaseModel,
    attackBoost: arg.source.attackBoost,
    seed: arg.source.seed,
    representation:
      arg.source.datasetKind === 'grumu'
        ? 'vector'
        : 'vector+fixedDelaySeconds',
    fixedDelaySeconds: arg.representation.fixedDelaySeconds,
    maxIterations: arg.execution.maxIterations,
    internalBudget: arg.budget.internalBudget,
    canonicalGuardWork: arg.budget.canonicalGuardWork,
    unusedWork: arg.report.unusedWork,
    iterationsCompleted: arg.report.iterationsCompleted,
    finalStagesSkipped: arg.report.finalStagesSkipped,
    proposed: arg.report.proposed,
    saved: arg.report.saved,
    sampleWork: arg.report.sampleWork,
    workBudget: arg.budget.workBudget,
    wallTimeMs: arg.report.wallTimeMs,
    character: arg.report.character,
    bands: arg.report.bands,
    guards: arg.report.guards,
    warnings: arg.report.warnings,
    q4Verdict: 'not-evaluated',
  });
}

/** Связывает representation, budgeted CD, canonical guard, save и audit. */
export async function executeAdditionalCdControl(
  arg: ControlExecutionInput,
): Promise<ControlArmReport> {
  const directory = join(arg.outDir, 'control');
  mkdirSync(directory, { recursive: true });
  const checkpoint = join(directory, 'checkpoint.json');
  const budget = createControlBudget(arg.source, arg.workBudget);
  let representation: ControlRepresentation;
  try {
    representation = representControlSource(arg.source);
  } catch (error) {
    return saveSkippedControl({
      source: arg.source,
      directory,
      checkpoint,
      budget,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (budget.internalBudget < 0) {
    return saveSkippedControl({
      source: arg.source,
      directory,
      checkpoint,
      budget,
      reason: 'W меньше canonical guard',
    });
  }
  const executed = runBudgetedControl({
    source: arg.source,
    representation,
    budget,
    directory,
    checkpoint,
    dependencies: arg.dependencies,
  });
  const guarded = guardControlCandidate({
    source: arg.source,
    representation,
    budget,
    execution: executed,
  });
  const saved = await saveControlExecution({
    source: arg.source,
    directory,
    execution: guarded,
  });
  const report = createControlReport({
    source: arg.source,
    representation,
    budget,
    directory,
    checkpoint,
    execution: saved,
  });
  writeProgressCheckpoint({
    directory,
    checkpoint,
    warnings: report.warnings,
    value: {
      status: 'completed',
      iteration: report.iterationsCompleted,
      sampleWork: report.sampleWork,
      workBudget: report.workBudget,
      unusedWork: report.unusedWork,
      fixedDelaySeconds: representation.fixedDelaySeconds,
      finalStagesSkipped: report.finalStagesSkipped,
    },
  });
  await auditControlExecution({
    source: arg.source,
    representation,
    budget,
    report,
    execution: saved,
  });
  return report;
}

async function processSeed(arg: {
  source: LoadedSource;
  options: FullPatchVpCliOptions;
  dependencies: RunnerDependencies;
}): Promise<FullPatchVpSeedReport> {
  const outDir = join(
    arg.options.outDir,
    arg.source.slug,
    `seed-${arg.source.seed}`,
  );
  const noOp = await saveNoOp(arg.source, outDir);
  let vp: VpArmReport | null = null;
  let control: ControlArmReport | null = null;
  if (arg.options.mode === 'vp') {
    vp = await executeVp({
      source: arg.source,
      outDir,
      options: arg.options,
      dependencies: arg.dependencies,
    });
    control = await executeAdditionalCdControl({
      source: arg.source,
      outDir,
      workBudget: vp.workBudget,
      dependencies: arg.dependencies,
    });
  }
  const warnings = [
    ...(vp?.warnings ?? []),
    ...(control?.warnings ?? []),
  ];
  const report: FullPatchVpSeedReport = {
    datasetKind: arg.source.datasetKind,
    slug: arg.source.slug,
    seed: arg.source.seed,
    status: 'completed',
    sourceRunDir: arg.source.sourceRunDir,
    originalMatchRunDir: arg.source.originalMatchRunDir,
    targetWavPath: arg.source.targetWavPath,
    phaseModel: arg.source.phaseModel,
    attackBoost: arg.source.attackBoost,
    noOp,
    vp,
    control,
    warnings,
    q4Verdict: 'not-evaluated',
  };
  await writeJsonAtomic(join(outDir, 'run.json'), report);
  return report;
}

/** Применяет заранее зафиксированный gate только к saved canonical VP. */
export function summarizeFullPatchVpTarget(
  datasetKind: DatasetKind,
  slug: string,
  runs: FullPatchVpSeedReport[],
  reportedWarnings: readonly string[],
): FullPatchVpTargetSummary {
  const vpRuns = runs.filter((run) => run.vp !== null);
  const improved = vpRuns.filter(
    (run) =>
      run.vp?.status === 'refined' &&
      (run.vp.saved.globalDelta ?? 0) > 0,
  ).length;
  const meanSavedGlobalDelta = mean(
    vpRuns.map((run) => run.vp?.saved.globalDelta ?? 0),
  );
  const meanResidual = mean(
    vpRuns.map(
      (run) => run.vp?.saved.residualRmsReductionPercent ?? 0,
    ),
  );
  const ownWarnings = runs.flatMap((run) =>
    run.warnings.map(
      (warning) =>
        `${run.datasetKind}/${run.slug}/seed-${run.seed}: ${warning}`,
    ),
  );
  const warningsNotHidden = ownWarnings.every((warning) =>
    reportedWarnings.includes(warning),
  );
  const minThreeOfFourImproved =
    vpRuns.length === FULL_PATCH_VP_GATE.requiredRuns &&
    improved >= FULL_PATCH_VP_GATE.minImprovedRuns;
  const meanSavedGlobalAtLeast46 =
    vpRuns.length === FULL_PATCH_VP_GATE.requiredRuns &&
    meanSavedGlobalDelta >=
      FULL_PATCH_VP_GATE.minMeanSavedGlobalDelta;
  const meanResidualReductionAtLeast25 =
    vpRuns.length === FULL_PATCH_VP_GATE.requiredRuns &&
    meanResidual >=
      FULL_PATCH_VP_GATE.minMeanResidualRmsReductionPercent;
  const canonicalGlobalJImmutableGuards =
    vpRuns.length === FULL_PATCH_VP_GATE.requiredRuns &&
    vpRuns.every((run) =>
      Object.values(run.vp?.guards ?? {}).every(Boolean),
    );
  return {
    datasetKind,
    slug,
    runs: vpRuns.length,
    improved,
    meanSavedGlobalDelta,
    meanResidualRmsReductionPercent: meanResidual,
    minThreeOfFourImproved,
    meanSavedGlobalAtLeast46,
    meanResidualReductionAtLeast25,
    canonicalGlobalJImmutableGuards,
    warningsNotHidden,
    gatePass:
      minThreeOfFourImproved &&
      meanSavedGlobalAtLeast46 &&
      meanResidualReductionAtLeast25 &&
      canonicalGlobalJImmutableGuards &&
      warningsNotHidden,
  };
}

function makeReport(arg: {
  options: FullPatchVpCliOptions;
  runs: FullPatchVpSeedReport[];
  skips: RunSkip[];
  errors: RunError[];
  finished: boolean;
}): FullPatchVpReport {
  const warnings = arg.runs.flatMap((run) =>
    run.warnings.map(
      (warning) =>
        `${run.datasetKind}/${run.slug}/seed-${run.seed}: ${warning}`,
    ),
  );
  const keys = [
    ...new Set(
      arg.runs.map((run) => `${run.datasetKind}\0${run.slug}`),
    ),
  ];
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    mode: arg.options.mode,
    outDir: arg.options.outDir,
    seeds: arg.options.seeds,
    limits: {
      maxOuter: arg.options.maxOuter,
      maxInner: arg.options.maxInner,
      maxBacktracks: arg.options.maxBacktracks,
    },
    gate: FULL_PATCH_VP_GATE,
    productionConnected: false,
    q4Verdict: 'not-evaluated',
    finished: arg.finished,
    runs: arg.runs,
    skips: arg.skips,
    errors: arg.errors,
    summaries: keys.map((key) => {
      const [datasetKind, slug] = key.split('\0');
      return summarizeFullPatchVpTarget(
        datasetKind as DatasetKind,
        slug ?? '',
        arg.runs.filter(
          (run) =>
            run.datasetKind === datasetKind && run.slug === slug,
        ),
        warnings,
      );
    }),
    warnings,
  };
}

function renderReportMarkdown(report: FullPatchVpReport): string {
  const lines = [
    '# Offline full-patch VP и additional CD control',
    '',
    'Все ветки стартуют с одного проверенного canonical patch. No-op сохраняет исходник. W равен фактическому VP sampleWork; CD завершает только целые итерации и не превышает W. Character/bands сохранены как измерения; Q4 не оценивался.',
    '',
    '| Набор | Таргет | Сид | VP Δ global | VP Δ J | Residual reduction, % | VP W | CD W | VP outer | CD целых iter | VP с | CD с |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const run of report.runs) {
    lines.push(
      `| ${run.datasetKind} | ${run.slug} | ${run.seed} | ${run.vp?.saved.globalDelta.toFixed(3) ?? '—'} | ${run.vp?.saved.windowedDelta.toFixed(3) ?? '—'} | ${run.vp?.saved.residualRmsReductionPercent.toFixed(2) ?? '—'} | ${run.vp?.workBudget ?? '—'} | ${run.control?.sampleWork.total ?? '—'} | ${run.vp?.outerIterations ?? '—'} | ${run.control?.iterationsCompleted ?? '—'} | ${run.vp === null ? '—' : (run.vp.wallTimeMs / 1000).toFixed(1)} | ${run.control === null ? '—' : (run.control.wallTimeMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push(
    '',
    `Gate заранее зафиксирован: 4 сида, минимум 3 улучшенных, mean saved global ≥ ${FULL_PATCH_VP_GATE.minMeanSavedGlobalDelta} п.п., mean residual RMS reduction ≥ ${FULL_PATCH_VP_GATE.minMeanResidualRmsReductionPercent}%. Также нужны canonical/global/J/immutable/work guards и видимые warnings.`,
    '',
    '| Набор | Таргет | Runs | Improved | Mean Δ global | Mean residual reduction | 3/4 | ≥4.6 | ≥25% | Guards | Warnings visible | Gate |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- |',
  );
  for (const summary of report.summaries) {
    lines.push(
      `| ${summary.datasetKind} | ${summary.slug} | ${summary.runs} | ${summary.improved} | ${summary.meanSavedGlobalDelta.toFixed(3)} | ${summary.meanResidualRmsReductionPercent.toFixed(2)} | ${summary.minThreeOfFourImproved} | ${summary.meanSavedGlobalAtLeast46} | ${summary.meanResidualReductionAtLeast25} | ${summary.canonicalGlobalJImmutableGuards} | ${summary.warningsNotHidden} | ${summary.gatePass} |`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  if (report.errors.length > 0) {
    lines.push('', '## Errors', '');
    for (const error of report.errors) {
      lines.push(
        `- ${error.datasetKind}/${error.slug}/seed-${error.seed}: ${error.message}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function checkpointReport(
  options: FullPatchVpCliOptions,
  report: FullPatchVpReport,
): Promise<void> {
  mkdirSync(options.outDir, { recursive: true });
  await writeJsonAtomic(join(options.outDir, 'report.json'), report);
  await writeTextAtomic(
    join(options.outDir, 'report.md'),
    renderReportMarkdown(report),
  );
  await writeJsonAtomic(join(options.outDir, 'checkpoint.json'), {
    finished: report.finished,
    runs: report.runs.length,
    skips: report.skips.length,
    errors: report.errors.length,
    summaries: report.summaries,
  });
}

/** Последовательно обрабатывает выбранные synthetic или реальные источники. */
export async function runFullPatchVpScreening(
  options: FullPatchVpCliOptions,
  dependencies: RunnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<FullPatchVpReport> {
  const kinds: DatasetKind[] =
    options.dataset === 'all' ? ['grumu', 'bog'] : [options.dataset];
  const runs: FullPatchVpSeedReport[] = [];
  const skips: RunSkip[] = [];
  const errors: RunError[] = [];
  await checkpointReport(
    options,
    makeReport({ options, runs, skips, errors, finished: false }),
  );
  for (const datasetKind of kinds) {
    for (const seed of options.seeds) {
      const slug = sourceSlug(options, datasetKind);
      try {
        const source = await loadSource({
          options,
          datasetKind,
          seed,
        });
        if ('status' in source) {
          skips.push(source);
          console.log(
            `SKIP ${datasetKind}/seed-${seed}: ${source.reason}`,
          );
        } else {
          const run = await withAttackBoost(
            source.attackBoost,
            async () =>
              processSeed({ source, options, dependencies }),
          );
          runs.push(run);
          console.log(
            `RESULT ${datasetKind} seed=${seed} ` +
              `globalDelta=${run.vp?.saved.globalDelta.toFixed(3) ?? 'no-op'} ` +
              `residualReduction=${run.vp?.saved.residualRmsReductionPercent.toFixed(2) ?? 'no-op'} ` +
              `W=${run.vp?.workBudget ?? 0} controlW=${run.control?.sampleWork.total ?? 0}`,
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        errors.push({ datasetKind, slug, seed, message });
        console.warn(`WARN ${datasetKind}/seed-${seed}: ${message}`);
      }
      await checkpointReport(
        options,
        makeReport({ options, runs, skips, errors, finished: false }),
      );
    }
  }
  const final = makeReport({
    options,
    runs,
    skips,
    errors,
    finished: true,
  });
  await checkpointReport(options, final);
  return final;
}

/** Принимает только один безопасный сегмент каталога для direct match. */
function isSafeMatchSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug !== '.' &&
    slug !== '..' &&
    !isAbsolute(slug) &&
    !slug.includes('/') &&
    !slug.includes('\\')
  );
}

function positiveInteger(
  value: string,
  name: string,
  allowZero: boolean,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(
      `${name} должен быть safe integer >= ${allowZero ? 0 : 1}`,
    );
  }
  return parsed;
}

/** Разбирает однозначный CLI без запуска solver. */
export function parseFullPatchVpRunArgs(
  args: string[],
): FullPatchVpCliOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    '--dataset',
    '--grumu-base',
    '--bog-base',
    '--match-base',
    '--match-slug',
    '--out',
    '--seeds',
    '--max-outer',
    '--max-inner',
    '--max-backtracks',
    '--mode',
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || !allowed.has(key)) {
      throw new Error(`Unknown argument: ${key ?? ''}`);
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (values.has(key)) {
      throw new Error(`Duplicate argument: ${key}`);
    }
    values.set(key, value);
  }
  const dataset = values.get('--dataset') ?? '';
  if (
    dataset !== 'grumu' &&
    dataset !== 'bog' &&
    dataset !== 'match' &&
    dataset !== 'all'
  ) {
    throw new Error(
      `--dataset должен быть grumu|bog|match|all\n${FULL_PATCH_VP_RUN_USAGE}`,
    );
  }
  const outDir = values.get('--out');
  if (outDir === undefined || outDir.length === 0) {
    throw new Error(`Нужен --out\n${FULL_PATCH_VP_RUN_USAGE}`);
  }
  const grumuBase = values.has('--grumu-base')
    ? resolve(values.get('--grumu-base') ?? '')
    : '';
  const bogBase = values.has('--bog-base')
    ? resolve(values.get('--bog-base') ?? '')
    : '';
  const matchBase = values.has('--match-base')
    ? resolve(values.get('--match-base') ?? '')
    : '';
  const matchSlug = values.get('--match-slug') ?? '';
  const expectedBaseArguments: Record<DatasetSelection, string[]> = {
    grumu: ['--grumu-base'],
    bog: ['--bog-base'],
    match: ['--match-base'],
    all: ['--grumu-base', '--bog-base'],
  };
  for (const key of ['--grumu-base', '--bog-base', '--match-base']) {
    if (
      values.has(key) &&
      !expectedBaseArguments[dataset].includes(key)
    ) {
      throw new Error(
        `${key} не используется с --dataset ${dataset}`,
      );
    }
  }
  if (dataset !== 'match' && values.has('--match-slug')) {
    throw new Error(
      `--match-slug не используется с --dataset ${dataset}`,
    );
  }
  if (
    dataset === 'match' &&
    (!values.has('--match-base') ||
      (values.get('--match-base') ?? '').length === 0)
  ) {
    throw new Error('Direct match требует явный --match-base');
  }
  if (dataset === 'match' && matchSlug.length === 0) {
    throw new Error('Direct match требует явный --match-slug');
  }
  if (dataset === 'match' && !isSafeMatchSlug(matchSlug)) {
    throw new Error(
      '--match-slug должен быть одним безопасным сегментом каталога',
    );
  }
  if (
    (dataset === 'grumu' || dataset === 'all') &&
    !values.has('--grumu-base')
  ) {
    throw new Error('GrumU требует явный --grumu-base');
  }
  if (
    (dataset === 'bog' || dataset === 'all') &&
    !values.has('--bog-base')
  ) {
    throw new Error('BOg требует явный --bog-base');
  }
  const resolvedOutDir = resolve(outDir);
  for (const [baseName, base] of [
    ['--grumu-base', grumuBase],
    ['--bog-base', bogBase],
    ['--match-base', matchBase],
  ] as const) {
    if (base.length > 0 && resolvedOutDir === base) {
      throw new Error(`--out не должен совпадать с ${baseName}`);
    }
  }
  const seeds = (values.get('--seeds') ?? '1,2,3,4')
    .split(',')
    .map((value) => positiveInteger(value, '--seeds', false));
  if (seeds.length === 0 || new Set(seeds).size !== seeds.length) {
    throw new Error('--seeds должен содержать уникальные целые >= 1');
  }
  const mode = values.get('--mode') ?? 'vp';
  if (mode !== 'vp' && mode !== 'no-op') {
    throw new Error('--mode должен быть vp|no-op');
  }
  return {
    dataset,
    grumuBase,
    bogBase,
    matchBase,
    matchSlug,
    outDir: resolvedOutDir,
    seeds,
    maxOuter: positiveInteger(
      values.get('--max-outer') ?? '24',
      '--max-outer',
      true,
    ),
    maxInner: positiveInteger(
      values.get('--max-inner') ?? '12',
      '--max-inner',
      false,
    ),
    maxBacktracks: positiveInteger(
      values.get('--max-backtracks') ?? '16',
      '--max-backtracks',
      true,
    ),
    mode,
  };
}

async function main(): Promise<void> {
  const options = parseFullPatchVpRunArgs(process.argv.slice(2));
  const report = await runFullPatchVpScreening(options);
  for (const summary of report.summaries) {
    console.log(
      `GATE ${summary.datasetKind}/${summary.slug} pass=${summary.gatePass} ` +
        `runs=${summary.runs} improved=${summary.improved} ` +
        `meanGlobal=${summary.meanSavedGlobalDelta.toFixed(3)} ` +
        `meanResidualReduction=${summary.meanResidualRmsReductionPercent.toFixed(2)}`,
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
