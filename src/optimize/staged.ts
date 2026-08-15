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

// Нормализация osc.duration: min=0, max=5
const OSC_DURATION_MIN = 0;
const OSC_DURATION_MAX = 5;

// Нормализация ampEnv.duration: min=0.5, max=5
const AMP_ENV_DURATION_MIN = 0.5;
const AMP_ENV_DURATION_MAX = 5;

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
 * Экстраполяция вектора между этапами многоэтапной оптимизации.
 * Увеличивает osc.duration и ampEnv.duration осцилляторов до новой
 * продолжительности, сохраняя уже оптимизированные параметры (частоты,
 * фазы, slope, startLevel, endLevel) без изменений.
 *
 * Физический смысл: осциллятор уже "научился" звучать определённым
 * образом на первых N ms. При увеличении фрагмента до M > N ms
 * растягиваем длительность, чтобы осциллятор мог звучать всё M ms,
 * но сохраняя форму огибающей на уже выученной части без искажений
 * от оптимизатора.
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
    initialStageMs = 10,
    stageDurationMultiplier = 1,
    maxStageMs = 500,
    stepGrowthAdd,
    stepDecayFactor,
    config,
    hpoTrials,
    tpeConfig,
  } = arg;

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

  console.log(
    `[Opt] Starting ${totalStages} stages: 10ms→${maxStageMs}ms, CD=${maxIterations} iter/stage, Osc=${numOscillators}`,
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
          onProgress?.(wrappedEntry);
        },
      });

      // Merge new observations into accumulated set
      for (const obs of hpoResult.observations) {
        accumulatedObservations.push(obs);
      }

      const bestHyper = hpoResult.bestHyperparams;
      currentVector = hpoResult.bestVector;
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
