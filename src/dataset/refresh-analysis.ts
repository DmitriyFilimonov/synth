/**
 * Обновляет анализ датасета одной командой: извлечение признаков,
 * потом оба анализа стабильности. Это вторая половина договора
 * «переобучение одной командой» (первая — build-dataset.ts):
 * на новом наборе таргетов гоняем build-dataset, затем refresh-analysis.
 *
 * Запуск:
 *   npx tsx src/dataset/refresh-analysis.ts --dataset datasets/reference-4
 *
 * Терпим к неполному датасету: все три шага пропускают
 * незавершённые прогоны, поэтому команду можно повторять по мере
 * готовности прогонов.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Одна ступень обновления: модуль и его лог-метка. */
interface AnalysisStep {
  script: string;
  label: string;
}

/** Ступени обновления в порядке зависимостей. */
const STEPS: AnalysisStep[] = [
  { script: 'extract-features.ts', label: 'features' },
  { script: 'analyze-stability.ts', label: 'stability' },
  {
    script: 'analyze-oscillator-stability.ts',
    label: 'oscillator-stability',
  },
];

/**
 * Гоняет одну ступень через tsx-подпроцесс с наследованным выводом.
 * Ошибка ступени не роняет остальные: печатаем и идём дальше.
 *
 * @param script - Имя модуля ступени рядом с этим файлом
 * @param datasetDir - Каталог датасета для аргумента --dataset
 * @returns true, если ступень завершилась успешно
 */
function runStep(script: string, datasetDir: string): boolean {
  try {
    execFileSync(
      'npx',
      ['tsx', resolve(__dirname, script), '--dataset', datasetDir],
      { stdio: 'inherit' },
    );
    return true;
  } catch (error) {
    console.error(
      `FAIL step ${script}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return false;
  }
}

/** Точка входа: гоняет ступени по порядку, печатает сводку. */
function main(): void {
  const argv = process.argv.slice(2);
  const datasetIdx = argv.indexOf('--dataset');
  const datasetArg =
    datasetIdx >= 0 ? argv[datasetIdx + 1] : undefined;
  if (datasetArg === undefined) {
    console.error('Usage: --dataset <dir>');
    process.exitCode = 1;
    return;
  }
  const datasetDir = resolve(datasetArg);

  let failed = 0;
  for (const step of STEPS) {
    console.log(`STEP ${step.label}`);
    if (!runStep(step.script, datasetDir)) {
      failed += 1;
    }
  }
  console.log(
    `SUMMARY analysis refreshed: ${STEPS.length - failed}/${STEPS.length} steps ok`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
