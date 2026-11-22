import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWaveForm } from '../optimize/evaluate';
import { writeWav } from '../write-wav';
import { readWav } from '../read-wav';
import { enhanceWavWithJob } from '../api/services/synth-service';
import {
  deleteJob,
  getJob,
  getResultFilePath,
} from '../api/services/job-store';
import { SAMPLE_RATE } from '../consts';

test('enhance service completes C4 and stores both patches and WAVs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'synth-c4-service-'));
  const targetPath = join(dir, 'target.wav');
  const vector = [
    1, 0.001, 0.002, 0.4, 0.5, 0.25, 0.4, 0.1, 0.5, 0.2,
  ];
  writeWav({
    samples: Int16Array.from(
      createWaveForm(vector, SAMPLE_RATE, 4096, {
        phaseModel: 'integral',
      }),
      (sample) => Math.round(sample),
    ),
    sampleRate: SAMPLE_RATE,
    filePath: targetPath,
  });

  const previousPriors = process.env.ENHANCE_PRIORS_PATH;
  process.env.ENHANCE_PRIORS_PATH = join(dir, 'missing-priors.json');
  const jobId = await enhanceWavWithJob(
    readFileSync(targetPath),
    2,
    1,
    1,
    'c4-service-test',
    7,
    1,
    'integral',
  );
  t.after(async () => {
    if (previousPriors === undefined) {
      delete process.env.ENHANCE_PRIORS_PATH;
    } else {
      process.env.ENHANCE_PRIORS_PATH = previousPriors;
    }
    await deleteJob(jobId);
    const matchPath = getResultFilePath(jobId).replace(
      /_result\.wav$/,
      '_match.wav',
    );
    await unlink(matchPath).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  let job = await getJob(jobId);
  const deadline = Date.now() + 30000;
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() > deadline) {
      assert.fail('enhance job did not finish within 30 seconds');
    }
    await delay(20);
    job = await getJob(jobId);
  }

  assert.equal(
    job.status,
    'completed',
    job.errorMessage ?? 'Enhance job failed',
  );
  assert.equal(job.params.refineIterations, 1);
  assert.equal(job.params.phaseModel, 'integral');
  assert.ok(job.synthConfig);
  assert.ok(job.matchSynthConfig);
  assert.equal(job.bestVector?.length, 500);
  assert.ok(
    job.enhanceAudit?.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'name' in entry &&
        entry.name === 'c4Refinement',
    ),
  );
  assert.ok(existsSync(getResultFilePath(jobId)));
  const result = readWav(getResultFilePath(jobId));
  assert.equal(result.samples.length, 4096);
  assert.equal(result.sampleRate, SAMPLE_RATE);

  const finalPatch = job.synthConfig;
  const matchPatch = job.matchSynthConfig;
  assert.ok(finalPatch);
  assert.ok(matchPatch);
  for (
    let index = 0;
    index < finalPatch.oscillators.length;
    index++
  ) {
    const finalOsc = finalPatch.oscillators[index];
    const matchOsc = matchPatch.oscillators[index];
    assert.ok(finalOsc);
    assert.ok(matchOsc);
    assert.equal(finalOsc.osc.freqBase, matchOsc.osc.freqBase);
    assert.equal(finalOsc.osc.freqStart, matchOsc.osc.freqStart);
    assert.equal(finalOsc.osc.on, matchOsc.osc.on);
  }
});
