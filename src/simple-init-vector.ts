import {
  MAX_OSCILLATORS,
  OSC_PARAMS_PER_OSCILLATOR,
  oscConfigNormales,
  ampEnvConfigNormales,
} from './synth';
import { SAMPLE_LENGTH_IN_SECONDS } from './consts';
import {
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

export const extractPhaseAndAmplitude = (
  samples: Int16Array | number[],
  sampleRate: number,
  freq: number,
): { phase: number; amplitude: number } => {
  const n = samples.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const angle = 2 * Math.PI * freq * t;
    re += (samples[i] ?? 0) * Math.cos(angle);
    im -= (samples[i] ?? 0) * Math.sin(angle);
  }
  re /= n;
  im /= n;
  return {
    phase: Math.atan2(im, re),
    amplitude: Math.sqrt(re * re + im * im) * 2,
  };
};

const goertzelSpectrum = (
  samples: number[],
  sampleRate: number,
  centerFreq: number,
  searchRange: number,
  resolution: number,
): { frequency: number; amplitude: number; phase: number }[] => {
  const candidates: {
    frequency: number;
    amplitude: number;
    phase: number;
  }[] = [];
  const startFreq = Math.max(centerFreq - searchRange, 20);
  const endFreq = centerFreq + searchRange;
  for (let freq = startFreq; freq <= endFreq; freq += resolution) {
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
    const amplitude = Math.sqrt(re * re + im * im) * 2;
    const phase = Math.atan2(im, re);
    candidates.push({ frequency: freq, amplitude, phase });
  }
  return candidates;
};

const findDominantFrequencies = (
  samples: number[],
  sampleRate: number,
  centerEstimate: number,
  count: number,
  searchRange: number = 50,
  resolution: number = 1,
): Array<{ frequency: number; amplitude: number; phase: number }> => {
  const spectrum = goertzelSpectrum(
    samples,
    sampleRate,
    centerEstimate,
    searchRange,
    resolution,
  );
  spectrum.sort((a, b) => b.amplitude - a.amplitude);

  const result: typeof spectrum = [];
  const minSeparation = 5;

  for (const peak of spectrum) {
    if (result.length >= count) break;
    const tooClose = result.some(
      (r) => Math.abs(r.frequency - peak.frequency) < minSeparation,
    );
    if (!tooClose && peak.amplitude > 1) {
      result.push(peak);
    }
  }

  return result.sort((a, b) => a.frequency - b.frequency);
};

const findDominantFrequenciesWide = (
  samples: number[],
  sampleRate: number,
  count: number,
  resolution: number = 2,
): Array<{ frequency: number; amplitude: number }> => {
  // Goertzel at multiple centers to cover wide range efficiently
  const centers = [200, 440, 660, 880, 1100, 1320, 1540, 1760];
  const searchRange = 100;

  const spectrum: Array<{ frequency: number; amplitude: number }> =
    [];
  const seen = new Set<number>();

  for (const center of centers) {
    const localSpectrum = goertzelSpectrum(
      samples,
      sampleRate,
      center,
      searchRange,
      resolution,
    );
    for (const peak of localSpectrum) {
      const roundedFreq = Math.round(peak.frequency);
      if (!seen.has(roundedFreq) && peak.amplitude > 1) {
        seen.add(roundedFreq);
        spectrum.push({
          frequency: peak.frequency,
          amplitude: peak.amplitude,
        });
      }
    }
  }

  spectrum.sort((a, b) => b.amplitude - a.amplitude);

  const result: typeof spectrum = [];
  const minSeparation = 5;

  for (const peak of spectrum) {
    if (result.length >= count) break;
    const tooClose = result.some(
      (r) => Math.abs(r.frequency - peak.frequency) < minSeparation,
    );
    if (!tooClose) {
      result.push(peak);
    }
  }

  return result.sort((a, b) => a.frequency - b.frequency);
};

type OscInit = {
  freqBase: number;
  freqStart: number;
  phase: number;
  relAmp: number;
  absAmplitude?: number;
};

export const simpleInitVector = (
  samples: Int16Array,
  sampleRate: number,
  maxOscillators: number = 5,
): number[] => {
  const freqOverTime = estimateFreqOverTime(samples, sampleRate);
  const ampEnv = computeAmplitudeEnvelope(
    samples,
    sampleRate,
    1024,
    256,
  );

  if (freqOverTime.length === 0 || ampEnv.length === 0) {
    return new Array(maxOscillators * OSC_PARAMS_PER_OSCILLATOR).fill(
      0,
    );
  }

  const estimatedFreq =
    freqOverTime.reduce((sum, e) => sum + e.freq, 0) /
    freqOverTime.length;

  const rmsValues = ampEnv.map((e) => e.rms);
  const avgRms =
    rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
  const maxRms = Math.max(...rmsValues);
  const minRms = Math.min(...rmsValues);
  const modulationRatio = maxRms / Math.max(minRms, 1);

  const sampleArray = Array.from(samples);
  const halfLen = Math.floor(samples.length / 2);
  const firstHalf = sampleArray.slice(0, halfLen);
  const secondHalf = sampleArray.slice(halfLen);

  let initList: OscInit[] = [];

  if (modulationRatio > 1.5 && rmsValues.length >= 4) {
    // Split into 4 quarters to track sweep from high to low
    const quarterLen = Math.floor(samples.length / 4);
    const firstQuarter = sampleArray.slice(0, quarterLen);
    const lastQuarter = sampleArray.slice(3 * quarterLen);

    // Find dominant frequencies in first quarter (higher sweep range)
    const firstPeaks = findDominantFrequenciesWide(
      firstQuarter,
      sampleRate,
      3,
    );
    // Find dominant frequencies in last quarter (lower sweep range)
    const lastPeaks = findDominantFrequenciesWide(
      lastQuarter,
      sampleRate,
      3,
    );

    // Match peaks between quarters: freq sweeps high→low
    const freqFirst1 = firstPeaks[0]?.frequency ?? estimatedFreq;
    const freqFirst2 = firstPeaks[1]?.frequency ?? estimatedFreq + 5;
    const freqLast1 = lastPeaks[0]?.frequency ?? estimatedFreq;
    const freqLast2 = lastPeaks[1]?.frequency ?? estimatedFreq + 5;

    const p1Full = extractPhaseAndAmplitude(
      samples,
      sampleRate,
      freqFirst1,
    );
    const p2Full = extractPhaseAndAmplitude(
      samples,
      sampleRate,
      freqFirst2,
    );

    const totalAmp = p1Full.amplitude + p2Full.amplitude;
    initList.push({
      freqBase: freqLast1,
      freqStart: freqFirst1,
      phase: p1Full.phase,
      relAmp: totalAmp > 0 ? p1Full.amplitude / totalAmp : 0.5,
      absAmplitude: p1Full.amplitude,
    });
    initList.push({
      freqBase: freqLast2,
      freqStart: freqFirst2,
      phase: p2Full.phase,
      relAmp: totalAmp > 0 ? p2Full.amplitude / totalAmp : 0.5,
      absAmplitude: p2Full.amplitude,
    });
    console.log(
      `  Beats: ~${freqFirst1.toFixed(0)}→${freqLast1.toFixed(0)} & ~${freqFirst2.toFixed(0)}→${freqLast2.toFixed(0)} Hz (modulation=${modulationRatio.toFixed(1)}x)`,
    );
    console.log(
      `  Phases: ${((p1Full.phase * 180) / Math.PI).toFixed(0)}° & ${((p2Full.phase * 180) / Math.PI).toFixed(0)}° amps=${p1Full.amplitude.toFixed(0)} ${p2Full.amplitude.toFixed(0)}`,
    );
  } else {
    const phaseInfo = extractPhaseAndAmplitude(
      samples,
      sampleRate,
      estimatedFreq,
    );
    const firstFreq = freqOverTime[0]?.freq ?? estimatedFreq;
    const lastFreq =
      freqOverTime[freqOverTime.length - 1]?.freq ?? estimatedFreq;
    initList.push({
      freqBase: lastFreq,
      freqStart: firstFreq,
      phase: phaseInfo.phase,
      relAmp: 1,
    });
    console.log(
      `  Single tone: ~${estimatedFreq.toFixed(0)} Hz (${firstFreq.toFixed(0)}→${lastFreq.toFixed(0)} Hz), phase=${((phaseInfo.phase * 180) / Math.PI).toFixed(0)}°`,
    );
  }

  if (initList.length < maxOscillators) {
    const frames = stftAnalyze({
      samples,
      sampleRate,
      windowSize: 2048,
      hopSize: 512,
      maxPeaksPerFrame: 20,
    });
    const trajectories = clusterHarmonics(frames, 100);
    const signalDuration = SAMPLE_LENGTH_IN_SECONDS;

    const oscParams: NonNullable<
      ReturnType<typeof fitOscEnvelopes>
    >[] = [];
    for (const traj of trajectories) {
      const p = fitOscEnvelopes(traj, sampleRate, signalDuration);
      if (p) oscParams.push(p);
    }
    oscParams.sort((a, b) => b.avgMagnitude - a.avgMagnitude);

    const maxStftMag =
      oscParams.length > 0 ? oscParams[0]!.avgMagnitude : 1;

    const mainMag = initList[0]!.relAmp || 1;
    for (const param of oscParams) {
      if (initList.length >= maxOscillators) break;
      const ratio = param.freqBase / estimatedFreq;
      const rounded = Math.round(ratio);
      const isHarmonic =
        rounded > 1 && Math.abs(ratio - rounded) < 0.08;
      const hasEnergy =
        param.avgMagnitude > mainMag * 0.05 &&
        param.freqBase > 200 &&
        param.freqBase < 15000;
      if (isHarmonic || hasEnergy) {
        const scaledMag = (param.avgMagnitude / maxStftMag) * 0.3;
        initList.push({
          freqBase: param.freqBase,
          freqStart: param.freqStart,
          phase: param.phase,
          relAmp: scaledMag,
        });
      }
    }
  }

  initList = initList.slice(0, maxOscillators);
  console.log(
    `  Enabled: ${initList.length} oscillators (max=${maxOscillators})`,
  );

  const meanSq =
    samples.reduce((sum, s) => sum + s * s, 0) / samples.length;
  const targetSignalRms = Math.sqrt(meanSq);
  const numOsc = initList.length;

  const totalExtractedAmp = initList.reduce(
    (sum, osc) => sum + (osc.absAmplitude ?? 0),
    0,
  );

  const rmsReduction = 0.284;

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
    oscConfigNormales.slope.max,
  );

  for (let i = 0; i < initList.length; i++) {
    const osc = initList[i]!;
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
    const phaseIn0To2PI =
      ((osc.phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const phaseNorm = normalize(
      phaseIn0To2PI,
      oscConfigNormales.phase.min,
      oscConfigNormales.phase.max,
    );

    const extractedAmp = osc.absAmplitude ?? 0;
    const oscProportion =
      totalExtractedAmp > 0
        ? extractedAmp / totalExtractedAmp
        : 1 / numOsc;

    const oscRmsEach = targetSignalRms * Math.sqrt(oscProportion);
    const oscStart = Math.min(
      Math.max(
        (oscRmsEach * Math.sqrt(2)) / 32767 / rmsReduction,
        ampEnvConfigNormales.startLevel.min,
      ),
      0.95,
    );
    const oscEnd = ampEnvConfigNormales.endLevel.min;

    vector[offset] = 1;
    vector[offset + 1] = freqBaseNorm;
    vector[offset + 2] = freqStartNorm;
    vector[offset + 3] = slopeNorm;
    vector[offset + 4] = freqEnvDurationNorm;
    vector[offset + 5] = phaseNorm;
    vector[offset + 6] = ampEnvDurationNorm;
    vector[offset + 7] = oscEnd;
    vector[offset + 8] = ampEnvSlopeNorm;
    vector[offset + 9] = oscStart;

    console.log(
      `Osc[${i}]: ${osc.freqStart.toFixed(0)}→${osc.freqBase.toFixed(0)}Hz amp=${oscStart.toFixed(3)}→${oscEnd.toFixed(3)}`,
    );
  }

  return vector;
};
