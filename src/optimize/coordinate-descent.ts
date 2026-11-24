/* eslint-disable no-console */
import { OSC_PARAMS, clampVolume, initGenome } from './consts';
import { VOLUME_PRUNE_THRESHOLD } from '../consts';
import {
  evaluateSuppressionWindowed,
  estimateFullWindowedEvaluationSampleWork,
  findOptimalScale,
  computeUsefulZone,
  createWaveForm,
  windowSubsampling,
  WaveformCache,
  UsefulZone,
} from './evaluate';
import { tryRelocateOscillator } from './residual-relocation';
import type {
  ProgressEntry,
  ProgressCallback,
  ArgOptimize,
} from './types';
import type { PhaseModel } from '../synth';
import { VECTOR_PARAM_OFFSETS as OFFSET } from '../vector-param-offsets';
import { validateFixedDelaySeconds } from '../fixed-delay';
import {
  createCoordinateDescentSampleWorkCounter,
  snapshotCoordinateDescentSampleWork,
  type CoordinateDescentSampleWorkCounter,
} from './sample-work';

/**
 * Конфигурация алгоритма coordinate descent.
 * Позволяет вызывающему коду менять параметры без правки алгоритма.
 */
export interface CoordinateDescentConfig {
  /** Iterations without improvement before step decay. */
  stagnationExitThreshold: number;
  /** Iterations without improvement before kick/restart. */
  plateauRestartThreshold: number;
  /** Consecutive successes before step grows. */
  stepGrowthThreshold: number;
  /** Step multiplier on stagnation exit. */
  stagnationStepDecayFactor: number;
  /** Min score increase (%) to count as improvement. */
  significantImprovementThreshold: number;
  /** Suppression % for early exit. */
  earlyExitSuppression: number;
  /** Max plateau kicks before full random restart. */
  maxRestartsBeforeRandomRestart: number;
  /** Kick fallback: if score < bestScore × threshold, restore genome. */
  kickFallbackThreshold: number;
  /**
   * Max acceptable regression (p.p.) after a full random restart.
   * If `newScore < bestScore - limit`, the genome is restored from
   * bestGenome. Random restart is meant to explore, so some
   * regression is tolerated; the limit only rejects catastrophic
   * blow-ups (e.g. 50 oscillators randomized to a state with
   * residual RMS ≫ target — score of −100000% and worse).
   */
  randomRestartRegressionLimit: number;
  /** Three-phase step schedule (applies to non-freq/phase params). */
  restartSchedule: Array<{
    startStep: number;
    minStep: number;
    label: string;
  }>;
  /**
   * Сид ГПСЧ. Прогон полностью детерминирован: один и тот же seed при
   * прочих равных даёт идентичный результат. Меняй seed, чтобы взять
   * независимую выборку (мультистарт, оценка дисперсии).
   */
  seed: number;
  /**
   * Модель фазы осциллятора. `legacy` — поведение прежних прогонов;
   * `integral` — звучащая частота совпадает с огибающей частоты.
   */
  phaseModel: PhaseModel;
  /**
   * Неизменные onset по исходным индексам слотов, в секундах. Массив
   * остаётся вне десятипараметрового генома и действует на каждый
   * синтез кандидата, включая кэш, рестарты, relocation, pruning и
   * scale fitting. Отсутствие поля сохраняет обычный match побитово.
   */
  fixedDelaySeconds?: readonly number[];
  /**
   * Неподвижные непрерывные параметры генома (индексы 1–9 внутри
   * каждого десятизначного слота). CD, пинки, рестарты, relocation
   * и scale fitting не меняют эти значения. Пустой список или
   * отсутствие поля сохраняет прежнее поведение.
   */
  frozenParameterIndices?: readonly number[];
  /**
   * Сохраняет исходные флаги on/off: init и рестарты не включают
   * выключенные слоты, а CD и финальный прунинг не переключают флаги.
   * Relocation при этом не запускается. По умолчанию false — прежнее
   * поведение обычного match.
   */
  preserveOscillatorFlags?: boolean;
  /**
   * Окно (в итерациях), на котором проверяется, продолжает ли цикл
   * приносить прогресс. Цикл, исчерпавший свою долю бюджета, но всё
   * ещё улучшающий bestScore быстрее `cycleProgressEpsilon` за окно,
   * продолжает работу вплоть до `cycleReserveFraction`-резерва.
   */
  cycleProgressWindow: number;
  /**
   * Минимальный прирост bestScore (п.п.) за `cycleProgressWindow`
   * итераций, при котором цикл считается всё ещё продуктивным.
   */
  cycleProgressEpsilon: number;
  /**
   * Сколько окон подряд должны недобрать `cycleProgressEpsilon`,
   * прежде чем цикл перестанет продлеваться за мягкий потолок.
   *
   * Одного окна недостаточно: CD движется рывками (плато, затем
   * прорыв через пинок или принятие ухудшения в SA), и одиночное
   * затишье не означает исчерпания цикла. Замер (`Mark Bester`,
   * 300 итераций): приросты по окнам шли +13.04, +0.22, +0.91,
   * +1.68, +0.60, +0.27 п.п. — при пороге в одно окно EXPLORATION
   * обрывался на затишье +0.22, хотя следующее окно дало +1.68.
   */
  cycleProgressMisses: number;
  /**
   * Доля номинальных бюджетов последующих циклов, которую текущий
   * цикл не имеет права занять, даже если продолжает улучшаться.
   * Гарантирует, что финальная полировка не останется без итераций.
   */
  cycleReserveFraction: number;
  /**
   * Fine frequency step (offsets 1, 2), used in the last cycle.
   * Absolute vector step, not a multiplier. Default 1e-7 ≈ 0.002 Hz.
   */
  frequencyStep: number;
  /**
   * Coarse frequency step (offsets 1, 2), used in EXPLORATION.
   * Absolute vector step. Default 1e-4 ≈ 2 Hz.
   */
  frequencyStepCoarse: number;
  /**
   * Refinement frequency step (offsets 1, 2), used in REFINEMENT.
   * Absolute vector step. Default 5e-6 ≈ 0.1 Hz.
   */
  frequencyStepRefine: number;
  /**
   * Phase step in EXPLORATION cycle. Absolute vector step.
   * Default 0.003125 ≈ 1.1°.
   */
  phaseStep: number;
  /** Phase step in REFINEMENT cycle. Default phaseStep / 4 ≈ 0.29°. */
  phaseStepRefine: number;
  /** Phase step in PRECISION cycle. Default phaseStep / 16 ≈ 0.07°. */
  phaseStepPrecision: number;
  /**
   * Simulated annealing: initial temperature in score units (p.p.).
   * A candidate worse by Δ p.p. is accepted with probability
   * exp(-Δ / T). 0 disables SA (pure greedy CD).
   */
  saInitialTemp: number;
  /** Geometric cooling factor applied per iteration. */
  saCoolingRate: number;
  /**
   * Max residual-relocation attempts per oscillator per run.
   * Prevents relocate→mute→relocate cycles on ghost peaks
   * (e.g. targets genuinely consisting of few oscillators).
   * 0 disables relocation entirely.
   */
  maxRelocationAttemptsPerOsc: number;
  /**
   * Min windowed-score improvement (p.p.) for a relocation
   * to be accepted — filters ghost-peak relocations with
   * negligible gain.
   */
  relocationMinImprovement: number;
  /**
   * Превью-оценка первого цикла расписания (по умолчанию
   * EXPLORATION): метрика считает каждое N-ое окно вместо всех
   * (вариант (б) из docs/plan-optimization-acceleration.md).
   * Итерации разведки дешевеют примерно в N раз, а временное
   * покрытие сигнала сохраняется.
   *
   * 1 или отсутствие поля — все окна, поведение побитово прежнее.
   * Подвыборка действует только в первом цикле: при переходе к
   * следующему циклу и перед финальным прунингом метрика
   * возвращается к полной, а опорные score (currentBest, bestScore)
   * пересчитываются на ней, чтобы все сравнения внутри каждого
   * цикла шли на одной метрике.
   */
  explorationWindowStride?: number;
  /**
   * Жёсткий бюджет фактических N-проходов synth/evaluation/cache.
   * CD начинает только такую целую итерацию, чей консервативный предел
   * помещается в остаток. Если финальные стадии не помещаются, возвращает
   * лучший геном целых итераций без скрытого превышения бюджета.
   * Отсутствие поля сохраняет прежний алгоритм и JSON history побитово.
   */
  maxSampleWork?: number;
}

/** Default config values (previous hardcoded constants). */
export const DEFAULT_COORD_DESCENT_CONFIG: CoordinateDescentConfig = {
  stagnationExitThreshold: 4,
  plateauRestartThreshold: 3,
  stepGrowthThreshold: 5,
  stagnationStepDecayFactor: 0.9,
  significantImprovementThreshold: 0.01,
  earlyExitSuppression: 98,
  maxRestartsBeforeRandomRestart: 5,
  kickFallbackThreshold: 0.8,
  randomRestartRegressionLimit: 30,
  restartSchedule: [
    { startStep: 0.025, minStep: 0.01, label: 'EXPLORATION' },
    { startStep: 0.01, minStep: 0.003, label: 'REFINEMENT' },
    { startStep: 0.0025, minStep: 0.0001, label: 'PRECISION' },
  ],
  seed: 1,
  phaseModel: 'legacy',
  cycleProgressWindow: 30,
  cycleProgressEpsilon: 0.5,
  cycleProgressMisses: 2,
  cycleReserveFraction: 0.5,
  frequencyStep: 0.0000001,
  frequencyStepCoarse: 0.0001,
  frequencyStepRefine: 0.000005,
  phaseStep: 0.003125,
  phaseStepRefine: 0.00078125,
  phaseStepPrecision: 0.00019531,
  saInitialTemp: 3,
  saCoolingRate: 0.99,
  maxRelocationAttemptsPerOsc: 3,
  relocationMinImprovement: 0.001,
};

/**
 * Per-parameter step. Frequency uses the caller-selected
 * coarse or fine step; phase is fixed; other params follow
 * the cycle schedule floored at minStep.
 */
const getParamStep = (
  paramIndex: number,
  baseStep: number,
  frequencyStep: number,
  phaseStep: number,
  minStep: number,
): number => {
  const offset = paramIndex % OSC_PARAMS;
  if (offset === OFFSET.freqBase || offset === OFFSET.freqStart) {
    return frequencyStep;
  }
  if (offset === OFFSET.phase) {
    return phaseStep;
  }
  return Math.max(baseStep, minStep);
};

/**
 * Детерминированный ГПСЧ (mulberry32). Один и тот же `seed` даёт
 * побитово одинаковый прогон.
 *
 * `Math.random()` не сидируется, и из-за этого два прогона одной и той
 * же конфигурации расходились: замер на `Danilo Ercole.wav` (250
 * итераций, три прогона) дал 83.07% / 83.74% / 85.94% — разброс
 * 2.87 п.п. При таком шуме любое A/B требовало усреднения по
 * нескольким запускам, а плохой прогон нельзя было воспроизвести
 * для отладки.
 *
 * @param seed - Начальное состояние (любое целое).
 * @returns Функция, возвращающая число в `[0, 1)`.
 */
const createRng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Проверяет индексы анкеров и собирает их в набор для быстрых
 * проверок.
 *
 * @param indices - Абсолютные индексы непрерывных параметров генома;
 *   undefined означает отсутствие анкеров
 * @param genomeLength - Общая длина генома
 * @returns Набор уникальных индексов анкеров
 * @throws Error если индекс не целый, выходит за геном или указывает
 *   на флаг on/off вместо непрерывного параметра
 * @remarks Пустой набор оставляет обычный match без анкеров.
 */
const createFrozenParameterSet = (
  indices: readonly number[] | undefined,
  genomeLength: number,
): ReadonlySet<number> => {
  const frozen = new Set<number>();
  for (const index of indices ?? []) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= genomeLength ||
      index % OSC_PARAMS === OFFSET.flag
    ) {
      throw new Error(
        `Invalid frozen parameter index ${index}; expected a continuous parameter within the genome`,
      );
    }
    frozen.add(index);
  }
  return frozen;
};

/**
 * Проверяет, закреплён ли хотя бы один непрерывный параметр слота.
 *
 * @param frozen - Набор абсолютных индексов анкеров
 * @param base - Индекс начала слота осциллятора в геноме
 * @returns true, если среди смещений 1–9 есть анкер
 * @remarks CD использует эту проверку, чтобы relocation не переписал
 *   осциллятор, часть параметров которого закреплена.
 */
const hasFrozenOscillatorParameter = (
  frozen: ReadonlySet<number>,
  base: number,
): boolean => {
  for (let offset = OFFSET.freqBase; offset < OSC_PARAMS; offset++) {
    if (frozen.has(base + offset)) {
      return true;
    }
  }
  return false;
};

/**
 * Выбирает непрерывный параметр для плато-пинка среди свободных
 * слотов.
 *
 * @param enabledOscs - Индексы включённых осцилляторов
 * @param frozen - Набор абсолютных индексов анкеров
 * @param rng - Сидируемый ГПСЧ оптимизатора
 * @returns Осциллятор, смещение и абсолютный индекс параметра; null,
 *   если все параметры включённых осцилляторов заморожены
 * @remarks Без анкеров функция сохраняет прежний выбор и порядок двух
 *   обращений к ГПСЧ, поэтому обычный match не меняется.
 */
const selectKickParameter = (
  enabledOscs: readonly number[],
  frozen: ReadonlySet<number>,
  rng: () => number,
): { osc: number; param: number; index: number } | null => {
  if (frozen.size === 0) {
    const osc =
      enabledOscs[Math.floor(rng() * enabledOscs.length)] ?? 0;
    const param =
      OFFSET.freqBase +
      Math.floor(rng() * (OSC_PARAMS - OFFSET.freqBase));
    return { osc, param, index: osc * OSC_PARAMS + param };
  }
  const candidates: { osc: number; param: number; index: number }[] =
    [];
  for (const osc of enabledOscs) {
    for (let param = OFFSET.freqBase; param < OSC_PARAMS; param++) {
      const index = osc * OSC_PARAMS + param;
      if (!frozen.has(index)) {
        candidates.push({ osc, param, index });
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  return candidates[Math.floor(rng() * candidates.length)] ?? null;
};

const optimizeSingleParameter = (
  genome: number[],
  waveformCache: WaveformCache,
  paramIndex: number,
  step: number,
  targetSignal: readonly number[],
  sampleRate: number,
  currentBest: number,
  usefulZone: UsefulZone,
  rng: () => number,
  temperature = 0,
  sampleWork?: CoordinateDescentSampleWorkCounter,
): {
  genome: number[];
  score: number;
} => {
  const center = genome[paramIndex] ?? 0;
  const isVolume = paramIndex % OSC_PARAMS === OFFSET.startLevel;

  const candidates = isVolume
    ? [
        clampVolume(center * (1 - step)),
        clampVolume(center * (1 + step)),
      ]
    : [Math.max(0, center - step), Math.min(1, center + step)];

  let bestScore = currentBest;
  let bestValue = center;
  // Кандидаты, ухудшающие score, — материал для SA-accept: лучший
  // из ухудшающих рассматривается, если greedy-улучшения не нашлось.
  let bestWorseScore = -Infinity;
  let bestWorseValue = center;

  for (const candVal of candidates) {
    waveformCache.setParam(paramIndex, candVal);
    const score = evaluateSuppressionWindowed(
      waveformCache.getWaveform(),
      targetSignal,
      sampleRate,
      usefulZone,
      sampleWork,
    );
    if (score > bestScore) {
      bestScore = score;
      bestValue = candVal;
    } else if (score > bestWorseScore) {
      bestWorseScore = score;
      bestWorseValue = candVal;
    }
  }

  // Simulated annealing: если greedy-улучшения нет, принимаем
  // ухудшение с вероятностью exp(-Δ / T). Это позволяет выйти
  // из локального минимума, в котором greedy CD застревает.
  if (
    temperature > 0 &&
    bestValue === center &&
    bestWorseScore > -Infinity
  ) {
    const delta = currentBest - bestWorseScore;
    if (delta > 0 && rng() < Math.exp(-delta / temperature)) {
      bestScore = bestWorseScore;
      bestValue = bestWorseValue;
    }
  }

  waveformCache.setParam(paramIndex, bestValue);
  genome[paramIndex] = bestValue;

  return {
    genome,
    score: bestScore,
  };
};

const syncFlagsToCache = (
  genome: readonly number[],
  waveformCache: WaveformCache,
  numOsc: number,
): void => {
  for (let osc = 0; osc < numOsc; osc++) {
    waveformCache.setParam(
      osc * OSC_PARAMS + OFFSET.flag,
      genome[osc * OSC_PARAMS + OFFSET.flag] ?? 0,
    );
  }
};

/**
 * Хранит зависимости и ограничения, общие для всех осцилляторов
 * внутри одной итерации coordinate descent.
 */
interface IterationContext {
  waveformCache: WaveformCache;
  targetSignal: readonly number[];
  sampleRate: number;
  step: number;
  firstOscMinVol: number;
  frequencyStep: number;
  phaseStep: number;
  minStep: number;
  usefulZone: UsefulZone;
  rng: () => number;
  temperature: number;
  relocationAttempts?: number[];
  maxRelocationAttemptsPerOsc: number;
  relocationMinImprovement: number;
  frozenParameterIndices: ReadonlySet<number>;
  preserveOscillatorFlags: boolean;
  sampleWork?: CoordinateDescentSampleWorkCounter;
}

/**
 * Подбирает непрерывные параметры одного включённого осциллятора.
 *
 * @param genome - Геном, который функция меняет по мере подбора
 * @param osc - Индекс осциллятора
 * @param currentBest - Windowed-score до обхода параметров
 * @param context - Метрика, шаги, ГПСЧ и ограничения итерации
 * @returns Тот же геном с выбранными значениями и его score
 * @remarks Закреплённые параметры пропускаются. Уровень первого
 *   осциллятора не опускается ниже его стартового значения, если этот
 *   параметр свободен. Каждый кандидат обновляет общий waveformCache.
 */
const optimizeOscillatorParameters = (
  genome: number[],
  osc: number,
  currentBest: number,
  context: IterationContext,
): { genome: number[]; score: number } => {
  const {
    waveformCache,
    targetSignal,
    sampleRate,
    step,
    firstOscMinVol,
    frequencyStep,
    phaseStep,
    minStep,
    usefulZone,
    rng,
    temperature,
    frozenParameterIndices,
    sampleWork,
  } = context;
  const base = osc * OSC_PARAMS;
  let score = currentBest;

  for (let p: number = OFFSET.freqBase; p < OSC_PARAMS; p++) {
    const i = base + p;
    if (frozenParameterIndices.has(i)) {
      continue;
    }
    const effectiveStep = getParamStep(
      i,
      step,
      frequencyStep,
      phaseStep,
      minStep,
    );
    const result = optimizeSingleParameter(
      genome,
      waveformCache,
      i,
      effectiveStep,
      targetSignal,
      sampleRate,
      score,
      usefulZone,
      rng,
      temperature,
      sampleWork,
    );
    genome = result.genome;
    score = result.score;

    if (
      osc === 0 &&
      p === OFFSET.startLevel &&
      !frozenParameterIndices.has(OFFSET.startLevel)
    ) {
      const minVol = Math.max(
        firstOscMinVol,
        genome[OFFSET.startLevel] ?? 0,
      );
      waveformCache.setParam(OFFSET.startLevel, minVol);
      genome[OFFSET.startLevel] = minVol;
    }
  }

  return { genome, score };
};

/**
 * Переставляет слабый осциллятор на пик остатка или проверяет его
 * выключение.
 *
 * @param genome - Геном, который меняется при принятии операции
 * @param osc - Индекс проверяемого осциллятора
 * @param currentBest - Windowed-score до relocation или прунинга
 * @param context - Кэш, таргет и ограничения текущей итерации
 * @returns Score после принятой операции либо прежний score
 * @remarks Выключенные и достаточно громкие осцилляторы не меняются.
 *   При preserveOscillatorFlags=true функция ничего не делает. Она не
 *   запускает relocation, если исчерпан лимит попыток или хотя бы один
 *   параметр слота закреплён. После отказа от relocation выключение
 *   принимается только при росте score.
 */
const relocateOrPruneOscillator = (
  genome: number[],
  osc: number,
  currentBest: number,
  context: IterationContext,
): number => {
  const {
    waveformCache,
    targetSignal,
    sampleRate,
    usefulZone,
    relocationAttempts,
    maxRelocationAttemptsPerOsc,
    relocationMinImprovement,
    frozenParameterIndices,
    preserveOscillatorFlags,
    sampleWork,
  } = context;
  const base = osc * OSC_PARAMS;
  const volume = genome[base + OFFSET.startLevel] ?? 0;
  if (
    preserveOscillatorFlags ||
    (genome[base] ?? 0) < 0.5 ||
    volume > VOLUME_PRUNE_THRESHOLD
  ) {
    return currentBest;
  }

  const attemptsUsed = relocationAttempts?.[osc] ?? 0;
  const relocationAllowed =
    maxRelocationAttemptsPerOsc > 0 &&
    attemptsUsed < maxRelocationAttemptsPerOsc &&
    !hasFrozenOscillatorParameter(frozenParameterIndices, base);
  const relocation = relocationAllowed
    ? tryRelocateOscillator({
        genome,
        waveformCache,
        oscIndex: osc,
        targetSignal,
        sampleRate,
        currentScore: currentBest,
        usefulZone,
        minImprovement: relocationMinImprovement,
        sampleWork,
      })
    : { relocated: false, score: currentBest };
  if (relocationAttempts && relocationAllowed) {
    relocationAttempts[osc] = attemptsUsed + 1;
  }
  if (relocation.relocated) {
    return relocation.score;
  }

  waveformCache.setParam(base, 0);
  const scoreOff = evaluateSuppressionWindowed(
    waveformCache.getWaveform(),
    targetSignal,
    sampleRate,
    usefulZone,
    sampleWork,
  );
  if (scoreOff > currentBest) {
    genome[base] = 0;
    return scoreOff;
  }
  waveformCache.setParam(base, 1);
  return currentBest;
};

/**
 * Выполняет одну итерацию coordinate descent.
 *
 * @param genome - Геном, который мутируют локальные подборы
 * @param numOsc - Число осцилляторов в геноме
 * @param currentBest - Score перед итерацией
 * @param context - Общие зависимости, шаги и ограничения итерации
 * @returns Обновлённые геном и windowed-score
 * @remarks Для каждого активного осциллятора сначала подбирает
 *   свободные параметры, затем вызывает relocation или prune. При
 *   preserveOscillatorFlags=true флаги не меняются, а обходные
 *   операции пропускаются.
 */
const optimizeIteration = (
  genome: number[],
  numOsc: number,
  currentBest: number,
  context: IterationContext,
): { genome: number[]; score: number } => {
  let score = currentBest;
  const { waveformCache, preserveOscillatorFlags } = context;

  if (!preserveOscillatorFlags && (genome[OFFSET.flag] ?? 0) !== 1) {
    waveformCache.setParam(OFFSET.flag, 1);
    genome[OFFSET.flag] = 1;
  }

  for (let osc = 0; osc < numOsc; osc++) {
    const base = osc * OSC_PARAMS + OFFSET.flag;
    if ((genome[base] ?? 0) < 0.5) {
      continue;
    }
    const optimized = optimizeOscillatorParameters(
      genome,
      osc,
      score,
      context,
    );
    genome = optimized.genome;
    score = relocateOrPruneOscillator(
      genome,
      osc,
      optimized.score,
      context,
    );
  }

  return { genome, score };
};

/**
 * Финальный прунинг: отключает осцилляторы со startLevel ниже
 * prune-порога, если это не роняет score.
 *
 * @param genome - Геном, в котором флаги отключаемых osc получают 0
 * @param waveformCache - Кэш waveform, синхронизирован с геномом
 * @param targetSignal - Эталонный сигнал
 * @param _currentBest - Прежняя оценка; не используется, потому что
 *   функция пересчитывает стартовый score непосредственно из кэша
 * @param numOsc - Число осцилляторов в геноме
 * @param sampleRate - Частота дискретизации, Гц
 * @param usefulZone - Полезная зона таргета для метрики
 * @returns Windowed-score после прунинга
 * @remarks Кандидаты (volume < VOLUME_PRUNE_THRESHOLD) отключаются
 *   в порядке возрастания volume; отключение откатывается, если
 *   score падает больше чем на 0.05 п.п. Метрика — та же windowed,
 *   что и в основном цикле CD: prune-решения и bestScore-сравнение
 *   идут по одной шкале.
 */
const finalPruneOscillators = (
  genome: number[],
  waveformCache: WaveformCache,
  targetSignal: readonly number[],
  _currentBest: number,
  numOsc: number,
  sampleRate: number,
  usefulZone: UsefulZone,
  sampleWork?: CoordinateDescentSampleWorkCounter,
): number => {
  const pruneCandidates: { base: number; volume: number }[] = [];
  for (let osc = 0; osc < numOsc; osc++) {
    const base = osc * OSC_PARAMS;
    const volume = genome[base + OFFSET.startLevel] ?? 0;
    if (volume < VOLUME_PRUNE_THRESHOLD) {
      pruneCandidates.push({ base, volume });
    }
  }
  pruneCandidates.sort((a, b) => a.volume - b.volume);

  // Стартовый score считаем честно от кэша, а не доверяем
  // currentBest: он может устареть относительно текущего генома
  // (например, после random restart), и тогда откаты prune-решений
  // сравнивались бы с лживым значением.
  let score = evaluateSuppressionWindowed(
    waveformCache.getWaveform(),
    targetSignal,
    sampleRate,
    usefulZone,
    sampleWork,
  );
  for (const { base } of pruneCandidates) {
    const savedFlag = genome[base] ?? 0;
    genome[base] = 0;
    waveformCache.setParam(base, 0);
    // Windowed-метрика, консистентная с основным циклом CD:
    // prune-решения и bestScore-сравнение по одной шкале.
    const scoreAfter = evaluateSuppressionWindowed(
      waveformCache.getWaveform(),
      targetSignal,
      sampleRate,
      usefulZone,
      sampleWork,
    );
    if (score - scoreAfter > 0.05) {
      genome[base] = savedFlag;
      waveformCache.setParam(base, savedFlag);
    } else {
      score = scoreAfter;
    }
  }

  return score;
};

const normalizeFlags = (genome: number[], numOsc: number): void => {
  for (let osc = 0; osc < numOsc; osc++) {
    const index = osc * OSC_PARAMS + OFFSET.flag;
    const flag = genome[index] ?? 0;
    genome[index] = flag >= 0.5 ? 1 : 0;
  }
};

const emitProgress = (
  history: ProgressEntry[],
  onProgress: ProgressCallback | undefined,
  iteration: number,
  suppressionPercent: number,
  cycle?: string,
  bestVector?: readonly number[],
  work?: {
    counter: CoordinateDescentSampleWorkCounter;
    maxSampleWork: number;
    budgetStop?: boolean;
    finalStagesSkipped?: boolean;
  },
): void => {
  const entry: ProgressEntry = {
    iteration,
    suppressionPercent,
    cycle,
  };
  if (bestVector !== undefined) {
    entry.bestVector = bestVector;
  }
  if (work !== undefined) {
    entry.sampleWork = snapshotCoordinateDescentSampleWork(
      work.counter,
    );
    entry.maxSampleWork = work.maxSampleWork;
    if (work.budgetStop === true) {
      entry.workBudgetStop = true;
    }
    if (work.finalStagesSkipped !== undefined) {
      entry.finalStagesSkipped = work.finalStagesSkipped;
    }
  }
  history.push(entry);
  onProgress?.(entry);
};

/** Результат оптимизации: финальный вектор и история прогресса. */
interface OptimizeResult {
  vector: number[];
  history: ProgressEntry[];
}

/**
 * Содержит неизменяемые зависимости и настройки одного прогона
 * coordinate descent.
 */
interface DescentContext {
  initialVector: readonly number[];
  targetSignal: readonly number[];
  sampleRate: number;
  maxIterations: number;
  onProgress?: ProgressCallback;
  cfg: CoordinateDescentConfig;
  numOsc: number;
  waveformCache: WaveformCache;
  usefulZone: UsefulZone;
  history: ProgressEntry[];
  rng: () => number;
  relocationAttempts: number[];
  firstOscInitVolume: number;
  stepGrowthAdd: number;
  stepDecayFactor: number;
  frozenParameterIndices: ReadonlySet<number>;
  preserveOscillatorFlags: boolean;
  sampleWork?: CoordinateDescentSampleWorkCounter;
}

/**
 * Хранит изменяемое состояние прогона: текущий и лучший геномы,
 * счётчики итераций, циклов, плато и охлаждения.
 */
interface DescentState {
  genome: number[];
  currentBest: number;
  bestGenome: number[];
  bestScore: number;
  iter: number;
  cycleIndex: number;
  lastCycleLabel?: string;
  temperature: number;
  stagnation: number;
  plateauCount: number;
  restartCount: number;
  consecutiveSuccesses: number;
  workBudgetExhausted: boolean;
}

/** Добавляет work-поля только в явно ограниченный прогон. */
function progressWork(
  context: DescentContext,
  state: DescentState,
  finalStagesSkipped?: boolean,
):
  | {
      counter: CoordinateDescentSampleWorkCounter;
      maxSampleWork: number;
      budgetStop?: boolean;
      finalStagesSkipped?: boolean;
    }
  | undefined {
  const maxSampleWork = context.cfg.maxSampleWork;
  if (
    context.sampleWork === undefined ||
    maxSampleWork === undefined
  ) {
    return undefined;
  }
  return {
    counter: context.sampleWork,
    maxSampleWork,
    ...(state.workBudgetExhausted ? { budgetStop: true } : {}),
    ...(finalStagesSkipped === undefined
      ? {}
      : { finalStagesSkipped }),
  };
}

/**
 * Пересчитывает текущий и лучший score после смены метрики.
 *
 * @param context - Таргет, полезная зона, кэш и модель фазы прогона
 * @param state - Состояние, которое получает пересчитанные значения
 * @returns Ничего; обновляет state на месте
 * @remarks Текущий score вычисляется из waveformCache, а прежний
 *   лучший геном синтезируется заново. Если текущий геном не хуже, он
 *   становится новым лучшим. Это не даёт сравнивать превью- и полную
 *   шкалы на границе циклов.
 */
const rescaleScoresToCurrentMetric = (
  context: DescentContext,
  state: DescentState,
): void => {
  const {
    targetSignal,
    sampleRate,
    usefulZone,
    waveformCache,
    cfg,
    sampleWork,
  } = context;
  const current = evaluateSuppressionWindowed(
    waveformCache.getWaveform(),
    targetSignal,
    sampleRate,
    usefulZone,
    sampleWork,
  );
  const bestEver = evaluateSuppressionWindowed(
    createWaveForm(
      state.bestGenome,
      sampleRate,
      targetSignal.length,
      {
        phaseModel: cfg.phaseModel,
        fixedDelaySeconds: cfg.fixedDelaySeconds,
        sampleWork,
      },
    ),
    targetSignal,
    sampleRate,
    usefulZone,
    sampleWork,
  );
  state.currentBest = current;
  if (current >= bestEver) {
    state.bestScore = current;
    state.bestGenome = state.genome.slice();
  } else {
    state.bestScore = bestEver;
  }
};

/** Передаёт обработчикам плато снимок состояния и зависимости CD. */
interface PlateauContext {
  initialVector: readonly number[];
  genome: number[];
  bestGenome: number[];
  bestScore: number;
  currentBest: number;
  waveformCache: WaveformCache;
  targetSignal: readonly number[];
  sampleRate: number;
  usefulZone: UsefulZone;
  numOsc: number;
  rng: () => number;
  frozenParameterIndices: ReadonlySet<number>;
  preserveOscillatorFlags: boolean;
  cfg: CoordinateDescentConfig;
  iter: number;
  restartCount: number;
  isLastCycle: boolean;
  step: number;
  stepDecayFactor: number;
  history: ProgressEntry[];
  onProgress?: ProgressCallback;
  cycleLabel: string;
  sampleWork?: CoordinateDescentSampleWorkCounter;
}

/**
 * Случайно меняет свободные параметры и откатывает катастрофический
 * рестарт.
 *
 * @param context - Исходный вектор, лучший геном и зависимости метрики
 * @returns Новый геном и соответствующий ему текущий score
 * @remarks Флаги on/off и закреплённые параметры сохраняются. После
 *   пересинтеза кэша функция заново считает score. Если результат ниже
 *   лучшего больше чем на randomRestartRegressionLimit, она
 *   восстанавливает лучший геном и его score.
 */
const performRandomRestart = (
  context: PlateauContext,
): { genome: number[]; currentBest: number } => {
  const {
    initialVector,
    bestGenome,
    bestScore,
    waveformCache,
    targetSignal,
    sampleRate,
    usefulZone,
    numOsc,
    rng,
    frozenParameterIndices,
    preserveOscillatorFlags,
    cfg,
    iter,
    restartCount,
    sampleWork,
  } = context;
  console.log(
    `[CoordDescent] Random restart at iter ${iter} (best=${bestScore.toFixed(4)}%, restarts=${restartCount})`,
  );
  let genome = initGenome(initialVector, preserveOscillatorFlags).map(
    (v, idx) => {
      if (
        idx % OSC_PARAMS === OFFSET.flag ||
        frozenParameterIndices.has(idx)
      ) {
        return v;
      }
      return rng();
    },
  );
  waveformCache.rebuild(genome);
  syncFlagsToCache(genome, waveformCache, numOsc);
  let currentBest = evaluateSuppressionWindowed(
    waveformCache.getWaveform(),
    targetSignal,
    sampleRate,
    usefulZone,
    sampleWork,
  );

  if (currentBest < bestScore - cfg.randomRestartRegressionLimit) {
    console.log(
      `[CoordDescent] Random restart catastrophic (` +
        `score=${currentBest.toFixed(2)}%, best=` +
        `${bestScore.toFixed(2)}%), restoring from best`,
    );
    genome = bestGenome.slice();
    waveformCache.rebuild(genome);
    syncFlagsToCache(genome, waveformCache, numOsc);
    currentBest = bestScore;
  }
  return { genome, currentBest };
};

/**
 * Случайно меняет один свободный параметр на плато и при провале
 * восстанавливает лучший геном.
 *
 * @param context - Текущий и лучший геномы, ГПСЧ и настройки CD
 * @returns Геном после пинка или отката и его текущий score
 * @remarks Функция выбирает параметр только среди включённых
 *   осцилляторов. Если все кандидаты закреплены, она ничего не меняет.
 *   Откат срабатывает при падении ниже bestScore, умноженного на
 *   kickFallbackThreshold; кэш после него синхронизируется с геномом.
 */
const performPlateauKick = (
  context: PlateauContext,
): { genome: number[]; currentBest: number } => {
  const {
    bestGenome,
    bestScore,
    waveformCache,
    targetSignal,
    sampleRate,
    usefulZone,
    numOsc,
    rng,
    frozenParameterIndices,
    cfg,
    iter,
    restartCount,
    sampleWork,
  } = context;
  let { genome, currentBest } = context;
  const enabledOscs: number[] = [];
  for (let osc = 0; osc < numOsc; osc++) {
    if ((genome[osc * OSC_PARAMS + OFFSET.flag] ?? 0) >= 0.5) {
      enabledOscs.push(osc);
    }
  }
  if (enabledOscs.length === 0) {
    enabledOscs.push(0);
  }
  const kick = selectKickParameter(
    enabledOscs,
    frozenParameterIndices,
    rng,
  );
  if (kick === null) {
    console.log(
      `[CoordDescent] Plateau kick skipped: all enabled parameters are frozen`,
    );
    return { genome, currentBest };
  }

  console.log(
    `[CoordDescent] Plateau kick at iter ${iter}: osc[${kick.osc}].p[${kick.param}] (restart=${restartCount})`,
  );
  genome[kick.index] = rng();
  waveformCache.setParam(kick.index, genome[kick.index] ?? 0);
  syncFlagsToCache(genome, waveformCache, numOsc);
  currentBest = evaluateSuppressionWindowed(
    waveformCache.getWaveform(),
    targetSignal,
    sampleRate,
    usefulZone,
    sampleWork,
  );

  if (currentBest < bestScore * cfg.kickFallbackThreshold) {
    console.log(`[CoordDescent] Kick failed, restarting from best`);
    genome = bestGenome.slice();
    waveformCache.rebuild(genome);
    syncFlagsToCache(genome, waveformCache, numOsc);
    currentBest = bestScore;
  }
  return { genome, currentBest };
};

/**
 * Обрабатывает плато рестартом или одиночным пинком и уменьшает шаг.
 *
 * @param context - Постоянные зависимости и настройки прогона
 * @param state - Изменяемое состояние спуска
 * @param step - Шаг непрерывных параметров до обработки плато
 * @param cycleLabel - Метка цикла для записи прогресса
 * @param isLastCycle - Признак финального greedy-цикла
 * @returns Новый шаг после умножения на stepDecayFactor
 * @remarks Полный random restart запрещён в последнем цикле: там
 *   остаётся только пинк. Функция обновляет геном и score в state,
 *   отправляет прогресс и сбрасывает счётчики плато и серии успехов.
 */
const handlePlateau = (
  context: DescentContext,
  state: DescentState,
  step: number,
  cycleLabel: string,
  isLastCycle: boolean,
): number => {
  state.restartCount++;
  const wantsRandomRestart =
    state.restartCount >= context.cfg.maxRestartsBeforeRandomRestart;
  if (wantsRandomRestart && isLastCycle) {
    state.restartCount = 0;
  }
  const plateauContext: PlateauContext = {
    initialVector: context.initialVector,
    genome: state.genome,
    bestGenome: state.bestGenome,
    bestScore: state.bestScore,
    currentBest: state.currentBest,
    waveformCache: context.waveformCache,
    targetSignal: context.targetSignal,
    sampleRate: context.sampleRate,
    usefulZone: context.usefulZone,
    numOsc: context.numOsc,
    rng: context.rng,
    frozenParameterIndices: context.frozenParameterIndices,
    preserveOscillatorFlags: context.preserveOscillatorFlags,
    cfg: context.cfg,
    iter: state.iter,
    restartCount: state.restartCount,
    isLastCycle,
    step,
    stepDecayFactor: context.stepDecayFactor,
    history: context.history,
    onProgress: context.onProgress,
    cycleLabel,
    sampleWork: context.sampleWork,
  };

  if (wantsRandomRestart && !isLastCycle) {
    const restarted = performRandomRestart(plateauContext);
    state.genome = restarted.genome;
    state.currentBest = restarted.currentBest;
    state.restartCount = 0;
  } else {
    const kicked = performPlateauKick(plateauContext);
    state.genome = kicked.genome;
    state.currentBest = kicked.currentBest;
  }

  emitProgress(
    context.history,
    context.onProgress,
    state.iter,
    state.currentBest,
    cycleLabel,
    undefined,
    progressWork(context, state),
  );
  state.plateauCount = 0;
  state.consecutiveSuccesses = 0;
  const nextStep = step * context.stepDecayFactor;
  console.log(
    `[CoordDescent] Step decayed to ${nextStep.toFixed(8)} (×${context.stepDecayFactor.toFixed(2)})`,
  );
  return nextStep;
};

/** Передаёт scale fitting геном, метрику и ограничения анкеров. */
interface ScaleFittingContext {
  genome: number[];
  waveformCache: WaveformCache;
  targetSignal: readonly number[];
  sampleRate: number;
  usefulZone: UsefulZone;
  numOsc: number;
  phaseModel: PhaseModel;
  fixedDelaySeconds?: readonly number[];
  frozenParameterIndices: ReadonlySet<number>;
  sampleWork?: CoordinateDescentSampleWorkCounter;
}

/**
 * Подбирает общий масштаб громкости и принимает его только при росте
 * windowed-score.
 *
 * @param context - Геном, waveformCache, таргет и анкеры прогона
 * @returns Исходный или отмасштабированный геном и его новый score
 * @remarks Если закреплён хотя бы один startLevel, масштаб не
 *   применяется. Иначе функция отдельно синтезирует кандидата и
 *   переоценивает его, а не использует score промежуточного waveform.
 *   Кандидат и перестроенный кэш получают тот же fixed-delay sidecar.
 *   При принятии она перестраивает основной кэш.
 */
const applyScaleFitting = (
  context: ScaleFittingContext,
): { genome: number[]; currentBest: number } => {
  const {
    waveformCache,
    targetSignal,
    sampleRate,
    usefulZone,
    numOsc,
    phaseModel,
    fixedDelaySeconds,
    frozenParameterIndices,
    sampleWork,
  } = context;
  let { genome } = context;

  console.log(`[CoordDescent] Phase 2: Scale fitting...`);
  const generated = waveformCache.getWaveform();
  const preScaleScore = evaluateSuppressionWindowed(
    generated,
    targetSignal,
    sampleRate,
    usefulZone,
    sampleWork,
  );
  const { scale, suppressionPercent: scaleScore } = findOptimalScale(
    generated,
    targetSignal,
    sampleRate,
    usefulZone,
    sampleWork,
  );
  console.log(
    `[CoordDescent] Optimal scale: ${scale.toFixed(4)} (waveform probe ${scaleScore.toFixed(4)}%)`,
  );

  const hasFrozenVolume = [...frozenParameterIndices].some(
    (index) => index % OSC_PARAMS === OFFSET.startLevel,
  );
  let currentBest = preScaleScore;
  if (scale !== 1 && !hasFrozenVolume) {
    const scaledGenome = genome.slice();
    for (let osc = 0; osc < numOsc; osc++) {
      const base = osc * OSC_PARAMS;
      const volIdx = base + OFFSET.startLevel;
      const currentVol = scaledGenome[volIdx] ?? 0;
      scaledGenome[volIdx] = clampVolume(currentVol * scale);
    }
    const scaledCache = new WaveformCache(
      scaledGenome,
      sampleRate,
      targetSignal.length,
      phaseModel,
      fixedDelaySeconds,
      sampleWork,
    );
    const scaledScore = evaluateSuppressionWindowed(
      scaledCache.getWaveform(),
      targetSignal,
      sampleRate,
      usefulZone,
      sampleWork,
    );
    if (scaledScore > preScaleScore) {
      genome = scaledGenome;
      waveformCache.rebuild(genome);
      syncFlagsToCache(genome, waveformCache, numOsc);
      currentBest = scaledScore;
      console.log(
        `[CoordDescent] Scale fitting applied: ${preScaleScore.toFixed(4)}% -> ${scaledScore.toFixed(4)}%`,
      );
    } else {
      console.log(
        `[CoordDescent] Scale fitting skipped (no improvement: ${scaledScore.toFixed(4)}% <= ${preScaleScore.toFixed(4)}%)`,
      );
    }
  } else if (scale !== 1 && hasFrozenVolume) {
    console.log(
      `[CoordDescent] Scale fitting skipped: at least one volume is frozen`,
    );
  }
  console.log(
    `[CoordDescent] After scale fitting: ${currentBest.toFixed(4)}%`,
  );
  return { genome, currentBest };
};

/**
 * Возвращает полную windowed-метрику перед финальными стадиями.
 *
 * @param context - Зависимости, нужные для повторной оценки геномов
 * @param state - Состояние с текущим и лучшим score
 * @returns Ничего; при смене метрики обновляет state на месте
 * @remarks Если превью-подвыборка уже выключена, функция ничего не
 *   делает. Иначе она сбрасывает stride до 1 и пересчитывает опорные
 *   score, чтобы ранний выход из превью-цикла не смешивал шкалы.
 */
const restoreFullMetricForFinalStages = (
  context: DescentContext,
  state: DescentState,
): void => {
  if (windowSubsampling.stride === 1) {
    return;
  }
  windowSubsampling.stride = 1;
  console.log(
    `[CoordDescent] Exploration preview off: full metric for final stages`,
  );
  rescaleScoresToCurrentMetric(context, state);
};

/**
 * Выполняет финальный прунинг либо переоценивает геном без него при
 * сохранении флагов.
 *
 * @param context - Метрика, кэш и настройки сохранения флагов
 * @param state - Текущий и лучший геномы с их score
 * @returns Ничего; синхронизирует кэш и обновляет state на месте
 * @remarks При preserveOscillatorFlags=true функция только считает
 *   полный score текущего генома. Иначе она отключает тихие слоты через
 *   finalPruneOscillators. Улучшенный геном становится лучшим, а
 *   текущий score не уменьшается.
 */
const applyFinalPruning = (
  context: DescentContext,
  state: DescentState,
): void => {
  const {
    targetSignal,
    sampleRate,
    usefulZone,
    waveformCache,
    numOsc,
    preserveOscillatorFlags,
    sampleWork,
  } = context;
  const finalPruningScore = preserveOscillatorFlags
    ? evaluateSuppressionWindowed(
        waveformCache.getWaveform(),
        targetSignal,
        sampleRate,
        usefulZone,
        sampleWork,
      )
    : finalPruneOscillators(
        state.genome,
        waveformCache,
        targetSignal,
        state.currentBest,
        numOsc,
        sampleRate,
        usefulZone,
        sampleWork,
      );
  syncFlagsToCache(state.genome, waveformCache, numOsc);
  console.log(
    `[CoordDescent] Post-pruning score: ${finalPruningScore.toFixed(4)}%`,
  );
  if (finalPruningScore > state.bestScore) {
    state.bestScore = finalPruningScore;
    state.bestGenome = state.genome.slice();
  }
  state.currentBest = Math.max(state.currentBest, finalPruningScore);
};

interface CyclePlan {
  cycle: CoordinateDescentConfig['restartSchedule'][number];
  isLastCycle: boolean;
  frequencyStep: number;
  phaseStep: number;
  cycleIterStart: number;
  cycleHardCap: number;
  cycleSoftCap: number;
}

interface CycleProgress {
  windowStartIter: number;
  windowStartBest: number;
  cycleStillImproving: boolean;
  missCount: number;
}

/** Настраивает метрику, шаги и бюджет одного цикла расписания. */
const prepareCycle = (
  context: DescentContext,
  state: DescentState,
  cycleStartIter: number,
): CyclePlan | null => {
  const { cfg, numOsc, waveformCache, maxIterations } = context;
  const restartSchedule = cfg.restartSchedule;
  const cycle = restartSchedule[state.cycleIndex];
  if (!cycle) {
    return null;
  }
  state.stagnation = 0;
  const isLastCycle = state.cycleIndex === restartSchedule.length - 1;

  const configuredStride = cfg.explorationWindowStride ?? 1;
  const previewStride =
    state.cycleIndex === 0 && Number.isFinite(configuredStride)
      ? Math.min(8, Math.max(1, Math.floor(configuredStride)))
      : 1;
  const maxSampleWork = cfg.maxSampleWork;
  if (
    context.sampleWork !== undefined &&
    maxSampleWork !== undefined
  ) {
    const n = context.targetSignal.length;
    const evaluation = estimateFullWindowedEvaluationSampleWork(
      n,
      context.sampleRate,
    );
    const active = Math.max(
      countActiveForBudget(
        state.genome,
        numOsc,
        context.preserveOscillatorFlags,
      ),
      countActiveForBudget(
        state.bestGenome,
        numOsc,
        context.preserveOscillatorFlags,
      ),
    );
    let required = 0;
    if (previewStride !== windowSubsampling.stride) {
      required += (active + 2) * n + 2 * evaluation;
    }
    if (isLastCycle) {
      // Preview→full rescale может изменить порядок scores: restore нужен
      // резервировать до rescale, даже если старый bestScore не выше.
      required += estimateCacheRebuildWork(state.bestGenome, context);
    }
    const used = snapshotCoordinateDescentSampleWork(
      context.sampleWork,
    ).total;
    if (used + required > maxSampleWork) {
      state.workBudgetExhausted = true;
      return null;
    }
  }
  if (previewStride !== windowSubsampling.stride) {
    windowSubsampling.stride = previewStride;
    if (previewStride > 1) {
      console.log(
        `[CoordDescent] Exploration preview: every ${previewStride}th window in ${cycle.label}`,
      );
    } else {
      console.log(
        `[CoordDescent] Exploration preview off: full metric from ${cycle.label}`,
      );
    }
    rescaleScoresToCurrentMetric(context, state);
  }

  const frequencyStep =
    state.cycleIndex === 0
      ? cfg.frequencyStepCoarse
      : isLastCycle
        ? cfg.frequencyStep
        : cfg.frequencyStepRefine;
  const phaseStep =
    state.cycleIndex === 0
      ? cfg.phaseStep
      : isLastCycle
        ? cfg.phaseStepPrecision
        : cfg.phaseStepRefine;
  state.lastCycleLabel = cycle.label;

  if (isLastCycle) {
    state.temperature = 0;
  }
  if (isLastCycle && state.bestScore > state.currentBest) {
    console.log(
      `[CoordDescent] SA: restoring best-ever ${state.bestScore.toFixed(4)}% (was ${state.currentBest.toFixed(4)}%) before ${cycle.label}`,
    );
    state.genome = state.bestGenome.slice();
    waveformCache.rebuild(state.genome);
    syncFlagsToCache(state.genome, waveformCache, numOsc);
    state.currentBest = state.bestScore;
  }
  console.log(
    `[CoordDescent] Cycle: ${cycle.label}, startStep=${cycle.startStep}, minStep=${cycle.minStep}, freqStep=${frequencyStep}, phaseStep=${phaseStep}, T=${state.temperature.toFixed(4)}, score=${state.currentBest.toFixed(4)}%`,
  );

  const cycleShares = restartSchedule.map((_, index) =>
    index === restartSchedule.length - 1
      ? 0.3
      : 0.7 / Math.max(1, restartSchedule.length - 1),
  );
  const laterShares = cycleShares
    .slice(state.cycleIndex + 1)
    .reduce((a, b) => a + b, 0);
  const cycleHardCap =
    maxIterations -
    Math.floor(
      maxIterations * laterShares * cfg.cycleReserveFraction,
    );
  const cycleSoftCap = Math.min(
    cycleHardCap,
    cycleStartIter +
      Math.floor(
        maxIterations * (cycleShares[state.cycleIndex] ?? 0.3),
      ),
  );
  return {
    cycle,
    isLastCycle,
    frequencyStep,
    phaseStep,
    cycleIterStart: state.iter,
    cycleHardCap,
    cycleSoftCap,
  };
};

/** Пересчитывает продуктивность цикла на границе окна. */
const updateCycleProgress = (
  context: DescentContext,
  state: DescentState,
  plan: CyclePlan,
  progress: CycleProgress,
): void => {
  const { cfg } = context;
  if (
    state.iter - progress.windowStartIter <
    cfg.cycleProgressWindow
  ) {
    return;
  }
  const windowGain = state.bestScore - progress.windowStartBest;
  if (windowGain >= cfg.cycleProgressEpsilon) {
    progress.missCount = 0;
  } else {
    progress.missCount++;
  }
  progress.cycleStillImproving =
    progress.missCount < cfg.cycleProgressMisses;
  if (
    !progress.cycleStillImproving &&
    state.iter >= plan.cycleSoftCap
  ) {
    console.log(
      `[CoordDescent] Cycle ${plan.cycle.label} stopped improving ` +
        `(+${windowGain.toFixed(3)}pp over ` +
        `${cfg.cycleProgressWindow} iters, ` +
        `${progress.missCount} misses in a row), ` +
        `advancing at ${state.iter}`,
    );
  }
  progress.windowStartIter = state.iter;
  progress.windowStartBest = state.bestScore;
};

/** Число включённых слотов с учётом обязательного первого osc в обычном CD. */
function countActiveForBudget(
  genome: readonly number[],
  numOsc: number,
  preserveOscillatorFlags: boolean,
): number {
  let active = 0;
  for (let osc = 0; osc < numOsc; osc += 1) {
    const enabled =
      (genome[osc * OSC_PARAMS + OFFSET.flag] ?? 0) >= 0.5 ||
      (osc === 0 && !preserveOscillatorFlags);
    if (enabled) {
      active += 1;
    }
  }
  return active;
}

/** Верхняя стоимость `WaveformCache.rebuild` в sample units. */
function estimateCacheRebuildWork(
  genome: readonly number[],
  context: DescentContext,
): number {
  const n = context.targetSignal.length;
  const active = countActiveForBudget(
    genome,
    context.numOsc,
    context.preserveOscillatorFlags,
  );
  return (2 * active + 2) * n;
}

/** Резервирует первый restart rebuild из initialVector, а не из current. */
function estimateRandomRestartRebuildWork(
  context: DescentContext,
): number {
  const n = context.targetSignal.length;
  // initGenome(initialVector, false) включает все флаги, в том числе уже
  // pruned у current/best. До restart нельзя занижать этот rebuild.
  const active = context.preserveOscillatorFlags
    ? countActiveForBudget(
        context.initialVector,
        context.numOsc,
        true,
      )
    : context.numOsc;
  return (2 * active + 2) * n;
}

/**
 * Консервативно оценивает целую итерацию и возможный plateau post-pass.
 * Никакие candidate/cache/metric N-проходы не начинаются до этой проверки.
 */
function estimateWholeIterationWork(
  context: DescentContext,
  state: DescentState,
  plan: CyclePlan,
): number {
  const n = context.targetSignal.length;
  const evaluation = estimateFullWindowedEvaluationSampleWork(
    n,
    context.sampleRate,
  );
  let total = 0;
  if (
    !context.preserveOscillatorFlags &&
    (state.genome[OFFSET.flag] ?? 0) !== 1
  ) {
    total += 3 * n;
  }
  for (let osc = 0; osc < context.numOsc; osc += 1) {
    const base = osc * OSC_PARAMS;
    const enabled =
      (state.genome[base + OFFSET.flag] ?? 0) >= 0.5 ||
      (osc === 0 && !context.preserveOscillatorFlags);
    if (!enabled) {
      continue;
    }
    let freeParameters = 0;
    for (
      let offset = OFFSET.freqBase;
      offset < OSC_PARAMS;
      offset += 1
    ) {
      if (!context.frozenParameterIndices.has(base + offset)) {
        freeParameters += 1;
      }
    }
    // Два кандидата: set/get/evaluate каждый, затем финальный set.
    total += freeParameters * (11 * n + 2 * evaluation);
    if (
      osc === 0 &&
      !context.frozenParameterIndices.has(OFFSET.startLevel)
    ) {
      total += 3 * n;
    }
    if (!context.preserveOscillatorFlags) {
      const attemptsUsed = context.relocationAttempts[osc] ?? 0;
      if (
        context.cfg.maxRelocationAttemptsPerOsc > attemptsUsed &&
        !hasFrozenOscillatorParameter(
          context.frozenParameterIndices,
          base,
        )
      ) {
        // Двухпроходный residual scan, DFT, relocation, greedy и rollback.
        total += 2300 * n + 25 * evaluation;
      }
      // Prune probe и возможный rollback после relocation.
      total += 5 * n + evaluation;
    }
  }

  const plateauAfterIteration =
    state.plateauCount + 1 >= context.cfg.plateauRestartThreshold;
  if (plateauAfterIteration) {
    const wantsRandomRestart =
      state.restartCount + 1 >=
        context.cfg.maxRestartsBeforeRandomRestart &&
      !plan.isLastCycle;
    const bestRebuild = estimateCacheRebuildWork(
      state.bestGenome,
      context,
    );
    if (wantsRandomRestart) {
      // Random rebuild стартует из initialVector, rollback — из bestGenome.
      total +=
        estimateRandomRestartRebuildWork(context) +
        bestRebuild +
        n +
        evaluation;
    } else {
      // Один kick, metric и возможный fallback rebuild.
      const currentRebuild = estimateCacheRebuildWork(
        state.genome,
        context,
      );
      total +=
        Math.max(currentRebuild, bestRebuild) + 4 * n + evaluation;
    }
  }
  return total;
}

/** Верхняя стоимость всех финальных стадий после последней целой итерации. */
function estimateFinalStagesWork(
  context: DescentContext,
  state: DescentState,
): number {
  const n = context.targetSignal.length;
  const evaluation = estimateFullWindowedEvaluationSampleWork(
    n,
    context.sampleRate,
  );
  const active = Math.max(
    countActiveForBudget(
      state.genome,
      context.numOsc,
      context.preserveOscillatorFlags,
    ),
    countActiveForBudget(
      state.bestGenome,
      context.numOsc,
      context.preserveOscillatorFlags,
    ),
  );
  const rebuild = Math.max(
    estimateCacheRebuildWork(state.genome, context),
    estimateCacheRebuildWork(state.bestGenome, context),
  );
  let total = 0;
  if (windowSubsampling.stride !== 1) {
    // Текущий cache и полный render best-ever, каждый со своей метрикой.
    total += (active + 2) * n + 2 * evaluation;
  }
  // Полный score и не более одного prune probe с rollback на каждый слот.
  total += n + evaluation;
  if (!context.preserveOscillatorFlags) {
    total += context.numOsc * (5 * n + evaluation);
  }
  // Scale probe, analytic scale + metric, scaled cache и его metric.
  total += 4 * n + 3 * evaluation + 2 * active * n;
  // Принятый scale rebuild, restore best и финальная нормализация флагов.
  total += 2 * rebuild + 3 * context.numOsc * n;
  return total;
}

/** Выполняет итерации одного цикла до бюджета, плато или early exit. */
const runCycleIterations = (
  context: DescentContext,
  state: DescentState,
  plan: CyclePlan,
): boolean => {
  const {
    cfg,
    targetSignal,
    sampleRate,
    onProgress,
    numOsc,
    waveformCache,
    usefulZone,
    history,
    rng,
    relocationAttempts,
    firstOscInitVolume,
    stepGrowthAdd,
    frozenParameterIndices,
    preserveOscillatorFlags,
    sampleWork,
  } = context;
  const { cycle, isLastCycle } = plan;
  let step = cycle.startStep;
  let genomeChanged = false;
  const progress: CycleProgress = {
    windowStartIter: state.iter,
    windowStartBest: state.bestScore,
    cycleStillImproving: true,
    missCount: 0,
  };

  while (
    state.iter < plan.cycleHardCap &&
    (state.iter < plan.cycleSoftCap || progress.cycleStillImproving)
  ) {
    const maxSampleWork = cfg.maxSampleWork;
    if (sampleWork !== undefined && maxSampleWork !== undefined) {
      const used =
        snapshotCoordinateDescentSampleWork(sampleWork).total;
      const required = estimateWholeIterationWork(
        context,
        state,
        plan,
      );
      if (used + required > maxSampleWork) {
        state.workBudgetExhausted = true;
        console.log(
          `[CoordDescent] Sample-work budget stops before iteration ${state.iter + 1}: ` +
            `used=${used}, reserved=${required}, max=${maxSampleWork}`,
        );
        break;
      }
    }
    const prevGenome = state.genome.slice();
    const result = optimizeIteration(
      state.genome,
      numOsc,
      state.currentBest,
      {
        waveformCache,
        targetSignal,
        sampleRate,
        step,
        firstOscMinVol: firstOscInitVolume,
        frequencyStep: plan.frequencyStep,
        phaseStep: plan.phaseStep,
        minStep: cycle.minStep,
        usefulZone,
        rng,
        temperature: state.temperature,
        relocationAttempts,
        maxRelocationAttemptsPerOsc: cfg.maxRelocationAttemptsPerOsc,
        relocationMinImprovement: cfg.relocationMinImprovement,
        frozenParameterIndices,
        preserveOscillatorFlags,
        sampleWork,
      },
    );
    state.genome = result.genome;
    const scoreImproved =
      result.score >
      state.currentBest + cfg.significantImprovementThreshold;
    state.currentBest = result.score;

    let bestVectorSnapshot: number[] | undefined;
    if (state.currentBest > state.bestScore) {
      state.bestScore = state.currentBest;
      state.bestGenome = state.genome.slice();
      bestVectorSnapshot = state.bestGenome.slice();
    }
    const genomeActuallyChanged =
      state.genome.length !== prevGenome.length ||
      state.genome.some(
        (value, index) => value !== prevGenome[index],
      );
    if (genomeActuallyChanged) {
      genomeChanged = true;
    }

    console.log(
      `Iteration ${state.iter + 1}: ${state.currentBest.toFixed(4)}%`,
    );
    emitProgress(
      history,
      onProgress,
      state.iter + 1,
      state.currentBest,
      cycle.label,
      bestVectorSnapshot,
      progressWork(context, state),
    );
    state.iter++;
    state.temperature *= cfg.saCoolingRate;
    updateCycleProgress(context, state, plan, progress);

    if (state.currentBest >= cfg.earlyExitSuppression) {
      break;
    }
    if (scoreImproved) {
      state.stagnation = 0;
      state.plateauCount = 0;
      state.consecutiveSuccesses++;
      if (state.consecutiveSuccesses >= cfg.stepGrowthThreshold) {
        step += stepGrowthAdd;
        console.log(
          `[CoordDescent] Step grown to ${step.toFixed(6)} (added ${stepGrowthAdd})`,
        );
        state.consecutiveSuccesses = 0;
      }
    } else {
      state.stagnation++;
      state.plateauCount++;
      state.consecutiveSuccesses = 0;
    }

    if (state.plateauCount >= cfg.plateauRestartThreshold) {
      step = handlePlateau(
        context,
        state,
        step,
        cycle.label,
        isLastCycle,
      );
    }
    if (state.stagnation >= cfg.stagnationExitThreshold) {
      step *= cfg.stagnationStepDecayFactor;
      console.log(
        `[CoordDescent] Decay step to ${step.toFixed(8)} (${state.stagnation} stagnant)`,
      );
      state.stagnation = 0;
    }
    if (step < cycle.minStep) {
      console.log(
        `[CoordDescent] Step ${step.toFixed(8)} < minStep ${cycle.minStep}, leaving ${cycle.label}`,
      );
      break;
    }
  }

  return genomeChanged;
};

/** Обходит расписание и делегирует каждый цикл своим хелперам. */
const runRestartSchedule = (
  context: DescentContext,
  state: DescentState,
): void => {
  const restartSchedule = context.cfg.restartSchedule;
  let cycleStartIter = 0;

  while (state.cycleIndex < restartSchedule.length) {
    const plan = prepareCycle(context, state, cycleStartIter);
    if (plan === null) {
      break;
    }
    const genomeChanged = runCycleIterations(context, state, plan);

    if (state.workBudgetExhausted) {
      break;
    }
    if (state.currentBest >= context.cfg.earlyExitSuppression) {
      break;
    }
    if (!genomeChanged && state.iter - plan.cycleIterStart > 0) {
      console.log(
        `[CoordDescent] No genome change in cycle ${plan.cycle.label}, advancing`,
      );
    }
    if (
      state.iter >= plan.cycleHardCap &&
      state.iter < context.maxIterations
    ) {
      console.log(
        `[CoordDescent] Cycle ${plan.cycle.label} hit reserve cap at iter ${state.iter}` +
          ` (soft cap was ${plan.cycleSoftCap}), advancing`,
      );
    }
    cycleStartIter = state.iter;
    state.cycleIndex++;
  }

  console.log(
    `[CoordDescent] Finished after ${state.iter} iterations (${state.lastCycleLabel} cycle, ${state.cycleIndex - 1} cycles completed)`,
  );
};

/**
 * Выполняет финальные стадии целиком либо возвращает лучший целый genome.
 * Порядок restore/prune/scale и все sample-work операции совпадают с
 * прежним inline-путём; возвращаемый флаг описывает факт, а не причину stop.
 */
function finalizeCoordinateDescent(
  context: DescentContext,
  state: DescentState,
): { finalStagesSkipped: boolean } {
  const {
    cfg,
    sampleWork,
    waveformCache,
    targetSignal,
    sampleRate,
    usefulZone,
    numOsc,
    frozenParameterIndices,
  } = context;
  const maxSampleWork = cfg.maxSampleWork;
  const finalStagesFit =
    sampleWork === undefined ||
    maxSampleWork === undefined ||
    snapshotCoordinateDescentSampleWork(sampleWork).total +
      estimateFinalStagesWork(context, state) <=
      maxSampleWork;
  if (finalStagesFit) {
    restoreFullMetricForFinalStages(context, state);
    applyFinalPruning(context, state);
    const scaled = applyScaleFitting({
      genome: state.genome,
      waveformCache,
      targetSignal,
      sampleRate,
      usefulZone,
      numOsc,
      phaseModel: cfg.phaseModel,
      fixedDelaySeconds: cfg.fixedDelaySeconds,
      frozenParameterIndices,
      sampleWork,
    });
    state.genome = scaled.genome;
    state.currentBest = scaled.currentBest;

    if (state.bestScore > state.currentBest) {
      state.genome = state.bestGenome.slice();
      waveformCache.rebuild(state.genome);
      syncFlagsToCache(state.genome, waveformCache, numOsc);
      state.currentBest = state.bestScore;
      console.log(
        `[CoordDescent] Restored best genome: ${state.currentBest.toFixed(4)}%`,
      );
    }
    normalizeFlags(state.genome, numOsc);
    syncFlagsToCache(state.genome, waveformCache, numOsc);
  } else {
    state.workBudgetExhausted = true;
    windowSubsampling.stride = 1;
    if (state.bestScore > state.currentBest) {
      state.genome = state.bestGenome.slice();
      state.currentBest = state.bestScore;
    }
    normalizeFlags(state.genome, numOsc);
    console.log(
      '[CoordDescent] Sample-work budget skips non-iteration final stages',
    );
  }
  return { finalStagesSkipped: !finalStagesFit };
}

/**
 * Подбирает параметры осцилляторов методом coordinate descent и
 * максимизирует windowed suppressionPercent против таргета.
 *
 * @param initialVector - Стартовый вектор: по OSC_PARAMS нормализованных
 *   значений на осциллятор
 * @param targetSignal - Эталонный сигнал
 * @param sampleRate - Частота дискретизации, Гц
 * @param maxIterations - Общий бюджет итераций всех циклов
 * @param onProgress - Колбэк прогресса, вызывается каждую итерацию и
 *   после финальных стадий
 * @param stepGrowthAdd - Приращение шага после серии успехов
 * @param stepDecayFactor - Множитель затухания шага на плато
 * @param config - Переопределения CoordinateDescentConfig
 * @returns Оптимизированный вектор и история прогресса
 * @throws Error если frozenParameterIndices указывает вне генома,
 *   содержит нецелый индекс или индекс флага on/off, если
 *   fixedDelaySeconds имеет неверную длину или значение вне 0–0.5 с,
 *   либо если maxSampleWork отрицателен или не конечен
 * @remarks Циклы меняют шаги частоты, фазы и остальных параметров;
 *   плато вызывает пинки или сидируемые рестарты, а simulated annealing
 *   выключается в финальном цикле. После спуска функция возвращает
 *   полную метрику, выполняет прунинг и scale fitting с переоценкой,
 *   затем восстанавливает лучший геном при необходимости. Анкеры
 *   остаются неизменными. При preserveOscillatorFlags=true сохраняются
 *   исходные флаги, а relocation и прунинг не запускаются. В возврате
 *   все флаги равны строго 0 или 1. Fixed-delay sidecar копируется на
 *   входе, не попадает в vector/history и остаётся привязанным к исходным
 *   индексам при любых операциях спуска. При заданном maxSampleWork
 *   progress дополнительно несёт фактические N-проходы; CD начинает только
 *   целую итерацию с достаточным консервативным запасом и не выполняет
 *   финальные стадии частично. В последнем progress `workBudgetStop` и
 *   `finalStagesSkipped` описывают причину остановки и фактический skip
 *   независимо. Без лимита возврат и history не меняются.
 */
export const coordinateDescent = (
  initialVector: readonly number[],
  targetSignal: readonly number[],
  sampleRate: number,
  maxIterations: number,
  onProgress?: ProgressCallback,
  stepGrowthAdd?: number,
  stepDecayFactor?: number,
  config?: Partial<CoordinateDescentConfig>,
): OptimizeResult => {
  const cfg: CoordinateDescentConfig = {
    ...DEFAULT_COORD_DESCENT_CONFIG,
    ...config,
  };
  windowSubsampling.stride = 1;
  const rng = createRng(cfg.seed);
  const genomeLength = initialVector.length;
  const numOsc = genomeLength / OSC_PARAMS;
  validateFixedDelaySeconds(cfg.fixedDelaySeconds, numOsc);
  if (cfg.fixedDelaySeconds !== undefined) {
    cfg.fixedDelaySeconds = [...cfg.fixedDelaySeconds];
  }
  const frozenParameterIndices = createFrozenParameterSet(
    cfg.frozenParameterIndices,
    genomeLength,
  );
  const preserveOscillatorFlags =
    cfg.preserveOscillatorFlags ?? false;
  const genome = initGenome(initialVector, preserveOscillatorFlags);
  const maxSampleWork = cfg.maxSampleWork;
  if (
    maxSampleWork !== undefined &&
    (!Number.isFinite(maxSampleWork) || maxSampleWork < 0)
  ) {
    throw new Error('maxSampleWork должен быть конечным и >= 0');
  }
  let sampleWork: CoordinateDescentSampleWorkCounter | undefined;
  if (maxSampleWork !== undefined) {
    const n = targetSignal.length;
    const active = countActiveForBudget(
      genome,
      numOsc,
      preserveOscillatorFlags,
    );
    const startupUpperBound =
      2 * n +
      2 * active * n +
      n +
      estimateFullWindowedEvaluationSampleWork(n, sampleRate);
    if (startupUpperBound > maxSampleWork) {
      normalizeFlags(genome, numOsc);
      return { vector: genome, history: [] };
    }
    sampleWork = createCoordinateDescentSampleWorkCounter();
  }
  const relocationAttempts = new Array<number>(numOsc).fill(0);
  const firstOscInitVolume = genome[OFFSET.startLevel] ?? 0;
  const usefulZone = computeUsefulZone(
    targetSignal,
    sampleRate,
    sampleWork,
  );
  const waveformCache = new WaveformCache(
    genome,
    sampleRate,
    targetSignal.length,
    cfg.phaseModel,
    cfg.fixedDelaySeconds,
    sampleWork,
  );
  const currentBest = evaluateSuppressionWindowed(
    waveformCache.getWaveform(),
    targetSignal,
    sampleRate,
    usefulZone,
    sampleWork,
  );
  const history: ProgressEntry[] = [];
  const state: DescentState = {
    genome,
    currentBest,
    bestGenome: genome.slice(),
    bestScore: currentBest,
    iter: 0,
    cycleIndex: 0,
    temperature: cfg.saInitialTemp,
    stagnation: 0,
    plateauCount: 0,
    restartCount: 0,
    consecutiveSuccesses: 0,
    workBudgetExhausted: false,
  };
  const context: DescentContext = {
    initialVector,
    targetSignal,
    sampleRate,
    maxIterations,
    onProgress,
    cfg,
    numOsc,
    waveformCache,
    usefulZone,
    history,
    rng,
    relocationAttempts,
    firstOscInitVolume,
    stepGrowthAdd: stepGrowthAdd ?? 0.01,
    stepDecayFactor: stepDecayFactor ?? cfg.stagnationStepDecayFactor,
    frozenParameterIndices,
    preserveOscillatorFlags,
    sampleWork,
  };

  console.log(
    `[CoordDescent] Starting at ${currentBest.toFixed(4)}%, ${genomeLength} params`,
  );
  for (let osc = 0; osc < numOsc; osc++) {
    const base = osc * OSC_PARAMS;
    const freqBase = genome[base + OFFSET.freqBase];
    const freqStart = genome[base + OFFSET.freqStart];
    const vol = genome[base + OFFSET.startLevel];
    console.log(
      `[Init] Osc[${osc}]: freq=${freqBase?.toFixed(2)}-${freqStart?.toFixed(2)}, vol=${vol?.toFixed(3)}, on=${genome[base]}`,
    );
  }

  runRestartSchedule(context, state);
  const { finalStagesSkipped } = finalizeCoordinateDescent(
    context,
    state,
  );
  if (sampleWork !== undefined && maxSampleWork !== undefined) {
    const used =
      snapshotCoordinateDescentSampleWork(sampleWork).total;
    if (used > maxSampleWork) {
      throw new Error(
        `Internal sample-work estimate failed: ${used} > ${maxSampleWork}`,
      );
    }
  }
  emitProgress(
    history,
    onProgress,
    state.iter,
    state.currentBest,
    state.lastCycleLabel,
    state.genome.slice(),
    progressWork(context, state, finalStagesSkipped),
  );
  return { vector: state.genome, history };
};

/**
 * Точка входа оптимизации: обёртка над coordinateDescent
 * с объектом аргументов ArgOptimize (публичный контракт,
 * используется worker-потоком и staged-оптимизацией).
 *
 * @param arg - Параметры оптимизации: вектор, таргет, бюджет
 *   итераций и конфиг coordinate descent
 * @returns Оптимизированный вектор и история прогресса
 */
export const optimize = (
  arg: ArgOptimize,
): {
  vector: number[];
  history: ProgressEntry[];
} => {
  return coordinateDescent(
    arg.initialVector,
    arg.targetSignal,
    arg.sampleRate,
    arg.maxIterations ?? 100,
    arg.onProgress,
    arg.stepGrowthAdd,
    arg.stepDecayFactor,
    {
      ...arg.config,
      ...(arg.fixedDelaySeconds === undefined
        ? {}
        : { fixedDelaySeconds: arg.fixedDelaySeconds }),
    },
  );
};
