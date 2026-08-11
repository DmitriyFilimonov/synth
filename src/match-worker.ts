import { Worker } from 'worker_threads';
import { resolve } from 'node:path';

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
}

interface MatchWorkerArgs {
  targetWavPath: string;
  outputWavPath: string;
  initialVector: number[];
  sampleRate: number;
  maxIterations: number;
  onProgress?: (entry: MatchWorkerProgress) => void;
}

export function matchWithWorker(
  arg: MatchWorkerArgs,
): Promise<MatchWorkerResult> {
  return new Promise((resolveFn, rejectFn) => {
    const workerPath = resolve(__dirname, 'optimizer-worker.js');
    const worker = new Worker(workerPath, {
      workerData: {},
    });

    const timeout = setTimeout(
      () => {
        worker.terminate();
        rejectFn(new Error('Worker timed out'));
      },
      30 * 60 * 1000,
    );

    worker.on('message', (msg: { type: string; data: unknown }) => {
      if (msg.type === 'progress') {
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

    // Send the actual configuration after worker starts
    worker.postMessage({
      targetWavPath: arg.targetWavPath,
      outputWavPath: arg.outputWavPath,
      initialVector: arg.initialVector,
      sampleRate: arg.sampleRate,
      maxIterations: arg.maxIterations,
    });
  });
}
