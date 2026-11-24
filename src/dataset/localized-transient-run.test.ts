import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { SAMPLE_RATE } from '../consts';
import { attackWeighting } from '../optimize/evaluate';
import { readWav } from '../read-wav';
import type { ArgCreateSynth } from '../synth';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  groupFromLocalizedAtom,
  type LocalizedAtomDescription,
} from './localized-transient';
import {
  localizedCharacterWarnings,
  parseLocalizedTransientArgs,
  runLocalizedTransientScreening,
} from './localized-transient-run';
import { renderForTarget } from './quadrature-refit';
import { readJsonOrNull } from './shared';

function exactPatch(): ArgCreateSynth {
  const supportSamples = 221;
  const shape: LocalizedAtomDescription = {
    frequency: 6000,
    freqStart: 9000,
    duration: supportSamples / SAMPLE_RATE,
    slope: 2,
    oscDuration: 0.01,
    oscSlope: 1,
    window: 'attack',
    localGain: 0,
    peakMagnitude: 1,
    sweepTemplateIndex: null,
    delaySamples: 220,
    attackSamples: 22,
    supportSamples,
    cellRegion: 'attack',
  };
  return {
    oscillators: [
      groupFromLocalizedAtom(shape, {
        sineCoefficient: 0.2,
        cosineCoefficient: 0.1,
        startLevel: Math.hypot(0.2, 0.1),
        phase: Math.atan2(0.1, 0.2),
      }),
    ],
  };
}

test('CLI fixes A+B2 input, seeds and rejects ambiguous lists', () => {
  const parsed = parseLocalizedTransientArgs([
    '--dataset',
    'datasets/reference-integral',
    '--base',
    'datasets/block-pursuit-ab-blocks2-grumu',
    '--out',
    'datasets/localized-test',
  ]);
  assert.deepEqual(parsed.seeds, [1, 2, 3, 4]);
  assert.throws(
    () =>
      parseLocalizedTransientArgs([
        '--dataset',
        'd',
        '--base',
        'b',
        '--out',
        'o',
        '--seeds',
        '1,1',
      ]),
    /уникальные/,
  );
});

test('character diagnostics warn about low/f0/decay without claiming Q4', () => {
  const warnings = localizedCharacterWarnings({
    baselineCharacter: {
      bodyF0DeltaCents: 1,
      decayDb20DeltaSec: 0.01,
    },
    character: {
      bodyF0DeltaCents: -2,
      decayDb20DeltaSec: 0.02,
    },
    baselineBands: [
      {
        region: 'attack',
        name: 'low',
        minHz: 60,
        maxHz: 100,
        energy: 1,
        referenceEnergy: 2,
        candidateEnergy: 2.5,
        deltaDb: 1,
      },
    ],
    bands: [
      {
        region: 'attack',
        name: 'low',
        minHz: 60,
        maxHz: 100,
        energy: 1,
        referenceEnergy: 2,
        candidateEnergy: 1.5,
        deltaDb: -2,
      },
    ],
  });
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((warning) => warning.startsWith('WARN:')));
});

test('runner saves exact A+B2 fallback and verifies canonical JSON/WAV round-trip', async () => {
  const root = await mkdtemp(
    join('/tmp/opencode', 'localized-transient-run-'),
  );
  const previousBoost = attackWeighting.boost;
  try {
    const dataset = join(root, 'reference-integral');
    const base = join(root, 'block-pursuit-ab-blocks2-grumu');
    const outDir = join(root, 'out');
    const targetsDir = join(root, 'targets');
    const originalRun = join(dataset, 'GrumU', 'seed-1');
    const baseRun = join(
      base,
      'GrumU',
      'seed-1',
      'k2-vp-clip-seed-refit',
    );
    await mkdir(targetsDir, { recursive: true });
    await mkdir(originalRun, { recursive: true });
    await mkdir(baseRun, { recursive: true });
    const patch = exactPatch();
    const samples = renderForTarget(patch, 4096, 'integral');
    await writeFile(
      join(dataset, 'manifest.json'),
      JSON.stringify({
        targetsDir,
        phaseModel: 'integral',
        attackBoost: 3,
      }),
    );
    await writeFile(
      join(originalRun, 'run.json'),
      JSON.stringify({
        status: 'completed',
        target: 'target.wav',
        globalSuppressionPercent: 91,
      }),
    );
    await writeFile(
      join(baseRun, 'patch.json'),
      JSON.stringify(patch),
    );
    writeWav({
      samples,
      sampleRate: SAMPLE_RATE,
      filePath: join(targetsDir, 'target.wav'),
    });
    writeWav({
      samples,
      sampleRate: SAMPLE_RATE,
      filePath: join(baseRun, 'result.wav'),
    });
    const report = await runLocalizedTransientScreening({
      dataset,
      base,
      outDir,
      seeds: [1],
    });
    assert.equal(report.errors.length, 0);
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0]?.status, 'unchanged');
    assert.equal(report.runs[0]?.savedGlobalDelta, 0);
    assert.equal(report.continuationGate.pass, false);
    assert.equal(report.phaseModel, 'integral');
    assert.equal(report.attackBoost, 3);
    assert.equal(report.q4Pass, null);
    assert.equal(attackWeighting.boost, previousBoost);
    const savedPatch = await readJsonOrNull<ArgCreateSynth>(
      join(outDir, 'GrumU', 'seed-1', 'patch.json'),
    );
    assert.deepEqual(savedPatch, patch);
    const savedWav = readWav(
      join(outDir, 'GrumU', 'seed-1', 'result.wav'),
    );
    assert.deepEqual(savedWav.samples, samples);
    assert.ok(savedPatch);
    assertPatchMatchesWav(
      savedPatch,
      savedWav.samples,
      'integral',
      SAMPLE_RATE,
      samples.length,
    );
    const savedReport = JSON.parse(
      await readFile(join(outDir, 'report.json'), 'utf8'),
    ) as { finished: boolean; hypothesisOnly: boolean };
    assert.equal(savedReport.finished, true);
    assert.equal(savedReport.hypothesisOnly, true);
  } finally {
    attackWeighting.boost = previousBoost;
    await rm(root, { recursive: true, force: true });
  }
});
