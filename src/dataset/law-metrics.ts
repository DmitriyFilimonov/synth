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
  /**
   * Доля энергии самого сильного компонента низа (35–200 Гц).
   * Высокая доля означает «низ — одно колебание», а не структуру.
   */
  lowBandTop1Share: number | null;
  /**
   * Эффективное число компонентов низа: экспонента энтропии их
   * энергетических долей. 1 — вся энергия в одном компоненте.
   */
  lowBandEffectiveCount: number | null;
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

/**
 * Сводит метрики прогонов одного таргета в медианы по сидам.
 *
 * @param runs - Метрики отдельных прогонов одного таргета
 * @returns Метрики таргета с медианами доступных значений
 * @remarks Значения null не участвуют в медиане; при чётном числе
 *   значений усредняются два средних. `sustainCount` округляется до
 *   целого. Для пустого входа остальные метрики равны null, а
 *   `sustainCount` — нулю.
 */
export function medianLawMetrics(runs: LawMetrics[]): LawMetrics {
  const pick = (
    get: (metrics: LawMetrics) => number | null,
  ): number | null =>
    median(
      runs
        .map(get)
        .filter((value): value is number => value !== null),
    );
  return {
    bodySweepMedian: pick((metrics) => metrics.bodySweepMedian),
    upperSweepMedian: pick((metrics) => metrics.upperSweepMedian),
    nearIntFraction: pick((metrics) => metrics.nearIntFraction),
    top3Share: pick((metrics) => metrics.top3Share),
    top3MaxFreq: pick((metrics) => metrics.top3MaxFreq),
    lowBandTop1Share: pick((metrics) => metrics.lowBandTop1Share),
    lowBandEffectiveCount: pick(
      (metrics) => metrics.lowBandEffectiveCount,
    ),
    sustainCount: Math.round(
      pick((metrics) => metrics.sustainCount) ?? 0,
    ),
  };
}

interface EnergyFeature {
  energy: number;
  freq: number;
}

/**
 * Считает концентрацию и эффективное число компонентов низа.
 *
 * @param energies - Энергии sustain-компонентов по убыванию энергии
 * @returns Доля сильнейшего в энергии низа и эффективное число
 *   компонентов
 * @remarks Учитываются только компоненты 35–200 Гц с положительной
 *   энергией. Эффективное число — экспонента энтропии их
 *   энергетических долей. Без положительной энергии обе метрики
 *   равны null.
 */
function computeLowBandMetrics(
  energies: EnergyFeature[],
): Pick<LawMetrics, 'lowBandTop1Share' | 'lowBandEffectiveCount'> {
  const lowEnergies = energies
    .filter(
      (feature) =>
        feature.freq >= 35 &&
        feature.freq <= 200 &&
        feature.energy > 0,
    )
    .map((feature) => feature.energy);
  const lowTotal = lowEnergies.reduce(
    (sum, energy) => sum + energy,
    0,
  );
  if (lowTotal <= 0) {
    return { lowBandTop1Share: null, lowBandEffectiveCount: null };
  }
  const shares = lowEnergies.map((energy) => energy / lowTotal);
  return {
    lowBandTop1Share: shares[0] ?? null,
    lowBandEffectiveCount: Math.exp(
      -shares.reduce(
        (entropy, share) =>
          entropy + (share > 0 ? share * Math.log(share) : 0),
        0,
      ),
    ),
  };
}

/**
 * Считает метрики прогона по признакам его осцилляторов.
 *
 * @param oscs - Признаки осцилляторов одного прогона
 * @returns Метрики прогона; отсутствующие значения равны null
 * @remarks Во всех энергетических метриках энергия компонента равна
 *   `ampStartLevel ** 2 * decayDb20Sec`. Для низа учитываются только
 *   sustain-компоненты 35–200 Гц с положительной энергией:
 *   `lowBandTop1Share` — доля сильнейшего из них, а
 *   `lowBandEffectiveCount` — экспонента энтропии энергетических
 *   долей. Если такой энергии нет, обе метрики равны null.
 */
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

  const lowBand = computeLowBandMetrics(energies);

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
    ...lowBand,
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

/** Вход проверки на отложенных таргетах: метрики одного таргета. */
export interface HoldoutTarget {
  slug: string;
  metrics: LawMetrics;
  bodyClusters: number;
  bodyClusterSpread: number | null;
}

/** Итог одного правила: сколько отложенных таргетов его прошло. */
export interface HoldoutRuleResult {
  name: string;
  description: string;
  heldOutPassed: number;
  targets: number;
  details: string[];
}

/** Человеческие формулировки правил для отчёта. */
const RULE_DESCRIPTIONS = {
  bodySweepDown: 'тело свипует вниз: медиана freqStart/freqBase ≥ 1',
  upperSweepFlat:
    'верх и клик без свипа: медиана ≤ max(остальные)·1.05',
  nonHarmonic:
    'спектр негармоничен: доля кратных ≤ max(остальные)+0.02',
  energyHierarchy:
    'топ-3 по энергии: доля ≥ min(остальные), частота ≤ max(остальные)',
  lowEndNotSingle:
    'низ не сведён к одному компоненту: доля top1 ≤ max(остальные)+0.02',
  bodyClusters:
    'под-кластеры тела: 2–4 кластера шириной ≤ 20 % (правило Г2)',
} as const;

type RuleName = keyof typeof RULE_DESCRIPTIONS;

const RULE_NAMES: RuleName[] = [
  'bodySweepDown',
  'upperSweepFlat',
  'nonHarmonic',
  'energyHierarchy',
  'lowEndNotSingle',
  'bodyClusters',
];

interface RuleEvaluation {
  passed: boolean;
  detail: string;
}

/**
 * Собирает непустые значения метрики на обучающих таргетах.
 *
 * @param targets - Обучающие таргеты без отложенного
 * @param pick - Выбор нужной метрики из таргета
 * @returns Значения выбранной метрики без null
 */
function referenceValues(
  targets: HoldoutTarget[],
  pick: (metrics: LawMetrics) => number | null,
): number[] {
  return targets
    .map((target) => pick(target.metrics))
    .filter((value): value is number => value !== null);
}

/**
 * Проверяет направление свипа тела по порогу `bodySweepMedian >= 1`.
 *
 * @param target - Отложенный таргет
 * @returns Признак прохождения и строка со значением для отчёта
 * @remarks Значение null не проходит проверку.
 */
function evaluateBodySweep(target: HoldoutTarget): RuleEvaluation {
  const value = target.metrics.bodySweepMedian;
  return {
    passed: value !== null && value >= 1,
    detail: `${target.slug}: ${value?.toFixed(3) ?? '—'}`,
  };
}

/**
 * Проверяет, что верх не свипует сильнее обучающих таргетов.
 *
 * @param target - Отложенный таргет
 * @param others - Обучающие таргеты без отложенного
 * @returns Признак прохождения и строка с порогом для отчёта
 * @remarks Медиана свипа может превышать максимум остальных таргетов
 *   не более чем в 1,05 раза; null не проходит проверку.
 */
function evaluateUpperSweep(
  target: HoldoutTarget,
  others: HoldoutTarget[],
): RuleEvaluation {
  const value = target.metrics.upperSweepMedian;
  const threshold = Math.max(
    ...referenceValues(others, (metrics) => metrics.upperSweepMedian),
  );
  return {
    passed: value !== null && value <= threshold * 1.05,
    detail: `${target.slug}: ${value?.toFixed(3) ?? '—'} порог ${threshold.toFixed(3)}`,
  };
}

/**
 * Проверяет верхнюю границу доли почти гармонических частот.
 *
 * @param target - Отложенный таргет
 * @param others - Обучающие таргеты без отложенного
 * @returns Признак прохождения и строка с порогом для отчёта
 * @remarks Доля может превышать максимум остальных таргетов не более
 *   чем на 0,02; null не проходит проверку.
 */
function evaluateNonHarmonicity(
  target: HoldoutTarget,
  others: HoldoutTarget[],
): RuleEvaluation {
  const value = target.metrics.nearIntFraction;
  const threshold = Math.max(
    ...referenceValues(others, (metrics) => metrics.nearIntFraction),
  );
  return {
    passed: value !== null && value <= threshold + 0.02,
    detail: `${target.slug}: ${value?.toFixed(3) ?? '—'} порог ${threshold.toFixed(3)}`,
  };
}

/**
 * Проверяет иерархию трёх главных sustain-компонентов по энергии.
 *
 * @param target - Отложенный таргет
 * @param others - Обучающие таргеты без отложенного
 * @returns Признак прохождения и строка с порогом доли для отчёта
 * @remarks Доля энергии должна быть не ниже минимума остальных
 *   таргетов, а максимальная частота — не выше их максимума. Если
 *   одна из метрик равна null, правило не проходит.
 */
function evaluateEnergyHierarchy(
  target: HoldoutTarget,
  others: HoldoutTarget[],
): RuleEvaluation {
  const share = target.metrics.top3Share;
  const maxFreq = target.metrics.top3MaxFreq;
  const shareMin = Math.min(
    ...referenceValues(others, (metrics) => metrics.top3Share),
  );
  const freqMax = Math.max(
    ...referenceValues(others, (metrics) => metrics.top3MaxFreq),
  );
  return {
    passed:
      share !== null &&
      maxFreq !== null &&
      share >= shareMin &&
      maxFreq <= freqMax,
    detail: `${target.slug}: доля ${share?.toFixed(3) ?? '—'} порог ${shareMin.toFixed(3)}`,
  };
}

/**
 * Проверяет кандидата `lowEndNotSingle` по концентрации низа.
 *
 * @param target - Отложенный таргет
 * @param others - Обучающие таргеты без отложенного
 * @returns Признак прохождения и строка с порогом для отчёта
 * @remarks Доля сильнейшего sustain-компонента 35–200 Гц может
 *   превышать максимум остальных таргетов не более чем на 0,02;
 *   null не проходит проверку. Это кандидат, а не доказанный закон.
 */
function evaluateLowEndConcentration(
  target: HoldoutTarget,
  others: HoldoutTarget[],
): RuleEvaluation {
  const value = target.metrics.lowBandTop1Share;
  const threshold = Math.max(
    ...referenceValues(others, (metrics) => metrics.lowBandTop1Share),
  );
  return {
    passed: value !== null && value <= threshold + 0.02,
    detail: `${target.slug}: ${value?.toFixed(3) ?? '—'} порог ${threshold.toFixed(3)}`,
  };
}

/**
 * Проверяет число и ширину воспроизводимых кластеров тела.
 *
 * @param target - Отложенный таргет с пулом кластеров по сидам
 * @returns Признак прохождения и строка с числом кластеров
 * @remarks Правило проходит при 2–4 кластерах шириной не более 20%.
 *   Неизвестная ширина не проходит проверку.
 */
function evaluateBodyClusters(target: HoldoutTarget): RuleEvaluation {
  return {
    passed:
      target.bodyClusters >= 2 &&
      target.bodyClusters <= 4 &&
      (target.bodyClusterSpread ?? 1) <= 0.2,
    detail: `${target.slug}: ${target.bodyClusters} кластеров`,
  };
}

/**
 * Создаёт пустой счётчик одного правила.
 *
 * @param name - Имя правила и ключ его описания
 * @param targetCount - Общее число отложенных таргетов
 * @returns Счётчик без прошедших таргетов и с пустым списком деталей
 */
function createRuleResult(
  name: RuleName,
  targetCount: number,
): HoldoutRuleResult {
  return {
    name,
    description: RULE_DESCRIPTIONS[name],
    heldOutPassed: 0,
    targets: targetCount,
    details: [],
  };
}

/**
 * Записывает результат проверки одного таргета в счётчик правила.
 *
 * @param result - Изменяемый счётчик правила
 * @param evaluation - Итог проверки и строка для отчёта
 * @returns Ничего; изменяет счётчик на месте
 * @remarks Увеличивает `heldOutPassed` только при успешной проверке
 *   и всегда добавляет строку в `details`.
 */
function recordEvaluation(
  result: HoldoutRuleResult,
  evaluation: RuleEvaluation,
): void {
  if (evaluation.passed) {
    result.heldOutPassed += 1;
  }
  result.details.push(evaluation.detail);
}

/**
 * Проверяет правила на отложенных таргетах по схеме leave-one-out.
 *
 * @param targets - Метрики таргетов и сведения о кластерах тела
 * @returns Число прошедших таргетов и детали для каждого правила
 * @remarks Порог каждого правила считается без проверяемого
 *   таргета. `lowEndNotSingle` проверяет только долю сильнейшего
 *   sustain-компонента 35–200 Гц и остаётся кандидатом, а не
 *   доказанным законом. `lowBandEffectiveCount` здесь не используется.
 */
export function evaluateHoldoutRules(
  targets: HoldoutTarget[],
): HoldoutRuleResult[] {
  const results: Record<RuleName, HoldoutRuleResult> = {
    bodySweepDown: createRuleResult('bodySweepDown', targets.length),
    upperSweepFlat: createRuleResult(
      'upperSweepFlat',
      targets.length,
    ),
    nonHarmonic: createRuleResult('nonHarmonic', targets.length),
    energyHierarchy: createRuleResult(
      'energyHierarchy',
      targets.length,
    ),
    lowEndNotSingle: createRuleResult(
      'lowEndNotSingle',
      targets.length,
    ),
    bodyClusters: createRuleResult('bodyClusters', targets.length),
  };

  for (const heldOut of targets) {
    const others = targets.filter(
      (target) => target.slug !== heldOut.slug,
    );
    recordEvaluation(
      results.bodySweepDown,
      evaluateBodySweep(heldOut),
    );
    recordEvaluation(
      results.upperSweepFlat,
      evaluateUpperSweep(heldOut, others),
    );
    recordEvaluation(
      results.nonHarmonic,
      evaluateNonHarmonicity(heldOut, others),
    );
    recordEvaluation(
      results.energyHierarchy,
      evaluateEnergyHierarchy(heldOut, others),
    );
    recordEvaluation(
      results.lowEndNotSingle,
      evaluateLowEndConcentration(heldOut, others),
    );
    recordEvaluation(
      results.bodyClusters,
      evaluateBodyClusters(heldOut),
    );
  }
  return RULE_NAMES.map((name) => results[name]);
}
