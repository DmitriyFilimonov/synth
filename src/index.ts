import { createSynth } from './synth';
import { synthPreset } from './presets';
import { writeWav } from './write-wav';

const SAMPLE_RATE = 44100;
const DURATION_SECONDS = 0.5;
const TOTAL_SAMPLES = Math.floor(SAMPLE_RATE * DURATION_SECONDS);

const synth = createSynth(synthPreset);

const samples = new Int16Array(TOTAL_SAMPLES);

for (let i = 0; i < TOTAL_SAMPLES; i++) {
  const timeSeconds = i / SAMPLE_RATE;
  const sample = synth({ x: timeSeconds });
  samples[i] = Math.round(sample * 32767);
}

writeWav({
  samples,
  sampleRate: SAMPLE_RATE,
  filePath: 'output10.wav',
});
console.log('Generated output10.wav');
