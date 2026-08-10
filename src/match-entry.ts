import { match } from './match';

match({
  targetWavPath: './test-sine-decay.wav',
  outputWavPath: './matched-output.wav',
  maxIterations: 6,
});
