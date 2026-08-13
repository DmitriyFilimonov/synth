import { readWav } from './read-wav';
import { stftAnalyze } from './spectrogram';

const targetWav = readWav('./output14.wav');
const samples = targetWav.samples;
const sampleRate = 44100;

const windowSize = 2048;
const hopSize = 512;
const maxPeaksPerFrame = 30;

const frames = stftAnalyze({
  samples,
  sampleRate,
  windowSize,
  hopSize,
  maxPeaksPerFrame,
});

// Print first 15 frames, top 5 peaks each
console.log(`Total frames: ${frames.length}\n`);
console.log(
  `First 15 frames, top 5 peaks each (windowSize=${windowSize}, hopSize=${hopSize}):`,
);
for (let f = 0; f < Math.min(15, frames.length); f++) {
  const frame = frames[f];
  if (!frame) continue;
  const top5 = frame.peaks.slice(0, 5);
  const peakStr = top5
    .map((p, i) => `${i}:${p.frequency.toFixed(0)}`)
    .join(' ');
  console.log(`  Frame ${f}: ${peakStr}`);
}

// Show frame at 50%
const midIdx = Math.floor(frames.length / 2);
const midFrame = frames[midIdx];
if (midFrame) {
  console.log(
    `\nFrame ${midIdx} (${midFrame.timeSeconds.toFixed(3)}s):`,
  );
  midFrame.peaks.slice(0, 8).forEach((p, i) => {
    if (p)
      console.log(
        `  [${i}] ${p.frequency.toFixed(0)}Hz mag=${p.magnitude.toFixed(0)}`,
      );
  });
}
