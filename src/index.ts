import { createSynth } from './synth';
import { synthPreset1 } from './presets';
import { writeWav } from './write-wav';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './consts';

const SAMPLE_RATE = 44100;
const DURATION_SECONDS = 0.5;
const TOTAL_SAMPLES = Math.floor(SAMPLE_RATE * DURATION_SECONDS);

const synth = createSynth(synthPreset1);

const samples = new Int16Array(TOTAL_SAMPLES);

for (let i = 0; i < TOTAL_SAMPLES; i++) {
  const timeSeconds = i / SAMPLE_RATE;
  const sample = synth({ x: timeSeconds });
  samples[i] = Math.round(sample * MAX_AMPLITUDE_16_BIT_WAV_ENCODED);
}

writeWav({
  samples,
  sampleRate: SAMPLE_RATE,
  filePath: 'output15.wav',
});
console.log('Generated output15.wav');
