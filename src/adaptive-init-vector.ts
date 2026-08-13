import {
  MAX_OSCILLATORS,
  OSC_PARAMS_PER_OSCILLATOR,
  oscConfigNormales,
  ampEnvConfigNormales,
} from './synth';
import { SAMPLE_LENGTH_IN_SECONDS, SAMPLE_RATE } from './consts';
import {
  estimateFundamentalFreq,
  computeAmplitudeEnvelope,
  estimateFreqOverTime,
} from './signal-analysis';
import {
  stftAnalyze,
  clusterHarmonics,
  fitOscEnvelopes,
} from './spectrogram';

const normalize = (
  value: number,
  min: number,
  max: number,
): number => {
  if (max === min) return 0.5;
  const clamped = Math.max(min, Math.min(max, value));
  return (clamped - min) / (max - min);
};

/**
 * Analyze the signal for "closely spaced tones" (beats) using amplitude modulation.
 * If amplitude envelope shows strong modulation, likely two tones are close.
 */
const estimateCloseTones = (
  freqOverTime: { timeSeconds: number; freq: number }[],
  ampEnv: { timeSeconds: number; rms: number }[],
  estimatedFreq: number,
):
  | { freqBase: number; freqStart: number; phaseOffset: number }[]
  | null => {
  if (ampEnv.length < 4) return null;

  const rmsValues = ampEnv.map((e) => e.rms);
  const avgRms =
    rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
  const maxRms = Math.max(...rmsValues);
  const minRms = Math.min(...rmsValues);

  // Amplitude modulation ratio: if > 2x, likely beats from close tones
  const modulationRatio = maxRms / Math.max(minRms, 1);

  if (modulationRatio < 1.5) return null; // No strong beats

  // Estimate beat frequency from zero-crossings of amplitude envelope
  let beatCrossings = 0;
  for (let i = 1; i < rmsValues.length; i++) {
    const prev = (rmsValues[i - 1] ?? avgRms) - avgRms;
    const curr = (rmsValues[i] ?? avgRms) - avgRms;
    if (prev * curr < 0) beatCrossings++;
  }

  const lastEntry = ampEnv[ampEnv.length - 1];
  const firstEntry = ampEnv[0];
  const duration =
    lastEntry && firstEntry
      ? lastEntry.timeSeconds - firstEntry.timeSeconds
      : 0.5;
  const beatFreq = beatCrossings / (2 * duration);

  // Two tones separated by beat_freq Hz
  const tone1Freq = estimatedFreq - beatFreq / 2;
  const tone2Freq = estimatedFreq + beatFreq / 2;

  if (tone1Freq < 20 || tone2Freq > 20000) return null;

  console.log(
    `  Beats detected: modulation=${modulationRatio.toFixed(2)}x, beat_freq=${beatFreq.toFixed(1)} Hz`,
  );

  return [
    { freqBase: tone1Freq, freqStart: tone1Freq, phaseOffset: 0 },
    {
      freqBase: tone2Freq,
      freqStart: tone2Freq,
      phaseOffset: Math.PI,
    },
  ];
};

const DEFAULT_OSCILLATOR_LIMIT = 10;

export const adaptiveInitVector = (
  samples: Int16Array,
  sampleRate: number,
  maxOscillators: number = DEFAULT_OSCILLATOR_LIMIT,
): number[] => {
  const freqOverTime = estimateFreqOverTime(samples, sampleRate);
  const ampEnv = computeAmplitudeEnvelope(
    samples,
    sampleRate,
    1024,
    256,
  );

  if (freqOverTime.length === 0 || ampEnv.length === 0) {
    console.log('Signal analysis: no data, returning zero vector');
    return new Array(maxOscillators * OSC_PARAMS_PER_OSCILLATOR).fill(
      0,
    );
  }

  const firstAmp = ampEnv[0]?.rms ?? 16384;
  const lastAmp = ampEnv[ampEnv.length - 1]?.rms ?? 100;

  // STFT analysis for distinct spectral components
  const frames = stftAnalyze({
    samples,
    sampleRate,
    windowSize: 2048,
    hopSize: 512,
    maxPeaksPerFrame: 30,
  });

  const trajectories = clusterHarmonics(frames, 100);

  const signalDuration = SAMPLE_LENGTH_IN_SECONDS;
  type FitResult = NonNullable<ReturnType<typeof fitOscEnvelopes>>;
  const oscParams: FitResult[] = [];

  for (const traj of trajectories) {
    const params = fitOscEnvelopes(traj, sampleRate, signalDuration);
    if (params) {
      oscParams.push(params);
    }
  }

  oscParams.sort((a, b) => b.avgMagnitude - a.avgMagnitude);

  // Collect all enabled oscillators
  type OscInit = {
    freqBase: number;
    freqStart: number;
    phase: number;
    relAmp: number;
  };
  const oscInitList: OscInit[] = [];

  // Check for close tones (beats) in the fundamental
  const estimatedFreq =
    freqOverTime.reduce((sum, e) => sum + e.freq, 0) /
    freqOverTime.length;
  const closeTones = estimateCloseTones(
    freqOverTime,
    ampEnv,
    estimatedFreq,
  );

  if (closeTones && oscParams.length > 0) {
    // Found beats: use close tones instead of the main STFT component
    console.log(
      `  Using beat-based split for fundamental (~${estimatedFreq.toFixed(0)} Hz)`,
    );
    const mainMag = oscParams[0]?.avgMagnitude ?? 1;

    // Replace the first STFT component with two close tones
    oscInitList.push({
      freqBase: closeTones[0]!.freqBase,
      freqStart: closeTones[0]!.freqStart,
      phase: closeTones[0]!.phaseOffset,
      relAmp: 0.5,
    });
    oscInitList.push({
      freqBase: closeTones[1]!.freqBase,
      freqStart: closeTones[1]!.freqStart,
      phase: closeTones[1]!.phaseOffset,
      relAmp: 0.5,
    });

    // Add other STFT components (harmonics, etc.) minus the fundamental
    for (const param of oscParams.slice(1)) {
      if (oscInitList.length >= maxOscillators) break;
      const relMag = param.avgMagnitude / mainMag;
      oscInitList.push({
        freqBase: param.freqBase,
        freqStart: param.freqStart,
        phase: param.phase,
        relAmp: relMag,
      });
    }
  } else {
    // No beats: use STFT components directly
    const maxMag = oscParams[0]?.avgMagnitude ?? 0;
    const energyThreshold = maxMag * 0.05;
    const validParams = oscParams.filter(
      (p) => p.avgMagnitude >= energyThreshold,
    );

    for (const param of validParams) {
      if (oscInitList.length >= maxOscillators) break;
      const relMag = param.avgMagnitude / maxMag;
      oscInitList.push({
        freqBase: param.freqBase,
        freqStart: param.freqStart,
        phase: param.phase,
        relAmp: relMag,
      });
    }

    // Fallback: if no STFT components, use freqOverTime average
    if (oscInitList.length === 0) {
      oscInitList.push({
        freqBase: estimatedFreq,
        freqStart:
          freqOverTime[freqOverTime.length - 1]?.freq ??
          estimatedFreq,
        phase: 0,
        relAmp: 1,
      });
      console.log(
        `  No STFT components, using freq average: ${estimatedFreq.toFixed(0)} Hz`,
      );
    }
  }

  const numOscillators = oscInitList.length;
  console.log(`  Enabling ${numOscillators} oscillators`);
  console.log(
    `  Amp (RMS): ${firstAmp.toFixed(0)} → ${lastAmp.toFixed(0)}`,
  );

  // Global amplitude envelope for scaling
  const maxPossibleRms = 32767 / Math.sqrt(2);
  const globalStartLevel = Math.min(firstAmp / maxPossibleRms, 0.95);
  const globalEndLevel = Math.max(
    lastAmp / maxPossibleRms,
    ampEnvConfigNormales.endLevel.min,
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
  const slopeNorm = normalize(
    0.8,
    oscConfigNormales.slope.min,
    oscConfigNormales.slope.max,
  );
  const ampEnvSlopeNorm = normalize(
    0.8,
    ampEnvConfigNormales.slope.min,
    ampEnvConfigNormales.slope.max,
  );

  const totalRelAmp = oscInitList.reduce(
    (sum, o) => sum + o.relAmp,
    0,
  );

  for (let i = 0; i < numOscillators; i++) {
    const osc = oscInitList[i]!;
    const offset = i * OSC_PARAMS_PER_OSCILLATOR;

    const freqBaseNorm = normalize(
      osc.freqBase,
      oscConfigNormales.freqBase.min,
      oscConfigNormales.freqBase.max,
    );
    const freqStartNorm = normalize(
      osc.freqStart,
      oscConfigNormales.freqStart.min,
      oscConfigNormales.freqStart.max,
    );
    const phaseNorm = normalize(
      (((osc.phase + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) %
        (2 * Math.PI),
      oscConfigNormales.phase.min,
      oscConfigNormales.phase.max,
    );

    // Amplitude proportional to relative contribution
    const relMag =
      totalRelAmp > 0 ? osc.relAmp / totalRelAmp : 1 / numOscillators;
    const oscStartLevel = Math.min(
      globalStartLevel * relMag * numOscillators,
      0.95,
    );
    const oscEndLevel = Math.max(
      globalEndLevel * relMag * numOscillators,
      ampEnvConfigNormales.endLevel.min,
    );

    const startLevelNorm = normalize(
      oscStartLevel,
      ampEnvConfigNormales.startLevel.min,
      ampEnvConfigNormales.startLevel.max,
    );
    const endLevelNorm = normalize(
      oscEndLevel,
      ampEnvConfigNormales.endLevel.min,
      ampEnvConfigNormales.endLevel.max,
    );

    vector[offset] = 1;
    vector[offset + 1] = Math.max(0, Math.min(1, freqBaseNorm));
    vector[offset + 2] = Math.max(0, Math.min(1, freqStartNorm));
    vector[offset + 3] = slopeNorm;
    vector[offset + 4] = freqEnvDurationNorm;
    vector[offset + 5] = phaseNorm;
    vector[offset + 6] = ampEnvDurationNorm;
    vector[offset + 7] = endLevelNorm;
    vector[offset + 8] = ampEnvSlopeNorm;
    vector[offset + 9] = startLevelNorm;

    console.log(
      `Osc[${i}]: ${osc.freqBase.toFixed(0)}→${osc.freqStart.toFixed(0)}Hz amp_norm=${startLevelNorm.toFixed(3)}→${endLevelNorm.toFixed(3)} relAmp=${relMag.toFixed(3)}`,
    );
  }

  return vector;
};
