import { readWav } from './src/read-wav';
import { calculateRMS } from './src/rms';
import { assessCancellationQuality } from './src/cancellation-assessment';
import { createSynth } from './src/synth';
import { synthPreset1 } from './src/presets';
import { MIN } from './src/envelope';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './src/consts';

// 1. Regenerate the signal from preset
const synth = createSynth(synthPreset1);
const targetWav = readWav('./output15.wav');
const targetSignal = targetWav.samples;

// Check: is ./output15.wav actually generated from synthPreset1?
const regenerated: Int16Array = new Int16Array(targetSignal.length);
for (let i = 0; i < targetSignal.length; i++) {
  const t = i / 44100;
  regenerated[i] = Math.round(synth({ x: t }) * MAX_AMPLITUDE_16_BIT_WAV_ENCODED);
}

// Compare regenerated to target
const diff: number[] = [];
for (let i = 0; i < targetSignal.length; i++) {
  diff.push(regenerated[i]! - targetSignal[i]!);
}

console.log('Regenerated RMS:', calculateRMS(regenerated));
console.log('Target RMS:', calculateRMS(targetSignal));
console.log('Diff RMS:', calculateRMS(diff));
console.log('Max diff:', Math.max(...diff.map(v => Math.abs(v))));

const assess = assessCancellationQuality({
  target: targetSignal,
  generated: regenerated.map(v => -v),
});
console.log('Self-test suppression:', assess.suppressionPercent.toFixed(4) + '%');

// Now test: what if we use preset1 vector in optimization?
// Let's convert preset to vector to compare with init vector
import { synthConfigToVector } from './src/synth-config-to-vector';
const presetVector = synthConfigToVector(synthPreset1);
console.log('\nPreset vector (first 30 values):');
for (let i = 0; i < presetVector.length && i < 30; i++) {
  console.log(`  [${i}]: ${presetVector[i]!.toFixed(4)}`);
}

// Let's also test the synth directly
const synth2 = createSynth(synthPreset1);
const s1 = synth2({ x: 0 });
const s2 = synth2({ x: 0.5 / 2 });
const s3 = synth2({ x: 0.5 });
console.log('\nSynth sample at t=0:', s1);
console.log('Synth sample at t=0.25:', s2);
console.log('Synth sample at t=0.5:', s3);

// Let's see frequency over time - what frequency is the synth producing?
// Estimate from zero crossings
const segmentSize = 4410; // 100ms
for (let offset = 0; offset < targetSignal.length; offset += segmentSize) {
  const segment = targetSignal.slice(offset, offset + segmentSize);
  let zeroCrossings = 0;
  for (let i = 1; i < segment.length; i++) {
    if ((segment[i - 1]! >= 0 && segment[i]! < 0) ||
        (segment[i - 1]! < 0 && segment[i]! >= 0)) {
      zeroCrossings++;
    }
  }
  const estimatedFreq = (zeroCrossings / 2) * 44100 / segment.length;
  const rms = calculateRMS(segment);
  console.log(`t=${(offset/44100).toFixed(2)}s: estFreq=${estimatedFreq.toFixed(1)}Hz, RMS=${rms.toFixed(1)}`);
}
