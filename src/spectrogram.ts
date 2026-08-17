/* eslint-disable no-console */
/**
 * Short-Time Fourier Transform (STFT) for full-signal analysis.
 * Splits signal into overlapping windows, extracts frequency/amplitude trajectories.
 */

type ComplexVal = [number, number];

const fft = (signal: Float64Array): ComplexVal[] => {
  const n = signal.length;
  if (n <= 1) {
    return [[signal[0] ?? 0, 0]];
  }

  const omega = (-2.0 * Math.PI) / n;
  const result: ComplexVal[] = Array.from({ length: n });

  const jReverse = (i: number): number => {
    let reversed = 0;
    let bits = 0;
    let temp = i;
    let len = n;
    while (len > 1) {
      len >>= 1;
      bits++;
    }
    while (bits > 0) {
      reversed = (reversed << 1) | (temp & 1);
      temp >>= 1;
      bits--;
    }
    return reversed;
  };

  for (let i = 0; i < n; i++) {
    const ri = jReverse(i);
    const sample = signal[ri] ?? 0;
    result[ri] = [sample, 0];
  }

  let len = 2;
  while (len <= n) {
    const half = len >> 1;
    const wAngle = omega * half;
    const wReal = Math.cos(wAngle);
    const wImag = Math.sin(wAngle);

    for (let i = 0; i < n; i += len) {
      let uReal = 1;
      let uImag = 0;
      for (let j = 0; j < half; j++) {
        const ai = i + j;
        const bi = i + j + half;
        const [aReal, aImag] = result[ai] ?? [0, 0];
        const [bReal, bImag] = result[bi] ?? [0, 0];
        const tr = uReal * bReal - uImag * bImag;
        const ti = uReal * bImag + uImag * bReal;
        result[ai] = [aReal + tr, aImag + ti];
        result[bi] = [aReal - tr, aImag - ti];
        const newReal = uReal * wReal - uImag * wImag;
        const newImag = uReal * wImag + uImag * wReal;
        uReal = newReal;
        uImag = newImag;
      }
    }
    len <<= 1;
  }

  return result;
};

export interface STFTFrame {
  timeSeconds: number;
  peaks: {
    frequency: number;
    magnitude: number;
    phase: number;
  }[];
}

const applyHanning = (samples: Float64Array): Float64Array => {
  const n = samples.length;
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const multiplier =
      0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    const s = samples[i];
    if (s !== undefined) {
      windowed[i] = s * multiplier;
    }
  }
  return windowed;
};

const findPeaksInSpectrum = (
  spectrum: ComplexVal[],
  sampleRate: number,
  fftSize: number,
  maxPeaks: number,
): { frequency: number; magnitude: number; phase: number }[] => {
  const numBins = fftSize >> 1;

  const magnitudeBin = (k: number): number => {
    const [r, i] = spectrum[k] ?? [0, 0];
    return Math.sqrt(r * r + i * i) / fftSize;
  };

  const magnitudes = Array.from({ length: numBins }, (_, k) =>
    magnitudeBin(k),
  );
  const maxMag = Math.max(...magnitudes);
  const threshold = maxMag * 0.03;

  const peaks: {
    frequency: number;
    magnitude: number;
    phase: number;
    weightedMagnitude: number;
  }[] = [];
  for (let k = 1; k < numBins; k++) {
    const mag = magnitudeBin(k);
    if (mag < threshold) {
      continue;
    }
    const prev = magnitudeBin(k - 1);
    const next = magnitudeBin(k + 1);
    if (mag > prev && mag > next) {
      const [r, i] = spectrum[k] ?? [0, 0];
      const freq = (k * sampleRate) / fftSize;
      const phase = Math.atan2(i, r);
      const freqWeight = 1 / Math.sqrt(Math.max(freq, 20));
      peaks.push({
        frequency: freq,
        magnitude: mag,
        phase,
        weightedMagnitude: mag * freqWeight,
      });
    }
  }

  peaks.sort((a, b) => b.magnitude - a.magnitude);
  return peaks.slice(0, maxPeaks).map((p) => ({
    frequency: p.frequency,
    magnitude: p.magnitude,
    phase: p.phase,
  }));
};

export interface ArgSTFT {
  samples: Int16Array | number[];
  sampleRate: number;
  windowSize: number;
  hopSize: number;
  maxPeaksPerFrame: number;
}

export const stftAnalyze = (arg: ArgSTFT): STFTFrame[] => {
  const {
    samples,
    sampleRate,
    windowSize,
    hopSize,
    maxPeaksPerFrame,
  } = arg;
  const signalLen = samples.length;

  const fftSize = 1 << Math.ceil(Math.log2(windowSize));
  const paddedWindow = new Float64Array(fftSize);

  const frames: STFTFrame[] = [];

  for (
    let start = 0;
    start + windowSize < signalLen;
    start += hopSize
  ) {
    for (let i = 0; i < fftSize; i++) {
      if (i < windowSize && start + i < signalLen) {
        paddedWindow[i] = samples[start + i] ?? 0;
      } else {
        paddedWindow[i] = 0;
      }
    }

    const windowed = applyHanning(paddedWindow.slice(0, fftSize));
    const spectrum = fft(windowed);
    const peaks = findPeaksInSpectrum(
      spectrum,
      sampleRate,
      fftSize,
      maxPeaksPerFrame,
    );

    const timeSeconds = start / sampleRate;
    frames.push({ timeSeconds, peaks });
  }

  return frames;
};

export interface HarmonicTrajectory {
  frequencies: number[];
  magnitudes: number[];
  phases: number[];
  activeFrames: number[];
}

/**
 * Cluster peaks across frames into harmonic trajectories.
 * Uses activeFrames to find last known frequency of each cluster.
 */
export const clusterHarmonics = (
  frames: STFTFrame[],
  frequencyTolerance: number = 700,
): HarmonicTrajectory[] => {
  type Cluster = {
    harmonicId: number;
    frequencies: number[];
    magnitudes: number[];
    phases: number[];
    activeFrames: number[];
  };

  const clusters: Cluster[] = [];
  let matchedPeaks = 0;

  for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    const frame = frames[frameIdx];
    if (!frame) {
      continue;
    }

    for (let peakIdx = 0; peakIdx < frame.peaks.length; peakIdx++) {
      const peak = frame.peaks[peakIdx];
      if (!peak) {
        continue;
      }

      let bestCluster: Cluster | null = null;
      let bestDist = Infinity;

      for (const cluster of clusters) {
        const lastActive =
          cluster.activeFrames[cluster.activeFrames.length - 1];
        if (lastActive === undefined) {
          continue;
        }
        // Only match recent frames (within 8 frames)
        if (frameIdx - lastActive > 8) {
          continue;
        }

        const lastFreq = cluster.frequencies[lastActive];
        if (lastFreq === undefined || lastFreq === 0) {
          continue;
        }

        const dist = Math.abs(peak.frequency - lastFreq);
        if (dist < frequencyTolerance && dist < bestDist) {
          bestDist = dist;
          bestCluster = cluster;
        }
      }

      if (bestCluster) {
        bestCluster.frequencies[frameIdx] = peak.frequency;
        bestCluster.magnitudes[frameIdx] = peak.magnitude;
        bestCluster.phases[frameIdx] = peak.phase;
        bestCluster.activeFrames.push(frameIdx);
        matchedPeaks++;
      } else {
        const freqs = new Array<number>(frames.length).fill(0);
        const mags = new Array<number>(frames.length).fill(0);
        const phs = new Array<number>(frames.length).fill(0);
        freqs[frameIdx] = peak.frequency;
        mags[frameIdx] = peak.magnitude;
        phs[frameIdx] = peak.phase;
        clusters.push({
          harmonicId: clusters.length,
          frequencies: freqs,
          magnitudes: mags,
          phases: phs,
          activeFrames: [frameIdx],
        });
      }
    }
  }

  console.log(
    `STFT clustering: ${clusters.length} total clusters, ${matchedPeaks} matched peaks`,
  );

  const filtered = clusters
    .filter((c) => c.activeFrames.length >= 3)
    .map((c) => ({
      frequencies: c.frequencies,
      magnitudes: c.magnitudes,
      phases: c.phases,
      activeFrames: c.activeFrames,
    }));

  console.log(
    `STFT: ${filtered.length} valid trajectories (>=3 frames)`,
  );
  return filtered;
};

export interface HarmonicOscParams {
  freqBase: number;
  freqStart: number;
  phase: number;
  startLevel: number;
  endLevel: number;
  avgMagnitude: number;
}

export const fitOscEnvelopes = (
  trajectory: HarmonicTrajectory,
  sampleRate: number,
  signalDuration: number,
  maxFreq: number = 20000,
  minFreq: number = 20,
): HarmonicOscParams | null => {
  const { frequencies, magnitudes, phases } = trajectory;

  let firstFreq: number | null = null;
  let lastFreq: number | null = null;
  let firstMag: number | null = null;
  let lastMag: number | null = null;
  let firstPhase: number | null = null;
  const activeFreqs: number[] = [];
  const activeMags: number[] = [];

  for (let i = 0; i < frequencies.length; i++) {
    const freq = frequencies[i];
    const mag = magnitudes[i];
    const phase = phases[i];
    if (freq !== undefined && freq !== 0) {
      if (firstFreq === null) {
        firstFreq = freq;
      }
      lastFreq = freq;
      activeFreqs.push(freq);
      if (mag !== undefined) {
        activeMags.push(mag);
        if (firstMag === null) {
          firstMag = mag;
        }
        lastMag = mag;
        if (firstPhase === null && phase !== undefined) {
          firstPhase = phase;
        }
      }
    }
  }

  if (
    firstFreq === null ||
    lastFreq === null ||
    activeFreqs.length < 2
  ) {
    return null;
  }

  const clampFreq = (f: number): number =>
    Math.max(minFreq, Math.min(maxFreq, f));

  const avgMag =
    activeMags.length > 0
      ? activeMags.reduce((a, b) => a + b, 0) / activeMags.length
      : 0;

  return {
    freqBase: clampFreq(firstFreq),
    freqStart: clampFreq(lastFreq),
    phase: firstPhase ?? 0,
    startLevel: firstMag ?? 0,
    endLevel: lastMag ?? 0,
    avgMagnitude: avgMag,
  };
};
