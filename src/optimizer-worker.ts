/* eslint-disable no-console */
import { parentPort } from 'worker_threads';
import {
  stagedOptimize,
  evaluateSuppressionFromWaveform,
} from './optimize';
import { generateOutput } from './match';
import { mapVectorToSynthConfig } from './vector-to-synth-config';
import { readWav } from './read-wav';

if (!parentPort) {
  throw new Error('Must run as worker thread');
}

const CONSOLE_LOG_THROTTLE_MS = 50;
const IMPORTANT_LOG_THROTTLE_MS = 5;
let lastLogTime = 0;
let lastImportantLogTime = 0;

const sendLog = (message: string): void => {
  try {
    parentPort?.postMessage({ type: 'log', data: message });
  } catch {
    // message channel might be closed, silently ignore
  }
};

console.log = (...args: unknown[]): void => {
  const msg = args.map((a) => String(a)).join(' ');
  const isImportant = /^\[/.test(msg);
  const now = Date.now();

  if (isImportant) {
    if (now - lastImportantLogTime < IMPORTANT_LOG_THROTTLE_MS) {
      return;
    }
    lastImportantLogTime = now;
  } else {
    if (now - lastLogTime < CONSOLE_LOG_THROTTLE_MS) {
      return;
    }
    lastLogTime = now;
  }

  sendLog(msg);
};
console.error = (...args: unknown[]): void => {
  const now = Date.now();
  if (now - lastLogTime < CONSOLE_LOG_THROTTLE_MS / 2) {
    return;
  }
  lastLogTime = now;
  sendLog('[ERR] ' + args.map((a) => String(a)).join(' '));
};
console.warn = (...args: unknown[]): void => {
  const now = Date.now();
  if (now - lastLogTime < CONSOLE_LOG_THROTTLE_MS / 2) {
    return;
  }
  lastLogTime = now;
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
}

parentPort.on('message', (msg: WorkerMessage) => {
  try {
    const targetWav = readWav(msg.targetWavPath);
    const targetSignal = [...targetWav.samples];

    const PROGRESS_THROTTLE_MS = 100;
    let lastProgressMs = 0;

    const result = stagedOptimize({
      initialVector: msg.initialVector,
      targetSignal,
      sampleRate: msg.sampleRate,
      maxIterations: msg.maxIterations,
      stepGrowthAdd: msg.stepGrowthAdd,
      stepDecayFactor: msg.stepDecayFactor,
      onProgress: (entry) => {
        const now = Date.now();
        if (now - lastProgressMs >= PROGRESS_THROTTLE_MS) {
          lastProgressMs = now;
          parentPort?.postMessage({
            type: 'progress',
            data: entry,
          });
        }
      },
    });

    const vector = result.vector;
    const history = result.history;

    console.log(`Optimization complete.`);

    const { samples } = generateOutput({
      vector,
      targetSignal,
      numSamples: targetWav.samples.length,
      sampleRate: msg.sampleRate,
      outputWavPath: msg.outputWavPath,
      history,
    });

    const optimizedConfig = mapVectorToSynthConfig(vector);

    // Честный глобальный suppression (1 - RMS(остаток)/RMS(таргет))
    // по финальному WAV — в отличие от surrogate J в истории.
    // Не критично для результата: при ошибке поле будет null.
    let globalSuppressionPercent: number | null = null;
    try {
      globalSuppressionPercent = evaluateSuppressionFromWaveform(
        [...samples],
        targetSignal,
      );
      console.log(
        `Global suppression (RMS, full signal): ${globalSuppressionPercent.toFixed(2)}%`,
      );
    } catch (assessError) {
      console.warn(
        `Global suppression assessment failed: ${assessError instanceof Error ? assessError.message : String(assessError)}`,
      );
    }

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
        globalSuppressionPercent,
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
