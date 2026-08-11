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

export interface PresetsResponse {
  presets: string[];
  defaultPreset: string;
}
