import {
  MAX_OSCILLATORS,
  OSC_PARAMS_PER_OSCILLATOR,
  oscConfigNormales,
  ampEnvConfigNormales,
} from './synth';
import { SAMPLE_LENGTH_IN_SECONDS, SAMPLE_RATE } from './consts';
import {
  stftAnalyze,
  clusterHarmonics,
  fitOscEnvelopes,
  type HarmonicOscParams,
  type HarmonicTrajectory,
} from './spectrogram';
import {
  estimateFundamentalFreq,
  computeAmplitudeEnvelope,
} from './signal-analysis';

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
 * Find the trajectory closest to a target frequency.
 */
const findTrajectoryNearFreq = (
  oscParams: HarmonicOscParams[],
  targetFreq: number,
  toleranceHz: number = 100,
): HarmonicOscParams | null => {
  let best: HarmonicOscParams | null = null;
  let bestDist = Infinity;

  for (const param of oscParams) {
    const dist = Math.abs(param.freqBase - targetFreq);
    if (dist < toleranceHz && dist < bestDist) {
      bestDist = dist;
      best = param;
    }
  }

  return best;
};

export const stftInitVector = (
  samples: Int16Array,
  sampleRate: number,
  maxOscillators: number = MAX_OSCILLATORS,
): number[] => {
  const fundamentalFromAuto = estimateFundamentalFreq(
    samples,
    sampleRate,
    50,
    5000,
  );
  const ampEnv = computeAmplitudeEnvelope(
    samples,
    sampleRate,
    1024,
    256,
  );

  if (ampEnv.length === 0) {
    console.log(
      'Signal analysis: no amplitude envelope, returning zero vector',
    );
    return new Array(maxOscillators * OSC_PARAMS_PER_OSCILLATOR).fill(
      0,
    );
  }

  console.log(
    `  Amp range: ${ampEnv[0]?.rms.toFixed(0)} → ${ampEnv[ampEnv.length - 1]?.rms.toFixed(0)}`,
  );

  // STFT analysis for frequency tracking
  const windowSize = 2048;
  const hopSize = 512;
  const maxPeaksPerFrame = 20;

  const frames = stftAnalyze({
    samples,
    sampleRate,
    windowSize,
    hopSize,
    maxPeaksPerFrame,
  });

  const trajectories = clusterHarmonics(frames, 150);

  const signalDuration = SAMPLE_LENGTH_IN_SECONDS;
  const oscParams: HarmonicOscParams[] = [];

  for (const traj of trajectories) {
    const params = fitOscEnvelopes(traj, sampleRate, signalDuration);
    if (params) {
      oscParams.push(params);
    }
  }

  oscParams.sort((a, b) => b.avgMagnitude - a.avgMagnitude);

  // Build oscillators
  const oscillators: {
    freqBase: number;
    freqStart: number;
    phase: number;
    startLevel: number;
    endLevel: number;
    avgMagnitude: number;
  }[] = [];

  // Main oscillator: prefer STFT trajectory near fundamental, fallback to autocorrelation
  const firstAmpRms = ampEnv[0]?.rms ?? 16384;
  const lastAmpRms = ampEnv[ampEnv.length - 1]?.rms ?? 100;
  const fundamental = fundamentalFromAuto ?? 440;

  const mainTraj = findTrajectoryNearFreq(
    oscParams,
    fundamental,
    fundamental * 0.3,
  );

  let mainFreqBase: number;
  let mainFreqStart: number;
  let mainPhase: number;

  if (mainTraj) {
    mainFreqBase = mainTraj.freqBase;
    mainFreqStart = mainTraj.freqStart;
    mainPhase = mainTraj.phase;
    console.log(
      `  Main osc from STFT: ${mainFreqBase.toFixed(0)} → ${mainFreqStart.toFixed(0)} Hz`,
    );
  } else {
    mainFreqBase = fundamental;
    mainFreqStart = fundamental;
    mainPhase = 0;
    console.log(
      `  Main osc from autocorrelation: ${mainFreqBase.toFixed(0)} Hz (no STFT trajectory)`,
    );
  }

  console.log(
    `  Amp: ${firstAmpRms.toFixed(0)} → ${lastAmpRms.toFixed(0)}`,
  );

  oscillators.push({
    freqBase: mainFreqBase,
    freqStart: mainFreqStart,
    phase: mainPhase,
    startLevel: firstAmpRms,
    endLevel: lastAmpRms,
    avgMagnitude: firstAmpRms,
  });

  // Harmonics: integer multiples of fundamental with sufficient energy
  const MAX_HARMONIC_RATIO = 10;
  const HARMONIC_TOLERANCE = 0.08;
  const MIN_ENERGY_RATIO = 0.03;

  const mainOscForEnergy = oscillators[0]!;

  for (const param of oscParams) {
    if (oscillators.length >= maxOscillators) break;

    const ratio = param.freqBase / fundamental;
    const roundedRatio = Math.round(ratio);
    const isIntegerMultiple =
      roundedRatio > 1 &&
      roundedRatio <= MAX_HARMONIC_RATIO &&
      Math.abs(ratio - roundedRatio) < HARMONIC_TOLERANCE;

    const hasEnoughEnergy =
      param.avgMagnitude >
      mainOscForEnergy.avgMagnitude * MIN_ENERGY_RATIO;

    if (isIntegerMultiple && hasEnoughEnergy) {
      console.log(
        `  Harmonic ${roundedRatio}x: freq ${param.freqBase.toFixed(0)} Hz (ratio=${ratio.toFixed(2)})`,
      );
      oscillators.push({
        freqBase: param.freqBase,
        freqStart: param.freqStart,
        phase: param.phase,
        startLevel: param.avgMagnitude,
        endLevel: param.avgMagnitude * 0.1,
        avgMagnitude: param.avgMagnitude,
      });
    }
  }

  if (oscillators.length === 1) {
    console.log(
      '  No valid STFT harmonics found, using only main oscillator',
    );
  }

  const mainOsc = oscillators[0];
  if (!mainOsc) {
    console.log('No oscillators detected, returning zero vector');
    return new Array(maxOscillators * OSC_PARAMS_PER_OSCILLATOR).fill(
      0,
    );
  }

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

  for (
    let i = 0;
    i < Math.min(oscillators.length, maxOscillators);
    i++
  ) {
    const osc = oscillators[i];
    if (!osc) continue;
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

    const oscPhase = osc.phase + Math.PI / 2;
    const wrapped =
      ((oscPhase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const phaseNorm = normalize(
      wrapped,
      oscConfigNormales.phase.min,
      oscConfigNormales.phase.max,
    );

    const relAmp = osc.avgMagnitude / mainOsc.avgMagnitude;
    const startLevelNorm = normalize(
      Math.min(relAmp * 0.9, 0.95),
      ampEnvConfigNormales.startLevel.min,
      ampEnvConfigNormales.startLevel.max,
    );
    const endLevelNorm = normalize(
      Math.max(
        relAmp * 0.05,
        ampEnvConfigNormales.endLevel.min * 1.1,
      ),
      ampEnvConfigNormales.endLevel.min,
      ampEnvConfigNormales.endLevel.max,
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

    vector[offset] = 1;
    vector[offset + 1] = Math.max(0, Math.min(1, freqBaseNorm));
    vector[offset + 2] = Math.max(0, Math.min(1, freqStartNorm));
    vector[offset + 3] = Math.max(0, Math.min(1, slopeNorm));
    vector[offset + 4] = Math.max(
      0,
      Math.min(1, freqEnvDurationNorm),
    );
    vector[offset + 5] = Math.max(0, Math.min(1, phaseNorm));
    vector[offset + 6] = Math.max(0, Math.min(1, ampEnvDurationNorm));
    vector[offset + 7] = Math.max(0, Math.min(1, endLevelNorm));
    vector[offset + 8] = Math.max(0, Math.min(1, ampEnvSlopeNorm));
    vector[offset + 9] = Math.max(0, Math.min(1, startLevelNorm));

    console.log(
      `Osc[${i}]: ${osc.freqBase.toFixed(0)}→${osc.freqStart.toFixed(0)}Hz amp_norm=${startLevelNorm.toFixed(3)}→${endLevelNorm.toFixed(3)} phaseNorm=${phaseNorm.toFixed(3)}`,
    );
  }

  return vector;
};
