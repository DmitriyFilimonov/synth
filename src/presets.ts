import { MIN } from './envelope';
import type { ArgCreateSynth } from './synth';

export const synthPreset: ArgCreateSynth = {
  osc: {
    freqBase: 440,
    freqStart: 880,
    duration: 0.5,
    slope: 0.8,
  },
  ampEnv: {
    startLevel: 1,
    endLevel: MIN,
    duration: 0.5,
    slope: 0.8,
  },
};
