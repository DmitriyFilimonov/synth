export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface MatchTargetInfo {
  sampleRate: number;
  numSamples: number;
  bitsPerSample: number;
  numChannels: number;
}

export interface MatchHistoryEntry {
  iteration: number;
  suppressionPercent: number;
  status?: string;
}

export interface MatchConfig {
  numOscillators?: number;
  maxIterations?: number;
}

export interface SynthOscConfig {
  freqBase: number;
  freqStart: number;
  duration: number;
  slope: number;
  phase: number;
  on: boolean;
}

export interface SynthAmpEnvConfig {
  startLevel: number;
  endLevel: number;
  duration: number;
  slope: number;
}

export interface SynthConfig {
  oscillators: {
    osc: SynthOscConfig;
    ampEnv: SynthAmpEnvConfig;
  }[];
}

export interface JobEntry {
  id: string;
  /** Человекочитаемое имя job (может отсутствовать у старых job) */
  name?: string;
  status: JobStatus;
  progress: MatchHistoryEntry[];
  params: {
    numOscillators: number;
    maxIterations: number;
  };
  suppressionPercent: number;
  /** Честный глобальный suppression финального WAV (может отсутствовать у старых job) */
  globalSuppressionPercent?: number | null;
  targetInfo?: MatchTargetInfo;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  synthConfig?: SynthConfig;
}

export interface JobListEntry {
  id: string;
  /** Человекочитаемое имя job (может отсутствовать у старых job) */
  name?: string;
  status: JobStatus;
  suppressionPercent: number;
  globalSuppressionPercent?: number | null;
  params: {
    numOscillators: number;
    maxIterations: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobResponse {
  id: string;
}
