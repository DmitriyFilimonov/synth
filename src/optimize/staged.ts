import { coordinateDescent } from './coordinate-descent';
import { runHPO } from './hpo';
import type { TPEConfig } from './hpo/sampler-tpe';
import type { ResolvedHyperparams, TrialObservation } from './hpo';
import type {
  ProgressEntry,
  ProgressCallback,
  ArgOptimize,
  CoordinateDescentConfig,
} from './types';
import { OSC_PARAMS } from './consts';
import { oscConfigNormales, ampEnvConfigNormales } from '../synth';
import {
  evaluateSuppressionWindowed,
  createWaveForm,
} from './evaluate';

export interface ArgStagedOptimize extends Omit<
  ArgOptimize,
  'targetSignal'
> {
  targetSignal: readonly number[];

  sampleRate: number;
  maxIterations: number;
  onProgress?: ProgressCallback;
  initialStageMs?: number;
  stageDurationMultiplier?: number;
  maxStageMs?: number;
  hpoTrials?: number;
  tpeConfig?: Partial<TPEConfig>;
  /** Фундаментальная частота (Гц). Если передана, initialStageMs вычисляется автоматически. */
  fundamentalHz?: number;
}

export interface StageResult {
  stageIndex: number;
  stageDurationMs: number;
  stageSamples: number;
  suppressionPercent: number;
  iterations: number;
}

export interface StagedOptimizeResult {
  vector: number[];
  history: ProgressEntry[];
  stageResults: StageResult[];
}

// Диапазоны нормализации длительностей — единственный источник
// истины в synth.ts (те же, что использует vector-to-synth-config.ts)
const OSC_DURATION_MIN = oscConfigNormales.duration.min;
const OSC_DURATION_MAX = oscConfigNormales.duration.max;

/**
 * Вычисляет начальную длительность стадии на основе фундаментальной частоты.
 * Цель — 4..10 полных периодов, результат клампится к [10, 100] мс.
 */
export const computeInitialStageMs = (
  fundamentalHz: number,
): number => {
  if (fundamentalHz <= 0) {
    return 10;
  }
  const periodMs = 1000 / fundamentalHz;
  const minCycles = 4;
  const maxCycles = 10;
  const targetMs = Math.max(
    periodMs * minCycles,
    Math.min(periodMs * maxCycles, periodMs * 7),
  );
  return Math.max(10, Math.min(100, targetMs));
};

const AMP_ENV_DURATION_MIN = ampEnvConfigNormales.duration.min;
const AMP_ENV_DURATION_MAX = ampEnvConfigNormales.duration.max;

// Бюджет вычислений HPO: при коротких стадиях — больше trials,
// при длинных — меньше, координатный спуск стоит дорого.
// База: 20 trials на ~441 сэмпле (10ms), масштабируем обратно
// пропорционально длине сигнала, ограничивая сверху и снизу.
const HPO_TRIALS_REF_SAMPLES = 441;
const HPO_TRIALS_MIN = 3;
const HPO_TRIALS_MAX = 25;

const computeHpoTrialsForStage = (
  stageSamples: number,
  requestedTrials: number,
): number => {
  if (stageSamples <= HPO_TRIALS_REF_SAMPLES) {
    return Math.min(requestedTrials, HPO_TRIALS_MAX);
  }
  const scaleFactor = HPO_TRIALS_REF_SAMPLES / stageSamples;
  const scaled = Math.round(requestedTrials * scaleFactor);
  return Math.max(HPO_TRIALS_MIN, Math.min(scaled, requestedTrials));
};

// Индексы параметров в векторе осциллятора (см. vector-to-synth-config.ts)
const IDX_ON = 0;
const IDX_OSC_DURATION = 4;
const IDX_AMP_ENV_DURATION = 6;

const generateStageDurations = (
  totalSamples: number,
  sampleRate: number,
  initialStageMs: number,
  stageDurationMultiplier: number,
  maxStageMs: number,
): number[] => {
  const totalMs = (totalSamples / sampleRate) * 1000;
  const effectiveMaxStage = Math.min(maxStageMs, totalMs);

  // stageDurationMultiplier must be >= 2.0 for reasonable stage count.
  // Values below 2.0 cause exponential stage proliferation (e.g. 1.1 → 125 stages).
  const effectiveMultiplier = Math.max(stageDurationMultiplier, 2.0);

  const stages: number[] = [];
  let baseMs = initialStageMs;
  let done = false;

  while (!done) {
    const group: number[] = [baseMs];
    if (baseMs + 10 <= effectiveMaxStage) {
      group.push(baseMs + 10);
    }
    if (group.length < 3 && baseMs + 20 <= effectiveMaxStage) {
      group.push(baseMs + 20);
    }

    const lastInGroup = group[group.length - 1] ?? baseMs;

    for (const ms of group) {
      const capped = Math.min(ms, effectiveMaxStage);
      stages.push(capped);
      if (capped >= effectiveMaxStage) {
        done = true;
        break;
      }
    }

    if (!done) {
      baseMs = Math.min(
        lastInGroup * effectiveMultiplier,
        effectiveMaxStage,
      );
    }
  }

  return stages;
};

const denormalizeDuration = (
  normalized: number,
  min: number,
  max: number,
): number => {
  const clipped = Math.max(0, Math.min(1, normalized));
  return clipped * (max - min) + min;
};

const normalizeDuration = (
  value: number,
  min: number,
  max: number,
): number => {
  const clamped = Math.max(min, Math.min(max, value));
  return (clamped - min) / (max - min);
};

/**
 * Экстраполирует вектор между этапами многоэтапной оптимизации:
 * увеличивает osc.duration и ampEnv.duration включённых
 * осцилляторов минимум до новой продолжительности стадии,
 * сохраняя уже оптимизированные параметры (частоты, фазы, slope,
 * startLevel, endLevel) без изменений.
 *
 * @param vector - Нормализованный вектор параметров в [0, 1]
 * @param newDurationMs - Длительность следующей стадии (мс)
 * @returns Новый вектор с растянутыми длительностями
 * @remarks Нормализация/денормализация длительностей использует
 *   диапазоны из `synth.ts` (`oscConfigNormales.duration`,
 *   `ampEnvConfigNormales.duration`: [1/44100, 0.5] сек) — тот же
 *   единственный источник истины, что и
 *   `vector-to-synth-config.ts`. Значения вне [0, 1] клампятся.
 *   Выключенные осцилляторы (flag < 0.5) не изменяются.
 *   Физический смысл: осциллятор уже «научился» звучать на первых
 *   N ms; при расширении фрагмента до M > N ms длительность
 *   растягивается, чтобы он звучал все M ms без искажения формы
 *   огибающей на выученной части.
 */
export const extrapolateVectorBetweenStages = (
  vector: readonly number[],
  newDurationMs: number,
): number[] => {
  const result = [...vector];
  const newDurationSec = newDurationMs / 1000;

  for (let i = 0; i < result.length; i += OSC_PARAMS) {
    const on = result[i + IDX_ON] ?? 0;
    if (on < 0.5) {
      continue;
    }

    // Обновляем osc.duration до новой продолжительности
    const oscDurNorm = result[i + IDX_OSC_DURATION] ?? 0;
    const oscDurationSec = Math.max(
      denormalizeDuration(
        oscDurNorm,
        OSC_DURATION_MIN,
        OSC_DURATION_MAX,
      ),
      newDurationSec,
    );
    result[i + IDX_OSC_DURATION] = normalizeDuration(
      oscDurationSec,
      OSC_DURATION_MIN,
      OSC_DURATION_MAX,
    );

    // Обновляем ampEnv.duration до новой продолжительности
    const ampDurNorm = result[i + IDX_AMP_ENV_DURATION] ?? 0;
    const ampEnvDurationSec = Math.max(
      denormalizeDuration(
        ampDurNorm,
        AMP_ENV_DURATION_MIN,
        AMP_ENV_DURATION_MAX,
      ),
      newDurationSec,
    );
    result[i + IDX_AMP_ENV_DURATION] = normalizeDuration(
      ampEnvDurationSec,
      AMP_ENV_DURATION_MIN,
      AMP_ENV_DURATION_MAX,
    );

    // Частоты, фазы, slope, startLevel, endLevel остаются как есть —
    // оптимизатор уже подобрал их на предыдущем этапе.
  }

  return result;
};

/**
 * Выполняет поэтапную оптимизацию по нарастающим длительностям
 * сигнала: на каждой стадии HPO (опционально) подбирает
 * гиперпараметры, затем coordinate descent уточняет вектор,
 * после чего длительности экстраполируются на следующую стадию.
 *
 * @param arg - Параметры staged-оптимизации: целевой сигнал,
 *   sample rate, начальный вектор, лимит итераций CD, настройки
 *   стадий (initialStageMs, stageDurationMultiplier, maxStageMs),
 *   HPO (hpoTrials, tpeConfig), fundamentalHz и переопределения
 *   `CoordinateDescentConfig`
 * @returns Итоговый вектор, объединённая история прогресса
 *   (phase 'hpo'/'cd') и результаты по стадиям
 * @remarks HPO-наблюдения кумулятивно передаются между стадиями
 *   (TPE строит модель на всей истории). Guard против регрессии
 *   HPO: `bestVector` из HPO принимается только если его
 *   windowed-score на текущей стадии >= score входного
 *   (экстраполированного) вектора; иначе входной вектор
 *   сохраняется, а от HPO берутся только гиперпараметры.
 *   Прогресс CD троттлится (200 мс), история ограничивается
 *   для защиты от OOM при сериализации.
 */
export const stagedOptimize = (
  arg: ArgStagedOptimize & {
    config?: Partial<CoordinateDescentConfig>;
  },
): StagedOptimizeResult => {
  const {
    targetSignal,
    sampleRate,
    initialVector,
    maxIterations,
    onProgress,
    initialStageMs: explicitInitialStageMs,
    stageDurationMultiplier = 1,
    maxStageMs = 500,
    stepGrowthAdd,
    stepDecayFactor,
    config,
    hpoTrials,
    tpeConfig,
    fundamentalHz,
  } = arg;

  const initialStageMs =
    explicitInitialStageMs ??
    (fundamentalHz !== undefined
      ? computeInitialStageMs(fundamentalHz)
      : 10);

  const totalSamples = targetSignal.length;
  const stageDurationsMs = generateStageDurations(
    totalSamples,
    sampleRate,
    initialStageMs,
    stageDurationMultiplier,
    maxStageMs,
  );

  const numOscillators = initialVector.length / OSC_PARAMS;
  const totalStages = stageDurationsMs.length;

  const firstStageMs = stageDurationsMs[0] ?? initialStageMs;
  const lastStageMs =
    stageDurationsMs[stageDurationsMs.length - 1] ?? maxStageMs;

  console.log(
    `[Opt] Starting ${totalStages} stages: ${firstStageMs}ms→${lastStageMs}ms, CD=${maxIterations} iter/stage, Osc=${numOscillators}`,
  );

  let currentVector = [...initialVector];
  const allHistory: ProgressEntry[] = [];
  const stageResults: StageResult[] = [];

  // Cumulative iteration offset across stages (CD iterations only, not HPO)
  let iterationOffset = 0;

  // Accumulate HPO observations across stages for TPE model building
  const accumulatedObservations: TrialObservation[] = [];

  for (let stageIdx = 0; stageIdx < totalStages; stageIdx++) {
    const durationMs = stageDurationsMs[stageIdx]!;
    const stageSamples = Math.round((durationMs / 1000) * sampleRate);
    const truncatedSignal = targetSignal.slice(0, stageSamples);

    // Throttled progress callback for coordinate descent (phase=cd)
    const PROGRESS_THROTTLE_MS = 200;
    let lastStageProgressTime = 0;

    const cdOnProgress: ProgressCallback = (entry) => {
      const now = Date.now();
      if (now - lastStageProgressTime < PROGRESS_THROTTLE_MS) {
        return;
      }
      lastStageProgressTime = now;

      // Cap history size to prevent OOM on postMessage serialization
      if (allHistory.length > 10000) {
        allHistory.length = 5000;
      }

      const wrappedEntry: ProgressEntry = {
        iteration: iterationOffset + entry.iteration,
        suppressionPercent: entry.suppressionPercent,
        phase: 'cd',
        stageIndex: stageIdx,
        totalStages,
        stageDurationMs: durationMs,
        cycle: entry.cycle,
      };
      allHistory.push(wrappedEntry);
      onProgress?.(wrappedEntry);
    };

    let cdMaxIterations: number;
    let cdStepGrowthAdd: number | undefined;
    let cdStepDecayFactor: number | undefined;
    let usedConfig: Partial<CoordinateDescentConfig> = { ...config };

    if (hpoTrials && hpoTrials > 0) {
      const effectiveHpoTrials = computeHpoTrialsForStage(
        stageSamples,
        hpoTrials,
      );

      console.log(
        `[HPO] Stage ${stageIdx + 1}/${totalStages}: ${effectiveHpoTrials} trials × 7 iter, signal=${durationMs}ms`,
      );

      const hpoResult = runHPO({
        targetSignal: truncatedSignal,
        sampleRate,
        initialVector: currentVector,
        numOscillators,
        nTrials: effectiveHpoTrials,
        tpeConfig,
        initialObservations:
          accumulatedObservations.length > 0
            ? [...accumulatedObservations]
            : undefined,
        onProgress: (hpoEntry) => {
          // Report HPO trials briefly so UI shows activity, but
          // keep phase='hpo' separate from CD iterations
          const wrappedEntry: ProgressEntry = {
            iteration: iterationOffset,
            suppressionPercent: hpoEntry.suppressionPercent,
            phase: 'hpo',
            stageIndex: stageIdx,
            totalStages,
            stageDurationMs: durationMs,
          };
          allHistory.push(wrappedEntry);
          onProgress?.(wrappedEntry);
        },
      });

      // Merge new observations into accumulated set
      for (const obs of hpoResult.observations) {
        accumulatedObservations.push(obs);
      }

      const bestHyper = hpoResult.bestHyperparams;
      // Guard against HPO regression: keep the incoming
      // (extrapolated) vector if it scores better on this window
      const incomingScore = evaluateSuppressionWindowed(
        createWaveForm(currentVector, sampleRate, stageSamples),
        truncatedSignal,
      );
      const hpoScore = evaluateSuppressionWindowed(
        createWaveForm(
          hpoResult.bestVector,
          sampleRate,
          stageSamples,
        ),
        truncatedSignal,
      );
      if (hpoScore >= incomingScore) {
        currentVector = hpoResult.bestVector;
      } else {
        console.log(
          `[HPO] Stage ${stageIdx + 1}: keeping incoming vector (${incomingScore.toFixed(2)}% > ${hpoScore.toFixed(2)}%)`,
        );
      }
      // After HPO: user controls iterations, HPO tunes step sizes and thresholds
      cdMaxIterations = maxIterations;
      cdStepGrowthAdd = bestHyper.stepGrowthAdd;
      cdStepDecayFactor = bestHyper.stepDecayFactor;
      usedConfig = {
        ...usedConfig,
        stagnationExitThreshold: bestHyper.stagnationExitThreshold,
        plateauRestartThreshold: bestHyper.plateauRestartThreshold,
        stepGrowthThreshold: bestHyper.stepGrowthThreshold,
        stagnationStepDecayFactor: bestHyper.stagnationDecayFactor,
        significantImprovementThreshold:
          bestHyper.significantImprovementThreshold,
        earlyExitSuppression: bestHyper.earlyExitSuppression,
        maxRestartsBeforeRandomRestart:
          bestHyper.maxRestartsBeforeRandomRestart,
        kickFallbackThreshold: bestHyper.kickFallbackThreshold,
        restartSchedule: [
          {
            startStep: bestHyper.explorationStartStep,
            minStep: bestHyper.explorationMinStep,
            label: 'EXPLORATION',
          },
          {
            startStep: bestHyper.refinementStartStep,
            minStep: bestHyper.refinementMinStep,
            label: 'REFINEMENT',
          },
          {
            startStep: bestHyper.precisionStartStep,
            minStep: bestHyper.precisionMinStep,
            label: 'PRECISION',
          },
        ],
        frequencyStep: bestHyper.frequencyStep,
        frequencyStepCoarse: bestHyper.frequencyStepCoarse,
        phaseStep: bestHyper.phaseStep,
      };
      if (config?.frequencyStep !== undefined) {
        usedConfig.frequencyStep = config.frequencyStep;
      }
      if (config?.frequencyStepCoarse !== undefined) {
        usedConfig.frequencyStepCoarse = config.frequencyStepCoarse;
      }
      if (config?.phaseStep !== undefined) {
        usedConfig.phaseStep = config.phaseStep;
      }

      const hpoSuppression = hpoResult.bestValue;
      console.log(
        `[HPO] Stage ${stageIdx + 1} done: ${hpoSuppression.toFixed(2)}%. Starting CD (${maxIterations} iter)...`,
      );
    } else {
      console.log(
        `[CD] Stage ${stageIdx + 1}/${totalStages}: ${maxIterations} iter, ${durationMs}ms`,
      );
      cdMaxIterations = maxIterations;
      cdStepGrowthAdd = stepGrowthAdd;
      cdStepDecayFactor = stepDecayFactor;
    }

    // Coordinate descent с лучшими гиперпараметрами для этой стадии
    const { vector, history } = coordinateDescent(
      currentVector,
      truncatedSignal,
      sampleRate,
      cdMaxIterations,
      cdOnProgress,
      cdStepGrowthAdd,
      cdStepDecayFactor,
      usedConfig,
    );

    currentVector = vector;

    // Update cumulative offset for next stage's iteration numbering
    if (history.length > 0) {
      iterationOffset += history[history.length - 1]?.iteration ?? 0;
    }

    // После завершения этапа — экстраполируем вектор для следующего
    // Увеличиваем osc.duration и ampEnv.duration до новой продолжительности,
    // сохраняя уже оптимизированные частоты, фазы и профиль огибающей
    if (stageIdx < stageDurationsMs.length - 1) {
      const nextDurationMs =
        stageDurationsMs[stageIdx + 1] ?? durationMs;
      currentVector = extrapolateVectorBetweenStages(
        currentVector,
        nextDurationMs,
      );
    }

    const lastSuppression =
      history.length > 0
        ? (history[history.length - 1]?.suppressionPercent ?? 0)
        : 0;

    const stageResult: StageResult = {
      stageIndex: stageIdx,
      stageDurationMs: durationMs,
      stageSamples,
      suppressionPercent: lastSuppression,
      iterations: history.length,
    };
    stageResults.push(stageResult);

    console.log(
      `[CD] Stage ${stageIdx + 1}/${totalStages} done: ${lastSuppression.toFixed(2)}% in ${history.length} iter`,
    );
  }

  const finalSuppression =
    allHistory.length > 0
      ? (allHistory[allHistory.length - 1]?.suppressionPercent ?? 0)
      : 0;

  console.log(
    `[StagedOpt] Complete: ${stageResults.length} stages, ` +
      `final suppression=${finalSuppression.toFixed(2)}%`,
  );

  return {
    vector: currentVector,
    history: allHistory,
    stageResults,
  };
};
