export const SAMPLE_RATE = 44100;
export const SAMPLE_LENGTH_IN_SECONDS = 0.5;
export const MAX_AMPLITUDE_16_BIT_WAV_ENCODED = 32767;

// Minimum amplitude for any oscillator during optimization (shared constant)
export const VOLUME_MIN = 0.01;
// Threshold below which an oscillator is considered silent and may be pruned
export const VOLUME_PRUNE_THRESHOLD = 0.02;
