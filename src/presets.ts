import type { ArgCreateSynth } from './synth';

export const synthPreset: ArgCreateSynth = {
  osc: {
    freqBase: 440,
    freqStart: 880,
    duration: 500,
  },
  ampEnv: {
    start: 1,
    end: 0.001,
    duration: 500,
  },
};
