import { SYNTH_MULTI_PRESET } from './match-preset';
import { mapSynthConfigToVector } from './synth-config-to-vector';
import { match } from './match';

const NUM_OSCILLATORS = 5;

match({
  targetWavPath: './output14.wav',
  outputWavPath: './output14_reacreation_7.wav',
  maxIterations: 5000,
  initialVector: mapSynthConfigToVector(
    SYNTH_MULTI_PRESET(NUM_OSCILLATORS),
  ),
  onProgress: (entry) => {
    console.log(
      `Iteration ${entry.iteration}: ${entry.suppressionPercent.toFixed(2)}%`,
    );
  },
});
