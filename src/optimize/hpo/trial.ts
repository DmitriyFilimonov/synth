import type {
  Distribution,
  FloatDistribution,
  IntDistribution,
  CategoricalDistribution,
} from './types';
import { TrialState } from './types';
import type { Sampler } from './sampler';

export interface RegisteredDistribution {
  name: string;
  distribution: Distribution;
}

export class Trial {
  private trialNumber: number;
  private sampler: Sampler;
  private params: Record<string, number | string | boolean>;
  private distributions: RegisteredDistribution[];
  private value: number | null;
  private state: TrialState;
  private startTimeMs: number;

  constructor(trialNumber: number, sampler: Sampler) {
    this.trialNumber = trialNumber;
    this.sampler = sampler;
    this.params = {};
    this.distributions = [];
    this.value = null;
    this.state = TrialState.Running;
    this.startTimeMs = Date.now();
  }

  suggestFloat(
    name: string,
    low: number,
    high: number,
    opts: { log?: boolean; step?: number } = {},
  ): number {
    const dist: FloatDistribution = {
      type: 'float',
      low,
      high,
      log: opts.log ?? false,
      step: opts.step ?? null,
    };
    return this.suggest(name, dist) as number;
  }

  suggestInt(
    name: string,
    low: number,
    high: number,
    opts: { log?: boolean; step?: number } = {},
  ): number {
    const dist: IntDistribution = {
      type: 'int',
      low,
      high,
      log: opts.log ?? false,
      step: opts.step ?? null,
    };
    return this.suggest(name, dist) as number;
  }

  suggestCategorical<T>(name: string, choices: readonly T[]): T {
    const dist: CategoricalDistribution = {
      type: 'categorical',
      choices,
    };
    return this.suggest(name, dist) as T;
  }

  report(value: number): void {
    if (this.state === TrialState.Running) {
      this.value = value;
    }
  }

  complete(value: number): void {
    this.value = value;
    this.state = TrialState.Complete;
  }

  fail(): void {
    this.state = TrialState.Fail;
  }

  getParams(): Record<string, number | string | boolean> {
    return { ...this.params };
  }

  getState(): TrialState {
    return this.state;
  }

  getValue(): number | null {
    return this.value;
  }

  getNumber(): number {
    return this.trialNumber;
  }

  getDistributions(): readonly RegisteredDistribution[] {
    return [...this.distributions];
  }

  getDurationMs(): number {
    return Date.now() - this.startTimeMs;
  }

  private suggest(
    name: string,
    distribution: Distribution,
  ): number | string | boolean {
    const existing = this.params[name];
    if (existing !== undefined) {
      return existing;
    }

    const relativeParams = this.sampler.sampleRelative(
      this.distributions.map((d) => ({
        name: d.name,
        distribution: d.distribution,
      })),
    );

    if (relativeParams[name] !== undefined) {
      this.params[name] = relativeParams[name];
      this.distributions.push({ name, distribution });
      return this.params[name];
    }

    const value = this.sampler.sampleIndependent(name, distribution);
    this.params[name] = value;
    this.distributions.push({ name, distribution });
    return value;
  }
}
