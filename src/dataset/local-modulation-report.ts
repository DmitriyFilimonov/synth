/* eslint-disable no-console */
/**
 * CLI WAV-only screening локальной низкочастотной модуляции.
 * Принимает только явно перечисленные WAV и пишет report.json/md.
 * Не создаёт патчи или WAV и не выставляет Q1/Q2/Q4/Q5.
 *
 * npx tsx src/dataset/local-modulation-report.ts \
 *   --wav synthetic.wav --out datasets/local-modulation-synthetic
 */
import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readWav } from '../read-wav';
import {
  screenLocalModulation,
  type LocalModulationOptions,
  type LocalModulationResult,
} from './local-modulation';
import { writeJsonAtomic, writeTextAtomic } from './shared';

/** Один явно переданный WAV и его диагностика. */
export interface LocalModulationReportEntry {
  file: string;
  result: LocalModulationResult;
}

/** Машиночитаемый offline-отчёт без оценок закона качества. */
export interface LocalModulationReport {
  reportVersion: 1;
  files: string[];
  entries: LocalModulationReportEntry[];
}

function format(value: number, digits = 6): string {
  return Number.isFinite(value)
    ? value.toFixed(digits)
    : 'не конечно';
}

/**
 * Возвращает Markdown с поблочными числами и границами контракта.
 *
 * @param report - Результаты screening по явно перечисленным WAV
 * @returns Markdown со summary, folds и описательным full fit
 * @remarks Full fit визуально отделён от held-out метрик и не даёт
 *   accepted-вердикта или оценок Q1/Q2/Q4/Q5.
 */
export function renderLocalModulationMarkdown(
  report: LocalModulationReport,
): string {
  const lines = [
    '# Screening локальной низкочастотной модуляции',
    '',
    'H0 и H1 используют одну и ту же экспоненциальную D(t) и фазу экспоненциального sweep. H0 имеет постоянные C/S, а H1 — кусочно-линейные C/S со штрафом вторых разностей. В каждом внутреннем leave-one-contiguous-block-out fold общие D/phi сначала подбираются по H0 только на train, после чего обе модели получают их без изменений. Это ограниченный common-nuisance контракт: H1 не оптимизирует собственные D/phi.',
    '',
    'Первый и последний блоки всегда остаются доступными для train, поэтому исключённый блок имеет соседей с двух сторон. Из train дополнительно удаляются все filtered отсчёты, чей raw support пересекает held-out. H1 предсказывает блок через глобально заданные hat-функции. Отчёт не проверяет биение, не принимает кандидата и не выносит Q1/Q2/Q4/Q5. Full fit описывает A(t), фазу и частоту, но не входит в held-out метрики.',
    '',
  ];
  for (const entry of report.entries) {
    const result = entry.result;
    lines.push(`## ${entry.file}`, '');
    lines.push(`Статус: ${result.status}.`, '');
    if (result.status !== 'ok') {
      continue;
    }
    lines.push(
      `Pooled RSS H0: ${result.summary.h0PooledHeldOutRss}; H1: ${result.summary.h1PooledHeldOutRss}; gain: ${format(result.summary.pooledHeldOutRssGain)}. Положительных folds: ${result.summary.positiveGainFoldCount}/${result.folds.length}.`,
      '',
      '| Fold | Начало, с | Конец, с | Purge | RSS H0 | RSS H1 | Gain |',
      '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const fold of result.folds) {
      lines.push(
        `| ${fold.index} | ${format(fold.startSec, 3)} | ${format(fold.endSec, 3)} | ${fold.purgedTrainSampleCount} | ${fold.h0HeldOutRss} | ${fold.h1HeldOutRss} | ${format(fold.heldOutRssGain)} |`,
      );
    }
    lines.push(
      '',
      '| t, с | D | A0 | A1 | Residual phase | Residual f, Гц | Total f, Гц |',
      '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const point of result.descriptiveFit?.trajectory ?? []) {
      lines.push(
        `| ${format(point.timeSec, 3)} | ${format(point.sharedD)} | ${format(point.h0Amplitude)} | ${format(point.h1Amplitude)} | ${format(point.h1ResidualPhaseRad)} | ${point.h1ResidualFrequencyHz === null ? '—' : format(point.h1ResidualFrequencyHz)} | ${point.h1TotalFrequencyHz === null ? '—' : format(point.h1TotalFrequencyHz)} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Обрабатывает перечисленные WAV и атомарно сохраняет JSON и
 * Markdown.
 *
 * @param files - Явные пути к mono PCM16 WAV; каталоги не сканируются
 * @param outDir - Каталог только для report.json и report.md
 * @param options - Параметры screening, прежде всего для synthetic
 *   tests
 * @returns Тот же объект, который записан в report.json
 * @throws Error если список пуст, вход не читается или запись не
 *   удалась
 */
export async function runLocalModulationReport(
  files: string[],
  outDir: string,
  options: LocalModulationOptions = {},
): Promise<LocalModulationReport> {
  if (files.length === 0) {
    throw new Error('Нужен хотя бы один явный --wav FILE');
  }
  const resolvedFiles = files.map((file) => resolve(file));
  const entries: LocalModulationReportEntry[] = [];
  for (const file of resolvedFiles) {
    const wav = readWav(file);
    const result = screenLocalModulation(
      wav.samples,
      wav.sampleRate,
      options,
    );
    entries.push({ file, result });
    console.log(
      `${basename(file)}: status=${result.status} ` +
        `folds=${result.folds.length} ` +
        `pooledGain=${result.summary.pooledHeldOutRssGain}`,
    );
  }
  const report: LocalModulationReport = {
    reportVersion: 1,
    files: resolvedFiles,
    entries,
  };
  const resolvedOut = resolve(outDir);
  mkdirSync(resolvedOut, { recursive: true });
  await writeJsonAtomic(join(resolvedOut, 'report.json'), report);
  await writeTextAtomic(
    join(resolvedOut, 'report.md'),
    renderLocalModulationMarkdown(report),
  );
  console.log(`REPORT ${resolvedOut}: ${entries.length} WAV`);
  return report;
}

/**
 * Разбирает только повторяемый --wav и обязательный --out.
 *
 * @returns Завершается после записи JSON и Markdown
 * @throws Error если аргумент неизвестен, значение или --out
 *   отсутствует
 * @remarks Каталоги не сканируются; без явного --wav runner отклоняет
 *   пустой список и не запускает screening.
 */
async function main(): Promise<void> {
  const files: string[] = [];
  let outDir = '';
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === '--wav') {
      files.push(value);
    } else if (key === '--out') {
      outDir = value;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
    index += 1;
  }
  if (outDir === '') {
    throw new Error(
      'Usage: local-modulation-report --wav FILE [--wav FILE ...] --out DIR',
    );
  }
  await runLocalModulationReport(files, outDir);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
