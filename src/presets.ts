import { MIN } from './envelope';
import type { ArgCreateSynth } from './synth';

export const synthPreset: ArgCreateSynth = {
  oscillators: [
    {
      osc: {
        freqBase: 220,
        freqStart: 880,
        duration: 0.5,
        slope: 0.8,
      },
      ampEnv: {
        startLevel: 0.5,
        endLevel: MIN,
        duration: 0.5,
        slope: 0.8,
      },
    },
    {
      osc: {
        freqBase: 442,
        freqStart: 878,
        duration: 0.5,
        slope: 0.8,
      },
      ampEnv: {
        startLevel: 0.5,
        endLevel: MIN,
        duration: 0.5,
        slope: 0.8,
      },
    },
  ],
};
