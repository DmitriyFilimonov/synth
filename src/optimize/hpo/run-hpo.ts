import type { ProgressCallback, ProgressEntry } from '../types';
import {
  coordinateDescent,
  DEFAULT_COORD_DESCENT_CONFIG,
  type CoordinateDescentConfig,
} from '../coordinate-descent';
import { Study, type OptimizationDirection } from './study';
import { Trial } from './trial';
import { TPESampler, type TPEConfig } from './sampler-tpe';
import { resolveHyperparams, type ResolvedHyperparams } from './param-space';

export interface HPOProgressEntry extends ProgressEntry {
  trialIndex: number;
  totalTrials: number;
  trialValue: number | null;
}

export interface HPOResult {
  bestParams: Record<string, number | string | boolean>;
  bestValue: number;
  bestVector: number[];
  bestHyperparams: ResolvedHyperparams;
  history: {
    trial: number;
    value: number | null;
    params: Record<string, number | string | boolean>;
  }[];
}

export interface ArgHPO {
  targetSignal: readonly number[];
  sampleRate: number;
  initialVector: readonly number[];
  numOscillators: number;
  nTrials: number;
  onProgress?: ProgressCallback;
  tpeConfig?: Partial<TPEConfig>;
  direction?: OptimizationDirection;
}

export const runHPO = (arg: ArgHPO): HPOResult => {
  const {
    targetSignal,
    sampleRate,
    initialVector,
    nTrials,
    onProgress,
    tpeConfig,
    direction,
  } = arg;

  const sampler = new TPESampler(tpeConfig);
  const study = new Study(
    'hpo-coordinate-descent',
    sampler,
    direction ?? 'maximize',
  );

  const result = study.optimize(nTrials, (trial) => {
    const params = suggestTrialParams(trial);
    const hyperparams = resolveHyperparams(params);
    const coordConfig = buildCoordDescentConfig(hyperparams);

    const { history } = coordinateDescent(
      initialVector,
      targetSignal,
      sampleRate,
      hyperparams.iterations,
      undefined,
      hyperparams.stepGrowthAdd,
      hyperparams.stepDecayFactor,
      coordConfig,
    );

    const suppression =
      history.length > 0
        ? (history[history.length - 1]?.suppressionPercent ?? 0)
        : 0;

    const trialIdx = trial.getNumber();
    onProgress?.({
      iteration: trialIdx + 1,
      suppressionPercent: suppression,
    });

    return suppression;
  });

  const bestTrialIdx = result.bestTrial;
  const bestTrialResult =
    bestTrialIdx >= 0
      ? result.history.find((h) => h.number === bestTrialIdx)
      : undefined;

  const bestHyperparams = bestTrialResult
    ? resolveHyperparams(bestTrialResult.params)
    : resolveHyperparams({});

  const bestCoordConfig = buildCoordDescentConfig(bestHyperparams);
  const { vector: bestVector } = coordinateDescent(
    initialVector,
    targetSignal,
    sampleRate,
    bestHyperparams.iterations,
    undefined,
    bestHyperparams.stepGrowthAdd,
    bestHyperparams.stepDecayFactor,
    bestCoordConfig,
  );

  const history = result.history.map((h) => ({
    trial: h.number,
    value: h.value,
    params: h.params,
  }));

  onProgress?.({
    iteration: nTrials,
    suppressionPercent: result.bestValue ?? 0,
  });

  return {
    bestParams: result.bestParams,
    bestValue: result.bestValue ?? 0,
    bestVector,
    bestHyperparams,
    history,
  };
};

function suggestTrialParams(
  trial: Trial,
): Record<string, number | string | boolean> {
  trial.suggestInt('iterations', 50, 500, { step: 10 });
  trial.suggestFloat('stepGrowthAdd', 0.0001, 0.01, { log: true });
  trial.suggestFloat('stepDecayFactor', 0.85, 0.995);
  trial.suggestFloat('stageDurationMultiplier', 1.2, 5);
  trial.suggestFloat('explorationStartStep', 0.005, 0.1);
  trial.suggestFloat('explorationMinStep', 0.001, 0.05);
  trial.suggestFloat('refinementStartStep', 0.001, 0.05);
  trial.suggestFloat('refinementMinStep', 0.0005, 0.02);
  trial.suggestFloat('precisionStartStep', 0.0005, 0.02);
  trial.suggestFloat('precisionMinStep', 1e-6, 0.002, { log: true });
  trial.suggestInt('stagnationExitThreshold', 2, 12);
  trial.suggestFloat('stagnationDecayFactor', 0.5, 0.95);
  trial.suggestInt('plateauRestartThreshold', 2, 10);
  trial.suggestInt('stepGrowthThreshold', 2, 15);
  trial.suggestFloat('significantImprovementThreshold', 0.0005, 0.1, {
    log: true,
  });
  trial.suggestFloat('earlyExitSuppression', 90, 99.9);
  trial.suggestInt('maxRestartsBeforeRandomRestart', 2, 10);
  trial.suggestFloat('kickFallbackThreshold', 0.5, 0.95);
  trial.suggestInt('initialStageMs', 5, 100, { step: 5 });

  return trial.getParams();
}

function buildCoordDescentConfig(
  hyperparams: ReturnType<typeof resolveHyperparams>,
): CoordinateDescentConfig {
  return {
    ...DEFAULT_COORD_DESCENT_CONFIG,
    stagnationExitThreshold: hyperparams.stagnationExitThreshold,
    plateauRestartThreshold: hyperparams.plateauRestartThreshold,
    stepGrowthThreshold: hyperparams.stepGrowthThreshold,
    stagnationStepDecayFactor: hyperparams.stagnationDecayFactor,
    significantImprovementThreshold:
      hyperparams.significantImprovementThreshold,
    earlyExitSuppression: hyperparams.earlyExitSuppression,
    maxRestartsBeforeRandomRestart:
      hyperparams.maxRestartsBeforeRandomRestart,
    kickFallbackThreshold: hyperparams.kickFallbackThreshold,
    restartSchedule: [
      {
        startStep: hyperparams.explorationStartStep,
        minStep: hyperparams.explorationMinStep,
        label: 'EXPLORATION',
      },
      {
        startStep: hyperparams.refinementStartStep,
        minStep: hyperparams.refinementMinStep,
        label: 'REFINEMENT',
      },
      {
        startStep: hyperparams.precisionStartStep,
        minStep: hyperparams.precisionMinStep,
        label: 'PRECISION',
      },
    ],
  };
}
