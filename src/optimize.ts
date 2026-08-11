import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './consts';
import { assessCancellationQuality } from './cancellation-assessment';
import { createSynth } from './synth';
import { mapVectorToSynthConfig } from './vector-to-synth-config';

const OSC_PARAMS = 10;

const isOscEnabled = (
  vec: readonly number[],
  idx: number,
): boolean => {
  const v = vec[idx];
  return v !== undefined && v >= 0.5;
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

const FINE_STEP_BASE = 0.005;
const STEP_GROWTH_FACTOR = 1.5;
const STEP_SHRINK_FACTOR = 0.5;
const STAGNATION_THRESHOLD = 100;
const EARLY_EXIT_THRESHOLD = 300;
const OSC_SCAN_INTERVAL = 50;

const normalizeGenome = (genome: number[]): number[] => {
  const result: number[] = [];
  for (let i = 0; i < genome.length; i++) {
    const v = Math.max(0, Math.min(1, genome[i] ?? 0));
    result.push(Number.isFinite(v) ? v : 0);
  }
  return result;
};

export const optimize = (
  arg: ArgOptimize,
): {
  vector: number[];
  history: ProgressEntry[];
} => {
  const maxIterations = arg.maxIterations ?? 100;
  const genomeLength = arg.initialVector.length;
  const numOsc = genomeLength / OSC_PARAMS;

  const steps: number[] = new Array(genomeLength).fill(FINE_STEP_BASE);
  const genome = normalizeGenome([...arg.initialVector]);

  let currentBest = evaluateSuppression(
    genome,
    arg.targetSignal,
    arg.sampleRate,
  );
  const history: ProgressEntry[] = [];
  const stagnationPerParam = new Array(genomeLength).fill(0);
  let globalStagnation = 0;

  console.log(
    `[CoordDescent] Starting at ${currentBest.toFixed(4)}%, ${numOsc} osc, ${genomeLength} params`,
  );

  for (let iter = 0; iter < maxIterations; iter++) {
    let iterImproved = false;

    if (globalStagnation > EARLY_EXIT_THRESHOLD) {
      console.log(
        `[CoordDescent] Early exit at iter ${iter + 1} (${globalStagnation} stagnant)`,
      );
      break;
    }

    if (
      globalStagnation > STAGNATION_THRESHOLD &&
      globalStagnation % OSC_SCAN_INTERVAL === 0
    ) {
      console.log(
        `[CoordDescent] Stagnation ${globalStagnation}, scanning osc...`,
      );
      let bestCandidateGenome = [...genome];
      let bestCandidateScore = currentBest;

      for (let osc = 0; osc < numOsc; osc++) {
        const base = osc * OSC_PARAMS;
        const currentlyOn = isOscEnabled(genome, base);

        if (currentlyOn) {
          const offGenome = [...genome];
          offGenome[base] = Math.max(0, (offGenome[base] ?? 0) - 0.5);
          const score = evaluateSuppression(
            offGenome,
            arg.targetSignal,
            arg.sampleRate,
          );
          if (score > bestCandidateScore) {
            bestCandidateScore = score;
            bestCandidateGenome = offGenome;
          }
        } else {
          const onGenome = [...genome];
          onGenome[base] = 0.5;
          const onScore = evaluateSuppression(
            onGenome,
            arg.targetSignal,
            arg.sampleRate,
          );
          if (onScore > bestCandidateScore) {
            bestCandidateScore = onScore;
            bestCandidateGenome = onGenome;
          }
        }
      }

      if (bestCandidateScore > currentBest + 0.001) {
        console.log(
          `[CoordDescent] Escaping stagnation: ${currentBest.toFixed(4)}% -> ${bestCandidateScore.toFixed(4)}%`,
        );
        genome.length = 0;
        genome.push(...bestCandidateGenome);
        currentBest = bestCandidateScore;
        globalStagnation = 0;
        stagnationPerParam.fill(0);
        steps.fill(FINE_STEP_BASE);
      } else {
        globalStagnation++;
      }
    }

    for (let osc = 0; osc < numOsc; osc++) {
      const base = osc * OSC_PARAMS;
      if (!isOscEnabled(genome, base)) {
        continue;
      }

      for (let p = 0; p < OSC_PARAMS; p++) {
        const i = base + p;
        const step = steps[i] ?? FINE_STEP_BASE;
        const center = genome[i] ?? 0;

        const left = [...genome];
        left[i] = Math.max(0, center - step);

        const right = [...genome];
        right[i] = Math.min(1, center + step);

        let bestScore = currentBest;
        let bestCandidate = genome;

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

        if (bestCandidate !== genome) {
          genome.length = 0;
          genome.push(...bestCandidate);
          currentBest = bestScore;
          iterImproved = true;
          stagnationPerParam[i] = 0;
          globalStagnation = 0;
          steps[i] = Math.max(
            FINE_STEP_BASE * 0.1,
            (steps[i] ?? FINE_STEP_BASE) * STEP_SHRINK_FACTOR,
          );
        } else {
          stagnationPerParam[i]++;
          globalStagnation++;
          if (stagnationPerParam[i] % 50 === 0) {
            steps[i] = Math.min(
              0.1,
              (steps[i] ?? FINE_STEP_BASE) * STEP_GROWTH_FACTOR,
            );
          }
        }
      }
    }

    history.push({
      iteration: iter + 1,
      suppressionPercent: currentBest,
      status: globalStagnation > 0 ? 'stagnation' : 'optimizing',
    });

    arg.onProgress?.({
      iteration: iter + 1,
      suppressionPercent: currentBest,
      status: globalStagnation > 0 ? 'stagnation' : 'optimizing',
    });

    if (currentBest >= 98) {
      break;
    }

    if ((iter + 1) % 20 === 0) {
      console.log(
        `[CoordDescent] Iter ${iter + 1}: ${currentBest.toFixed(4)}%, stagn=${globalStagnation}`,
      );
    }
  }

  return { vector: genome, history };
};
