import { SAMPLE_LENGTH_IN_SECONDS } from './consts';
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
  on: boolean;
}

type OscConfigNormales = {
  [K in keyof ArgOscConfig]: {
    min: number;
    max: number;
    step: number;
  };
};

export const oscConfigNormales: OscConfigNormales = {
  duration: {
    min: SAMPLE_LENGTH_IN_SECONDS,
    max: 0.5,
    step: SAMPLE_LENGTH_IN_SECONDS,
  },
  freqBase: {
    min: 20,
    max: 20000,
    step: 1,
  },
  freqStart: {
    min: 20,
    max: 20000,
    step: 1,
  },
  on: {
    min: 0,
    max: 1,
    step: 1,
  },
  phase: {
    min: 0,
    max: 2 * Math.PI,
    step: (2 * Math.PI) / 360,
  },
  slope: {
    min: 0.2,
    max: 2,
    step: 0.1,
  },
};

interface ArgAmpEnvConfig {
  startLevel: number;
  endLevel?: number;
  duration: number;
  slope: number;
}

type AmpEnvConfigNormales = Required<{
  [K in keyof ArgAmpEnvConfig]: {
    min: number;
    max: number;
    step: number;
  };
}>;

export const ampEnvConfigNormales: AmpEnvConfigNormales = {
  duration: {
    min: SAMPLE_LENGTH_IN_SECONDS,
    max: 0.5,
    step: SAMPLE_LENGTH_IN_SECONDS,
  },
  slope: {
    min: 0.2,
    max: 2,
    step: 0.1,
  },
  startLevel: {
    min: MIN,
    max: 1,
    step: MIN,
  },
  endLevel: {
    min: MIN,
    max: 1,
    step: MIN,
  },
};

interface OscillatorGroup {
  osc: ArgOscConfig;
  ampEnv: ArgAmpEnvConfig;
}

export interface ArgCreateSynth {
  oscillators: OscillatorGroup[];
}

export const MAX_OSCILLATORS = 50;
export const OSC_PARAMS_PER_OSCILLATOR = 10;

const createOscillatorGroup = (config: OscillatorGroup) => {
  const osc = oscillatorCreator({
    on: config.osc.on,
    initialPhase: config.osc.phase,
  });

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
