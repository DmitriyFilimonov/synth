import { createSynth, ArgCreateSynth } from '../../synth';
import { writeWav } from '../../write-wav';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from '../../consts';
import { match } from '../../match';
import { matchWithWorker } from '../../match-worker';
import { mapSynthConfigToVector } from '../../synth-config-to-vector';
import { SYNTH_MULTI_PRESET } from '../../match-preset';
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
  history: { iteration: number; suppressionPercent: number }[];
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
): Promise<MatchedFile> {
  const tempInput = join(tmpdir(), `${randomUUID()}_input.wav`);
  const tempOutput = join(tmpdir(), `${randomUUID()}_output.wav`);

  await writeFile(tempInput, wavBuffer);

  try {
    const history: {
      iteration: number;
      suppressionPercent: number;
    }[] = [];

    const initialVector = mapSynthConfigToVector(
      SYNTH_MULTI_PRESET(numOscillators),
    );

    const result = await matchWithWorker({
      targetWavPath: tempInput,
      outputWavPath: tempOutput,
      initialVector,
      sampleRate: 44100,
      maxIterations,
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
): Promise<string> {
  const jobId = randomUUID();
  const inputFileName = `${jobId}_input.wav`;

  await createJob(
    jobId,
    { numOscillators, maxIterations },
    inputFileName,
  );

  const inputPath = getInputFilePath(jobId);
  await writeFile(inputPath, wavBuffer);

  setImmediate(() => {
    void runMatchJob(jobId, numOscillators, maxIterations, inputPath);
  });

  return jobId;
}

async function runMatchJob(
  jobId: string,
  numOscillators: number,
  maxIterations: number,
  inputPath: string,
): Promise<void> {
  const tempOutput = join(tmpdir(), `${randomUUID()}_output.wav`);
  const history: {
    iteration: number;
    suppressionPercent: number;
  }[] = [];

  try {
    await updateJobStatus(jobId, 'running');

    const initialVector = mapSynthConfigToVector(
      SYNTH_MULTI_PRESET(numOscillators),
    );

    const result = await matchWithWorker({
      targetWavPath: inputPath,
      outputWavPath: tempOutput,
      initialVector,
      sampleRate: 44100,
      maxIterations,
      onProgress: (entry) => {
        history.push(entry);
        void updateJobStatus(jobId, 'running', {
          progress: [...history],
          suppressionPercent: entry.suppressionPercent,
        });
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
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    await updateJobStatus(jobId, 'failed', {
      errorMessage: message,
    });
  } finally {
    await unlink(tempOutput).catch(() => {});
  }
}

