/**
 * Кандидаты в закон качества: метрики патча и их проверка.
 *
 * Метрики считаются по признакам прогона (features.json), а не по
 * параметрам оптимизатора: закон должен описывать звук, поэтому в
 * отчёте указываем, что именно измерено. Правила Г1–Г5 выведены на
 * одном таргете (BOg) и потому считаются гипотезами, пока не пройдут
 * leave-one-out по остальным эталонам.
 */

/** Срез признаков осциллятора, нужный метрикам. */
export interface LawOsc {
  role: 'sustain' | 'transient';
  freqBase: number;
  freqStartToBase: number;
  ampStartLevel: number;
  /** Время спада до −20 дБ, секунды; null, если не определено. */
  decayDb20Sec: number | null;
}

/** Метрики одного прогона. */
export interface LawMetrics {
  /** Медиана свипа тела (sustain < 100 Гц): > 1 — свип вниз. */
  bodySweepMedian: number | null;
  /** Медиана свипа верха и transient-слоя: около 1 — без свипа. */
  upperSweepMedian: number | null;
  /** Доля sustain-частот в ±30 центах от кратных минимальной. */
  nearIntFraction: number | null;
  /** Доля энергии трёх самых энергичных sustain-осцилляторов. */
  top3Share: number | null;
  /** Максимальная частота среди этих трёх, Гц. */
  top3MaxFreq: number | null;
  /** Число sustain-осцилляторов, на которых считали. */
  sustainCount: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? null;
  }
  const a = sorted[mid - 1];
  const b = sorted[mid];
  return a === undefined || b === undefined ? null : (a + b) / 2;
}

/** Считает метрики прогона по его осцилляторам. */
export function computeLawMetrics(oscs: LawOsc[]): LawMetrics {
  const sustain = oscs.filter((o) => o.role === 'sustain');
  const body = sustain.filter((o) => o.freqBase < 100);
  const upper = oscs.filter(
    (o) => o.role === 'transient' || o.freqBase >= 100,
  );

  let nearIntFraction: number | null = null;
  if (sustain.length > 0) {
    const f0 = Math.min(...sustain.map((o) => o.freqBase));
    const near = sustain.filter((o) => {
      const ratio = o.freqBase / f0;
      const n = Math.max(1, Math.round(ratio));
      const cents = Math.abs(1200 * Math.log2(ratio / n));
      return cents <= 30;
    }).length;
    nearIntFraction = near / sustain.length;
  }

  const energies = sustain
    .filter((o) => o.decayDb20Sec !== null && o.decayDb20Sec > 0)
    .map((o) => ({
      energy: o.ampStartLevel ** 2 * (o.decayDb20Sec ?? 0),
      freq: o.freqBase,
    }))
    .sort((a, b) => b.energy - a.energy);
  const total = energies.reduce((acc, e) => acc + e.energy, 0);
  const top3 = energies.slice(0, 3);

  return {
    bodySweepMedian: median(body.map((o) => o.freqStartToBase)),
    upperSweepMedian: median(upper.map((o) => o.freqStartToBase)),
    nearIntFraction,
    top3Share:
      total > 0
        ? top3.reduce((a, e) => a + e.energy, 0) / total
        : null,
    top3MaxFreq:
      top3.length > 0 ? Math.max(...top3.map((e) => e.freq)) : null,
    sustainCount: sustain.length,
  };
}

/**
 * Под-кластеры тела по пулу сидов: частоты < 120 Гц кластеризуются
 * по log-разрыву 6 %, остаются кластеры, покрытые минимум тремя
 * сидами. Так правило проверялось в разведке BOg: кластеры ищутся
 * по совокупности прогонов, а не внутри одного.
 */
export function pooledBodyClusters(
  perSeedFreqs: number[][],
  minSeedCoverage = 3,
): { count: number; maxSpread: number | null } {
  const points = perSeedFreqs
    .flatMap((freqs, seed) =>
      freqs.filter((f) => f < 120).map((f) => ({ f, seed })),
    )
    .sort((a, b) => a.f - b.f);
  const clusters: { freqs: number[]; seeds: Set<number> }[] = [];
  for (const p of points) {
    const last = clusters[clusters.length - 1];
    const prev = last?.freqs[last.freqs.length - 1];
    if (
      last !== undefined &&
      prev !== undefined &&
      Math.log(p.f / prev) <= Math.log(1.06)
    ) {
      last.freqs.push(p.f);
      last.seeds.add(p.seed);
    } else {
      clusters.push({ freqs: [p.f], seeds: new Set([p.seed]) });
    }
  }
  const kept = clusters.filter(
    (c) => c.seeds.size >= minSeedCoverage,
  );
  const spreads = kept.map((c) => {
    const min = Math.min(...c.freqs);
    const max = Math.max(...c.freqs);
    return max / min - 1;
  });
  return {
    count: kept.length,
    maxSpread: spreads.length > 0 ? Math.max(...spreads) : null,
  };
}
