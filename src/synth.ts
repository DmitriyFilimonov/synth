import { envelopeCreator } from './envelope';
import { oscillatorCreator } from './oscillator';

interface ArgFrequncyEnvelopeCreator {
  /**Hz */
  modulation: number;
  base: number;
  duration: number;
}

const frequencyEnvelopeCreator = ({
  modulation,
  base,
  duration,
}: ArgFrequncyEnvelopeCreator) => {
  const frequencyEnvelopeNormalized = envelopeCreator({
    duration,
    max: 1,
    min: Number.MIN_VALUE,
  });

  const frequencyEnvelop = ({
    x,
  }: {
    /**время (в секундах) */
    x: number;
  }) => {
    const normalizedFrequencyModulation = frequencyEnvelopeNormalized(
      { x },
    );

    const frequency =
      base + modulation * normalizedFrequencyModulation;

    return frequency;
  };

  return { frequencyEnvelop };
};

export interface ArgCreateSynth {
  osc: {
    freqBase: number;
    freqStart: number;
    duration: number;
  };
  ampEnv: {
    start: number;
    end?: number;
    duration: number;
  };
}

export const createSynth = (synthConfig: ArgCreateSynth) => {
  const osc = oscillatorCreator();

  const { frequencyEnvelop } = frequencyEnvelopeCreator({
    base: synthConfig.osc.freqBase,
    duration: synthConfig.osc.duration,
    modulation: synthConfig.osc.freqStart - synthConfig.osc.freqBase,
  });

  const amplitudeEnvelope = envelopeCreator({
    duration: synthConfig.ampEnv.duration,
    max: synthConfig.ampEnv.start,
    min: synthConfig.ampEnv.end,
  });

  return ({ x }: { x: number }) => {
    const xMs = x * 1000;
    return osc({
      amplitude: amplitudeEnvelope({ x: xMs }),
      frequency: frequencyEnvelop({ x: xMs }),
      x: xMs,
    });
  };
};
