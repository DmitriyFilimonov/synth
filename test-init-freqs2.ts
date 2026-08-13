import { readWav } from './src/read-wav';
import { simpleInitVector } from './src/simple-init-vector';
import { createSynth } from './src/synth';
import { mapVectorToSynthConfig } from './src/vector-to-synth-config';
import { assessCancellationQuality } from './src/cancellation-assessment';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './src/consts';

const wav = readWav('./output15.wav');
const samples = wav.samples;

console.log('=== Init with maxOsc=2 ===');
const vector = simpleInitVector(samples, 44100, 2);

const config = mapVectorToSynthConfig([...vector]);
for (let i = 0; i < config.oscillators.length; i++) {
  const osc = config.oscillators[i]!;
  console.log(
    `[${i}] freq=${osc.osc.freqBase.toFixed(1)}Hz phase=${((osc.osc.phase * 180) / Math.PI).toFixed(1)}° start=${osc.ampEnv.startLevel.toFixed(4)} end=${osc.ampEnv.endLevel.toFixed(4)} dur=${osc.ampEnv.duration.toFixed(3)}s slope=${osc.ampEnv.slope.toFixed(2)}`,
  );
}

// Generate
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
console.log('Init suppression:', assess.suppressionPercent.toFixed(4) + '%');

// Amplitude comparison
console.log('\n--- Amplitude comparison ---');
for (let ms = 0; ms <= 500; ms += 50) {
  const idx = Math.floor((ms / 1000) * 44100);
  const targetAmp =
    (Math.abs(samples[idx - 1] ?? 0) +
      Math.abs(samples[idx] ?? 0) +
      Math.abs(samples[idx + 1] ?? 0)) / 3;
  const genAmp =
    (Math.abs(generated[idx - 1] ?? 0) +
      Math.abs(generated[idx] ?? 0) +
      Math.abs(generated[idx + 1] ?? 0)) / 3;
  console.log(
    `t=${ms}ms: target=${targetAmp.toFixed(1)} gen=${genAmp.toFixed(1)} ratio=${(genAmp / Math.max(targetAmp, 1)).toFixed(2)}`,
  );
}
