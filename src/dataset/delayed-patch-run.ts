/* eslint-disable no-console */
/**
 * Воспроизводит лучшие onset-кандидаты как настоящие canonical patch/WAV.
 * Delayed synth применяется только в этом offline post-pass; CD и enhance
 * не вызываются. При ухудшении global/J сохраняется исходный match.
 *
 * npx tsx src/dataset/delayed-patch-run.ts --report datasets/onset/report.json --out datasets/delayed
 */
import { mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareCharacter } from '../character-metrics';
import { readWav } from '../read-wav';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { compareWaveformBands } from '../waveform-bands';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import {
  countDelayedAtoms,
  realizeDelayedCandidate,
  type DelayedCandidate,
} from './delayed-patch';
import { withAttackBoost } from './quadrature-refit-run';
import type { RefitMetrics } from './quadrature-refit';
import {
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

interface OnsetReportInput {
  dataset: string;
  phaseModel?: PhaseModel;
  attackBoost?: number;
  runs: OnsetRunInput[];
}

interface OnsetRunInput {
  slug: string;
  seed: number;
  sourceRunDir: string;
  bestExactDelayed: {
    candidate: DelayedCandidate;
    metrics: RefitMetrics;
  } | null;
}

interface DatasetManifest {
  targetsDir: string;
}

interface SourceRunRecord {
  status: string;
  target: string;
}

interface DelayedRunReport {
  slug: string;
  seed: number;
  status: 'refined' | 'unchanged';
  patch: string;
  wav: string;
  baselineGlobal: number;
  baselineWindowed: number;
  oracleGlobal: number;
  oracleWindowed: number;
  candidateGlobal: number;
  candidateWindowed: number;
  resultGlobal: number;
  resultWindowed: number;
  resultGlobalDelta: number;
  resultWindowedDelta: number;
  delayedAtoms: number;
  onsetsMs: number[];
  durationMs: number;
}

interface DelayedSummary {
  slug: string;
  runs: number;
  meanGlobalDelta: number;
  meanWindowedDelta: number;
  improved: number;
}

interface DelayedReport {
  version: 1;
  createdAt: string;
  sourceReport: string;
  phaseModel: PhaseModel;
  attackBoost: number;
  finished: boolean;
  canonicalPatchWritten: boolean;
  canonicalWavWritten: boolean;
  errors: { slug: string; seed: number; message: string }[];
  noCandidates: { slug: string; seed: number }[];
  runs: DelayedRunReport[];
  summaries: DelayedSummary[];
}

/** Сверяет canonical candidate с измерением diagnostic oracle. */
function assertOracleMetricsMatch(
  actual: RefitMetrics,
  expected: RefitMetrics,
): void {
  if (
    Math.abs(
      actual.globalSuppressionPercent -
        expected.globalSuppressionPercent,
    ) > 1e-8 ||
    Math.abs(
      actual.windowedSuppressionPercent -
        expected.windowedSuppressionPercent,
    ) > 1e-8
  ) {
    throw new Error(
      `Canonical delayed patch не совпал с oracle: ${actual.globalSuppressionPercent}/${actual.windowedSuppressionPercent} против ${expected.globalSuppressionPercent}/${expected.windowedSuppressionPercent}`,
    );
  }
}

/** Атомарно сохраняет patch/WAV и подробный аудит одного сида. */
async function saveDelayedArtifacts(arg: {
  directory: string;
  patch: ArgCreateSynth;
  samples: Int16Array;
  sampleRate: number;
  audit: unknown;
}): Promise<{ patch: string; wav: string }> {
  mkdirSync(arg.directory, { recursive: true });
  const patch = join(arg.directory, 'patch.json');
  const wav = join(arg.directory, 'result.wav');
  await writeJsonAtomic(patch, arg.patch);
  writeWav({
    samples: arg.samples,
    sampleRate: arg.sampleRate,
    filePath: `${wav}.tmp`,
  });
  await rename(`${wav}.tmp`, wav);
  await writeJsonAtomic(join(arg.directory, 'audit.json'), arg.audit);
  return { patch, wav };
}

/**
 * Обрабатывает один onset candidate с canonical и oracle guards.
 *
 * @param arg - Запись onset-отчёта, каталог target WAV, модель фазы и
 *   выходной каталог
 * @returns Отчёт сида либо `null`, если match не завершён или oracle не
 *   нашёл delayed candidate
 * @throws Error если исходный patch/WAV не совпадают, canonical candidate
 *   расходится с oracle или не удаётся прочитать входные артефакты
 * @remarks Runner сначала проверяет canonical render исходного match,
 *   затем сверяет global/J candidate с oracle. Если guard отклоняет
 *   candidate, сохраняет возвращённые исходные patch/WAV как fallback.
 */
async function processDelayedRun(arg: {
  run: OnsetRunInput;
  targetsDir: string;
  phaseModel: PhaseModel;
  outDir: string;
}): Promise<DelayedRunReport | null> {
  const { run } = arg;
  if (run.bestExactDelayed === null) {
    return null;
  }
  const record = await readJsonOrNull<SourceRunRecord>(
    join(run.sourceRunDir, 'run.json'),
  );
  if (record?.status !== 'completed') {
    return null;
  }
  const patch = await readJsonOrNull<ArgCreateSynth>(
    join(run.sourceRunDir, 'patch.json'),
  );
  if (patch === null) {
    throw new Error(`Нет patch.json в ${run.sourceRunDir}`);
  }
  const target = readWav(join(arg.targetsDir, record.target));
  const baselineWav = readWav(join(run.sourceRunDir, 'result.wav'));
  assertPatchMatchesWav(
    patch,
    baselineWav.samples,
    arg.phaseModel,
    baselineWav.sampleRate,
    target.samples.length,
  );
  const started = Date.now();
  const result = realizeDelayedCandidate({
    source: patch,
    candidate: run.bestExactDelayed.candidate,
    target: target.samples,
    sampleRate: target.sampleRate,
    phaseModel: arg.phaseModel,
  });
  assertOracleMetricsMatch(
    result.candidateMetrics,
    run.bestExactDelayed.metrics,
  );
  assertPatchMatchesWav(
    result.patch,
    result.samples,
    arg.phaseModel,
    target.sampleRate,
    target.samples.length,
  );
  const onsetsMs = run.bestExactDelayed.candidate.atoms.map(
    (atom) => (atom.delaySamples / target.sampleRate) * 1000,
  );
  const artifacts = await saveDelayedArtifacts({
    directory: join(arg.outDir, run.slug, `seed-${run.seed}`),
    patch: result.patch,
    samples: result.samples,
    sampleRate: target.sampleRate,
    audit: {
      algorithm: 'delayed-patch',
      oracle: run.bestExactDelayed,
      candidate: run.bestExactDelayed.candidate,
      baseline: result.baseline,
      candidateMetrics: result.candidateMetrics,
      metrics: result.metrics,
      status: result.status,
      canonicalPatchWritten: true,
      canonicalWavWritten: true,
      character: compareCharacter(
        target.samples,
        result.samples,
        target.sampleRate,
      ),
      bands: compareWaveformBands(
        target.samples,
        result.samples,
        target.sampleRate,
      ),
    },
  });
  return {
    slug: run.slug,
    seed: run.seed,
    status: result.status,
    ...artifacts,
    baselineGlobal: result.baseline.globalSuppressionPercent,
    baselineWindowed: result.baseline.windowedSuppressionPercent,
    oracleGlobal:
      run.bestExactDelayed.metrics.globalSuppressionPercent,
    oracleWindowed:
      run.bestExactDelayed.metrics.windowedSuppressionPercent,
    candidateGlobal: result.candidateMetrics.globalSuppressionPercent,
    candidateWindowed:
      result.candidateMetrics.windowedSuppressionPercent,
    resultGlobal: result.metrics.globalSuppressionPercent,
    resultWindowed: result.metrics.windowedSuppressionPercent,
    resultGlobalDelta:
      result.metrics.globalSuppressionPercent -
      result.baseline.globalSuppressionPercent,
    resultWindowedDelta:
      result.metrics.windowedSuppressionPercent -
      result.baseline.windowedSuppressionPercent,
    delayedAtoms: countDelayedAtoms(run.bestExactDelayed.candidate),
    onsetsMs,
    durationMs: Date.now() - started,
  };
}

/** Сводит только фактический canonical результат каждого таргета. */
function summarizeDelayedTarget(
  slug: string,
  runs: DelayedRunReport[],
): DelayedSummary {
  const count = Math.max(1, runs.length);
  return {
    slug,
    runs: runs.length,
    meanGlobalDelta:
      runs.reduce((sum, run) => sum + run.resultGlobalDelta, 0) /
      count,
    meanWindowedDelta:
      runs.reduce((sum, run) => sum + run.resultWindowedDelta, 0) /
      count,
    improved: runs.filter(
      (run) => run.status === 'refined' && run.resultGlobalDelta > 0,
    ).length,
  };
}

/** Возвращает Markdown только о canonical patch/WAV, не raw oracle. */
function renderDelayedMarkdown(report: DelayedReport): string {
  const lines = [
    '# Canonical delayed patch/WAV из onset oracle',
    '',
    'Каждый candidate прошёл canonical render и сверку global/J с oracle. При проигрыше исходному match runner сохранил исходный patch/WAV. Это offline post-pass, не новый CD и не доказанный закон T35.',
    '',
    '| Таргет | Сид | Статус | Baseline global/J | Oracle candidate global/J | Canonical global/J | Δ global/J | Onset, мс |',
    '| --- | ---: | --- | --- | --- | --- | --- | --- |',
  ];
  for (const run of report.runs) {
    lines.push(
      `| ${run.slug} | ${run.seed} | ${run.status} | ${run.baselineGlobal.toFixed(3)} / ${run.baselineWindowed.toFixed(3)} | ${run.oracleGlobal.toFixed(3)} / ${run.oracleWindowed.toFixed(3)} | ${run.resultGlobal.toFixed(3)} / ${run.resultWindowed.toFixed(3)} | ${run.resultGlobalDelta.toFixed(3)} / ${run.resultWindowedDelta.toFixed(3)} | ${run.onsetsMs.map((value) => value.toFixed(3)).join(', ')} |`,
    );
  }
  lines.push(
    '',
    '| Таргет | Прогонов | Среднее Δ global | Среднее Δ J | Улучшено |',
    '| --- | ---: | ---: | ---: | ---: |',
  );
  for (const summary of report.summaries) {
    lines.push(
      `| ${summary.slug} | ${summary.runs} | ${summary.meanGlobalDelta.toFixed(3)} | ${summary.meanWindowedDelta.toFixed(3)} | ${summary.improved} |`,
    );
  }
  if (report.noCandidates.length > 0) {
    lines.push('', '## Без delayed candidate', '');
    for (const run of report.noCandidates) {
      lines.push(`- ${run.slug}, seed ${run.seed}: no-candidate.`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Строит текущий отчёт и чекпоинт после каждого сида. */
function makeDelayedReport(arg: {
  sourceReport: string;
  phaseModel: PhaseModel;
  attackBoost: number;
  runs: DelayedRunReport[];
  errors: DelayedReport['errors'];
  noCandidates: DelayedReport['noCandidates'];
  finished: boolean;
}): DelayedReport {
  const slugs = [...new Set(arg.runs.map((run) => run.slug))];
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceReport: arg.sourceReport,
    phaseModel: arg.phaseModel,
    attackBoost: arg.attackBoost,
    finished: arg.finished,
    canonicalPatchWritten: arg.runs.length > 0,
    canonicalWavWritten: arg.runs.length > 0,
    errors: arg.errors,
    noCandidates: arg.noCandidates,
    runs: arg.runs,
    summaries: slugs.map((slug) =>
      summarizeDelayedTarget(
        slug,
        arg.runs.filter((run) => run.slug === slug),
      ),
    ),
  };
}

/** Атомарно сохраняет JSON и Markdown текущего прогона. */
async function checkpoint(
  outDir: string,
  report: DelayedReport,
): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await writeJsonAtomic(join(outDir, 'report.json'), report);
  await writeTextAtomic(
    join(outDir, 'report.md'),
    renderDelayedMarkdown(report),
  );
}

/** Последовательно воспроизводит onset-кандидаты и сохраняет чекпоинты. */
export async function runDelayedCli(arg: {
  sourceReport: string;
  report: OnsetReportInput;
  outDir: string;
}): Promise<DelayedReport> {
  const manifest = await readJsonOrNull<DatasetManifest>(
    join(arg.report.dataset, 'manifest.json'),
  );
  if (manifest === null) {
    throw new Error(`Нет manifest.json в ${arg.report.dataset}`);
  }
  const phaseModel = arg.report.phaseModel ?? 'legacy';
  const runs: DelayedRunReport[] = [];
  const errors: DelayedReport['errors'] = [];
  const noCandidates = arg.report.runs
    .filter((run) => run.bestExactDelayed === null)
    .map((run) => ({ slug: run.slug, seed: run.seed }));
  for (const run of arg.report.runs) {
    try {
      const result = await processDelayedRun({
        run,
        targetsDir: manifest.targetsDir,
        phaseModel,
        outDir: arg.outDir,
      });
      if (result !== null) {
        runs.push(result);
        console.log(
          `RESULT ${run.slug} seed=${run.seed} ${result.status} ` +
            `global=${result.resultGlobalDelta.toFixed(3)} J=${result.resultWindowedDelta.toFixed(3)} ` +
            `onsetMs=${result.onsetsMs.map((value) => value.toFixed(3)).join(',')}`,
        );
      } else if (run.bestExactDelayed === null) {
        console.log(
          `SKIP ${run.slug}/seed-${run.seed}: no-candidate`,
        );
      } else {
        console.log(
          `SKIP ${run.slug}/seed-${run.seed}: not completed`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      errors.push({ slug: run.slug, seed: run.seed, message });
      console.warn(`WARN ${run.slug}/seed-${run.seed}: ${message}`);
    }
    await checkpoint(
      arg.outDir,
      makeDelayedReport({
        sourceReport: arg.sourceReport,
        phaseModel,
        attackBoost: arg.report.attackBoost ?? 1,
        runs,
        errors,
        noCandidates,
        finished: false,
      }),
    );
  }
  const final = makeDelayedReport({
    sourceReport: arg.sourceReport,
    phaseModel,
    attackBoost: arg.report.attackBoost ?? 1,
    runs,
    errors,
    noCandidates,
    finished: true,
  });
  await checkpoint(arg.outDir, final);
  return final;
}

/** Разбирает путь отчёта и выходной каталог. */
function parseDelayedArgs(args: string[]): {
  report: string;
  outDir: string;
} {
  let report = '';
  let outDir = '';
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--report') {
      report = resolve(value);
    } else if (key === '--out') {
      outDir = resolve(value);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (report === '' || outDir === '') {
    throw new Error(
      'Usage: delayed-patch-run --report FILE --out DIR',
    );
  }
  return { report, outDir };
}

/** Связывает CLI, attackBoost и canonical delayed post-pass. */
async function main(): Promise<void> {
  const args = parseDelayedArgs(process.argv.slice(2));
  const report = await readJsonOrNull<OnsetReportInput>(args.report);
  if (report === null) {
    throw new Error(`Нет onset report ${args.report}`);
  }
  const result = await withAttackBoost(report.attackBoost ?? 1, () =>
    runDelayedCli({
      sourceReport: args.report,
      report,
      outDir: args.outDir,
    }),
  );
  for (const summary of result.summaries) {
    console.log(
      `SUMMARY ${summary.slug} runs=${summary.runs} ` +
        `meanGlobal=${summary.meanGlobalDelta.toFixed(3)} ` +
        `meanJ=${summary.meanWindowedDelta.toFixed(3)} improved=${summary.improved}`,
    );
  }
  console.log(
    `REPORT ${args.outDir}: ${result.runs.length} runs, errors=${result.errors.length}`,
  );
  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
