/* eslint-disable no-console */
import { OSC_PARAMS, clampVolume, initGenome } from './consts';
import { VOLUME_PRUNE_THRESHOLD } from '../consts';
import {
  evaluateSuppressionFromWaveform,
  evaluateSuppressionWindowed,
  findOptimalScale,
  computeSpectralProfile,
  WaveformCache,
  SpectralProfile,
} from './evaluate';
import type {
  ProgressEntry,
  ProgressCallback,
  ArgOptimize,
} from './types';

const IDX_FREQ_BASE = 1;
const IDX_FREQ_START = 2;
const IDX_PHASE = 5;

/**
 * Конфигурация алгоритма coordinate descent.
 * Вынесена из модуля, чтобы HPO мог подбирать эти параметры.
 */
export interface CoordinateDescentConfig {
  /** Iterations without improvement before step decay. */
  stagnationExitThreshold: number;
  /** Iterations without improvement before kick/restart. */
  plateauRestartThreshold: number;
  /** Consecutive successes before step grows. */
  stepGrowthThreshold: number;
  /** Step multiplier on stagnation exit. */
  stagnationStepDecayFactor: number;
  /** Min score increase (%) to count as improvement. */
  significantImprovementThreshold: number;
  /** Suppression % for early exit. */
  earlyExitSuppression: number;
  /** Max plateau kicks before full random restart. */
  maxRestartsBeforeRandomRestart: number;
  /** Kick fallback: if score < bestScore × threshold, restore genome. */
  kickFallbackThreshold: number;
  /** Three-phase step schedule (applies to non-freq/phase params). */
  restartSchedule: Array<{
    startStep: number;
    minStep: number;
    label: string;
  }>;
  /**
   * Fine frequency step (offsets 1, 2), used in the last cycle.
   * Absolute vector step, not a multiplier. Default 1e-7 ≈ 0.002 Hz.
   */
  frequencyStep: number;
  /**
   * Coarse frequency step (offsets 1, 2), used in EXPLORATION.
   * Absolute vector step. Default 1e-4 ≈ 2 Hz.
   */
  frequencyStepCoarse: number;
  /**
   * Refinement frequency step (offsets 1, 2), used in REFINEMENT.
   * Absolute vector step. Default 5e-6 ≈ 0.1 Hz.
   */
  frequencyStepRefine: number;
  /**
   * Phase step in EXPLORATION cycle. Absolute vector step.
   * Default 0.003125 ≈ 1.1°.
   */
  phaseStep: number;
  /** Phase step in REFINEMENT cycle. Default phaseStep / 4 ≈ 0.29°. */
  phaseStepRefine: number;
  /** Phase step in PRECISION cycle. Default phaseStep / 16 ≈ 0.07°. */
  phaseStepPrecision: number;
  /**
   * Simulated annealing: initial temperature in score units (p.p.).
   * A candidate worse by Δ p.p. is accepted with probability
   * exp(-Δ / T). 0 disables SA (pure greedy CD).
   */
  saInitialTemp: number;
  /** Geometric cooling factor applied per iteration. */
  saCoolingRate: number;
}

/** Default config values (previous hardcoded constants). */
export const DEFAULT_COORD_DESCENT_CONFIG: CoordinateDescentConfig = {
  stagnationExitThreshold: 4,
  plateauRestartThreshold: 3,
  stepGrowthThreshold: 5,
  stagnationStepDecayFactor: 0.9,
  significantImprovementThreshold: 0.01,
  earlyExitSuppression: 98,
  maxRestartsBeforeRandomRestart: 5,
  kickFallbackThreshold: 0.8,
  restartSchedule: [
    { startStep: 0.025, minStep: 0.01, label: 'EXPLORATION' },
    { startStep: 0.01, minStep: 0.003, label: 'REFINEMENT' },
    { startStep: 0.0025, minStep: 0.0001, label: 'PRECISION' },
  ],
  frequencyStep: 0.0000001,
  frequencyStepCoarse: 0.0001,
  frequencyStepRefine: 0.000005,
  phaseStep: 0.003125,
  phaseStepRefine: 0.00078125,
  phaseStepPrecision: 0.00019531,
  saInitialTemp: 3,
  saCoolingRate: 0.99,
};

/**
 * Per-parameter step. Frequency uses the caller-selected
 * coarse or fine step; phase is fixed; other params follow
 * the cycle schedule floored at minStep.
 */
const getParamStep = (
  paramIndex: number,
  baseStep: number,
  frequencyStep: number,
  phaseStep: number,
  minStep: number,
): number => {
  const offset = paramIndex % OSC_PARAMS;
  if (offset === IDX_FREQ_BASE || offset === IDX_FREQ_START) {
    return frequencyStep;
  }
  if (offset === IDX_PHASE) {
    return phaseStep;
  }
  return Math.max(baseStep, minStep);
};

const optimizeSingleParameter = (
  genome: number[],
  waveformCache: WaveformCache,
  paramIndex: number,
  step: number,
  targetSignal: readonly number[],
  sampleRate: number,
  currentBest: number,
  spectralProfile: SpectralProfile,
  temperature = 0,
): {
  genome: number[];
  score: number;
} => {
  const center = genome[paramIndex] ?? 0;
  const isVolume = paramIndex % OSC_PARAMS === 9;

  const candidates = isVolume
    ? [
        clampVolume(center * (1 - step)),
        clampVolume(center * (1 + step)),
      ]
    : [Math.max(0, center - step), Math.min(1, center + step)];

  let bestScore = currentBest;
  let bestValue = center;
  // Кандидаты, ухудшающие score, — материал для SA-accept: лучший
  // из ухудшающих рассматривается, если greedy-улучшения не нашлось.
  let bestWorseScore = -Infinity;
  let bestWorseValue = center;

  for (const candVal of candidates) {
    waveformCache.setParam(paramIndex, candVal);
    const score = evaluateSuppressionWindowed(
      waveformCache.getWaveform(),
      targetSignal,
      0.5,
      0.3,
      sampleRate,
      spectralProfile,
    );
    if (score > bestScore) {
      bestScore = score;
      bestValue = candVal;
    } else if (score > bestWorseScore) {
      bestWorseScore = score;
      bestWorseValue = candVal;
    }
  }

  // Simulated annealing: если greedy-улучшения нет, принимаем
  // ухудшение с вероятностью exp(-Δ / T). Это позволяет выйти
  // из локального минимума, в котором greedy CD застревает.
  if (
    temperature > 0 &&
    bestValue === center &&
    bestWorseScore > -Infinity
  ) {
    const delta = currentBest - bestWorseScore;
    if (delta > 0 && Math.random() < Math.exp(-delta / temperature)) {
      bestScore = bestWorseScore;
      bestValue = bestWorseValue;
    }
  }

  waveformCache.setParam(paramIndex, bestValue);
  genome[paramIndex] = bestValue;

  return {
    genome,
    score: bestScore,
  };
};

const syncFlagsToCache = (
  genome: readonly number[],
  waveformCache: WaveformCache,
  numOsc: number,
): void => {
  for (let osc = 0; osc < numOsc; osc++) {
    waveformCache.setParam(
      osc * OSC_PARAMS,
      genome[osc * OSC_PARAMS] ?? 0,
    );
  }
};

const optimizeIteration = (
  genome: number[],
  waveformCache: WaveformCache,
  numOsc: number,
  targetSignal: readonly number[],
  sampleRate: number,
  currentBest: number,
  step: number,
  firstOscMinVol: number,
  frequencyStep: number,
  phaseStep: number,
  minStep: number,
  spectralProfile: SpectralProfile,
  temperature = 0,
): { genome: number[]; score: number } => {
  let score = currentBest;

  if ((genome[0] ?? 0) !== 1) {
    waveformCache.setParam(0, 1);
    genome[0] = 1;
  }

  for (let osc = 0; osc < numOsc; osc++) {
    const base = osc * OSC_PARAMS;
    if ((genome[base] ?? 0) < 0.5) {
      continue;
    }
    for (let p = 1; p < OSC_PARAMS; p++) {
      const i = base + p;
      const effectiveStep = getParamStep(
        i,
        step,
        frequencyStep,
        phaseStep,
        minStep,
      );
      const result = optimizeSingleParameter(
        genome,
        waveformCache,
        i,
        effectiveStep,
        targetSignal,
        sampleRate,
        score,
        spectralProfile,
        temperature,
      );
      genome = result.genome;
      score = result.score;

      if (osc === 0 && p === 9) {
        const minVol = Math.max(firstOscMinVol, genome[9] ?? 0);
        waveformCache.setParam(9, minVol);
        genome[9] = minVol;
      }
    }

    const volume = genome[base + 9] ?? 0;
    if (
      (genome[base] ?? 0) >= 0.5 &&
      volume <= VOLUME_PRUNE_THRESHOLD
    ) {
      waveformCache.setParam(base, 0);
      const scoreOff = evaluateSuppressionWindowed(
        waveformCache.getWaveform(),
        targetSignal,
        0.5,
        0.3,
        sampleRate,
        spectralProfile,
      );
      if (scoreOff > score) {
        genome[base] = 0;
        score = scoreOff;
      } else {
        waveformCache.setParam(base, 1);
      }
    }
  }

  return { genome, score };
};

const finalPruneOscillators = (
  genome: number[],
  waveformCache: WaveformCache,
  targetSignal: readonly number[],
  currentBest: number,
  numOsc: number,
): number => {
  const pruneCandidates: { base: number; volume: number }[] = [];
  for (let osc = 0; osc < numOsc; osc++) {
    const base = osc * OSC_PARAMS;
    const volume = genome[base + 9] ?? 0;
    if (volume < VOLUME_PRUNE_THRESHOLD) {
      pruneCandidates.push({ base, volume });
    }
  }
  pruneCandidates.sort((a, b) => a.volume - b.volume);

  let score = currentBest;
  for (const { base } of pruneCandidates) {
    const savedFlag = genome[base] ?? 0;
    genome[base] = 0;
    waveformCache.setParam(base, 0);
    const scoreAfter = evaluateSuppressionFromWaveform(
      waveformCache.getWaveform(),
      targetSignal,
    );
    if (score - scoreAfter > 0.05) {
      genome[base] = savedFlag;
      waveformCache.setParam(base, savedFlag);
    } else {
      score = scoreAfter;
    }
  }

  return score;
};

const normalizeFlags = (genome: number[], numOsc: number): void => {
  for (let osc = 0; osc < numOsc; osc++) {
    const flag = genome[osc * OSC_PARAMS] ?? 0;
    genome[osc * OSC_PARAMS] = flag >= 0.5 ? 1 : 0;
  }
};

const emitProgress = (
  history: ProgressEntry[],
  onProgress: ProgressCallback | undefined,
  iteration: number,
  suppressionPercent: number,
  cycle?: string,
): void => {
  const entry: ProgressEntry = {
    iteration,
    suppressionPercent,
    cycle,
  };
  history.push(entry);
  onProgress?.(entry);
};

interface OptimizeResult {
  vector: number[];
  history: ProgressEntry[];
}

export const coordinateDescent = (
  initialVector: readonly number[],
  targetSignal: readonly number[],
  sampleRate: number,
  maxIterations: number,
  onProgress?: ProgressCallback,
  stepGrowthAdd?: number,
  stepDecayFactor?: number,
  config?: Partial<CoordinateDescentConfig>,
): OptimizeResult => {
  const cfg: CoordinateDescentConfig = {
    ...DEFAULT_COORD_DESCENT_CONFIG,
    ...config,
  };

  const genomeLength = initialVector.length;
  const numOsc = genomeLength / OSC_PARAMS;

  let genome = initGenome(initialVector);

  const firstOscInitVolume = genome[9] ?? 0;

  const actualStepGrowthAdd = stepGrowthAdd ?? 0.01;
  const actualStepDecayFactor =
    stepDecayFactor ?? cfg.stagnationStepDecayFactor;

  const spectralProfile = computeSpectralProfile(
    targetSignal,
    sampleRate,
  );
  const waveformCache = new WaveformCache(
    genome,
    sampleRate,
    targetSignal.length,
  );
  let currentBest = evaluateSuppressionWindowed(
    waveformCache.getWaveform(),
    targetSignal,
    0.5,
    0.3,
    sampleRate,
    spectralProfile,
  );
  const history: ProgressEntry[] = [];
  let stagnation = 0;
  let plateauCount = 0;
  let restartCount = 0;
  let consecutiveSuccesses = 0;
  let bestGenome = genome.slice();
  let bestScore = currentBest;

  console.log(
    `[CoordDescent] Starting at ${currentBest.toFixed(4)}%, ${genomeLength} params`,
  );

  for (let osc = 0; osc < numOsc; osc++) {
    const base = osc * OSC_PARAMS;
    const freqBase = genome[base + 1];
    const freqStart = genome[base + 2];
    const vol = genome[base + 9];
    console.log(
      `[Init] Osc[${osc}]: freq=${freqBase?.toFixed(2)}-${freqStart?.toFixed(2)}, vol=${vol?.toFixed(3)}, on=${genome[base]}`,
    );
  }

  const restartSchedule = cfg.restartSchedule;

  // Бюджет итераций на цикл: каждый цикл ограничен долей maxIterations,
  // финальный цикл (PRECISION) гарантированно получает резерв (30%).
  // Цикл, завершившийся по minStep раньше своей доли, освобождает
  // оставшиеся итерации следующим циклам.
  const cycleShares = restartSchedule.map((_, i) =>
    i === restartSchedule.length - 1
      ? 0.3
      : 0.7 / Math.max(1, restartSchedule.length - 1),
  );
  let cycleStartIter = 0;

  let iter = 0;
  let cycleIndex = 0;
  let lastCycleLabel: string | undefined;
  // Температура SA живёт через все циклы: охлаждается непрерывно,
  // а не сбрасывается на каждом цикле (иначе SA перегревается).
  let temperature = cfg.saInitialTemp;
  while (cycleIndex < restartSchedule.length) {
    const cycle = restartSchedule[cycleIndex];
    if (!cycle) {
      break;
    }
    let step = cycle.startStep;
    stagnation = 0;

    const isLastCycle = cycleIndex === restartSchedule.length - 1;
    const frequencyStep =
      cycleIndex === 0
        ? cfg.frequencyStepCoarse
        : isLastCycle
          ? cfg.frequencyStep
          : cfg.frequencyStepRefine;
    const phaseStep =
      cycleIndex === 0
        ? cfg.phaseStep
        : isLastCycle
          ? cfg.phaseStepPrecision
          : cfg.phaseStepRefine;
    lastCycleLabel = cycle.label;

    // Simulated annealing: температура охлаждается непрерывно через
    // все исследовательские циклы (не сбрасывается на каждом), и
    // выключается в финальном (PRECISION) — там нужен чистый greedy.
    // Перед PRECISION откатываемся к best-ever геному: SA мог уйти
    // в худшую точку, а финальная полировка должна идти от лучшей.
    if (isLastCycle) {
      temperature = 0;
    }
    if (isLastCycle && bestScore > currentBest) {
      console.log(
        `[CoordDescent] SA: restoring best-ever ${bestScore.toFixed(4)}% (was ${currentBest.toFixed(4)}%) before ${cycle.label}`,
      );
      genome = bestGenome.slice();
      waveformCache.rebuild(genome);
      syncFlagsToCache(genome, waveformCache, numOsc);
      currentBest = bestScore;
    }

    console.log(
      `[CoordDescent] Cycle: ${cycle.label}, startStep=${cycle.startStep}, minStep=${cycle.minStep}, freqStep=${frequencyStep}, phaseStep=${phaseStep}, T=${temperature.toFixed(4)}, score=${currentBest.toFixed(4)}%`,
    );

    const cycleIterStart = iter;
    let genomeChanged = false;

    const cycleIterCap = Math.min(
      maxIterations,
      cycleStartIter +
        Math.floor(maxIterations * (cycleShares[cycleIndex] ?? 0.3)),
    );

    while (iter < cycleIterCap) {
      const prevGenome = genome.slice();
      const result = optimizeIteration(
        genome,
        waveformCache,
        numOsc,
        targetSignal,
        sampleRate,
        currentBest,
        step,
        firstOscInitVolume,
        frequencyStep,
        phaseStep,
        cycle.minStep,
        spectralProfile,
        temperature,
      );
      genome = result.genome;
      const scoreImproved =
        result.score >
        currentBest + cfg.significantImprovementThreshold;
      currentBest = result.score;

      if (currentBest > bestScore) {
        bestScore = currentBest;
        bestGenome = genome.slice();
      }

      const genomeActuallyChanged =
        genome.length !== prevGenome.length ||
        genome.some((v, i) => v !== prevGenome[i]);

      if (genomeActuallyChanged) {
        genomeChanged = true;
      }

      console.log(
        `Iteration ${iter + 1}: ${currentBest.toFixed(4)}%`,
      );
      emitProgress(
        history,
        onProgress,
        iter + 1,
        currentBest,
        cycle.label,
      );

      iter++;
      temperature *= cfg.saCoolingRate;
      if (currentBest >= cfg.earlyExitSuppression) {
        break;
      }

      if (scoreImproved) {
        stagnation = 0;
        plateauCount = 0;
        consecutiveSuccesses++;
        if (consecutiveSuccesses >= cfg.stepGrowthThreshold) {
          step += actualStepGrowthAdd;
          console.log(
            `[CoordDescent] Step grown to ${step.toFixed(6)} (added ${actualStepGrowthAdd})`,
          );
          consecutiveSuccesses = 0;
        }
      } else {
        stagnation++;
        plateauCount++;
        consecutiveSuccesses = 0;
      }

      if (plateauCount >= cfg.plateauRestartThreshold) {
        restartCount++;
        if (restartCount >= cfg.maxRestartsBeforeRandomRestart) {
          console.log(
            `[CoordDescent] Random restart at iter ${iter} (best=${bestScore.toFixed(4)}%, restarts=${restartCount})`,
          );
          genome = initGenome(initialVector).map((v, idx) => {
            if (idx % OSC_PARAMS === 0) {
              return v;
            }
            return Math.random();
          });
          waveformCache.rebuild(genome);
          syncFlagsToCache(genome, waveformCache, numOsc);
          restartCount = 0;
        } else {
          const enabledOscs: number[] = [];
          for (let osc = 0; osc < numOsc; osc++) {
            if ((genome[osc * OSC_PARAMS] ?? 0) >= 0.5) {
              enabledOscs.push(osc);
            }
          }
          if (enabledOscs.length === 0) {
            enabledOscs.push(0);
          }
          const kickOsc =
            enabledOscs[
              Math.floor(Math.random() * enabledOscs.length)
            ] ?? 0;
          const kickParam =
            1 + Math.floor(Math.random() * (OSC_PARAMS - 1));
          const kickIdx = kickOsc * OSC_PARAMS + kickParam;

          console.log(
            `[CoordDescent] Plateau kick at iter ${iter}: osc[${kickOsc}].p[${kickParam}] (restart=${restartCount})`,
          );

          genome[kickIdx] = Math.random();
          waveformCache.setParam(kickIdx, genome[kickIdx] ?? 0);

          syncFlagsToCache(genome, waveformCache, numOsc);

          currentBest = evaluateSuppressionWindowed(
            waveformCache.getWaveform(),
            targetSignal,
            0.5,
            0.3,
            sampleRate,
            spectralProfile,
          );

          if (currentBest < bestScore * cfg.kickFallbackThreshold) {
            console.log(
              `[CoordDescent] Kick failed, restarting from best`,
            );
            genome = bestGenome.slice();
            waveformCache.rebuild(genome);
            syncFlagsToCache(genome, waveformCache, numOsc);
            currentBest = bestScore;
          }
        }

        emitProgress(
          history,
          onProgress,
          iter,
          currentBest,
          cycle.label,
        );
        plateauCount = 0;
        consecutiveSuccesses = 0;
        step *= actualStepDecayFactor;
        console.log(
          `[CoordDescent] Step decayed to ${step.toFixed(8)} (×${actualStepDecayFactor.toFixed(2)})`,
        );
      }

      if (stagnation >= cfg.stagnationExitThreshold) {
        step *= cfg.stagnationStepDecayFactor;
        console.log(
          `[CoordDescent] Decay step to ${step.toFixed(8)} (${stagnation} stagnant)`,
        );
        stagnation = 0;
      }

      if (step < cycle.minStep) {
        console.log(
          `[CoordDescent] Step ${step.toFixed(8)} < minStep ${cycle.minStep}, leaving ${cycle.label}`,
        );
        break;
      }
    }

    if (currentBest >= cfg.earlyExitSuppression) {
      break;
    }

    if (!genomeChanged && iter - cycleIterStart > 0) {
      console.log(
        `[CoordDescent] No genome change in cycle ${cycle.label}, advancing`,
      );
    }

    if (iter >= cycleIterCap && iter < maxIterations) {
      console.log(
        `[CoordDescent] Cycle ${cycle.label} hit share cap at iter ${iter}, advancing`,
      );
    }

    cycleStartIter = iter;
    cycleIndex++;
  }

  console.log(
    `[CoordDescent] Finished after ${iter} iterations (${lastCycleLabel} cycle, ${cycleIndex - 1} cycles completed)`,
  );

  const finalPruningScore = finalPruneOscillators(
    genome,
    waveformCache,
    targetSignal,
    currentBest,
    numOsc,
  );

  syncFlagsToCache(genome, waveformCache, numOsc);

  console.log(
    `[CoordDescent] Post-pruning score: ${finalPruningScore.toFixed(4)}%`,
  );

  if (finalPruningScore > bestScore) {
    bestScore = finalPruningScore;
    bestGenome = genome.slice();
  }
  currentBest = Math.max(currentBest, finalPruningScore);

  console.log(`[CoordDescent] Phase 2: Scale fitting...`);
  const generated = waveformCache.getWaveform();
  const preScaleScore = evaluateSuppressionWindowed(
    generated,
    targetSignal,
    0.5,
    0.3,
    sampleRate,
    spectralProfile,
  );
  const { scale, suppressionPercent: scaleScore } = findOptimalScale(
    generated,
    targetSignal,
    sampleRate,
    spectralProfile,
  );

  console.log(
    `[CoordDescent] Optimal scale: ${scale.toFixed(4)} (waveform probe ${scaleScore.toFixed(4)}%)`,
  );

  if (scale !== 1) {
    const scaledGenome = genome.slice();
    for (let osc = 0; osc < numOsc; osc++) {
      const base = osc * OSC_PARAMS;
      const volIdx = base + 9;
      const currentVol = scaledGenome[volIdx] ?? 0;
      scaledGenome[volIdx] = clampVolume(currentVol * scale);
    }

    const scaledCache = new WaveformCache(
      scaledGenome,
      sampleRate,
      targetSignal.length,
    );
    const scaledScore = evaluateSuppressionWindowed(
      scaledCache.getWaveform(),
      targetSignal,
      0.5,
      0.3,
      sampleRate,
      spectralProfile,
    );

    if (scaledScore > preScaleScore) {
      genome = scaledGenome;
      waveformCache.rebuild(genome);
      syncFlagsToCache(genome, waveformCache, numOsc);
      currentBest = scaledScore;
      console.log(
        `[CoordDescent] Scale fitting applied: ${preScaleScore.toFixed(4)}% -> ${scaledScore.toFixed(4)}%`,
      );
    } else {
      console.log(
        `[CoordDescent] Scale fitting skipped (no improvement: ${scaledScore.toFixed(4)}% <= ${preScaleScore.toFixed(4)}%)`,
      );
      currentBest = preScaleScore;
    }
  } else {
    currentBest = preScaleScore;
  }

  console.log(
    `[CoordDescent] After scale fitting: ${currentBest.toFixed(4)}%`,
  );

  if (bestScore > currentBest) {
    genome = bestGenome.slice();
    waveformCache.rebuild(genome);
    syncFlagsToCache(genome, waveformCache, numOsc);
    currentBest = bestScore;
    console.log(
      `[CoordDescent] Restored best genome: ${currentBest.toFixed(4)}%`,
    );
  }

  normalizeFlags(genome, numOsc);
  syncFlagsToCache(genome, waveformCache, numOsc);

  emitProgress(
    history,
    onProgress,
    iter,
    currentBest,
    lastCycleLabel,
  );

  return { vector: genome, history };
};

export const optimize = (
  arg: ArgOptimize,
): {
  vector: number[];
  history: ProgressEntry[];
} => {
  return coordinateDescent(
    arg.initialVector,
    arg.targetSignal,
    arg.sampleRate,
    arg.maxIterations ?? 100,
    arg.onProgress,
    arg.stepGrowthAdd,
    arg.stepDecayFactor,
    arg.config,
  );
};
