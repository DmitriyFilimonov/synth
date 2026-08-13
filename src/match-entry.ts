import { SAMPLE_RATE } from './consts';
import { readWav } from './read-wav';
import { match } from './match';
import { simpleInitVector } from './simple-init-vector';

// ===== CONFIG =====
const MAX_OSCILLATORS = 2; // Число доступных осцилляторов
// ==================

const targetWavPath = './output15.wav';
const outputWavPath = './output15_recreation_2' + Date().toString() + '.wav';

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
  maxIterations: 600,
  initialVector,
  onProgress: () => {},
});
