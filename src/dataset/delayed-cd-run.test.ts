import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  attackWeighting,
  createWaveForm,
  evaluateSuppressionWindowed,
} from '../optimize/evaluate';
import { readWav } from '../read-wav';
import type { ArgCreateSynth } from '../synth';
import { mapVectorToSynthConfig } from '../vector-to-synth-config';
import { writeWav } from '../write-wav';
import { runDelayedCdScreening } from './delayed-cd-run';
import { withAttackBoost } from './quadrature-refit-run';
import {
  readJsonOrNull,
  renderSamples,
  writeJsonAtomic,
} from './shared';

const SAMPLE_RATE = 44100;
const NUM_SAMPLES = 2048;
const DELAY_SECONDS = 0.01;

function vector(volume: number): number[] {
  return [1, 0.001, 0.002, 0.4, 0.5, 0.25, 0.4, 0.1, 0.5, volume];
}

async function writeSourceRun(arg: {
  directory: string;
  patch: ArgCreateSynth;
  withRecord: boolean;
  auditStatus?: 'refined' | 'unchanged';
}): Promise<void> {
  mkdirSync(arg.directory, { recursive: true });
  await writeJsonAtomic(join(arg.directory, 'patch.json'), arg.patch);
  if (arg.withRecord) {
    await writeJsonAtomic(join(arg.directory, 'run.json'), {
      status: 'completed',
      target: 'target.wav',
    });
  }
  if (arg.auditStatus !== undefined) {
    await writeJsonAtomic(join(arg.directory, 'audit.json'), {
      status: arg.auditStatus,
    });
  }
  writeWav({
    samples: renderSamples(
      arg.patch,
      (NUM_SAMPLES + 0.5) / SAMPLE_RATE,
      { phaseModel: 'integral' },
    ),
    sampleRate: SAMPLE_RATE,
    filePath: join(arg.directory, 'result.wav'),
  });
}

/** Создаёт короткий синтетический source/delayed/target без реальных данных. */
async function createKnownAnswerFixture(
  root: string,
  attackBoost = 1,
): Promise<{
  dataset: string;
  delayed: string;
  outDir: string;
  slug: string;
  targets: string;
  manifest: {
    targetsDir: string;
    phaseModel: 'integral';
    attackBoost: number;
  };
  originalPatch: ArgCreateSynth;
  delayedPatch: ArgCreateSynth;
}> {
  const dataset = join(root, 'reference-integral');
  const delayed = join(root, 'delayed-patches');
  const outDir = join(root, 'out');
  const slug = 'BOg-Disco-Futuro';
  const targets = join(root, 'targets');
  mkdirSync(targets, { recursive: true });
  const originalPatch = mapVectorToSynthConfig(vector(0.2));
  originalPatch.oscillators = originalPatch.oscillators.slice(0, 1);
  const delayedPatch = mapVectorToSynthConfig(vector(0.2), [
    DELAY_SECONDS,
  ]);
  delayedPatch.oscillators = delayedPatch.oscillators.slice(0, 1);
  await writeSourceRun({
    directory: join(dataset, slug, 'seed-1'),
    patch: originalPatch,
    withRecord: true,
  });
  await writeSourceRun({
    directory: join(delayed, slug, 'seed-1'),
    patch: delayedPatch,
    withRecord: false,
    auditStatus: 'refined',
  });
  const target = createWaveForm(
    vector(0.4),
    SAMPLE_RATE,
    NUM_SAMPLES,
    {
      phaseModel: 'integral',
      fixedDelaySeconds: [DELAY_SECONDS],
    },
  );
  writeWav({
    samples: Int16Array.from(target, (sample) => Math.round(sample)),
    sampleRate: SAMPLE_RATE,
    filePath: join(targets, 'target.wav'),
  });
  const manifest = {
    targetsDir: targets,
    phaseModel: 'integral' as const,
    attackBoost,
  };
  await writeJsonAtomic(join(dataset, 'manifest.json'), manifest);
  return {
    dataset,
    delayed,
    outDir,
    slug,
    targets,
    manifest,
    originalPatch,
    delayedPatch,
  };
}

test('known-answer runner preserves onset and writes both paired arms', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'delayed-cd-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { dataset, delayed, outDir, slug, manifest } =
    await createKnownAnswerFixture(root);

  const report = await runDelayedCdScreening(
    {
      dataset,
      delayed,
      outDir,
      iterations: 1,
      seeds: [1],
      slugs: [slug],
    },
    manifest,
  );
  assert.equal(report.errors.length, 0);
  assert.equal(report.runs.length, 1);
  const run = report.runs[0];
  assert.ok(run !== undefined);
  assert.equal(run.iterations, 1);
  assert.equal(run.delayed.fixedDelaySeconds?.[0], DELAY_SECONDS);
  assert.equal(run.original.fixedDelaySeconds, null);
  const finalPatch = await readJsonOrNull<ArgCreateSynth>(
    join(outDir, slug, 'seed-1', 'delayed', 'patch.json'),
  );
  assert.ok(finalPatch !== null);
  assert.equal(finalPatch.oscillators[0]?.osc.delay, DELAY_SECONDS);
  const finalWav = readWav(
    join(outDir, slug, 'seed-1', 'delayed', 'result.wav'),
  );
  assert.equal(finalWav.samples.length, NUM_SAMPLES);
  assert.deepEqual(
    finalWav.samples,
    renderSamples(finalPatch, (NUM_SAMPLES + 0.5) / SAMPLE_RATE, {
      phaseModel: 'integral',
    }),
  );
  const checkpoint = await readJsonOrNull<{
    fixedDelaySeconds: number[] | null;
    bestVector: number[];
  }>(join(outDir, slug, 'seed-1', 'delayed', 'checkpoint.json'));
  assert.deepEqual(checkpoint?.fixedDelaySeconds, [DELAY_SECONDS]);
  assert.equal(checkpoint?.bestVector.length, 10);
  const history = await readJsonOrNull<unknown[]>(
    join(outDir, slug, 'seed-1', 'delayed', 'history.json'),
  );
  assert.ok(Array.isArray(history) && history.length > 0);
  const savedReport = await readJsonOrNull<typeof report>(
    join(outDir, 'report.json'),
  );
  assert.equal(savedReport?.finished, true);
  assert.equal(savedReport?.pairedBudget, true);
});

test('direct runner applies manifest boost to baseline and final J with finally', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'delayed-cd-boost-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { dataset, delayed, outDir, slug, targets, manifest } =
    await createKnownAnswerFixture(root, 3);
  const previousBoost = attackWeighting.boost;
  const report = await runDelayedCdScreening(
    {
      dataset,
      delayed,
      outDir,
      iterations: 1,
      seeds: [1],
      slugs: [slug],
    },
    manifest,
  );
  assert.equal(attackWeighting.boost, previousBoost);
  assert.equal(report.errors.length, 0);
  const run = report.runs[0];
  assert.ok(run !== undefined);
  assert.equal(run.delayed.attackBoost, 3);
  assert.equal(run.original.attackBoost, 3);

  const target = Array.from(
    readWav(join(targets, 'target.wav')).samples,
  );
  const score = (path: string): number =>
    evaluateSuppressionWindowed(
      Array.from(readWav(path).samples),
      target,
      SAMPLE_RATE,
    );
  const expected = await withAttackBoost(3, () => ({
    originalBaseline: score(
      join(dataset, slug, 'seed-1', 'result.wav'),
    ),
    delayedBaseline: score(
      join(delayed, slug, 'seed-1', 'result.wav'),
    ),
    originalFinal: score(run.original.wav),
    delayedFinal: score(run.delayed.wav),
  }));
  assert.equal(
    run.original.baselineWindowedSuppressionPercent,
    expected.originalBaseline,
  );
  assert.equal(
    run.delayed.baselineWindowedSuppressionPercent,
    expected.delayedBaseline,
  );
  assert.equal(
    run.original.windowedSuppressionPercent,
    expected.originalFinal,
  );
  assert.equal(
    run.delayed.windowedSuppressionPercent,
    expected.delayedFinal,
  );
});

test('missing original match is skipped without creating a fake pair', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'delayed-cd-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataset = join(root, 'dataset');
  const delayed = join(root, 'delayed');
  const outDir = join(root, 'out');
  mkdirSync(dataset, { recursive: true });
  const manifest = { targetsDir: join(root, 'targets') };
  await writeJsonAtomic(join(dataset, 'manifest.json'), manifest);
  const report = await runDelayedCdScreening(
    {
      dataset,
      delayed,
      outDir,
      iterations: 1,
      seeds: [1],
      slugs: ['BOg-Disco-Futuro'],
    },
    manifest,
  );
  assert.equal(report.runs.length, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.skips.length, 1);
  assert.equal(report.skips[0]?.reason, 'source not completed');
  assert.equal(report.finished, true);
  const saved = await readJsonOrNull<typeof report>(
    join(outDir, 'report.json'),
  );
  assert.deepEqual(saved?.skips, report.skips);
  assert.match(
    readFileSync(join(outDir, 'report.md'), 'utf8'),
    /Пропущенные пары/,
  );
});

test('missing candidate and unchanged without onset are saved as skips', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'delayed-cd-skips-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = await createKnownAnswerFixture(root);
  const { dataset, delayed, outDir, slug, manifest, originalPatch } =
    fixture;
  rmSync(join(delayed, slug, 'seed-1'), {
    recursive: true,
    force: true,
  });
  await writeSourceRun({
    directory: join(dataset, slug, 'seed-2'),
    patch: originalPatch,
    withRecord: true,
  });
  await writeSourceRun({
    directory: join(delayed, slug, 'seed-2'),
    patch: originalPatch,
    withRecord: false,
    auditStatus: 'unchanged',
  });

  const report = await runDelayedCdScreening(
    {
      dataset,
      delayed,
      outDir,
      iterations: 1,
      seeds: [1, 2],
      slugs: [slug],
    },
    manifest,
  );
  assert.equal(report.runs.length, 0);
  assert.equal(report.errors.length, 0);
  assert.deepEqual(
    report.skips.map((skip) => ({
      seed: skip.seed,
      reason: skip.reason,
      detail: skip.detail,
    })),
    [
      {
        seed: 1,
        reason: 'no eligible delayed pair',
        detail: 'delayed candidate отсутствует',
      },
      {
        seed: 2,
        reason: 'no eligible delayed pair',
        detail: 'canonical unchanged без onset',
      },
    ],
  );
  const saved = await readJsonOrNull<typeof report>(
    join(outDir, 'report.json'),
  );
  assert.deepEqual(saved?.skips, report.skips);
  const markdown = readFileSync(join(outDir, 'report.md'), 'utf8');
  assert.match(markdown, /no eligible delayed pair/);
  assert.match(markdown, /canonical unchanged без onset/);
});

test('refined source without onset or with mismatched WAV remains an error', async (t) => {
  const root = mkdtempSync(
    join(tmpdir(), 'delayed-cd-refined-errors-'),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const {
    dataset,
    delayed,
    outDir,
    slug,
    manifest,
    originalPatch,
    delayedPatch,
  } = await createKnownAnswerFixture(root, 3);
  const previousBoost = attackWeighting.boost;
  await writeJsonAtomic(
    join(delayed, slug, 'seed-1', 'patch.json'),
    originalPatch,
  );
  await writeSourceRun({
    directory: join(dataset, slug, 'seed-2'),
    patch: originalPatch,
    withRecord: true,
  });
  await writeSourceRun({
    directory: join(delayed, slug, 'seed-2'),
    patch: delayedPatch,
    withRecord: false,
    auditStatus: 'refined',
  });
  writeWav({
    samples: renderSamples(
      originalPatch,
      (NUM_SAMPLES + 0.5) / SAMPLE_RATE,
      { phaseModel: 'integral' },
    ),
    sampleRate: SAMPLE_RATE,
    filePath: join(delayed, slug, 'seed-2', 'result.wav'),
  });

  const report = await runDelayedCdScreening(
    {
      dataset,
      delayed,
      outDir,
      iterations: 1,
      seeds: [1, 2],
      slugs: [slug],
    },
    manifest,
  );
  assert.equal(attackWeighting.boost, previousBoost);
  assert.equal(report.runs.length, 0);
  assert.equal(report.skips.length, 0);
  assert.equal(report.errors.length, 2);
  assert.match(report.errors[0]?.message ?? '', /потерял onset/);
  assert.match(
    report.errors[1]?.message ?? '',
    /patch\.json не совпадает с result\.wav/,
  );
  const secondFailure = await readJsonOrNull<{ status: string }>(
    join(outDir, slug, 'seed-2', 'run.json'),
  );
  assert.equal(secondFailure?.status, 'failed');
});
