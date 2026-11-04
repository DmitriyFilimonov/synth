export interface FrequencyEnvelopeParameters {
  freqBase: number;
  freqStart: number;
  duration: number;
  slope: number;
  phase: number;
  on: boolean;
}

export interface AmplitudeEnvelopeParameters {
  startLevel: number;
  endLevel: number;
  duration: number;
  slope: number;
}

export interface PatchOscillator {
  osc: FrequencyEnvelopeParameters;
  ampEnv?: AmplitudeEnvelopeParameters;
}

export interface SynthPatch {
  oscillators: PatchOscillator[];
}

/** External patch input accepted by the visualizer. */
export interface PatchVisualizerSource {
  name: string;
  patch: SynthPatch;
}

export interface ActiveOscillator {
  index: number;
  parameters: FrequencyEnvelopeParameters;
}

export interface RenderedSvg {
  blob: Blob;
  url: string;
  fileName: string;
}

export interface FrequencyEnvelopeVisualizationRequest {
  patch: SynthPatch;
  oscillatorIndices: number[];
}
