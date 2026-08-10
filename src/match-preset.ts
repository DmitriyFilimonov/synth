import { SAMPLE_LENGTH_IN_SECONDS } from './consts';
import { MIN } from './envelope';
import type { ArgCreateSynth } from './synth';

const DURATION = 0.5;

export const SYNTH_DEFAULT_PRESET: ArgCreateSynth = {
  oscillators: [
    {
      osc: {
        freqBase: 440,
        freqStart: 440,
        duration: DURATION,
        slope: 1,
        phase: 0,
        on: true,
      },
      ampEnv: {
        startLevel: 1,
        endLevel: MIN,
        duration: DURATION,
        slope: 1,
      },
    },
  ],
};

export const SYNTH_MULTI_PRESET = (count: number): ArgCreateSynth => {
  const oscillators = [];
  for (let i = 0; i < count; i++) {
    oscillators.push({
      osc: {
        freqBase: 440 * (i + 1),
        freqStart: 440 * (i + 1),
        duration: DURATION,
        slope: 1,
        phase: (Math.PI * i) / count,
        on: true,
      },
      ampEnv: {
        startLevel: 1 / (i + 1),
        endLevel: MIN,
        duration: DURATION,
        slope: 1,
      },
    });
  }
  return { oscillators };
};
