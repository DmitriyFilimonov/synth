import { readWav } from './read-wav';
import {
  createSynth,
  MAX_OSCILLATORS,
  OSC_PARAMS_PER_OSCILLATOR,
} from './synth';
import { mapVectorToSynthConfig } from './vector-to-synth-config';
import {
  SAMPLE_RATE,
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
} from './consts';

const wav = readWav('./output14.wav');
const samples = wav.samples;

// Zero-crossing analysis to estimate frequency at different time points
const findZeroCrossings = (
  signal: Int16Array,
  from: number,
  to: number,
): number[] => {
  const crossings: number[] = [];
  for (let i = from + 1; i < to; i++) {
    if (
      (signal[i - 1] < 0 && signal[i] >= 0) ||
      (signal[i - 1] >= 0 && signal[i] < 0)
    ) {
      crossings.push(i);
    }
  }
  return crossings;
};

console.log(
  'Zero-crossing frequency estimate at different time points:',
);
const totalSamples = samples.length;
const checkpoints = [
  0,
  totalSamples * 0.1,
  totalSamples * 0.25,
  totalSamples * 0.5,
  totalSamples * 0.75,
  totalSamples * 0.9,
];

for (const startSample of checkpoints) {
  const endSample = Math.min(startSample + 4410, totalSamples);
  const crossings = findZeroCrossings(
    samples,
    Math.floor(startSample),
    endSample,
  );
  if (crossings.length >= 2) {
    const period = (endSample - startSample) / (crossings.length / 2);
    const freq = SAMPLE_RATE / period;
    const timeMs = ((startSample / SAMPLE_RATE) * 1000).toFixed(0);
    console.log(
      `  t=${timeMs}ms: ${crossings.length} crossings, est. freq=${freq.toFixed(0)}Hz, amp=${Math.max(Math.abs(samples[Math.floor(startSample)]), Math.abs(samples[Math.floor(startSample) + 100]))}`,
    );
  }
}

// Peak amplitude over time
console.log('\nPeak amplitude over time:');
for (let t = 0; t < 10; t++) {
  const start = Math.floor((t * totalSamples) / 10);
  const end = start + Math.floor(totalSamples / 10);
  let maxAmp = 0;
  for (let i = start; i < end; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > maxAmp) maxAmp = abs;
  }
  const timeMs = ((start / SAMPLE_RATE) * 1000).toFixed(0);
  console.log(
    `  t=${timeMs}ms: peak=${maxAmp} (${((maxAmp / 32767) * 100).toFixed(1)}%)`,
  );
}
