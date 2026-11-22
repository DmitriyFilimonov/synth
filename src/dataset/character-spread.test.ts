import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SAMPLE_RATE } from '../consts';
import { writeWav } from '../write-wav';
import {
  renderCharacterSpreadMarkdown,
  spreadStats,
  summarizeCharacterSpread,
  type CharacterRunSpread,
  type CharacterSpreadReport,
} from './character-spread';

function run(seed: number): CharacterRunSpread {
  return {
    slug: 'known',
    seed,
    bodyF0DeltaCents: seed === 1 ? -10 : 30,
    decayDb20DeltaSec: seed === 1 ? -0.02 : 0.04,
    bands: [
      {
        region: 'body',
        band: 'sub',
        deltaDb: seed === 1 ? 5 : -10,
        referenceRegionShare: seed === 1 ? 0.1 : 0.3,
        referenceRegionRelativeEnergy: seed === 1 ? 0.01 : 0.03,
      },
    ],
  };
}

test('character spread aggregates absolute values per target', () => {
  const [target] = summarizeCharacterSpread([run(1), run(2)]);
  assert.ok(target);
  assert.deepEqual(target.seeds, [1, 2]);
  assert.deepEqual(target.f0AbsCents, {
    median: 20,
    p90: 28,
    max: 30,
  });
  assert.deepEqual(target.decayAbsMs, {
    median: 30,
    p90: 38,
    max: 40,
  });
  const band = target.bands[0];
  assert.ok(band);
  assert.equal(band.referenceRegionShareMedian, 0.2);
  assert.ok(
    Math.abs((band.referenceRegionRelativeEnergyMedian ?? 0) - 0.02) <
      1e-12,
  );
  assert.deepEqual(band.absDeltaDb, {
    median: 7.5,
    p90: 9.5,
    max: 10,
  });
});

function executeCli(dataset: string): void {
  execFileSync(
    'npx',
    [
      'tsx',
      join(__dirname, 'character-spread.ts'),
      '--dataset',
      dataset,
    ],
    { stdio: 'pipe' },
  );
}

function readReport(dataset: string): CharacterSpreadReport {
  return JSON.parse(
    readFileSync(join(dataset, 'character-spread.json'), 'utf8'),
  ) as CharacterSpreadReport;
}

test('empty spread stays null and markdown reports observations', () => {
  assert.deepEqual(spreadStats([]), {
    median: null,
    p90: null,
    max: null,
  });
  const report = {
    version: 1 as const,
    createdAt: '2026-11-22T00:00:00.000Z',
    phaseModel: 'integral',
    codeRevision: 'known',
    runs: [run(1)],
    targets: summarizeCharacterSpread([run(1)]),
  };
  const markdown = renderCharacterSpreadMarkdown(report);
  assert.ok(markdown.includes('## known'));
  assert.ok(markdown.includes('Сиды: 1.'));
  assert.ok(markdown.includes('10.00 / 10.00 / 10.00'));
  assert.ok(markdown.includes('Абсолютная дельта'));
});

test('CLI writes a successful empty report without completed runs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'character-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ targetsDir: dir, phaseModel: 'integral' }),
  );
  executeCli(dir);
  const report = readReport(dir);
  assert.deepEqual(report.runs, []);
  assert.deepEqual(report.targets, []);
});

test('CLI skips a result with a different sample rate', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'character-rate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataset = join(dir, 'dataset');
  const runDir = join(dataset, 'known', 'seed-1');
  mkdirSync(runDir, { recursive: true });
  const targetPath = join(dir, 'target.wav');
  writeWav({
    samples: new Int16Array(SAMPLE_RATE / 10),
    sampleRate: SAMPLE_RATE,
    filePath: targetPath,
  });
  writeWav({
    samples: new Int16Array(SAMPLE_RATE / 20),
    sampleRate: SAMPLE_RATE / 2,
    filePath: join(runDir, 'result.wav'),
  });
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({ status: 'completed', target: 'target.wav' }),
  );
  writeFileSync(
    join(dataset, 'manifest.json'),
    JSON.stringify({ targetsDir: dir, phaseModel: 'integral' }),
  );
  executeCli(dataset);
  const report = readReport(dataset);
  assert.deepEqual(report.runs, []);
  assert.deepEqual(report.targets, []);
});
