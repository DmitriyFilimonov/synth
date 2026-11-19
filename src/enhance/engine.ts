/**
 * Движок улучшения патча, режим A (достраивание) — контракт C4 из
 * `docs/spec-kick-enhancement.md`.
 *
 * Логика: параметры, которые сигнал определяет устойчиво (вердикт
 * `anchored` в карте идентифицируемости), не трогаем; свободные
 * (`free`) и залипшие на init (`prior-owned`) двигаем к приорам
 * семейства на величину `strength` (0 — не менять, 1 — полностью
 * приор). Движок v1 консервативен: хвосты только продлевает,
 * уровни только поднимает — типичные дефекты именно такие
 * (обрезанный хвост, слабый саб), а укорочение и приглушение
 * ждут своих подтверждённых сценариев.
 *
 * Модуль чистый: никакого I/O, файлы читает вызывающий.
 */
import { MIN } from '../envelope';
import { type ArgCreateSynth } from '../synth';
import {
  addTransientClick,
  boostOscillator,
  extendTail,
  setEndLevel,
  type TransformAudit,
} from './transforms';

/** Вердикт идентифицируемости параметра (контракт C1). */
export type ParamVerdict =
  'anchored' | 'free' | 'prior-owned' | 'unknown';

/** Карта идентифицируемости (контракт C1). */
export interface IdentifiabilityMap {
  version: number;
  params: Record<string, { verdict: ParamVerdict }>;
}

/** Распределение признака в приоре (контракт C2). */
export interface FeatureDist {
  median: number | null;
  p10: number | null;
  p90: number | null;
}

/** Кластер приоров (контракт C2). */
export interface PriorCluster {
  id: string;
  role: 'sustain' | 'transient';
  freqBaseHz: FeatureDist;
  ampEnvDurationSec: FeatureDist;
  ampStartLevel: FeatureDist;
  ampEndLevel: FeatureDist;
  /** Таргеты, где кластер представлен; режим B требует ≥ 2. */
  targetsPresent?: string[];
  /** Покрытие сидов в представленных таргетах, 0..1. */
  seedCoverage?: number;
}

/** Файл приоров (контракт C2). */
export interface PriorsFile {
  version: number;
  clusters: PriorCluster[];
}

/** Аргументы улучшения. */
export interface EnhanceArgs {
  patch: ArgCreateSynth;
  identifiability: IdentifiabilityMap;
  priors: PriorsFile;
  /** 0 — ничего не менять, 1 — полностью приор. */
  strength: number;
}

/** Результат улучшения: патч и журнал трансформаций. */
export interface EnhanceResult {
  patch: ArgCreateSynth;
  audits: TransformAudit[];
}

/**
 * Порог длительности огибающей для роли transient: короче неё
 * считаем осциллятор частью атаки. Эвристика v1 по данным BOg:
 * медиана ampEnv у transient-кластера ~29 мс.
 */
const TRANSIENT_DURATION_SEC = 0.06;

/**
 * Максимальное расстояние по log-частоте, на котором кластер ещё
 * считается своим для осциллятора. 0.7 ≈ ×2 по частоте.
 */
const CLUSTER_MAX_LOG_DISTANCE = 0.7;

/** Классифицирует осциллятор по роли из формы огибающей. */
export function classifyOscillatorRole(
  group: ArgCreateSynth['oscillators'][number],
): 'sustain' | 'transient' {
  return group.ampEnv.duration <= TRANSIENT_DURATION_SEC
    ? 'transient'
    : 'sustain';
}

/** Находит ближайший кластер роли по log-частоте; дальний — null. */
export function nearestCluster(
  priors: PriorsFile,
  role: 'sustain' | 'transient',
  freqBase: number,
): PriorCluster | null {
  let best: PriorCluster | null = null;
  let bestDist = CLUSTER_MAX_LOG_DISTANCE;
  for (const cluster of priors.clusters) {
    if (cluster.role !== role || cluster.freqBaseHz.median === null) {
      continue;
    }
    const dist = Math.abs(
      Math.log(freqBase) - Math.log(cluster.freqBaseHz.median),
    );
    if (dist < bestDist) {
      bestDist = dist;
      best = cluster;
    }
  }
  return best;
}

/** Читает вердикт параметра из карты; отсутствие — unknown. */
function verdictOf(
  map: IdentifiabilityMap,
  param: string,
): ParamVerdict {
  return map.params[param]?.verdict ?? 'unknown';
}

/**
 * Грубая оценка энергии осциллятора: квадрат уровня на длительность.
 * Нужна, чтобы отличать «тело» патча от тембровой текстуры.
 */
function energyProxy(
  group: ArgCreateSynth['oscillators'][number],
): number {
  return group.ampEnv.startLevel ** 2 * group.ampEnv.duration;
}

/**
 * Индексы топ-N sustain-осцилляторов патча по энергии. Только они
 * могут быть «слишком слабым телом»; текстуру движок не усиливает
 * (урок провалившейся регрессии: 21 усиление подряд разровняло
 * тембровую иерархию эталона).
 */
export function topSustainIndices(
  patch: ArgCreateSynth,
  count: number,
): Set<number> {
  const scored = patch.oscillators
    .map((group, index) => ({
      index,
      score:
        group.osc.on && classifyOscillatorRole(group) === 'sustain'
          ? energyProxy(group)
          : -1,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return new Set(scored.slice(0, count).map((s) => s.index));
}

/**
 * Двигает текущее значение к целевому на долю strength в
 * мультипликативной шкале: при strength 1 результат равен цели.
 */
function moveToward(
  current: number,
  target: number,
  strength: number,
): number {
  return current * Math.exp(Math.log(target / current) * strength);
}

/**
 * Улучшает патч по режиму A: анкерные параметры не трогает,
 * свободные двигает к приорам. Возвращает новый патч и журнал.
 */
export function enhancePatch(args: EnhanceArgs): EnhanceResult {
  const { identifiability, priors, strength } = args;
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

  const hasActiveTransient = patch.oscillators.some(
    (g) => g.osc.on && classifyOscillatorRole(g) === 'transient',
  );
  const bodyIndices = topSustainIndices(patch, 3);

  patch.oscillators.forEach((group, index) => {
    if (!group.osc.on) {
      return;
    }
    const role = classifyOscillatorRole(group);
    const cluster = nearestCluster(priors, role, group.osc.freqBase);
    if (cluster === null) {
      return;
    }

    // endLevel приглушаем только у выбросов выше p90 кластера:
    // поднимать звонкость к медиане нельзя (звенящий хвост может
    // быть характером), а типовой хвост и так у своей медианы.
    const endLevelVerdict = verdictOf(identifiability, 'endLevel');
    const endP90 = cluster.ampEndLevel.p90;
    const currentEnd = group.ampEnv.endLevel ?? MIN;
    if (
      (endLevelVerdict === 'prior-owned' ||
        endLevelVerdict === 'free') &&
      endP90 !== null &&
      currentEnd > endP90
    ) {
      const target = moveToward(currentEnd, endP90, strength);
      apply(setEndLevel(patch, index, target));
    }

    // Продление и усиление — только телу (топ-3 sustain по энергии):
    // текстуру оставляем, как определил match.
    if (!bodyIndices.has(index)) {
      return;
    }

    const durationVerdict = verdictOf(
      identifiability,
      'ampEnvDuration',
    );
    if (
      (durationVerdict === 'free' ||
        durationVerdict === 'prior-owned') &&
      cluster.ampEnvDurationSec.median !== null
    ) {
      const target = moveToward(
        group.ampEnv.duration,
        cluster.ampEnvDurationSec.median,
        strength,
      );
      if (target > group.ampEnv.duration) {
        apply(
          extendTail(patch, index, target / group.ampEnv.duration),
        );
      }
    }

    const levelVerdict = verdictOf(identifiability, 'startLevel');
    if (
      (levelVerdict === 'free' || levelVerdict === 'prior-owned') &&
      cluster.ampStartLevel.median !== null
    ) {
      const target = moveToward(
        group.ampEnv.startLevel,
        cluster.ampStartLevel.median,
        strength,
      );
      if (target > group.ampEnv.startLevel) {
        apply(
          boostOscillator(
            patch,
            index,
            target / group.ampEnv.startLevel,
          ),
        );
      }
    }
  });

  // Отсутствующий слой атаки достраиваем по приору transient,
  // если сила достаточна, чтобы добавка была слышимой.
  if (!hasActiveTransient && strength >= 0.5) {
    const transientClusters = priors.clusters.filter(
      (c) => c.role === 'transient',
    );
    const cluster = transientClusters[0];
    if (cluster !== undefined) {
      const freq = cluster.freqBaseHz.median;
      const level = cluster.ampStartLevel.median;
      if (freq !== null && level !== null) {
        apply(
          addTransientClick(patch, {
            freqHz: freq,
            level: level * strength,
          }),
        );
      }
    }
  }

  return { patch, audits };
}
