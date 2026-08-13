import { parentPort, workerData } from 'worker_threads';
import { optimize } from './optimize';
import { createSynth } from './synth';
import { mapVectorToSynthConfig } from './vector-to-synth-config';
import { writeWav } from './write-wav';
import { matchVisualize } from './match-visualize';
import { readWav } from './read-wav';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './consts';
import {
  MATCH_DEFAULT_STEP_GROWTH_ADD,
  MATCH_DEFAULT_STEP_DECAY_FACTOR,
} from './match-defaults';

if (!parentPort) throw new Error('Must run as worker thread');

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
}

parentPort.on('message', (msg: WorkerMessage) => {
  try {
    const targetWav = readWav(msg.targetWavPath);
    const targetSignal = [...targetWav.samples];

    const { vector, history } = optimize({
      initialVector: msg.initialVector,
      targetSignal,
      sampleRate: msg.sampleRate,
      maxIterations: msg.maxIterations,
      stepGrowthAdd:
        msg.stepGrowthAdd ?? MATCH_DEFAULT_STEP_GROWTH_ADD,
      stepDecayFactor:
        msg.stepDecayFactor ?? MATCH_DEFAULT_STEP_DECAY_FACTOR,
      onProgress: (entry) => {
        parentPort?.postMessage({ type: 'progress', data: entry });
      },
    });

    const optimizedConfig = mapVectorToSynthConfig(vector);
    const synth = createSynth(optimizedConfig);
    const samples = new Int16Array(targetWav.samples.length);

    for (let i = 0; i < targetWav.samples.length; i++) {
      const timeSeconds = i / msg.sampleRate;
      const sample = synth({ x: timeSeconds });
      samples[i] = Math.round(
        sample * MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
      );
    }

    writeWav({
      samples,
      sampleRate: msg.sampleRate,
      filePath: msg.outputWavPath,
    });

    const visualizationPath = `${msg.outputWavPath}-match`;
    matchVisualize({
      targetSignal,
      synthSignal: [...samples],
      sampleRate: msg.sampleRate,
      outputPath: visualizationPath,
      history,
    });

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
