/* eslint-disable no-console */
import { join } from 'node:path';
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  unlink,
  rename,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ArgCreateSynth } from '../../synth';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface JobEntry {
  iteration: number;
  suppressionPercent: number;
  stageIndex?: number;
  totalStages?: number;
  stageDurationMs?: number;
}

export interface JobRecord {
  id: string;
  /** Human-readable name: "<targetFileName> DD.MM.YYYY HH:MM:SS" или "target DD.MM.YYYY HH:MM:SS" */
  name: string;
  status: JobStatus;
  progress: JobEntry[];
  params: {
    numOscillators: number;
    maxIterations: number;
    stepGrowthAdd?: number;
    stepDecayFactor?: number;
    stageDurationMultiplier?: number;
    hpoTrials?: number;
    hpo?: boolean;
    staged?: boolean;
  };
  inputFileName: string;
  resultFileName: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  suppressionPercent: number;
  /** Честный глобальный suppression финального WAV; null, если оценка не удалась или job старый */
  globalSuppressionPercent?: number | null;
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  } | null;
  bestVector: number[] | null;
  synthConfig: ArgCreateSynth | null;
}

const JOBS_DIR = join(process.cwd(), 'jobs');

async function ensureJobsDir(): Promise<void> {
  if (!existsSync(JOBS_DIR)) {
    await mkdir(JOBS_DIR, { recursive: true });
  }
}

function jobFilePath(id: string): string {
  return join(JOBS_DIR, `${id}.json`);
}

function resultFilePath(id: string): string {
  return join(JOBS_DIR, `${id}_result.wav`);
}

function inputFilePath(id: string): string {
  return join(JOBS_DIR, `${id}_input.wav`);
}

export function getJobFilePath(id: string): string {
  return jobFilePath(id);
}

export function getResultFilePath(id: string): string {
  return resultFilePath(id);
}

export function getInputFilePath(id: string): string {
  return inputFilePath(id);
}

function createFallbackRecord(id: string): JobRecord {
  const now = new Date().toISOString();
  return {
    id,
    name: '',
    status: 'running',
    progress: [],
    params: { numOscillators: 0, maxIterations: 0 },
    inputFileName: '',
    resultFileName: `${id}_result.wav`,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    suppressionPercent: 0,
    globalSuppressionPercent: null,
    targetInfo: null,
    bestVector: null,
    synthConfig: null,
  };
}

async function safeWriteJson(
  filePath: string,
  data: string,
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, filePath);
}

export async function createJob(
  id: string,
  params: {
    numOscillators: number;
    maxIterations: number;
    stepGrowthAdd?: number;
    stepDecayFactor?: number;
    stageDurationMultiplier?: number;
    hpoTrials?: number;
    hpo?: boolean;
    staged?: boolean;
  },
  inputFileName: string,
  name: string,
): Promise<JobRecord> {
  await ensureJobsDir();
  const now = new Date().toISOString();
  const record: JobRecord = {
    id,
    name,
    status: 'queued',
    progress: [],
    params,
    inputFileName,
    resultFileName: `${id}_result.wav`,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    suppressionPercent: 0,
    globalSuppressionPercent: null,
    targetInfo: null,
    bestVector: null,
    synthConfig: null,
  };
  await safeWriteJson(
    jobFilePath(id),
    JSON.stringify(record, null, 2),
  );
  return record;
}

export async function updateJobStatus(
  id: string,
  status: JobStatus,
  partial?: Partial<
    Pick<
      JobRecord,
      | 'progress'
      | 'suppressionPercent'
      | 'globalSuppressionPercent'
      | 'targetInfo'
      | 'errorMessage'
      | 'bestVector'
      | 'synthConfig'
    >
  >,
): Promise<JobRecord> {
  let record: JobRecord;
  try {
    record = await getJob(id);
  } catch {
    record = createFallbackRecord(id);
  }
  record.status = status;
  record.updatedAt = new Date().toISOString();
  if (partial) {
    if (partial.progress !== undefined) {
      record.progress = partial.progress;
    }
    if (partial.suppressionPercent !== undefined) {
      record.suppressionPercent = partial.suppressionPercent;
    }
    if (partial.globalSuppressionPercent !== undefined) {
      record.globalSuppressionPercent =
        partial.globalSuppressionPercent;
    }
    if (partial.targetInfo !== undefined) {
      record.targetInfo = partial.targetInfo;
    }
    if (partial.errorMessage !== undefined) {
      record.errorMessage = partial.errorMessage;
    }
    if (partial.bestVector !== undefined) {
      record.bestVector = partial.bestVector;
    }
    if (partial.synthConfig !== undefined) {
      record.synthConfig = partial.synthConfig;
    }
  }
  try {
    await safeWriteJson(
      jobFilePath(id),
      JSON.stringify(record, null, 2),
    );
  } catch (writeError) {
    console.error(`Failed to write job file for ${id}:`, writeError);
  }
  return record;
}

export async function getJob(id: string): Promise<JobRecord> {
  const data = await readFile(jobFilePath(id), 'utf-8');
  const trimmed = data.trim();
  if (!trimmed) {
    throw new Error(`Job file for ${id} is empty`);
  }
  return JSON.parse(trimmed) as JobRecord;
}

export async function listJobs(): Promise<JobRecord[]> {
  await ensureJobsDir();
  const files = await readdir(JOBS_DIR);
  const jobFiles = files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));

  const jobs = await Promise.all(
    jobFiles.map(async (id) => {
      try {
        return await getJob(id);
      } catch {
        return null;
      }
    }),
  );

  return jobs
    .filter((j): j is JobRecord => j !== null)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() -
        new Date(a.createdAt).getTime(),
    );
}

export async function deleteJob(id: string): Promise<void> {
  const jsonFile = jobFilePath(id);
  const resultFile = resultFilePath(id);
  const inputFile = inputFilePath(id);

  await unlink(jsonFile).catch(() => {});
  await unlink(resultFile).catch(() => {});
  await unlink(inputFile).catch(() => {});
}
