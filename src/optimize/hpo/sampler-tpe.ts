/**
 * TPESampler — Tree-structured Parzen Estimator.
 * Основной алгоритм Optuna для гиперпараметрической оптимизации.
 *
 * Принцип:
 * 1. Разделить завершённые trials на «good» (лучшие γ%) и «bad» (остальные)
 * 2. Для каждого параметра построить KDE: l(x) = P(x|good), g(x) = P(x|bad)
 * 3. Сэмплировать кандидаты из l(x)
 * 4. Выбрать кандидата с max l(x)/g(x) ratio (expected improvement)
 */

import type {
  Distribution,
  FloatDistribution,
  IntDistribution,
  CategoricalDistribution,
} from './types';
import { TrialState } from './types';
import type { Sampler } from './sampler';

interface TrialObservation {
  params: Record<string, number | string | boolean>;
  value: number;
}

export interface TPEConfig {
  /** trials before TPE kicks in (random sampling during warmup) */
  nStartupTrials: number;
  /** fraction of completed trials considered "good" */
  gamma: number;
  /** bandwidth multiplier (fraction of param range) for KDE kernel */
  bandwidth: number;
  /** candidates to evaluate per parameter when maximizing EI */
  nEICandidates: number;
  /** weight for signal vs prior in l(x)/g(x) ratio */
  weights: { signal: number; prior: number };
}

const TPE_DEFAULTS: TPEConfig = {
  nStartupTrials: 10,
  gamma: 0.25,
  bandwidth: 0.15,
  nEICandidates: 64,
  weights: { signal: 0.95, prior: 0.05 },
};

export class TPESampler implements Sampler {
  private observations: TrialObservation[];
  private config: TPEConfig;

  constructor(config: Partial<TPEConfig> = {}) {
    this.config = { ...TPE_DEFAULTS, ...config };
    this.observations = [];
  }

  sampleRelative(): Record<string, number | string | boolean> {
    return {};
  }

  sampleIndependent(
    paramName: string,
    distribution: Distribution,
  ): number | string | boolean {
    if (this.observations.length < this.config.nStartupTrials) {
      return sampleRandom(distribution);
    }

    const sorted = [...this.observations].sort(
      (a, b) => b.value - a.value,
    );

    const n = Math.max(
      1,
      Math.floor(this.config.gamma * sorted.length),
    );

    const goodTrials = sorted.slice(0, n);
    const badTrials = sorted.slice(n);

    return this.sampleByEI(
      paramName,
      distribution,
      goodTrials,
      badTrials,
    );
  }

  afterTrial(
    _trialNumber: number,
    state: TrialState,
    value: number | null,
    params: Record<string, number | string | boolean>,
  ): void {
    if (state === TrialState.Complete && value !== null) {
      this.observations.push({ params, value });
    }
  }

  private sampleByEI(
    paramName: string,
    distribution: Distribution,
    goodTrials: TrialObservation[],
    badTrials: TrialObservation[],
  ): number | string | boolean {
    if (distribution.type === 'categorical') {
      return sampleCategoricalByEI(
        distribution,
        goodTrials,
        badTrials,
        paramName,
        this.config,
      );
    }

    return sampleContinuousByEI(
      distribution,
      goodTrials,
      badTrials,
      paramName,
      this.config,
    );
  }
}

function sampleRandom(dist: Distribution): number | string | boolean {
  switch (dist.type) {
    case 'float': {
      let value: number;
      if (dist.log) {
        const lo = Math.log(dist.low);
        const hi = Math.log(dist.high);
        value = Math.exp(lo + Math.random() * (hi - lo));
      } else {
        value = dist.low + Math.random() * (dist.high - dist.low);
      }
      if (dist.step !== null && dist.step > 0) {
        value = Math.round(value / dist.step) * dist.step;
        value = Math.max(dist.low, Math.min(dist.high, value));
      }
      return value;
    }
    case 'int': {
      let value: number;
      if (dist.log) {
        const lo = Math.log(dist.low);
        const hi = Math.log(dist.high);
        value = Math.round(Math.exp(lo + Math.random() * (hi - lo)));
      } else if (dist.step !== null && dist.step > 0) {
        const steps = Math.floor((dist.high - dist.low) / dist.step);
        value =
          dist.low +
          Math.floor(Math.random() * (steps + 1)) * dist.step;
      } else {
        value =
          dist.low +
          Math.floor(Math.random() * (dist.high - dist.low + 1));
      }
      return Math.max(dist.low, Math.min(dist.high, value));
    }
    case 'categorical': {
      const idx = Math.floor(Math.random() * dist.choices.length);
      return (dist.choices[idx] ?? '') as string;
    }
  }
}

function sampleCategoricalByEI(
  dist: CategoricalDistribution,
  goodTrials: TrialObservation[],
  badTrials: TrialObservation[],
  paramName: string,
  config: TPEConfig,
): number | string | boolean {
  const n = dist.choices.length;
  const goodCounts = new Array(n).fill(0) as number[];
  const badCounts = new Array(n).fill(0) as number[];

  for (const trial of goodTrials) {
    const val = trial.params[paramName];
    const idx = dist.choices.indexOf(val);
    if (idx >= 0) {
      goodCounts[idx] = (goodCounts[idx] ?? 0) + 1;
    }
  }
  for (const trial of badTrials) {
    const val = trial.params[paramName];
    const idx = dist.choices.indexOf(val);
    if (idx >= 0) {
      badCounts[idx] = (badCounts[idx] ?? 0) + 1;
    }
  }

  const goodTotal = goodCounts.reduce((a, b) => a + b, 0) + n;
  const badTotal = badCounts.reduce((a, b) => a + b, 0);

  const probGood = goodCounts.map((c) => (c + 1) / goodTotal);
  const probBad = badCounts.map((c) => (c + 1) / (badTotal + n));

  const eiScores = probGood.map(
    (pg, i) =>
      (config.weights.signal * pg + config.weights.prior / n) /
      (badTotal > 0
        ? config.weights.signal * (probBad[i] ?? 0) +
          config.weights.prior / n
        : 1e-7),
  );

  const choice = weightedRandomChoice(dist.choices, eiScores);
  return choice as number | string | boolean;
}

function sampleContinuousByEI(
  dist: FloatDistribution | IntDistribution,
  goodTrials: TrialObservation[],
  badTrials: TrialObservation[],
  paramName: string,
  config: TPEConfig,
): number {
  const isLog = dist.log;
  const isInt = dist.type === 'int';

  const lowLog = isLog ? Math.log(dist.low) : dist.low;
  const highLog = isLog ? Math.log(dist.high) : dist.high;

  const goodValues = extractValues(
    goodTrials,
    paramName,
    dist,
    isLog,
  );
  const badValues = extractValues(badTrials, paramName, dist, isLog);

  const band = config.bandwidth * (highLog - lowLog);

  const candidates: number[] = [];
  for (let i = 0; i < config.nEICandidates; i++) {
    candidates.push(sampleFromKDE(goodValues, lowLog, highLog, band));
  }

  let bestRatio = -Infinity;
  let bestCandidate = candidates[0] ?? (lowLog + highLog) / 2;

  for (const cand of candidates) {
    const lScore =
      kdeDensity(cand, goodValues, band) +
      config.weights.prior / (highLog - lowLog);
    const gScore =
      badValues.length > 0
        ? kdeDensity(cand, badValues, band) +
          config.weights.prior / (highLog - lowLog)
        : config.weights.prior / (highLog - lowLog);

    const ratio = lScore / (gScore > 1e-14 ? gScore : 1e-14);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestCandidate = cand;
    }
  }

  let value = isLog ? Math.exp(bestCandidate) : bestCandidate;

  if (isInt) {
    value = Math.round(value);
  }

  if (dist.step !== null && dist.step > 0) {
    value = Math.round(value / dist.step) * dist.step;
  }

  return Math.max(dist.low, Math.min(dist.high, value));
}

function extractValues(
  trials: TrialObservation[],
  paramName: string,
  dist: FloatDistribution | IntDistribution,
  toLog: boolean,
): number[] {
  const values: number[] = [];
  for (const trial of trials) {
    const raw = trial.params[paramName];
    if (typeof raw !== 'number' || raw <= 0) {
      continue;
    }
    values.push(toLog ? Math.log(Math.max(raw, dist.low)) : raw);
  }
  return values;
}

function sampleFromKDE(
  values: number[],
  low: number,
  high: number,
  band: number,
): number {
  if (values.length === 0) {
    return low + Math.random() * (high - low);
  }

  const idx = Math.floor(Math.random() * values.length);
  const center = values[idx] ?? 0;

  const noise =
    (Math.random() + Math.random() + Math.random() - 1.5) * 2;
  const sample = center + noise * band;

  return Math.max(low, Math.min(high, sample));
}

function kdeDensity(
  x: number,
  values: number[],
  band: number,
): number {
  if (values.length === 0) {
    return 0;
  }

  let sum = 0;
  const b = band > 0 ? band : 1e-10;

  for (const xi of values) {
    const z = (x - xi) / b;
    sum += Math.exp(-0.5 * z * z);
  }

  return sum / (values.length * Math.sqrt(2 * Math.PI) * b);
}

function weightedRandomChoice<T>(
  choices: readonly T[],
  weights: number[],
): T {
  let total = 0;
  for (const w of weights) {
    total += w;
  }

  const fallback = choices[0] ?? 0;

  if (total <= 0) {
    const idx = Math.floor(Math.random() * choices.length);
    return (choices[idx] ?? fallback) as T;
  }

  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) {
      return (choices[i] ?? fallback) as T;
    }
  }

  return (choices[choices.length - 1] ?? fallback) as T;
}
