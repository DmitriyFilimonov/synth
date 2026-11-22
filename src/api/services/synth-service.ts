/* eslint-disable no-console */
import {
  ArgCreateSynth,
  createSynth,
  type PhaseModel,
  type SynthOptions,
} from '../../synth';
import { writeWav } from '../../write-wav';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../../consts';
import {
  matchWithWorker,
  type MatchWorkerProgress,
  type MatchWorkerResult,
} from '../../match-worker';
import { dualWindowInitVector } from '../../dual-window-init-vector';
import { mapSynthConfigToVector } from '../../synth-config-to-vector';
import { mapVectorToSynthConfig } from '../../vector-to-synth-config';
import { enhancePatch, type PriorsFile } from '../../enhance/engine';
import { correctPatch } from '../../enhance/correct';
import { type TransformAudit } from '../../enhance/transforms';
import { DEFAULT_IDENTIFIABILITY } from '../../enhance/defaults';
import {
  createRefinementPlan,
  limitRefinementPeak,
} from '../../enhance/refinement';
import { evaluateSuppressionFromWaveform } from '../../optimize/evaluate';
import { renderSamples } from '../../dataset/shared';
import { readWav } from '../../read-wav';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  unlink,
  readFile,
  writeFile,
  copyFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  createJob,
  updateJobStatus,
  getInputFilePath,
  getResultFilePath,
} from './job-store';

function formatRussianDateTime(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

function generateJobName(targetFileName?: string): string {
  const baseName = targetFileName?.trim() || 'target';
  const timestamp = formatRussianDateTime(new Date());
  return `${baseName} ${timestamp}`;
}

interface GeneratedFile {
  buffer: Buffer;
  sampleRate: number;
  duration: number;
}

interface MatchedFile {
  buffer: Buffer;
  history: {
    iteration: number;
    suppressionPercent: number;
  }[];
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  };
  suppressionPercent: number;
  /** Честный глобальный suppression финального WAV; null, если оценка не удалась */
  globalSuppressionPercent: number | null;
  synthConfig: ArgCreateSynth;
}

export async function generateWav(
  synthConfig: ArgCreateSynth,
  duration: number,
  sampleRate: number,
  options: SynthOptions = {},
): Promise<GeneratedFile> {
  const totalSamples = Math.floor(sampleRate * duration);
  const synth = createSynth(synthConfig, options);
  const samples = new Int16Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const timeSeconds = i / sampleRate;
    const sample = synth({ x: timeSeconds });
    samples[i] = Math.round(
      sample * MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    );
  }

  const tempFile = join(tmpdir(), `${randomUUID()}.wav`);
  writeWav({ samples, sampleRate, filePath: tempFile });

  if (!existsSync(tempFile)) {
    throw new Error('Failed to generate WAV file');
  }

  const buffer = await readFile(tempFile);
  await unlink(tempFile).catch(() => {});

  return { buffer, sampleRate, duration };
}

export async function matchWav(
  wavBuffer: Buffer,
  numOscillators: number,
  maxIterations: number,
  stepGrowthAdd?: number,
  stepDecayFactor?: number,
  attackBoost?: number,
): Promise<MatchedFile> {
  const tempInput = join(tmpdir(), `${randomUUID()}_input.wav`);
  const tempOutput = join(tmpdir(), `${randomUUID()}_output.wav`);

  await writeFile(tempInput, wavBuffer);

  try {
    const history: {
      iteration: number;
      suppressionPercent: number;
    }[] = [];

    const targetWavData = readWav(tempInput);
    const initialVector = dualWindowInitVector(
      targetWavData.samples,
      SAMPLE_RATE,
      numOscillators,
    );

    const result = await matchWithWorker({
      targetWavPath: tempInput,
      outputWavPath: tempOutput,
      initialVector,
      sampleRate: 44100,
      maxIterations,
      attackBoost,
      stepGrowthAdd,
      stepDecayFactor,
      onProgress: (entry) => {
        // Drop bestVector to keep response history compact.
        const { bestVector: _bv, ...historyEntry } = entry;
        history.push(historyEntry);
      },
    });

    if (!existsSync(tempOutput)) {
      throw new Error('Failed to generate matched WAV file');
    }

    const outBuffer = await readFile(tempOutput);

    return {
      buffer: outBuffer,
      history,
      targetInfo: result.targetInfo,
      suppressionPercent:
        history.length > 0
          ? (history[history.length - 1]?.suppressionPercent ?? 0)
          : 0,
      globalSuppressionPercent:
        result.globalSuppressionPercent ?? null,
      synthConfig: result.synthConfig,
    };
  } finally {
    await unlink(tempInput).catch(() => {});
    await unlink(tempOutput).catch(() => {});
  }
}

export async function matchWavWithJob(
  wavBuffer: Buffer,
  numOscillators: number,
  maxIterations: number,
  stepGrowthAdd?: number,
  stepDecayFactor?: number,
  targetFileName?: string,
  attackBoost?: number,
  seed?: number,
  phaseModel?: PhaseModel,
): Promise<string> {
  const jobId = randomUUID();
  const inputFileName = `${jobId}_input.wav`;
  const jobName = generateJobName(targetFileName);

  await createJob(
    jobId,
    {
      numOscillators,
      maxIterations,
      stepGrowthAdd,
      stepDecayFactor,
      attackBoost,
      seed,
      phaseModel,
    },
    inputFileName,
    jobName,
  );

  const inputPath = getInputFilePath(jobId);
  await writeFile(inputPath, wavBuffer);

  setImmediate(() => {
    runMatchJob(
      jobId,
      numOscillators,
      maxIterations,
      inputPath,
      stepGrowthAdd,
      stepDecayFactor,
      attackBoost,
      seed,
      phaseModel,
    ).catch((err) => {
      const message =
        err instanceof Error ? err.message : 'Unknown error';
      updateJobStatus(jobId, 'failed', {
        errorMessage: message,
      }).catch(() => {});
    });
  });

  return jobId;
}

async function runMatchJob(
  jobId: string,
  numOscillators: number,
  maxIterations: number,
  inputPath: string,
  stepGrowthAdd?: number,
  stepDecayFactor?: number,
  attackBoost?: number,
  seed?: number,
  phaseModel?: PhaseModel,
): Promise<void> {
  const tempOutput = join(tmpdir(), `${randomUUID()}_output.wav`);
  const history: {
    iteration: number;
    suppressionPercent: number;
  }[] = [];
  let lastUpdateMs = 0;
  const UPDATE_THROTTLE_MS = 1000;
  // Latest best-so-far snapshot from the optimizer. Kept out of
  // `history` (which is trimmed for OOM safety) so we always have
  // the freshest vector to persist even after history rotation.
  let latestBestVector: number[] | null = null;

  try {
    await updateJobStatus(jobId, 'running');

    const targetWavData = readWav(inputPath);
    const initialVector = dualWindowInitVector(
      targetWavData.samples,
      SAMPLE_RATE,
      numOscillators,
    );

    const result = await matchWithWorker({
      targetWavPath: inputPath,
      outputWavPath: tempOutput,
      initialVector,
      sampleRate: 44100,
      maxIterations,
      attackBoost,
      stepGrowthAdd,
      stepDecayFactor,
      seed,
      phaseModel,
      onProgress: (entry) => {
        // Strip bestVector from history entries — it bloats the
        // job.json file and duplicates data we persist separately.
        const { bestVector: entryVector, ...historyEntry } = entry;
        history.push(historyEntry);
        // Cap history to prevent job.json from ballooning past the
        // JSON stringify threshold on long runs; matches optimizer-
        // worker safeguard. Trims oldest entries.
        if (history.length > 10000) {
          history.splice(0, 5000);
        }
        if (entryVector !== undefined) {
          latestBestVector = [...entryVector];
        }
        const now = Date.now();
        if (now - lastUpdateMs >= UPDATE_THROTTLE_MS) {
          lastUpdateMs = now;
          // Persist progress + latest best snapshot so a running
          // job exposes its intermediate synth config. Any failure
          // here (I/O hiccup) must not break optimization; the
          // updateJobStatus promise is fire-and-forget with its own
          // internal error logging.
          const update: Parameters<typeof updateJobStatus>[2] = {
            progress: [...history],
            suppressionPercent: entry.suppressionPercent,
          };
          if (latestBestVector !== null) {
            update.bestVector = latestBestVector;
            update.synthConfig = mapVectorToSynthConfig([
              ...latestBestVector,
            ]);
          }
          void updateJobStatus(jobId, 'running', update);
        }
      },
    });

    const resultPath = getResultFilePath(jobId);
    await copyFile(tempOutput, resultPath);

    await updateJobStatus(jobId, 'completed', {
      progress: history,
      suppressionPercent:
        history.length > 0
          ? (history[history.length - 1]?.suppressionPercent ?? 0)
          : 0,
      globalSuppressionPercent:
        result.globalSuppressionPercent ?? null,
      targetInfo: result.targetInfo,
      bestVector: result.bestVector,
      synthConfig: result.synthConfig,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    try {
      await updateJobStatus(jobId, 'failed', {
        errorMessage: message,
      });
    } catch (reportError) {
      console.error(
        `Failed to report error for job ${jobId}:`,
        reportError,
      );
    }
  } finally {
    await unlink(tempOutput).catch(() => {});
  }
}

/**
 * Создаёт job улучшения бочки: match + улучшение патча приорами +
 * синтез улучшенного WAV. Стадии и контракт — по
 * `docs/spec-kick-enhancement.md` (C4, C5).
 */
export async function enhanceWavWithJob(
  wavBuffer: Buffer,
  numOscillators: number,
  maxIterations: number,
  enhancementStrength: number,
  targetFileName?: string,
  seed?: number,
  refineIterations?: number,
  phaseModel?: PhaseModel,
): Promise<string> {
  const jobId = randomUUID();
  const inputFileName = `${jobId}_input.wav`;
  const jobName = generateJobName(targetFileName);

  await createJob(
    jobId,
    {
      numOscillators,
      maxIterations,
      enhancementStrength,
      seed,
      refineIterations,
      phaseModel,
    },
    inputFileName,
    jobName,
  );

  const inputPath = getInputFilePath(jobId);
  await writeFile(inputPath, wavBuffer);

  setImmediate(() => {
    runEnhanceJob(
      jobId,
      numOscillators,
      maxIterations,
      inputPath,
      enhancementStrength,
      seed,
      refineIterations ?? 0,
      phaseModel,
    ).catch((err) => {
      const message =
        err instanceof Error ? err.message : 'Unknown error';
      updateJobStatus(jobId, 'failed', {
        errorMessage: message,
      }).catch(() => {});
    });
  });

  return jobId;
}

/** Читает приоры из файла; отсутствие — null (улучшение пройдёт пустым). */
async function loadPriors(
  priorsPath: string,
): Promise<PriorsFile | null> {
  if (!existsSync(priorsPath)) {
    return null;
  }
  try {
    const raw = await readFile(priorsPath, 'utf8');
    return JSON.parse(raw) as PriorsFile;
  } catch {
    return null;
  }
}

type EnhanceProgressEntry = Omit<MatchWorkerProgress, 'bestVector'>;

/**
 * Создаёт колбэки прогресса match и C4 с общей историей job.
 *
 * @param jobId - Идентификатор job, чей статус обновляется
 * @param refinementOffset - Смещение номеров итераций C4 в общей
 *   истории
 * @returns Общую историю и отдельные колбэки для match и C4
 * @remarks История пополняется на каждый вызов, а запись статуса
 *   ограничена интервалом в одну секунду. Match сохраняет последний
 *   bestVector между обновлениями; C4 передаёт только собственный
 *   вектор. Ошибки записи статуса игнорируются, чтобы не остановить
 *   вычисления.
 */
function createEnhanceJobProgressReporter(
  jobId: string,
  refinementOffset: number,
): {
  history: EnhanceProgressEntry[];
  onMatchProgress: (entry: MatchWorkerProgress) => void;
  onRefinementProgress: (entry: MatchWorkerProgress) => void;
} {
  const history: EnhanceProgressEntry[] = [];
  const updateThrottleMs = 1000;
  let lastUpdateMs = 0;
  let latestBestVector: number[] | null = null;

  const report = (
    entry: MatchWorkerProgress,
    bestVector: readonly number[] | undefined,
  ): void => {
    const now = Date.now();
    if (now - lastUpdateMs < updateThrottleMs) {
      return;
    }
    lastUpdateMs = now;
    const update: Parameters<typeof updateJobStatus>[2] = {
      progress: [...history],
      suppressionPercent: entry.suppressionPercent,
    };
    if (bestVector !== undefined) {
      update.bestVector = [...bestVector];
      update.synthConfig = mapVectorToSynthConfig([...bestVector]);
    }
    // Ошибка записи статуса не должна останавливать синтез.
    void updateJobStatus(jobId, 'running', update).catch(() => {});
  };

  return {
    history,
    onMatchProgress: (entry): void => {
      const { bestVector, ...historyEntry } = entry;
      history.push(historyEntry);
      if (bestVector !== undefined) {
        latestBestVector = [...bestVector];
      }
      report(entry, latestBestVector ?? undefined);
    },
    onRefinementProgress: (entry): void => {
      history.push({
        iteration: refinementOffset + entry.iteration,
        suppressionPercent: entry.suppressionPercent,
      });
      // C4 не использует последний bestVector основного match.
      report(entry, entry.bestVector);
    },
  };
}

/**
 * Читает таргет, строит init-вектор и запускает основной match.
 *
 * @param args - Пути к WAV, бюджет, сид, модель фазы и колбэк прогресса
 * @returns Разобранный таргет и полный результат worker-потока
 * @throws Error если входной WAV не читается или worker завершает match
 *   с ошибкой
 * @remarks Init-вектор строится dualWindowInitVector с SAMPLE_RATE;
 *   worker пишет основной match во временный tempOutput.
 */
async function matchEnhancementTarget(args: {
  inputPath: string;
  tempOutput: string;
  numOscillators: number;
  maxIterations: number;
  seed?: number;
  phaseModel?: PhaseModel;
  onProgress: (entry: MatchWorkerProgress) => void;
}): Promise<{
  targetWavData: ReturnType<typeof readWav>;
  result: MatchWorkerResult;
}> {
  const targetWavData = readWav(args.inputPath);
  const initialVector = dualWindowInitVector(
    targetWavData.samples,
    SAMPLE_RATE,
    args.numOscillators,
  );
  const result = await matchWithWorker({
    targetWavPath: args.inputPath,
    outputWavPath: args.tempOutput,
    initialVector,
    sampleRate: SAMPLE_RATE,
    maxIterations: args.maxIterations,
    seed: args.seed,
    phaseModel: args.phaseModel,
    onProgress: args.onProgress,
  });
  return { targetWavData, result };
}

/**
 * Исправляет анкеры режимом B и заполняет свободные параметры режимом
 * A по приорам.
 *
 * @param args - Патч основного match, сила улучшения и модель фазы
 * @returns Улучшенный патч и объединённый журнал обеих трансформаций
 * @remarks Путь к приорам задаёт ENHANCE_PRIORS_PATH; по умолчанию
 *   используется datasets/reference-4/priors.json. Если файл отсутствует
 *   или не читается, функция возвращает исходный патч с пустым журналом.
 *   Перенос множителей тела отключён, пока закон качества не доказан.
 */
async function enhanceMatchedPatch(args: {
  patch: ArgCreateSynth;
  enhancementStrength: number;
  phaseModel?: PhaseModel;
}): Promise<{ patch: ArgCreateSynth; audits: TransformAudit[] }> {
  const priorsPath =
    process.env.ENHANCE_PRIORS_PATH ??
    join(process.cwd(), 'datasets', 'reference-4', 'priors.json');
  const priors = await loadPriors(priorsPath);
  if (priors === null) {
    return { patch: args.patch, audits: [] };
  }
  const corrected = correctPatch({
    patch: args.patch,
    priors,
    strength: args.enhancementStrength,
  });
  const filled = enhancePatch({
    patch: corrected.patch,
    identifiability: DEFAULT_IDENTIFIABILITY,
    priors,
    strength: args.enhancementStrength,
    phaseModel: args.phaseModel,
    // Перенос множителей тела не доказан как закон (T17).
    enrichBody: false,
  });
  return {
    patch: filled.patch,
    audits: [...corrected.audits, ...filled.audits],
  };
}

/** Задаёт исходный патч, таргет и настройки одного прогона C4. */
interface RefineEnhancedPatchArgs {
  patch: ArgCreateSynth;
  inputPath: string;
  numSamples: number;
  iterations: number;
  seed?: number;
  phaseModel?: PhaseModel;
  onProgress: (entry: MatchWorkerProgress) => void;
}

/** Объединяет результат C4, его сэмплы и запись для журнала. */
interface RefinedPatch {
  patch: ArgCreateSynth;
  samples: Int16Array;
  audit: TransformAudit;
}

/**
 * Доводит улучшенный патч к исходному WAV с ограничениями C4.
 *
 * @param args - Патч, путь к исходному WAV, длина, бюджет и колбэк
 *   прогресса
 * @returns Доведённый патч, его сэмплы и запись c4Refinement
 * @throws Error если worker не завершает доводку успешно
 * @remarks createRefinementPlan закрепляет анкеры и сохраняет флаги.
 *   После worker функция применяет limitRefinementPeak и синтезирует
 *   ровно numSamples сэмплов. Временный WAV удаляется даже при ошибке.
 */
async function refineEnhancedPatch(
  args: RefineEnhancedPatchArgs,
): Promise<RefinedPatch> {
  const tempRefined = join(tmpdir(), `${randomUUID()}_ref.wav`);
  try {
    const refinement = createRefinementPlan(
      args.patch,
      DEFAULT_IDENTIFIABILITY,
    );
    const refined = await matchWithWorker({
      targetWavPath: args.inputPath,
      outputWavPath: tempRefined,
      initialVector: refinement.initialVector,
      sampleRate: SAMPLE_RATE,
      maxIterations: args.iterations,
      seed: args.seed,
      phaseModel: args.phaseModel,
      config: refinement.config,
      onProgress: args.onProgress,
    });
    const peakLimit = limitRefinementPeak(
      refined.synthConfig,
      DEFAULT_IDENTIFIABILITY,
      { phaseModel: args.phaseModel },
    );
    return {
      patch: peakLimit.patch,
      samples: renderSamples(
        peakLimit.patch,
        args.numSamples / SAMPLE_RATE,
        { phaseModel: args.phaseModel },
      ),
      audit: {
        name: 'c4Refinement',
        detail: `Доводка к исходному WAV: бюджет ${args.iterations} итераций, анкеров ${refinement.config.frozenParameterIndices?.length ?? 0}; ${peakLimit.skipReason ?? 'после неё применён потолок пика'}`,
      },
    };
  } finally {
    await unlink(tempRefined).catch(() => {});
  }
}

/**
 * Рендерит улучшенный патч и при ненулевом бюджете запускает C4.
 *
 * @param args - Патч, журнал, исходный WAV, бюджет C4 и колбэк прогресса
 * @returns Итоговый патч, сэмплы и журнал трансформаций
 * @throws Error если запрошенная доводка завершается ошибкой
 * @remarks При refineIterations <= 0 функция возвращает исходный
 *   улучшенный патч и его сэмплы без новых записей. Иначе она заменяет
 *   их результатом refineEnhancedPatch и добавляет аудит C4 в конец
 *   журнала.
 */
async function renderAndRefineEnhancedPatch(args: {
  patch: ArgCreateSynth;
  audits: TransformAudit[];
  inputPath: string;
  numSamples: number;
  refineIterations: number;
  seed?: number;
  phaseModel?: PhaseModel;
  onProgress: (entry: MatchWorkerProgress) => void;
}): Promise<{
  patch: ArgCreateSynth;
  samples: Int16Array;
  audits: TransformAudit[];
}> {
  const samples = renderSamples(
    args.patch,
    args.numSamples / SAMPLE_RATE,
    { phaseModel: args.phaseModel },
  );
  if (args.refineIterations <= 0) {
    return {
      patch: args.patch,
      samples,
      audits: args.audits,
    };
  }
  const refined = await refineEnhancedPatch({
    patch: args.patch,
    inputPath: args.inputPath,
    numSamples: args.numSamples,
    iterations: args.refineIterations,
    seed: args.seed,
    phaseModel: args.phaseModel,
    onProgress: args.onProgress,
  });
  return {
    patch: refined.patch,
    samples: refined.samples,
    audits: [...args.audits, refined.audit],
  };
}

/**
 * Сохраняет отдельно чистый match и окончательный улучшенный WAV.
 *
 * @param jobId - Идентификатор job, определяющий пути артефактов
 * @param tempOutput - Временный WAV основного match
 * @param samples - Сэмплы окончательного улучшенного варианта
 * @returns Промис, который завершается после записи обоих WAV
 * @throws Error если копирование match или запись результата не удалась
 * @remarks Основной match сохраняется рядом с результатом с суффиксом
 *   _match.wav; итоговый WAV занимает стандартный путь _result.wav.
 */
async function writeEnhanceArtifacts(
  jobId: string,
  tempOutput: string,
  samples: Int16Array,
): Promise<void> {
  const resultPath = getResultFilePath(jobId);
  const matchPath = resultPath.replace(/_result\.wav$/, '_match.wav');
  await copyFile(tempOutput, matchPath);
  writeWav({
    samples,
    sampleRate: SAMPLE_RATE,
    filePath: resultPath,
  });
}

/**
 * Считает global suppression улучшенного WAV против исходного таргета.
 *
 * @param samples - Сэмплы окончательного улучшенного варианта
 * @param targetSamples - Сэмплы исходного таргета той же длины
 * @returns Глобальный suppression в процентах либо null при ошибке
 * @remarks Оценка не влияет на уже записанные артефакты: любое
 *   исключение метрики превращается в null.
 */
function evaluateEnhanceGlobal(
  samples: Int16Array,
  targetSamples: Int16Array,
): number | null {
  try {
    return evaluateSuppressionFromWaveform(
      [...samples],
      [...targetSamples],
    );
  } catch {
    return null;
  }
}

/**
 * Выполняет job улучшения: подбирает патч по исходному WAV,
 * исправляет и достраивает его по приорам, при необходимости
 * запускает C4 и сохраняет артефакты и метрики в job.
 *
 * @param jobId - Идентификатор job улучшения
 * @param numOscillators - Число осцилляторов в стартовом векторе match
 * @param maxIterations - Бюджет итераций основного match
 * @param inputPath - Путь к исходному WAV
 * @param enhancementStrength - Сила исправлений и достраивания от 0 до 1
 * @param seed - Сид ГПСЧ для match и C4; без него действует дефолт CD
 * @param refineIterations - Бюджет C4; 0 пропускает доводку
 * @param phaseModel - Модель фазы синтеза; без неё действует legacy
 * @returns Промис, который завершается после обработки job
 * @remarks C4 стартует с улучшенного патча и подгоняет свободные
 *   параметры к исходному WAV. Анкеры и флаги on/off сохраняются.
 *   Патч и global основного match остаются в отдельных полях job.
 */
async function runEnhanceJob(
  jobId: string,
  numOscillators: number,
  maxIterations: number,
  inputPath: string,
  enhancementStrength: number,
  seed?: number,
  refineIterations = 0,
  phaseModel?: PhaseModel,
): Promise<void> {
  const tempOutput = join(tmpdir(), `${randomUUID()}_enhance.wav`);
  const reporter = createEnhanceJobProgressReporter(
    jobId,
    maxIterations,
  );

  try {
    await updateJobStatus(jobId, 'running');
    const { targetWavData, result } = await matchEnhancementTarget({
      inputPath,
      tempOutput,
      numOscillators,
      maxIterations,
      seed,
      phaseModel,
      onProgress: reporter.onMatchProgress,
    });
    const enhanced = await enhanceMatchedPatch({
      patch: result.synthConfig,
      enhancementStrength,
      phaseModel,
    });
    const final = await renderAndRefineEnhancedPatch({
      patch: enhanced.patch,
      audits: enhanced.audits,
      inputPath,
      numSamples: targetWavData.samples.length,
      refineIterations,
      seed,
      phaseModel,
      onProgress: reporter.onRefinementProgress,
    });

    await writeEnhanceArtifacts(jobId, tempOutput, final.samples);
    const enhanceGlobal = evaluateEnhanceGlobal(
      final.samples,
      targetWavData.samples,
    );
    await updateJobStatus(jobId, 'completed', {
      progress: reporter.history,
      suppressionPercent:
        reporter.history.length > 0
          ? (reporter.history[reporter.history.length - 1]
              ?.suppressionPercent ?? 0)
          : 0,
      globalSuppressionPercent:
        result.globalSuppressionPercent ?? null,
      targetInfo: result.targetInfo,
      bestVector: mapSynthConfigToVector(final.patch),
      synthConfig: final.patch,
      matchSynthConfig: result.synthConfig,
      enhanceAudit: final.audits,
      enhanceGlobalSuppressionPercent: enhanceGlobal,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    try {
      await updateJobStatus(jobId, 'failed', {
        errorMessage: message,
      });
    } catch (reportError) {
      console.error(
        `Failed to report error for job ${jobId}:`,
        reportError,
      );
    }
  } finally {
    await unlink(tempOutput).catch(() => {});
  }
}
