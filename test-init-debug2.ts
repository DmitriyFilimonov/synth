import { readWav } from './src/read-wav';
import { calculateRMS } from './src/rms';
import { computeAmplitudeEnvelope } from './src/signal-analysis';

const wav = readWav('./output15.wav');
const samples = wav.samples;

console.log('WAV samples length:', samples.length);
console.log('Total RMS:', calculateRMS(samples));

const ampEnv = computeAmplitudeEnvelope(samples, 44100, 1024, 256);
console.log('Envelope frames:', ampEnv.length);

const rmsValues = ampEnv.map((e) => e.rms);
const avgRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
const maxRms = Math.max(...rmsValues);
const minRms = Math.min(...rmsValues);

console.log('Avg window RMS:', avgRms);
console.log('Max window RMS:', maxRms);
console.log('Min window RMS:', minRms);
console.log('Ratio avg/total:', calculateRMS(samples));

const maxPossibleRms = 32767 / Math.sqrt(2);
const globalStart = Math.min(avgRms / maxPossibleRms, 0.5);
console.log('avgRms/maxRms:', avgRms / maxPossibleRms);
console.log('globalStart:', globalStart);
