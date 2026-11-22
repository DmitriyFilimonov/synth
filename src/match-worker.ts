import { Worker } from 'worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import type { ArgCreateSynth, PhaseModel } from './synth';
import type { CoordinateDescentConfig } from './optimize/coordinate-descent';

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
  /** Модель фазы; без неё — legacy. */
  phaseModel?: PhaseModel;
  /**
   * Переопределения CD, включая анкеры и сохранение флагов для C4.
   * Без этого поля worker ведёт обычный match. Пустой список
   * frozenParameterIndices и preserveOscillatorFlags=false сохраняют
   * прежнее поведение оптимизатора.
   */
  config?: Partial<CoordinateDescentConfig>;
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
 *   конфиг CD, колбэки логов и прогресса
 * @returns Промис с историей, метриками suppression, лучшим вектором
 *   и конфигом синтезатора
 * @throws Error Отклоняет промис при ошибке worker'а или при его
 *   выходе без результата, включая выход с нулевым кодом
 * @remarks Сообщения worker'а с типом `log` уходят в `arg.onLog`, а без
 *   него — в stdout процесса. Поле `arg.config` передаётся в coordinate
 *   descent. После `done` или `error` функция завершает worker и
 *   игнорирует повторные события. Без `arg.config`, с пустым списком
 *   анкеров и preserveOscillatorFlags=false worker выполняет обычный
 *   match без изменений.
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
    let settled = false;
    const stopWorker = (): void => {
      void worker.terminate().catch(() => {});
    };

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
        if (settled) {
          return;
        }
        settled = true;
        resolveFn(msg.data as MatchWorkerResult);
        stopWorker();
      } else if (msg.type === 'error') {
        if (settled) {
          return;
        }
        settled = true;
        rejectFn(new Error(msg.data as string));
        stopWorker();
      }
    });

    worker.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectFn(err instanceof Error ? err : new Error(String(err)));
      stopWorker();
    });

    worker.on('exit', (code) => {
      if (!settled) {
        settled = true;
        rejectFn(
          new Error(
            code === 0
              ? 'Worker exited without a result'
              : `Worker stopped with exit code ${code}`,
          ),
        );
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
      phaseModel: arg.phaseModel,
      config: arg.config,
    });
  });
}
