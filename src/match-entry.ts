/* eslint-disable no-console */
import { SAMPLE_RATE } from './consts';
import { readWav } from './read-wav';
import { match } from './match';
import { simpleInitVector } from './simple-init-vector';
import { MATCH_DEFAULT_OSCILLATORS } from './match-defaults';
import { writeMatchArtifacts } from './match-metadata';

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

const result = match({
  targetWavPath,
  outputWavPath,
  initialVector,
  onProgress: () => {},
});

const artifacts = writeMatchArtifacts(outputWavPath, result);
console.log(`Parameters: ${artifacts.paramsPath}`);
console.log(`Metadata: ${artifacts.metadataPath}`);
