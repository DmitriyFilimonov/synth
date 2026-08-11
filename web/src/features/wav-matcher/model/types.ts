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

export interface JobEntry {
  id: string;
  status: JobStatus;
  progress: MatchHistoryEntry[];
  params: {
    numOscillators: number;
    maxIterations: number;
  };
  suppressionPercent: number;
  targetInfo?: MatchTargetInfo;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobListEntry {
  id: string;
  status: JobStatus;
  suppressionPercent: number;
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
