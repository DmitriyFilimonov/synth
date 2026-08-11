import type { Request, Response } from 'express';
import { synthPreset1 } from '../../presets';
import type { ArgCreateSynth } from '../../synth';
import { generateWav, matchWav } from '../services/synth-service';
import {
  GenerateRequest,
  MatchRequestBody,
  oscillatorsToSynthConfig,
} from '../types';

const PRESETS_MAP: Record<string, ArgCreateSynth> = {
  synthPreset1,
};

export const generateHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as GenerateRequest;
    let synthConfig: ArgCreateSynth;

    if (body.preset) {
      const preset = PRESETS_MAP[body.preset];
      if (preset === undefined) {
        res
          .status(400)
          .json({ error: `Unknown preset: ${body.preset}` });
        return;
      }
      synthConfig = preset;
    } else if (body.oscillators !== undefined) {
      synthConfig = oscillatorsToSynthConfig(body.oscillators);
    } else {
      synthConfig = synthPreset1;
    }

    const duration = body.duration ?? 0.5;
    const sampleRate =
      body.sampleRate ?? (req.app.get('synth_sample_rate') as number);

    const { buffer } = await generateWav(
      synthConfig,
      duration,
      sampleRate,
    );

    res.set('Content-Type', 'audio/wav');
    res.set(
      'Content-Disposition',
      'attachment; filename="generated.wav"',
    );
    res.set('X-Sample-Rate', String(sampleRate));
    res.set('X-Duration-Seconds', String(duration));
    res.send(buffer);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
};

export const matchHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as MatchRequestBody;

    if (body.wavBase64 === undefined || body.wavBase64 === '') {
      res
        .status(400)
        .json({ error: 'wavBase64 field required in request body' });
      return;
    }

    const numOscillators = body.numOscillators ?? 5;
    const maxIterations = body.maxIterations ?? 20;

    const wavBuffer = Buffer.from(body.wavBase64, 'base64');

    const result = await matchWav(
      wavBuffer,
      numOscillators,
      maxIterations,
    );

    res.json({
      history: result.history,
      targetInfo: result.targetInfo,
      suppressionPercent: result.suppressionPercent,
      wavBase64: result.buffer.toString('base64'),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
};

export const matchBinaryHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'WAV binary data required' });
      return;
    }

    const numOscillators = 5;
    const maxIterations = 20;

    const result = await matchWav(
      req.body,
      numOscillators,
      maxIterations,
    );

    res.set('Content-Type', 'audio/wav');
    res.set(
      'Content-Disposition',
      'attachment; filename="matched.wav"',
    );
    res.send(result.buffer);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
};
