export const SAMPLE_RATE = 44100;
export const SAMPLE_LENGTH_IN_SECONDS = 0.5;
export const MAX_AMPLITUDE_16_BIT_WAV_ENCODED = 32767;

// Minimum amplitude for any oscillator during optimization (shared constant).
// Kept below the prune threshold so `clampVolume` doesn't clip startLevel
// against the prune bar (which would make the prune check misfire).
export const VOLUME_MIN = 0.001;
// Threshold below which an oscillator is considered silent and may be pruned.
// Lowered from 0.02 (−34 dB) to 0.005 (−46 dB): rich-spectrum targets have
// many low-amplitude harmonics that individually contribute little to
// windowed-RMS score but collectively define timbre. The old threshold
// pruned them aggressively — production targets ended up with 3–8 active
// oscillators out of 50, discarding real spectral content that a wider
// tolerance would keep alive.
export const VOLUME_PRUNE_THRESHOLD = 0.005;
