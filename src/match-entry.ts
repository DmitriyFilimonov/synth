/* eslint-disable no-console */
import { SAMPLE_RATE } from './consts';
import { readWav } from './read-wav';
import { match } from './match';
import { simpleInitVector } from './simple-init-vector';
import { MATCH_DEFAULT_OSCILLATORS } from './match-defaults';
import { writeFileSync, renameSync } from 'node:fs';

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

const paramsPath = `${outputWavPath}.params.json`;
const tmpParamsPath = `${paramsPath}.tmp`;
writeFileSync(
  tmpParamsPath,
  JSON.stringify(result.optimizedConfig, null, 2),
);
renameSync(tmpParamsPath, paramsPath);
console.log(`Parameters: ${paramsPath}`);
