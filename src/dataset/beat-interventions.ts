/* eslint-disable no-console */
/**
 * Вмешательство для Q2: удаляет вторую подобранную компоненту,
 * сохраняет WAV и проверяет, исчезает ли кандидат биения при повторном
 * анализе. Не меняет исходные файлы.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readWav } from '../read-wav';
import { writeWav } from '../write-wav';
import { fitDampedBeat, removeFittedComponent } from './beat-model';
import type { BeatReport } from './beat-report';
import { writeJsonAtomic, writeTextAtomic } from './shared';

/** Результат одного вмешательства и повторной подгонки. */
export interface BeatInterventionResult {
  file: string;
  outputWav: string;
  originalAccepted: boolean;
  changedAccepted: boolean;
  originalPairValR2: number;
  changedPairValR2: number | null;
  changedValGain: number | null;
  changedReasons: string[];
}

/**
 * Пишет таблицу исходов без объявления остальных критериев закрытыми.
 *
 * @param results - Записи обо всех исходно принятых кандидатах;
 *   отсутствие модели после вмешательства сохраняется как `no-model`
 * @returns Markdown-отчёт; числитель сводки считает кандидатов,
 *   отклонённых после абляции, а знаменатель равен их общему числу
 */
export function renderBeatInterventionsMarkdown(
  results: BeatInterventionResult[],
): string {
  const separated = results.filter(
    (result) => result.originalAccepted && !result.changedAccepted,
  ).length;
  const lines = [
    '# Абляция второй компоненты у принятых кандидатов',
    '',
    `Повторное отклонение после абляции: ${separated}/${results.length}. Показатель относится только к исходно принятым кандидатам и не измеряет долю Q2 по всем эталонам.`,
    '',
    '| Файл | R² пары до | R² пары после | Выигрыш после | Итог |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  for (const result of results) {
    lines.push(
      `| ${result.file} | ${result.originalPairValR2.toFixed(3)} | ${result.changedPairValR2?.toFixed(3) ?? '—'} | ${result.changedValGain?.toFixed(3) ?? '—'} | ${result.changedAccepted ? 'остался' : 'исчез: ' + result.changedReasons.join(', ')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Удаляет вторую компоненту у каждого принятого кандидата из отчёта.
 *
 * @remarks Принимает `--report FILE --out DIR`. Изменённый WAV
 *   сохраняется до повторной подгонки. Если она возвращает `null`,
 *   результат всё равно входит в отчёт с `changedAccepted=false`
 *   и причиной `no-model`. Порядковый префикс в имени WAV не даёт
 *   одноимённым входам из разных каталогов перезаписать друг друга.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (
    argv.length !== 4 ||
    argv[0] !== '--report' ||
    argv[2] !== '--out'
  ) {
    throw new Error(
      'Usage: beat-interventions --report FILE --out DIR',
    );
  }
  const reportPath = resolve(argv[1] ?? '');
  const outDir = resolve(argv[3] ?? '');
  const report = JSON.parse(
    readFileSync(reportPath, 'utf8'),
  ) as BeatReport;
  const accepted = report.entries.filter(
    (entry) => entry.fit?.accepted === true && entry.f0 !== null,
  );
  mkdirSync(outDir, { recursive: true });
  const results: BeatInterventionResult[] = [];
  for (const [index, entry] of accepted.entries()) {
    const fit = entry.fit;
    if (fit === null || entry.f0 === null) {
      continue;
    }
    const wav = readWav(entry.file);
    const changed = removeFittedComponent(
      wav.samples,
      fit,
      'second',
      wav.sampleRate,
    );
    const int16 = Int16Array.from(changed, (value) =>
      Math.round(Math.max(-32768, Math.min(32767, value))),
    );
    const outputWav = join(
      outDir,
      `${String(index + 1).padStart(2, '0')}-${basename(entry.file)}-single.wav`,
    );
    writeWav({
      samples: int16,
      sampleRate: wav.sampleRate,
      filePath: outputWav,
    });
    const after = fitDampedBeat(int16, fit.f0, wav.sampleRate);
    const result: BeatInterventionResult = {
      file: entry.file,
      outputWav,
      originalAccepted: fit.accepted,
      changedAccepted: after?.accepted ?? false,
      originalPairValR2: fit.pairValR2,
      changedPairValR2: after?.pairValR2 ?? null,
      changedValGain: after?.valGain ?? null,
      changedReasons: after?.rejectionReasons ?? ['no-model'],
    };
    results.push(result);
    console.log(
      `${basename(entry.file)}: before=${result.originalPairValR2.toFixed(3)} ` +
        `after=${result.changedPairValR2?.toFixed(3) ?? 'no-model'} accepted=${result.changedAccepted}`,
    );
  }
  const separated = results.filter(
    (result) => result.originalAccepted && !result.changedAccepted,
  ).length;
  await writeJsonAtomic(join(outDir, 'beat-interventions.json'), {
    version: 1,
    createdAt: new Date().toISOString(),
    reportPath,
    separated,
    total: results.length,
    results,
  });
  await writeTextAtomic(
    join(outDir, 'beat-interventions.md'),
    renderBeatInterventionsMarkdown(results),
  );
  console.log(`SEPARATED ${separated}/${results.length}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
