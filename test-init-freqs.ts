import { readWav } from './src/read-wav';
import { calculateRMS } from './src/rms';
import { estimateFreqOverTime, computeAmplitudeEnvelope } from './src/signal-analysis';

const wav = readWav('./output15.wav');
const samples = wav.samples;

console.log('Signal length:', samples.length, 'samples');
console.log('Total RMS:', calculateRMS(samples));

const freqOverTime = estimateFreqOverTime(samples, 44100, 4410); // 100ms сегменты
console.log('\nfreqOverTime (100ms segments):');
for (const entry of freqOverTime) {
  console.log(`  t=${entry.timeSeconds.toFixed(3)}s: ${entry.freq.toFixed(1)} Hz`);
}

// Also check with smaller segments
const freqOverTimeFine = estimateFreqOverTime(samples, 44100, 1102); // 25ms сегменты
console.log('\nfreqOverTime (25ms segments):');
for (const entry of freqOverTimeFine) {
  console.log(`  t=${entry.timeSeconds.toFixed(3)}s: ${entry.freq.toFixed(1)} Hz`);
}

// Amplitude envelope
const ampEnv = computeAmplitudeEnvelope(samples, 44100, 1024, 256);
console.log('\nAmplitude envelope:');
for (let i = 0; i < ampEnv.length; i += 5) {
  const e = ampEnv[i]!;
  console.log(`  t=${e.timeSeconds.toFixed(3)}s: RMS=${e.rms.toFixed(1)}`);
}

// Extract phase/amplitude for actual preset frequencies
const extract = (freq: number) => {
  const n = samples.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const t = i / 44100;
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

// Test exact preset frequencies
for (const freq of [440, 442, 441, 443]) {
  const p = extract(freq);
  console.log(`\n${freq}Hz: amp=${p.amplitude.toFixed(2)}, phase=${((p.phase * 180) / Math.PI).toFixed(1)}°`);
}
