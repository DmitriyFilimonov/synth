/* eslint-disable no-console */
/**
 * Отчёт биения низа по исходным WAV. Не меняет патчи и не выдаёт
 * кандидат в закон за доказанный: сохраняет модель и причины отказа.
 *
 * npx tsx src/dataset/beat-report.ts --targets targets --out datasets/beat
 * npx tsx src/dataset/beat-report.ts --dataset datasets/reference-integral
 * Дополнительные файлы: --extra raw/water_12_kick.wav,raw/water_15_kick.wav
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readWav } from '../read-wav';
import {
  fitDampedBeat,
  measureTrainingF0,
  type DampedBeatFit,
} from './beat-model';
import {
  readJsonOrNullSync,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

/** Один WAV и его модель либо причина невозможности измерения. */
export interface BeatReportEntry {
  file: string;
  f0: number | null;
  fit: DampedBeatFit | null;
}

/** Машиночитаемый отчёт с версией модели и входными путями. */
export interface BeatReport {
  modelVersion: 2;
  createdAt: string;
  targetsDir: string;
  extraFiles: string[];
  entries: BeatReportEntry[];
}

function format(value: number | null, digits = 3): string {
  return value === null ? '—' : value.toFixed(digits);
}

/**
 * Строит Markdown-таблицу моделей и правил принятия биения.
 *
 * @param report - Входные пути и результаты подгонки по каждому WAV
 * @returns Markdown с частотами, глубиной, метриками и причинами
 *   отказа
 * @remarks Текст отчёта фиксирует пороги принятия и напоминает, что
 *   они не заменяют проверки Q1–Q5 и не доказывают закон качества.
 */
export function renderBeatReportMarkdown(report: BeatReport): string {
  const lines = [
    '# Биение низа: затухающие пары',
    '',
    'Обучение и оценка f0 идут на 80–180 мс, проверка — на 180–300 мс без новых коэффициентов. Кандидат принят, если pairTrainR2 ≥ 0.8, pairValR2 ≥ 0.5, valGain ≥ 0.5, прирост R² ≥ 0.005 и глубина огибающей (max−min)/max ≥ 0.05. Это измеритель, а не доказанный закон качества.',
    '',
    '| Файл | f0 | f1 | f2 | Δf | Глубина | Train R² | Val R² | Val gain | Вердикт |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const entry of report.entries) {
    const fit = entry.fit;
    if (fit === null) {
      lines.push(
        `| ${entry.file} | — | — | — | — | — | — | — | — | нет модели |`,
      );
      continue;
    }
    lines.push(
      `| ${entry.file} | ${format(entry.f0, 2)} | ${format(fit.f1, 2)} | ${format(fit.f2, 2)} | ${format(fit.deltaHz, 2)} | ${format(fit.depth)} | ${format(fit.pairTrainR2)} | ${format(fit.pairValR2)} | ${format(fit.valGain)} | ${fit.accepted ? 'кандидат' : `не принят: ${fit.rejectionReasons.join(', ')}`} |`,
    );
  }
  lines.push(
    '',
    'Частоты f1/f2 не считаются единственным физическим разложением короткого сигнала. Решение зависит от обобщения на другом участке, а не только от глубины коэффициентов.',
    '',
  );
  return lines.join('\n');
}

/**
 * Измеряет биение во всех входных WAV и сохраняет JSON и Markdown.
 *
 * @throws Error если аргументы неверны, не найдено ни одного WAV,
 *   файл не читается или не удалось записать отчёт
 * @remarks Принимает `--targets DIR` с обязательным `--out DIR` либо
 *   `--dataset DIR`, который читает `targetsDir` из manifest.json и
 *   пишет отчёт в корень датасета. Дополнительный `--extra FILES`
 *   содержит WAV через запятую. Каждый отчёт записывается атомарно;
 *   патчи не изменяются.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let targetsDir = 'targets';
  let outDir = '';
  let extraFiles: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--dataset') {
      const datasetDir = resolve(value);
      const manifest = readJsonOrNullSync<{ targetsDir: string }>(
        join(datasetDir, 'manifest.json'),
      );
      if (manifest === null) {
        throw new Error(`Нет manifest.json в ${datasetDir}`);
      }
      targetsDir = manifest.targetsDir;
      outDir = datasetDir;
    } else if (key === '--targets') {
      targetsDir = value;
    } else if (key === '--out') {
      outDir = value;
    } else if (key === '--extra') {
      extraFiles = value
        .split(',')
        .map((file) => file.trim())
        .filter((file) => file.length > 0);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (outDir === '') {
    throw new Error(
      'Usage: beat-report --targets DIR --out DIR [--extra FILES]',
    );
  }
  const resolvedTargets = resolve(targetsDir);
  const files = readdirSync(resolvedTargets)
    .filter((file) => file.toLowerCase().endsWith('.wav'))
    .sort()
    .map((file) => join(resolvedTargets, file));
  files.push(...extraFiles.map((file) => resolve(file)));
  if (files.length === 0) {
    throw new Error(`No WAV files in ${resolvedTargets}`);
  }
  const entries: BeatReportEntry[] = [];
  for (const file of files) {
    const wav = readWav(file);
    const f0 = measureTrainingF0(wav.samples, wav.sampleRate);
    const fit =
      f0 === null
        ? null
        : fitDampedBeat(wav.samples, f0, wav.sampleRate);
    entries.push({ file, f0, fit });
    if (fit === null) {
      console.log(`${basename(file)}: no model`);
    } else {
      console.log(
        `${basename(file)}: accepted=${fit.accepted} ` +
          `delta=${fit.deltaHz.toFixed(2)}Hz depth=${fit.depth.toFixed(3)} ` +
          `valR2=${fit.pairValR2.toFixed(3)} gain=${fit.valGain.toFixed(3)} ` +
          `reasons=${fit.rejectionReasons.join(',') || 'none'}`,
      );
    }
  }
  const report: BeatReport = {
    modelVersion: 2,
    createdAt: new Date().toISOString(),
    targetsDir: resolvedTargets,
    extraFiles: extraFiles.map((file) => resolve(file)),
    entries,
  };
  mkdirSync(outDir, { recursive: true });
  await writeJsonAtomic(join(outDir, 'beat-report.json'), report);
  await writeTextAtomic(
    join(outDir, 'beat-report.md'),
    renderBeatReportMarkdown(report),
  );
  console.log(
    `REPORT ${outDir}: ${entries.length} WAV, accepted=${entries.filter((entry) => entry.fit?.accepted === true).length}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
