import { Worker } from 'worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import type { ArgCreateSynth } from './synth';
import type { TPEConfig } from './optimize/hpo';

export interface MatchWorkerProgress {
  iteration: number;
  suppressionPercent: number;
  phase?: 'hpo' | 'cd';
  status?: string;
  stageIndex?: number;
  totalStages?: number;
  stageDurationMs?: number;
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
  stageDurationMultiplier?: number;
  onProgress?: (entry: MatchWorkerProgress) => void;
  hpoTrials?: number;
  hpoTpeConfig?: Partial<TPEConfig>;
  fundamentalHz?: number;
  staged?: boolean;
  hpo?: boolean;
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

    worker.on('message', (msg: { type: string; data: unknown }) => {
      if (msg.type === 'log') {
        process.stdout.write((msg.data as string) + '\n');
      } else if (msg.type === 'progress') {
        arg.onProgress?.(msg.data as MatchWorkerProgress);
      } else if (msg.type === 'done') {
        resolveFn(msg.data as MatchWorkerResult);
      } else if (msg.type === 'error') {
        rejectFn(new Error(msg.data as string));
      }
    });

    worker.on('error', (err) => {
      rejectFn(err instanceof Error ? err : new Error(String(err)));
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        rejectFn(new Error(`Worker stopped with exit code ${code}`));
      }
    });

    worker.postMessage({
      targetWavPath: arg.targetWavPath,
      outputWavPath: arg.outputWavPath,
      initialVector: arg.initialVector,
      sampleRate: arg.sampleRate,
      maxIterations: arg.maxIterations,
      fundamentalHz: arg.fundamentalHz,
      stepGrowthAdd: arg.stepGrowthAdd,
      stepDecayFactor: arg.stepDecayFactor,
      stageDurationMultiplier: arg.stageDurationMultiplier,
      hpoTrials: arg.hpoTrials,
      hpoTpeConfig: arg.hpoTpeConfig,
      staged: arg.staged,
      hpo: arg.hpo,
    });
  });
}
