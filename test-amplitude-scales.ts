import { readWav } from './src/read-wav';
import { assessCancellationQuality } from './src/cancellation-assessment';
import { MAX_AMPLITUDE_16_BIT_WAV_ENCODED } from './src/consts';

const wav = readWav('./output15.wav');
const targetSignal = wav.samples;

// Extract phase and amplitude
const extract = (freq: number) => {
  const n = targetSignal.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const t = i / 44100;
    const angle = 2 * Math.PI * freq * t;
    re += targetSignal[i]! * Math.cos(angle);
    im -= targetSignal[i]! * Math.sin(angle);
  }
  re /= n;
  im /= n;
  return {
    phase: Math.atan2(im, re),
    amplitude: Math.sqrt(re * re + im * im) * 2,
  };
};

const p1 = extract(441);
const p2 = extract(443);
console.log('Extracted: 441Hz amp=' + p1.amplitude.toFixed(1) + ' phase=' + ((p1.phase * 180) / Math.PI).toFixed(1) + '°');
console.log('Extracted: 443Hz amp=' + p2.amplitude.toFixed(1) + ' phase=' + ((p2.phase * 180) / Math.PI).toFixed(1) + '°');

// Generate signal with various amplitude scales
const scales = [1, 2, 5, 7, 10, 14, 15];

for (const scale of scales) {
  const generated: number[] = [];
  for (let i = 0; i < targetSignal.length; i++) {
    const t = i / 44100;
    const sample =
      p1.amplitude * scale * Math.cos(2 * Math.PI * 441 * t + p1.phase) +
      p2.amplitude * scale * Math.cos(2 * Math.PI * 443 * t + p2.phase);
    generated.push(sample);
  }

  const inverted = generated.map((s) => -s);
  const assess = assessCancellationQuality({
    target: targetSignal,
    generated: inverted,
  });
  console.log('Scale ' + scale + ': suppression=' + assess.suppressionPercent.toFixed(2) + '%');
}
