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

interface ArgOscConfig {
  freqBase: number;
  freqStart: number;
  duration: number;
  slope: number;
  phase: number;
}

interface ArgAmpEnvConfig {
  startLevel: number;
  endLevel?: number;
  duration: number;
  slope: number;
}

interface OscillatorGroup {
  osc: ArgOscConfig;
  ampEnv: ArgAmpEnvConfig;
}

export interface ArgCreateSynth {
  oscillators: OscillatorGroup[];
}

const MAX_OSCILLATORS = 50;

const createOscillatorGroup = (config: OscillatorGroup) => {
  const osc = oscillatorCreator();

  const { frequencyEnvelop } = frequencyEnvelopeCreator({
    base: config.osc.freqBase,
    duration: config.osc.duration,
    modulation: config.osc.freqStart - config.osc.freqBase,
    slope: config.osc.slope,
  });

  const amplitudeEnvelope = envelopeCreator({
    duration: config.ampEnv.duration,
    max: config.ampEnv.startLevel,
    min: config.ampEnv.endLevel,
    slope: config.ampEnv.slope,
  });

  return ({ x }: { x: number }) => {
    return osc({
      amplitude: amplitudeEnvelope({ x }),
      frequency: frequencyEnvelop({ x }),
      x,
      phase: config.osc.phase,
    });
  };
};

export const createSynth = (synthConfig: ArgCreateSynth) => {
  if (synthConfig.oscillators.length > MAX_OSCILLATORS) {
    throw new Error(
      `Maximum ${MAX_OSCILLATORS} oscillators allowed, got ${synthConfig.oscillators.length}`,
    );
  }

  const oscillatorGroups = synthConfig.oscillators.map((config) =>
    createOscillatorGroup(config),
  );

  return ({ x }: { x: number }) => {
    let sum = 0;
    for (const oscGroup of oscillatorGroups) {
      sum += oscGroup({ x });
    }
    return Math.max(-1, Math.min(1, sum));
  };
};
