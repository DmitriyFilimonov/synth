import { SAMPLE_RATE } from './consts';
import { readWav } from './read-wav';
import { match } from './match';
import { simpleInitVector } from './simple-init-vector';

// ===== CONFIG =====
const MAX_OSCILLATORS = 2;
const MAX_ITERATIONS = 600;
const STEP_GROWTH_ADD = 0.001;
const STEP_DECAY_FACTOR = 0.97;
// ==================

const targetWavPath = './output14.wav';
const outputWavPath =
  './output14_recreation' + Date().toString() + '.wav';

console.log(`Reading target: ${targetWavPath}`);
const targetWav = readWav(targetWavPath);
const initialVector = simpleInitVector(
  targetWav.samples,
  SAMPLE_RATE,
  MAX_OSCILLATORS,
);

console.log('Initialization complete');

match({
  targetWavPath,
  outputWavPath,
  maxIterations: MAX_ITERATIONS,
  initialVector,
  onProgress: () => {},
  stepGrowthAdd: STEP_GROWTH_ADD,
  stepDecayFactor: STEP_DECAY_FACTOR,
});
