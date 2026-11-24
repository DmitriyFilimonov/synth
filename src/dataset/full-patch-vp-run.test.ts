import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  attackWeighting,
  computeUsefulZone,
  evaluateSuppressionWindowed,
} from '../optimize/evaluate';
import { coordinateDescent } from '../optimize/coordinate-descent';
import { readWav } from '../read-wav';
import type { ArgCreateSynth } from '../synth';
import { mapVectorToSynthConfig } from '../vector-to-synth-config';
import { writeWav } from '../write-wav';
import {
  runFullPatchVariableProjection,
  type FullPatchRunInput,
} from './full-patch-vp';
import {
  parseFullPatchVpRunArgs,
  runFullPatchVpScreening,
  summarizeFullPatchVpTarget,
  type FullPatchVpCliOptions,
  type FullPatchVpSeedReport,
} from './full-patch-vp-run';
import { measureMetrics } from './quadrature-refit';
import { withAttackBoost } from './quadrature-refit-run';
import {
  readJsonOrNull,
  renderSamples,
  writeJsonAtomic,
} from './shared';

const SAMPLE_RATE = 44100;
const SAMPLE_COUNT = 1024;
const DELAY_SECONDS = 0.005;

function tone(
  volume: number,
  delay?: number,
  attack?: number,
): ArgCreateSynth {
  const vector = [
    1,
    0.001,
    0.002,
    0.4,
    0.5,
    0.25,
    0.4,
    0.1,
    0.5,
    volume,
  ];
  const patch = mapVectorToSynthConfig(
    vector,
    delay === undefined ? undefined : [delay],
  );
  patch.oscillators = patch.oscillators.slice(0, 1);
  const group = patch.oscillators[0];
  assert.ok(group !== undefined);
  if (attack !== undefined) {
    group.ampEnv.attack = attack;
  }
  return patch;
}

function canonicalSamples(patch: ArgCreateSynth): Int16Array {
  return renderSamples(patch, (SAMPLE_COUNT + 0.5) / SAMPLE_RATE, {
    phaseModel: 'integral',
  });
}

async function writeSource(
  directory: string,
  patch: ArgCreateSynth,
): Promise<{ patch: string; wav: string }> {
  mkdirSync(directory, { recursive: true });
  const patchPath = join(directory, 'patch.json');
  const wavPath = join(directory, 'result.wav');
  await writeJsonAtomic(patchPath, patch);
  writeWav({
    samples: canonicalSamples(patch),
    sampleRate: SAMPLE_RATE,
    filePath: wavPath,
  });
  return { patch: patchPath, wav: wavPath };
}

interface Fixture {
  kind: 'grumu' | 'bog' | 'match';
  base: string;
  dataset: string;
  originalRunDir: string;
  sourceRunDir: string;
  sourcePatch: ArgCreateSynth;
  targetPath: string;
  slug: string;
}

async function createFixture(
  root: string,
  kind: 'grumu' | 'bog',
  attackBoost = 3,
  localized = false,
): Promise<Fixture> {
  const slug = kind === 'grumu' ? 'GrumU' : 'BOg-Disco-Futuro';
  const dataset = join(root, 'reference');
  const base = join(root, kind);
  const targets = join(root, 'targets');
  const originalRunDir = join(dataset, slug, 'seed-1');
  const sourceRunDir =
    kind === 'grumu'
      ? join(base, slug, 'seed-1', 'k2-vp-clip-seed-refit')
      : join(base, slug, 'seed-1');
  const delay = kind === 'bog' ? DELAY_SECONDS : undefined;
  mkdirSync(targets, { recursive: true });
  mkdirSync(originalRunDir, { recursive: true });
  mkdirSync(join(root, 'onset'), { recursive: true });
  const sourcePatch = tone(0.2, delay, localized ? 0.001 : undefined);
  const targetPatch = tone(0.4, delay);
  const source = await writeSource(sourceRunDir, sourcePatch);
  const targetPath = join(targets, 'target.wav');
  writeWav({
    samples: canonicalSamples(targetPatch),
    sampleRate: SAMPLE_RATE,
    filePath: targetPath,
  });
  await writeJsonAtomic(join(dataset, 'manifest.json'), {
    targetsDir: targets,
    phaseModel: 'integral',
    attackBoost,
  });
  await writeJsonAtomic(join(originalRunDir, 'run.json'), {
    status: 'completed',
    target: 'target.wav',
  });
  if (kind === 'grumu') {
    await writeJsonAtomic(join(base, 'report.json'), {
      dataset,
      runs: [
        {
          slug,
          seed: 1,
          sourceRunDir: originalRunDir,
          k2VpClipSeedRefit: source,
        },
      ],
    });
  } else {
    const onsetReport = join(root, 'onset', 'report.json');
    await writeJsonAtomic(onsetReport, {
      dataset,
      runs: [{ slug, seed: 1, sourceRunDir: originalRunDir }],
    });
    await writeJsonAtomic(join(base, 'report.json'), {
      sourceReport: onsetReport,
      runs: [{ slug, seed: 1, ...source }],
    });
  }
  return {
    kind,
    base,
    dataset,
    originalRunDir,
    sourceRunDir,
    sourcePatch,
    targetPath,
    slug,
  };
}

async function createMatchFixture(
  root: string,
  attackBoost = 3,
  localized = false,
  matchDelay: number | null = DELAY_SECONDS,
): Promise<Fixture> {
  const base = join(root, 'match');
  const slug = 'water_15_kick';
  const sourceRunDir = join(base, slug, 'seed-1');
  const targets = join(root, 'match-targets');
  const delay = matchDelay ?? undefined;
  const sourcePatch = tone(0.2, delay, localized ? 0.001 : undefined);
  const targetPatch = tone(0.4, delay);
  await writeSource(sourceRunDir, sourcePatch);
  mkdirSync(targets, { recursive: true });
  const targetPath = join(targets, 'target.wav');
  writeWav({
    samples: canonicalSamples(targetPatch),
    sampleRate: SAMPLE_RATE,
    filePath: targetPath,
  });
  await writeJsonAtomic(join(base, 'manifest.json'), {
    targetsDir: targets,
    phaseModel: 'integral',
    attackBoost,
  });
  await writeJsonAtomic(join(sourceRunDir, 'run.json'), {
    status: 'completed',
    target: 'target.wav',
  });
  return {
    kind: 'match',
    base,
    dataset: base,
    originalRunDir: sourceRunDir,
    sourceRunDir,
    sourcePatch,
    targetPath,
    slug,
  };
}

function options(
  fixture: Fixture,
  mode: 'vp' | 'no-op' = 'vp',
  seeds = [1],
): FullPatchVpCliOptions {
  return {
    dataset: fixture.kind,
    grumuBase: fixture.kind === 'grumu' ? fixture.base : '/unused',
    bogBase: fixture.kind === 'bog' ? fixture.base : '/unused',
    matchBase: fixture.kind === 'match' ? fixture.base : '/unused',
    matchSlug: fixture.kind === 'match' ? fixture.slug : '',
    outDir: join(fixture.base, 'out'),
    seeds,
    maxOuter: 0,
    maxInner: 2,
    maxBacktracks: 1,
    mode,
  };
}

async function withFixture(
  t: TestContext,
  kind: 'grumu' | 'bog' | 'match',
  action: (fixture: Fixture) => Promise<void>,
  localized = false,
): Promise<void> {
  const root = mkdtempSync(
    join('/tmp/opencode', `full-patch-${kind}-`),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture =
    kind === 'match'
      ? await createMatchFixture(root, 3, localized)
      : await createFixture(root, kind, 3, localized);
  await action(fixture);
}

test('verified GrumU source writes canonical VP, no-op, control and atomic checkpoints', async (t) => {
  await withFixture(t, 'grumu', async (fixture) => {
    const report = await runFullPatchVpScreening(options(fixture));
    assert.equal(report.errors.length, 0);
    assert.equal(report.runs.length, 1);
    const run = report.runs[0];
    assert.ok(run !== undefined);
    assert.notEqual(run.sourceRunDir, run.originalMatchRunDir);
    assert.equal(run.targetWavPath, fixture.targetPath);
    assert.equal(run.q4Verdict, 'not-evaluated');
    assert.ok(run.vp !== null);
    assert.ok(run.vp.proposed !== null);
    assert.equal(run.vp.guards.savedCanonical, true);
    assert.equal(run.vp.guards.immutable, true);
    assert.ok(run.vp.workBudget > 0);
    assert.ok(run.control !== null);
    assert.equal(run.control.status, 'completed');
    assert.ok(run.control.sampleWork.total <= run.vp.workBudget);
    assert.equal(run.noOp.metrics.globalDelta, 0);
    assert.equal(run.noOp.metrics.residualRmsReductionPercent, 0);
    assert.equal(run.vp.bands.length, 28);
    assert.ok('bodyF0DeltaCents' in run.vp.character);
    const history = await readJsonOrNull<unknown[]>(run.vp.history);
    assert.ok(Array.isArray(history));
    const checkpoint = await readJsonOrNull<{ status: string }>(
      run.vp.checkpoint,
    );
    assert.equal(checkpoint?.status, 'completed');
    assert.equal(existsSync(`${run.vp.checkpoint}.tmp`), false);
    const globalCheckpoint = await readJsonOrNull<{
      finished: boolean;
    }>(join(fixture.base, 'out', 'checkpoint.json'));
    assert.equal(globalCheckpoint?.finished, true);
    assert.equal(
      existsSync(join(fixture.base, 'out', 'report.json.tmp')),
      false,
    );
    const savedPatch = await readJsonOrNull<ArgCreateSynth>(
      run.vp.patch,
    );
    assert.ok(savedPatch !== null);
    assert.deepEqual(
      readWav(run.vp.wav).samples,
      canonicalSamples(savedPatch),
    );
    assert.equal(report.summaries[0]?.warningsNotHidden, true);
    assert.equal(report.summaries[0]?.gatePass, false);
  });
});

test('outer LM integration remeasures solver metrics and shares six-N work parity', async (t) => {
  await withFixture(t, 'grumu', async (fixture) => {
    const runOptions = options(fixture);
    runOptions.maxOuter = 1;
    const report = await runFullPatchVpScreening(runOptions, {
      runVp: (input: FullPatchRunInput) => {
        const result = runFullPatchVariableProjection(input);
        result.metrics.globalSuppressionPercent = -777;
        if (result.proposed !== null) {
          result.proposed.metrics.globalSuppressionPercent = -777;
        }
        return result;
      },
      runCd: coordinateDescent,
    });
    assert.equal(report.errors.length, 0);
    const run = report.runs[0];
    assert.ok(run !== undefined);
    assert.ok(run.vp !== null);
    assert.ok(run.control !== null);
    assert.ok(run.vp.outerIterations > 0);
    assert.ok(run.vp.cost.outerAttempts > 0);
    assert.notEqual(run.vp.saved.globalSuppressionPercent, -777);
    assert.notEqual(run.vp.proposed?.globalSuppressionPercent, -777);

    const target = Array.from(readWav(fixture.targetPath).samples);
    const expected = await withAttackBoost(3, () =>
      measureMetrics(
        readWav(run.vp?.wav ?? '').samples,
        target,
        SAMPLE_RATE,
        computeUsefulZone(target, SAMPLE_RATE),
      ),
    );
    assert.equal(
      run.vp.saved.globalSuppressionPercent,
      expected.globalSuppressionPercent,
    );
    assert.equal(
      run.vp.saved.windowedSuppressionPercent,
      expected.windowedSuppressionPercent,
    );
    const audit = await readJsonOrNull<{
      solverMetrics: {
        saved: { globalSuppressionPercent: number };
      };
      canonicalFinalizationSamplePasses: number;
    }>(run.vp.audit);
    assert.equal(
      audit?.solverMetrics.saved.globalSuppressionPercent,
      -777,
    );
    assert.equal(audit?.canonicalFinalizationSamplePasses, 6);

    const canonicalWork = 6 * SAMPLE_COUNT;
    assert.equal(run.control.canonicalGuardWork, canonicalWork);
    assert.equal(
      run.control.internalWorkBudget,
      run.vp.workBudget - canonicalWork,
    );
    assert.ok(run.control.sampleWork.total <= run.vp.workBudget);
    assert.equal(
      run.control.unusedWork,
      run.vp.workBudget - run.control.sampleWork.total,
    );
    assert.ok(run.control.unusedWork >= 0);
    const controlHistory = await readJsonOrNull<
      { finalStagesSkipped?: boolean }[]
    >(run.control.history ?? '');
    assert.equal(
      run.control.finalStagesSkipped,
      controlHistory?.[controlHistory.length - 1]
        ?.finalStagesSkipped === true,
    );
  });
});

test('BOg control uses fixedDelaySeconds and preserves optional delay fields', async (t) => {
  await withFixture(t, 'bog', async (fixture) => {
    const report = await runFullPatchVpScreening(options(fixture));
    assert.equal(report.errors.length, 0);
    const run = report.runs[0];
    assert.ok(run !== undefined);
    assert.ok(run.vp !== null);
    assert.ok(run.control !== null);
    assert.equal(run.control.status, 'completed');
    assert.deepEqual(run.control.fixedDelaySeconds, [DELAY_SECONDS]);
    assert.ok(run.control.sampleWork.total <= run.vp.workBudget);
    assert.ok(Number.isInteger(run.control.iterationsCompleted));
    const controlPatch = await readJsonOrNull<ArgCreateSynth>(
      run.control.patch,
    );
    assert.ok(controlPatch !== null);
    assert.equal(controlPatch.oscillators.length, 1);
    assert.equal(
      controlPatch.oscillators[0]?.osc.delay,
      DELAY_SECONDS,
    );
    assert.deepEqual(
      readWav(run.control.wav).samples,
      canonicalSamples(controlPatch),
    );
    const checkpoint = await readJsonOrNull<{
      fixedDelaySeconds: number[];
      sampleWork: { total: number };
    }>(run.control.checkpoint);
    assert.deepEqual(checkpoint?.fixedDelaySeconds, [DELAY_SECONDS]);
    assert.ok(
      (checkpoint?.sampleWork.total ?? Infinity) <= run.vp.workBudget,
    );
  });
});

test('direct match reads canonical source, manifest target and fixed-delay control without reports', async (t) => {
  await withFixture(t, 'match', async (fixture) => {
    const report = await runFullPatchVpScreening(options(fixture));
    assert.equal(report.errors.length, 0);
    assert.equal(report.skips.length, 0);
    assert.equal(
      existsSync(join(fixture.base, 'report.json')),
      false,
    );
    const run = report.runs[0];
    assert.ok(run !== undefined);
    assert.equal(run.datasetKind, 'match');
    assert.equal(run.slug, 'water_15_kick');
    assert.equal(run.sourceRunDir, fixture.sourceRunDir);
    assert.equal(run.originalMatchRunDir, fixture.sourceRunDir);
    assert.equal(run.targetWavPath, fixture.targetPath);
    assert.equal(report.summaries[0]?.slug, fixture.slug);

    assert.deepEqual(
      await readJsonOrNull<ArgCreateSynth>(run.noOp.patch),
      fixture.sourcePatch,
    );
    assert.deepEqual(
      readWav(run.noOp.wav).samples,
      readWav(join(fixture.sourceRunDir, 'result.wav')).samples,
    );
    assert.ok(run.vp !== null);
    const vpPatch = await readJsonOrNull<ArgCreateSynth>(
      run.vp.patch,
    );
    assert.ok(vpPatch !== null);
    assert.deepEqual(
      readWav(run.vp.wav).samples,
      canonicalSamples(vpPatch),
    );

    assert.ok(run.control !== null);
    assert.equal(run.control.status, 'completed');
    assert.deepEqual(run.control.fixedDelaySeconds, [DELAY_SECONDS]);
    const controlPatch = await readJsonOrNull<ArgCreateSynth>(
      run.control.patch,
    );
    assert.ok(controlPatch !== null);
    assert.equal(
      controlPatch.oscillators[0]?.osc.delay,
      DELAY_SECONDS,
    );
    assert.deepEqual(
      readWav(run.control.wav).samples,
      canonicalSamples(controlPatch),
    );
    const controlAudit = await readJsonOrNull<{
      representation: string;
      fixedDelaySeconds: number[];
    }>(run.control.audit);
    assert.equal(
      controlAudit?.representation,
      'vector+fixedDelaySeconds',
    );
    assert.deepEqual(controlAudit?.fixedDelaySeconds, [
      DELAY_SECONDS,
    ]);
  });
});

test('direct match control does not materialize delay zero after mapping and restore', async (t) => {
  const root = mkdtempSync(
    join('/tmp/opencode', 'full-patch-match-no-delay-'),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = await createMatchFixture(root, 3, false, null);
  const sourceOsc = fixture.sourcePatch.oscillators[0]?.osc;
  assert.ok(sourceOsc !== undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(sourceOsc, 'delay'),
    false,
  );

  const runOptions = options(fixture);
  runOptions.maxOuter = 1;
  const report = await runFullPatchVpScreening(runOptions);
  assert.equal(report.errors.length, 0);
  const control = report.runs[0]?.control;
  assert.ok(control !== null && control !== undefined);
  assert.equal(control.status, 'completed');
  assert.deepEqual(control.fixedDelaySeconds, [0]);
  const controlHistory = await readJsonOrNull<unknown[]>(
    control.history ?? '',
  );
  assert.ok((controlHistory?.length ?? 0) > 0);

  const controlPatch = await readJsonOrNull<ArgCreateSynth>(
    control.patch,
  );
  const controlOsc = controlPatch?.oscillators[0]?.osc;
  assert.ok(controlOsc !== undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(controlOsc, 'delay'),
    false,
  );
  assert.equal(controlOsc.delay, undefined);
  assert.ok(controlPatch !== null);
  assert.deepEqual(
    readWav(control.wav).samples,
    canonicalSamples(controlPatch),
  );
});

test('localized BOg source gets explicit skip-control without deleting fields', async (t) => {
  await withFixture(
    t,
    'bog',
    async (fixture) => {
      const report = await runFullPatchVpScreening(options(fixture));
      assert.equal(report.errors.length, 0);
      const control = report.runs[0]?.control;
      assert.ok(control !== null && control !== undefined);
      assert.equal(control.status, 'skip-control');
      assert.match(control.skipReason ?? '', /Localized amplitude/);
      const saved = await readJsonOrNull<ArgCreateSynth>(
        control.patch,
      );
      assert.equal(saved?.oscillators[0]?.ampEnv.attack, 0.001);
      assert.equal(saved?.oscillators[0]?.osc.delay, DELAY_SECONDS);
      assert.ok(
        report.warnings.some((warning) =>
          warning.includes('skip-control'),
        ),
      );
    },
    true,
  );
});

test('localized direct match skips control and preserves delay and attack', async (t) => {
  await withFixture(
    t,
    'match',
    async (fixture) => {
      const report = await runFullPatchVpScreening(options(fixture));
      assert.equal(report.errors.length, 0);
      const control = report.runs[0]?.control;
      assert.ok(control !== null && control !== undefined);
      assert.equal(control.status, 'skip-control');
      assert.match(control.skipReason ?? '', /Localized amplitude/);
      assert.deepEqual(control.fixedDelaySeconds, [DELAY_SECONDS]);
      assert.deepEqual(
        await readJsonOrNull<ArgCreateSynth>(control.patch),
        fixture.sourcePatch,
      );
      assert.deepEqual(
        readWav(control.wav).samples,
        readWav(join(fixture.sourceRunDir, 'result.wav')).samples,
      );
    },
    true,
  );
});

test('missing direct match run gets the regular source-not-completed skip', async (t) => {
  await withFixture(t, 'match', async (fixture) => {
    rmSync(join(fixture.sourceRunDir, 'run.json'));
    const report = await runFullPatchVpScreening(
      options(fixture, 'no-op'),
      {
        runVp: () => {
          throw new Error('VP must not run');
        },
        runCd: () => {
          throw new Error('CD must not run');
        },
      },
    );
    assert.equal(report.errors.length, 0);
    assert.equal(report.runs.length, 0);
    assert.equal(report.skips.length, 1);
    assert.equal(report.skips[0]?.reason, 'source-not-completed');
    assert.equal(report.skips[0]?.slug, fixture.slug);
    assert.equal(report.skips[0]?.detail, fixture.sourceRunDir);
  });
});

test('direct match rejects a non-canonical source WAV before no-op', async (t) => {
  await withFixture(t, 'match', async (fixture) => {
    writeWav({
      samples: canonicalSamples(tone(0.3, DELAY_SECONDS)),
      sampleRate: SAMPLE_RATE,
      filePath: join(fixture.sourceRunDir, 'result.wav'),
    });
    const report = await runFullPatchVpScreening(
      options(fixture, 'no-op'),
    );
    assert.equal(report.runs.length, 0);
    assert.equal(report.skips.length, 0);
    assert.equal(report.errors.length, 1);
    assert.match(
      report.errors[0]?.message ?? '',
      /patch\.json не совпадает с result\.wav/,
    );
  });
});

test('separate no-op mode verifies source and never calls VP or CD', async (t) => {
  await withFixture(t, 'grumu', async (fixture) => {
    const report = await runFullPatchVpScreening(
      options(fixture, 'no-op'),
      {
        runVp: () => {
          throw new Error('VP must not run');
        },
        runCd: () => {
          throw new Error('CD must not run');
        },
      },
    );
    assert.equal(report.errors.length, 0);
    const run = report.runs[0];
    assert.ok(run !== undefined);
    assert.equal(run.vp, null);
    assert.equal(run.control, null);
    assert.equal(run.noOp.sampleWork, 0);
    assert.deepEqual(
      await readJsonOrNull<ArgCreateSynth>(run.noOp.patch),
      fixture.sourcePatch,
    );
    assert.equal(report.summaries[0]?.gatePass, false);
  });
});

test('corrupt original run is an error, not an eligibility skip', async (t) => {
  await withFixture(t, 'grumu', async (fixture) => {
    writeFileSync(
      join(fixture.originalRunDir, 'run.json'),
      '{broken',
    );
    const report = await runFullPatchVpScreening(
      options(fixture, 'no-op'),
    );
    assert.equal(report.runs.length, 0);
    assert.equal(report.skips.length, 0);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0]?.message ?? '', /Битый JSON/);
    assert.equal(report.finished, true);
  });
});

test('absent requested seed is the only source-level skip and does no work', async (t) => {
  await withFixture(t, 'grumu', async (fixture) => {
    const report = await runFullPatchVpScreening(
      options(fixture, 'vp', [2]),
      {
        runVp: () => {
          throw new Error('VP must not run');
        },
        runCd: () => {
          throw new Error('CD must not run');
        },
      },
    );
    assert.equal(report.errors.length, 0);
    assert.equal(report.runs.length, 0);
    assert.equal(report.skips[0]?.reason, 'source-run-absent');
  });
});

test('manifest attackBoost applies to baseline and restores after solver failure', async (t) => {
  await withFixture(t, 'grumu', async (fixture) => {
    const previous = attackWeighting.boost;
    t.after(() => {
      attackWeighting.boost = previous;
    });
    attackWeighting.boost = 7;
    const report = await runFullPatchVpScreening(options(fixture), {
      runVp: (_input: FullPatchRunInput) => {
        throw new Error('synthetic solver failure');
      },
      runCd: coordinateDescent,
    });
    assert.equal(attackWeighting.boost, 7);
    attackWeighting.boost = previous;
    assert.equal(report.errors.length, 1);
    const audit = await readJsonOrNull<{
      metrics: { windowedSuppressionPercent: number };
    }>(
      join(
        fixture.base,
        'out',
        fixture.slug,
        'seed-1',
        'no-op',
        'audit.json',
      ),
    );
    const sourceSamples = readWav(
      join(fixture.sourceRunDir, 'result.wav'),
    ).samples;
    const target = Array.from(readWav(fixture.targetPath).samples);
    const expected = await withAttackBoost(3, () =>
      evaluateSuppressionWindowed(
        Array.from(sourceSamples),
        target,
        SAMPLE_RATE,
      ),
    );
    assert.equal(audit?.metrics.windowedSuppressionPercent, expected);
    assert.equal(attackWeighting.boost, previous);
  });
});

test('runner rejects a solver that mutates an immutable delay', async (t) => {
  await withFixture(t, 'bog', async (fixture) => {
    const report = await runFullPatchVpScreening(options(fixture), {
      runVp: (input: FullPatchRunInput) => {
        const result = runFullPatchVariableProjection(input);
        const group = result.patch.oscillators[0];
        assert.ok(group !== undefined);
        group.osc.delay = DELAY_SECONDS / 2;
        return result;
      },
      runCd: coordinateDescent,
    });
    assert.equal(report.errors.length, 1);
    assert.match(
      report.errors[0]?.message ?? '',
      /immutable vp fields/,
    );
  });
});

function gateRun(
  seed: number,
  globalDelta: number,
  residualReduction: number,
  warning = `warning-${seed}`,
): FullPatchVpSeedReport {
  return {
    datasetKind: 'grumu',
    slug: 'GrumU',
    seed,
    warnings: [warning],
    vp: {
      status: globalDelta > 0 ? 'refined' : 'unchanged',
      saved: {
        globalDelta,
        residualRmsReductionPercent: residualReduction,
      },
      guards: {
        sourceCanonical: true,
        savedCanonical: true,
        globalJ: true,
        immutable: true,
        withinWorkBudget: true,
      },
    },
  } as unknown as FullPatchVpSeedReport;
}

test('fixed gate uses 3/4, +4.6pp, 25% residual and visible warnings', () => {
  const runs = [
    gateRun(1, 6.2, 30),
    gateRun(2, 6.2, 30),
    gateRun(3, 6.2, 30),
    gateRun(4, 0, 10),
  ];
  const warnings = runs.flatMap((run) =>
    run.warnings.map(
      (warning) => `grumu/GrumU/seed-${run.seed}: ${warning}`,
    ),
  );
  const summary = summarizeFullPatchVpTarget(
    'grumu',
    'GrumU',
    runs,
    warnings,
  );
  assert.equal(summary.improved, 3);
  assert.equal(summary.meanSavedGlobalDelta, 4.65);
  assert.equal(summary.meanResidualRmsReductionPercent, 25);
  assert.equal(summary.gatePass, true);

  const hidden = summarizeFullPatchVpTarget(
    'grumu',
    'GrumU',
    runs,
    [],
  );
  assert.equal(hidden.warningsNotHidden, false);
  assert.equal(hidden.gatePass, false);
  const weaker = [...runs];
  weaker[2] = gateRun(3, 6, 20);
  assert.equal(
    summarizeFullPatchVpTarget('grumu', 'GrumU', weaker, warnings)
      .gatePass,
    false,
  );
});

test('CLI direct match requires base and slug and rejects ambiguous bases', () => {
  const parsed = parseFullPatchVpRunArgs([
    '--dataset',
    'match',
    '--match-base',
    '/tmp/opencode/match',
    '--match-slug',
    'water_15_kick',
    '--out',
    '/tmp/opencode/match-out',
    '--seeds',
    '1,2,3,4',
    '--max-outer',
    '4',
    '--max-inner',
    '12',
    '--max-backtracks',
    '16',
  ]);
  assert.equal(parsed.dataset, 'match');
  assert.equal(parsed.matchBase, '/tmp/opencode/match');
  assert.equal(parsed.matchSlug, 'water_15_kick');
  assert.equal(parsed.maxOuter, 4);
  assert.deepEqual(parsed.seeds, [1, 2, 3, 4]);
  assert.throws(
    () =>
      parseFullPatchVpRunArgs([
        '--dataset',
        'match',
        '--match-slug',
        'water_15_kick',
        '--out',
        '/tmp/opencode/match-out',
      ]),
    /match-base/,
  );
  assert.throws(
    () =>
      parseFullPatchVpRunArgs([
        '--dataset',
        'match',
        '--match-base',
        '/tmp/opencode/match',
        '--out',
        '/tmp/opencode/match-out',
      ]),
    /match-slug/,
  );
  assert.throws(
    () =>
      parseFullPatchVpRunArgs([
        '--dataset',
        'match',
        '--match-base',
        '/tmp/opencode/match',
        '--match-slug',
        'water_15_kick',
        '--grumu-base',
        '/tmp/opencode/grumu',
        '--out',
        '/tmp/opencode/match-out',
      ]),
    /grumu-base.*не используется/,
  );
  const all = parseFullPatchVpRunArgs([
    '--dataset',
    'all',
    '--grumu-base',
    '/tmp/opencode/grumu',
    '--bog-base',
    '/tmp/opencode/bog',
    '--out',
    '/tmp/opencode/all-out',
  ]);
  assert.equal(all.dataset, 'all');
  assert.equal(all.matchBase, '');
  assert.equal(all.matchSlug, '');
});

test('CLI rejects unsafe match slugs and source/output collisions', () => {
  const parseMatch = (
    slug: string,
    outDir: string,
  ): FullPatchVpCliOptions =>
    parseFullPatchVpRunArgs([
      '--dataset',
      'match',
      '--match-base',
      '/tmp/opencode/match-source',
      '--match-slug',
      slug,
      '--out',
      outDir,
    ]);
  for (const slug of [
    '',
    '.',
    '..',
    '/tmp/water',
    'water/15',
    'water\\15',
    'C:\\water',
  ]) {
    assert.throws(
      () => parseMatch(slug, '/tmp/opencode/match-output'),
      /match-slug/,
    );
  }
  assert.throws(
    () => parseMatch('water_15_kick', '/tmp/opencode/match-source'),
    /out.*match-base/,
  );
  assert.throws(
    () =>
      parseFullPatchVpRunArgs([
        '--dataset',
        'grumu',
        '--grumu-base',
        '/tmp/opencode/grumu-source',
        '--out',
        '/tmp/opencode/grumu-source',
      ]),
    /out.*grumu-base/,
  );
  assert.throws(
    () =>
      parseFullPatchVpRunArgs([
        '--dataset',
        'bog',
        '--bog-base',
        '/tmp/opencode/bog-source',
        '--out',
        '/tmp/opencode/bog-source',
      ]),
    /out.*bog-base/,
  );

  const relative = parseFullPatchVpRunArgs([
    '--dataset',
    'match',
    '--match-base',
    'tmp/match-source',
    '--match-slug',
    'water_15.kick',
    '--out',
    'tmp/match-output',
  ]);
  assert.equal(relative.matchBase, resolve('tmp/match-source'));
  assert.equal(relative.outDir, resolve('tmp/match-output'));
  assert.equal(relative.matchSlug, 'water_15.kick');
});

test('CLI requires explicit dataset bases and validates budgets', () => {
  const parsed = parseFullPatchVpRunArgs([
    '--dataset',
    'bog',
    '--bog-base',
    '/tmp/opencode/bog',
    '--out',
    '/tmp/opencode/out',
    '--seeds',
    '1,2,3,4',
    '--max-outer',
    '24',
    '--max-inner',
    '12',
    '--max-backtracks',
    '16',
  ]);
  assert.deepEqual(parsed.seeds, [1, 2, 3, 4]);
  assert.equal(parsed.mode, 'vp');
  assert.throws(
    () =>
      parseFullPatchVpRunArgs([
        '--dataset',
        'grumu',
        '--out',
        '/tmp/opencode/out',
      ]),
    /grumu-base/,
  );
  assert.throws(
    () =>
      parseFullPatchVpRunArgs([
        '--dataset',
        'bog',
        '--bog-base',
        '/tmp/opencode/bog',
        '--out',
        '/tmp/opencode/out',
        '--max-inner',
        '0',
      ]),
    /max-inner/,
  );
});
