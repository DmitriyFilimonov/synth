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
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
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
  /** Честный глобальный suppression финального WAV; null, если оценка не удалась */
  globalSuppressionPercent: number | null;
  wavBase64: string;
  synthConfig: ArgCreateSynth;
}

export interface CreateMatchJobRequest {
  numOscillators?: number;
  maxIterations?: number;
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
  wavBase64?: string;
  /** Название целевого файла (отображается в UI как "targetFileName DD.MM.YYYY HH:MM:SS") */
  targetFileName?: string;
}

export interface MatchParams {
  numOscillators: number;
  maxIterations: number;
  stepGrowthAdd?: number;
  stepDecayFactor?: number;
}

export interface JobStatusResponse {
  id: string;
  /** Human-readable name: "<targetFileName> DD.MM.YYYY HH:MM:SS" */
  name: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: {
    iteration: number;
    suppressionPercent: number;
  }[];
  params: MatchParams;
  inputFileName: string;
  resultFileName: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  suppressionPercent: number;
  /** Честный глобальный suppression финального WAV; null, если оценка не удалась или job старый */
  globalSuppressionPercent: number | null;
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
  globalSuppressionPercent: number | null;
  params: MatchParams;
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
