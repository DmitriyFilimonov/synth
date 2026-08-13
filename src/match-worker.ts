import { Worker } from 'worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import type { ArgCreateSynth } from './synth';

export interface MatchWorkerProgress {
  iteration: number;
  suppressionPercent: number;
  status?: string;
}

export interface MatchWorkerResult {
  history: MatchWorkerProgress[];
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  };
  suppressionPercent: number;
  bestVector: number[];
  synthConfig: ArgCreateSynth;
}

interface MatchWorkerArgs {
  targetWavPath: string;
  outputWavPath: string;
  initialVector: number[];
  sampleRate: number;
  maxIterations: number;
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
  onProgress?: (entry: MatchWorkerProgress) => void;
}

function resolveWorkerPath(): {
  specifier: string | URL;
  execArgv?: string[];
} {
  const tsPath = resolve(__dirname, 'optimizer-worker.ts');
  if (existsSync(tsPath)) {
    return {
      specifier: new URL(pathToFileURL(tsPath).href),
      execArgv: ['--require', require.resolve('tsx/cjs')],
    };
  }
  const jsPath = resolve(__dirname, 'optimizer-worker.js');
  return { specifier: jsPath };
}

export function matchWithWorker(
  arg: MatchWorkerArgs,
): Promise<MatchWorkerResult> {
  return new Promise((resolveFn, rejectFn) => {
    const { specifier, execArgv } = resolveWorkerPath();
    const worker = new Worker(specifier, {
      workerData: {},
      ...(execArgv ? { execArgv } : {}),
    });

    const timeout = setTimeout(
      () => {
        worker.terminate();
        rejectFn(new Error('Worker timed out'));
      },
      30 * 60 * 1000,
    );

    worker.on('message', (msg: { type: string; data: unknown }) => {
      if (msg.type === 'log') {
        process.stdout.write((msg.data as string) + '\n');
      } else if (msg.type === 'progress') {
        arg.onProgress?.(msg.data as MatchWorkerProgress);
      } else if (msg.type === 'done') {
        clearTimeout(timeout);
        resolveFn(msg.data as MatchWorkerResult);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        rejectFn(new Error(msg.data as string));
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timeout);
      rejectFn(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        rejectFn(new Error(`Worker stopped with exit code ${code}`));
      }
    });

    worker.postMessage({
      targetWavPath: arg.targetWavPath,
      outputWavPath: arg.outputWavPath,
      initialVector: arg.initialVector,
      sampleRate: arg.sampleRate,
      maxIterations: arg.maxIterations,
      stepGrowthAdd: arg.stepGrowthAdd,
      stepDecayFactor: arg.stepDecayFactor,
    });
  });
}
