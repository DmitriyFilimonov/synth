export interface MatchTargetInfo {
  sampleRate: number;
  numSamples: number;
  bitsPerSample: number;
  numChannels: number;
}

export interface MatchHistoryEntry {
  iteration: number;
  suppressionPercent: number;
}

export interface MatchConfig {
  numOscillators?: number;
  maxIterations?: number;
}
