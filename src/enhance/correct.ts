/**
 * Движок улучшения, режим B (коррекция) — контракт C4 из
 * `docs/spec-kick-enhancement.md`.
 *
 * Срабатывает, когда анкерный параметр противоречит приору
 * семейства: значение лежит вне квантильной вилки кластера
 * (p10…p90). Тогда двигаем его к ближайшей границе вилки на долю
 * `strength` от промаха: 0 — не трогаем, 1 — ровно до границы.
 * Внутри вилки коррекция ничего не делает: семейство признаёт
 * значение нормальным.
 */
import { type ArgCreateSynth } from '../synth';
import {
  classifyOscillatorRole,
  nearestCluster,
  type PriorsFile,
} from './engine';
import {
  retuneOscillator,
  setAmpEnvDuration,
  type TransformAudit,
} from './transforms';

/** Аргументы коррекции. */
export interface CorrectArgs {
  patch: ArgCreateSynth;
  priors: PriorsFile;
  /** Доля промаха, на которую двигаем: 0 — нет, 1 — до границы. */
  strength: number;
}

/** Результат коррекции: патч и журнал трансформаций. */
export interface CorrectResult {
  patch: ArgCreateSynth;
  audits: TransformAudit[];
}

/**
 * Возвращает цель движения к вилке [lo, hi]: внутри вилки — само
 * значение (двигать нечего), снаружи — границу, сдвинутую на долю
 * strength от промаха.
 */
function projectIntoRange(
  value: number,
  lo: number,
  hi: number,
  strength: number,
): number {
  if (value >= lo && value <= hi) {
    return value;
  }
  const boundary = value < lo ? lo : hi;
  return value + (boundary - value) * strength;
}

/**
 * Корректирует патч по режиму B: вываливающиеся из приорных вилок
 * анкерные параметры подтягивает к границам. Частота двигается с
 * сохранением отношения sweep (retuneOscillator), длительность
 * огибающей — двунаправленным сеттером.
 */
export function correctPatch(args: CorrectArgs): CorrectResult {
  const { priors, strength } = args;
  let patch = args.patch;
  const audits: TransformAudit[] = [];
  if (strength <= 0) {
    return { patch, audits };
  }

  const apply = (result: {
    patch: ArgCreateSynth;
    audit: TransformAudit | null;
  }): void => {
    if (result.audit !== null) {
      patch = result.patch;
      audits.push(result.audit);
    }
  };

  patch.oscillators.forEach((group, index) => {
    if (!group.osc.on) {
      return;
    }
    const cluster = nearestCluster(
      priors,
      classifyOscillatorRole(group),
      group.osc.freqBase,
    );
    if (cluster === null) {
      return;
    }

    const freqDist = cluster.freqBaseHz;
    if (freqDist.p10 !== null && freqDist.p90 !== null) {
      const target = projectIntoRange(
        group.osc.freqBase,
        freqDist.p10,
        freqDist.p90,
        strength,
      );
      if (target !== group.osc.freqBase) {
        apply(retuneOscillator(patch, index, target, true));
      }
    }

    const durDist = cluster.ampEnvDurationSec;
    if (durDist.p10 !== null && durDist.p90 !== null) {
      const target = projectIntoRange(
        group.ampEnv.duration,
        durDist.p10,
        durDist.p90,
        strength,
      );
      if (target !== group.ampEnv.duration) {
        apply(setAmpEnvDuration(patch, index, target));
      }
    }
  });

  return { patch, audits };
}
