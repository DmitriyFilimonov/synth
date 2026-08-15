/**
 * Пространство гиперпараметров для оптимизации coordinate descent.
 *
 * Включает параметры из match-defaults.ts и скрытые константы
 * из coordinate-descent.ts / staged.ts.
 *
 * HPO подбирает эти значения — пользователь задаёт только
 * numOscillators. Начальные параметры осцилляторов определяются FFT.
 * Файлы всегда 500ms, без staged-оптимизации.
 */

import type { Distribution } from './types';

/**
 * Определение одного гиперпараметра.
 */
export interface HyperparamDef {
  name: string;
  distribution: Distribution;
  description: string;
  currentValue: number;
}

/**
 * Всё пространство гиперпараметров coordinate descent.
 */
export const HYPERPARAM_SPACE: HyperparamDef[] = [
  // --- match-defaults.ts (пользовательские) ---
  {
    name: 'iterations',
    distribution: {
      type: 'int',
      low: 50,
      high: 500,
      log: false,
      step: 10,
    },
    description: 'Max iterations per stage',
    currentValue: 100,
  },
  {
    name: 'stepGrowthAdd',
    distribution: {
      type: 'float',
      low: 0.0001,
      high: 0.01,
      log: true,
      step: null,
    },
    description: 'Step size growth additive factor',
    currentValue: 0.0007,
  },
  {
    name: 'stepDecayFactor',
    distribution: {
      type: 'float',
      low: 0.85,
      high: 0.995,
      log: false,
      step: null,
    },
    description: 'Step size decay multiplier on plateau',
    currentValue: 0.97,
  },
  // --- coordinate-descent.ts (скрытые константы) ---
  {
    name: 'explorationStartStep',
    distribution: {
      type: 'float',
      low: 0.005,
      high: 0.1,
      log: false,
      step: null,
    },
    description: 'EXPLORATION phase start step size',
    currentValue: 0.025,
  },
  {
    name: 'explorationMinStep',
    distribution: {
      type: 'float',
      low: 0.001,
      high: 0.05,
      log: false,
      step: null,
    },
    description: 'EXPLORATION phase min step size',
    currentValue: 0.01,
  },
  {
    name: 'refinementStartStep',
    distribution: {
      type: 'float',
      low: 0.001,
      high: 0.05,
      log: false,
      step: null,
    },
    description: 'REFINEMENT phase start step size',
    currentValue: 0.01,
  },
  {
    name: 'refinementMinStep',
    distribution: {
      type: 'float',
      low: 0.0005,
      high: 0.02,
      log: false,
      step: null,
    },
    description: 'REFINEMENT phase min step size',
    currentValue: 0.003,
  },
  {
    name: 'precisionStartStep',
    distribution: {
      type: 'float',
      low: 0.0005,
      high: 0.02,
      log: false,
      step: null,
    },
    description: 'PRECISION phase start step size',
    currentValue: 0.0025,
  },
  {
    name: 'precisionMinStep',
    distribution: {
      type: 'float',
      low: 1e-6,
      high: 0.002,
      log: true,
      step: null,
    },
    description: 'PRECISION phase min step size',
    currentValue: 0.0001,
  },
  {
    name: 'stagnationExitThreshold',
    distribution: {
      type: 'int',
      low: 2,
      high: 12,
      log: false,
      step: 1,
    },
    description: 'Iterations without improvement before step decay',
    currentValue: 4,
  },
  {
    name: 'stagnationDecayFactor',
    distribution: {
      type: 'float',
      low: 0.5,
      high: 0.95,
      log: false,
      step: null,
    },
    description: 'Step multiplier on stagnation exit',
    currentValue: 0.9,
  },
  {
    name: 'plateauRestartThreshold',
    distribution: {
      type: 'int',
      low: 2,
      high: 10,
      log: false,
      step: 1,
    },
    description: 'Iterations without improvement before kick/restart',
    currentValue: 3,
  },
  {
    name: 'stepGrowthThreshold',
    distribution: {
      type: 'int',
      low: 2,
      high: 15,
      log: false,
      step: 1,
    },
    description: 'Consecutive successes before step grows',
    currentValue: 5,
  },
  {
    name: 'significantImprovementThreshold',
    distribution: {
      type: 'float',
      low: 0.0005,
      high: 0.1,
      log: true,
      step: null,
    },
    description: 'Min score increase (%) to count as improvement',
    currentValue: 0.01,
  },
  {
    name: 'earlyExitSuppression',
    distribution: {
      type: 'float',
      low: 90,
      high: 99.9,
      log: false,
      step: null,
    },
    description: 'Early exit suppression threshold (%)',
    currentValue: 98,
  },
  {
    name: 'maxRestartsBeforeRandomRestart',
    distribution: {
      type: 'int',
      low: 2,
      high: 10,
      log: false,
      step: 1,
    },
    description: 'Max plateau kicks before full random restart',
    currentValue: 5,
  },
  {
    name: 'kickFallbackThreshold',
    distribution: {
      type: 'float',
      low: 0.5,
      high: 0.95,
      log: false,
      step: null,
    },
    description:
      'Kick fallback: if score < bestScore × threshold, restore',
    currentValue: 0.8,
  },

  // --- staged.ts ---
  {
    name: 'initialStageMs',
    distribution: {
      type: 'int',
      low: 5,
      high: 100,
      log: false,
      step: 5,
    },
    description: 'Initial stage duration in ms',
    currentValue: 10,
  },

  // --- per-parameter step sizes (narrow ranges — deviate → likely wrong) ---
  {
    name: 'frequencyStep',
    distribution: {
      type: 'float',
      low: 5e-8,
      high: 5e-7,
      log: true,
      step: null,
    },
    description:
      'Fine step for freqBase/freqStart (offset 1,2) in PRECISION. ~0.002 Hz',
    currentValue: 0.0000001,
  },
  {
    name: 'frequencyStepCoarse',
    distribution: {
      type: 'float',
      low: 1e-5,
      high: 5e-4,
      log: true,
      step: null,
    },
    description:
      'Coarse step for freqBase/freqStart in EXPLORATION/REFINEMENT. ~2 Hz',
    currentValue: 0.0001,
  },
  {
    name: 'phaseStep',
    distribution: {
      type: 'float',
      low: 0.0015,
      high: 0.006,
      log: false,
      step: null,
    },
    description:
      'Step for phase (offset 5). ~0.02 rad / 1.1 deg in physical space',
    currentValue: 0.003125,
  },
];

/**
 * Значения по умолчанию (текущие захардкоженные).
 */
export const HYPERPARAM_DEFAULTS: Record<string, number> = {
  iterations: 100,
  stepGrowthAdd: 0.0007,
  stepDecayFactor: 0.97,
  explorationStartStep: 0.025,
  explorationMinStep: 0.01,
  refinementStartStep: 0.01,
  refinementMinStep: 0.003,
  precisionStartStep: 0.0025,
  precisionMinStep: 0.0001,
  stagnationExitThreshold: 4,
  stagnationDecayFactor: 0.9,
  plateauRestartThreshold: 3,
  stepGrowthThreshold: 5,
  significantImprovementThreshold: 0.01,
  earlyExitSuppression: 98,
  maxRestartsBeforeRandomRestart: 5,
  kickFallbackThreshold: 0.8,
  initialStageMs: 10,
  frequencyStep: 0.0000001,
  frequencyStepCoarse: 0.0001,
  phaseStep: 0.003125,
};

/**
 * Собранный конфиг для передачи в coordinate descent.
 */
export interface ResolvedHyperparams {
  // match-defaults
  iterations: number;
  stepGrowthAdd: number;
  stepDecayFactor: number;
  // coordinate-descent
  explorationStartStep: number;
  explorationMinStep: number;
  refinementStartStep: number;
  refinementMinStep: number;
  precisionStartStep: number;
  precisionMinStep: number;
  stagnationExitThreshold: number;
  stagnationDecayFactor: number;
  plateauRestartThreshold: number;
  stepGrowthThreshold: number;
  significantImprovementThreshold: number;
  earlyExitSuppression: number;
  maxRestartsBeforeRandomRestart: number;
  kickFallbackThreshold: number;
  // staged
  initialStageMs: number;
  // per-parameter step sizes
  frequencyStep: number;
  frequencyStepCoarse: number;
  phaseStep: number;
}

export function resolveHyperparams(
  params: Record<string, number | string | boolean>,
): ResolvedHyperparams {
  const D = HYPERPARAM_DEFAULTS;
  const get = (name: string, fallback: number): number => {
    const v = params[name];
    return typeof v === 'number' ? v : fallback;
  };
  const getInt = (name: string, fallback: number): number =>
    Math.round(get(name, fallback));

  return {
    iterations: getInt('iterations', D.iterations as number),
    stepGrowthAdd: get('stepGrowthAdd', D.stepGrowthAdd as number),
    stepDecayFactor: get(
      'stepDecayFactor',
      D.stepDecayFactor as number,
    ),
    explorationStartStep: get(
      'explorationStartStep',
      D.explorationStartStep as number,
    ),
    explorationMinStep: get(
      'explorationMinStep',
      D.explorationMinStep as number,
    ),
    refinementStartStep: get(
      'refinementStartStep',
      D.refinementStartStep as number,
    ),
    refinementMinStep: get(
      'refinementMinStep',
      D.refinementMinStep as number,
    ),
    precisionStartStep: get(
      'precisionStartStep',
      D.precisionStartStep as number,
    ),
    precisionMinStep: get(
      'precisionMinStep',
      D.precisionMinStep as number,
    ),
    stagnationExitThreshold: getInt(
      'stagnationExitThreshold',
      D.stagnationExitThreshold as number,
    ),
    stagnationDecayFactor: get(
      'stagnationDecayFactor',
      D.stagnationDecayFactor as number,
    ),
    plateauRestartThreshold: getInt(
      'plateauRestartThreshold',
      D.plateauRestartThreshold as number,
    ),
    stepGrowthThreshold: getInt(
      'stepGrowthThreshold',
      D.stepGrowthThreshold as number,
    ),
    significantImprovementThreshold: get(
      'significantImprovementThreshold',
      D.significantImprovementThreshold as number,
    ),
    earlyExitSuppression: get(
      'earlyExitSuppression',
      D.earlyExitSuppression as number,
    ),
    maxRestartsBeforeRandomRestart: getInt(
      'maxRestartsBeforeRandomRestart',
      D.maxRestartsBeforeRandomRestart as number,
    ),
    kickFallbackThreshold: get(
      'kickFallbackThreshold',
      D.kickFallbackThreshold as number,
    ),
    initialStageMs: getInt(
      'initialStageMs',
      D.initialStageMs as number,
    ),
    frequencyStep: get('frequencyStep', D.frequencyStep as number),
    frequencyStepCoarse: get(
      'frequencyStepCoarse',
      D.frequencyStepCoarse as number,
    ),
    phaseStep: get('phaseStep', D.phaseStep as number),
  };
}
