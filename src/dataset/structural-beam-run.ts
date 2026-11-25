/* eslint-disable no-console */
/**
 * Offline-runner residual-driven native structural beam.
 *
 * Runner читает canonical source из одного дерева, а target и phase/attackBoost
 * из независимого target dataset. Beam и width-1 получают одинаковый W и
 * независимые residual proposer sessions. Runner не вызывает CD, match,
 * enhance или production API и не выносит вердикт Q4.
 *
 * npx tsx src/dataset/structural-beam-run.ts \
 *   --source-base datasets/block --target-dataset datasets/reference \
 *   --slug Synthetic --out datasets/structural --seeds 1,2,3,4 \
 *   --work-budget 1000000000
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { rename } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  compareCharacter,
  type CharacterDelta,
} from '../character-metrics';
import {
  computeUsefulZone,
  type UsefulZone,
} from '../optimize/evaluate';
import { readWav } from '../read-wav';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import {
  compareWaveformBands,
  type WaveformBandDelta,
} from '../waveform-bands';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  runNativeStructuralBeamWithWidthControl,
  type NativeStructuralBeamResult,
  type NativeStructuralHistoryEntry,
  type NativeStructuralNode,
  type NativeStructuralProposed,
} from './native-structural-beam';
import {
  measureMetrics,
  type RefitMetrics,
} from './quadrature-refit';
import { withAttackBoost } from './quadrature-refit-run';
import {
  createResidualStructuralProposer,
  type ResidualStructuralProposerOptions,
  type ResidualStructuralProposerSession,
  type ResidualStructuralProposerSnapshot,
} from './residual-structural-proposer';
import {
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';
import type { StructuralDenseWork } from './structural-work';

/** Имя режима: полный solver либо сохранение исходника без solver. */
export type StructuralBeamRunMode = 'vp' | 'no-op';

/** Ветвь paired native experiment. */
export type StructuralBeamBranchName = 'beam' | 'width1';

/** Аргументы CLI и программного offline-запуска. */
export interface StructuralBeamCliOptions {
  sourceBase: string;
  targetDataset: string;
  slug: string;
  outDir: string;
  seeds: number[];
  /** Общий W evaluator+expansion каждой ветви, не число итераций. */
  workBudget: number;
  candidateSubdir: string;
  beamWidth: number;
  maxDepth: number;
  maxGroupSize: number;
  maxInner: number;
  maxBacktracks: number;
  mode: StructuralBeamRunMode;
}

/**
 * Точки расширения только для offline synthetic tests.
 * Production CLI их не принимает.
 */
export interface StructuralBeamRunDependencies {
  /** Позволяет проверить no-op и восстановление attackBoost после ошибки. */
  runBeam?: typeof runNativeStructuralBeamWithWidthControl;
  /** Может задать known-answer windows/shapes/injections; target защищён. */
  configureProposer?: (
    options: ResidualStructuralProposerOptions,
  ) => ResidualStructuralProposerOptions;
}

interface DatasetManifest {
  targetsDir: string;
  phaseModel: PhaseModel;
  attackBoost: number;
}

interface RunRecord {
  status: string;
  target: string;
}

/** Ошибка одного сида не скрывается и запрещает PASS эксперимента. */
export interface StructuralBeamRunError {
  slug: string;
  seed: number;
  message: string;
}

/** Штатный пропуск отсутствующего или незавершённого original run. */
export interface StructuralBeamRunSkip {
  slug: string;
  seed: number;
  reason: 'missing-run' | 'not-completed';
}

/** Canonical PCM-метрики и характер одного baseline/proposed/saved WAV. */
export interface StructuralBeamMeasurement extends RefitMetrics {
  globalDelta: number;
  windowedDelta: number;
  residualRms: number;
  /** null означает нулевой baseline residual при ненулевом кандидате. */
  residualRmsReductionPercent: number | null;
  character: CharacterDelta;
  bands: WaveformBandDelta[];
}

/** Метрики и canonical файлы лучшего evaluated candidate до saved guard. */
export interface StructuralBeamProposedReport extends StructuralBeamMeasurement {
  nodeKey: string;
  candidateKey: string;
  parentKey: string | null;
  depth: number;
  groupSize: number;
  estimatedWork: number;
  cost: number;
  patch: string;
  wav: string;
}

/** Раздельный учёт W и работы, которая в W не входит. */
export interface StructuralBeamWorkReport {
  budget: number;
  used: number;
  unused: number;
  evaluatorWork: number;
  expansionWork: number;
  denseWork: StructuralDenseWork;
  /** Native root не измеряет N-pass; null не выдаёт его за нулевую работу. */
  rootSampleWork: number | null;
  rootIncludedInBudget: false;
  /** При принятом candidate native сообщает ровно 5N. */
  finalizationSampleWork: number;
  finalizationIncludedInBudget: false;
}

/** Guard одной сохранённой ветви; улучшение gate считает отдельно. */
export interface StructuralBeamGuards {
  canonical: boolean;
  global: boolean;
  windowed: boolean;
  immutable: boolean;
  work: boolean;
}

/** Компактный узел пути без копий PCM и cached contributions. */
export interface StructuralBeamPathEntry {
  nodeKey: string;
  candidateKey: string | null;
  parentKey: string | null;
  depth: number;
  groupSize: number;
  estimatedWork: number;
  cost: number;
  metrics: RefitMetrics;
}

/** Полный публичный отчёт одной сохранённой ветви. */
export interface StructuralBeamBranchReport {
  slug: string;
  seed: number;
  branch: StructuralBeamBranchName;
  status: 'refined' | 'unchanged';
  sourceDir: string;
  directory: string;
  patch: string;
  wav: string;
  audit: string;
  history: string;
  checkpoint: string;
  baseline: StructuralBeamMeasurement;
  proposed: StructuralBeamProposedReport | null;
  saved: StructuralBeamMeasurement;
  work: StructuralBeamWorkReport;
  proposer: ResidualStructuralProposerSnapshot;
  expansions: NativeStructuralBeamResult['expansions'];
  skips: NativeStructuralBeamResult['skips'];
  path: StructuralBeamPathEntry[];
  rejectionReason: string | null;
  canonicalError: string | null;
  warnings: string[];
  guards: StructuralBeamGuards;
  algorithmOptions: {
    beamWidth: number;
    maxDepth: number;
    maxGroupSize: number;
    maxInner: number;
    maxBacktracks: number;
    workBudget: number;
  };
}

/** Минимальный вход gate; полный run report совместим структурно. */
export interface StructuralBeamGateRun {
  seed: number;
  beam: {
    status: 'refined' | 'unchanged';
    saved: {
      globalDelta: number;
      residualRmsReductionPercent: number | null;
    };
    guards: StructuralBeamGuards;
    warnings: string[];
  };
  width1: {
    guards: StructuralBeamGuards;
    warnings: string[];
  };
}

/** Заранее зафиксированный gate не выбирает ветвь по результатам. */
export interface StructuralBeamGateResult {
  requiredCompletedSeeds: 4;
  minImprovedBeamSeeds: 3;
  minMeanBeamGlobalDelta: 4.6;
  minMeanBeamResidualRmsReductionPercent: 25;
  requestedSeeds: number;
  completedSeeds: number;
  improvedBeamSeeds: number;
  meanBeamGlobalDelta: number | null;
  meanBeamResidualRmsReductionPercent: number | null;
  meanWidth1GlobalDelta: number | null;
  meanBeamMinusWidth1Global: number | null;
  errors: number;
  skips: number;
  guardsPass: boolean;
  warningCount: number;
  pass: boolean;
}

/** Разница ветвей видна отдельно и не меняет выбор beam для gate. */
export interface StructuralBeamControlDelta {
  savedGlobal: number;
  savedWindowed: number;
  savedResidualRmsReductionPercent: number | null;
  proposedGlobal: number | null;
  proposedWindowed: number | null;
}

/** Парный результат одного completed original run. */
export interface StructuralBeamSeedReport {
  slug: string;
  seed: number;
  sourceDir: string;
  originalRunDir: string;
  targetPath: string;
  inputSha256: Record<string, string>;
  beam: StructuralBeamBranchReport;
  width1: StructuralBeamBranchReport;
  beamMinusWidth1: StructuralBeamControlDelta;
  immutable: boolean;
  warnings: string[];
  /** Wall clock не входит в W и не смешивается с dense-work. */
  wallTimeMs: number;
  solverWallTimeMs: number;
}

/** Главный report и содержимое checkpoint после каждого сида. */
export interface StructuralBeamScreeningReport {
  version: 1;
  experiment: 'residual-structural-beam';
  hypothesisOnly: true;
  productionConnected: false;
  q4Pass: null;
  coordinateDescentStarted: false;
  createdAt: string;
  finishedAt: string | null;
  finished: boolean;
  sourceBase: string;
  targetDataset: string;
  targetsDir: string;
  slug: string;
  outDir: string;
  candidateSubdir: string;
  seeds: number[];
  mode: StructuralBeamRunMode;
  workBudget: number;
  phaseModel: PhaseModel;
  attackBoost: number;
  algorithmOptions: StructuralBeamBranchReport['algorithmOptions'];
  gate: StructuralBeamGateResult;
  errors: StructuralBeamRunError[];
  skips: StructuralBeamRunSkip[];
  runs: StructuralBeamSeedReport[];
  warnings: string[];
  wallTimeMs: number;
}

/** Пороги зафиксированы до чтения результатов. */
export const STRUCTURAL_BEAM_GATE = {
  requiredCompletedSeeds: 4,
  minImprovedBeamSeeds: 3,
  minMeanBeamGlobalDelta: 4.6,
  minMeanBeamResidualRmsReductionPercent: 25,
} as const;

export const STRUCTURAL_BEAM_RUN_USAGE =
  'Usage: structural-beam-run --source-base DIR --target-dataset DIR ' +
  '--slug SLUG --out DIR --seeds 1,2,3,4 --work-budget N ' +
  '[--candidate-subdir k2-vp-clip-seed-refit] [--beam-width 4] ' +
  '[--max-depth 20] [--max-group-size 20] [--max-inner 12] ' +
  '[--max-backtracks 16] [--mode vp|no-op]';

const GLOBAL_GUARD_EPSILON = 1e-9;
const WINDOWED_GUARD_FLOOR = 0.05;
const MAX_STRUCTURAL_GROUP_SIZE = 50;

/** Проверяет, что child совпадает с parent или лежит внутри него. */
function pathIsSameOrInside(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return (
    rest === '' ||
    (rest !== '..' &&
      !rest.startsWith(`..${sep}`) &&
      !isAbsolute(rest))
  );
}

/** Отклоняет unsafe slug, абсолютные пути и выход через `..`. */
function assertSafeRelativePath(
  value: string,
  label: string,
  allowDot: boolean,
  singleSegment = !allowDot,
): void {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value)
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const segments = value.split('/');
  const hasControlCharacter = (segment: string): boolean =>
    Array.from(segment).some((character) => {
      const code = character.charCodeAt(0);
      return code >= 0 && code <= 31;
    });
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '..' ||
        (!allowDot && segment === '.') ||
        hasControlCharacter(segment),
    ) ||
    (singleSegment && segments.length !== 1) ||
    (allowDot && value !== '.' && segments.includes('.'))
  ) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
}

/** Проверяет единственный slug без разделителей и специальных сегментов. */
function assertSafeSlug(slug: string): void {
  assertSafeRelativePath(slug, '--slug', false);
  if (slug === '.' || slug === '..') {
    throw new Error('--slug must be one safe path segment');
  }
}

/** Проверяет конечный safe integer в заданном диапазоне. */
function assertSafeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be a safe integer within ${minimum}..${maximum}`,
    );
  }
}

/** Разбирает строгое числовое значение без молчаливого Number('') = 0. */
function parseNumber(value: string, label: string): number {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return Number(value);
}

/** Проверяет все ограничения, включая обязательный W и collision out. */
function validateOptions(options: StructuralBeamCliOptions): void {
  if (
    options.sourceBase.length === 0 ||
    options.targetDataset.length === 0 ||
    options.outDir.length === 0
  ) {
    throw new Error(STRUCTURAL_BEAM_RUN_USAGE);
  }
  assertSafeSlug(options.slug);
  assertSafeRelativePath(
    options.candidateSubdir,
    '--candidate-subdir',
    true,
  );
  assertSafeInteger(options.workBudget, '--work-budget', 0);
  assertSafeInteger(options.beamWidth, '--beam-width', 1);
  assertSafeInteger(options.maxDepth, '--max-depth', 0);
  assertSafeInteger(
    options.maxGroupSize,
    '--max-group-size',
    1,
    MAX_STRUCTURAL_GROUP_SIZE,
  );
  assertSafeInteger(options.maxInner, '--max-inner', 0);
  assertSafeInteger(options.maxBacktracks, '--max-backtracks', 0);
  if (
    options.seeds.length === 0 ||
    options.seeds.some(
      (seed) => !Number.isSafeInteger(seed) || seed < 1,
    ) ||
    new Set(options.seeds).size !== options.seeds.length
  ) {
    throw new Error(
      '--seeds must contain unique positive safe integers',
    );
  }
  if (options.mode !== 'vp' && options.mode !== 'no-op') {
    throw new Error('--mode must be vp or no-op');
  }
  const sourceBase = resolve(options.sourceBase);
  const targetDataset = resolve(options.targetDataset);
  const outDir = resolve(options.outDir);
  if (
    pathIsSameOrInside(sourceBase, outDir) ||
    pathIsSameOrInside(targetDataset, outDir)
  ) {
    throw new Error(
      '--out must not equal or lie inside source-base/target-dataset',
    );
  }
}

/**
 * Разбирает пары CLI-аргументов без запуска solver или файловых операций.
 *
 * @param args - Аргументы после пути к скрипту
 * @returns Нормализованные абсолютные пути и полные algorithmic options
 * @throws Error если обязательный аргумент отсутствует, W не является
 *   finite safe nonnegative integer либо путь допускает collision/traversal
 */
export function parseStructuralBeamRunArgs(
  args: string[],
): StructuralBeamCliOptions {
  let workBudget: number | undefined;
  const options: Omit<StructuralBeamCliOptions, 'workBudget'> = {
    sourceBase: '',
    targetDataset: '',
    slug: '',
    outDir: '',
    seeds: [1, 2, 3, 4],
    candidateSubdir: '.',
    beamWidth: 4,
    maxDepth: 20,
    maxGroupSize: 20,
    maxInner: 12,
    maxBacktracks: 16,
    mode: 'vp',
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined) {
      throw new Error(`Missing value for ${key ?? 'argument'}`);
    }
    switch (key) {
      case '--source-base':
        options.sourceBase = resolve(value);
        break;
      case '--target-dataset':
        options.targetDataset = resolve(value);
        break;
      case '--slug':
        options.slug = value;
        break;
      case '--out':
        options.outDir = resolve(value);
        break;
      case '--seeds':
        options.seeds = value
          .split(',')
          .map((seed) => parseNumber(seed.trim(), '--seeds'));
        break;
      case '--work-budget':
        workBudget = parseNumber(value, '--work-budget');
        break;
      case '--candidate-subdir':
        options.candidateSubdir = value;
        break;
      case '--beam-width':
        options.beamWidth = parseNumber(value, key);
        break;
      case '--max-depth':
        options.maxDepth = parseNumber(value, key);
        break;
      case '--max-group-size':
        options.maxGroupSize = parseNumber(value, key);
        break;
      case '--max-inner':
        options.maxInner = parseNumber(value, key);
        break;
      case '--max-backtracks':
        options.maxBacktracks = parseNumber(value, key);
        break;
      case '--mode':
        if (value !== 'vp' && value !== 'no-op') {
          throw new Error('--mode must be vp or no-op');
        }
        options.mode = value;
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (workBudget === undefined) {
    throw new Error(
      `--work-budget is required\n${STRUCTURAL_BEAM_RUN_USAGE}`,
    );
  }
  const complete: StructuralBeamCliOptions = {
    ...options,
    workBudget,
  };
  validateOptions(complete);
  return complete;
}

/** Совместимое короткое имя парсера для программных вызовов. */
export const parseStructuralBeamCliArgs = parseStructuralBeamRunArgs;

/** Раскрывает symlinks существующего префикса даже если out ещё отсутствует. */
function realPathWithMissingTail(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    missing.unshift(basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : current;
  return resolve(base, ...missing);
}

/** Повторяет collision check после раскрытия symlinks. */
function assertRealOutputLocation(
  options: StructuralBeamCliOptions,
): void {
  const out = realPathWithMissingTail(options.outDir);
  const source = realPathWithMissingTail(options.sourceBase);
  const target = realPathWithMissingTail(options.targetDataset);
  if (
    pathIsSameOrInside(source, out) ||
    pathIsSameOrInside(target, out)
  ) {
    throw new Error('--out resolves inside an immutable input tree');
  }
}

/** Требует отсутствующий или пустой out и ничего из него не удаляет. */
function assertEmptyOut(outDir: string): void {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`--out must be absent or empty: ${outDir}`);
  }
}

/** Проверяет объект manifest и применяет legacy/1 только к отсутствующим полям. */
function normalizeManifest(value: unknown): DatasetManifest {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error('Invalid target dataset manifest.json');
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.targetsDir !== 'string' ||
    raw.targetsDir.length === 0
  ) {
    throw new Error(
      'Target manifest targetsDir must be a non-empty string',
    );
  }
  const phaseModel = raw.phaseModel ?? 'legacy';
  if (phaseModel !== 'legacy' && phaseModel !== 'integral') {
    throw new Error('Invalid target manifest phaseModel');
  }
  const attackBoost = raw.attackBoost ?? 1;
  if (
    typeof attackBoost !== 'number' ||
    !Number.isFinite(attackBoost) ||
    attackBoost < 0
  ) {
    throw new Error(
      'Target manifest attackBoost must be finite and >= 0',
    );
  }
  return {
    targetsDir: resolve(raw.targetsDir),
    phaseModel,
    attackBoost,
  };
}

/** Читает SHA-256 неизменяемого входного файла. */
function fileSha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(path))
    .digest('hex');
}

/** Снимает хэши source, original run, target и manifest одного сида. */
function hashInputFiles(
  paths: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [
      name,
      fileSha256(path),
    ]),
  );
}

/** Сравнивает хэши до и после solver/artifacts по всем входным файлам. */
function inputHashesMatch(
  before: Record<string, string>,
  paths: Record<string, string>,
): boolean {
  return Object.entries(paths).every(
    ([name, path]) => before[name] === fileSha256(path),
  );
}

/** Возвращает RMS residual target−candidate по сохранённому Int16 PCM. */
function residualRms(
  target: ArrayLike<number>,
  samples: ArrayLike<number>,
): number {
  if (target.length !== samples.length || target.length === 0) {
    throw new Error(
      'Residual RMS requires equal non-empty PCM buffers',
    );
  }
  let squares = 0;
  for (let index = 0; index < target.length; index += 1) {
    const residual = (target[index] ?? 0) - (samples[index] ?? 0);
    squares += residual * residual;
  }
  return Math.sqrt(squares / target.length);
}

/** Среднее непустого конечного ряда; пустой ряд не становится нулевым PASS. */
function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return (
    values.reduce((sum, value) => sum + value, 0) / values.length
  );
}

/** Все guard флаги обеих ветвей обязаны пройти независимо от улучшения. */
function guardsPass(run: StructuralBeamGateRun): boolean {
  return [run.beam.guards, run.width1.guards].every(
    (guard) =>
      guard.canonical &&
      guard.global &&
      guard.windowed &&
      guard.immutable &&
      guard.work,
  );
}

/**
 * Применяет заранее фиксированный screening gate только к saved beam.
 *
 * @param arg - Запрошенные сиды, полные paired runs, ошибки и skips
 * @returns Отдельные beam/width1 метрики, guards, warnings и итог gate
 * @remarks Width-1 остаётся structural control. Runner не выбирает лучшую
 *   ветвь постфактум и не использует proposed вместо saved. Любая ошибка,
 *   нехватка четырёх completed сидов или failed guard запрещает PASS.
 */
export function evaluateStructuralBeamGate(arg: {
  requestedSeeds: number;
  runs: readonly StructuralBeamGateRun[];
  errors: number;
  skips: number;
}): StructuralBeamGateResult {
  const globalDeltas = arg.runs.map(
    (run) => run.beam.saved.globalDelta,
  );
  const residualValues = arg.runs.map(
    (run) => run.beam.saved.residualRmsReductionPercent,
  );
  const meanBeamGlobalDelta = mean(globalDeltas);
  const meanBeamResidualRmsReductionPercent = residualValues.every(
    (value): value is number =>
      value !== null && Number.isFinite(value),
  )
    ? mean(residualValues)
    : null;
  const improvedBeamSeeds = arg.runs.filter(
    (run) =>
      run.beam.status === 'refined' && run.beam.saved.globalDelta > 0,
  ).length;
  const allGuardsPass =
    arg.runs.length === arg.requestedSeeds &&
    arg.runs.every(guardsPass);
  const warningCount = arg.runs.reduce(
    (sum, run) =>
      sum + run.beam.warnings.length + run.width1.warnings.length,
    0,
  );
  const pass =
    arg.errors === 0 &&
    arg.skips === 0 &&
    arg.requestedSeeds ===
      STRUCTURAL_BEAM_GATE.requiredCompletedSeeds &&
    arg.runs.length === STRUCTURAL_BEAM_GATE.requiredCompletedSeeds &&
    improvedBeamSeeds >= STRUCTURAL_BEAM_GATE.minImprovedBeamSeeds &&
    meanBeamGlobalDelta !== null &&
    Number.isFinite(meanBeamGlobalDelta) &&
    meanBeamGlobalDelta >=
      STRUCTURAL_BEAM_GATE.minMeanBeamGlobalDelta &&
    meanBeamResidualRmsReductionPercent !== null &&
    meanBeamResidualRmsReductionPercent >=
      STRUCTURAL_BEAM_GATE.minMeanBeamResidualRmsReductionPercent &&
    allGuardsPass;
  return {
    ...STRUCTURAL_BEAM_GATE,
    requestedSeeds: arg.requestedSeeds,
    completedSeeds: arg.runs.length,
    improvedBeamSeeds,
    meanBeamGlobalDelta,
    meanBeamResidualRmsReductionPercent,
    meanWidth1GlobalDelta: null,
    meanBeamMinusWidth1Global: null,
    errors: arg.errors,
    skips: arg.skips,
    guardsPass: allGuardsPass,
    warningCount,
    pass,
  };
}

/** Заполняет width-control средние только для полного run report. */
function evaluateFullGate(arg: {
  options: StructuralBeamCliOptions;
  runs: readonly StructuralBeamSeedReport[];
  errors: number;
  skips: number;
}): StructuralBeamGateResult {
  const gate = evaluateStructuralBeamGate({
    requestedSeeds: arg.options.seeds.length,
    runs: arg.runs,
    errors: arg.errors,
    skips: arg.skips,
  });
  return {
    ...gate,
    meanWidth1GlobalDelta: mean(
      arg.runs.map((run) => run.width1.saved.globalDelta),
    ),
    meanBeamMinusWidth1Global: mean(
      arg.runs.map((run) => run.beamMinusWidth1.savedGlobal),
    ),
  };
}

/** Возвращает независимый нулевой snapshot для no-op без создания proposer. */
function emptyProposerSnapshot(): ResidualStructuralProposerSnapshot {
  return {
    calls: 0,
    cost: 0,
    categories: {
      residual: 0,
      window: 0,
      fft: 0,
      peaks: 0,
      shapes: 0,
      slots: 0,
      total: 0,
    },
  };
}

/** Возвращает независимый нулевой dense ledger для no-op. */
function emptyDenseWork(): StructuralDenseWork {
  return {
    gramCellUpdates: 0,
    jacobiMatrixEntries: 0,
    jacobiOffDiagonalScans: 0,
    jacobiRotations: 0,
    jacobiRotationElementUpdates: 0,
    pseudoInverseEntries: 0,
  };
}

/** Оставляет в path только metadata и canonical score. */
function summarizeNode(
  node: NativeStructuralNode,
): StructuralBeamPathEntry {
  return {
    nodeKey: node.nodeKey,
    candidateKey: node.candidateKey,
    parentKey: node.parentKey,
    depth: node.depth,
    groupSize: node.groupSize,
    estimatedWork: node.estimatedWork,
    cost: node.cost,
    metrics: { ...node.score },
  };
}

/** Проверяет, что independently measured baseline совпал с native root. */
function assertMetricsMatch(
  actual: RefitMetrics,
  expected: RefitMetrics,
  label: string,
): void {
  if (
    Math.abs(
      actual.globalSuppressionPercent -
        expected.globalSuppressionPercent,
    ) > 1e-8 ||
    Math.abs(
      actual.windowedSuppressionPercent -
        expected.windowedSuppressionPercent,
    ) > 1e-8
  ) {
    throw new Error(
      `${label}: canonical metrics diverged from native solver`,
    );
  }
}

/** Собирает diagnostics по фактическому PCM, а не по solver raw score. */
function makeMeasurement(arg: {
  samples: Int16Array;
  target: Int16Array;
  targetValues: number[];
  sampleRate: number;
  usefulZone: UsefulZone;
  baseline: RefitMetrics;
  baselineResidualRms: number;
}): StructuralBeamMeasurement {
  const metrics = measureMetrics(
    arg.samples,
    arg.targetValues,
    arg.sampleRate,
    arg.usefulZone,
  );
  const currentResidualRms = residualRms(arg.target, arg.samples);
  const reduction =
    arg.baselineResidualRms > 0
      ? 100 * (1 - currentResidualRms / arg.baselineResidualRms)
      : currentResidualRms === 0
        ? 0
        : null;
  if (
    !Number.isFinite(metrics.globalSuppressionPercent) ||
    !Number.isFinite(metrics.windowedSuppressionPercent) ||
    !Number.isFinite(currentResidualRms)
  ) {
    throw new Error('Non-finite saved PCM measurement');
  }
  return {
    ...metrics,
    globalDelta:
      metrics.globalSuppressionPercent -
      arg.baseline.globalSuppressionPercent,
    windowedDelta:
      metrics.windowedSuppressionPercent -
      arg.baseline.windowedSuppressionPercent,
    residualRms: currentResidualRms,
    residualRmsReductionPercent: reduction,
    character: compareCharacter(
      arg.target,
      arg.samples,
      arg.sampleRate,
    ),
    bands: compareWaveformBands(
      arg.target,
      arg.samples,
      arg.sampleRate,
    ),
  };
}

/** Атомарно пишет mono WAV через sibling temp и rename. */
async function writeWavAtomic(
  path: string,
  samples: Int16Array,
  sampleRate: number,
): Promise<void> {
  writeWav({ samples, sampleRate, filePath: `${path}.tmp` });
  await rename(`${path}.tmp`, path);
}

interface SavedCanonicalMeasurement {
  measurement: StructuralBeamMeasurement;
  patchPath: string;
  wavPath: string;
}

/** Сохраняет, перечитывает и независимо измеряет один canonical patch/WAV. */
async function saveAndMeasureCanonical(arg: {
  patch: ArgCreateSynth;
  samples: Int16Array;
  patchPath: string;
  wavPath: string;
  target: Int16Array;
  targetValues: number[];
  sampleRate: number;
  sampleCount: number;
  phaseModel: PhaseModel;
  usefulZone: UsefulZone;
  baseline: RefitMetrics;
  baselineResidualRms: number;
  expectedMetrics: RefitMetrics;
  label: string;
}): Promise<SavedCanonicalMeasurement> {
  await writeJsonAtomic(arg.patchPath, arg.patch);
  await writeWavAtomic(arg.wavPath, arg.samples, arg.sampleRate);
  const savedPatch = await readJsonOrNull<ArgCreateSynth>(
    arg.patchPath,
  );
  const expectedPatch = JSON.parse(
    JSON.stringify(arg.patch),
  ) as ArgCreateSynth;
  if (
    savedPatch === null ||
    !isDeepStrictEqual(savedPatch, expectedPatch)
  ) {
    throw new Error(
      `${arg.label}: saved patch failed JSON round-trip`,
    );
  }
  const savedWav = readWav(arg.wavPath);
  if (
    savedWav.sampleRate !== arg.sampleRate ||
    savedWav.samples.length !== arg.sampleCount ||
    !isDeepStrictEqual(savedWav.samples, arg.samples)
  ) {
    throw new Error(
      `${arg.label}: saved WAV differs from canonical PCM`,
    );
  }
  assertPatchMatchesWav(
    savedPatch,
    savedWav.samples,
    arg.phaseModel,
    savedWav.sampleRate,
    arg.sampleCount,
  );
  const measurement = makeMeasurement({
    samples: savedWav.samples,
    target: arg.target,
    targetValues: arg.targetValues,
    sampleRate: arg.sampleRate,
    usefulZone: arg.usefulZone,
    baseline: arg.baseline,
    baselineResidualRms: arg.baselineResidualRms,
  });
  assertMetricsMatch(measurement, arg.expectedMetrics, arg.label);
  return {
    measurement,
    patchPath: arg.patchPath,
    wavPath: arg.wavPath,
  };
}

/** Преобразует typed arrays solver в обычные JSON-массивы без numeric keys. */
function serializableHistory(
  history: readonly NativeStructuralHistoryEntry[],
): unknown[] {
  return history.map((entry) => ({
    ...entry,
    fixedOffset: Array.from(entry.fixedOffset),
    solver: {
      ...entry.solver,
      raw: Array.from(entry.solver.raw),
      samples: Array.from(entry.solver.samples),
    },
  }));
}

/** Независимые данные ветви, общие для native и no-op. */
interface BranchExecution {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  metrics: RefitMetrics;
  proposed: NativeStructuralProposed | null;
  rejectionReason: string | null;
  canonicalError: string | null;
  work: StructuralBeamWorkReport;
  proposer: ResidualStructuralProposerSnapshot;
  expansions: NativeStructuralBeamResult['expansions'];
  skips: NativeStructuralBeamResult['skips'];
  path: StructuralBeamPathEntry[];
  history: NativeStructuralHistoryEntry[];
  native: NativeStructuralBeamResult | null;
}

/** Отделяет native W от root, dense и одноразового finalization. */
function nativeWork(
  result: NativeStructuralBeamResult,
): StructuralBeamWorkReport {
  return {
    budget: result.work.budget,
    used: result.work.used,
    unused: result.work.unused,
    evaluatorWork: result.evaluatorWork,
    expansionWork: result.expansionWork,
    denseWork: { ...result.denseWork },
    rootSampleWork: null,
    rootIncludedInBudget: false,
    finalizationSampleWork: result.finalizationSampleWork,
    finalizationIncludedInBudget: false,
  };
}

/** Снимает сохраняемую часть native ветви, не копируя root PCM в audit. */
function executionFromNative(
  result: NativeStructuralBeamResult,
  proposer: ResidualStructuralProposerSnapshot,
): BranchExecution {
  return {
    status: result.status,
    patch: result.patch,
    samples: result.samples,
    metrics: result.metrics,
    proposed: result.proposed,
    rejectionReason: result.rejectionReason,
    canonicalError: result.canonicalError,
    work: nativeWork(result),
    proposer,
    expansions: result.expansions,
    skips: result.skips,
    path: result.path.map(summarizeNode),
    history: result.history,
    native: result,
  };
}

/** Формирует no-op ветвь без factory, solver, proposed или finalization work. */
function noOpExecution(arg: {
  patch: ArgCreateSynth;
  samples: Int16Array;
  baseline: RefitMetrics;
  workBudget: number;
}): BranchExecution {
  return {
    status: 'unchanged',
    patch: arg.patch,
    samples: arg.samples,
    metrics: { ...arg.baseline },
    proposed: null,
    rejectionReason: 'no-op mode: solver not called',
    canonicalError: null,
    work: {
      budget: arg.workBudget,
      used: 0,
      unused: arg.workBudget,
      evaluatorWork: 0,
      expansionWork: 0,
      denseWork: emptyDenseWork(),
      rootSampleWork: null,
      rootIncludedInBudget: false,
      finalizationSampleWork: 0,
      finalizationIncludedInBudget: false,
    },
    proposer: emptyProposerSnapshot(),
    expansions: [],
    skips: { budget: [], expansionBudget: [], groupSize: [] },
    path: [
      {
        nodeKey: 'no-op-root',
        candidateKey: null,
        parentKey: null,
        depth: 0,
        groupSize: 0,
        estimatedWork: 0,
        cost: 0,
        metrics: { ...arg.baseline },
      },
    ],
    history: [],
    native: null,
  };
}

/** Проверяет W, used/unused, proposer parity и отдельный finalization 5N. */
function workGuardHolds(
  execution: BranchExecution,
  workBudget: number,
  sampleCount: number,
): boolean {
  const work = execution.work;
  const categories = execution.proposer.categories;
  const categorySum =
    categories.residual +
    categories.window +
    categories.fft +
    categories.peaks +
    categories.shapes +
    categories.slots;
  return (
    work.budget === workBudget &&
    Number.isSafeInteger(work.used) &&
    work.used >= 0 &&
    work.used <= workBudget &&
    work.unused === workBudget - work.used &&
    work.used === work.evaluatorWork + work.expansionWork &&
    work.expansionWork === execution.proposer.cost &&
    execution.proposer.calls === execution.expansions.length &&
    execution.proposer.categories.total === categorySum &&
    execution.proposer.categories.total === execution.proposer.cost &&
    (work.finalizationSampleWork === 0 ||
      work.finalizationSampleWork === 5 * sampleCount) &&
    work.rootSampleWork === null &&
    !work.rootIncludedInBudget &&
    !work.finalizationIncludedInBudget
  );
}

/** Делает solver rejection, canonical и budget следствия видимыми как WARN. */
function executionWarnings(execution: BranchExecution): string[] {
  const warnings: string[] = [];
  if (execution.rejectionReason !== null) {
    warnings.push(`WARN: ${execution.rejectionReason}`);
  }
  if (execution.canonicalError !== null) {
    warnings.push(
      `WARN: canonicalError: ${execution.canonicalError}`,
    );
  }
  if (execution.skips.expansionBudget.length > 0) {
    warnings.push(
      `WARN: ${execution.skips.expansionBudget.length} expansion(s) skipped by W`,
    );
  }
  if (execution.skips.budget.length > 0) {
    warnings.push(
      `WARN: ${execution.skips.budget.length} candidate(s) skipped by W`,
    );
  }
  if (execution.skips.groupSize.length > 0) {
    warnings.push(
      `WARN: ${execution.skips.groupSize.length} candidate(s) skipped by group size`,
    );
  }
  return warnings;
}

/** Полный audit без дублирования больших root/evaluated PCM buffers. */
function nativeAudit(
  result: NativeStructuralBeamResult | null,
): unknown {
  if (result === null) {
    return null;
  }
  return {
    status: result.status,
    baseline: result.baseline,
    metrics: result.metrics,
    rejectionReason: result.rejectionReason,
    canonicalError: result.canonicalError,
    proposed:
      result.proposed === null
        ? null
        : {
            nodeKey: result.proposed.nodeKey,
            candidateKey: result.proposed.candidateKey,
            parentKey: result.proposed.parentKey,
            depth: result.proposed.depth,
            groupSize: result.proposed.groupSize,
            estimatedWork: result.proposed.estimatedWork,
            cost: result.proposed.cost,
            metrics: result.proposed.metrics,
          },
    bestAny: summarizeNode(result.bestAny),
    bestPath: result.bestPath.map(summarizeNode),
    depths: result.depths.map((depth) => ({
      depth: depth.depth,
      nodes: depth.nodes.map(summarizeNode),
    })),
    evaluated: result.evaluated.map(summarizeNode),
    expansions: result.expansions,
    skippedExpansionBudget: result.skippedExpansionBudget,
    work: nativeWork(result),
  };
}

/** Сохраняет branch patch/WAV/history/audit/checkpoint и возвращает report. */
async function saveBranch(arg: {
  options: StructuralBeamCliOptions;
  seed: number;
  branch: StructuralBeamBranchName;
  sourceDir: string;
  execution: BranchExecution;
  target: Int16Array;
  targetValues: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  usefulZone: UsefulZone;
  baseline: StructuralBeamMeasurement;
  immutable: boolean;
}): Promise<StructuralBeamBranchReport> {
  const directory = join(
    arg.options.outDir,
    arg.options.slug,
    `seed-${arg.seed}`,
    arg.branch,
  );
  mkdirSync(directory, { recursive: true });
  const patch = join(directory, 'patch.json');
  const wav = join(directory, 'result.wav');
  const history = join(directory, 'history.json');
  const audit = join(directory, 'audit.json');
  const checkpoint = join(directory, 'checkpoint.json');
  const saved = await saveAndMeasureCanonical({
    patch: arg.execution.patch,
    samples: arg.execution.samples,
    patchPath: patch,
    wavPath: wav,
    target: arg.target,
    targetValues: arg.targetValues,
    sampleRate: arg.sampleRate,
    sampleCount: arg.target.length,
    phaseModel: arg.phaseModel,
    usefulZone: arg.usefulZone,
    baseline: arg.baseline,
    baselineResidualRms: arg.baseline.residualRms,
    expectedMetrics: arg.execution.metrics,
    label: `${arg.options.slug}/seed-${arg.seed}/${arg.branch}/saved`,
  });

  let proposed: StructuralBeamProposedReport | null = null;
  if (arg.execution.proposed !== null) {
    const candidate = arg.execution.proposed;
    const proposedSaved = await saveAndMeasureCanonical({
      patch: candidate.patch,
      samples: candidate.samples,
      patchPath: join(directory, 'proposed-patch.json'),
      wavPath: join(directory, 'proposed.wav'),
      target: arg.target,
      targetValues: arg.targetValues,
      sampleRate: arg.sampleRate,
      sampleCount: arg.target.length,
      phaseModel: arg.phaseModel,
      usefulZone: arg.usefulZone,
      baseline: arg.baseline,
      baselineResidualRms: arg.baseline.residualRms,
      expectedMetrics: candidate.metrics,
      label: `${arg.options.slug}/seed-${arg.seed}/${arg.branch}/proposed`,
    });
    proposed = {
      ...proposedSaved.measurement,
      nodeKey: candidate.nodeKey,
      candidateKey: candidate.candidateKey,
      parentKey: candidate.parentKey,
      depth: candidate.depth,
      groupSize: candidate.groupSize,
      estimatedWork: candidate.estimatedWork,
      cost: candidate.cost,
      patch: proposedSaved.patchPath,
      wav: proposedSaved.wavPath,
    };
  }

  const work = workGuardHolds(
    arg.execution,
    arg.options.workBudget,
    arg.target.length,
  );
  const global =
    saved.measurement.globalSuppressionPercent >=
    arg.baseline.globalSuppressionPercent - GLOBAL_GUARD_EPSILON;
  const windowed =
    saved.measurement.windowedSuppressionPercent >=
    arg.baseline.windowedSuppressionPercent -
      WINDOWED_GUARD_FLOOR -
      GLOBAL_GUARD_EPSILON;
  const warnings = executionWarnings(arg.execution);
  if (!work) {
    warnings.push('WARN: work/W/proposer/finalization guard failed');
  }
  if (!global) {
    warnings.push('WARN: saved global regressed against baseline');
  }
  if (!windowed) {
    warnings.push('WARN: saved J fell below baseline−0.05');
  }
  if (!arg.immutable) {
    warnings.push('WARN: immutable source hash changed');
  }
  const report: StructuralBeamBranchReport = {
    slug: arg.options.slug,
    seed: arg.seed,
    branch: arg.branch,
    status: arg.execution.status,
    sourceDir: arg.sourceDir,
    directory,
    patch,
    wav,
    audit,
    history,
    checkpoint,
    baseline: arg.baseline,
    proposed,
    saved: saved.measurement,
    work: arg.execution.work,
    proposer: arg.execution.proposer,
    expansions: arg.execution.expansions,
    skips: arg.execution.skips,
    path: arg.execution.path,
    rejectionReason: arg.execution.rejectionReason,
    canonicalError: arg.execution.canonicalError,
    warnings,
    guards: {
      canonical: true,
      global,
      windowed,
      immutable: arg.immutable,
      work,
    },
    algorithmOptions: {
      beamWidth: arg.branch === 'beam' ? arg.options.beamWidth : 1,
      maxDepth: arg.options.maxDepth,
      maxGroupSize: arg.options.maxGroupSize,
      maxInner: arg.options.maxInner,
      maxBacktracks: arg.options.maxBacktracks,
      workBudget: arg.options.workBudget,
    },
  };
  await writeJsonAtomic(
    history,
    serializableHistory(arg.execution.history),
  );
  await writeJsonAtomic(audit, {
    algorithm: 'residual-structural-beam',
    branch: arg.branch,
    hypothesisOnly: true,
    productionConnected: false,
    q4Pass: null,
    coordinateDescentStarted: false,
    report,
    native: nativeAudit(arg.execution.native),
  });
  await writeJsonAtomic(checkpoint, { finished: true, report });
  return report;
}

interface CapturedProposer {
  session: ResidualStructuralProposerSession;
  calls: Array<{
    parentKey: string;
    depth: number;
    cost: number;
  }>;
}

/** Сверяет записанные propose calls с expansion audit конкретной ветви. */
function proposerCaptureMatches(
  captured: CapturedProposer,
  result: NativeStructuralBeamResult,
): boolean {
  const snapshot = captured.session.snapshot();
  return (
    captured.calls.length === result.expansions.length &&
    snapshot.calls === result.expansions.length &&
    snapshot.cost === result.expansionWork &&
    captured.calls.every((call, index) => {
      const expansion = result.expansions[index];
      return (
        expansion !== undefined &&
        call.parentKey === expansion.parentKey &&
        call.depth === expansion.depth &&
        call.cost === expansion.cost
      );
    })
  );
}

/**
 * Связывает captures с ветвями только после проверки обеих возможных пар.
 * Если порядок factory изменится, совпадение parent/depth/cost восстановит
 * правильную связь либо остановит seed с ошибкой вместо ложного breakdown.
 */
function assignProposerSnapshots(
  captures: readonly CapturedProposer[],
  beam: NativeStructuralBeamResult,
  width1: NativeStructuralBeamResult,
): {
  beam: ResidualStructuralProposerSnapshot;
  width1: ResidualStructuralProposerSnapshot;
} {
  if (captures.length !== 2) {
    throw new Error(
      `Expected two independent residual proposer sessions, got ${captures.length}`,
    );
  }
  const first = captures[0];
  const second = captures[1];
  if (first === undefined || second === undefined) {
    throw new Error('Missing residual proposer capture');
  }
  const forward =
    proposerCaptureMatches(first, beam) &&
    proposerCaptureMatches(second, width1);
  const reverse =
    proposerCaptureMatches(first, width1) &&
    proposerCaptureMatches(second, beam);
  if (!forward && !reverse) {
    throw new Error(
      'Residual proposer snapshots do not match either branch',
    );
  }
  if (
    forward &&
    reverse &&
    !isDeepStrictEqual(
      first.session.snapshot(),
      second.session.snapshot(),
    )
  ) {
    throw new Error(
      'Residual proposer branch assignment is ambiguous',
    );
  }
  const beamCapture = forward ? first : second;
  const widthCapture = forward ? second : first;
  return {
    beam: beamCapture.session.snapshot(),
    width1: widthCapture.session.snapshot(),
  };
}

/** Создаёт measured factory с независимой session и явным журналом вызовов. */
function createCapturedFactory(arg: {
  target: Int16Array;
  sampleRate: number;
  phaseModel: PhaseModel;
  options: StructuralBeamCliOptions;
  dependencies: StructuralBeamRunDependencies;
  captures: CapturedProposer[];
}): () => ResidualStructuralProposerSession {
  const baseOptions: ResidualStructuralProposerOptions = {
    target: arg.target,
    sampleRate: arg.sampleRate,
    phaseModel: arg.phaseModel,
    maxGroupSize: arg.options.maxGroupSize,
  };
  const configured =
    arg.dependencies.configureProposer?.(baseOptions) ?? baseOptions;
  const protectedOptions: ResidualStructuralProposerOptions = {
    ...configured,
    target: arg.target,
    sampleRate: arg.sampleRate,
    phaseModel: arg.phaseModel,
    maxGroupSize: arg.options.maxGroupSize,
  };
  const factory = createResidualStructuralProposer(protectedOptions);
  return () => {
    const session = factory();
    const captured: CapturedProposer = { session, calls: [] };
    arg.captures.push(captured);
    return {
      estimateExpansion: (parent) =>
        session.estimateExpansion(parent),
      propose: (
        parent,
      ): ReturnType<ResidualStructuralProposerSession['propose']> => {
        const proposed = session.propose(parent);
        captured.calls.push({
          parentKey: parent.nodeKey,
          depth: parent.depth + 1,
          cost: proposed.cost,
        });
        return proposed;
      },
      snapshot: () => session.snapshot(),
    };
  };
}

interface LoadedSeed {
  sourceDir: string;
  originalRunDir: string;
  targetPath: string;
  inputPaths: Record<string, string>;
  inputSha256: Record<string, string>;
  patch: ArgCreateSynth;
  sourceSamples: Int16Array;
  target: Int16Array;
  targetValues: number[];
  sampleRate: number;
  usefulZone: UsefulZone;
}

/** Возвращает null только для штатного missing/not completed original run. */
async function loadVerifiedSeed(arg: {
  options: StructuralBeamCliOptions;
  manifest: DatasetManifest;
  manifestPath: string;
  seed: number;
}): Promise<LoadedSeed | null> {
  const originalRunDir = join(
    arg.options.targetDataset,
    arg.options.slug,
    `seed-${arg.seed}`,
  );
  const runPath = join(originalRunDir, 'run.json');
  if (!existsSync(runPath)) {
    return null;
  }
  const rawRun = await readJsonOrNull<unknown>(runPath);
  if (
    typeof rawRun !== 'object' ||
    rawRun === null ||
    Array.isArray(rawRun)
  ) {
    throw new Error(`Corrupt original run.json: ${runPath}`);
  }
  const rawRecord = rawRun as Record<string, unknown>;
  if (typeof rawRecord.status !== 'string') {
    throw new Error(`Corrupt original run status: ${runPath}`);
  }
  if (rawRecord.status !== 'completed') {
    return null;
  }
  if (
    typeof rawRecord.target !== 'string' ||
    rawRecord.target.length === 0
  ) {
    throw new Error(`Completed run has no target: ${runPath}`);
  }
  const record: RunRecord = {
    status: rawRecord.status,
    target: rawRecord.target,
  };
  assertSafeRelativePath(record.target, 'run.target', false, false);
  const targetPath = resolve(arg.manifest.targetsDir, record.target);
  if (!pathIsSameOrInside(arg.manifest.targetsDir, targetPath)) {
    throw new Error(
      `run.target escapes targetsDir: ${record.target}`,
    );
  }

  const seedDir = join(
    arg.options.sourceBase,
    arg.options.slug,
    `seed-${arg.seed}`,
  );
  const sourceDir = resolve(seedDir, arg.options.candidateSubdir);
  if (!pathIsSameOrInside(seedDir, sourceDir)) {
    throw new Error(
      '--candidate-subdir escapes the source seed directory',
    );
  }
  const realSeedDir = realpathSync(seedDir);
  const realSourceDir = realpathSync(sourceDir);
  if (!pathIsSameOrInside(realSeedDir, realSourceDir)) {
    throw new Error(
      '--candidate-subdir resolves outside the source seed',
    );
  }
  const sourcePatchPath = join(sourceDir, 'patch.json');
  const sourceWavPath = join(sourceDir, 'result.wav');
  const inputPaths = {
    manifest: arg.manifestPath,
    originalRun: runPath,
    sourcePatch: sourcePatchPath,
    sourceWav: sourceWavPath,
    target: targetPath,
  };
  const inputSha256 = hashInputFiles(inputPaths);
  const patch = await readJsonOrNull<ArgCreateSynth>(sourcePatchPath);
  if (patch === null) {
    throw new Error(
      `Missing or corrupt source patch: ${sourcePatchPath}`,
    );
  }
  const sourceWav = readWav(sourceWavPath);
  const targetWav = readWav(targetPath);
  if (sourceWav.sampleRate !== targetWav.sampleRate) {
    throw new Error(
      `Source/target sampleRate differ: ${sourceWav.sampleRate}/${targetWav.sampleRate}`,
    );
  }
  if (
    sourceWav.samples.length === 0 ||
    sourceWav.samples.length !== targetWav.samples.length
  ) {
    throw new Error(
      `Source/target lengths differ or empty: ${sourceWav.samples.length}/${targetWav.samples.length}`,
    );
  }
  assertPatchMatchesWav(
    patch,
    sourceWav.samples,
    arg.manifest.phaseModel,
    sourceWav.sampleRate,
    targetWav.samples.length,
  );
  const targetValues = Array.from(targetWav.samples);
  return {
    sourceDir,
    originalRunDir,
    targetPath,
    inputPaths,
    inputSha256,
    patch,
    sourceSamples: sourceWav.samples,
    target: targetWav.samples,
    targetValues,
    sampleRate: targetWav.sampleRate,
    usefulZone: computeUsefulZone(targetValues, targetWav.sampleRate),
  };
}

/** Обрабатывает один canonical source и сохраняет обе paired ветви. */
async function processSeed(arg: {
  options: StructuralBeamCliOptions;
  manifest: DatasetManifest;
  manifestPath: string;
  seed: number;
  dependencies: StructuralBeamRunDependencies;
}): Promise<StructuralBeamSeedReport | null> {
  const started = Date.now();
  const loaded = await loadVerifiedSeed(arg);
  if (loaded === null) {
    return null;
  }
  const sourcePatchSnapshot = structuredClone(loaded.patch);
  const baselineMetrics = measureMetrics(
    loaded.sourceSamples,
    loaded.targetValues,
    loaded.sampleRate,
    loaded.usefulZone,
  );
  const baselineResidualRms = residualRms(
    loaded.target,
    loaded.sourceSamples,
  );
  const baseline = makeMeasurement({
    samples: loaded.sourceSamples,
    target: loaded.target,
    targetValues: loaded.targetValues,
    sampleRate: loaded.sampleRate,
    usefulZone: loaded.usefulZone,
    baseline: baselineMetrics,
    baselineResidualRms,
  });

  let beamExecution: BranchExecution;
  let widthExecution: BranchExecution;
  let solverWallTimeMs = 0;
  if (arg.options.mode === 'no-op') {
    beamExecution = noOpExecution({
      patch: loaded.patch,
      samples: loaded.sourceSamples,
      baseline: baselineMetrics,
      workBudget: arg.options.workBudget,
    });
    widthExecution = noOpExecution({
      patch: loaded.patch,
      samples: loaded.sourceSamples,
      baseline: baselineMetrics,
      workBudget: arg.options.workBudget,
    });
  } else {
    const captures: CapturedProposer[] = [];
    const runBeam =
      arg.dependencies.runBeam ??
      runNativeStructuralBeamWithWidthControl;
    const solverStarted = Date.now();
    const control = runBeam({
      patch: loaded.patch,
      target: loaded.target,
      sampleRate: loaded.sampleRate,
      phaseModel: arg.manifest.phaseModel,
      beamWidth: arg.options.beamWidth,
      maxDepth: arg.options.maxDepth,
      maxGroupSize: arg.options.maxGroupSize,
      workBudget: arg.options.workBudget,
      maxInner: arg.options.maxInner,
      maxBacktracks: arg.options.maxBacktracks,
      createProposerSession: createCapturedFactory({
        target: loaded.target,
        sampleRate: loaded.sampleRate,
        phaseModel: arg.manifest.phaseModel,
        options: arg.options,
        dependencies: arg.dependencies,
        captures,
      }),
    });
    solverWallTimeMs = Date.now() - solverStarted;
    assertMetricsMatch(
      control.beam.baseline,
      baselineMetrics,
      'beam root',
    );
    assertMetricsMatch(
      control.width1.baseline,
      baselineMetrics,
      'width1 root',
    );
    const snapshots = assignProposerSnapshots(
      captures,
      control.beam,
      control.width1,
    );
    beamExecution = executionFromNative(control.beam, snapshots.beam);
    widthExecution = executionFromNative(
      control.width1,
      snapshots.width1,
    );
  }
  if (!isDeepStrictEqual(loaded.patch, sourcePatchSnapshot)) {
    throw new Error(
      'Native solver mutated the in-memory source patch',
    );
  }
  const immutableBeforeWrite = inputHashesMatch(
    loaded.inputSha256,
    loaded.inputPaths,
  );
  if (!immutableBeforeWrite) {
    throw new Error(
      'Source inputs changed during native structural beam',
    );
  }
  const common = {
    options: arg.options,
    seed: arg.seed,
    sourceDir: loaded.sourceDir,
    target: loaded.target,
    targetValues: loaded.targetValues,
    sampleRate: loaded.sampleRate,
    phaseModel: arg.manifest.phaseModel,
    usefulZone: loaded.usefulZone,
    baseline,
    immutable: immutableBeforeWrite,
  };
  const beam = await saveBranch({
    ...common,
    branch: 'beam',
    execution: beamExecution,
  });
  const width1 = await saveBranch({
    ...common,
    branch: 'width1',
    execution: widthExecution,
  });
  const immutable = inputHashesMatch(
    loaded.inputSha256,
    loaded.inputPaths,
  );
  if (!immutable) {
    throw new Error(
      'Source inputs changed while writing seed artifacts',
    );
  }
  const residualDelta =
    beam.saved.residualRmsReductionPercent === null ||
    width1.saved.residualRmsReductionPercent === null
      ? null
      : beam.saved.residualRmsReductionPercent -
        width1.saved.residualRmsReductionPercent;
  return {
    slug: arg.options.slug,
    seed: arg.seed,
    sourceDir: loaded.sourceDir,
    originalRunDir: loaded.originalRunDir,
    targetPath: loaded.targetPath,
    inputSha256: loaded.inputSha256,
    beam,
    width1,
    beamMinusWidth1: {
      savedGlobal:
        beam.saved.globalSuppressionPercent -
        width1.saved.globalSuppressionPercent,
      savedWindowed:
        beam.saved.windowedSuppressionPercent -
        width1.saved.windowedSuppressionPercent,
      savedResidualRmsReductionPercent: residualDelta,
      proposedGlobal:
        beam.proposed === null || width1.proposed === null
          ? null
          : beam.proposed.globalSuppressionPercent -
            width1.proposed.globalSuppressionPercent,
      proposedWindowed:
        beam.proposed === null || width1.proposed === null
          ? null
          : beam.proposed.windowedSuppressionPercent -
            width1.proposed.windowedSuppressionPercent,
    },
    immutable,
    warnings: [...beam.warnings, ...width1.warnings],
    wallTimeMs: Date.now() - started,
    solverWallTimeMs,
  };
}

/** Собирает report/checkpoint из уже сохранённых paired runs. */
function makeReport(arg: {
  options: StructuralBeamCliOptions;
  manifest: DatasetManifest;
  createdAt: string;
  started: number;
  finished: boolean;
  runs: StructuralBeamSeedReport[];
  errors: StructuralBeamRunError[];
  skips: StructuralBeamRunSkip[];
}): StructuralBeamScreeningReport {
  const warnings = arg.runs.flatMap((run) =>
    run.warnings.map((warning) => `seed ${run.seed}: ${warning}`),
  );
  return {
    version: 1,
    experiment: 'residual-structural-beam',
    hypothesisOnly: true,
    productionConnected: false,
    q4Pass: null,
    coordinateDescentStarted: false,
    createdAt: arg.createdAt,
    finishedAt: arg.finished ? new Date().toISOString() : null,
    finished: arg.finished,
    sourceBase: arg.options.sourceBase,
    targetDataset: arg.options.targetDataset,
    targetsDir: arg.manifest.targetsDir,
    slug: arg.options.slug,
    outDir: arg.options.outDir,
    candidateSubdir: arg.options.candidateSubdir,
    seeds: [...arg.options.seeds],
    mode: arg.options.mode,
    workBudget: arg.options.workBudget,
    phaseModel: arg.manifest.phaseModel,
    attackBoost: arg.manifest.attackBoost,
    algorithmOptions: {
      beamWidth: arg.options.beamWidth,
      maxDepth: arg.options.maxDepth,
      maxGroupSize: arg.options.maxGroupSize,
      maxInner: arg.options.maxInner,
      maxBacktracks: arg.options.maxBacktracks,
      workBudget: arg.options.workBudget,
    },
    gate: evaluateFullGate({
      options: arg.options,
      runs: arg.runs,
      errors: arg.errors.length,
      skips: arg.skips.length,
    }),
    errors: arg.errors,
    skips: arg.skips,
    runs: arg.runs,
    warnings,
    wallTimeMs: Date.now() - arg.started,
  };
}

/**
 * Формирует Markdown-отчёт по saved beam и width-1 control.
 *
 * @param report - Итоговый или промежуточный screening report
 * @returns Markdown с gate, метриками ветвей, работой и warnings
 */
export function renderStructuralBeamMarkdown(
  report: StructuralBeamScreeningReport,
): string {
  const lines = [
    '# Residual-driven native structural beam',
    '',
    'Offline experiment не подключён к production, не запускает CD и не выносит Q4 PASS. Saved patch и WAV перечитаны с диска; global и J измерены по сохранённому PCM.',
    '',
    `Gate зафиксирован заранее: ${STRUCTURAL_BEAM_GATE.requiredCompletedSeeds} completed сида, улучшенных beam ≥ ${STRUCTURAL_BEAM_GATE.minImprovedBeamSeeds}, mean beam Δglobal ≥ ${STRUCTURAL_BEAM_GATE.minMeanBeamGlobalDelta} п.п., mean residual RMS reduction ≥ ${STRUCTURAL_BEAM_GATE.minMeanBeamResidualRmsReductionPercent}%.`,
    '',
    `Gate: **${report.gate.pass ? 'PASS' : 'NO GO'}**; completed=${report.gate.completedSeeds}, improved=${report.gate.improvedBeamSeeds}, mean Δglobal=${report.gate.meanBeamGlobalDelta?.toFixed(6) ?? 'n/a'}, mean residual reduction=${report.gate.meanBeamResidualRmsReductionPercent?.toFixed(6) ?? 'n/a'}%, warnings=${report.gate.warningCount}.`,
    '',
    '| Сид | Beam status | Beam Δglobal | Beam ΔJ | Beam residual reduction | Width1 Δglobal | Beam−width1 global | Beam W used/unused | Width1 W used/unused | Wall, ms |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const run of report.runs) {
    lines.push(
      `| ${run.seed} | ${run.beam.status} | ${run.beam.saved.globalDelta.toFixed(6)} | ${run.beam.saved.windowedDelta.toFixed(6)} | ${run.beam.saved.residualRmsReductionPercent?.toFixed(6) ?? 'n/a'}% | ${run.width1.saved.globalDelta.toFixed(6)} | ${run.beamMinusWidth1.savedGlobal.toFixed(6)} | ${run.beam.work.used}/${run.beam.work.unused} | ${run.width1.work.used}/${run.width1.work.unused} | ${run.wallTimeMs} |`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  if (report.errors.length > 0) {
    lines.push('', '## Ошибки', '');
    for (const error of report.errors) {
      lines.push(`- seed ${error.seed}: ${error.message}`);
    }
  }
  if (report.skips.length > 0) {
    lines.push('', '## Skips', '');
    for (const skip of report.skips) {
      lines.push(`- seed ${skip.seed}: ${skip.reason}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Атомарно обновляет общий и seed checkpoint после каждого выбранного сида. */
async function checkpointReport(arg: {
  options: StructuralBeamCliOptions;
  seed: number | null;
  report: StructuralBeamScreeningReport;
}): Promise<void> {
  mkdirSync(arg.options.outDir, { recursive: true });
  await writeJsonAtomic(
    join(arg.options.outDir, 'checkpoint.json'),
    arg.report,
  );
  await writeJsonAtomic(
    join(arg.options.outDir, 'report.json'),
    arg.report,
  );
  await writeTextAtomic(
    join(arg.options.outDir, 'report.md'),
    renderStructuralBeamMarkdown(arg.report),
  );
  if (arg.seed !== null) {
    const seedDir = join(
      arg.options.outDir,
      arg.options.slug,
      `seed-${arg.seed}`,
    );
    mkdirSync(seedDir, { recursive: true });
    await writeJsonAtomic(
      join(seedDir, 'checkpoint.json'),
      arg.report,
    );
  }
}

/**
 * Последовательно обрабатывает synthetic offline seeds под manifest attackBoost.
 *
 * @param options - Полные CLI options с обязательным workBudget
 * @param dependencies - Необязательные synthetic test hooks; CLI их не задаёт
 * @returns Финальный report даже при ошибках отдельных сидов
 * @throws Error при невалидном manifest/out либо сбое checkpoint; `finally`
 *   всегда восстанавливает прежний attackBoost
 * @remarks Missing/not completed original run становится skip. Corrupt run,
 *   canonical mismatch и прочие ошибки попадают в report, а CLI завершается
 *   с exit code 1. После каждого сида runner атомарно пишет checkpoints и не
 *   удаляет чужие или частично записанные файлы.
 */
export async function runStructuralBeamScreening(
  options: StructuralBeamCliOptions,
  dependencies: StructuralBeamRunDependencies = {},
): Promise<StructuralBeamScreeningReport> {
  validateOptions(options);
  assertRealOutputLocation(options);
  assertEmptyOut(options.outDir);
  const manifestPath = join(options.targetDataset, 'manifest.json');
  const rawManifest = await readJsonOrNull<unknown>(manifestPath);
  if (rawManifest === null) {
    throw new Error(`Missing or corrupt manifest: ${manifestPath}`);
  }
  const manifest = normalizeManifest(rawManifest);
  const createdAt = new Date().toISOString();
  const started = Date.now();
  return withAttackBoost(manifest.attackBoost, async () => {
    const runs: StructuralBeamSeedReport[] = [];
    const errors: StructuralBeamRunError[] = [];
    const skips: StructuralBeamRunSkip[] = [];
    for (const seed of options.seeds) {
      let skipReason: StructuralBeamRunSkip['reason'] | null = null;
      try {
        const run = await processSeed({
          options,
          manifest,
          manifestPath,
          seed,
          dependencies,
        });
        if (run === null) {
          const runPath = join(
            options.targetDataset,
            options.slug,
            `seed-${seed}`,
            'run.json',
          );
          skipReason = existsSync(runPath)
            ? 'not-completed'
            : 'missing-run';
          skips.push({
            slug: options.slug,
            seed,
            reason: skipReason,
          });
          console.log(
            `SKIP ${options.slug}/seed-${seed}: ${skipReason}`,
          );
        } else {
          runs.push(run);
          console.log(
            `RESULT ${options.slug} seed=${seed} ` +
              `beam=${run.beam.saved.globalDelta.toFixed(6)} ` +
              `width1=${run.width1.saved.globalDelta.toFixed(6)} ` +
              `W=${run.beam.work.used}/${run.beam.work.budget} ` +
              `warnings=${run.warnings.length}`,
          );
        }
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error);
        errors.push({
          slug: options.slug,
          seed,
          message: detail,
        });
        console.warn(`WARN ${options.slug}/seed-${seed}: ${detail}`);
      }
      const checkpoint = makeReport({
        options,
        manifest,
        createdAt,
        started,
        finished: false,
        runs,
        errors,
        skips,
      });
      await checkpointReport({ options, seed, report: checkpoint });
    }
    const report = makeReport({
      options,
      manifest,
      createdAt,
      started,
      finished: true,
      runs,
      errors,
      skips,
    });
    await checkpointReport({ options, seed: null, report });
    return report;
  });
}

/** Запускает CLI и переводит ошибки сидов в exit code 1. */
async function main(): Promise<void> {
  const options = parseStructuralBeamRunArgs(process.argv.slice(2));
  const report = await runStructuralBeamScreening(options);
  console.log(
    `REPORT completed=${report.gate.completedSeeds} ` +
      `improved=${report.gate.improvedBeamSeeds} ` +
      `gate=${report.gate.pass ? 'PASS' : 'NO_GO'} ` +
      `errors=${report.errors.length}`,
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
