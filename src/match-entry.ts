import { SAMPLE_RATE } from './consts';
import { readWav } from './read-wav';
import { match } from './match';
import { simpleInitVector } from './simple-init-vector';
import {
  MATCH_DEFAULT_OSCILLATORS,
  MATCH_DEFAULT_ITERATIONS,
  MATCH_DEFAULT_STEP_GROWTH_ADD,
  MATCH_DEFAULT_STEP_DECAY_FACTOR,
} from './match-defaults';

const targetWavPath = './targets/techno_1.wav';
const outputWavPath =
  './matches/techno_1' + Date().toString() + '.wav';

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
  maxIterations: MATCH_DEFAULT_ITERATIONS,
  initialVector,
  onProgress: () => {},
  stepGrowthAdd: MATCH_DEFAULT_STEP_GROWTH_ADD,
  stepDecayFactor: MATCH_DEFAULT_STEP_DECAY_FACTOR,
});
