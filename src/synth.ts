import { envelopeCreator, MIN } from './envelope';
import { oscillatorCreator } from './oscillator';

interface ArgFrequncyEnvelopeCreator {
  /**Hz */
  modulation: number;
  base: number;
  /**s */
  duration: number;
  slope: number;
}

const frequencyEnvelopeCreator = ({
  modulation,
  base,
  duration,
  slope,
}: ArgFrequncyEnvelopeCreator) => {
  const frequencyEnvelopeNormalized = envelopeCreator({
    duration,
    max: 1,
    min: MIN,
    slope,
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
    slope: number;
  };
  ampEnv: {
    startLevel: number;
    endLevel?: number;
    duration: number;
    slope: number;
  };
}

export const createSynth = (synthConfig: ArgCreateSynth) => {
  const osc = oscillatorCreator();

  const { frequencyEnvelop } = frequencyEnvelopeCreator({
    base: synthConfig.osc.freqBase,
    duration: synthConfig.osc.duration,
    modulation: synthConfig.osc.freqStart - synthConfig.osc.freqBase,
    slope: synthConfig.osc.slope,
  });

  const amplitudeEnvelope = envelopeCreator({
    duration: synthConfig.ampEnv.duration,
    max: synthConfig.ampEnv.startLevel,
    min: synthConfig.ampEnv.endLevel,
    slope: synthConfig.ampEnv.slope,
  });

  return ({
    x,
  }: {
    /**s */
    x: number;
  }) => {
    return osc({
      amplitude: amplitudeEnvelope({ x }),
      frequency: frequencyEnvelop({ x }),
      x,
    });
  };
};
