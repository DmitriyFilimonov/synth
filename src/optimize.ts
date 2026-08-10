import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './consts';
import { assessCancellationQuality } from './cancellation-assessment';
import { createSynth } from './synth';
import { mapVectorToSynthConfig } from './vector-to-synth-config';

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

interface ProgressEntry {
  iteration: number;
  suppressionPercent: number;
}

export type ProgressCallback = (entry: ProgressEntry) => void;

interface ArgOptimize {
  initialVector: readonly (readonly [number, number])[];
  targetSignal: readonly number[];
  sampleRate: number;
  maxIterations?: number;
  onProgress?: ProgressCallback;
}

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

export const optimize = (
  arg: ArgOptimize,
): {
  vector: (readonly [number, number])[];
  history: ProgressEntry[];
} => {
  let vector = arg.initialVector.map(
    (entry) => [entry[0], entry[1]] as const,
  );

  const maxIterations = arg.maxIterations ?? 100;
  const history: ProgressEntry[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    for (let i = 0; i < vector.length; i++) {
      const entry = vector[i];

      if (!entry) {
        continue;
      }

      const [, step] = entry;
      const vectorValues = vector.map((e) => e[0]);
      const currentSuppression = evaluateSuppression(
        vectorValues,
        arg.targetSignal,
        arg.sampleRate,
      );

      const left = vector.map(
        (entry, index) =>
          [
            index === i ? entry[0] - step : entry[0],
            entry[1],
          ] as const,
      );
      const right = vector.map(
        (entry, index) =>
          [
            index === i ? entry[0] + step : entry[0],
            entry[1],
          ] as const,
      );

      const leftSuppression = evaluateSuppression(
        left.map((e) => e[0]),
        arg.targetSignal,
        arg.sampleRate,
      );
      const rightSuppression = evaluateSuppression(
        right.map((e) => e[0]),
        arg.targetSignal,
        arg.sampleRate,
      );

      if (
        leftSuppression > currentSuppression &&
        leftSuppression >= rightSuppression
      ) {
        vector = left;
      } else if (rightSuppression > currentSuppression) {
        vector = right;
      }

      const bestSuppression = Math.max(
        currentSuppression,
        leftSuppression,
        rightSuppression,
      );
      history.push({
        iteration: iteration + 1,
        suppressionPercent: bestSuppression,
      });

      arg.onProgress?.({
        iteration: iteration + 1,
        suppressionPercent: bestSuppression,
      });

      if (bestSuppression >= 98) {
        return { vector, history };
      }
    }
  }

  return { vector, history };
};
