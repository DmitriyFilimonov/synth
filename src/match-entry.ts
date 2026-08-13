import { SYNTH_MULTI_PRESET } from './match-preset';
import { mapSynthConfigToVector } from './synth-config-to-vector';
import { match } from './match';

const NUM_OSCILLATORS = 3;

match({
  targetWavPath: './output14.wav',
  outputWavPath: './output14_reacreation_16.wav',
  maxIterations: 100,
  initialVector: mapSynthConfigToVector(
    SYNTH_MULTI_PRESET(NUM_OSCILLATORS),
  ),
  onProgress: () => {},
});
