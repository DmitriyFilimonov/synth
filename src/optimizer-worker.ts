import { parentPort, workerData } from 'worker_threads';
import { stagedOptimize } from './optimize';
import { generateOutput } from './match';
import { mapVectorToSynthConfig } from './vector-to-synth-config';
import { readWav } from './read-wav';
import { MATCH_DEFAULT_HPO_TRIALS } from './match-defaults';
import type { TPEConfig } from './optimize/hpo';

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

console.log = (...args: unknown[]) => {
  const msg = args.map((a) => String(a)).join(' ');
  const isImportant = /^\[/.test(msg);
  const now = Date.now();

  if (isImportant) {
    if (now - lastImportantLogTime < IMPORTANT_LOG_THROTTLE_MS)
      return;
    lastImportantLogTime = now;
  } else {
    if (now - lastLogTime < CONSOLE_LOG_THROTTLE_MS) return;
    lastLogTime = now;
  }

  sendLog(msg);
};
console.error = (...args: unknown[]) => {
  const now = Date.now();
  if (now - lastLogTime < CONSOLE_LOG_THROTTLE_MS / 2) return;
  lastLogTime = now;
  sendLog('[ERR] ' + args.map((a) => String(a)).join(' '));
};
console.warn = (...args: unknown[]) => {
  const now = Date.now();
  if (now - lastLogTime < CONSOLE_LOG_THROTTLE_MS / 2) return;
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
  stageDurationMultiplier?: number;
  hpoTrials?: number;
  hpoTpeConfig?: Partial<TPEConfig>;
  fundamentalHz?: number;
}

parentPort.on('message', (msg: WorkerMessage) => {
  try {
    const targetWav = readWav(msg.targetWavPath);
    const targetSignal = [...targetWav.samples];

    const hasUserOverride =
      msg.stepGrowthAdd !== undefined &&
      msg.stepDecayFactor !== undefined;

    let vector: number[];
    let history: Array<{
      iteration: number;
      suppressionPercent: number;
      phase?: 'hpo' | 'cd';
      stageIndex?: number;
      totalStages?: number;
      stageDurationMs?: number;
    }>;

    if (!hasUserOverride) {
      const nTrials = msg.hpoTrials ?? MATCH_DEFAULT_HPO_TRIALS;
      const numOscillators = msg.initialVector.length / 10;

      console.log(
        `Starting staged optimization with per-stage HPO: ${nTrials} trials/stage, ${numOscillators} oscillators`,
      );

      const PROGRESS_THROTTLE_MS = 100;
      let lastProgressMs = 0;

      const stagedResult = stagedOptimize({
        initialVector: msg.initialVector,
        targetSignal,
        sampleRate: msg.sampleRate,
        maxIterations: msg.maxIterations,
        hpoTrials: nTrials,
        tpeConfig: msg.hpoTpeConfig,
        stageDurationMultiplier: msg.stageDurationMultiplier,
        fundamentalHz: msg.fundamentalHz,
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

      vector = stagedResult.vector;
      history = stagedResult.history;

      console.log(`StagedOpt complete.`);
    } else {
      const result = stagedOptimize({
        initialVector: msg.initialVector,
        targetSignal,
        sampleRate: msg.sampleRate,
        maxIterations: msg.maxIterations,
        stepGrowthAdd: msg.stepGrowthAdd,
        stepDecayFactor: msg.stepDecayFactor,
        stageDurationMultiplier: msg.stageDurationMultiplier,
        fundamentalHz: msg.fundamentalHz,
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
