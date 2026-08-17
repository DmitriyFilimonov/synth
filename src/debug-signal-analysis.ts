/* eslint-disable no-console */
import { readWav } from './read-wav';
import {
  estimateFundamentalFreq,
  computeAmplitudeEnvelope,
  estimateFreqOverTime,
} from './signal-analysis';
import { SAMPLE_RATE } from './consts';

const wav = readWav('./output14.wav');

// Fundamental frequency
const fundFreq = estimateFundamentalFreq(wav.samples, SAMPLE_RATE);
console.log(`Fundamental freq: ${fundFreq?.toFixed(1) ?? 'null'} Hz`);

// Frequency over time
const freqOverTime = estimateFreqOverTime(wav.samples, SAMPLE_RATE);
console.log('\nFreq over time:');
for (const pt of freqOverTime.slice(0, 10)) {
  console.log(
    `  t=${(pt.timeSeconds * 1000).toFixed(0)}ms: ${pt.freq.toFixed(0)} Hz`,
  );
}
if (freqOverTime.length > 10) {
  console.log('  ...');
}

// Amplitude envelope
const ampEnv = computeAmplitudeEnvelope(wav.samples, SAMPLE_RATE);
console.log('\nAmplitude envelope:');
for (const pt of ampEnv.slice(0, 10)) {
  console.log(
    `  t=${(pt.timeSeconds * 1000).toFixed(0)}ms: RMS=${pt.rms.toFixed(0)}`,
  );
}
if (ampEnv.length > 10) {
  console.log('  ...');
}
