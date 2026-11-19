/**
 * Оценочный жгут этапа 4 (план `docs/plan-kick-enhancement.md`):
 * портит патч завершённого прогона, синтезирует испорченный WAV,
 * прогоняет по нему стандартный match и меряет, что восстановилось
 * относительно чистого оригинала.
 *
 * Пока улучшение (T9) не написано, жгут измеряет базовую линию:
 * сколько возвращает голый match. Улучшение обязано бить эту цифру.
 *
 * Запуск:
 *   npx tsx src/dataset/run-mangle-eval.ts \
 *     --dataset datasets/reference-4 --run BOg-Disco-Futuro:1 \
 *     --out datasets/reference-4-mangle/BOg-s1-r7 \
 *     --mangle-seed 7 --strength 0.3 --count 4 --iterations 50
 *
 * Артефакты выходного каталога: broken.wav и broken-patch.json
 * (испорченное), recovered.wav и recovered-patch.json (голый match
 * по испорченному), eval.json (метрики и протокол порчи).
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SAMPLE_RATE } from '../consts';
import { dualWindowInitVector } from '../dual-window-init-vector';
import { matchWithWorker } from '../match-worker';
import { evaluateSuppressionFromWaveform } from '../optimize/evaluate';
import { readWav } from '../read-wav';
import { type ArgCreateSynth } from '../synth';
import { writeWav } from '../write-wav';
import { mangleRandom, type MangleEdit } from './mangle-patch';
import {
  readJsonOrNull,
  renderSamples,
  writeJsonAtomic,
} from './shared';

/** Аргументы командной строки жгута. */
interface CliArgs {
  dataset: string;
  run: string;
  out: string;
  mangleSeed: number;
  strength: number;
  count: number;
  iterations: number;
  oscillators: number;
}

/** Срез manifest.json датасета. */
interface ManifestSlice {
  targetsDir: string;
  numOscillators: number;
}

/** Срез run.json прогона. */
interface RunSlice {
  target: string;
  status: string;
}

/** Отчёт жгута — содержимое eval.json. */
interface EvalReport {
  dataset: string;
  run: string;
  target: string;
  mangleSeed: number;
  strength: number;
  recoveryIterations: number;
  mangleEdits: MangleEdit[];
  brokenSuppressionPercent: number | null;
  recoveredVsBrokenPercent: number | null;
  recoveredVsOriginalPercent: number | null;
  originalActiveOscillators: number;
  recoveredActiveOscillators: number;
  matchedOscillators: number;
  medianLogFreqBaseDelta: number | null;
  error: string | null;
}

/** Порог сопоставления по log-частоте (тот же, что в анализе). */
const MATCH_MAX_LOG_FREQ_DISTANCE = 0.25;

/** Разбирает аргументы командной строки в {@link CliArgs}. */
function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dataset: '',
    run: '',
    out: '',
    mangleSeed: 7,
    strength: 0.3,
    count: 4,
    iterations: 50,
    oscillators: 50,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for argument: ${key}`);
    }
    switch (key) {
      case '--dataset':
        args.dataset = value;
        break;
      case '--run':
        args.run = value;
        break;
      case '--out':
        args.out = value;
        break;
      case '--mangle-seed':
        args.mangleSeed = parseInt(value, 10);
        break;
      case '--strength':
        args.strength = parseFloat(value);
        break;
      case '--count':
        args.count = parseInt(value, 10);
        break;
      case '--iterations':
        args.iterations = parseInt(value, 10);
        break;
      case '--oscillators':
        args.oscillators = parseInt(value, 10);
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (args.dataset === '' || args.run === '' || args.out === '') {
    throw new Error('Required: --dataset, --run, --out');
  }
  return args;
}

/**
 * Сопоставляет активные осцилляторы двух патчей жадно по
 * log-частоте и возвращает медиану |Δlog freqBase| и число пар.
 */
function matchPatchOscillators(
  a: ArgCreateSynth,
  b: ArgCreateSynth,
): { matched: number; medianDelta: number | null } {
  const activeA = a.oscillators
    .map((g, i) => ({ i, f: g.osc.freqBase, on: g.osc.on }))
    .filter((g) => g.on);
  const activeB = b.oscillators
    .map((g, i) => ({ i, f: g.osc.freqBase, on: g.osc.on }))
    .filter((g) => g.on);

  const candidates: { i: number; j: number; dist: number }[] = [];
  for (const oa of activeA) {
    for (const ob of activeB) {
      candidates.push({
        i: oa.i,
        j: ob.i,
        dist: Math.abs(Math.log(oa.f) - Math.log(ob.f)),
      });
    }
  }
  candidates.sort((x, y) => x.dist - y.dist);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const deltas: number[] = [];
  for (const c of candidates) {
    if (c.dist > MATCH_MAX_LOG_FREQ_DISTANCE) {
      break;
    }
    if (usedA.has(c.i) || usedB.has(c.j)) {
      continue;
    }
    usedA.add(c.i);
    usedB.add(c.j);
    deltas.push(c.dist);
  }
  deltas.sort((x, y) => x - y);
  const medianDelta =
    deltas.length === 0
      ? null
      : (deltas[Math.floor((deltas.length - 1) / 2)] ?? null);
  return { matched: deltas.length, medianDelta };
}

/** Читает обязательный JSON; неудача — ошибка с путём. */
async function readJsonRequired<T>(path: string): Promise<T> {
  const data = await readJsonOrNull<T>(path);
  if (data === null) {
    throw new Error(`Cannot read or parse JSON: ${path}`);
  }
  return data;
}

/**
 * Гоняет оценку одного прогона: порча, синтез, match по
 * испорченному, метрики против оригинала. Тяжёлый шаг — match,
 * он занимает почти всё время работы жгута.
 */
async function runEval(args: CliArgs): Promise<EvalReport> {
  const [slug, seedPart] = args.run.split(':');
  const seed = parseInt(seedPart ?? '', 10);
  if (!slug || Number.isNaN(seed)) {
    throw new Error('--run must look like <slug>:<seed>');
  }
  const runDir = join(args.dataset, slug, `seed-${seed}`);
  const manifest = await readJsonRequired<ManifestSlice>(
    join(args.dataset, 'manifest.json'),
  );
  const runMeta = await readJsonRequired<RunSlice>(
    join(runDir, 'run.json'),
  );
  const originalPatch = await readJsonRequired<ArgCreateSynth>(
    join(runDir, 'patch.json'),
  );
  const targetPath = join(manifest.targetsDir, runMeta.target);

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  const brokenPatch = structuredClone(originalPatch);
  const mangleEdits = mangleRandom(brokenPatch, {
    patchPath: '',
    outDir: '',
    mode: 'random',
    seed: args.mangleSeed,
    strength: args.strength,
    count: args.count,
  });
  writeWav({
    samples: renderSamples(brokenPatch, 0.5),
    sampleRate: SAMPLE_RATE,
    filePath: join(outDir, 'broken.wav'),
  });
  await writeJsonAtomic(
    join(outDir, 'broken-patch.json'),
    brokenPatch,
  );

  const brokenWav = readWav(join(outDir, 'broken.wav'));
  const targetWav = readWav(targetPath);
  const targetSamples = [...targetWav.samples];
  const brokenSuppression = evaluateSuppressionFromWaveform(
    [...brokenWav.samples],
    targetSamples,
  );

  const initialVector = dualWindowInitVector(
    brokenWav.samples,
    SAMPLE_RATE,
    args.oscillators,
  );
  const recovered = await matchWithWorker({
    targetWavPath: join(outDir, 'broken.wav'),
    outputWavPath: join(outDir, 'recovered.wav'),
    initialVector,
    sampleRate: SAMPLE_RATE,
    maxIterations: args.iterations,
    seed: args.mangleSeed,
  });
  await writeJsonAtomic(
    join(outDir, 'recovered-patch.json'),
    recovered.synthConfig,
  );

  const recoveredWav = readWav(join(outDir, 'recovered.wav'));
  const recoveredSamples = [...recoveredWav.samples];
  const recoveredVsBroken = evaluateSuppressionFromWaveform(
    recoveredSamples,
    [...brokenWav.samples],
  );
  const recoveredVsOriginal = evaluateSuppressionFromWaveform(
    recoveredSamples,
    targetSamples,
  );

  const matching = matchPatchOscillators(
    originalPatch,
    recovered.synthConfig,
  );
  return {
    dataset: args.dataset,
    run: args.run,
    target: runMeta.target,
    mangleSeed: args.mangleSeed,
    strength: args.strength,
    recoveryIterations: args.iterations,
    mangleEdits,
    brokenSuppressionPercent: brokenSuppression,
    recoveredVsBrokenPercent: recoveredVsBroken,
    recoveredVsOriginalPercent: recoveredVsOriginal,
    originalActiveOscillators: originalPatch.oscillators.filter(
      (g) => g.osc.on,
    ).length,
    recoveredActiveOscillators:
      recovered.synthConfig.oscillators.filter((g) => g.osc.on)
        .length,
    matchedOscillators: matching.matched,
    medianLogFreqBaseDelta: matching.medianDelta,
    error: null,
  };
}

/** Точка входа: гоняет оценку и пишет eval.json. */
async function main(): Promise<void> {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const report = await runEval(args);
    await writeJsonAtomic(
      join(resolve(args.out), 'eval.json'),
      report,
    );
    console.log(
      `EVAL ${args.run}: broken=${report.brokenSuppressionPercent?.toFixed(2)}% ` +
        `recovered-vs-original=${report.recoveredVsOriginalPercent?.toFixed(2)}% ` +
        `matched=${report.matchedOscillators}/${report.originalActiveOscillators}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main();
