/* eslint-disable no-console */
import { createSynth, ArgCreateSynth } from '../../synth';
import { writeWav } from '../../write-wav';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../../consts';
import { matchWithWorker } from '../../match-worker';
import { dualWindowInitVector } from '../../dual-window-init-vector';
import { mapVectorToSynthConfig } from '../../vector-to-synth-config';
import { readWav } from '../../read-wav';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  unlink,
  readFile,
  writeFile,
  copyFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  createJob,
  updateJobStatus,
  getInputFilePath,
  getResultFilePath,
} from './job-store';

function formatRussianDateTime(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

function generateJobName(targetFileName?: string): string {
  const baseName = targetFileName?.trim() || 'target';
  const timestamp = formatRussianDateTime(new Date());
  return `${baseName} ${timestamp}`;
}

interface GeneratedFile {
  buffer: Buffer;
  sampleRate: number;
  duration: number;
}

interface MatchedFile {
  buffer: Buffer;
  history: {
    iteration: number;
    suppressionPercent: number;
  }[];
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  };
  suppressionPercent: number;
  /** Честный глобальный suppression финального WAV; null, если оценка не удалась */
  globalSuppressionPercent: number | null;
  synthConfig: ArgCreateSynth;
}

export async function generateWav(
  synthConfig: ArgCreateSynth,
  duration: number,
  sampleRate: number,
): Promise<GeneratedFile> {
  const totalSamples = Math.floor(sampleRate * duration);
  const synth = createSynth(synthConfig);
  const samples = new Int16Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const timeSeconds = i / sampleRate;
    const sample = synth({ x: timeSeconds });
    samples[i] = Math.round(
      sample * MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    );
  }

  const tempFile = join(tmpdir(), `${randomUUID()}.wav`);
  writeWav({ samples, sampleRate, filePath: tempFile });

  if (!existsSync(tempFile)) {
    throw new Error('Failed to generate WAV file');
  }

  const buffer = await readFile(tempFile);
  await unlink(tempFile).catch(() => {});

  return { buffer, sampleRate, duration };
}

export async function matchWav(
  wavBuffer: Buffer,
  numOscillators: number,
  maxIterations: number,
  stepGrowthAdd?: number,
  stepDecayFactor?: number,
): Promise<MatchedFile> {
  const tempInput = join(tmpdir(), `${randomUUID()}_input.wav`);
  const tempOutput = join(tmpdir(), `${randomUUID()}_output.wav`);

  await writeFile(tempInput, wavBuffer);

  try {
    const history: {
      iteration: number;
      suppressionPercent: number;
    }[] = [];

    const targetWavData = readWav(tempInput);
    const initialVector = dualWindowInitVector(
      targetWavData.samples,
      SAMPLE_RATE,
      numOscillators,
    );

    const result = await matchWithWorker({
      targetWavPath: tempInput,
      outputWavPath: tempOutput,
      initialVector,
      sampleRate: 44100,
      maxIterations,
      stepGrowthAdd,
      stepDecayFactor,
      onProgress: (entry) => {
        // Drop bestVector to keep response history compact.
        const { bestVector: _bv, ...historyEntry } = entry;
        history.push(historyEntry);
      },
    });

    if (!existsSync(tempOutput)) {
      throw new Error('Failed to generate matched WAV file');
    }

    const outBuffer = await readFile(tempOutput);

    return {
      buffer: outBuffer,
      history,
      targetInfo: result.targetInfo,
      suppressionPercent:
        history.length > 0
          ? (history[history.length - 1]?.suppressionPercent ?? 0)
          : 0,
      globalSuppressionPercent:
        result.globalSuppressionPercent ?? null,
      synthConfig: result.synthConfig,
    };
  } finally {
    await unlink(tempInput).catch(() => {});
    await unlink(tempOutput).catch(() => {});
  }
}

export async function matchWavWithJob(
  wavBuffer: Buffer,
  numOscillators: number,
  maxIterations: number,
  stepGrowthAdd?: number,
  stepDecayFactor?: number,
  targetFileName?: string,
): Promise<string> {
  const jobId = randomUUID();
  const inputFileName = `${jobId}_input.wav`;
  const jobName = generateJobName(targetFileName);

  await createJob(
    jobId,
    {
      numOscillators,
      maxIterations,
      stepGrowthAdd,
      stepDecayFactor,
    },
    inputFileName,
    jobName,
  );

  const inputPath = getInputFilePath(jobId);
  await writeFile(inputPath, wavBuffer);

  setImmediate(() => {
    runMatchJob(
      jobId,
      numOscillators,
      maxIterations,
      inputPath,
      stepGrowthAdd,
      stepDecayFactor,
    ).catch((err) => {
      const message =
        err instanceof Error ? err.message : 'Unknown error';
      updateJobStatus(jobId, 'failed', {
        errorMessage: message,
      }).catch(() => {});
    });
  });

  return jobId;
}

async function runMatchJob(
  jobId: string,
  numOscillators: number,
  maxIterations: number,
  inputPath: string,
  stepGrowthAdd?: number,
  stepDecayFactor?: number,
): Promise<void> {
  const tempOutput = join(tmpdir(), `${randomUUID()}_output.wav`);
  const history: {
    iteration: number;
    suppressionPercent: number;
  }[] = [];
  let lastUpdateMs = 0;
  const UPDATE_THROTTLE_MS = 1000;
  // Latest best-so-far snapshot from the optimizer. Kept out of
  // `history` (which is trimmed for OOM safety) so we always have
  // the freshest vector to persist even after history rotation.
  let latestBestVector: number[] | null = null;

  try {
    await updateJobStatus(jobId, 'running');

    const targetWavData = readWav(inputPath);
    const initialVector = dualWindowInitVector(
      targetWavData.samples,
      SAMPLE_RATE,
      numOscillators,
    );

    const result = await matchWithWorker({
      targetWavPath: inputPath,
      outputWavPath: tempOutput,
      initialVector,
      sampleRate: 44100,
      maxIterations,
      stepGrowthAdd,
      stepDecayFactor,
      onProgress: (entry) => {
        // Strip bestVector from history entries — it bloats the
        // job.json file and duplicates data we persist separately.
        const { bestVector: entryVector, ...historyEntry } = entry;
        history.push(historyEntry);
        // Cap history to prevent job.json from ballooning past the
        // JSON stringify threshold on long runs; matches optimizer-
        // worker safeguard. Trims oldest entries.
        if (history.length > 10000) {
          history.splice(0, 5000);
        }
        if (entryVector !== undefined) {
          latestBestVector = [...entryVector];
        }
        const now = Date.now();
        if (now - lastUpdateMs >= UPDATE_THROTTLE_MS) {
          lastUpdateMs = now;
          // Persist progress + latest best snapshot so a running
          // job exposes its intermediate synth config. Any failure
          // here (I/O hiccup) must not break optimization; the
          // updateJobStatus promise is fire-and-forget with its own
          // internal error logging.
          const update: Parameters<typeof updateJobStatus>[2] = {
            progress: [...history],
            suppressionPercent: entry.suppressionPercent,
          };
          if (latestBestVector !== null) {
            update.bestVector = latestBestVector;
            update.synthConfig = mapVectorToSynthConfig([
              ...latestBestVector,
            ]);
          }
          void updateJobStatus(jobId, 'running', update);
        }
      },
    });

    const resultPath = getResultFilePath(jobId);
    await copyFile(tempOutput, resultPath);

    await updateJobStatus(jobId, 'completed', {
      progress: history,
      suppressionPercent:
        history.length > 0
          ? (history[history.length - 1]?.suppressionPercent ?? 0)
          : 0,
      globalSuppressionPercent:
        result.globalSuppressionPercent ?? null,
      targetInfo: result.targetInfo,
      bestVector: result.bestVector,
      synthConfig: result.synthConfig,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    try {
      await updateJobStatus(jobId, 'failed', {
        errorMessage: message,
      });
    } catch (reportError) {
      console.error(
        `Failed to report error for job ${jobId}:`,
        reportError,
      );
    }
  } finally {
    await unlink(tempOutput).catch(() => {});
  }
}
