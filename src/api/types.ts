import type { ArgCreateSynth } from '../synth';
import { MIN } from '../envelope';

export interface OscillatorConfig {
  freqBase: number;
  freqStart: number;
  duration: number;
  slope: number;
  phase: number;
  on: boolean;
  ampEnv?: {
    startLevel: number;
    endLevel: number;
    duration: number;
    slope: number;
  };
}

export interface GenerateRequest {
  preset?: string;
  oscillators?: OscillatorConfig[];
  duration?: number;
  sampleRate?: number;
}

export interface MatchRequestBody {
  numOscillators?: number;
  maxIterations?: number;
  wavBase64?: string;
}

export interface MatchResult {
  history: {
    iteration: number;
    suppressionPercent: number;
    status?: string;
  }[];
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  };
  suppressionPercent: number;
  wavBase64: string;
}

export interface CreateMatchJobRequest {
  numOscillators?: number;
  maxIterations?: number;
  wavBase64?: string;
}

export interface JobStatusResponse {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: { iteration: number; suppressionPercent: number }[];
  params: { numOscillators: number; maxIterations: number };
  inputFileName: string;
  resultFileName: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  suppressionPercent: number;
  targetInfo: {
    sampleRate: number;
    numSamples: number;
    bitsPerSample: number;
    numChannels: number;
  } | null;
  bestVector: number[] | null;
  synthConfig: {
    oscillators: {
      osc: {
        freqBase: number;
        freqStart: number;
        duration: number;
        slope: number;
        phase: number;
        on: boolean;
      };
      ampEnv: {
        startLevel: number;
        endLevel: number;
        duration: number;
        slope: number;
      };
    }[];
  } | null;
}

export interface JobListItem {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  suppressionPercent: number;
  createdAt: string;
  updatedAt: string;
}

export function oscillatorsToSynthConfig(
  oscillators: OscillatorConfig[],
): ArgCreateSynth {
  return {
    oscillators: oscillators.map((osc) => ({
      osc: {
        freqBase: osc.freqBase,
        freqStart: osc.freqStart,
        duration: osc.duration,
        slope: osc.slope,
        phase: osc.phase,
        on: osc.on ?? true,
      },
      ampEnv: {
        startLevel: osc.ampEnv?.startLevel ?? 0.5,
        endLevel: osc.ampEnv?.endLevel ?? MIN,
        duration: osc.ampEnv?.duration ?? osc.duration ?? 0.5,
        slope: osc.ampEnv?.slope ?? osc.slope ?? 0.8,
      },
    })),
  };
}
