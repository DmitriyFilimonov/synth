/**
 * Sampler интерфейс для HPO.
 * Аналог BaseSampler из Optuna.
 */

import type { Distribution, TrialState } from './types';

export interface Sampler {
  sampleRelative(
    params: readonly { name: string; distribution: Distribution }[],
  ): Record<string, number | string | boolean>;

  sampleIndependent(
    paramName: string,
    distribution: Distribution,
  ): number | string | boolean;

  afterTrial(
    trialNumber: number,
    state: TrialState,
    value: number | null,
    params: Record<string, number | string | boolean>,
  ): void;
}

/**
 * RandomSampler — равномерная случайная выборка.
 * Используется как baseline и для nStartupTrials перед TPE.
 */
export class RandomSampler implements Sampler {
  sampleRelative(): Record<string, number | string | boolean> {
    return {};
  }

  sampleIndependent(
    _paramName: string,
    distribution: Distribution,
  ): number | string | boolean {
    switch (distribution.type) {
      case 'float':
        return sampleFloat(distribution);
      case 'int':
        return sampleInt(distribution);
      case 'categorical':
        return sampleCategorical(distribution) as string | boolean;
    }
  }

  afterTrial(): void {
    // stateless
  }
}

function sampleFloat(dist: Distribution): number {
  if (dist.type !== 'float') {
    return 0;
  }

  let value: number;
  if (dist.log) {
    const lowLog = Math.log(dist.low);
    const highLog = Math.log(dist.high);
    value = Math.exp(lowLog + Math.random() * (highLog - lowLog));
  } else {
    value = dist.low + Math.random() * (dist.high - dist.low);
  }

  if (dist.step !== null && dist.step > 0) {
    value = Math.round(value / dist.step) * dist.step;
    value = Math.max(dist.low, Math.min(dist.high, value));
  }

  return value;
}

function sampleInt(dist: Distribution): number {
  if (dist.type !== 'int') {
    return 0;
  }

  let value: number;
  if (dist.log) {
    const lowLog = Math.log(dist.low);
    const highLog = Math.log(dist.high);
    value = Math.round(
      Math.exp(lowLog + Math.random() * (highLog - lowLog)),
    );
  } else if (dist.step !== null && dist.step > 0) {
    const steps = Math.floor((dist.high - dist.low) / dist.step);
    value =
      dist.low + Math.floor(Math.random() * (steps + 1)) * dist.step;
  } else {
    value =
      dist.low +
      Math.floor(Math.random() * (dist.high - dist.low + 1));
  }

  return Math.max(dist.low, Math.min(dist.high, value));
}

function sampleCategorical(dist: Distribution): unknown {
  if (dist.type !== 'categorical') {
    return null;
  }
  const idx = Math.floor(Math.random() * dist.choices.length);
  return dist.choices[idx] ?? null;
}
