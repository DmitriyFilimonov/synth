/** Options for selecting oscillators in the source patch. */
export interface FrequencyEnvelopeRenderOptions {
  /** Zero-based indices into the original `patch.oscillators` array. */
  oscillatorIndices?: readonly number[];
}

/** An invalid patch or oscillator selection supplied by a caller. */
export class FrequencyEnvelopeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrequencyEnvelopeInputError';
  }
}
