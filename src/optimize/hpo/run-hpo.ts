import type { ProgressEntry } from '../types';
import {
  coordinateDescent,
  DEFAULT_COORD_DESCENT_CONFIG,
  type CoordinateDescentConfig,
} from '../coordinate-descent';
import { Study, type OptimizationDirection } from './study';
import { Trial } from './trial';
import { TPESampler, type TPEConfig } from './sampler-tpe';
import {
  resolveHyperparams,
  type ResolvedHyperparams,
} from './param-space';

export interface TrialObservation {
  params: Record<string, number | string | boolean>;
  value: number;
}

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
  /** Raw observations for carry-over between stages */
  observations: TrialObservation[];
}

export interface ArgHPO {
  targetSignal: readonly number[];
  sampleRate: number;
  initialVector: readonly number[];
  numOscillators: number;
  nTrials: number;
  onProgress?: (entry: HPOProgressEntry) => void;
  tpeConfig?: Partial<TPEConfig>;
  direction?: OptimizationDirection;
  /** CD iterations per HPO trial. Controls trial cost, not final CD. Default: 7 */
  cdIterationsPerTrial?: number;
  /** Observations from prior HPO runs (carry-over across stages) */
  initialObservations?: TrialObservation[];
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
    cdIterationsPerTrial = 7,
    initialObservations = [],
  } = arg;

  // nStartupTrials adapts to trial count: with few trials, TPE must
  // kick in immediately rather than doing pure random for 10 probes.
  const effectiveNStartupTrials = computeStartupTrials(nTrials);

  const sampler = new TPESampler({
    ...tpeConfig,
    nStartupTrials:
      tpeConfig?.nStartupTrials ?? effectiveNStartupTrials,
  });
  // Seed sampler with observations from prior stages
  for (const obs of initialObservations) {
    sampler.seedObservation(obs.params, obs.value);
  }

  const study = new Study(
    'hpo-coordinate-descent',
    sampler,
    direction ?? 'maximize',
  );

  const result = study.optimize(nTrials, (trial) => {
    const params = suggestTrialParams(trial);
    const hyperparams = resolveHyperparams(params);
    const coordConfig = buildCoordDescentConfig(hyperparams);
    const trialIdx = trial.getNumber();

    // Emit trial start so UI shows HPO isn't stalled
    onProgress?.({
      iteration: trialIdx + 1,
      suppressionPercent: 0,
      trialIndex: trialIdx,
      totalTrials: nTrials,
      trialValue: null,
    });

    // HPO trials use fixed small cdIterationsPerTrial for fast comparison.
    // Final CD uses user's maxIterations or bestHyper.iterations.
    const { history } = coordinateDescent(
      initialVector,
      targetSignal,
      sampleRate,
      cdIterationsPerTrial,
      (entry) => {
        onProgress?.({
          iteration: trialIdx + 1,
          suppressionPercent: entry.suppressionPercent,
          trialIndex: trialIdx,
          totalTrials: nTrials,
          trialValue: entry.suppressionPercent,
        });
      },
      hyperparams.stepGrowthAdd,
      hyperparams.stepDecayFactor,
      coordConfig,
    );

    const suppression =
      history.length > 0
        ? (history[history.length - 1]?.suppressionPercent ?? 0)
        : 0;

    onProgress?.({
      iteration: trialIdx + 1,
      suppressionPercent: suppression,
      trialIndex: trialIdx,
      totalTrials: nTrials,
      trialValue: suppression,
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
  // Final HPO validation uses cdIterationsPerTrial, not iterations from
  // hyperparams (which is now a user-controlled value, not HPO-sampled)
  const { vector: bestVector } = coordinateDescent(
    initialVector,
    targetSignal,
    sampleRate,
    cdIterationsPerTrial,
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
    trialIndex: nTrials - 1,
    totalTrials: nTrials,
    trialValue: result.bestValue,
  });

  const observations = sampler.getObservations();

  return {
    bestParams: result.bestParams,
    bestValue: result.bestValue ?? 0,
    bestVector,
    bestHyperparams,
    history,
    observations,
  };
};

function suggestTrialParams(
  trial: Trial,
): Record<string, number | string | boolean> {
  // Note: `iterations` is NOT a hyperparameter. User controls it via
  // maxIterations. HPO trials use cdIterationsPerTrial (default 7).
  trial.suggestFloat('stepGrowthAdd', 0.0001, 0.01, { log: true });
  trial.suggestFloat('stepDecayFactor', 0.85, 0.995);
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
  trial.suggestFloat('frequencyStep', 5e-8, 5e-7, { log: true });
  trial.suggestFloat('frequencyStepCoarse', 1e-5, 5e-4, {
    log: true,
  });
  trial.suggestFloat('frequencyStepRefine', 1e-6, 1e-5, {
    log: true,
  });
  trial.suggestFloat('phaseStep', 0.0015, 0.006);
  trial.suggestFloat('phaseStepRefine', 0.0003, 0.002);
  trial.suggestFloat('phaseStepPrecision', 0.00005, 0.0005);
  trial.suggestFloat('saInitialTemp', 0.5, 8);
  trial.suggestFloat('saCoolingRate', 0.95, 0.999);

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
    frequencyStep: hyperparams.frequencyStep,
    frequencyStepCoarse: hyperparams.frequencyStepCoarse,
    frequencyStepRefine: hyperparams.frequencyStepRefine,
    phaseStep: hyperparams.phaseStep,
    phaseStepRefine: hyperparams.phaseStepRefine,
    phaseStepPrecision: hyperparams.phaseStepPrecision,
    saInitialTemp: hyperparams.saInitialTemp,
    saCoolingRate: hyperparams.saCoolingRate,
  };
}

/**
 * Adaptive nStartupTrials: with few trials, TPE must kick in immediately.
 * Default nStartupTrials = 10 is designed for 30-50+ trial runs.
 * For staged HPO with 2-5 trials, we need TPE from trial 2.
 */
function computeStartupTrials(nTrials: number): number {
  if (nTrials <= 3) {
    return 1;
  }
  if (nTrials <= 8) {
    return 2;
  }
  if (nTrials <= 20) {
    return 5;
  }
  return 10;
}
