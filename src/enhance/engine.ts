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
import { calculateRMS } from '../rms';
import { renderSamples } from '../dataset/shared';
import {
  type ArgCreateSynth,
  ampEnvConfigNormales,
  oscConfigNormales,
} from '../synth';
import {
  addTransientClick,
  boostOscillator,
  extendTail,
  removeOscillator,
  scaleLevels,
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

/** Слот профиля тела из приоров (контракт C2). */
export interface BodyProfileSlot {
  rank: number;
  runs: number;
  freqRatio: FeatureDist;
  levelRatio: FeatureDist;
  durRatio: FeatureDist;
  /** Абсолютный свип партиала (freqStart/freqBase), из датасета. */
  sweepRatio?: FeatureDist;
}

/** Сигнатура тела архетипа (контракт C2). */
export interface BodySignature {
  slug: string;
  fundamentalHz: number | null;
  partials: {
    ratio: number | null;
    level: number | null;
    dur: number | null;
    sweep: number | null;
    /** Крутизна частотной огибающей партиала. */
    freqSlope?: number | null;
    /** Протяжённость свипа партиала относительно фундаменталки. */
    freqDurRatio?: number | null;
    /** Крутизна амплитудной огибающей партиала. */
    ampSlope?: number | null;
  }[];
}

/** Файл приоров (контракт C2). */
export interface PriorsFile {
  version: number;
  bodyProfile?: BodyProfileSlot[];
  /** Сигнатуры тел по таргетам: совместные кортежи партиалов. */
  bodySignatures?: BodySignature[];
  /** Семейная норма громкости: распределение RMS эталонов. */
  loudness?: { rms: FeatureDist };
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

/** Уровень старта огибающей, с которого щелчок слышно в миксе. */
const AUDIBLE_TRANSIENT_LEVEL = 0.03;

/**
 * Порог частоты для роли transient, Гц: короткая огибающая у
 * низкочастотного осциллятора — это короткий саб, а не щелчок.
 * Роль смотрит и на огибающую, и на частоту (урок water_12:
 * click не добавился, потому что короткий саб считался щелчком).
 */
const TRANSIENT_MIN_FREQ_HZ = 400;

/** Классифицирует осциллятор по роли из огибающей и частоты. */
export function classifyOscillatorRole(
  group: ArgCreateSynth['oscillators'][number],
): 'sustain' | 'transient' {
  return group.ampEnv.duration <= TRANSIENT_DURATION_SEC &&
    group.osc.freqBase >= TRANSIENT_MIN_FREQ_HZ
    ? 'transient'
    : 'sustain';
}

/**
 * Находит ближайший кластер роли: осциллятор внутри вилки
 * [p10, p90] кластера — свой (нулевое расстояние), снаружи меряем
 * расстояние до ближайшего края вилки. Медиана используется как
 * fallback, когда вилки нет. До этого меряли расстояние до
 * медианы, и широкий кластер терял крайние, но свои осцилляторы
 * (урок water_15: саб 50 Гц на самом краю p10 остался «дальним»).
 */
export function nearestCluster(
  priors: PriorsFile,
  role: 'sustain' | 'transient',
  freqBase: number,
): PriorCluster | null {
  let best: PriorCluster | null = null;
  let bestDist = CLUSTER_MAX_LOG_DISTANCE;
  for (const cluster of priors.clusters) {
    if (cluster.role !== role) {
      continue;
    }
    const lo = cluster.freqBaseHz.p10;
    const hi = cluster.freqBaseHz.p90;
    const median = cluster.freqBaseHz.median;
    let dist: number | null = null;
    if (lo !== null && hi !== null) {
      if (freqBase >= lo && freqBase <= hi) {
        dist = 0;
      } else {
        const edge = freqBase < lo ? lo : hi;
        dist = Math.abs(Math.log(freqBase / edge));
      }
    } else if (median !== null) {
      dist = Math.abs(Math.log(freqBase) - Math.log(median));
    }
    if (dist !== null && dist < bestDist) {
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

  // «Слышимая атака» — не просто transient-осциллятор в патче,
  // а заметный: у water_12 такой сидел с уровнем ~0.01 и глушил
  // добавление настоящего click.
  const hasAudibleTransient = patch.oscillators.some(
    (g) =>
      g.osc.on &&
      classifyOscillatorRole(g) === 'transient' &&
      g.ampEnv.startLevel >= AUDIBLE_TRANSIENT_LEVEL,
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

  // Сначала атака: click — определяющий признак бочки, ему
  // первый слот. Обогащение низа берёт оставшиеся.
  if (!hasAudibleTransient && strength >= 0.5) {
    const transientClusters = priors.clusters.filter(
      (c) => c.role === 'transient',
    );
    const cluster = transientClusters[0];
    if (cluster !== undefined) {
      const freq = cluster.freqBaseHz.median;
      const level = cluster.ampStartLevel.median;
      if (freq !== null && level !== null) {
        const room = ensureFreeSlot({
          patch,
          reason: 'уступил место click-слою',
        });
        if (room !== null) {
          patch = room.patch;
          if (room.removed !== null) {
            audits.push(room.removed);
          }
          apply(
            addTransientClick(patch, {
              freqHz: freq,
              level: level * strength,
            }),
          );
        }
      }
    }
  }

  // Примитивный саб обогащаем партиалами по профилю тела приоров.
  if (strength >= 0.5) {
    const enriched = enrichPrimitiveBody({ patch, priors, strength });
    patch = enriched.patch;
    audits.push(...enriched.audits);
  }

  // Нормализация громкости к семейной норме приоров — последний
  // шаг, чтобы учесть и добавленные компоненты. Цель растёт с
  // силой от медианы к p90: богатые бочки семейства громче
  // медианы, а недостаточность улучшения — в первую очередь про
  // вес низа. Потолок по пику: не загоняем результат в клип.
  const loudness = priors.loudness?.rms;
  const median = loudness?.median;
  if (median !== null && median !== undefined && strength > 0) {
    const p90 = loudness?.p90 ?? median;
    const norm = median * Math.exp(Math.log(p90 / median) * strength);
    const samples = renderSamples(patch, 0.5);
    const current = calculateRMS([...samples].map((s) => s / 32768));
    if (current > 1e-9) {
      const wanted = Math.exp(Math.log(norm / current) * strength);
      const factor = headroomFactor(patch, wanted);
      const scaled = scaleLevels(patch, factor);
      if (scaled.audit !== null) {
        patch = scaled.patch;
        audits.push(scaled.audit);
      }
    }
  }

  return { patch, audits };
}

/** Потолок пика синтеза в долях полной шкалы: запас до жёсткого ±1. */
const HEADROOM_PEAK = 0.98;

/** Шагов бисекции для поиска множителя под потолком. */
const HEADROOM_STEPS = 16;

/** Пик синтеза патча в долях полной шкалы по окну 0.5 с. */
function synthPeak(patch: ArgCreateSynth): number {
  let peak = 0;
  for (const s of renderSamples(patch, 0.5)) {
    const v = Math.abs(s) / 32768;
    if (v > peak) {
      peak = v;
    }
  }
  return peak;
}

/**
 * Самый большой множитель громкости не выше `wanted`, при котором
 * пик синтеза остаётся под потолком. Синтезатор ограничивает сумму
 * осцилляторов значением ±1, поэтому измеренный пик насыщен и
 * занижает превышение: делить на него нельзя, ищем бисекцией по
 * выходу.
 */
function headroomFactor(
  patch: ArgCreateSynth,
  wanted: number,
): number {
  const fits = (k: number): boolean =>
    synthPeak(scaleLevels(patch, k).patch) <= HEADROOM_PEAK;
  if (fits(wanted)) {
    return wanted;
  }
  let lo = 0;
  let hi = wanted;
  for (let i = 0; i < HEADROOM_STEPS; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Ограничивает пик патча потолком, не поднимая громкость. Нужна
 * там, где патч пересобран после масштабирования (доводка).
 */
export function limitPeak(patch: ArgCreateSynth): ArgCreateSynth {
  return scaleLevels(patch, headroomFactor(patch, 1)).patch;
}

/**
 * Индекс самого слабого неслышного активного осциллятора
 * (startLevel ниже порога слышимости) или null, если таких нет.
 * Слышимые осцилляторы место не уступают.
 */
function findWeakestInaudible(patch: ArgCreateSynth): number | null {
  let weakest: number | null = null;
  let weakestScore = Infinity;
  patch.oscillators.forEach((group, index) => {
    if (
      !group.osc.on ||
      group.ampEnv.startLevel >= AUDIBLE_TRANSIENT_LEVEL
    ) {
      return;
    }
    const score = energyProxy(group);
    if (score < weakestScore) {
      weakestScore = score;
      weakest = index;
    }
  });
  return weakest;
}

/**
 * Гармоники обогащения тела по умолчанию: используются, только
 * если у приоров нет вычисленного bodyProfile. Основной источник
 * — профиль из датасета: партиалы реальных бочек не кратны.
 */
const ENRICH_HARMONICS: {
  ratio: number;
  level: number;
  dur: number;
}[] = [
  { ratio: 2, level: 0.35, dur: 0.6 },
  { ratio: 3, level: 0.18, dur: 0.35 },
];

/**
 * Слот обогащения: кортеж партиала. Сверх отношений частоты,
 * уровня и затухания несёт динамику огибающих (крутизну свипа,
 * его протяжённость, крутизну амплитуды) — у партиалов эталонов
 * своя атака высоты, и она часть сигнатуры.
 */
interface EnrichSlot {
  ratio: number;
  level: number;
  dur: number;
  sweep: number | null;
  freqSlope?: number | null;
  freqDurRatio?: number | null;
  ampSlope?: number | null;
}

/**
 * Слоты обогащения для патча: при наличии сигнатур тел — кортежи
 * ближайшего по фундаменталке архетипа (переносим взаимосвязь
 * целиком), иначе послотовые медианы bodyProfile, иначе умолчание
 * 2f/3f. Свип у сигнатур свой у каждого партиала.
 */
function enrichSlots(
  priors: PriorsFile,
  fundHz: number,
): EnrichSlot[] {
  const sigs = priors.bodySignatures;
  if (sigs !== undefined && sigs.length > 0) {
    let best: BodySignature | null = null;
    let bestDist = Infinity;
    for (const sig of sigs) {
      if (sig.fundamentalHz === null) {
        continue;
      }
      const dist = Math.abs(Math.log(sig.fundamentalHz / fundHz));
      if (dist < bestDist) {
        bestDist = dist;
        best = sig;
      }
    }
    if (best !== null) {
      return best.partials
        .filter(
          (
            p,
          ): p is typeof p & {
            ratio: number;
            level: number;
            dur: number;
          } => p.ratio !== null && p.level !== null && p.dur !== null,
        )
        .map((p) => ({
          ratio: p.ratio,
          level: p.level,
          dur: p.dur,
          sweep: p.sweep,
          freqSlope: p.freqSlope ?? null,
          freqDurRatio: p.freqDurRatio ?? null,
          ampSlope: p.ampSlope ?? null,
        }));
    }
  }
  return enrichRatios(priors);
}

/**
 * Отношения для обогащения: из bodyProfile приоров (медианы),
 * иначе из умолчания. Профиль уже несёт уровень и длительность
 * относительно фундаменталки; динамики огибающих в нём нет.
 */
function enrichRatios(priors: PriorsFile): EnrichSlot[] {
  const profile = priors.bodyProfile;
  if (profile === undefined || profile.length === 0) {
    return ENRICH_HARMONICS.map((h) => ({ ...h, sweep: null }));
  }
  return profile
    .filter(
      (s) =>
        s.freqRatio.median !== null &&
        s.levelRatio.median !== null &&
        s.durRatio.median !== null,
    )
    .map((s) => ({
      ratio: s.freqRatio.median ?? 1,
      level: s.levelRatio.median ?? 0,
      dur: s.durRatio.median ?? 1,
      sweep: s.sweepRatio?.median ?? null,
    }));
}

/**
 * Находит фундаменталку патча: самый энергичный sustain-
 * осциллятор в низкой зоне (до 150 Гц), при пустой зоне — самый
 * низкий слышимый sustain. «Самый низкий по частоте» неверен:
 * под телом может сидеть слабый спутник, и профильные уровни,
 * посчитанные от него, выходят копеечными (замер на water_15).
 */
const FUNDAMENTAL_MAX_FREQ_HZ = 150;

function findFundamental(patch: ArgCreateSynth): {
  index: number;
  group: ArgCreateSynth['oscillators'][number];
} | null {
  const candidates: {
    index: number;
    group: ArgCreateSynth['oscillators'][number];
  }[] = [];
  patch.oscillators.forEach((group, index) => {
    if (
      group.osc.on &&
      classifyOscillatorRole(group) === 'sustain' &&
      group.ampEnv.startLevel >= AUDIBLE_TRANSIENT_LEVEL
    ) {
      candidates.push({ index, group });
    }
  });

  let lowest: {
    index: number;
    group: ArgCreateSynth['oscillators'][number];
  } | null = candidates[0] ?? null;
  for (const c of candidates) {
    if (
      lowest === null ||
      c.group.osc.freqBase < lowest.group.osc.freqBase
    ) {
      lowest = c;
    }
  }

  let best: {
    index: number;
    group: ArgCreateSynth['oscillators'][number];
  } | null = null;
  for (const c of candidates) {
    if (c.group.osc.freqBase > FUNDAMENTAL_MAX_FREQ_HZ) {
      continue;
    }
    if (
      best === null ||
      energyProxy(c.group) > energyProxy(best.group)
    ) {
      best = c;
    }
  }

  const chosen = best ?? lowest;
  if (chosen === null) {
    return null;
  }
  return { index: chosen.index, group: chosen.group };
}

/**
 * Доля частоты для «свой партиал уже есть»: существующий
 * осциллятор в пределах ±10% от целевой частоты слота считается
 * покрытием слота и усиливается вместо добавления.
 */
const PARTIAL_MATCH_LOG = Math.log(1.1);

/**
 * Потолок усиления существующего партиала, растёт с силой: при
 * малых — консервативный ×2 (защита иерархии), к strength=1 — ×8.
 * Жёсткий ×2 отдавал лишь 35–70% целевого уровня архетипа (замер
 * на water_12: цели требовали ×2.9–×5.7), отсюда «недостаточность»
 * улучшения при полностью найденных слотах.
 */
function partialBoostCap(strength: number): number {
  return 2 + 6 * strength;
}

/**
 * Освобождает слот для добавления: свободный или за счёт самого
 * слабого неслышного. Возвращает новый патч и аудит вытеснения
 * (null, если слот был свободен); null — если уступать некому.
 */
function ensureFreeSlot(arg: {
  patch: ArgCreateSynth;
  reason: string;
}): { patch: ArgCreateSynth; removed: TransformAudit | null } | null {
  const hasFree = arg.patch.oscillators.some((g) => !g.osc.on);
  if (hasFree) {
    return { patch: arg.patch, removed: null };
  }
  const weakest = findWeakestInaudible(arg.patch);
  if (weakest === null) {
    return null;
  }
  const removed = removeOscillator(arg.patch, weakest, arg.reason);
  if (removed.audit === null) {
    return null;
  }
  return { patch: removed.patch, removed: removed.audit };
}

/**
 * Выравнивает тело по профилю приоров: партиал, которого нет
 * в пределах ±10% частоты слота, добавляется; слабый существующий
 * усиливается к целевому уровню с потолком ×2 (защита иерархии);
 * достаточно громкий не трогается. Частотный sweep фундаменталки
 * сохраняется в добавленных партиалах (та же относительная форма).
 */
function enrichPrimitiveBody(arg: {
  patch: ArgCreateSynth;
  priors: PriorsFile;
  strength: number;
}): { patch: ArgCreateSynth; audits: TransformAudit[] } {
  let patch = arg.patch;
  const audits: TransformAudit[] = [];
  const boostCap = partialBoostCap(arg.strength);
  const fundamental = findFundamental(patch);
  if (fundamental === null) {
    return { patch, audits };
  }
  const base = fundamental.group;
  // Осциллятор потребляется одним слотом: без этого два соседних
  // слота усиливали один и тот же партиал дважды (замер на
  // water_15: 0.124 → 0.248 → 0.409).
  const claimedIndices = new Set<number>();

  for (const harmonic of enrichSlots(
    arg.priors,
    fundamental.group.osc.freqBase,
  )) {
    const targetFreq = base.osc.freqBase * harmonic.ratio;
    const targetLevel =
      base.ampEnv.startLevel * harmonic.level * arg.strength;

    // Уже есть свой партиал у этой частоты? Берём ближайший.
    let existingIndex: number | null = null;
    let existingDist = PARTIAL_MATCH_LOG;
    patch.oscillators.forEach((g, i) => {
      if (!g.osc.on || claimedIndices.has(i)) {
        return;
      }
      const dist = Math.abs(Math.log(g.osc.freqBase / targetFreq));
      if (dist <= existingDist) {
        existingDist = dist;
        existingIndex = i;
      }
    });

    if (existingIndex !== null) {
      const idx: number = existingIndex;
      claimedIndices.add(idx);
      const current = patch.oscillators[idx];
      if (current === undefined) {
        continue;
      }
      const currentLevel = current.ampEnv.startLevel;
      if (currentLevel < targetLevel) {
        const factor = Math.min(boostCap, targetLevel / currentLevel);
        const boosted = boostOscillator(patch, idx, factor);
        if (boosted.audit !== null) {
          patch = boosted.patch;
          audits.push(boosted.audit);
        }
      }
      continue;
    }

    const room = ensureFreeSlot({
      patch,
      reason: 'уступил место партиалу обогащения',
    });
    if (room === null) {
      break;
    }
    patch = room.patch;
    if (room.removed !== null) {
      audits.push(room.removed);
    }
    const slotIndex = patch.oscillators.findIndex((g) => !g.osc.on);
    if (slotIndex === -1) {
      break;
    }
    const clampNum = (v: number, lo: number, hi: number): number =>
      Math.min(hi, Math.max(lo, v));
    const newOsc = {
      osc: {
        on: true,
        freqBase: targetFreq,
        // У партиала — свой свип из профиля эталонов; без профиля
        // делим форму атаки с фундаменталкой.
        freqStart:
          harmonic.sweep !== null
            ? targetFreq * harmonic.sweep
            : base.osc.freqStart * harmonic.ratio,
        // Динамика свипа — тоже из сигнатуры: крутизна и
        // протяжённость (относительно свипа фундаменталки).
        slope: clampNum(
          harmonic.freqSlope ?? base.osc.slope,
          oscConfigNormales.slope.min,
          oscConfigNormales.slope.max,
        ),
        duration: clampNum(
          base.osc.duration * (harmonic.freqDurRatio ?? 1),
          oscConfigNormales.duration.min,
          oscConfigNormales.duration.max,
        ),
        phase: 0,
      },
      ampEnv: {
        duration: base.ampEnv.duration * harmonic.dur,
        endLevel: base.ampEnv.endLevel,
        slope: clampNum(
          harmonic.ampSlope ?? base.ampEnv.slope,
          ampEnvConfigNormales.slope.min,
          ampEnvConfigNormales.slope.max,
        ),
        startLevel: targetLevel,
      },
    };
    patch = {
      oscillators: patch.oscillators.map((g, i) =>
        i === slotIndex ? newOsc : g,
      ),
    };
    audits.push({
      name: 'enrichBody',
      oscillatorIndex: slotIndex,
      detail:
        `добавил партиал ×${harmonic.ratio.toFixed(2)} ` +
        `(${newOsc.osc.freqBase.toFixed(1)} Гц, ` +
        `уровень ${newOsc.ampEnv.startLevel.toFixed(3)})`,
    });
  }
  return { patch, audits };
}
