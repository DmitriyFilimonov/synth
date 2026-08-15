import {
  OSC_PARAMS,
  clamp01,
  clampVolume,
  initGenome,
} from './consts';
import { VOLUME_MIN, VOLUME_PRUNE_THRESHOLD } from '../consts';
import {
  evaluateSuppression,
  evaluateSuppressionWindowed,
  findOptimalScale,
  createWaveForm,
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
  /** Frequency step scale (offsets 1, 2). Multiplier applied to base schedule step. */
  frequencyStep: number;
  /** Phase step scale (offset 5). Multiplier applied to base schedule step. */
  phaseStep: number;
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
  phaseStep: 0.003125,
};

const PERTURBATION = 0.05;

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
  genome: readonly number[],
  paramIndex: number,
  step: number,
  targetSignal: readonly number[],
  sampleRate: number,
  currentBest: number,
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
  let bestCandidate: number[] | null = null;

  for (const candVal of candidates) {
    const candGenome = [...genome] as number[];
    candGenome[paramIndex] = candVal;
    const score = evaluateSuppressionWindowed(
      createWaveForm(candGenome, sampleRate, targetSignal.length),
      targetSignal,
    );
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candGenome;
    }
  }

  return {
    genome: bestCandidate ?? ([...genome] as number[]),
    score: bestScore,
  };
};

const optimizeIteration = (
  genome: number[],
  numOsc: number,
  initOscCount: number,
  targetSignal: readonly number[],
  sampleRate: number,
  currentBest: number,
  step: number,
  firstOscMinVol: number,
  frequencyStep: number,
  phaseStep: number,
  minStep: number,
): { genome: number[]; score: number } => {
  let score = currentBest;

  genome[0] = 1;

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
        i,
        effectiveStep,
        targetSignal,
        sampleRate,
        score,
      );
      genome.length = 0;
      genome.push(...result.genome);
      score = result.score;

      if (osc === 0 && p === 9) {
        genome[9] = Math.max(firstOscMinVol, genome[9] ?? 0);
      }
    }

    enforceFlagInvariant(genome, numOsc, initOscCount);
  }

  return { genome, score };
};

const finalPruneOscillators = (
  genome: number[],
  targetSignal: readonly number[],
  sampleRate: number,
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
    const scoreAfter = evaluateSuppression(
      genome,
      targetSignal,
      sampleRate,
    );
    if (score - scoreAfter > 0.05) {
      genome[base] = savedFlag;
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

const enforceFlagInvariant = (
  genome: number[],
  numOsc: number,
  initOscCount: number,
): void => {
  let rightmostEnabled = -1;
  for (let osc = numOsc - 1; osc >= 0; osc--) {
    if ((genome[osc * OSC_PARAMS] ?? 0) >= 0.5) {
      rightmostEnabled = osc;
      break;
    }
  }

  for (let osc = 0; osc < numOsc; osc++) {
    if (osc < initOscCount) {
      genome[osc * OSC_PARAMS] = 1;
      continue;
    }

    const vol = genome[osc * OSC_PARAMS + 9] ?? 0;

    if (osc < rightmostEnabled) {
      genome[osc * OSC_PARAMS] = 1;
      continue;
    }

    if (vol < VOLUME_MIN) {
      genome[osc * OSC_PARAMS] = 0;
    } else {
      genome[osc * OSC_PARAMS] = 1;
    }
  }
};

const emitProgress = (
  history: ProgressEntry[],
  onProgress: ProgressCallback | undefined,
  iteration: number,
  suppressionPercent: number,
): void => {
  const entry: ProgressEntry = {
    iteration,
    suppressionPercent,
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

  const initOscCount = initialVector.filter(
    (v, i) => i % OSC_PARAMS === 0 && v >= 0.5,
  ).length;

  const actualStepGrowthAdd = stepGrowthAdd ?? 0.01;
  const actualStepDecayFactor =
    stepDecayFactor ?? cfg.stagnationStepDecayFactor;

  const initialGenerated = createWaveForm(
    genome,
    sampleRate,
    targetSignal.length,
  );
  let currentBest = evaluateSuppressionWindowed(
    initialGenerated,
    targetSignal,
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

  let iter = 0;
  let cycleIndex = 0;
  while (cycleIndex < restartSchedule.length) {
    const cycle = restartSchedule[cycleIndex];
    if (!cycle) {
      break;
    }
    let step = cycle.startStep;
    stagnation = 0;

    console.log(
      `[CoordDescent] Cycle: ${cycle.label}, startStep=${cycle.startStep}, minStep=${cycle.minStep}, score=${currentBest.toFixed(4)}%`,
    );

    const cycleIterStart = iter;
    let genomeChanged = false;

    const frequencyStep = cfg.frequencyStep;
    const phaseStep = cfg.phaseStep;

    while (iter < maxIterations) {
      const prevGenome = genome.slice();
      const result = optimizeIteration(
        genome,
        numOsc,
        initOscCount,
        targetSignal,
        sampleRate,
        currentBest,
        step,
        firstOscInitVolume,
        frequencyStep,
        phaseStep,
        cycle.minStep,
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
      emitProgress(history, onProgress, iter + 1, currentBest);

      iter++;
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
          enforceFlagInvariant(genome, numOsc, initOscCount);
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

          enforceFlagInvariant(genome, numOsc, initOscCount);

          currentBest = evaluateSuppressionWindowed(
            createWaveForm(genome, sampleRate, targetSignal.length),
            targetSignal,
          );

          if (currentBest < bestScore * cfg.kickFallbackThreshold) {
            console.log(
              `[CoordDescent] Kick failed, restarting from best`,
            );
            genome = bestGenome.slice();
            currentBest = bestScore;
          }
        }

        emitProgress(history, onProgress, iter, currentBest);
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
    }

    if (currentBest >= cfg.earlyExitSuppression) {
      break;
    }

    if (!genomeChanged && iter - cycleIterStart > 0) {
      console.log(
        `[CoordDescent] No genome change in cycle ${cycle.label}, advancing`,
      );
    }

    cycleIndex++;
  }

  const finalPruningScore = finalPruneOscillators(
    genome,
    targetSignal,
    sampleRate,
    currentBest,
    numOsc,
  );

  enforceFlagInvariant(genome, numOsc, initOscCount);

  console.log(
    `[CoordDescent] Post-pruning score: ${finalPruningScore.toFixed(4)}%`,
  );

  console.log(`[CoordDescent] Phase 2: Scale fitting...`);
  const generated = createWaveForm(
    genome,
    sampleRate,
    targetSignal.length,
  );
  const { scale, suppressionPercent: scaleScore } = findOptimalScale(
    generated,
    targetSignal,
  );

  console.log(`[CoordDescent] Optimal scale: ${scale.toFixed(4)}`);

  if (scale !== 1) {
    for (let osc = 0; osc < numOsc; osc++) {
      const base = osc * OSC_PARAMS;
      const volIdx = base + 9;
      const currentVol = genome[volIdx] ?? 0;
      genome[volIdx] = clampVolume(currentVol * scale);
    }
  }

  currentBest = scaleScore;

  console.log(
    `[CoordDescent] After scale fitting: ${currentBest.toFixed(4)}%`,
  );

  if (bestScore > currentBest) {
    genome = bestGenome.slice();
    currentBest = bestScore;
    console.log(
      `[CoordDescent] Restored best genome: ${currentBest.toFixed(4)}%`,
    );
  }

  normalizeFlags(genome, numOsc);
  enforceFlagInvariant(genome, numOsc, initOscCount);

  emitProgress(history, onProgress, maxIterations, currentBest);

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
