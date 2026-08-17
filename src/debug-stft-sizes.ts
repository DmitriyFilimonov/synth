/* eslint-disable no-console */
import { readWav } from './read-wav';
import { stftAnalyze } from './spectrogram';

const targetWav = readWav('./output14.wav');

// Analyze with multiple window sizes to see which catches the fundamental
const windowSizes = [4096, 8192];
const sampleRate = 44100;

for (const ws of windowSizes) {
  console.log(
    `\n=== windowSize=${ws} (resolution: ${(sampleRate / ws).toFixed(1)}Hz) ===`,
  );
  const hopSize = Math.floor(ws / 4);
  const frames = stftAnalyze({
    samples: targetWav.samples,
    sampleRate,
    windowSize: ws,
    hopSize,
    maxPeaksPerFrame: 50,
  });

  // Print first 5 frames, top 10 peaks
  console.log(
    'First 5 frames, top 8 peaks (filtering <500Hz and >20kHz):',
  );
  for (let f = 0; f < Math.min(5, frames.length); f++) {
    const frame = frames[f];
    if (!frame) {
      continue;
    }
    const peaks = frame.peaks.filter((p) => p.frequency < 5000);
    const peakStr = peaks
      .slice(0, 8)
      .map((p, i) => `${i}:${p.frequency.toFixed(0)}`)
      .join(' ');
    console.log(
      `  Frame ${f} (${frame.timeSeconds.toFixed(3)}s): ${peakStr}`,
    );
  }
}
