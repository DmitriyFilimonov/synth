/* eslint-disable no-console */
import {
  MAX_OSCILLATORS,
  OSC_PARAMS_PER_OSCILLATOR,
  oscConfigNormales,
  ampEnvConfigNormales,
} from './synth';

const normalize = (
  value: number,
  min: number,
  max: number,
): number => {
  if (max === min) {
    return 0.5;
  }
  const clamped = Math.max(min, Math.min(max, value));
  return (clamped - min) / (max - min);
};

/**
 * Compute Goertzel amplitude/phase for a single frequency over the
 * given sample window. Uses direct DFT projection (correct phase for
 * non-integer bin indices).
 *
 * @param samples - Windowed sample data (int16 or number[])
 * @param sampleRate - Sample rate in Hz
 * @param freq - Frequency to probe, in Hz
 * @returns Amplitude (in same units as samples) and phase (radians,
 *   `sin(ωt + phase)` convention)
 */
const projectFrequency = (
  samples: ArrayLike<number>,
  sampleRate: number,
  freq: number,
): { amplitude: number; phase: number } => {
  const n = samples.length;
  if (n === 0) {
    return { amplitude: 0, phase: 0 };
  }
  let re = 0;
  let im = 0;
  const twoPiFOverSr = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < n; i++) {
    const angle = twoPiFOverSr * i;
    const s = samples[i] ?? 0;
    re += s * Math.cos(angle);
    im -= s * Math.sin(angle);
  }
  re /= n;
  im /= n;
  const amplitude = Math.sqrt(re * re + im * im) * 2;
  // cos(ωt + φ_cos) = sin(ωt + φ_cos + π/2), so oscillator phase =
  // atan2(im, re) + π/2 for our sin(ωt + phase) convention.
  const cosPhase = Math.atan2(im, re);
  const phase = cosPhase + Math.PI / 2;
  return { amplitude, phase };
};

/**
 * Scan a frequency range with fine resolution using Goertzel-style DFT
 * projection, returning local peaks (freq where amplitude is greater
 * than both neighbors).
 *
 * @param samples - Windowed sample data
 * @param sampleRate - Sample rate in Hz
 * @param minHz - Lower bound of scan (inclusive)
 * @param maxHz - Upper bound of scan (inclusive)
 * @param resolutionHz - Step between scan frequencies
 * @returns Local peaks sorted by descending amplitude
 */
const scanPeaks = (
  samples: ArrayLike<number>,
  sampleRate: number,
  minHz: number,
  maxHz: number,
  resolutionHz: number,
): Array<{ frequency: number; amplitude: number; phase: number }> => {
  const scanned: Array<{
    frequency: number;
    amplitude: number;
    phase: number;
  }> = [];
  for (let f = minHz; f <= maxHz; f += resolutionHz) {
    const { amplitude, phase } = projectFrequency(
      samples,
      sampleRate,
      f,
    );
    scanned.push({ frequency: f, amplitude, phase });
  }

  const peaks: typeof scanned = [];
  for (let i = 1; i < scanned.length - 1; i++) {
    const prev = scanned[i - 1]!;
    const cur = scanned[i]!;
    const next = scanned[i + 1]!;
    if (
      cur.amplitude > prev.amplitude &&
      cur.amplitude > next.amplitude
    ) {
      peaks.push(cur);
    }
  }
  // Sort by amplitude descending.
  peaks.sort((a, b) => b.amplitude - a.amplitude);
  return peaks;
};

/**
 * Enforce minimum frequency separation between peaks: greedy pick from
 * amplitude-sorted list, skipping any peak within `minSeparationHz`
 * of an already-picked one.
 */
const enforceSeparation = <
  T extends { frequency: number; amplitude: number },
>(
  peaks: readonly T[],
  minSeparationHz: number,
  maxCount: number,
): T[] => {
  const out: T[] = [];
  for (const p of peaks) {
    if (out.length >= maxCount) {
      break;
    }
    const tooClose = out.some(
      (r) => Math.abs(r.frequency - p.frequency) < minSeparationHz,
    );
    if (!tooClose) {
      out.push(p);
    }
  }
  return out;
};

/**
 * Compute effective (non-silent) signal duration in seconds: earliest
 * time at which windowed RMS falls below `AMP_TAIL_RATIO * maxRms`.
 * Used to size sustained-oscillator envelopes correctly for decaying
 * targets (drum hits, plucks).
 */
const computeEffectiveDuration = (
  samples: ArrayLike<number>,
  sampleRate: number,
): number => {
  const WINDOW = 1024;
  const HOP = 256;
  const AMP_TAIL_RATIO = 0.05;
  const rmsValues: number[] = [];
  for (
    let start = 0;
    start + WINDOW <= samples.length;
    start += HOP
  ) {
    let sumSq = 0;
    for (let i = start; i < start + WINDOW; i++) {
      const s = samples[i] ?? 0;
      sumSq += s * s;
    }
    rmsValues.push(Math.sqrt(sumSq / WINDOW));
  }
  if (rmsValues.length === 0) {
    return samples.length / sampleRate;
  }
  const maxRms = Math.max(...rmsValues);
  const threshold = Math.max(maxRms * AMP_TAIL_RATIO, 8);
  for (let i = 0; i < rmsValues.length; i++) {
    if ((rmsValues[i] ?? 0) < threshold) {
      const tSec = (i * HOP + WINDOW) / sampleRate;
      return Math.max(tSec, 0.05);
    }
  }
  return samples.length / sampleRate;
};

interface OscInit {
  freqBase: number;
  freqStart: number;
  phase: number;
  amplitude: number; // peak amplitude in int16 scale
  ampEnvDurationSec: number;
  ampEnvSlope: number;
  kind: 'sustain' | 'transient';
}

const SUSTAIN_MIN_HZ = 20;
const SUSTAIN_MAX_HZ = 5000;
const SUSTAIN_RES_HZ = 2;
const SUSTAIN_MIN_SEPARATION_HZ = 8;

const TRANSIENT_WINDOW_MS = 20;
const TRANSIENT_MIN_HZ = 200;
const TRANSIENT_MAX_HZ = 15000;
const TRANSIENT_RES_HZ = 50;
const TRANSIENT_MIN_SEPARATION_HZ = 100;

// Minimum amplitude ratio (relative to strongest peak in the same
// scan) below which a peak is considered noise, not signal.
const AMP_NOISE_RATIO = 0.02;

// Fraction of oscillator budget devoted to sustain vs transient.
// Sustain gets priority — most target energy is in sustained tones.
const SUSTAIN_BUDGET_FRACTION = 0.6;

/**
 * Build an initial vector for the optimizer via dual-window spectral
 * analysis of the target signal:
 *
 * 1. **Sustain scan**: Goertzel scan of the full signal at fine
 *    resolution over 20–5000 Hz. Detected peaks receive long-duration
 *    oscillators with near-linear amplitude envelopes — these voice
 *    the sustained harmonic content that dominates most musical
 *    targets.
 * 2. **Transient scan**: Goertzel scan of the first ~20 ms of the
 *    signal over 200–15000 Hz. Detected peaks (not already covered by
 *    a nearby sustain peak) receive short-duration oscillators with
 *    steep decay envelopes — these voice the attack transient without
 *    leaking into the sustained region.
 *
 * The oscillator budget is split ~60/40 between sustain and transient;
 * unused slots migrate to the other pool. Per-oscillator amplitudes
 * are calibrated so the initial synth RMS approximately matches the
 * target RMS.
 *
 * @param samples - Target signal samples (int16)
 * @param sampleRate - Sample rate in Hz
 * @param maxOscillators - Total oscillator budget (default MAX_OSCILLATORS)
 * @returns Normalized parameter vector of length
 *   `maxOscillators * OSC_PARAMS_PER_OSCILLATOR`
 */
export const dualWindowInitVector = (
  samples: Int16Array,
  sampleRate: number,
  maxOscillators: number = MAX_OSCILLATORS,
): number[] => {
  const totalSamples = samples.length;
  const effectiveDurationSec = computeEffectiveDuration(
    samples,
    sampleRate,
  );

  // ==============================
  // 1. Sustain scan (full signal)
  // ==============================
  const sustainSamples = samples;
  const sustainPeaks = scanPeaks(
    sustainSamples,
    sampleRate,
    SUSTAIN_MIN_HZ,
    SUSTAIN_MAX_HZ,
    SUSTAIN_RES_HZ,
  );
  const sustainMaxAmp = sustainPeaks[0]?.amplitude ?? 0;
  const sustainFiltered = sustainPeaks.filter(
    (p) => p.amplitude > sustainMaxAmp * AMP_NOISE_RATIO,
  );

  // ==============================
  // 2. Transient scan (first 20 ms)
  // ==============================
  const transientLen = Math.min(
    Math.floor((TRANSIENT_WINDOW_MS / 1000) * sampleRate),
    totalSamples,
  );
  const transientSamples = samples.subarray(0, transientLen);
  const transientPeaks = scanPeaks(
    transientSamples,
    sampleRate,
    TRANSIENT_MIN_HZ,
    TRANSIENT_MAX_HZ,
    TRANSIENT_RES_HZ,
  );
  const transientMaxAmp = transientPeaks[0]?.amplitude ?? 0;
  const transientFiltered = transientPeaks.filter(
    (p) => p.amplitude > transientMaxAmp * AMP_NOISE_RATIO,
  );

  // ==============================
  // 3. Budget allocation
  // ==============================
  const sustainBudget = Math.floor(
    maxOscillators * SUSTAIN_BUDGET_FRACTION,
  );
  const transientBudget = maxOscillators - sustainBudget;

  const sustainSeparated = enforceSeparation(
    sustainFiltered,
    SUSTAIN_MIN_SEPARATION_HZ,
    sustainBudget,
  );

  // Exclude transient peaks that overlap with sustain peaks (a
  // sustain oscillator already covers this frequency).
  const sustainFreqs = sustainSeparated.map((p) => p.frequency);
  const transientNonOverlap = transientFiltered.filter((tp) => {
    return !sustainFreqs.some(
      (sf) =>
        Math.abs(sf - tp.frequency) < TRANSIENT_MIN_SEPARATION_HZ,
    );
  });
  const transientSeparated = enforceSeparation(
    transientNonOverlap,
    TRANSIENT_MIN_SEPARATION_HZ,
    transientBudget,
  );

  // Migrate unused slots between pools.
  const sustainUnused = sustainBudget - sustainSeparated.length;
  const transientUnused = transientBudget - transientSeparated.length;

  let extraSustain: typeof sustainSeparated = [];
  let extraTransient: typeof transientSeparated = [];
  if (
    sustainUnused > 0 &&
    transientNonOverlap.length > transientSeparated.length
  ) {
    // Give unused sustain slots to transient.
    const remaining = transientNonOverlap.filter(
      (p) => !transientSeparated.includes(p),
    );
    extraTransient = enforceSeparation(
      remaining,
      TRANSIENT_MIN_SEPARATION_HZ,
      sustainUnused,
    );
  }
  if (
    transientUnused > 0 &&
    sustainFiltered.length > sustainSeparated.length
  ) {
    // Give unused transient slots to sustain.
    const remaining = sustainFiltered.filter(
      (p) => !sustainSeparated.includes(p),
    );
    extraSustain = enforceSeparation(
      remaining,
      SUSTAIN_MIN_SEPARATION_HZ,
      transientUnused,
    );
  }

  const allSustain = [...sustainSeparated, ...extraSustain];
  const allTransient = [...transientSeparated, ...extraTransient];

  // ==============================
  // 4. Build OscInit list
  // ==============================
  const initList: OscInit[] = [];

  // Re-project sustain peaks on the FULL signal to get accurate
  // phase (they were detected on full signal already but we make it
  // explicit for consistency with transient re-projection).
  for (const p of allSustain) {
    initList.push({
      freqBase: p.frequency,
      freqStart: p.frequency,
      phase: p.phase,
      amplitude: p.amplitude,
      ampEnvDurationSec: effectiveDurationSec,
      ampEnvSlope: 0.8,
      kind: 'sustain',
    });
  }

  // For transient peaks, re-project on the transient window for
  // accurate phase (already done in scan). Duration = 2× transient
  // window (envelope decays to `min * startLevel` by t = duration,
  // ≈ -60 dB, effectively silent thereafter for RMS purposes).
  const transientDurationSec = (TRANSIENT_WINDOW_MS / 1000) * 2;
  for (const p of allTransient) {
    initList.push({
      freqBase: p.frequency,
      freqStart: p.frequency,
      phase: p.phase,
      amplitude: p.amplitude,
      ampEnvDurationSec: transientDurationSec,
      ampEnvSlope: 2.0,
      kind: 'transient',
    });
  }

  console.log(
    `Dual-window init: ${allSustain.length} sustain + ${allTransient.length} transient oscillators (effectiveDur=${effectiveDurationSec.toFixed(3)}s, transientDur=${transientDurationSec.toFixed(3)}s)`,
  );

  // ==============================
  // 5. Amplitude calibration
  // ==============================
  // Target: sum of oscillator RMS ≈ target signal RMS. For each osc,
  // amplitude in [0,1] range. Peak amplitude of a sinusoid A →
  // startLevel = A / 32768 (int16 scale).
  const targetMeanSq =
    Array.from(samples).reduce((sum, s) => sum + s * s, 0) /
    Math.max(samples.length, 1);
  const targetRms = Math.sqrt(targetMeanSq);

  // Global amp scale: prevent over-loud init. Match total osc RMS to
  // target RMS assuming incoherent sum (RMS_sum = sqrt(sum(A_i^2/2))).
  // Solve k such that sqrt(sum((k*A_i)^2 / 2)) = targetRms:
  // k = targetRms / sqrt(sum(A_i^2) / 2) = targetRms * sqrt(2) / sqrt(sum(A_i^2))
  const sumAmpSq = initList.reduce(
    (sum, o) => sum + o.amplitude * o.amplitude,
    0,
  );
  const globalAmpScale =
    sumAmpSq > 0
      ? (targetRms * Math.sqrt(2)) / Math.sqrt(sumAmpSq)
      : 1;
  // Fallback: if signal is near-silent, globalAmpScale can explode;
  // cap to keep init amplitudes physical.
  const safeScale = Math.min(globalAmpScale, 2.0);

  // ==============================
  // 6. Emit normalized vector
  // ==============================
  const vector = new Array<number>(
    maxOscillators * OSC_PARAMS_PER_OSCILLATOR,
  ).fill(0);

  // Freq envelope duration: whole signal (constant frequency).
  const freqEnvDurationNorm = normalize(
    effectiveDurationSec,
    oscConfigNormales.duration.min,
    oscConfigNormales.duration.max,
  );
  const slopeNorm = normalize(
    0.8,
    oscConfigNormales.slope.min,
    oscConfigNormales.slope.max,
  );

  for (
    let i = 0;
    i < Math.min(initList.length, maxOscillators);
    i++
  ) {
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

    const wrappedPhase =
      ((osc.phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const phaseNorm = normalize(
      wrappedPhase,
      oscConfigNormales.phase.min,
      oscConfigNormales.phase.max,
    );

    const ampEnvDurationNorm = normalize(
      osc.ampEnvDurationSec,
      ampEnvConfigNormales.duration.min,
      ampEnvConfigNormales.duration.max,
    );
    const ampEnvSlopeNorm = normalize(
      osc.ampEnvSlope,
      ampEnvConfigNormales.slope.min,
      ampEnvConfigNormales.slope.max,
    );

    // Start level (peak amplitude) in [0,1]. Amplitude is in int16 units.
    const startLevelRaw = (osc.amplitude * safeScale) / 32768;
    const startLevelClamped = Math.max(
      ampEnvConfigNormales.startLevel.min,
      Math.min(0.95, startLevelRaw),
    );
    const startLevelNorm = normalize(
      startLevelClamped,
      ampEnvConfigNormales.startLevel.min,
      ampEnvConfigNormales.startLevel.max,
    );

    // End level: for transient, near-zero (min); for sustain,
    // near-zero as well — realistic decay behavior for musical
    // targets. CD will tune this per-osc.
    const endLevelNorm = normalize(
      ampEnvConfigNormales.endLevel.min,
      ampEnvConfigNormales.endLevel.min,
      ampEnvConfigNormales.endLevel.max,
    );

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
      `  Osc[${i}] ${osc.kind}: ${osc.freqBase.toFixed(1)}Hz amp=${startLevelClamped.toFixed(4)} dur=${osc.ampEnvDurationSec.toFixed(3)}s slope=${osc.ampEnvSlope.toFixed(1)}`,
    );
  }

  return vector;
};
