import { readWav } from './src/read-wav';
import { createSynth } from './src/synth';
import { assessCancellationQuality } from './src/cancellation-assessment';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './src/consts';

const wav = readWav('./output15.wav');
const samples = wav.samples;

// Manually create the exact correct init
const config = {
  oscillators: [
    {
      osc: {
        freqBase: 440,
        freqStart: 880,
        duration: 0.5,
        slope: 0.8,
        phase: 0,
        on: true,
      },
      ampEnv: {
        startLevel: 0.5,
        endLevel: 0.001,
        duration: 0.5,
        slope: 0.8,
      },
    },
    {
      osc: {
        freqBase: 442,
        freqStart: 878,
        duration: 0.5,
        slope: 0.8,
        phase: Math.PI,
        on: true,
      },
      ampEnv: {
        startLevel: 0.5,
        endLevel: 0.001,
        duration: 0.5,
        slope: 0.8,
      },
    },
  ],
};

const synth = createSynth(config);
const generated: number[] = [];
for (let i = 0; i < samples.length; i++) {
  const t = i / 44100;
  generated.push(synth({ x: t }) * MAX_AMPLITUDE_16_BIT_WAV_ENCODED);
}

const assess = assessCancellationQuality({
  target: samples,
  generated: generated.map((s) => -s),
});
console.log('Perfect init suppression:', assess.suppressionPercent.toFixed(4) + '%');

// Check amplitude at start
console.log('Target[0]:', samples[0]);
console.log('Generated[0]:', generated[0]);
console.log('Target RMS:', Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length));
console.log('Gen RMS:', Math.sqrt(generated.reduce((s, v) => s + v * v, 0) / generated.length));
