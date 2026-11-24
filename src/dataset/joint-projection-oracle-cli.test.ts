import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { attackWeighting } from '../optimize/evaluate';
import { readWav } from '../read-wav';
import type { ArgCreateSynth } from '../synth';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  JOINT_PROJECTION_CONFIG,
  patchFromJointCoefficients,
  runJointProjectionCli,
  type CandidateRunReport,
  type JointRunReport,
  type JointTargetSummary,
  type RunError,
} from './joint-projection-oracle';
import { renderSamples } from './shared';

interface Fixture {
  root: string;
  dataset: string;
  outDir: string;
  runDir: string;
  source: ArgCreateSynth;
  initial: ArgCreateSynth;
  currentSamples: Int16Array;
}

interface CliReport {
  version: number;
  codeRevision: string;
  attackBoost: number;
  outputPolicy: string;
  config: typeof JOINT_PROJECTION_CONFIG;
  runs: JointRunReport[];
  summaries: JointTargetSummary[];
  errors: RunError[];
}

interface Checkpoint {
  status: string;
  reason?: string;
  message?: string;
}

interface SavedAudit {
  coefficients: number[];
  raw: { rawRss: number };
  canonical: { globalSuppressionPercent: number };
  savedGlobalDelta: number;
  savedWindowedDelta: number;
  artifactIsFallback: boolean;
  config: typeof JOINT_PROJECTION_CONFIG;
}

/** Читает JSON через unknown, чтобы типы не текли из any. */
function readJson<T>(path: string): T {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed as T;
}

/** Создаёт короткий completed match без запуска coordinate descent. */
function createFixture(exactCurrent = false): Fixture {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync('/tmp/opencode/joint-cli-');
  const dataset = join(root, 'dataset');
  const targets = join(root, 'targets');
  const outDir = join(root, 'out');
  const runDir = join(dataset, 'GrumU', 'seed-1');
  mkdirSync(targets, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const makeGroup = (
    level: number,
    phase: number,
  ): ArgCreateSynth['oscillators'][number] => ({
    osc: {
      on: true,
      freqBase: 80,
      freqStart: 80,
      duration: 0.04,
      slope: 1,
      phase,
    },
    ampEnv: {
      startLevel: level,
      endLevel: 0.02,
      duration: 0.04,
      slope: 1,
    },
  });
  const source: ArgCreateSynth = {
    oscillators: [makeGroup(0.2, 0.8)],
  };
  const initial: ArgCreateSynth = exactCurrent
    ? structuredClone(source)
    : { oscillators: [makeGroup(0.07, 2.4)] };
  const seconds = (2048 + 0.5) / 44100;
  const target = renderSamples(source, seconds, {
    phaseModel: 'integral',
  });
  const currentSamples = renderSamples(initial, seconds, {
    phaseModel: 'integral',
  });
  writeWav({
    samples: target,
    sampleRate: 44100,
    filePath: join(targets, 'target.wav'),
  });
  writeWav({
    samples: currentSamples,
    sampleRate: 44100,
    filePath: join(runDir, 'result.wav'),
  });
  writeFileSync(join(runDir, 'patch.json'), JSON.stringify(initial));
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      status: 'completed',
      target: 'target.wav',
      globalSuppressionPercent: null,
    }),
  );
  writeFileSync(
    join(dataset, 'manifest.json'),
    JSON.stringify({
      targetsDir: targets,
      phaseModel: 'integral',
      attackBoost: 3,
    }),
  );
  return {
    root,
    dataset,
    outDir,
    runDir,
    source,
    initial,
    currentSamples,
  };
}

/** Вызывает только synthetic CLI и возвращает typed report. */
async function runFixtureCli(fixture: Fixture): Promise<CliReport> {
  const exitCode = await runJointProjectionCli([
    '--dataset',
    fixture.dataset,
    '--out',
    fixture.outDir,
  ]);
  assert.equal(exitCode, 0);
  return readJson<CliReport>(join(fixture.outDir, 'report.json'));
}

test('accepted E follows coefficients through patch and canonical saved WAV', async () => {
  const fixture = createFixture();
  try {
    const previousBoost = attackWeighting.boost;
    const report = await runFixtureCli(fixture);
    assert.equal(attackWeighting.boost, previousBoost);
    assert.equal(report.version, 2);
    assert.match(report.codeRevision, /^[0-9a-f]{40}$/);
    assert.equal(report.attackBoost, 3);
    assert.equal(report.outputPolicy, 'require-empty-out');
    assert.equal(report.config.maxEIterationsPerStart, 25);
    assert.equal(report.config.maxBacktracksPerEStart, 625);
    assert.equal(report.config.rankRelativeCutoff, 1e-10);
    assert.equal(report.config.normRelativeCutoff, 1e-12);
    const run = report.runs[0];
    assert.ok(run !== undefined);
    assert.equal(run.e.status, 'refined');
    assert.equal(run.e.accepted, true);
    assert.equal(run.e.savedGlobalDelta, run.e.canonicalGlobalDelta);
    assert.equal(
      run.e.savedWindowedDelta,
      run.e.canonicalWindowedDelta,
    );
    const summary = report.summaries[0];
    assert.ok(summary !== undefined);
    assert.equal(summary.slug, 'GrumU');
    assert.equal(
      summary.e.meanSavedGlobalDelta,
      run.e.savedGlobalDelta,
    );
    assert.equal(
      summary.e.meanSavedWindowedDelta,
      run.e.savedWindowedDelta,
    );
    assert.equal(summary.e.improved, 1);
    assert.equal(
      summary.e.meanProposedGlobalDelta,
      run.e.canonicalGlobalDelta,
    );
    const checkpoint = readJson<Checkpoint>(
      join(fixture.outDir, 'GrumU', 'seed-1', 'checkpoint.json'),
    );
    assert.equal(checkpoint.status, 'completed');
    const savedPatch = readJson<ArgCreateSynth>(run.e.patch);
    const savedWav = readWav(run.e.wav);
    const audit = readJson<SavedAudit>(run.e.audit);
    assert.deepEqual(audit.config, JOINT_PROJECTION_CONFIG);
    assert.equal(audit.savedGlobalDelta, run.e.savedGlobalDelta);
    assert.equal(audit.savedWindowedDelta, run.e.savedWindowedDelta);
    const expectedPatch = patchFromJointCoefficients({
      patch: fixture.initial,
      activeOscillatorIndices: [0],
      coefficients: audit.coefficients,
    });
    assert.deepEqual(savedPatch, expectedPatch);
    assertPatchMatchesWav(
      savedPatch,
      savedWav.samples,
      'integral',
      44100,
      fixture.currentSamples.length,
    );
    assert.equal(
      run.e.canonicalGlobalSuppressionPercent,
      audit.canonical.globalSuppressionPercent,
    );
    assert.equal(run.e.rawRss, audit.raw.rawRss);
    for (let seed = 2; seed <= 4; seed += 1) {
      const skipped = readJson<Checkpoint>(
        join(
          fixture.outDir,
          'GrumU',
          `seed-${seed}`,
          'checkpoint.json',
        ),
      );
      assert.equal(skipped.status, 'skipped');
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejected candidates save current but retain proposed raw/canonical audit', async () => {
  const fixture = createFixture(true);
  try {
    const report = await runFixtureCli(fixture);
    const run = report.runs[0];
    assert.ok(run !== undefined);
    for (const kind of ['d', 'e'] as const) {
      const candidate: CandidateRunReport = run[kind];
      assert.equal(candidate.status, 'unchanged');
      assert.equal(candidate.accepted, false);
      assert.equal(candidate.savedGlobalDelta, 0);
      assert.equal(candidate.savedWindowedDelta, 0);
      assert.equal(
        candidate.rejectionReason,
        'canonical global не вырос',
      );
      const patch = readJson<ArgCreateSynth>(candidate.patch);
      const wav = readWav(candidate.wav);
      const audit = readJson<SavedAudit>(candidate.audit);
      assert.deepEqual(patch, fixture.initial);
      assert.deepEqual(wav.samples, fixture.currentSamples);
      assert.equal(audit.artifactIsFallback, true);
      assert.equal(audit.savedGlobalDelta, 0);
      assert.equal(audit.savedWindowedDelta, 0);
      assert.equal(candidate.rawRss, audit.raw.rawRss);
      assert.equal(
        candidate.canonicalGlobalSuppressionPercent,
        audit.canonical.globalSuppressionPercent,
      );
      assert.ok(candidate.canonicalGlobalDelta <= 1e-10);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('target summaries average rejected saved gain as zero, not proposed gain', async () => {
  const fixture = createFixture();
  try {
    const secondRun = join(fixture.dataset, 'GrumU', 'seed-2');
    mkdirSync(secondRun, { recursive: true });
    const rejectedSamples = renderSamples(
      fixture.source,
      (2048 + 0.5) / 44100,
      { phaseModel: 'integral' },
    );
    writeWav({
      samples: rejectedSamples,
      sampleRate: 44100,
      filePath: join(secondRun, 'result.wav'),
    });
    writeFileSync(
      join(secondRun, 'patch.json'),
      JSON.stringify(fixture.source),
    );
    writeFileSync(
      join(secondRun, 'run.json'),
      JSON.stringify({ status: 'completed', target: 'target.wav' }),
    );
    const report = await runFixtureCli(fixture);
    const accepted = report.runs.find((run) => run.seed === 1);
    const rejected = report.runs.find((run) => run.seed === 2);
    const summary = report.summaries[0];
    assert.ok(
      accepted !== undefined &&
        rejected !== undefined &&
        summary !== undefined,
    );
    assert.equal(summary.runs, 2);
    for (const kind of ['d', 'e'] as const) {
      const acceptedCandidate: CandidateRunReport = accepted[kind];
      const rejectedCandidate: CandidateRunReport = rejected[kind];
      assert.equal(acceptedCandidate.accepted, true);
      assert.equal(rejectedCandidate.accepted, false);
      assert.equal(rejectedCandidate.savedGlobalDelta, 0);
      assert.equal(rejectedCandidate.savedWindowedDelta, 0);
      assert.equal(
        summary[kind].meanSavedGlobalDelta,
        acceptedCandidate.savedGlobalDelta / 2,
      );
      assert.equal(
        summary[kind].meanSavedWindowedDelta,
        acceptedCandidate.savedWindowedDelta / 2,
      );
      assert.equal(
        summary[kind].meanProposedGlobalDelta,
        (acceptedCandidate.canonicalGlobalDelta +
          rejectedCandidate.canonicalGlobalDelta) /
          2,
      );
      assert.equal(summary[kind].improved, 1);
    }
    const markdown = readFileSync(
      join(fixture.outDir, 'report.md'),
      'utf8',
    );
    assert.match(markdown, /D proposed ΔG/);
    assert.match(markdown, /D saved ΔG/);
    assert.match(markdown, /D mean saved ΔJ/);
    assert.match(markdown, /E mean proposed ΔG/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('corrupt run.json is an error while missing and not completed skip', async () => {
  const fixture = createFixture();
  try {
    writeFileSync(join(fixture.runDir, 'run.json'), '{broken');
    const secondRun = join(fixture.dataset, 'GrumU', 'seed-2');
    mkdirSync(secondRun, { recursive: true });
    writeFileSync(
      join(secondRun, 'run.json'),
      JSON.stringify({ status: 'failed' }),
    );
    const previousBoost = attackWeighting.boost;
    const exitCode = await runJointProjectionCli([
      '--dataset',
      fixture.dataset,
      '--out',
      fixture.outDir,
    ]);
    assert.equal(exitCode, 1);
    assert.equal(attackWeighting.boost, previousBoost);
    const report = readJson<CliReport>(
      join(fixture.outDir, 'report.json'),
    );
    assert.equal(report.runs.length, 0);
    assert.equal(report.errors.length, 1);
    assert.match(
      report.errors[0]?.message ?? '',
      /Повреждён run.json/,
    );
    const failed = readJson<Checkpoint>(
      join(fixture.outDir, 'GrumU', 'seed-1', 'checkpoint.json'),
    );
    assert.equal(failed.status, 'error');
    assert.match(failed.message ?? '', /Повреждён run.json/);
    assert.equal(
      existsSync(
        join(fixture.outDir, 'GrumU', 'seed-1', 'error.json'),
      ),
      true,
    );
    assert.equal(
      existsSync(join(fixture.outDir, 'GrumU', 'seed-1', 'd')),
      false,
    );
    for (const seed of [2, 3, 4]) {
      const skipped = readJson<Checkpoint>(
        join(
          fixture.outDir,
          'GrumU',
          `seed-${seed}`,
          'checkpoint.json',
        ),
      );
      assert.equal(skipped.status, 'skipped');
      assert.equal(skipped.reason, 'missing or not completed');
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('nonempty out is rejected without deleting stale or foreign files', async () => {
  const fixture = createFixture();
  try {
    rmSync(join(fixture.runDir, 'run.json'));
    mkdirSync(fixture.outDir, { recursive: true });
    await runFixtureCli(fixture);
    const reportPath = join(fixture.outDir, 'report.json');
    const reportBefore = readFileSync(reportPath, 'utf8');
    const staleError = join(
      fixture.outDir,
      'GrumU',
      'seed-1',
      'error.json',
    );
    const staleD = join(
      fixture.outDir,
      'GrumU',
      'seed-1',
      'd',
      'old.json',
    );
    const foreign = join(fixture.outDir, 'foreign.txt');
    writeFileSync(staleError, 'stale-error');
    mkdirSync(join(fixture.outDir, 'GrumU', 'seed-1', 'd'), {
      recursive: true,
    });
    writeFileSync(staleD, 'stale-d');
    writeFileSync(foreign, 'keep');
    await assert.rejects(
      runJointProjectionCli([
        '--dataset',
        fixture.dataset,
        '--out',
        fixture.outDir,
      ]),
      /--out должен быть пустым/,
    );
    assert.equal(readFileSync(reportPath, 'utf8'), reportBefore);
    assert.equal(readFileSync(staleError, 'utf8'), 'stale-error');
    assert.equal(readFileSync(staleD, 'utf8'), 'stale-d');
    assert.equal(readFileSync(foreign, 'utf8'), 'keep');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
