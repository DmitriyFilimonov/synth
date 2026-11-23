/**
 * Совместно подгоняет амплитуду и фазу существующих осцилляторов.
 * Частоты, свипы, огибающие и флаги остаются неизменными. Это offline
 * post-pass готового match, а не новый этап coordinate descent.
 */
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import { assessCancellationQuality } from '../cancellation-assessment';
import {
  computeUsefulZone,
  evaluateSuppressionWindowed,
  type UsefulZone,
} from '../optimize/evaluate';
import {
  createOscillatorGroup,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import { renderSamples } from './shared';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];

/** Метрики одного фактически отрендеренного WAV. */
export interface RefitMetrics {
  globalSuppressionPercent: number;
  windowedSuppressionPercent: number;
}

/** Изменение одного осциллятора и метрики после принятия шага. */
export interface QuadratureRefitChange {
  oscillatorIndex: number;
  previousStartLevel: number;
  startLevel: number;
  previousPhase: number;
  phase: number;
  metrics: RefitMetrics;
}

/** Аудит post-pass; unchanged возвращает исходные patch и samples. */
export interface QuadratureRefitResult {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  baseline: RefitMetrics;
  metrics: RefitMetrics;
  changes: QuadratureRefitChange[];
  passesCompleted: number;
}

export interface RenderState {
  patch: ArgCreateSynth;
  rawSum: Float64Array;
  samples: Int16Array;
  metrics: RefitMetrics;
}

export interface QuadratureFit {
  sineCoefficient: number;
  cosineCoefficient: number;
  startLevel: number;
  phase: number;
}

/** Клонирует патч, чтобы отказ не менял вход по ссылке. */
export function clonePatch(patch: ArgCreateSynth): ArgCreateSynth {
  return {
    oscillators: patch.oscillators.map((group) => ({
      osc: { ...group.osc },
      ampEnv: { ...group.ampEnv },
    })),
  };
}

/** Рендерит ровно sampleCount отсчётов в обеих фазовых моделях. */
export function renderForTarget(
  patch: ArgCreateSynth,
  sampleCount: number,
  phaseModel: PhaseModel,
): Int16Array {
  return renderSamples(patch, (sampleCount + 0.5) / SAMPLE_RATE, {
    phaseModel,
  });
}

/** Рендерит один osc group без клиппинга полной суммы. */
export function renderGroup(
  group: OscillatorGroup,
  sampleCount: number,
  phaseModel: PhaseModel,
): Float64Array {
  const synth = createOscillatorGroup(group, { phaseModel });
  return Float64Array.from({ length: sampleCount }, (_, index) =>
    synth({ x: index / SAMPLE_RATE }),
  );
}

/** Возвращает включённую копию osc group с единичной амплитудой и заданной фазой. */
export function unitGroup(
  source: OscillatorGroup,
  phase: number,
): OscillatorGroup {
  return {
    osc: { ...source.osc, on: true, phase },
    ampEnv: { ...source.ampEnv, startLevel: 1 },
  };
}

/** Складывает исходные вклады без клиппинга для линейного refit. */
function renderRawSum(
  patch: ArgCreateSynth,
  sampleCount: number,
  phaseModel: PhaseModel,
): Float64Array {
  const raw = new Float64Array(sampleCount);
  for (const group of patch.oscillators) {
    if (!group.osc.on) {
      continue;
    }
    const contribution = renderGroup(group, sampleCount, phaseModel);
    for (let index = 0; index < sampleCount; index += 1) {
      raw[index] = (raw[index] ?? 0) + (contribution[index] ?? 0);
    }
  }
  return raw;
}

/** Применяет клиппинг и квантование ровно так же, как renderSamples. */
export function quantizeRaw(raw: ArrayLike<number>): Int16Array {
  return Int16Array.from(raw, (value) =>
    Math.round(
      Math.max(-1, Math.min(1, value)) *
        MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    ),
  );
}

/** Считает обе метрики по одному и тому же квантованному WAV. */
export function measureMetrics(
  samples: Int16Array,
  target: number[],
  sampleRate: number,
  usefulZone: UsefulZone,
): RefitMetrics {
  const values = Array.from(samples);
  const inverted = values.map((value) => -value);
  return {
    globalSuppressionPercent: assessCancellationQuality({
      target,
      generated: inverted,
    }).suppressionPercent,
    windowedSuppressionPercent: evaluateSuppressionWindowed(
      values,
      target,
      sampleRate,
      usefulZone,
    ),
  };
}

/** Строит исходное состояние и проверяет метрики сохранённого match. */
export function createInitialState(arg: {
  patch: ArgCreateSynth;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  usefulZone: UsefulZone;
}): RenderState {
  const patch = clonePatch(arg.patch);
  const samples = renderForTarget(
    patch,
    arg.target.length,
    arg.phaseModel,
  );
  return {
    patch,
    rawSum: renderRawSum(patch, arg.target.length, arg.phaseModel),
    samples,
    metrics: measureMetrics(
      samples,
      arg.target,
      arg.sampleRate,
      arg.usefulZone,
    ),
  };
}

/**
 * Решает квадратурную систему 2×2 и ограничивает амплитуду [0.001, 1].
 * Возвращает null для вырожденного или нечислового базиса.
 */
export function fitQuadrature(arg: {
  sine: Float64Array;
  cosine: Float64Array;
  target: number[];
  rawWithout: Float64Array;
}): QuadratureFit | null {
  let ss = 0;
  let cc = 0;
  let sc = 0;
  let sr = 0;
  let cr = 0;
  for (let index = 0; index < arg.target.length; index += 1) {
    const sine = arg.sine[index] ?? 0;
    const cosine = arg.cosine[index] ?? 0;
    const residual =
      (arg.target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      (arg.rawWithout[index] ?? 0);
    ss += sine * sine;
    cc += cosine * cosine;
    sc += sine * cosine;
    sr += sine * residual;
    cr += cosine * residual;
  }
  const determinant = ss * cc - sc * sc;
  if (
    !Number.isFinite(determinant) ||
    determinant <= 1e-12 * ss * cc ||
    ss <= 0 ||
    cc <= 0
  ) {
    return null;
  }
  let sineCoefficient = (sr * cc - cr * sc) / determinant;
  let cosineCoefficient = (cr * ss - sr * sc) / determinant;
  const fittedLevel = Math.hypot(sineCoefficient, cosineCoefficient);
  if (!Number.isFinite(fittedLevel) || fittedLevel <= 1e-12) {
    return null;
  }
  const startLevel = Math.max(0.001, Math.min(1, fittedLevel));
  const scale = startLevel / fittedLevel;
  sineCoefficient *= scale;
  cosineCoefficient *= scale;
  const phase =
    ((Math.atan2(cosineCoefficient, sineCoefficient) %
      (2 * Math.PI)) +
      2 * Math.PI) %
    (2 * Math.PI);
  return {
    sineCoefficient,
    cosineCoefficient,
    startLevel,
    phase,
  };
}

/** Вычитает текущий вклад из полной суммы без новой большой матрицы. */
function rawWithoutGroup(
  rawSum: Float64Array,
  group: OscillatorGroup,
  phaseModel: PhaseModel,
): Float64Array {
  const contribution = renderGroup(group, rawSum.length, phaseModel);
  return Float64Array.from(
    rawSum,
    (value, index) => value - (contribution[index] ?? 0),
  );
}

/** Собирает кандидат из квадратур и применяет общий клиппинг. */
export function renderQuadratureCandidate(arg: {
  rawWithout: Float64Array;
  sine: Float64Array;
  cosine: Float64Array;
  fit: QuadratureFit;
}): { rawSum: Float64Array; samples: Int16Array } {
  const rawSum = new Float64Array(arg.rawWithout.length);
  for (let index = 0; index < rawSum.length; index += 1) {
    rawSum[index] =
      (arg.rawWithout[index] ?? 0) +
      arg.fit.sineCoefficient * (arg.sine[index] ?? 0) +
      arg.fit.cosineCoefficient * (arg.cosine[index] ?? 0);
  }
  return { rawSum, samples: quantizeRaw(rawSum) };
}

/** Проверяет, что шаг улучшает global и не отдаёт больше 0.05 п.п. J. */
function isAccepted(
  baseline: RefitMetrics,
  candidate: RefitMetrics,
  windowedFloor = baseline.windowedSuppressionPercent - 0.05,
): boolean {
  return (
    candidate.globalSuppressionPercent >
      baseline.globalSuppressionPercent + 1e-10 &&
    candidate.windowedSuppressionPercent >= windowedFloor
  );
}

/** Пробует один осциллятор; отказ оставляет state нетронутым. */
function tryOscillator(arg: {
  state: RenderState;
  oscillatorIndex: number;
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  usefulZone: UsefulZone;
  windowedFloor: number;
}): { state: RenderState; change: QuadratureRefitChange | null } {
  const group = arg.state.patch.oscillators[arg.oscillatorIndex];
  if (group === undefined || !group.osc.on) {
    return { state: arg.state, change: null };
  }
  const sine = renderGroup(
    unitGroup(group, 0),
    arg.target.length,
    arg.phaseModel,
  );
  const cosine = renderGroup(
    unitGroup(group, Math.PI / 2),
    arg.target.length,
    arg.phaseModel,
  );
  const rawWithout = rawWithoutGroup(
    arg.state.rawSum,
    group,
    arg.phaseModel,
  );
  const fit = fitQuadrature({
    sine,
    cosine,
    target: arg.target,
    rawWithout,
  });
  if (fit === null) {
    return { state: arg.state, change: null };
  }
  const candidateRaw = renderQuadratureCandidate({
    rawWithout,
    sine,
    cosine,
    fit,
  });
  const metrics = measureMetrics(
    candidateRaw.samples,
    arg.target,
    arg.sampleRate,
    arg.usefulZone,
  );
  if (!isAccepted(arg.state.metrics, metrics, arg.windowedFloor)) {
    return { state: arg.state, change: null };
  }
  const patch = clonePatch(arg.state.patch);
  const nextGroup = patch.oscillators[arg.oscillatorIndex];
  if (nextGroup === undefined) {
    return { state: arg.state, change: null };
  }
  nextGroup.ampEnv.startLevel = fit.startLevel;
  nextGroup.osc.phase = fit.phase;
  return {
    state: {
      patch,
      rawSum: candidateRaw.rawSum,
      samples: candidateRaw.samples,
      metrics,
    },
    change: {
      oscillatorIndex: arg.oscillatorIndex,
      previousStartLevel: group.ampEnv.startLevel,
      startLevel: fit.startLevel,
      previousPhase: group.osc.phase,
      phase: fit.phase,
      metrics,
    },
  };
}

/**
 * Выполняет до maxPasses жадных квадратурных проходов по активным слотам.
 *
 * @param arg - Исходный patch, target PCM и модель фазы сохранённого match
 * @returns Лучший принятый patch/WAV и аудит; при отсутствии выигрыша —
 *   неизменные исходные данные
 * @throws Error если target пуст, sample rate не 44100 Гц или maxPasses
 *   не является целым от 1 до 8
 * @remarks Каждый принятый шаг повышает честный global и не снижает
 *   windowed J больше чем на 0.05 п.п. Финальный fallback дополнительно
 *   сравнивает весь результат с исходным match. Частоты, огибающие,
 *   количество слотов и on/off не меняются. Поэтому этот метод сам по
 *   себе не добавляет отсутствующие структурные компоненты.
 */
export function refitPatchQuadratures(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  maxPasses?: number;
}): QuadratureRefitResult {
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  const maxPasses = arg.maxPasses ?? 2;
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Quadrature refit поддерживает только 44100 Гц');
  }
  if (arg.target.length === 0) {
    throw new Error('Пустой target');
  }
  if (
    !Number.isInteger(maxPasses) ||
    maxPasses < 1 ||
    maxPasses > 8
  ) {
    throw new Error('maxPasses должен быть целым от 1 до 8');
  }
  const target = Array.from(arg.target);
  const usefulZone = computeUsefulZone(target, sampleRate);
  const initial = createInitialState({
    patch: arg.patch,
    target,
    sampleRate,
    phaseModel,
    usefulZone,
  });
  let state = initial;
  const changes: QuadratureRefitChange[] = [];
  let passesCompleted = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let accepted = 0;
    for (
      let index = 0;
      index < state.patch.oscillators.length;
      index += 1
    ) {
      const attempted = tryOscillator({
        state,
        oscillatorIndex: index,
        target,
        sampleRate,
        phaseModel,
        usefulZone,
        windowedFloor:
          initial.metrics.windowedSuppressionPercent - 0.05,
      });
      state = attempted.state;
      if (attempted.change !== null) {
        changes.push(attempted.change);
        accepted += 1;
      }
    }
    passesCompleted += 1;
    if (accepted === 0) {
      break;
    }
  }
  if (changes.length === 0) {
    return {
      status: 'unchanged',
      patch: clonePatch(arg.patch),
      samples: initial.samples,
      baseline: initial.metrics,
      metrics: initial.metrics,
      changes: [],
      passesCompleted,
    };
  }
  const finalSamples = renderForTarget(
    state.patch,
    target.length,
    phaseModel,
  );
  const finalMetrics = measureMetrics(
    finalSamples,
    target,
    sampleRate,
    usefulZone,
  );
  if (!isAccepted(initial.metrics, finalMetrics)) {
    return {
      status: 'unchanged',
      patch: clonePatch(arg.patch),
      samples: initial.samples,
      baseline: initial.metrics,
      metrics: initial.metrics,
      changes: [],
      passesCompleted,
    };
  }
  return {
    status: 'refined',
    patch: state.patch,
    samples: finalSamples,
    baseline: initial.metrics,
    metrics: finalMetrics,
    changes,
    passesCompleted,
  };
}
