import { createSynth, ArgCreateSynth } from '../../synth';
import { writeWav } from '../../write-wav';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../../consts';
import { matchWithWorker } from '../../match-worker';
import { simpleInitVector } from '../../simple-init-vector';
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
    stageIndex?: number;
    totalStages?: number;
    stageDurationMs?: number;
  }[];
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  };
  suppressionPercent: number;
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
  stageDurationMultiplier?: number,
  hpoTrials?: number,
): Promise<MatchedFile> {
  const tempInput = join(tmpdir(), `${randomUUID()}_input.wav`);
  const tempOutput = join(tmpdir(), `${randomUUID()}_output.wav`);

  await writeFile(tempInput, wavBuffer);

  try {
    const history: {
      iteration: number;
      suppressionPercent: number;
      stageIndex?: number;
      totalStages?: number;
      stageDurationMs?: number;
    }[] = [];

    const targetWavData = readWav(tempInput);
    const initialVector = simpleInitVector(
      targetWavData.samples,
      SAMPLE_RATE,
      numOscillators,
    );

    const hasUserOverride =
      stepGrowthAdd !== undefined &&
      stepDecayFactor !== undefined &&
      stageDurationMultiplier !== undefined;

    const result = await matchWithWorker({
      targetWavPath: tempInput,
      outputWavPath: tempOutput,
      initialVector,
      sampleRate: 44100,
      maxIterations,
      ...(hasUserOverride
        ? {
            stepGrowthAdd,
            stepDecayFactor,
            stageDurationMultiplier,
          }
        : { hpoTrials }),
      onProgress: (entry) => {
        history.push(entry);
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
  stageDurationMultiplier?: number,
  hpoTrials?: number,
): Promise<string> {
  const jobId = randomUUID();
  const inputFileName = `${jobId}_input.wav`;

  await createJob(
    jobId,
    {
      numOscillators,
      maxIterations,
      stepGrowthAdd,
      stepDecayFactor,
      stageDurationMultiplier,
      hpoTrials,
    },
    inputFileName,
  );

  const inputPath = getInputFilePath(jobId);
  await writeFile(inputPath, wavBuffer);

  setImmediate(() => {
    void runMatchJob(
      jobId,
      numOscillators,
      maxIterations,
      inputPath,
      stepGrowthAdd,
      stepDecayFactor,
      stageDurationMultiplier,
      hpoTrials,
    );
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
  stageDurationMultiplier?: number,
  hpoTrials?: number,
): Promise<void> {
  const tempOutput = join(tmpdir(), `${randomUUID()}_output.wav`);
  const history: {
    iteration: number;
    suppressionPercent: number;
    stageIndex?: number;
    totalStages?: number;
    stageDurationMs?: number;
  }[] = [];
  let lastUpdateMs = 0;
  const UPDATE_THROTTLE_MS = 1000;

  try {
    await updateJobStatus(jobId, 'running');

    const targetWavData = readWav(inputPath);
    const initialVector = simpleInitVector(
      targetWavData.samples,
      SAMPLE_RATE,
      numOscillators,
    );

    const hasUserOverride =
      stepGrowthAdd !== undefined &&
      stepDecayFactor !== undefined &&
      stageDurationMultiplier !== undefined;

    const result = await matchWithWorker({
      targetWavPath: inputPath,
      outputWavPath: tempOutput,
      initialVector,
      sampleRate: 44100,
      maxIterations,
      ...(hasUserOverride
        ? {
            stepGrowthAdd,
            stepDecayFactor,
            stageDurationMultiplier,
          }
        : { hpoTrials }),
      onProgress: (entry) => {
        history.push(entry);
        const now = Date.now();
        if (now - lastUpdateMs >= UPDATE_THROTTLE_MS) {
          lastUpdateMs = now;
          void updateJobStatus(jobId, 'running', {
            progress: [...history],
            suppressionPercent: entry.suppressionPercent,
          });
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
