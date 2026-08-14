import {
  MAX_OSCILLATORS,
  OSC_PARAMS_PER_OSCILLATOR,
  oscConfigNormales,
  ampEnvConfigNormales,
} from './synth';
import { SAMPLE_LENGTH_IN_SECONDS } from './consts';
import { fftExtractHarmonics } from './fft';

const normalize = (
  value: number,
  min: number,
  max: number,
): number => {
  const clamped = Math.max(min, Math.min(max, value));
  return (clamped - min) / (max - min);
};

/**
 * Build an initial vector for the optimizer from a WAV target signal.
 * Uses FFT to detect dominant harmonics and maps them to oscillator parameters.
 */
export const fftInitVector = (
  samples: Int16Array,
  sampleRate: number,
  maxOscillators: number = MAX_OSCILLATORS,
): number[] => {
  // Use short-window FFT (first ~23ms) to capture initial frequencies
  // before frequency/amplitude envelopes have time to vary significantly.
  // Long-window FFT integrates over all sweeps and produces meaningless peaks.
  const windowSize = 1024;
  const signalLen = Math.min(samples.length, windowSize);
  const windowedSamples = samples.slice(0, signalLen);

  const harmonics = fftExtractHarmonics(
    windowedSamples,
    sampleRate,
    maxOscillators,
  );

  const vector = new Array(
    maxOscillators * OSC_PARAMS_PER_OSCILLATOR,
  ).fill(0);

  const sampleLength = SAMPLE_LENGTH_IN_SECONDS;
  const freqEnvDurationNorm = normalize(
    sampleLength,
    oscConfigNormales.duration.min,
    oscConfigNormales.duration.max,
  );
  const ampEnvDurationNorm = normalize(
    sampleLength,
    ampEnvConfigNormales.duration.min,
    ampEnvConfigNormales.duration.max,
  );

  if (harmonics.length > 0) {
    console.log(`FFT detected ${harmonics.length} harmonics:`);
    for (let i = 0; i < harmonics.length; i++) {
      const h = harmonics[i];
      if (!h) {
        continue;
      }
      console.log(
        `  [${i}] freq=${h.frequency.toFixed(1)}Hz, mag=${h.magnitude.toFixed(1)}, phase=${h.phase.toFixed(3)} rad`,
      );
    }
  }

  const harmonicCount = Math.min(harmonics.length, MAX_OSCILLATORS);
  for (let i = 0; i < harmonicCount; i++) {
    const h = harmonics[i];
    if (!h) {
      continue;
    }
    const offset = i * OSC_PARAMS_PER_OSCILLATOR;

    const freqBaseNorm = normalize(
      h.frequency,
      oscConfigNormales.freqBase.min,
      oscConfigNormales.freqBase.max,
    );
    const freqStartNorm = freqBaseNorm;
    // FFT gives phase for cos(ωt + φ). Oscillator uses sin(ωt + phase).
    // cos(ωt + φ) = sin(ωt + φ + π/2), so oscillatorPhase = fft_phase + π/2
    const oscPhase = h.phase + Math.PI / 2;
    const wrapped =
      ((oscPhase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const phaseNorm = normalize(
      wrapped,
      oscConfigNormales.phase.min,
      oscConfigNormales.phase.max,
    );

    // Magnitude -> amplitude envelope start level
    // Normalize magnitudes relative to the strongest harmonic, then scale down
    // to avoid destructive initialization (optimizer should grow from here)
    const maxMag = Math.max(
      ...harmonics.map((x) => x?.magnitude ?? 0),
    );
    const relAmp = h.magnitude / maxMag;
    const scaledAmp = relAmp * 0.15; // Start at 15% max, let optimizer grow
    const startLevelNorm = normalize(
      scaledAmp,
      ampEnvConfigNormales.startLevel.min,
      ampEnvConfigNormales.startLevel.max,
    );

    // Freq env slope -> flat (1.0), amplitude env slope -> flat
    const slopeNorm = normalize(
      1.0,
      oscConfigNormales.slope.min,
      oscConfigNormales.slope.max,
    );
    const ampEnvSlopeNorm = normalize(
      1.0,
      ampEnvConfigNormales.slope.min,
      ampEnvConfigNormales.slope.max,
    );

    // End level = start level for flat amplitude envelope (no decay)
    // This keeps the oscillator at full amplitude throughout the signal
    const endLevelNorm = startLevelNorm;

    vector[offset] = 1;
    vector[offset + 1] = freqBaseNorm;
    vector[offset + 2] = freqStartNorm;
    vector[offset + 3] = slopeNorm;
    vector[offset + 4] = freqEnvDurationNorm;
    vector[offset + 5] = phaseNorm;
    vector[offset + 6] = ampEnvDurationNorm;
    vector[offset + 7] = endLevelNorm;
    vector[offset + 8] = ampEnvSlopeNorm;
    vector[offset + 9] = startLevelNorm;

    console.log(
      `  Osc[${i}]: freq=${h.frequency.toFixed(0)}Hz phase=${h.phase.toFixed(2)} startLevelNorm=${startLevelNorm.toFixed(3)} phaseNorm=${phaseNorm.toFixed(3)} freqNorm=${freqBaseNorm.toFixed(3)}`,
    );
  }

  return vector;
};
