import { parentPort, workerData } from 'worker_threads';
import { stagedOptimize, runHPO } from './optimize';
import { generateOutput } from './match';
import { mapVectorToSynthConfig } from './vector-to-synth-config';
import { readWav } from './read-wav';
import { MATCH_DEFAULT_HPO_TRIALS } from './match-defaults';
import type { TPEConfig, ResolvedHyperparams } from './optimize/hpo';
import type { CoordinateDescentConfig } from './optimize/types';

if (!parentPort) {
  throw new Error('Must run as worker thread');
}

const sendLog = (message: string): void => {
  try {
    parentPort?.postMessage({ type: 'log', data: message });
  } catch {
    // message channel might be closed, silently ignore
  }
};

console.log = (...args: unknown[]) => {
  sendLog(args.map((a) => String(a)).join(' '));
};
console.error = (...args: unknown[]) => {
  sendLog('[ERR] ' + args.map((a) => String(a)).join(' '));
};
console.warn = (...args: unknown[]) => {
  sendLog('[WARN] ' + args.map((a) => String(a)).join(' '));
};

interface WorkerMessage {
  targetWavPath: string;
  outputWavPath: string;
  initialVector: number[];
  sampleRate: number;
  maxIterations: number;
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
  stageDurationMultiplier?: number;
  hpoTrials?: number;
  hpoTpeConfig?: Partial<TPEConfig>;
}

parentPort.on('message', (msg: WorkerMessage) => {
  try {
    const targetWav = readWav(msg.targetWavPath);
    const targetSignal = [...targetWav.samples];

    const hasUserOverride =
      msg.stepGrowthAdd !== undefined &&
      msg.stepDecayFactor !== undefined &&
      msg.stageDurationMultiplier !== undefined;

    let vector: number[];
    let history: Array<{
      iteration: number;
      suppressionPercent: number;
      stageIndex?: number;
      totalStages?: number;
      stageDurationMs?: number;
    }>;

    if (!hasUserOverride) {
      const nTrials = msg.hpoTrials ?? MATCH_DEFAULT_HPO_TRIALS;
      const numOscillators = msg.initialVector.length / 10;

      console.log(
        `Starting HPO: ${nTrials} trials, ${numOscillators} oscillators`,
      );

      const hpoResult = runHPO({
        targetSignal,
        sampleRate: msg.sampleRate,
        initialVector: msg.initialVector,
        numOscillators,
        nTrials,
        tpeConfig: msg.hpoTpeConfig,
        onProgress: (entry) => {
          parentPort?.postMessage({ type: 'progress', data: entry });
        },
      });

      console.log(`Running staged optimization with best hyperparams`);

      const config = buildCoordDescentConfig(
        hpoResult.bestHyperparams,
      );

      const stagedResult = stagedOptimize({
        initialVector: hpoResult.bestVector,
        targetSignal,
        sampleRate: msg.sampleRate,
        maxIterations: hpoResult.bestHyperparams.iterations,
        stepGrowthAdd: hpoResult.bestHyperparams.stepGrowthAdd,
        stepDecayFactor: hpoResult.bestHyperparams.stepDecayFactor,
        stageDurationMultiplier:
          hpoResult.bestHyperparams.stageDurationMultiplier,
        initialStageMs: hpoResult.bestHyperparams.initialStageMs,
        config,
        onProgress: (entry) => {
          parentPort?.postMessage({ type: 'progress', data: entry });
        },
      });

      vector = stagedResult.vector;
      history = stagedResult.history;

      console.log(
        `HPO + StagedOpt complete. Best: ${hpoResult.bestValue.toFixed(2)}%`,
      );
      console.log(`Best hyperparams:`, hpoResult.bestHyperparams);
    } else {
      const result = stagedOptimize({
        initialVector: msg.initialVector,
        targetSignal,
        sampleRate: msg.sampleRate,
        maxIterations: msg.maxIterations,
        stepGrowthAdd: msg.stepGrowthAdd,
        stepDecayFactor: msg.stepDecayFactor,
        stageDurationMultiplier: msg.stageDurationMultiplier,
        onProgress: (entry) => {
          parentPort?.postMessage({ type: 'progress', data: entry });
        },
      });

      vector = result.vector;
      history = result.history;
    }

    generateOutput({
      vector,
      targetSignal,
      numSamples: targetWav.samples.length,
      sampleRate: msg.sampleRate,
      outputWavPath: msg.outputWavPath,
      history,
    });

    const optimizedConfig = mapVectorToSynthConfig(vector);

    parentPort?.postMessage({
      type: 'done',
      data: {
        history,
        targetInfo: {
          sampleRate: targetWav.sampleRate,
          numSamples: targetWav.samples.length,
          bitsPerSample: targetWav.bitsPerSample,
          numChannels: targetWav.numChannels,
        },
        suppressionPercent:
          history.length > 0
            ? (history[history.length - 1]?.suppressionPercent ?? 0)
            : 0,
        bestVector: vector,
        synthConfig: optimizedConfig,
      },
    });
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      data: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

function buildCoordDescentConfig(
  hyperparams: ResolvedHyperparams,
): CoordinateDescentConfig {
  return {
    stagnationExitThreshold: hyperparams.stagnationExitThreshold ?? 5,
    plateauRestartThreshold: hyperparams.plateauRestartThreshold ?? 3,
    stepGrowthThreshold: hyperparams.stepGrowthThreshold ?? 4,
    stagnationStepDecayFactor:
      hyperparams.stagnationDecayFactor ?? 0.8,
    significantImprovementThreshold:
      hyperparams.significantImprovementThreshold ?? 0.01,
    earlyExitSuppression:
      hyperparams.earlyExitSuppression ?? 98,
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
  };
}
