import {
  OSC_PARAMS,
  FINE_STEP_BASE,
  STEP_GROWTH_FACTOR,
  STEP_SHRINK_FACTOR,
  EARLY_EXIT_THRESHOLD,
  STAGNATION_PERTURB_THRESHOLD,
  RANDOM_PERTURB_RATE,
  RANDOM_PERTURB_MAG,
  clamp01,
  clampVolume,
  countActiveOscillators,
  initGenome,
} from './consts';
import { VOLUME_PRUNE_THRESHOLD } from '../consts';
import { evaluateSuppression } from './evaluate';
import type {
  ProgressEntry,
  ProgressCallback,
  ArgOptimize,
  PerturbationResult,
} from './types';

const generateCandidates = (
  center: number,
  step: number,
  isVolume: boolean,
): number[] => {
  const candidates: number[] = [];
  if (isVolume) {
    for (let s = 1; s <= 3; s++) {
      const factor = step * s;
      const lower = clampVolume(center * (1 - factor));
      const upper = clampVolume(center * (1 + factor));
      candidates.push(lower, upper);
    }
  } else {
    for (let s = 1; s <= 3; s++) {
      const stepSize = step * s;
      const leftVal = Math.max(0, center - stepSize);
      const rightVal = Math.min(1, center + stepSize);
      candidates.push(leftVal, rightVal);
    }
  }
  return candidates;
};

const perturbAndEvaluate = (
  genome: readonly number[],
  targetSignal: readonly number[],
  sampleRate: number,
): PerturbationResult => {
  const perturbed = [...genome] as number[];
  for (let i = 0; i < perturbed.length; i++) {
    if (i % OSC_PARAMS === 0) {
      continue;
    }
    if (Math.random() < RANDOM_PERTURB_RATE) {
      const delta =
        Math.random() * RANDOM_PERTURB_MAG * 2 - RANDOM_PERTURB_MAG;
      perturbed[i] = clamp01((perturbed[i] ?? 0) + delta);
    }
  }
  const score = evaluateSuppression(
    perturbed,
    targetSignal,
    sampleRate,
  );
  return { genome: perturbed, score };
};

const applyRandomPerturbation = (
  genome: readonly number[],
  targetSignal: readonly number[],
  sampleRate: number,
  currentBest: number,
): { result: PerturbationResult; accepted: boolean } => {
  const result = perturbAndEvaluate(genome, targetSignal, sampleRate);
  const accepted = result.score > currentBest;
  if (accepted) {
    console.log(
      `[CoordDescent] Random perturbation improved score to ${result.score.toFixed(4)}%`,
    );
  } else {
    console.log(`[CoordDescent] Random perturbation applied`);
  }
  return { result, accepted };
};

const updateStepAndStagnation = (
  paramIndex: number,
  improved: boolean,
  step: number,
  steps: number[],
  stagnationPerParam: number[],
): void => {
  if (improved) {
    steps[paramIndex] = Math.max(
      FINE_STEP_BASE * 0.25,
      step * STEP_SHRINK_FACTOR,
    );
    stagnationPerParam[paramIndex] = 0;
  } else {
    const prevStagnation = stagnationPerParam[paramIndex] ?? 0;
    stagnationPerParam[paramIndex] = prevStagnation + 1;
    if ((prevStagnation + 1) % 20 === 0) {
      steps[paramIndex] = Math.min(0.15, step * STEP_GROWTH_FACTOR);
    }
  }
};

const optimizeSingleParameter = (
  genome: readonly number[],
  paramIndex: number,
  step: number,
  targetSignal: readonly number[],
  sampleRate: number,
  currentBest: number,
  steps: number[],
  stagnationPerParam: number[],
): {
  genome: number[];
  score: number;
  improved: boolean;
} => {
  const center = genome[paramIndex] ?? 0;
  const isVolume = paramIndex % OSC_PARAMS === 9;
  const candidates = generateCandidates(center, step, isVolume);

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

  const improved = bestCandidate !== null;
  updateStepAndStagnation(
    paramIndex,
    improved,
    step,
    steps,
    stagnationPerParam,
  );

  if (improved) {
    return {
      genome: bestCandidate ?? ([...genome] as number[]),
      score: bestScore,
      improved: true,
    };
  }

  return {
    genome: [...genome] as number[],
    score: currentBest,
    improved: false,
  };
};

const coordinateDescentPass = (
  genome: number[],
  steps: number[],
  targetSignal: readonly number[],
  sampleRate: number,
  currentBest: number,
  numOsc: number,
  bestGenome: number[],
  stagnationPerParam: number[],
): { genome: number[]; score: number; bestGenome: number[] } => {
  let score = currentBest;

  for (let osc = 0; osc < numOsc; osc++) {
    const base = osc * OSC_PARAMS;
    for (let p = 1; p < OSC_PARAMS; p++) {
      const i = base + p;
      const step = steps[i] ?? FINE_STEP_BASE;
      const result = optimizeSingleParameter(
        genome,
        i,
        step,
        targetSignal,
        sampleRate,
        score,
        steps,
        stagnationPerParam,
      );
      genome.length = 0;
      genome.push(...result.genome);
      score = result.score;
      if (result.improved) {
        bestGenome.length = 0;
        bestGenome.push(...genome);
      }
    }
  }

  return { genome, score, bestGenome };
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
    const savedFlag = genome[base];
    genome[base] = 0;
    const scoreAfter = evaluateSuppression(
      genome,
      targetSignal,
      sampleRate,
    );
    if (score - scoreAfter > 0.05) {
      genome[base] = savedFlag ?? 0;
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
  status: ProgressEntry['status'],
): void => {
  const entry: ProgressEntry = {
    iteration,
    suppressionPercent,
    status,
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

  const steps: number[] = Array.from(
    { length: genomeLength },
    () => FINE_STEP_BASE,
  );
  let genome = initGenome(initialVector);
  let bestGenome: number[] = [...genome];

  let currentBest = evaluateSuppression(
    genome,
    targetSignal,
    sampleRate,
  );
  const history: ProgressEntry[] = [];
  const stagnationPerParam: number[] = Array.from(
    { length: genomeLength },
    () => 0,
  );
  let globalStagnation = 0;

  console.log(
    `[CoordDescent] Starting at ${currentBest.toFixed(4)}%, ${countActiveOscillators(genome)} active/${numOsc} osc, ${genomeLength} params`,
  );

  for (let iter = 0; iter < maxIterations; iter++) {
    const preIterBest = currentBest;

    if (globalStagnation > EARLY_EXIT_THRESHOLD) {
      console.log(
        `[CoordDescent] Early exit at iter ${iter + 1} (${globalStagnation} stagnant)`,
      );
      break;
    }

    if (globalStagnation > STAGNATION_PERTURB_THRESHOLD) {
      const perturbationResult = applyRandomPerturbation(
        genome,
        targetSignal,
        sampleRate,
        currentBest,
      );
      if (perturbationResult.accepted) {
        genome = perturbationResult.result.genome;
        currentBest = perturbationResult.result.score;
        bestGenome = [...genome];
      }
    }

    const passResult = coordinateDescentPass(
      genome,
      steps,
      targetSignal,
      sampleRate,
      currentBest,
      numOsc,
      bestGenome,
      stagnationPerParam,
    );
    genome = passResult.genome;
    currentBest = passResult.score;
    bestGenome = passResult.bestGenome;

    const iterStatus =
      globalStagnation > 0 ? 'stagnation' : 'optimizing';

    emitProgress(
      history,
      onProgress,
      iter + 1,
      currentBest,
      iterStatus,
    );

    if (currentBest > preIterBest + 0.0001) {
      globalStagnation = 0;
    } else {
      globalStagnation++;
    }

    if (currentBest >= 98) {
      break;
    }

    if ((iter + 1) % 20 === 0) {
      console.log(
        `[CoordDescent] Iter ${iter + 1}: ${currentBest.toFixed(4)}%, active=${countActiveOscillators(genome)}, stagn=${globalStagnation}`,
      );
    }
  }

  genome = bestGenome;

  currentBest = finalPruneOscillators(
    genome,
    targetSignal,
    sampleRate,
    currentBest,
    numOsc,
  );

  normalizeFlags(genome, numOsc);

  emitProgress(
    history,
    onProgress,
    maxIterations,
    currentBest,
    'done',
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
  );
};
