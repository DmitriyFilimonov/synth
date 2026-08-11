import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './consts';
import { assessCancellationQuality } from './cancellation-assessment';
import { createSynth } from './synth';
import { mapVectorToSynthConfig } from './vector-to-synth-config';

const OSC_PARAMS = 10;

const isOscEnabled = (vec: readonly number[], idx: number): boolean => {
  const v = vec[idx];
  return v !== undefined && v >= 0.5;
};

const hasActiveOsc = (vec: readonly number[]): boolean => {
  for (let i = 0; i < vec.length; i += OSC_PARAMS) {
    if (isOscEnabled(vec, i)) {
      return true;
    }
  }
  return false;
};

const countActiveOscillators = (vec: readonly number[]): number => {
  let count = 0;
  for (let i = 0; i < vec.length; i += OSC_PARAMS) {
    if (isOscEnabled(vec, i)) {
      count++;
    }
  }
  return count;
};

const createWaveForm = (
  vectorValues: readonly number[],
  sampleRate: number,
  numSamples: number,
): number[] => {
  const synth = createSynth(
    mapVectorToSynthConfig([...vectorValues]),
  );
  const samples: number[] = [];
  for (let i = 0; i < numSamples; i++) {
    const timeSeconds = i / sampleRate;
    const sample = synth({ x: timeSeconds });
    samples.push(sample * MAX_AMPLITUDE_16_BIT_WAV_ENCODED);
  }
  return samples;
};

const evaluateSuppression = (
  vectorValues: readonly number[],
  targetSignal: readonly number[],
  sampleRate: number,
): number => {
  const generated = createWaveForm(
    vectorValues,
    sampleRate,
    targetSignal.length,
  );
  const inverted = generated.map((s) => -s);
  const assessment = assessCancellationQuality({
    target: [...targetSignal],
    generated: inverted,
  });
  return assessment.suppressionPercent;
};

interface ProgressEntry {
  iteration: number;
  suppressionPercent: number;
  status?:
    | 'optimizing'
    | 'stagnation'
    | 'cataclysm'
    | 'fine_tuning'
    | 'done';
}

export type ProgressCallback = (entry: ProgressEntry) => void;

interface ArgOptimize {
  initialVector: readonly number[];
  targetSignal: readonly number[];
  sampleRate: number;
  maxIterations?: number;
  onProgress?: ProgressCallback;
  numOscillators?: number;
}

const POPULATION_SIZE = 40;
const ELITE_COUNT = 3;
const TOURNAMENT_SIZE = 4;
const GA_PHASE_RATIO = 0.4;
const FINE_STEP_BASE = 0.005;

const normalizeGenome = (genome: number[]): number[] => {
  const result: number[] = [];
  for (let i = 0; i < genome.length; i++) {
    const v = Math.max(0, Math.min(1, genome[i] ?? 0));
    result.push(Number.isFinite(v) ? v : 0);
  }
  return result;
};

const createRandomGenome = (
  initial: readonly number[],
  sigma: number,
  genomeLength: number,
): number[] => {
  const genome: number[] = [];
  for (let i = 0; i < genomeLength; i++) {
    const value = initial[i] ?? 0;
    genome.push(value + (Math.random() - 0.5) * sigma * 2);
  }
  return normalizeGenome(genome);
};

const runGaPhase = (
  arg: ArgOptimize,
  genomeLength: number,
  generations: number,
  onProgress: ProgressCallback,
): {
  bestGenome: number[];
  bestFit: number;
  history: ProgressEntry[];
} => {
  const fitness = (genome: number[]): number => {
    if (!hasActiveOsc(genome)) {
      return -100;
    }
    const suppression = evaluateSuppression(
      genome,
      arg.targetSignal,
      arg.sampleRate,
    );
    const activeCount = countActiveOscillators(genome);
    const penalty = Math.max(0, activeCount - 8) * 0.15;
    return suppression - penalty;
  };

  const tournamentSelect = (
    population: number[][],
    fitnesses: number[],
  ): number[] => {
    let bestGenome = population[0];
    let bestFit = -Infinity;
    for (let i = 0; i < TOURNAMENT_SIZE; i++) {
      const idx = Math.floor(Math.random() * population.length);
      const fit = fitnesses[idx] ?? -Infinity;
      if (fit > bestFit) {
        bestFit = fit;
        bestGenome = population[idx];
      }
    }
    return [...(bestGenome ?? population[0] ?? [])];
  };

  const blendCrossover = (p1: number[], p2: number[]): number[] => {
    const child: number[] = [];
    for (let i = 0; i < p1.length; i++) {
      const v1 = p1[i] ?? 0;
      const v2 = p2[i] ?? 0;
      child.push(v1 * Math.random() + v2 * (1 - Math.random()));
    }
    return child;
  };

  const mutate = (
    genome: number[],
    sigma: number,
    prob: number,
  ): number[] => {
    const mutated: number[] = [];
    for (let osc = 0; osc < genome.length / OSC_PARAMS; osc++) {
      const onIdx = osc * OSC_PARAMS;
      const currentlyOn = isOscEnabled(genome, onIdx);
      for (let p = 0; p < OSC_PARAMS; p++) {
        const idx = onIdx + p;
        const current = genome[idx] ?? 0;
        const probForParam = p === 0 ? prob : currentlyOn ? prob : 0;
        mutated.push(
          Math.random() < probForParam
            ? current + (Math.random() - 0.5) * sigma * 2
            : current,
        );
      }
    }
    return normalizeGenome(mutated);
  };

  const population: number[][] = [];
  population.push(normalizeGenome([...arg.initialVector]));
  for (let i = 1; i < POPULATION_SIZE; i++) {
    population.push(
      createRandomGenome(arg.initialVector, 0.5, genomeLength),
    );
  }

  const history: ProgressEntry[] = [];
  let globalBestGenome = [...(population[0] ?? [])];
  let globalBestFit = -Infinity;
  let stagnationCount = 0;
  let prevBest = -Infinity;

  for (let gen = 0; gen < generations; gen++) {
    const sigma = Math.min(0.5, 0.1 + stagnationCount * 0.008);
    const prob = Math.min(0.5, 0.2 + stagnationCount * 0.005);

    const fitnesses = population.map((genome) => {
      const f = fitness(genome);
      if (f > globalBestFit) {
        globalBestFit = f;
        globalBestGenome = [...genome];
      }
      return f;
    });

    const genBest = Math.max(...fitnesses);

    if (genBest - prevBest < 0.01) {
      stagnationCount++;
    } else {
      stagnationCount = 0;
      prevBest = genBest;
    }

    const status =
      stagnationCount > 50
        ? 'stagnation'
        : stagnationCount === 0
          ? 'optimizing'
          : 'stagnation';

    history.push({
      iteration: gen + 1,
      suppressionPercent: globalBestFit,
      status,
    });

    onProgress({
      iteration: gen + 1,
      suppressionPercent: globalBestFit,
      status,
    });

    if (stagnationCount > 50 && stagnationCount % 50 < 2) {
      console.log(
        `[GA] Cataclysm triggered at gen ${gen + 1} (stagn=${stagnationCount})`,
      );
      const replaceCount = Math.floor(POPULATION_SIZE * 0.5);
      for (let i = 0; i < replaceCount; i++) {
        const fresh = createRandomGenome(
          arg.initialVector,
          1.0,
          genomeLength,
        );
        if (hasActiveOsc(fresh)) {
          population[POPULATION_SIZE - replaceCount + i] = fresh;
        }
      }
      stagnationCount = 0;
      prevBest = -Infinity;
      onProgress({
        iteration: gen + 1,
        suppressionPercent: globalBestFit,
        status: 'cataclysm',
      });
    }

    if (globalBestFit >= 98) {
      break;
    }

    const indexed = population.map((g, i) => ({
      genome: g,
      fit: fitnesses[i] ?? -Infinity,
    }));
    indexed.sort((a, b) => b.fit - a.fit);

    const elites = indexed
      .slice(0, ELITE_COUNT)
      .map((e) => [...e.genome]);
    const newPopulation: number[][] = [...elites];

    while (newPopulation.length < POPULATION_SIZE) {
      const p1 = tournamentSelect(population, fitnesses);
      const p2 = tournamentSelect(population, fitnesses);
      const child = blendCrossover(p1, p2);
      const mutated = mutate(child, sigma, prob);
      if (hasActiveOsc(mutated)) {
        newPopulation.push(mutated);
      }
    }

    if (gen % 30 === 0 && gen > 0) {
      const replaceCount = 5;
      for (let i = 0; i < replaceCount; i++) {
        const rnd = createRandomGenome(
          arg.initialVector,
          0.4,
          genomeLength,
        );
        if (hasActiveOsc(rnd)) {
          const idx = POPULATION_SIZE - replaceCount + i;
          if (idx < POPULATION_SIZE && idx < newPopulation.length) {
            newPopulation[idx] = rnd;
          } else {
            newPopulation.push(rnd);
          }
        }
      }
    }

    while (newPopulation.length < POPULATION_SIZE) {
      const rnd = createRandomGenome(
        arg.initialVector,
        0.2,
        genomeLength,
      );
      if (hasActiveOsc(rnd)) {
        newPopulation.push(rnd);
      }
    }

    population.length = 0;
    for (const g of newPopulation) {
      population.push(g);
    }

    if ((gen + 1) % 10 === 0) {
      console.log(
        `[GA] Gen ${gen + 1}: best=${globalBestFit.toFixed(4)}%, gen=${genBest.toFixed(4)}%, stagn=${stagnationCount}`,
      );
    }
  }

  return {
    bestGenome: globalBestGenome,
    bestFit: globalBestFit,
    history,
  };
};

const runFineTunePhase = (
  genome: number[],
  arg: ArgOptimize,
  maxIterations: number,
  startIteration: number,
  onProgress: ProgressCallback,
  prevHistory: ProgressEntry[],
): {
  bestGenome: number[];
  bestFit: number;
  history: ProgressEntry[];
} => {
  const steps: number[] = genome.map(() => FINE_STEP_BASE);
  let currentGenome = [...genome];
  let currentBest = evaluateSuppression(
    currentGenome,
    arg.targetSignal,
    arg.sampleRate,
  );
  const history: ProgressEntry[] = [...prevHistory];
  const stagnationPerParam = new Array(genome.length).fill(0);

  console.log(
    `[Hybrid] Fine-tune phase: starting at ${currentBest.toFixed(4)}%, ${genome.length} params`,
  );

  for (let iter = 0; iter < maxIterations; iter++) {
    let iterImproved = false;

    for (let osc = 0; osc < genome.length / OSC_PARAMS; osc++) {
      const base = osc * OSC_PARAMS;
      if (!isOscEnabled(currentGenome, base)) {
        continue;
      }

      for (let p = 0; p < OSC_PARAMS; p++) {
        const i = base + p;
        const step = steps[i] ?? FINE_STEP_BASE;
        const center = currentGenome[i] ?? 0;

        const left = [...currentGenome];
        left[i] = Math.max(0, center - step);

        const right = [...currentGenome];
        right[i] = Math.min(1, center + step);

        let bestScore = currentBest;
        let bestCandidate = currentGenome;

        const scoreLeft = evaluateSuppression(
          left,
          arg.targetSignal,
          arg.sampleRate,
        );
        if (scoreLeft > bestScore) {
          bestScore = scoreLeft;
          bestCandidate = left;
        }

        const scoreRight = evaluateSuppression(
          right,
          arg.targetSignal,
          arg.sampleRate,
        );
        if (scoreRight > bestScore) {
          bestScore = scoreRight;
          bestCandidate = right;
        }

        if (bestCandidate !== currentGenome) {
          currentGenome = bestCandidate;
          currentBest = bestScore;
          iterImproved = true;
          stagnationPerParam[i] = 0;
          steps[i] = Math.max(
            FINE_STEP_BASE * 0.1,
            (steps[i] ?? FINE_STEP_BASE) * 0.9,
          );
        } else {
          stagnationPerParam[i]++;
          if (stagnationPerParam[i] % 50 === 0) {
            steps[i] = Math.min(
              0.1,
              (steps[i] ?? FINE_STEP_BASE) * 1.5,
            );
          }
        }
      }
    }

    history.push({
      iteration: startIteration + iter + 1,
      suppressionPercent: currentBest,
      status: 'fine_tuning',
    });

    onProgress({
      iteration: startIteration + iter + 1,
      suppressionPercent: currentBest,
      status: 'fine_tuning',
    });

    if (currentBest >= 98) {
      break;
    }

    if (!iterImproved) {
      for (let osc = 0; osc < genome.length / OSC_PARAMS; osc++) {
        const base = osc * OSC_PARAMS;
        if (!isOscEnabled(currentGenome, base)) {
          continue;
        }

        for (let p = 0; p < OSC_PARAMS; p++) {
          const i = base + p;
          const step = (steps[i] ?? FINE_STEP_BASE) * 2;
          const perturbed = [...currentGenome];
          perturbed[i] = Math.max(
            0,
            Math.min(
              1,
              (perturbed[i] ?? 0) + (Math.random() - 0.5) * step,
            ),
          );
          const score = evaluateSuppression(
            perturbed,
            arg.targetSignal,
            arg.sampleRate,
          );
          if (score > currentBest) {
            currentGenome = perturbed;
            currentBest = score;
          }
        }
      }
    }

    if ((iter + 1) % 20 === 0) {
      console.log(
        `[Fine] Iter ${startIteration + iter + 1}: ${currentBest.toFixed(4)}%`,
      );
    }
  }

  return { bestGenome: currentGenome, bestFit: currentBest, history };
};

export const optimize = (
  arg: ArgOptimize,
): {
  vector: number[];
  history: ProgressEntry[];
} => {
  const maxIterations = arg.maxIterations ?? 100;
  const genomeLength = arg.initialVector.length;

  const gaGens = Math.floor(maxIterations * GA_PHASE_RATIO);
  const fineIters = maxIterations - gaGens;

  const {
    bestGenome: gaBest,
    bestFit: gaFit,
    history: gaHistory,
  } = runGaPhase(
    arg,
    genomeLength,
    gaGens,
    arg.onProgress ?? (() => {}),
  );

  console.log(
    `[Hybrid] GA phase done: ${gaFit.toFixed(4)}%, switching to fine-tune`,
  );

  const { bestGenome, bestFit, history } = runFineTunePhase(
    gaBest,
    arg,
    fineIters,
    gaGens,
    arg.onProgress ?? (() => {}),
    gaHistory,
  );

  return { vector: bestGenome, history };
};
