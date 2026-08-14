import { parentPort, workerData } from 'worker_threads';
import { stagedOptimize } from './optimize';
import { generateOutput } from './match';
import { mapVectorToSynthConfig } from './vector-to-synth-config';
import { readWav } from './read-wav';
import {
  MATCH_DEFAULT_STEP_GROWTH_ADD,
  MATCH_DEFAULT_STEP_DECAY_FACTOR,
  MATCH_DEFAULT_STAGE_DURATION_MULTIPLIER,
} from './match-defaults';

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
}

parentPort.on('message', (msg: WorkerMessage) => {
  try {
    const targetWav = readWav(msg.targetWavPath);
    const targetSignal = [...targetWav.samples];

    const { vector, history } = stagedOptimize({
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
