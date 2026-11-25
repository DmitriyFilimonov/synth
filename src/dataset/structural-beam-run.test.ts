import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SAMPLE_RATE } from '../consts';
import {
  attackWeighting,
  computeUsefulZone,
} from '../optimize/evaluate';
import { readWav } from '../read-wav';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  runNativeStructuralBeamWithWidthControl,
  type NativeStructuralBeamOptions,
  type NativeStructuralProposal,
} from './native-structural-beam';
import { measureMetrics, renderForTarget } from './quadrature-refit';
import { withAttackBoost } from './quadrature-refit-run';
import {
  evaluateStructuralBeamGate,
  parseStructuralBeamRunArgs,
  renderStructuralBeamMarkdown,
  runStructuralBeamScreening,
  STRUCTURAL_BEAM_RUN_USAGE,
  type StructuralBeamCliOptions,
  type StructuralBeamGateRun,
  type StructuralBeamGuards,
  type StructuralBeamRunDependencies,
  type StructuralBeamScreeningReport,
} from './structural-beam-run';
import type { ResidualStructuralShapeVariant } from './residual-structural-proposer';
import {
  patchFromStructuralCandidate,
  type StructuralAtomShape,
} from './structural-atom';

const SAMPLE_COUNT = 512;
const TARGET_FILE = 'known-target.wav';
const CANDIDATE_SUBDIR = 'nested/k2-vp-clip-seed-refit';
const TEST_WORK_BUDGET = 100_000;

/** Полная known-answer форма одного native structural-атома. */
function knownShape(): StructuralAtomShape {
  return {
    freqBase: 173,
    freqStart: 197,
    oscDuration: 0.014,
    oscSlope: 0.8,
    ampDuration: 0.04,
    ampEndLevel: 0.03,
    ampSlope: 0.9,
    delaySamples: 0,
    attackSamples: 0,
    hardStop: false,
  };
}

/** Строит исходник с неверными level/phase и target с известным ответом. */
function knownPatchPair(phaseModel: PhaseModel): {
  source: ArgCreateSynth;
  truth: ArgCreateSynth;
  sourceSamples: Int16Array;
  targetSamples: Int16Array;
  proposal: NativeStructuralProposal;
} {
  const proposal: NativeStructuralProposal = {
    slots: [0],
    shapes: [knownShape()],
  };
  const truth = patchFromStructuralCandidate(
    { oscillators: [] },
    {
      ...proposal,
      coefficients: [0.18 * Math.cos(0.27), 0.18 * Math.sin(0.27)],
    },
  );
  const source = patchFromStructuralCandidate(
    { oscillators: [] },
    {
      ...proposal,
      coefficients: [-0.025, 0.031],
    },
  );
  return {
    source,
    truth,
    sourceSamples: renderForTarget(source, SAMPLE_COUNT, phaseModel),
    targetSamples: renderForTarget(truth, SAMPLE_COUNT, phaseModel),
    proposal,
  };
}

interface SyntheticTree {
  root: string;
  sourceBase: string;
  targetDataset: string;
  targetsDir: string;
  outDir: string;
  source: ArgCreateSynth;
  sourceSamples: Int16Array;
  targetSamples: Int16Array;
  proposal: NativeStructuralProposal;
  phaseModel: PhaseModel;
  attackBoost: number;
}

/** Пишет generic source/candidate-subdir и независимый target dataset. */
async function writeSyntheticSeed(arg: {
  root: string;
  seed: number;
  slug?: string;
  phaseModel?: PhaseModel;
  attackBoost?: number;
  candidateSubdir?: string;
  status?: string;
}): Promise<SyntheticTree> {
  const slug = arg.slug ?? 'Known Synthetic';
  const phaseModel = arg.phaseModel ?? 'integral';
  const attackBoost = arg.attackBoost ?? 2.5;
  const candidateSubdir = arg.candidateSubdir ?? CANDIDATE_SUBDIR;
  const sourceBase = join(arg.root, 'source-base');
  const targetDataset = join(arg.root, 'target-dataset');
  const targetsDir = join(arg.root, 'separate-targets');
  const outDir = join(arg.root, 'out');
  const fixture = knownPatchPair(phaseModel);
  const sourceDir = join(
    sourceBase,
    slug,
    `seed-${arg.seed}`,
    candidateSubdir,
  );
  const originalRunDir = join(
    targetDataset,
    slug,
    `seed-${arg.seed}`,
  );
  await mkdir(sourceDir, { recursive: true });
  await mkdir(originalRunDir, { recursive: true });
  await mkdir(targetsDir, { recursive: true });
  await writeFile(
    join(sourceDir, 'patch.json'),
    JSON.stringify(fixture.source),
    'utf8',
  );
  writeWav({
    samples: fixture.sourceSamples,
    sampleRate: SAMPLE_RATE,
    filePath: join(sourceDir, 'result.wav'),
  });
  writeWav({
    samples: fixture.targetSamples,
    sampleRate: SAMPLE_RATE,
    filePath: join(targetsDir, TARGET_FILE),
  });
  await writeFile(
    join(originalRunDir, 'run.json'),
    JSON.stringify({
      status: arg.status ?? 'completed',
      target: TARGET_FILE,
      globalSuppressionPercent: -999,
    }),
    'utf8',
  );
  await writeFile(
    join(targetDataset, 'manifest.json'),
    JSON.stringify({
      targetsDir,
      phaseModel,
      attackBoost,
    }),
    'utf8',
  );
  return {
    root: arg.root,
    sourceBase,
    targetDataset,
    targetsDir,
    outDir,
    source: fixture.source,
    sourceSamples: fixture.sourceSamples,
    targetSamples: fixture.targetSamples,
    proposal: fixture.proposal,
    phaseModel,
    attackBoost,
  };
}

/** Создаёт временный root под одобренным tmp/opencode. */
async function createTempRoot(): Promise<string> {
  const base = join(tmpdir(), 'opencode');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'structural-beam-run-'));
}

/** Собирает полные CLI options с обязательным W и generic candidate-subdir. */
function optionsFor(
  tree: SyntheticTree,
  changes: Partial<StructuralBeamCliOptions> = {},
): StructuralBeamCliOptions {
  return {
    sourceBase: tree.sourceBase,
    targetDataset: tree.targetDataset,
    slug: 'Known Synthetic',
    outDir: tree.outDir,
    seeds: [1],
    workBudget: TEST_WORK_BUDGET,
    candidateSubdir: CANDIDATE_SUBDIR,
    beamWidth: 4,
    maxDepth: 1,
    maxGroupSize: 1,
    maxInner: 1,
    maxBacktracks: 0,
    mode: 'vp',
    ...changes,
  };
}

/** Использует настоящий residual proposer с одним known-answer injection. */
function knownAnswerDependencies(
  tree: SyntheticTree,
  additions: Partial<StructuralBeamRunDependencies> = {},
): StructuralBeamRunDependencies {
  return {
    configureProposer: (options) => ({
      ...options,
      usefulZone: { start: 0, end: tree.targetSamples.length },
      windows: [],
      shapeVariants: [],
      weakActiveSlotCount: 0,
      injectedCandidates: [tree.proposal],
    }),
    ...additions,
  };
}

/** Читает JSON без tolerant fallback, чтобы тест видел повреждение артефакта. */
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Возвращает SHA-256 файла для проверки immutable source. */
function hashFile(path: string): string {
  return createHash('sha256')
    .update(readFileSync(path))
    .digest('hex');
}

/** Собирает фактические CLI-аргументы synthetic no-op/seed-error запуска. */
function structuralCliArgs(
  tree: SyntheticTree,
  mode: 'vp' | 'no-op' = 'no-op',
): string[] {
  return [
    '--source-base',
    tree.sourceBase,
    '--target-dataset',
    tree.targetDataset,
    '--slug',
    'Known Synthetic',
    '--out',
    tree.outDir,
    '--seeds',
    '1',
    '--work-budget',
    '0',
    '--candidate-subdir',
    CANDIDATE_SUBDIR,
    '--mode',
    mode,
  ];
}

/** Запускает настоящий main через локальный tsx и возвращает exit status. */
function executeStructuralCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    'npx',
    ['tsx', join(__dirname, 'structural-beam-run.ts'), ...args],
    {
      cwd: join(__dirname, '../..'),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Рекурсивно перечисляет файлы output, не читая source trees. */
function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    },
  );
}

/** Возвращает полный набор успешных guards для чистого gate fixture. */
function passingGuards(): StructuralBeamGuards {
  return {
    canonical: true,
    global: true,
    windowed: true,
    immutable: true,
    work: true,
  };
}

/** Минимальный paired run для проверки заранее зафиксированного gate. */
function gateRun(
  seed: number,
  globalDelta: number,
  residualReduction: number | null,
  refined = true,
): StructuralBeamGateRun {
  return {
    seed,
    beam: {
      status: refined ? 'refined' : 'unchanged',
      saved: {
        globalDelta,
        residualRmsReductionPercent: residualReduction,
      },
      guards: passingGuards(),
      warnings: [],
    },
    width1: {
      guards: passingGuards(),
      warnings: [],
    },
  };
}

test('CLI requires safe integer W and rejects traversal/output collisions', () => {
  const parsed = parseStructuralBeamRunArgs([
    '--source-base',
    'source',
    '--target-dataset',
    'target',
    '--slug',
    'Boris Brejcha',
    '--out',
    'output',
    '--seeds',
    '1,2,3,4',
    '--work-budget',
    '0',
  ]);
  assert.equal(parsed.workBudget, 0);
  assert.equal(parsed.candidateSubdir, '.');
  assert.equal(parsed.beamWidth, 4);
  assert.equal(parsed.maxDepth, 20);
  assert.equal(parsed.maxGroupSize, 20);
  assert.equal(parsed.maxInner, 12);
  assert.equal(parsed.maxBacktracks, 16);
  assert.equal(parsed.mode, 'vp');
  assert.match(STRUCTURAL_BEAM_RUN_USAGE, /--work-budget N/);

  const required = [
    '--source-base',
    'source',
    '--target-dataset',
    'target',
    '--slug',
    'safe',
    '--out',
    'output',
    '--seeds',
    '1,2,3,4',
  ];
  assert.throws(
    () => parseStructuralBeamRunArgs(required),
    /--work-budget is required/,
  );
  for (const workBudget of [
    'NaN',
    'Infinity',
    '-1',
    '1.5',
    '9007199254740992',
    '',
  ]) {
    assert.throws(
      () =>
        parseStructuralBeamRunArgs([
          ...required,
          '--work-budget',
          workBudget,
        ]),
      /--work-budget/,
    );
  }
  for (const slug of ['../target', 'a/b', 'a\\b', '.', '..']) {
    assert.throws(() =>
      parseStructuralBeamRunArgs([
        ...required.slice(0, 4),
        '--slug',
        slug,
        ...required.slice(6),
        '--work-budget',
        '1',
      ]),
    );
  }
  for (const candidate of ['../escape', '/tmp/escape', 'a/../b']) {
    assert.throws(
      () =>
        parseStructuralBeamRunArgs([
          ...required,
          '--work-budget',
          '1',
          '--candidate-subdir',
          candidate,
        ]),
      /--candidate-subdir/,
    );
  }
  for (const out of [
    'source',
    'source/nested',
    'target',
    'target/out',
  ]) {
    assert.throws(
      () =>
        parseStructuralBeamRunArgs([
          ...required.slice(0, 6),
          '--out',
          out,
          ...required.slice(8),
          '--work-budget',
          '1',
        ]),
      /--out/,
    );
  }
  assert.throws(
    () =>
      parseStructuralBeamRunArgs([
        ...required,
        '--work-budget',
        '1',
        '--mode',
        'cd',
      ]),
    /--mode/,
  );
});

test('generic source and separate target produce actual canonical native candidates', async (t) => {
  const root = await createTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = await writeSyntheticSeed({ root, seed: 1 });
  const sourcePatchPath = join(
    tree.sourceBase,
    'Known Synthetic',
    'seed-1',
    CANDIDATE_SUBDIR,
    'patch.json',
  );
  const sourceWavPath = join(
    tree.sourceBase,
    'Known Synthetic',
    'seed-1',
    CANDIDATE_SUBDIR,
    'result.wav',
  );
  const sourcePatchHash = hashFile(sourcePatchPath);
  const sourceWavHash = hashFile(sourceWavPath);

  const report = await runStructuralBeamScreening(
    optionsFor(tree),
    knownAnswerDependencies(tree),
  );

  assert.equal(report.errors.length, 0);
  assert.equal(report.skips.length, 0);
  assert.equal(report.runs.length, 1);
  assert.equal(report.productionConnected, false);
  assert.equal(report.q4Pass, null);
  assert.equal(report.coordinateDescentStarted, false);
  assert.equal(
    report.gate.pass,
    false,
    'one seed cannot pass the four-seed gate',
  );
  const run = report.runs[0];
  assert.ok(run !== undefined);
  assert.equal(run.immutable, true);
  assert.ok(run.wallTimeMs >= 0);
  assert.ok(run.solverWallTimeMs >= 0);
  assert.ok(run.solverWallTimeMs <= run.wallTimeMs);
  assert.equal(
    run.beam.status,
    'refined',
    run.beam.rejectionReason ?? '',
  );
  assert.equal(
    run.width1.status,
    'refined',
    run.width1.rejectionReason ?? '',
  );
  assert.ok(run.beam.saved.globalDelta > 50);
  assert.ok(run.beam.saved.residualRmsReductionPercent !== null);
  assert.ok((run.beam.saved.residualRmsReductionPercent ?? 0) > 50);
  assert.ok(run.beam.proposed !== null);
  assert.ok(run.width1.proposed !== null);
  assert.ok(run.beam.proposed.globalSuppressionPercent > 90);
  assert.equal(run.beam.saved.character.bodyF0DeltaCents, null);
  assert.equal(run.beam.saved.bands.length, 28);
  assert.equal(run.beam.baseline.bands.length, 28);
  assert.equal(run.beam.proposed.bands.length, 28);
  assert.equal(run.beamMinusWidth1.savedGlobal, 0);
  assert.equal(run.beamMinusWidth1.savedWindowed, 0);
  assert.equal(
    report.gate.meanWidth1GlobalDelta,
    run.width1.saved.globalDelta,
  );
  assert.equal(report.gate.meanBeamMinusWidth1Global, 0);

  for (const branch of [run.beam, run.width1]) {
    assert.equal(branch.guards.canonical, true);
    assert.equal(branch.guards.global, true);
    assert.equal(branch.guards.windowed, true);
    assert.equal(branch.guards.immutable, true);
    assert.equal(branch.guards.work, true);
    assert.equal(branch.work.budget, TEST_WORK_BUDGET);
    assert.equal(
      branch.algorithmOptions.workBudget,
      TEST_WORK_BUDGET,
    );
    assert.equal(branch.algorithmOptions.maxDepth, 1);
    assert.equal(branch.algorithmOptions.maxInner, 1);
    assert.equal(branch.algorithmOptions.maxBacktracks, 0);
    assert.ok(branch.work.used > 0);
    assert.ok(branch.work.used <= TEST_WORK_BUDGET);
    assert.equal(
      branch.work.unused,
      TEST_WORK_BUDGET - branch.work.used,
    );
    assert.equal(
      branch.work.used,
      branch.work.evaluatorWork + branch.work.expansionWork,
    );
    assert.ok(branch.work.evaluatorWork > 0);
    assert.ok(branch.work.expansionWork > 0);
    assert.equal(branch.work.expansionWork, branch.proposer.cost);
    assert.equal(branch.proposer.calls, 1);
    assert.equal(branch.proposer.categories.residual, SAMPLE_COUNT);
    assert.equal(
      branch.proposer.categories.total,
      branch.proposer.cost,
    );
    assert.equal(branch.work.rootSampleWork, null);
    assert.equal(branch.work.rootIncludedInBudget, false);
    assert.equal(
      branch.work.finalizationSampleWork,
      5 * SAMPLE_COUNT,
    );
    assert.equal(branch.work.finalizationIncludedInBudget, false);
    assert.equal(branch.path[0]?.candidateKey, null);
    assert.equal(branch.path.length, 2);
    assert.ok(
      branch.skips.budget.every((skip) => skip.estimatedWork > 0),
    );

    const savedPatch = await readJson<ArgCreateSynth>(branch.patch);
    const savedWav = readWav(branch.wav);
    assertPatchMatchesWav(
      savedPatch,
      savedWav.samples,
      tree.phaseModel,
      SAMPLE_RATE,
      SAMPLE_COUNT,
    );
    const targetValues = Array.from(tree.targetSamples);
    const remeasured = await withAttackBoost(tree.attackBoost, () =>
      measureMetrics(
        savedWav.samples,
        targetValues,
        SAMPLE_RATE,
        computeUsefulZone(targetValues, SAMPLE_RATE),
      ),
    );
    assert.deepEqual(
      branch.saved.globalSuppressionPercent,
      remeasured.globalSuppressionPercent,
    );
    assert.deepEqual(
      branch.saved.windowedSuppressionPercent,
      remeasured.windowedSuppressionPercent,
    );

    const proposedWav = readWav(branch.proposed?.wav ?? '/missing');
    const proposedPatch = await readJson<ArgCreateSynth>(
      branch.proposed?.patch ?? '/missing',
    );
    assertPatchMatchesWav(
      proposedPatch,
      proposedWav.samples,
      tree.phaseModel,
      SAMPLE_RATE,
      SAMPLE_COUNT,
    );
    const history = await readJson<Array<Record<string, unknown>>>(
      branch.history,
    );
    assert.equal(history.length, 1);
    assert.ok(Array.isArray(history[0]?.fixedOffset));
    const audit = await readJson<Record<string, unknown>>(
      branch.audit,
    );
    assert.equal(audit.q4Pass, null);
    assert.equal(audit.productionConnected, false);
    const branchCheckpoint = await readJson<{
      finished: boolean;
      report: { seed: number };
    }>(branch.checkpoint);
    assert.equal(branchCheckpoint.finished, true);
    assert.equal(branchCheckpoint.report.seed, 1);
  }
  assert.notEqual(run.beam.proposer, run.width1.proposer);
  assert.deepEqual(run.beam.proposer, run.width1.proposer);
  assert.equal(run.beam.algorithmOptions.beamWidth, 4);
  assert.equal(run.width1.algorithmOptions.beamWidth, 1);
  assert.equal(hashFile(sourcePatchPath), sourcePatchHash);
  assert.equal(hashFile(sourceWavPath), sourceWavHash);

  for (const path of [
    join(tree.outDir, 'report.json'),
    join(tree.outDir, 'report.md'),
    join(tree.outDir, 'checkpoint.json'),
    join(tree.outDir, 'Known Synthetic', 'seed-1', 'checkpoint.json'),
  ]) {
    assert.equal(existsSync(path), true, path);
  }
  assert.equal(
    listFiles(tree.outDir).some((path) => path.endsWith('.tmp')),
    false,
  );
  const savedReport = await readJson<typeof report>(
    join(tree.outDir, 'report.json'),
  );
  assert.equal(savedReport.finished, true);
  assert.equal(
    savedReport.runs[0]?.beam.saved.globalDelta,
    run.beam.saved.globalDelta,
  );
});

test('no-op never calls solver/proposer and preserves source patch/WAV and metrics', async (t) => {
  const root = await createTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = await writeSyntheticSeed({ root, seed: 1 });
  let solverCalls = 0;
  let proposerConfigurations = 0;
  const report = await runStructuralBeamScreening(
    optionsFor(tree, { mode: 'no-op', workBudget: 12_345 }),
    {
      runBeam: () => {
        solverCalls += 1;
        throw new Error('no-op called solver');
      },
      configureProposer: (options) => {
        proposerConfigurations += 1;
        return options;
      },
    },
  );

  assert.equal(solverCalls, 0);
  assert.equal(proposerConfigurations, 0);
  assert.equal(report.errors.length, 0);
  const run = report.runs[0];
  assert.ok(run !== undefined);
  assert.equal(run.solverWallTimeMs, 0);
  for (const branch of [run.beam, run.width1]) {
    assert.equal(branch.status, 'unchanged');
    assert.equal(branch.proposed, null);
    assert.equal(branch.work.used, 0);
    assert.equal(branch.work.evaluatorWork, 0);
    assert.equal(branch.work.expansionWork, 0);
    assert.equal(branch.work.finalizationSampleWork, 0);
    assert.equal(branch.proposer.calls, 0);
    assert.equal(branch.proposer.cost, 0);
    assert.deepEqual(await readJson(branch.patch), tree.source);
    assert.deepEqual(readWav(branch.wav).samples, tree.sourceSamples);
    assert.equal(branch.saved.globalDelta, 0);
    assert.equal(branch.saved.windowedDelta, 0);
    assert.equal(branch.saved.residualRmsReductionPercent, 0);
    assert.deepEqual(
      branch.saved.globalSuppressionPercent,
      branch.baseline.globalSuppressionPercent,
    );
    assert.deepEqual(
      branch.saved.windowedSuppressionPercent,
      branch.baseline.windowedSuppressionPercent,
    );
    assert.ok(
      branch.warnings.some((warning) => warning.includes('no-op')),
    );
  }
});

test('non-empty out is rejected without deleting another file', async (t) => {
  const root = await createTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = await writeSyntheticSeed({ root, seed: 1 });
  await mkdir(tree.outDir, { recursive: true });
  const sentinel = join(tree.outDir, 'keep.txt');
  await writeFile(sentinel, 'do not delete', 'utf8');

  await assert.rejects(
    runStructuralBeamScreening(optionsFor(tree, { mode: 'no-op' })),
    /--out must be absent or empty/,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'do not delete');
  assert.deepEqual(readdirSync(tree.outDir), ['keep.txt']);
});

test('realpath rejects out symlinks into source and target without touching inputs', async (t) => {
  for (const input of ['source', 'target'] as const) {
    const root = await createTempRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const tree = await writeSyntheticSeed({ root, seed: 1 });
    const inputRoot =
      input === 'source' ? tree.sourceBase : tree.targetDataset;
    const realDestination = join(inputRoot, 'real-output');
    await mkdir(realDestination, { recursive: true });
    const sentinel = join(realDestination, 'keep.txt');
    await writeFile(sentinel, `keep ${input}`, 'utf8');
    await symlink(realDestination, tree.outDir, 'dir');
    const sourcePatchPath = join(
      tree.sourceBase,
      'Known Synthetic',
      'seed-1',
      CANDIDATE_SUBDIR,
      'patch.json',
    );
    const manifestPath = join(tree.targetDataset, 'manifest.json');
    const sourceHash = hashFile(sourcePatchPath);
    const manifestHash = hashFile(manifestPath);

    assert.equal(
      await realpath(tree.outDir),
      await realpath(realDestination),
    );
    await assert.rejects(
      runStructuralBeamScreening(
        optionsFor(tree, { mode: 'no-op', workBudget: 0 }),
      ),
      /--out resolves inside an immutable input tree/,
    );

    assert.equal(await readFile(sentinel, 'utf8'), `keep ${input}`);
    assert.equal(hashFile(sourcePatchPath), sourceHash);
    assert.equal(hashFile(manifestPath), manifestHash);
    assert.deepEqual(readdirSync(realDestination), ['keep.txt']);
  }
});

test('missing/not completed skip; corrupt run and source canonical mismatch are errors before solver', async (t) => {
  const root = await createTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = await writeSyntheticSeed({ root, seed: 4 });
  const sourceDir = join(
    tree.sourceBase,
    'Known Synthetic',
    'seed-4',
    CANDIDATE_SUBDIR,
  );
  writeWav({
    samples: tree.targetSamples,
    sampleRate: SAMPLE_RATE,
    filePath: join(sourceDir, 'result.wav'),
  });
  await mkdir(join(tree.targetDataset, 'Known Synthetic', 'seed-2'), {
    recursive: true,
  });
  await writeFile(
    join(tree.targetDataset, 'Known Synthetic', 'seed-2', 'run.json'),
    JSON.stringify({ status: 'running', target: TARGET_FILE }),
  );
  await mkdir(join(tree.targetDataset, 'Known Synthetic', 'seed-3'), {
    recursive: true,
  });
  await writeFile(
    join(tree.targetDataset, 'Known Synthetic', 'seed-3', 'run.json'),
    '{corrupt',
  );
  let solverCalls = 0;
  const report = await runStructuralBeamScreening(
    optionsFor(tree, { seeds: [1, 2, 3, 4] }),
    {
      runBeam: () => {
        solverCalls += 1;
        throw new Error('solver must not run');
      },
    },
  );

  assert.equal(solverCalls, 0);
  assert.equal(report.runs.length, 0);
  assert.deepEqual(
    report.skips.map((skip) => [skip.seed, skip.reason]),
    [
      [1, 'missing-run'],
      [2, 'not-completed'],
    ],
  );
  assert.equal(report.errors.length, 2);
  assert.match(
    report.errors[0]?.message ?? '',
    /Corrupt original run/,
  );
  assert.match(
    report.errors[1]?.message ?? '',
    /patch\.json.*result\.wav/,
  );
  assert.equal(report.gate.pass, false);
  assert.equal(report.q4Pass, null);
  assert.match(renderStructuralBeamMarkdown(report), /NO GO/);
  assert.match(
    renderStructuralBeamMarkdown(report),
    /Corrupt original run/,
  );
  assert.equal(
    existsSync(join(tree.outDir, 'checkpoint.json')),
    true,
  );
  assert.equal(
    existsSync(
      join(
        tree.outDir,
        'Known Synthetic',
        'seed-3',
        'checkpoint.json',
      ),
    ),
    true,
  );
});

test('source SHA change inside solver becomes a seed error before completed artifacts', async (t) => {
  const root = await createTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = await writeSyntheticSeed({ root, seed: 1 });
  const sourcePatchPath = join(
    tree.sourceBase,
    'Known Synthetic',
    'seed-1',
    CANDIDATE_SUBDIR,
    'patch.json',
  );
  const originalHash = hashFile(sourcePatchPath);
  let solverCalls = 0;
  const report = await runStructuralBeamScreening(
    optionsFor(tree),
    knownAnswerDependencies(tree, {
      runBeam: (nativeOptions) => {
        solverCalls += 1;
        writeFileSync(
          sourcePatchPath,
          `${readFileSync(sourcePatchPath, 'utf8')}\n`,
          'utf8',
        );
        return runNativeStructuralBeamWithWidthControl(nativeOptions);
      },
    }),
  );

  assert.equal(solverCalls, 1);
  assert.notEqual(hashFile(sourcePatchPath), originalHash);
  assert.equal(report.errors.length, 1);
  assert.match(
    report.errors[0]?.message ?? '',
    /Source inputs changed/,
  );
  assert.equal(report.runs.length, 0);
  assert.equal(report.gate.completedSeeds, 0);
  assert.equal(report.gate.pass, false);
  assert.equal(report.q4Pass, null);
  const saved = await readJson<StructuralBeamScreeningReport>(
    join(tree.outDir, 'report.json'),
  );
  assert.equal(saved.errors.length, 1);
  assert.equal(saved.gate.pass, false);
  assert.equal(
    existsSync(
      join(
        tree.outDir,
        'Known Synthetic',
        'seed-1',
        'beam',
        'checkpoint.json',
      ),
    ),
    false,
  );
});

test('manifest attackBoost covers proposer/solver and finally restores after seed error', async (t) => {
  const root = await createTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = await writeSyntheticSeed({
    root,
    seed: 1,
    attackBoost: 7,
  });
  const previous = attackWeighting.boost;
  const observed: number[] = [];
  try {
    const report = await runStructuralBeamScreening(
      optionsFor(tree),
      knownAnswerDependencies(tree, {
        configureProposer: (options) => {
          observed.push(attackWeighting.boost);
          return {
            ...options,
            windows: [],
            shapeVariants: [],
            injectedCandidates: [tree.proposal],
          };
        },
        runBeam: () => {
          observed.push(attackWeighting.boost);
          throw new Error('synthetic solver failure');
        },
      }),
    );
    assert.deepEqual(observed, [7, 7]);
    assert.equal(attackWeighting.boost, previous);
    assert.equal(report.errors.length, 1);
    assert.match(
      report.errors[0]?.message ?? '',
      /synthetic solver failure/,
    );
    assert.equal(report.gate.pass, false);
    assert.equal(report.q4Pass, null);
  } finally {
    attackWeighting.boost = previous;
  }
});

test('fixed gate requires 3/4 improved, mean 4.6 and 25%, plus every guard', () => {
  const passing = [
    gateRun(1, 7, 40),
    gateRun(2, 7, 40),
    gateRun(3, 7, 40),
    gateRun(4, 0, 0, false),
  ];
  passing[0]?.beam.warnings.push('WARN: visible but not hidden');
  const pass = evaluateStructuralBeamGate({
    requestedSeeds: 4,
    runs: passing,
    errors: 0,
    skips: 0,
  });
  assert.equal(pass.completedSeeds, 4);
  assert.equal(pass.improvedBeamSeeds, 3);
  assert.equal(pass.meanBeamGlobalDelta, 5.25);
  assert.equal(pass.meanBeamResidualRmsReductionPercent, 30);
  assert.equal(pass.warningCount, 1);
  assert.equal(pass.pass, true);
  assert.equal(
    evaluateStructuralBeamGate({
      requestedSeeds: 4,
      runs: [1, 2, 3, 4].map((seed) => gateRun(seed, 4.6, 25)),
      errors: 0,
      skips: 0,
    }).pass,
    true,
  );

  const twoImproved = [
    gateRun(1, 10, 40),
    gateRun(2, 10, 40),
    gateRun(3, 0, 40, false),
    gateRun(4, 0, 40, false),
  ];
  assert.equal(
    evaluateStructuralBeamGate({
      requestedSeeds: 4,
      runs: twoImproved,
      errors: 0,
      skips: 0,
    }).pass,
    false,
  );
  assert.equal(
    evaluateStructuralBeamGate({
      requestedSeeds: 4,
      runs: [1, 2, 3, 4].map((seed) => gateRun(seed, 4.5, 40)),
      errors: 0,
      skips: 0,
    }).pass,
    false,
  );
  assert.equal(
    evaluateStructuralBeamGate({
      requestedSeeds: 4,
      runs: [1, 2, 3, 4].map((seed) => gateRun(seed, 7, 24.9)),
      errors: 0,
      skips: 0,
    }).pass,
    false,
  );
  assert.equal(
    evaluateStructuralBeamGate({
      requestedSeeds: 4,
      runs: passing.slice(0, 3),
      errors: 0,
      skips: 1,
    }).pass,
    false,
  );
  for (const key of [
    'canonical',
    'global',
    'windowed',
    'immutable',
    'work',
  ] as const) {
    const failedGuard = structuredClone(passing);
    const first = failedGuard[0];
    assert.ok(first !== undefined);
    first.beam.guards[key] = false;
    assert.equal(
      evaluateStructuralBeamGate({
        requestedSeeds: 4,
        runs: failedGuard,
        errors: 0,
        skips: 0,
      }).pass,
      false,
      key,
    );
  }
  const failedControl = structuredClone(passing);
  const firstControl = failedControl[0];
  assert.ok(firstControl !== undefined);
  firstControl.width1.guards.work = false;
  assert.equal(
    evaluateStructuralBeamGate({
      requestedSeeds: 4,
      runs: failedControl,
      errors: 0,
      skips: 0,
    }).pass,
    false,
  );
  assert.equal(
    evaluateStructuralBeamGate({
      requestedSeeds: 4,
      runs: passing,
      errors: 1,
      skips: 0,
    }).pass,
    false,
  );
});

test('native options still use one factory per branch when runner captures snapshots', async (t) => {
  const root = await createTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = await writeSyntheticSeed({ root, seed: 1 });
  const factories: NativeStructuralBeamOptions[] = [];
  const dependencies = knownAnswerDependencies(tree, {
    runBeam: (options) => {
      factories.push(options);
      return runNativeStructuralBeamWithWidthControl(options);
    },
  });
  const report = await runStructuralBeamScreening(
    optionsFor(tree),
    dependencies,
  );
  assert.equal(factories.length, 1);
  const nativeOptions = factories[0];
  assert.ok(nativeOptions !== undefined);
  assert.equal(
    typeof nativeOptions.createProposerSession,
    'function',
  );
  assert.equal(nativeOptions.propose, undefined);
  assert.equal(nativeOptions.workBudget, TEST_WORK_BUDGET);
  const run = report.runs[0];
  assert.ok(run !== undefined);
  assert.equal(run.beam.work.budget, run.width1.work.budget);
  assert.equal(run.beam.proposer.calls, run.beam.expansions.length);
  assert.equal(
    run.width1.proposer.calls,
    run.width1.expansions.length,
  );
  assert.equal(run.beam.expansions[0]?.cost, run.beam.proposer.cost);
  assert.equal(
    run.width1.expansions[0]?.cost,
    run.width1.proposer.cost,
  );
});

test('automatic residual FFT drives a real native candidate without injections or mock scores', async (t) => {
  const root = await createTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = await writeSyntheticSeed({ root, seed: 1 });
  const sampleCount = 4096;
  const frequency = SAMPLE_RATE / 4;
  const variant: ResidualStructuralShapeVariant = {
    freqStartRatio: 1,
    oscDuration: 0.018,
    oscSlope: 0.8,
    ampDuration: sampleCount / SAMPLE_RATE,
    ampEndLevel: 1,
    ampSlope: 1.1,
    delaySamples: 0,
    attackSamples: 0,
    hardStop: false,
  };
  const shape: StructuralAtomShape = {
    freqBase: frequency,
    freqStart: frequency,
    oscDuration: variant.oscDuration,
    oscSlope: variant.oscSlope,
    ampDuration: variant.ampDuration,
    ampEndLevel: variant.ampEndLevel,
    ampSlope: variant.ampSlope,
    delaySamples: variant.delaySamples,
    attackSamples: variant.attackSamples,
    hardStop: variant.hardStop,
  };
  const truth = patchFromStructuralCandidate(
    { oscillators: [] },
    {
      slots: [0],
      shapes: [shape],
      coefficients: [1000 / 32767, 0],
    },
  );
  const source = structuredClone(truth);
  const sourceGroup = source.oscillators[0];
  assert.ok(sourceGroup !== undefined);
  sourceGroup.osc.on = false;
  const targetSamples = renderForTarget(
    truth,
    sampleCount,
    tree.phaseModel,
  );
  const sourceSamples = renderForTarget(
    source,
    sampleCount,
    tree.phaseModel,
  );
  const sourceDir = join(
    tree.sourceBase,
    'Known Synthetic',
    'seed-1',
    CANDIDATE_SUBDIR,
  );
  await writeFile(
    join(sourceDir, 'patch.json'),
    JSON.stringify(source),
    'utf8',
  );
  writeWav({
    samples: sourceSamples,
    sampleRate: SAMPLE_RATE,
    filePath: join(sourceDir, 'result.wav'),
  });
  writeWav({
    samples: targetSamples,
    sampleRate: SAMPLE_RATE,
    filePath: join(tree.targetsDir, TARGET_FILE),
  });

  const report = await runStructuralBeamScreening(
    optionsFor(tree, {
      workBudget: 100_000_000,
      maxInner: 8,
      maxBacktracks: 16,
    }),
    {
      configureProposer: (options) => ({
        ...options,
        usefulZone: { start: 0, end: sampleCount },
        windows: [{ name: 'full', start: 0, end: sampleCount }],
        maxPeaksPerWindow: 1,
        relativePeakThreshold: 0,
        shapeVariants: [variant],
        weakActiveSlotCount: 0,
        injectedCandidates: [],
      }),
    },
  );

  assert.equal(report.errors.length, 0);
  const run = report.runs[0];
  assert.ok(run !== undefined);
  for (const branch of [run.beam, run.width1]) {
    assert.equal(
      branch.status,
      'refined',
      branch.rejectionReason ?? '',
    );
    assert.ok(branch.saved.globalSuppressionPercent > 99);
    assert.ok(branch.proposer.categories.window > 0);
    assert.ok(branch.proposer.categories.fft > 0);
    assert.ok(branch.proposer.categories.peaks > 0);
    assert.ok(branch.proposer.categories.shapes > 0);
    assert.ok(branch.work.evaluatorWork > 0);
    assert.equal(branch.work.expansionWork, branch.proposer.cost);
    assert.equal(branch.work.finalizationSampleWork, 5 * sampleCount);
    assert.equal(branch.guards.work, true);
  }
});

test('main returns 1 for usage and seed errors but 0 for clean NO GO', async (t) => {
  const usage = executeStructuralCli([]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /--work-budget is required/);

  const noGoRoot = await createTempRoot();
  t.after(() => rmSync(noGoRoot, { recursive: true, force: true }));
  const noGoTree = await writeSyntheticSeed({
    root: noGoRoot,
    seed: 1,
  });
  const noGo = executeStructuralCli(structuralCliArgs(noGoTree));
  assert.equal(noGo.status, 0, noGo.stderr);
  assert.match(noGo.stdout, /gate=NO_GO/);
  const noGoReport = await readJson<StructuralBeamScreeningReport>(
    join(noGoTree.outDir, 'report.json'),
  );
  assert.equal(noGoReport.errors.length, 0);
  assert.equal(noGoReport.gate.pass, false);
  assert.equal(noGoReport.runs.length, 1);

  const errorRoot = await createTempRoot();
  t.after(() => rmSync(errorRoot, { recursive: true, force: true }));
  const errorTree = await writeSyntheticSeed({
    root: errorRoot,
    seed: 1,
  });
  await writeFile(
    join(
      errorTree.targetDataset,
      'Known Synthetic',
      'seed-1',
      'run.json',
    ),
    '{corrupt',
    'utf8',
  );
  const seedError = executeStructuralCli(
    structuralCliArgs(errorTree),
  );
  assert.equal(seedError.status, 1, seedError.stderr);
  assert.match(seedError.stdout, /errors=1/);
  const errorReport = await readJson<StructuralBeamScreeningReport>(
    join(errorTree.outDir, 'report.json'),
  );
  assert.equal(errorReport.errors.length, 1);
  assert.equal(errorReport.gate.pass, false);
});
