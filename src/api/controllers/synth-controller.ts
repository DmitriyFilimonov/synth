import type { Request, Response } from 'express';
import { synthPreset1 } from '../../presets';
import type { ArgCreateSynth } from '../../synth';
import {
  MATCH_DEFAULT_OSCILLATORS,
  MATCH_DEFAULT_ITERATIONS,
} from '../../match-defaults';
import {
  generateWav,
  matchWav,
  matchWavWithJob,
} from '../services/synth-service';
import {
  getJob,
  listJobs,
  getResultFilePath,
  deleteJob,
} from '../services/job-store';
import {
  GenerateRequest,
  MatchRequestBody,
  CreateMatchJobRequest,
  oscillatorsToSynthConfig,
} from '../types';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

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

    const numOscillators =
      body.numOscillators ?? MATCH_DEFAULT_OSCILLATORS;
    const maxIterations =
      body.maxIterations ?? MATCH_DEFAULT_ITERATIONS;

    const wavBuffer = Buffer.from(body.wavBase64, 'base64');

    const result = await matchWav(
      wavBuffer,
      numOscillators,
      maxIterations,
      body.stepGrowthAdd,
      body.stepDecayFactor,
      body.stageDurationMultiplier,
      body.hpoTrials,
      body.staged,
      body.hpo,
    );

    res.json({
      history: result.history,
      targetInfo: result.targetInfo,
      suppressionPercent: result.suppressionPercent,
      wavBase64: result.buffer.toString('base64'),
      synthConfig: result.synthConfig,
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

    const result = await matchWav(
      req.body,
      MATCH_DEFAULT_OSCILLATORS,
      MATCH_DEFAULT_ITERATIONS,
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

export const createMatchJobHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'WAV binary data required' });
      return;
    }

    const queryParams = req.query as Record<
      string,
      string | undefined
    >;
    const numOscillators = parseInt(
      queryParams.numOscillators ?? String(MATCH_DEFAULT_OSCILLATORS),
      10,
    );
    const maxIterations = parseInt(
      queryParams.maxIterations ?? String(MATCH_DEFAULT_ITERATIONS),
      10,
    );
    const hpoTrialsInt = parseInt(queryParams.hpoTrials ?? '', 10);
    const stepGrowthAddFloat = parseFloat(
      queryParams.stepGrowthAdd ?? '',
    );
    const stepDecayFactorFloat = parseFloat(
      queryParams.stepDecayFactor ?? '',
    );
    const stageDurationMultiplierFloat = parseFloat(
      queryParams.stageDurationMultiplier ?? '',
    );
    const staged =
      queryParams.staged !== undefined
        ? queryParams.staged === 'true'
        : undefined;
    const hpo =
      queryParams.hpo !== undefined
        ? queryParams.hpo === 'true'
        : undefined;

    const hpoTrials = isNaN(hpoTrialsInt) ? undefined : hpoTrialsInt;
    const stepGrowthAdd = isNaN(stepGrowthAddFloat)
      ? undefined
      : stepGrowthAddFloat;
    const stepDecayFactor = isNaN(stepDecayFactorFloat)
      ? undefined
      : stepDecayFactorFloat;
    const stageDurationMultiplier = isNaN(
      stageDurationMultiplierFloat,
    )
      ? undefined
      : stageDurationMultiplierFloat;

    const jobId = await matchWavWithJob(
      req.body,
      isNaN(numOscillators)
        ? MATCH_DEFAULT_OSCILLATORS
        : numOscillators,
      isNaN(maxIterations) ? MATCH_DEFAULT_ITERATIONS : maxIterations,
      stepGrowthAdd,
      stepDecayFactor,
      stageDurationMultiplier,
      hpoTrials,
      staged,
      hpo,
    );

    res.status(202).json({ id: jobId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
};

export const createMatchJobJsonHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as CreateMatchJobRequest;

    if (body.wavBase64 === undefined || body.wavBase64 === '') {
      res
        .status(400)
        .json({ error: 'wavBase64 field required in request body' });
      return;
    }

    const numOscillators =
      body.numOscillators ?? MATCH_DEFAULT_OSCILLATORS;
    const maxIterations =
      body.maxIterations ?? MATCH_DEFAULT_ITERATIONS;

    const wavBuffer = Buffer.from(body.wavBase64, 'base64');

    const jobId = await matchWavWithJob(
      wavBuffer,
      numOscillators,
      maxIterations,
      body.stepGrowthAdd,
      body.stepDecayFactor,
      body.stageDurationMultiplier,
      body.hpoTrials,
      body.staged,
      body.hpo,
    );

    res.status(202).json({ id: jobId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
};

export const getJobStatusHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ error: 'Job ID required' });
      return;
    }

    const job = await getJob(id);
    res.json({
      id: job.id,
      status: job.status,
      progress: job.progress,
      params: job.params,
      inputFileName: job.inputFileName,
      resultFileName: job.resultFileName,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      suppressionPercent: job.suppressionPercent,
      targetInfo: job.targetInfo,
      bestVector: job.bestVector,
      synthConfig: job.synthConfig,
    });
  } catch {
    res.status(404).json({ error: 'Job not found' });
  }
};

export const getJobsListHandler = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const jobs = await listJobs();
    res.json(
      jobs.map((job) => ({
        id: job.id,
        status: job.status,
        suppressionPercent: job.suppressionPercent,
        params: job.params,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
};

export const downloadJobResultHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ error: 'Job ID required' });
      return;
    }

    const job = await getJob(id);

    if (job.status !== 'completed') {
      res.status(400).json({
        error: `Job not completed. Status: ${job.status}`,
      });
      return;
    }

    const resultPath = getResultFilePath(id);
    if (!existsSync(resultPath)) {
      res.status(404).json({ error: 'Result file not found' });
      return;
    }

    const buffer = await readFile(resultPath);
    res.set('Content-Type', 'audio/wav');
    res.set(
      'Content-Disposition',
      `attachment; filename="matched_${id}.wav"`,
    );
    res.send(buffer);
  } catch {
    res.status(404).json({ error: 'Job not found' });
  }
};

export const downloadJobParamsHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ error: 'Job ID required' });
      return;
    }

    const job = await getJob(id);

    if (job.status !== 'completed') {
      res.status(400).json({
        error: `Job not completed. Status: ${job.status}`,
      });
      return;
    }

    if (!job.synthConfig) {
      res.status(404).json({ error: 'Synth config not found' });
      return;
    }

    res.set('Content-Type', 'application/json');
    res.set(
      'Content-Disposition',
      `attachment; filename="synth_params_${id}.json"`,
    );
    res.json(job.synthConfig);
  } catch {
    res.status(404).json({ error: 'Job not found' });
  }
};

export const deleteJobHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ error: 'Job ID required' });
      return;
    }

    await deleteJob(id);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Job not found' });
  }
};
