import { Worker } from 'worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import type { ArgCreateSynth } from './synth';

/** Точка истории прогресса оптимизации от worker'а. */
export interface MatchWorkerProgress {
  /** Номер завершённой итерации coordinate descent. */
  iteration: number;
  /** Текущий windowed-score (surrogate J), проценты. */
  suppressionPercent: number;
  /** Необязательная метка фазы или события спуска. */
  status?: string;
  /** Snapshot of best-so-far normalized parameter vector. */
  bestVector?: readonly number[];
}

/** Результат прогона оптимизации в worker-потоке. */
export interface MatchWorkerResult {
  history: MatchWorkerProgress[];
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  };
  suppressionPercent: number;
  /** Честный глобальный suppression финального WAV; null, если оценка не удалась */
  globalSuppressionPercent: number | null;
  bestVector: number[];
  synthConfig: ArgCreateSynth;
}

/** Аргументы запуска оптимизации в worker-потоке. */
interface MatchWorkerArgs {
  /** Путь к WAV-файлу таргета. */
  targetWavPath: string;
  /** Путь для записи синтезированного WAV. */
  outputWavPath: string;
  /** Стартовый вектор осцилляторов, нормализованный в [0, 1]. */
  initialVector: number[];
  /** Частота дискретизации, Гц. */
  sampleRate: number;
  /** Бюджет итераций coordinate descent. */
  maxIterations: number;
  /** Множитель веса окон атаки в метрике; 1 — без усиления. */
  attackBoost?: number;
  /** Приращение шага при серии успехов (см. coordinate-descent). */
  stepGrowthAdd?: number;
  /** Множитель затухания шага на плато. */
  stepDecayFactor?: number;
  /** Сид ГПСЧ оптимизатора; без него прогон идёт с дефолтным сидом. */
  seed?: number;
  /**
   * Куда писать логи worker'а. По умолчанию — в stdout процесса;
   * батч-раннеры перенаправляют в файл прогона, чтобы не шуметь.
   */
  onLog?: (line: string) => void;
  onProgress?: (entry: MatchWorkerProgress) => void;
}

/**
 * Выбирает файл worker'а: `.ts` через tsx при запуске из
 * исходников, иначе собранный `.js` из `dist/`.
 *
 * @returns Спецификатор worker'а и execArgv для tsx, если нужен
 */
function resolveWorkerPath(): {
  specifier: string | URL;
  execArgv?: string[];
} {
  const tsPath = resolve(__dirname, 'optimizer-worker.ts');
  if (existsSync(tsPath)) {
    return {
      specifier: new URL(pathToFileURL(tsPath).href),
      execArgv: ['--require', require.resolve('tsx/cjs')],
    };
  }
  const jsPath = resolve(__dirname, 'optimizer-worker.js');
  return { specifier: jsPath };
}

/**
 * Запускает оптимизацию в отдельном worker-потоке и возвращает
 * промис с результатом прогона.
 *
 * @param arg - Параметры прогона: таргет, init-вектор, сид,
 *   колбэки логов и прогресса
 * @returns История прогресса, метрики suppression, лучший
 *   вектор и конфиг синтезатора
 * @remarks Промис отклоняется при ошибке worker'а и при
 *   ненулевом коде его выхода. Сообщения worker'а с типом `log`
 *   уходят в `arg.onLog`, а без него — в stdout процесса.
 */
export function matchWithWorker(
  arg: MatchWorkerArgs,
): Promise<MatchWorkerResult> {
  return new Promise((resolveFn, rejectFn) => {
    const { specifier, execArgv } = resolveWorkerPath();
    const worker = new Worker(specifier, {
      workerData: {},
      ...(execArgv ? { execArgv } : {}),
    });

    worker.on('message', (msg: { type: string; data: unknown }) => {
      if (msg.type === 'log') {
        const line = msg.data as string;
        if (arg.onLog) {
          arg.onLog(line);
        } else {
          process.stdout.write(line + '\n');
        }
      } else if (msg.type === 'progress') {
        arg.onProgress?.(msg.data as MatchWorkerProgress);
      } else if (msg.type === 'done') {
        resolveFn(msg.data as MatchWorkerResult);
      } else if (msg.type === 'error') {
        rejectFn(new Error(msg.data as string));
      }
    });

    worker.on('error', (err) => {
      rejectFn(err instanceof Error ? err : new Error(String(err)));
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        rejectFn(new Error(`Worker stopped with exit code ${code}`));
      }
    });

    worker.postMessage({
      targetWavPath: arg.targetWavPath,
      outputWavPath: arg.outputWavPath,
      initialVector: arg.initialVector,
      sampleRate: arg.sampleRate,
      maxIterations: arg.maxIterations,
      attackBoost: arg.attackBoost,
      stepGrowthAdd: arg.stepGrowthAdd,
      stepDecayFactor: arg.stepDecayFactor,
      seed: arg.seed,
    });
  });
}
