import { SAMPLE_RATE } from './consts';
import { readWav } from './read-wav';
import { match } from './match';
import { simpleInitVector } from './simple-init-vector';
import {
  MATCH_DEFAULT_OSCILLATORS,
  MATCH_DEFAULT_HPO_TRIALS,
} from './match-defaults';

const targetWavPath = './fixtures/output15.wav';
const outputWavPath =
  './matches/output15' + Date().toString() + '.wav';

console.log(`Reading target: ${targetWavPath}`);
const targetWav = readWav(targetWavPath);
const initialVector = simpleInitVector(
  targetWav.samples,
  SAMPLE_RATE,
  MATCH_DEFAULT_OSCILLATORS,
);

console.log('Initialization complete');

match({
  targetWavPath,
  outputWavPath,
  initialVector,
  onProgress: () => {},
  hpoTrials: MATCH_DEFAULT_HPO_TRIALS,
});
