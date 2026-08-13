import { readWav } from './src/read-wav';
import { calculateRMS } from './src/rms';
import { createSynth } from './src/synth';
import { mapVectorToSynthConfig } from './src/vector-to-synth-config';
import { synthConfigToVector } from './src/synth-config-to-vector';
import { simpleInitVector } from './src/simple-init-vector';
import { assessCancellationQuality } from './src/cancellation-assessment';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './src/consts';

const wav = readWav('./output15.wav');
const targetSignal = wav.samples;

// === 1. Test init suppression ===
const vector = simpleInitVector(targetSignal, 44100, 2);
console.log('Init vector:', vector.map((v) => v.toFixed(4)).join(', '));

const synth = createSynth(mapVectorToSynthConfig([...vector]));
const generated: number[] = [];
for (let i = 0; i < targetSignal.length; i++) {
  generated.push(synth({ x: i / 44100 }) * MAX_AMPLITUDE_16_BIT_WAV_ENCODED);
}

const inv = generated.map((s) => -s);
const assess = assessCancellationQuality({
  target: targetSignal,
  generated: inv,
});
console.log('Init suppression:', assess.suppressionPercent.toFixed(4) + '%');

// === 2. Test with direct amplitudes ===
const extractPhaseAndAmplitude = (
  samples: Int16Array,
  sampleRate: number,
  freq: number,
): { phase: number; amplitude: number } => {
  const n = samples.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const angle = 2 * Math.PI * freq * t;
    re += samples[i]! * Math.cos(angle);
    im -= samples[i]! * Math.sin(angle);
  }
  re /= n;
  im /= n;
  return {
    phase: Math.atan2(im, re),
    amplitude: Math.sqrt(re * re + im * im) * 2,
  };
};

const amp441 = extractPhaseAndAmplitude(targetSignal, 44100, 441);
const amp443 = extractPhaseAndAmplitude(targetSignal, 44100, 443);
console.log('\nDirect extraction:');
console.log(
  `441Hz: amp=${amp441.amplitude.toFixed(1)}, phase=${((amp441.phase * 180) / Math.PI).toFixed(1)}°`,
);
console.log(
  `443Hz: amp=${amp443.amplitude.toFixed(1)}, phase=${((amp443.phase * 180) / Math.PI).toFixed(1)}°`,
);

// === 3. What if startLevel = 0 (silence)? ===
console.log('\n--- Test: What suppression with zero init? ---');
const zeroVector = new Array(20).fill(0);
zeroVector[0] = 1;
zeroVector[10] = 1;
const zeroSynth = createSynth(mapVectorToSynthConfig([...zeroVector]));
const zeroGen: number[] = [];
for (let i = 0; i < targetSignal.length; i++) {
  zeroGen.push(zeroSynth({ x: i / 44100 }) * MAX_AMPLITUDE_16_BIT_WAV_ENCODED);
}
const zeroAssess = assessCancellationQuality({
  target: targetSignal,
  generated: zeroGen.map((s) => -s),
});
console.log('Zero init suppression:', zeroAssess.suppressionPercent.toFixed(4) + '%');
