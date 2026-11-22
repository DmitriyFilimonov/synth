/* eslint-disable no-console */
/**
 * Offline-пилот restoreBeatPair и repairExistingBeatPair только на
 * lost-прогонах. Сохраняет патчи, WAV и полные метрики; match, enhance
 * и coordinate descent не вызываются. Validation 180–300 мс вычисляется
 * уже после выбора слотов.
 *
 * npx tsx src/dataset/beat-transfer-run.ts --dataset datasets/ref --out datasets/transfer
 */
import { mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SAMPLE_RATE } from '../consts';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { readWav } from '../read-wav';
import { writeWav } from '../write-wav';
import {
  compareCharacter,
  type CharacterDelta,
} from '../character-metrics';
import {
  compareWaveformBands,
  type WaveformBandDelta,
} from '../waveform-bands';
import {
  evaluateSuppressionFromWaveform,
  evaluateSuppressionWindowed,
} from '../optimize/evaluate';
import {
  fitDampedBeat,
  measureTrainingF0,
  type DampedBeatFit,
} from './beat-model';
import type { BeatReport } from './beat-report';
import {
  buildBeatReferenceMap,
  classifyBeatSeedOutcome,
  type BeatSeedOutcome,
  type BeatSeedReport,
  type BeatSeedRun,
} from './beat-seed-report';
import {
  repairExistingBeatPair,
  restoreBeatPair,
} from './beat-transfer';
import {
  readJsonOrNull,
  renderSamples,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

interface DatasetManifest {
  targetsDir: string;
  phaseModel?: PhaseModel;
}

interface Evaluation {
  globalSuppressionPercent: number;
  windowedSuppressionPercent: number;
  f0: number | null;
  fit: DampedBeatFit | null;
  character: CharacterDelta;
  bands: WaveformBandDelta[];
}

interface PilotRun {
  slug: string;
  seed: number;
  status: string;
  baseline: Evaluation;
  candidate: Evaluation;
  outcome: BeatSeedOutcome;
  transfer: ReturnType<typeof restoreBeatPair>['audit'];
  patch: string;
  wav: string;
}

/** Сравнивает один WAV с исходником уже после завершения переноса. */
function evaluateWav(
  samples: Int16Array,
  target: Int16Array,
  sampleRate: number,
): Evaluation {
  const f0 = measureTrainingF0(samples, sampleRate);
  return {
    globalSuppressionPercent: evaluateSuppressionFromWaveform(
      Array.from(samples),
      Array.from(target),
    ),
    windowedSuppressionPercent: evaluateSuppressionWindowed(
      Array.from(samples),
      Array.from(target),
      sampleRate,
    ),
    f0,
    fit: f0 === null ? null : fitDampedBeat(samples, f0, sampleRate),
    character: compareCharacter(target, samples, sampleRate),
    bands: compareWaveformBands(target, samples, sampleRate),
  };
}

/** Проверяет, что сохранённый patch воспроизводит result.wav побайтово. */
export function assertPatchMatchesWav(
  patch: ArgCreateSynth,
  expected: Int16Array,
  phaseModel: PhaseModel,
  sampleRate: number,
  renderSampleCount: number,
): void {
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error(`sample rate ${sampleRate} != ${SAMPLE_RATE}`);
  }
  const actual = renderSamplesForCheck(
    patch,
    phaseModel,
    renderSampleCount,
  );
  if (actual.length !== expected.length) {
    throw new Error(
      `Длина patch ${actual.length} != WAV ${expected.length}`,
    );
  }
  let maxDifference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    maxDifference = Math.max(
      maxDifference,
      Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)),
    );
  }
  if (maxDifference !== 0) {
    throw new Error(
      `patch.json не совпадает с result.wav: ${maxDifference} LSB`,
    );
  }
}

/** Локальный рендер нужен, чтобы проверка использовала общий helper. */
function renderSamplesForCheck(
  patch: ArgCreateSynth,
  phaseModel: PhaseModel,
  sampleCount: number,
): Int16Array {
  return renderSamples(patch, (sampleCount + 0.5) / SAMPLE_RATE, {
    phaseModel,
  });
}

interface VerifiedRun {
  patch: ArgCreateSynth;
  target: ReturnType<typeof readWav>;
  baselineWav: ReturnType<typeof readWav>;
}

/** Загружает один match и проверяет согласованность его артефактов. */
async function loadVerifiedRun(arg: {
  run: BeatSeedRun;
  targetWav: string;
  phaseModel: PhaseModel;
}): Promise<VerifiedRun> {
  const runDir = dirname(arg.run.resultWav);
  const patch = await readJsonOrNull<ArgCreateSynth>(
    join(runDir, 'patch.json'),
  );
  if (patch === null) {
    throw new Error(`Нет patch.json в ${runDir}`);
  }
  const target = readWav(arg.targetWav);
  const baselineWav = readWav(arg.run.resultWav);
  if (target.sampleRate !== baselineWav.sampleRate) {
    throw new Error(
      `sample rate ${target.sampleRate} != ${baselineWav.sampleRate}`,
    );
  }
  if (target.samples.length !== baselineWav.samples.length) {
    throw new Error(
      `Длина target ${target.samples.length} != baseline ${baselineWav.samples.length}`,
    );
  }
  assertPatchMatchesWav(
    patch,
    baselineWav.samples,
    arg.phaseModel,
    baselineWav.sampleRate,
    target.samples.length,
  );
  return { patch, target, baselineWav };
}

/** Сохраняет patch и WAV кандидата и возвращает их пути. */
async function writePilotArtifacts(arg: {
  outRunDir: string;
  restored: ReturnType<typeof restoreBeatPair>;
  sampleRate: number;
}): Promise<{ patchPath: string; wavPath: string }> {
  mkdirSync(arg.outRunDir, { recursive: true });
  const patchPath = join(arg.outRunDir, 'patch.json');
  const wavPath = join(arg.outRunDir, 'result.wav');
  await writeJsonAtomic(patchPath, arg.restored.patch);
  writeWav({
    samples: arg.restored.samples,
    sampleRate: arg.sampleRate,
    filePath: `${wavPath}.tmp`,
  });
  await rename(`${wavPath}.tmp`, wavPath);
  return { patchPath, wavPath };
}

/** Обрабатывает один lost-прогон и сохраняет все артефакты. */
async function processRun(arg: {
  run: BeatSeedRun;
  targetWav: string;
  referenceFit: DampedBeatFit | null;
  outDir: string;
  phaseModel: PhaseModel;
  mode: 'replace' | 'phase' | 'envelope';
}): Promise<PilotRun> {
  if (arg.referenceFit === null || !arg.referenceFit.accepted) {
    throw new Error('У lost-таргета нет принятой исходной модели');
  }
  const { patch, target, baselineWav } = await loadVerifiedRun({
    run: arg.run,
    targetWav: arg.targetWav,
    phaseModel: arg.phaseModel,
  });
  const transferArg = {
    patch,
    target: target.samples,
    fit: arg.referenceFit,
    sampleRate: target.sampleRate,
    phaseModel: arg.phaseModel,
  };
  const restored =
    arg.mode === 'replace'
      ? restoreBeatPair(transferArg)
      : repairExistingBeatPair({
          ...transferArg,
          refineEnvelopes: arg.mode === 'envelope',
        });
  const outRunDir = join(
    arg.outDir,
    arg.run.slug,
    `seed-${arg.run.seed}`,
  );
  const { patchPath, wavPath } = await writePilotArtifacts({
    outRunDir,
    restored,
    sampleRate: target.sampleRate,
  });
  const baseline = evaluateWav(
    baselineWav.samples,
    target.samples,
    target.sampleRate,
  );
  const candidate = evaluateWav(
    restored.samples,
    target.samples,
    target.sampleRate,
  );
  const candidateAccepted = candidate.fit?.accepted ?? false;
  const result: PilotRun = {
    slug: arg.run.slug,
    seed: arg.run.seed,
    status: restored.status,
    baseline,
    candidate,
    outcome: classifyBeatSeedOutcome(true, candidateAccepted),
    transfer: restored.audit,
    patch: patchPath,
    wav: wavPath,
  };
  await writeJsonAtomic(join(outRunDir, 'audit.json'), result);
  return result;
}

function format(value: number | null, digits = 3): string {
  return value === null ? '—' : value.toFixed(digits);
}

/** Строит компактную сводку; полные полосы и характер лежат в audit.json. */
function renderMarkdown(runs: PilotRun[]): string {
  const lines = [
    '# Offline-перенос биения на lost-сидах',
    '',
    'Коэффициенты подгоняются на 80–180 мс, а слоты выбираются с учётом атаки и хвоста вне validation. Val R² и global ниже посчитаны после рендера. Это эксперимент, а не включённое улучшение и не закрытие Q1–Q5.',
    '',
    '| Таргет | Сид | Статус | Val R² до | Val R² после | Global до | Global после | Исход |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const run of runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${run.status} | ${format(run.baseline.fit?.pairValR2 ?? null)} | ${format(run.candidate.fit?.pairValR2 ?? null)} | ${format(run.baseline.globalSuppressionPercent, 2)} | ${format(run.candidate.globalSuppressionPercent, 2)} | ${run.outcome} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Запускает пилот на всех lost-записях текущего beat-seed-report. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dataset = '';
  let outDir = '';
  let mode: 'replace' | 'phase' | 'envelope' = 'replace';
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--dataset') {
      dataset = resolve(value);
    } else if (key === '--out') {
      outDir = resolve(value);
    } else if (key === '--mode') {
      if (
        value !== 'replace' &&
        value !== 'phase' &&
        value !== 'envelope'
      ) {
        throw new Error(
          '--mode должен быть replace, phase или envelope',
        );
      }
      mode = value;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (dataset === '' || outDir === '') {
    throw new Error(
      'Usage: beat-transfer-run --dataset DIR --out DIR [--mode replace|phase]',
    );
  }
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(dataset, 'manifest.json'),
  );
  const beatReport = await readJsonOrNull<BeatReport>(
    join(dataset, 'beat-report.json'),
  );
  const seedReport = await readJsonOrNull<BeatSeedReport>(
    join(dataset, 'beat-seed-report.json'),
  );
  if (
    manifest === null ||
    beatReport === null ||
    seedReport === null
  ) {
    throw new Error('Нужны manifest, beat-report и beat-seed-report');
  }
  const references = buildBeatReferenceMap(beatReport.entries);
  const phaseModel = manifest.phaseModel ?? 'legacy';
  const lost = seedReport.runs.filter(
    (run) => run.outcome === 'lost',
  );
  const runs: PilotRun[] = [];
  for (const run of lost) {
    const targetWav = join(manifest.targetsDir, run.target);
    const reference = references.get(resolve(targetWav));
    try {
      const result = await processRun({
        run,
        targetWav,
        referenceFit: reference?.fit ?? null,
        outDir,
        phaseModel,
        mode,
      });
      runs.push(result);
      console.log(
        `${run.slug}/seed-${run.seed}: ${result.status}, ` +
          `valR2=${format(result.baseline.fit?.pairValR2 ?? null)} -> ${format(result.candidate.fit?.pairValR2 ?? null)}, ` +
          `global=${format(result.baseline.globalSuppressionPercent, 2)} -> ${format(result.candidate.globalSuppressionPercent, 2)}, ` +
          `outcome=${result.outcome}`,
      );
    } catch (error) {
      console.warn(
        `WARN ${run.slug}/seed-${run.seed}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  mkdirSync(outDir, { recursive: true });
  await writeJsonAtomic(join(outDir, 'report.json'), {
    version: 1,
    createdAt: new Date().toISOString(),
    dataset,
    mode,
    runs,
  });
  await writeTextAtomic(
    join(outDir, 'report.md'),
    renderMarkdown(runs),
  );
  console.log(
    `REPORT ${outDir}: ${runs.length}/${lost.length} processed`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
