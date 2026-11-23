import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runDelayedCli } from './delayed-patch-run';
import { readJsonOrNull, writeJsonAtomic } from './shared';

test('missing delayed candidate is reported as no-candidate, not an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delayed-no-candidate-'));
  const dataset = join(root, 'dataset');
  const outDir = join(root, 'out');
  mkdirSync(dataset, { recursive: true });
  await writeJsonAtomic(join(dataset, 'manifest.json'), {
    targetsDir: join(root, 'targets'),
  });
  const sourceReport = join(root, 'oracle.json');
  const result = await runDelayedCli({
    sourceReport,
    outDir,
    report: {
      dataset,
      phaseModel: 'integral',
      attackBoost: 1,
      runs: [
        {
          slug: 'empty-target',
          seed: 1,
          sourceRunDir: join(root, 'missing-source'),
          bestExactDelayed: null,
        },
      ],
    },
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.runs.length, 0);
  assert.deepEqual(result.noCandidates, [
    { slug: 'empty-target', seed: 1 },
  ]);
  assert.equal(result.finished, true);
  assert.equal(result.canonicalPatchWritten, false);
  assert.equal(result.canonicalWavWritten, false);
  assert.deepEqual(readdirSync(outDir).sort(), [
    'report.json',
    'report.md',
  ]);
  const saved = await readJsonOrNull<typeof result>(
    join(outDir, 'report.json'),
  );
  assert.deepEqual(saved?.noCandidates, result.noCandidates);
});
