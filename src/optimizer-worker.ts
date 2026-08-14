import { parentPort, workerData } from 'worker_threads';
import { stagedOptimize, runHPO } from './optimize';
import { generateOutput } from './match';
import { mapVectorToSynthConfig } from './vector-to-synth-config';
import { readWav } from './read-wav';
import {
  MATCH_DEFAULT_STEP_GROWTH_ADD,
  MATCH_DEFAULT_STEP_DECAY_FACTOR,
  MATCH_DEFAULT_STAGE_DURATION_MULTIPLIER,
} from './match-defaults';
import type { TPEConfig } from './optimize/hpo';

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
  useHPO?: boolean;
  hpoTrials?: number;
  hpoTpeConfig?: Partial<TPEConfig>;
}

parentPort.on('message', (msg: WorkerMessage) => {
  try {
    const targetWav = readWav(msg.targetWavPath);
    const targetSignal = [...targetWav.samples];

    let vector: number[];
    let history: typeof msg extends { useHPO: true }
      ? {
          trial: number;
          value: number | null;
          params: Record<string, number | string | boolean>;
        }[]
      : Array<{ iteration: number; suppressionPercent: number }>;

    if (msg.useHPO) {
      const nTrials = msg.hpoTrials ?? 10;
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

      vector = hpoResult.bestVector;
      history = hpoResult.history.map((h, i) => ({
        iteration: i + 1,
        suppressionPercent: h.value ?? 0,
      })) as typeof history;

      console.log(
        `HPO complete. Best: ${hpoResult.bestValue.toFixed(2)}%`,
      );
    } else {
      const result = stagedOptimize({
        initialVector: msg.initialVector,
        targetSignal,
        sampleRate: msg.sampleRate,
        maxIterations: msg.maxIterations,
        stepGrowthAdd:
          msg.stepGrowthAdd ?? MATCH_DEFAULT_STEP_GROWTH_ADD,
        stepDecayFactor:
          msg.stepDecayFactor ?? MATCH_DEFAULT_STEP_DECAY_FACTOR,
        stageDurationMultiplier:
          msg.stageDurationMultiplier ??
          MATCH_DEFAULT_STAGE_DURATION_MULTIPLIER,
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
      history: history.map((h) => ({
        iteration:
          'suppressionPercent' in h
            ? (h as { iteration: number; suppressionPercent: number })
                .iteration
            : (h as { trial: number; value: number | null }).trial,
        suppressionPercent:
          'suppressionPercent' in h
            ? (h as { iteration: number; suppressionPercent: number })
                .suppressionPercent
            : ((h as { trial: number; value: number | null }).value ??
              0),
      })),
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
