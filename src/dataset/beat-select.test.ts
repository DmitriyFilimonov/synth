import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  renderBeatSelectionMarkdown,
  saveSelection,
  selectBestPreserved,
  type BeatSelectionCandidate,
} from './beat-select';
import {
  classifyBeatSeedOutcome,
  type BeatSeedRun,
} from './beat-seed-report';

/** Создаёт запись кандидата без обращения к файловой системе. */
function candidate(
  outcome: 'preserved' | 'lost' | 'introduced' | 'absent',
  seed: number,
  global: number | null,
): BeatSelectionCandidate {
  const originalAccepted =
    outcome === 'preserved' || outcome === 'lost';
  const matchAccepted =
    outcome === 'preserved' || outcome === 'introduced';
  const run: BeatSeedRun = {
    slug: 'demo',
    seed,
    target: 'demo.wav',
    resultWav: `/demo/seed-${seed}/result.wav`,
    originalAccepted,
    matchAccepted,
    f0: 50,
    deltaHz: 4,
    depth: 0.8,
    pairValR2: 0.8,
    valGain: 0.9,
    rejectionReasons: [],
    outcome: classifyBeatSeedOutcome(originalAccepted, matchAccepted),
  };
  return { run, globalSuppressionPercent: global };
}

test('selection uses global only inside preserved and breaks ties by seed', () => {
  const best = selectBestPreserved([
    candidate('introduced', 1, 99),
    candidate('lost', 2, 98),
    candidate('preserved', 3, 91),
    candidate('preserved', 4, 91),
    candidate('absent', 5, 100),
  ]);
  assert.equal(best?.run.outcome, 'preserved');
  assert.equal(best?.run.seed, 3);
  assert.equal(selectBestPreserved([candidate('lost', 1, 99)]), null);
});

test('selection copies JSON and WAV as exact bytes', async () => {
  const root = await mkdtemp('/tmp/opencode/beat-select-');
  try {
    const sourceDir = join(root, 'source', 'seed-1');
    await mkdir(sourceDir, { recursive: true });
    const patchBytes = Buffer.from('{\n  "oscillators": [ ]\n}\n');
    const wavBytes = Buffer.from([0, 1, 2, 3, 255, 254, 128, 127]);
    await writeFile(join(sourceDir, 'patch.json'), patchBytes);
    const sourceWav = join(sourceDir, 'result.wav');
    await writeFile(sourceWav, wavBytes);
    const selected = candidate('preserved', 1, 91);
    selected.run.resultWav = sourceWav;
    const outDir = join(root, 'out');
    await saveSelection({
      candidate: selected,
      slug: 'demo',
      target: 'demo.wav',
      outDir,
    });
    assert.deepEqual(
      await readFile(join(outDir, 'demo', 'patch.json')),
      patchBytes,
    );
    assert.deepEqual(
      await readFile(join(outDir, 'demo', 'result.wav')),
      wavBytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('markdown reports no-candidate instead of inventing a patch', () => {
  const markdown = renderBeatSelectionMarkdown([
    {
      slug: 'empty',
      target: 'empty.wav',
      status: 'no-candidate',
      seed: null,
      sourceRunDir: null,
      patch: null,
      wav: null,
      globalSuppressionPercent: null,
      pairValR2: null,
      deltaHz: null,
      depth: null,
    },
  ]);
  assert.match(markdown, /empty.*no-candidate/);
});
