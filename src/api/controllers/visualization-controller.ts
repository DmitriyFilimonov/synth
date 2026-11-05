import type { Request, Response } from 'express';
import {
  FrequencyEnvelopeInputError,
  renderFrequencyEnvelopesSvg,
} from '../../frequency-envelope-visualization';
import type { FrequencyEnvelopeVisualizationRequest } from '../types';

/** Return an SVG rendering of the requested frequency envelopes. */
export const frequencyEnvelopesHandler = (
  req: Request,
  res: Response,
): void => {
  try {
    const body = (req.body ??
      {}) as FrequencyEnvelopeVisualizationRequest;
    const svg = renderFrequencyEnvelopesSvg(body.patch, {
      oscillatorIndices: body.oscillatorIndices,
    });

    res.status(200);
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Content-Disposition', 'inline');
    res.send(svg);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    const status =
      error instanceof FrequencyEnvelopeInputError ? 400 : 500;
    res.status(status).json({ error: message });
  }
};
