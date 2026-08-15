import { SAMPLE_RATE } from './consts';
import { mapSynthConfigToVector } from './synth-config-to-vector';
import { readWav } from './read-wav';
import { SYNTH_DEFAULT_PRESET } from './match-preset';
import { MATCH_DEFAULT_STAGE_DURATION_MULTIPLIER } from './match-defaults';
import {
  optimize,
  ProgressCallback,
  stagedOptimize,
  runHPO,
  type ArgHPO,
  type CoordinateDescentConfig,
  type ResolvedHyperparams,
} from './optimize';
import { mapVectorToSynthConfig } from './vector-to-synth-config';
import { createSynth, ArgCreateSynth } from './synth';
import { writeWav } from './write-wav';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './consts';
import { matchVisualize } from './match-visualize';

interface ArgMatch {
  targetWavPath: string;
  outputWavPath: string;
  maxIterations?: number;
  initialVector?: readonly number[];
  onProgress?: ProgressCallback;
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
  stageDurationMultiplier?: number;
  hpoTrials?: number;
  hpoConfig?: Partial<ArgHPO['tpeConfig']>;
}

interface MatchResult {
  optimizedVector: number[];
  optimizedConfig: ArgCreateSynth;
  history: { iteration: number; suppressionPercent: number }[];
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  };
}

export interface GenerateOutputArgs {
  vector: readonly number[];
  targetSignal: readonly number[];
  numSamples: number;
  sampleRate: number;
  outputWavPath: string;
  history: { iteration: number; suppressionPercent: number }[];
}

export interface GenerateOutputResult {
  samples: Int16Array;
  synthConfig: ArgCreateSynth;
}

export const generateOutput = (
  arg: GenerateOutputArgs,
): GenerateOutputResult => {
  const optimizedConfig = mapVectorToSynthConfig([...arg.vector]);

  const synth = createSynth(optimizedConfig);
  const samples = new Int16Array(arg.numSamples);

  for (let i = 0; i < arg.numSamples; i++) {
    const timeSeconds = i / arg.sampleRate;
    const sample = synth({ x: timeSeconds });
    samples[i] = Math.round(
      sample * MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    );
  }

  writeWav({
    samples,
    sampleRate: arg.sampleRate,
    filePath: arg.outputWavPath,
  });

  const visualizationPath = `${arg.outputWavPath}-match`;
  matchVisualize({
    targetSignal: [...arg.targetSignal],
    synthSignal: [...samples],
    sampleRate: arg.sampleRate,
    outputPath: visualizationPath,
    history: arg.history,
  });

  return { samples, synthConfig: optimizedConfig };
};

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

  const initialVector = arg.initialVector
    ? [...arg.initialVector]
    : mapSynthConfigToVector(SYNTH_DEFAULT_PRESET);

  console.log(`Vector size: ${initialVector.length} parameters`);
  console.log(`Starting optimization...`);

  const maxIterations = arg.maxIterations ?? 100;

  let vector: number[];
  let history: { iteration: number; suppressionPercent: number }[];

  const hasUserOverride =
    arg.stepGrowthAdd !== undefined &&
    arg.stepDecayFactor !== undefined;

  if (hasUserOverride) {
    const result = stagedOptimize({
      initialVector,
      targetSignal,
      sampleRate: SAMPLE_RATE,
      maxIterations,
      onProgress: arg.onProgress,
      stepGrowthAdd: arg.stepGrowthAdd,
      stepDecayFactor: arg.stepDecayFactor,
      stageDurationMultiplier: arg.stageDurationMultiplier,
    });
    vector = result.vector;
    history = result.history;
  } else {
    const nTrials = arg.hpoTrials ?? 30;
    const numOscillators = initialVector.length / 10;

    console.log(
      `Starting HPO: ${nTrials} trials, ${numOscillators} oscillators`,
    );

    const hpoResult = runHPO({
      targetSignal,
      sampleRate: SAMPLE_RATE,
      initialVector,
      numOscillators,
      nTrials,
      onProgress: undefined,
      tpeConfig: arg.hpoConfig,
    });

    const config = buildCoordDescentConfig(hpoResult.bestHyperparams);

    const stagedResult = stagedOptimize({
      initialVector: hpoResult.bestVector,
      targetSignal,
      sampleRate: SAMPLE_RATE,
      maxIterations,
      stepGrowthAdd: hpoResult.bestHyperparams.stepGrowthAdd,
      stepDecayFactor: hpoResult.bestHyperparams.stepDecayFactor,
      stageDurationMultiplier:
        arg.stageDurationMultiplier ??
        MATCH_DEFAULT_STAGE_DURATION_MULTIPLIER,
      initialStageMs: 10,
      config,
      onProgress: arg.onProgress,
    });

    vector = stagedResult.vector;
    history = stagedResult.history.map((h) => ({
      iteration: h.iteration,
      suppressionPercent: h.suppressionPercent,
    }));

    console.log(
      `HPO + StagedOpt complete. Best: ${hpoResult.bestValue.toFixed(2)}%`,
    );
    console.log(`Best hyperparams:`, hpoResult.bestHyperparams);
  }

  const bestSuppression =
    history.length > 0
      ? (history[history.length - 1]?.suppressionPercent ?? 0)
      : 0;
  console.log(
    `Optimization complete. Suppression: ${bestSuppression.toFixed(2)}%`,
  );

  generateOutput({
    vector,
    targetSignal,
    numSamples,
    sampleRate: SAMPLE_RATE,
    outputWavPath: arg.outputWavPath,
    history,
  });

  console.log(`Generated: ${arg.outputWavPath}`);

  return {
    optimizedVector: vector,
    optimizedConfig: mapVectorToSynthConfig(vector),
    history,
    targetInfo: {
      sampleRate: targetWav.sampleRate,
      numSamples,
      bitsPerSample: targetWav.bitsPerSample,
      numChannels: targetWav.numChannels,
    },
  };
};

function buildCoordDescentConfig(
  hyperparams: ResolvedHyperparams,
): Partial<CoordinateDescentConfig> {
  return {
    stagnationExitThreshold: hyperparams.stagnationExitThreshold ?? 5,
    plateauRestartThreshold: hyperparams.plateauRestartThreshold ?? 3,
    stepGrowthThreshold: hyperparams.stepGrowthThreshold ?? 4,
    stagnationStepDecayFactor:
      hyperparams.stagnationDecayFactor ?? 0.8,
    significantImprovementThreshold:
      hyperparams.significantImprovementThreshold ?? 0.01,
    earlyExitSuppression: hyperparams.earlyExitSuppression ?? 98,
    maxRestartsBeforeRandomRestart:
      hyperparams.maxRestartsBeforeRandomRestart ?? 5,
    kickFallbackThreshold: hyperparams.kickFallbackThreshold ?? 0.8,
    restartSchedule: [
      {
        startStep: hyperparams.explorationStartStep ?? 0.05,
        minStep: hyperparams.explorationMinStep ?? 0.01,
        label: 'EXPLORATION',
      },
      {
        startStep: hyperparams.refinementStartStep ?? 0.02,
        minStep: hyperparams.refinementMinStep ?? 0.005,
        label: 'REFINEMENT',
      },
      {
        startStep: hyperparams.precisionStartStep ?? 0.005,
        minStep: hyperparams.precisionMinStep ?? 0.001,
        label: 'PRECISION',
      },
    ],
    frequencyStep: hyperparams.frequencyStep ?? 0.0000001,
    frequencyStepCoarse: hyperparams.frequencyStepCoarse ?? 0.0001,
    phaseStep: hyperparams.phaseStep ?? 0.003125,
  };
}
