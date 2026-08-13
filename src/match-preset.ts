import { MIN } from './envelope';
import { VOLUME_MIN } from './consts';
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
        startLevel: VOLUME_MIN,
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
        freqBase: 50 * (i + 1),
        freqStart: 440 * (i + 1),
        duration: DURATION,
        slope: 1,
        phase: (Math.PI * i) / count,
        on: true,
      },
      ampEnv: {
        startLevel: VOLUME_MIN,
        endLevel: MIN,
        duration: DURATION,
        slope: 1,
      },
    });
  }
  return { oscillators };
};
