import {
  OSC_PARAMS,
  FINE_STEP_BASE,
  clampVolume,
  initGenome,
} from './consts';
import { VOLUME_PRUNE_THRESHOLD } from '../consts';
import { evaluateSuppression } from './evaluate';
import type {
  ProgressEntry,
  ProgressCallback,
  ArgOptimize,
} from './types';

const STAGNATION_EXIT_THRESHOLD = 10;

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
    const score = evaluateSuppression(
      candGenome,
      targetSignal,
      sampleRate,
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
  targetSignal: readonly number[],
  sampleRate: number,
  currentBest: number,
): { genome: number[]; score: number } => {
  let score = currentBest;

  for (let osc = 0; osc < numOsc; osc++) {
    const base = osc * OSC_PARAMS;
    for (let p = 1; p < OSC_PARAMS; p++) {
      const i = base + p;
      const result = optimizeSingleParameter(
        genome,
        i,
        FINE_STEP_BASE,
        targetSignal,
        sampleRate,
        score,
      );
      genome.length = 0;
      genome.push(...result.genome);
      score = result.score;
    }
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
): OptimizeResult => {
  const genomeLength = initialVector.length;
  const numOsc = genomeLength / OSC_PARAMS;

  let genome = initGenome(initialVector);

  let currentBest = evaluateSuppression(
    genome,
    targetSignal,
    sampleRate,
  );
  const history: ProgressEntry[] = [];
  let stagnation = 0;

  console.log(
    `[CoordDescent] Starting at ${currentBest.toFixed(4)}%, ${genomeLength} params`,
  );

  for (let iter = 0; iter < maxIterations; iter++) {
    const result = optimizeIteration(
      genome,
      numOsc,
      targetSignal,
      sampleRate,
      currentBest,
    );
    genome = result.genome;
    currentBest = result.score;

    console.log(`Iteration ${iter + 1}: ${currentBest.toFixed(4)}%`);
    emitProgress(history, onProgress, iter + 1, currentBest);

    if (currentBest >= 98) {
      break;
    }

    if (
      currentBest >
      (history[history.length - 2]?.suppressionPercent ?? -Infinity)
    ) {
      stagnation = 0;
    } else {
      stagnation++;
    }

    if (stagnation >= STAGNATION_EXIT_THRESHOLD) {
      console.log(
        `[CoordDescent] Early exit at iter ${iter + 1} (${stagnation} stagnant)`,
      );
      break;
    }
  }

  currentBest = finalPruneOscillators(
    genome,
    targetSignal,
    sampleRate,
    currentBest,
    numOsc,
  );

  normalizeFlags(genome, numOsc);

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
  );
};
