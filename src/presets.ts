import { MIN } from './envelope';
import type { ArgCreateSynth } from './synth';

export const synthPreset: ArgCreateSynth = {
  oscillators: [
    {
      osc: {
        freqBase: 440,
        freqStart: 880,
        duration: 0.5,
        slope: 0.8,
        phase: 0,
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
        phase: Math.PI,
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
