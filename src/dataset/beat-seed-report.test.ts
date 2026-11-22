import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import {
  buildBeatReferenceMap,
  classifyBeatSeedOutcome,
  renderBeatSeedReportMarkdown,
  summarizeBeatSeedRuns,
  type BeatSeedReport,
  type BeatSeedRun,
} from './beat-seed-report';

/** Собирает минимальную запись для проверки сводки без аудио-I/O. */
function run(arg: {
  slug: string;
  seed: number;
  originalAccepted: boolean;
  matchAccepted: boolean;
}): BeatSeedRun {
  return {
    slug: arg.slug,
    seed: arg.seed,
    target: `${arg.slug}.wav`,
    resultWav: `/${arg.slug}/seed-${arg.seed}/result.wav`,
    originalAccepted: arg.originalAccepted,
    matchAccepted: arg.matchAccepted,
    f0: 50,
    deltaHz: arg.matchAccepted ? 4 : 1,
    depth: arg.matchAccepted ? 0.8 : 0.01,
    pairValR2: arg.matchAccepted ? 0.8 : 0.1,
    valGain: arg.matchAccepted ? 0.9 : 0.1,
    rejectionReasons: arg.matchAccepted ? [] : ['depth'],
    outcome: classifyBeatSeedOutcome(
      arg.originalAccepted,
      arg.matchAccepted,
    ),
  };
}

test('four outcomes cover preservation, loss, introduction and absence', () => {
  assert.equal(classifyBeatSeedOutcome(true, true), 'preserved');
  assert.equal(classifyBeatSeedOutcome(true, false), 'lost');
  assert.equal(classifyBeatSeedOutcome(false, true), 'introduced');
  assert.equal(classifyBeatSeedOutcome(false, false), 'absent');
});

test('reference lookup distinguishes equal basenames by full path', () => {
  const target = { file: '/targets/same.wav', f0: 50, fit: null };
  const extra = { file: '/extra/same.wav', f0: 100, fit: null };
  const references = buildBeatReferenceMap([target, extra]);
  assert.equal(references.get(resolve('/targets/same.wav'))?.f0, 50);
  assert.equal(references.get(resolve('/extra/same.wav'))?.f0, 100);
});

test('summary separates introduced beats from preserved ones', () => {
  const runs = [
    run({
      slug: 'accepted',
      seed: 1,
      originalAccepted: true,
      matchAccepted: true,
    }),
    run({
      slug: 'accepted',
      seed: 2,
      originalAccepted: true,
      matchAccepted: false,
    }),
    run({
      slug: 'rejected',
      seed: 1,
      originalAccepted: false,
      matchAccepted: true,
    }),
    run({
      slug: 'rejected',
      seed: 2,
      originalAccepted: false,
      matchAccepted: false,
    }),
  ];
  const targets = summarizeBeatSeedRuns(runs);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0], {
    slug: 'accepted',
    target: 'accepted.wav',
    originalAccepted: true,
    seeds: [1, 2],
    acceptedSeeds: [1],
    preserved: 1,
    lost: 1,
    introduced: 0,
    absent: 0,
  });
  assert.deepEqual(targets[1], {
    slug: 'rejected',
    target: 'rejected.wav',
    originalAccepted: false,
    seeds: [1, 2],
    acceptedSeeds: [1],
    preserved: 0,
    lost: 0,
    introduced: 1,
    absent: 1,
  });
  const report: BeatSeedReport = {
    version: 1,
    createdAt: '2026-11-22T00:00:00.000Z',
    phaseModel: 'integral',
    codeRevision: 'test',
    runs,
    targets,
  };
  const markdown = renderBeatSeedReportMarkdown(report);
  assert.match(markdown, /introduced/);
  assert.match(
    markdown,
    /\| accepted \| кандидат \| 1, 2 \| 1 \| 1 \| 1 \| 0 \| 0 \|/,
  );
  assert.equal(summarizeBeatSeedRuns([]).length, 0);
});
