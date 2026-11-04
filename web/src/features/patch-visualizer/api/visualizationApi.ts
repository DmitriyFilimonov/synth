import { fetchBlob } from '@/shared/api/fetchBlob';
import type {
  FrequencyEnvelopeVisualizationRequest,
  SynthPatch,
} from '../model/types';

/** Request an SVG for the selected original oscillator indices. */
export function fetchFrequencyEnvelopesSvg(
  patch: SynthPatch,
  oscillatorIndices: number[],
): Promise<Blob> {
  const request: FrequencyEnvelopeVisualizationRequest = {
    patch,
    oscillatorIndices,
  };

  return fetchBlob('/api/visualizations/frequency-envelopes', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}
