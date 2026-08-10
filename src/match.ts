import { SAMPLE_RATE } from './consts';
import { mapSynthConfigToVector } from './synth-config-to-vector';
import { readWav } from './read-wav';
import { SYNTH_DEFAULT_PRESET } from './match-preset';
import { optimize, ProgressCallback } from './optimize';
import { mapVectorToSynthConfig } from './vector-to-synth-config';
import { createSynth, ArgCreateSynth } from './synth';
import { writeWav } from './write-wav';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './consts';
import { matchVisualize } from './match-visualize';

interface ArgMatch {
  targetWavPath: string;
  outputWavPath: string;
  maxIterations?: number;
  onProgress?: ProgressCallback;
}

interface MatchResult {
  optimizedVector: (readonly [number, number])[];
  optimizedConfig: ArgCreateSynth;
  history: { iteration: number; suppressionPercent: number }[];
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  };
}

export const match = (arg: ArgMatch): MatchResult => {
  console.log(`Reading target: ${arg.targetWavPath}`);
  const targetWav = readWav(arg.targetWavPath);

  if (targetWav.sampleRate !== SAMPLE_RATE) {
    throw new Error(
      `Sample rate mismatch: expected ${SAMPLE_RATE}, got ${targetWav.sampleRate}. Resampling is not supported.`,
    );
  }

  const numSamples = targetWav.samples.length;
  const targetSignal = [...targetWav.samples];

  console.log(
    `Target: ${numSamples} samples, ${targetWav.numChannels}ch, ${targetWav.bitsPerSample}-bit`,
  );

  const initialVector = mapSynthConfigToVector(SYNTH_DEFAULT_PRESET);

  console.log(`Vector size: ${initialVector.length} parameters`);
  console.log(`Starting optimization...`);

  const { vector, history } = optimize({
    initialVector,
    targetSignal,
    sampleRate: SAMPLE_RATE,
    maxIterations: arg.maxIterations,
    onProgress: arg.onProgress,
  });

  const bestSuppression =
    history.length > 0
      ? (history[history.length - 1]?.suppressionPercent ?? 0)
      : 0;
  console.log(
    `Optimization complete. Suppression: ${bestSuppression.toFixed(2)}%`,
  );

  const optimizedConfig = mapVectorToSynthConfig(
    vector.map((entry) => entry[0]),
  );

  console.log(`Generating output WAV...`);
  const synth = createSynth(optimizedConfig);
  const samples = new Int16Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const timeSeconds = i / SAMPLE_RATE;
    const sample = synth({ x: timeSeconds });
    samples[i] = Math.round(
      sample * MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    );
  }

  writeWav({
    samples,
    sampleRate: SAMPLE_RATE,
    filePath: arg.outputWavPath,
  });
  console.log(`Generated: ${arg.outputWavPath}`);

  const visualizationPath = `${arg.outputWavPath}-match`;
  matchVisualize({
    targetSignal,
    synthSignal: [...samples],
    sampleRate: SAMPLE_RATE,
    outputPath: visualizationPath,
    history,
  });

  return {
    optimizedVector: vector,
    optimizedConfig,
    history,
    targetInfo: {
      sampleRate: targetWav.sampleRate,
      numSamples,
      bitsPerSample: targetWav.bitsPerSample,
      numChannels: targetWav.numChannels,
    },
  };
};
