import type { Sampler } from './sampler';
import {
  TrialState,
  type StudyResult,
  type TrialResult,
} from './types';
import { Trial } from './trial';

export type OptimizationDirection = 'maximize' | 'minimize';

export interface StudyOptions {
  studyName: string;
  direction?: OptimizationDirection;
}

export class Study {
  private studyName: string;
  private sampler: Sampler;
  private direction: OptimizationDirection;
  private trialsList: Trial[];
  private trialResults: TrialResult[];

  constructor(
    studyName: string,
    sampler: Sampler,
    direction: OptimizationDirection = 'maximize',
  ) {
    this.studyName = studyName;
    this.sampler = sampler;
    this.direction = direction;
    this.trialsList = [];
    this.trialResults = [];
  }

  optimize(
    nTrials: number,
    objective: (trial: Trial) => number,
  ): StudyResult {
    for (let i = 0; i < nTrials; i++) {
      const trial = new Trial(i, this.sampler);
      this.trialsList.push(trial);

      let value: number | null = null;
      let state = TrialState.Complete;
      const startTime = Date.now();

      try {
        value = objective(trial);
        trial.complete(value);
      } catch {
        trial.fail();
        state = TrialState.Fail;
        value = null;
      }

      const durationMs = Date.now() - startTime;
      const params = trial.getParams();

      const result: TrialResult = {
        number: i,
        value,
        state: state,
        params,
        durationMs,
      };
      this.trialResults.push(result);

      this.sampler.afterTrial(i, trial.getState(), value, params);
    }

    return this.getResult();
  }

  getResult(): StudyResult {
    const validTrials = this.trialResults.filter(
      (t) => t.state === TrialState.Complete && t.value !== null,
    );

    if (validTrials.length === 0) {
      return {
        bestTrial: -1,
        bestParams: {},
        bestValue: null,
        history: this.trialResults,
      };
    }

    const comparator =
      this.direction === 'maximize'
        ? (a: number, b: number): number => b - a
        : (a: number, b: number): number => a - b;

    const first = validTrials[0] ?? null;
    let best = first;
    for (const t of validTrials) {
      const bestVal = best?.value ?? null;
      if (
        t.value !== null &&
        bestVal !== null &&
        comparator(t.value, bestVal) > 0
      ) {
        best = t;
      }
    }

    return {
      bestTrial: best ? best.number : -1,
      bestParams: best ? { ...best.params } : {},
      bestValue: best ? best.value : null,
      history: this.trialResults,
    };
  }

  get bestTrial(): number {
    return this.getResult().bestTrial;
  }

  get bestParams(): Record<string, number | string | boolean> {
    return this.getResult().bestParams;
  }

  get bestValue(): number | null {
    return this.getResult().bestValue;
  }

  get trialsCount(): number {
    return this.trialsList.length;
  }

  get allTrials(): readonly TrialResult[] {
    return [...this.trialResults];
  }
}
