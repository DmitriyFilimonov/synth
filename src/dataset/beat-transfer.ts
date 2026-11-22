/**
 * Offline-перенос принятой пары в готовый match-патч. Частоты берутся
 * из исходника, а амплитуды, фазы и допустимые варианты огибающих
 * подгоняются к конкретному патчу с ограничениями синтезатора. Сервис
 * эту функцию не вызывает: сначала нужны holdout-проверки на lost-сидах.
 */
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import {
  createOscillatorGroup,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import {
  BEAT_DECIMATION,
  basis,
  lowpassAmplitudeGain,
  lowpassDecimate,
  lowpassGroupDelaySec,
  solveLeastSquares,
  type DampedBeatFit,
} from './beat-model';
import { renderSamples } from './shared';

type OscillatorGroup = ArgCreateSynth['oscillators'][number];

/** Что сделал перенос и какие параметры получили новые компоненты. */
export interface BeatTransferAudit {
  mode: 'replace' | 'phase-repair' | 'envelope-repair';
  applied: boolean;
  replacedOscillators: number[];
  pairOscillators: number[];
  coefficients: number[];
  startLevels: number[];
  phases: number[];
  durationSec: number;
  endLevel: number;
  baselineTrainRss: number;
  candidateTrainRss: number;
  baselineGuardRss: number;
  candidateGuardRss: number;
  baselineSelectionRss: number;
  candidateSelectionRss: number;
}

/**
 * Кандидат либо исходный патч с причиной отказа от изменений.
 * `candidate` означает только улучшение train+guard, а не гарантированный
 * рост validation R² или global. Оба отказа возвращают исходные данные.
 */
export interface BeatTransferResult {
  status: 'candidate' | 'no-improvement' | 'no-feasible-replacement';
  patch: ArgCreateSynth;
  samples: Int16Array;
  audit: BeatTransferAudit | null;
}

interface Candidate {
  patch: ArgCreateSynth;
  samples: Int16Array;
  audit: BeatTransferAudit;
}

interface RenderContext {
  rawSum: Float64Array;
  solo: Float64Array[];
}

/** Клонирует патч без ссылок на вложенные параметры исходника. */
function clonePatch(patch: ArgCreateSynth): ArgCreateSynth {
  return {
    oscillators: patch.oscillators.map((group) => ({
      osc: { ...group.osc },
      ampEnv: { ...group.ampEnv },
    })),
  };
}

/** Ограничивает сумму диапазоном синтезатора и округляет до int16. */
function clampSamples(raw: ArrayLike<number>): Int16Array {
  return Int16Array.from(raw, (value) =>
    Math.round(
      Math.max(
        -MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
        Math.min(MAX_AMPLITUDE_16_BIT_WAV_ENCODED, value),
      ),
    ),
  );
}

/** Считает solo-вклады и их сумму один раз для всех вариантов замены. */
function buildRenderContext(
  patch: ArgCreateSynth,
  phaseModel: PhaseModel,
  sampleCount: number,
): RenderContext {
  const count = sampleCount;
  const rawSum = new Float64Array(count);
  const solo = patch.oscillators.map((group) => {
    const synth = createOscillatorGroup(group, { phaseModel });
    const samples = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      const value =
        synth({ x: index / SAMPLE_RATE }) *
        MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
      samples[index] = value;
      rawSum[index] = (rawSum[index] ?? 0) + value;
    }
    return samples;
  });
  return { rawSum, solo };
}

/** Рендерит ровно sampleCount отсчётов без ошибки округления длительности. */
function renderForTarget(
  patch: ArgCreateSynth,
  sampleCount: number,
  phaseModel: PhaseModel,
): Int16Array {
  return renderSamples(patch, (sampleCount + 0.5) / SAMPLE_RATE, {
    phaseModel,
  });
}

/** RSS на сырых отсчётах обучающего участка 80–180 мс. */
function trainingRss(
  target: ArrayLike<number>,
  samples: ArrayLike<number>,
  sampleRate: number,
): number {
  const start = Math.round(0.08 * sampleRate);
  const end = Math.min(target.length, Math.round(0.18 * sampleRate));
  let rss = 0;
  for (let index = start; index < end; index += 1) {
    const error = (target[index] ?? 0) - (samples[index] ?? 0);
    rss += error * error;
  }
  return rss;
}

/** RSS атаки и позднего хвоста вне validation 180–300 мс. */
function guardRss(
  target: ArrayLike<number>,
  samples: ArrayLike<number>,
  sampleRate: number,
): number {
  let rss = 0;
  for (let index = 0; index < target.length; index += 1) {
    const time = index / sampleRate;
    if (time >= 0.08 && time < 0.3) {
      continue;
    }
    const error = (target[index] ?? 0) - (samples[index] ?? 0);
    rss += error * error;
  }
  return rss;
}

/** Ограничивает амплитуду пары cos/sin без изменения её фазы. */
function capBlock(
  coefficients: number[],
  offset: number,
  maxAmplitude: number,
): void {
  const cosine = coefficients[offset] ?? 0;
  const sine = coefficients[offset + 1] ?? 0;
  const amplitude = Math.hypot(cosine, sine);
  if (amplitude <= maxAmplitude || amplitude === 0) {
    return;
  }
  const scale = maxAmplitude / amplitude;
  coefficients[offset] = cosine * scale;
  coefficients[offset + 1] = sine * scale;
}

/** Полная ошибка четырёх коэффициентов на обучающем сигнале. */
function coefficientRss(
  columns: number[][],
  coefficients: number[],
  values: number[],
): number {
  let rss = 0;
  for (let index = 0; index < values.length; index += 1) {
    let prediction = 0;
    for (let column = 0; column < columns.length; column += 1) {
      prediction +=
        (columns[column]?.[index] ?? 0) * (coefficients[column] ?? 0);
    }
    rss += ((values[index] ?? 0) - prediction) ** 2;
  }
  return rss;
}

/**
 * Подгоняет четыре коэффициента к остатку с дисковыми ограничениями
 * амплитуд. Попеременно уточняет каждую пару cos/sin; validation не
 * участвует ни в одной итерации.
 */
function fitBoundedPair(arg: {
  residual: ArrayLike<number>;
  fit: DampedBeatFit;
  sampleRate: number;
}): number[] {
  const decimated = lowpassDecimate(arg.residual);
  const decimatedRate = arg.sampleRate / BEAT_DECIMATION;
  const times = decimated
    .map((_, index) => index / decimatedRate)
    .filter((time) => time >= 0.08 && time < 0.18);
  const values = decimated.filter((_, index) => {
    const time = index / decimatedRate;
    return time >= 0.08 && time < 0.18;
  });
  const columns = basis(
    [arg.fit.f1, arg.fit.f2],
    arg.fit.lambda,
    times,
  );
  const delay = lowpassGroupDelaySec(arg.sampleRate);
  const caps = [arg.fit.f1, arg.fit.f2].map(
    (frequency) =>
      lowpassAmplitudeGain(frequency, arg.sampleRate) *
      Math.exp(arg.fit.lambda * delay),
  );
  const coefficients = solveLeastSquares(columns, values);
  capBlock(coefficients, 0, caps[0] ?? 0);
  capBlock(coefficients, 2, caps[1] ?? 0);
  let best = [...coefficients];
  let bestRss = coefficientRss(columns, best, values);
  for (let iteration = 0; iteration < 30; iteration += 1) {
    for (const block of [0, 1]) {
      const other = block === 0 ? 2 : 0;
      const residual = values.map((value, index) => {
        const first = columns[other]?.[index] ?? 0;
        const second = columns[other + 1]?.[index] ?? 0;
        return (
          value -
          first * (coefficients[other] ?? 0) -
          second * (coefficients[other + 1] ?? 0)
        );
      });
      const pair = solveLeastSquares(
        columns.slice(block * 2, block * 2 + 2),
        residual,
      );
      coefficients[block * 2] = pair[0] ?? 0;
      coefficients[block * 2 + 1] = pair[1] ?? 0;
      capBlock(coefficients, block * 2, caps[block] ?? 0);
    }
    const rss = coefficientRss(columns, coefficients, values);
    if (rss < bestRss) {
      best = [...coefficients];
      bestRss = rss;
    } else {
      break;
    }
  }
  return best;
}

/** Переводит одну отфильтрованную компоненту в допустимый osc group. */
function componentFromCoefficients(arg: {
  cosine: number;
  sine: number;
  frequency: number;
  lambda: number;
  sampleRate: number;
}): OscillatorGroup | null {
  const delay = lowpassGroupDelaySec(arg.sampleRate);
  const gain = lowpassAmplitudeGain(arg.frequency, arg.sampleRate);
  if (gain < 1e-9) {
    return null;
  }
  const startLevel =
    (Math.hypot(arg.cosine, arg.sine) *
      Math.exp(-arg.lambda * delay)) /
    gain;
  if (
    !Number.isFinite(startLevel) ||
    startLevel < 0.001 ||
    startLevel > 1 + 1e-9
  ) {
    return null;
  }
  const durationSec =
    arg.lambda > 0 ? Math.min(0.5, Math.log(1000) / arg.lambda) : 0.5;
  const endLevel =
    arg.lambda > 0 ? Math.exp(-arg.lambda * durationSec) : 1;
  const phase =
    (((Math.atan2(arg.cosine, arg.sine) +
      2 * Math.PI * arg.frequency * delay) %
      (2 * Math.PI)) +
      2 * Math.PI) %
    (2 * Math.PI);
  return {
    osc: {
      on: true,
      freqBase: arg.frequency,
      freqStart: arg.frequency,
      duration: durationSec,
      slope: 1,
      phase,
    },
    ampEnv: {
      startLevel: Math.min(1, startLevel),
      endLevel,
      duration: durationSec,
      slope: 1,
    },
  };
}

/** Перечисляет варианты: ничего не заменять, заменить один или два низких слота. */
function replacementSubsets(indices: number[]): number[][] {
  const subsets: number[][] = [[]];
  for (let first = 0; first < indices.length; first += 1) {
    const index = indices[first];
    if (index !== undefined) {
      subsets.push([index]);
    }
    for (
      let second = first + 1;
      second < indices.length;
      second += 1
    ) {
      const other = indices[second];
      if (index !== undefined && other !== undefined) {
        subsets.push([index, other]);
      }
    }
  }
  return subsets;
}

interface BaselineMetrics {
  trainRss: number;
  guardRss: number;
  selectionRss: number;
}

/** Считает train, guard и их сумму для одного WAV. */
function measureSelection(
  target: ArrayLike<number>,
  samples: ArrayLike<number>,
  sampleRate: number,
): BaselineMetrics {
  const trainRss = trainingRss(target, samples, sampleRate);
  const guard = guardRss(target, samples, sampleRate);
  return {
    trainRss,
    guardRss: guard,
    selectionRss: trainRss + guard,
  };
}

/** Вычитает выбранные solo-вклады из исходной суммы. */
function remainingRawAfterReplacement(
  context: RenderContext,
  replaced: number[],
): Float64Array {
  const remaining = new Float64Array(context.rawSum);
  for (const index of replaced) {
    const solo = context.solo[index];
    if (solo !== undefined) {
      for (let sample = 0; sample < remaining.length; sample += 1) {
        remaining[sample] =
          (remaining[sample] ?? 0) - (solo[sample] ?? 0);
      }
    }
  }
  return remaining;
}

/** Добавляет группы к остатку и применяет общий клиппинг синтезатора. */
function renderWithGroups(
  remainingRaw: Float64Array,
  groups: OscillatorGroup[],
  phaseModel: PhaseModel,
): Int16Array {
  const raw = new Float64Array(remainingRaw);
  for (const group of groups) {
    const synth = createOscillatorGroup(group, { phaseModel });
    for (let sample = 0; sample < raw.length; sample += 1) {
      raw[sample] =
        (raw[sample] ?? 0) +
        synth({ x: sample / SAMPLE_RATE }) *
          MAX_AMPLITUDE_16_BIT_WAV_ENCODED;
    }
  }
  return clampSamples(raw);
}

/** Формирует единый аудит обоих алгоритмов переноса. */
function makeCandidateAudit(arg: {
  mode: BeatTransferAudit['mode'];
  replaced: number[];
  pair: number[];
  coefficients: number[];
  groups: OscillatorGroup[];
  baseline: BaselineMetrics;
  target: ArrayLike<number>;
  samples: Int16Array;
  sampleRate: number;
}): BeatTransferAudit {
  const metrics = measureSelection(
    arg.target,
    arg.samples,
    arg.sampleRate,
  );
  const first = arg.groups[0];
  return {
    mode: arg.mode,
    applied: true,
    replacedOscillators: [...arg.replaced],
    pairOscillators: [...arg.pair],
    coefficients: [...arg.coefficients],
    startLevels: arg.groups.map((group) => group.ampEnv.startLevel),
    phases: arg.groups.map((group) => group.osc.phase),
    durationSec: first?.ampEnv.duration ?? 0.5,
    endLevel: first?.ampEnv.endLevel ?? 0.001,
    baselineTrainRss: arg.baseline.trainRss,
    candidateTrainRss: metrics.trainRss,
    baselineGuardRss: arg.baseline.guardRss,
    candidateGuardRss: metrics.guardRss,
    baselineSelectionRss: arg.baseline.selectionRss,
    candidateSelectionRss: metrics.selectionRss,
  };
}

/** Перерендеривает лучший вариант и откатывает его при отсутствии выигрыша. */
function finalizeBestCandidate(arg: {
  best: Candidate;
  original: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate: number;
  phaseModel: PhaseModel;
  baselineSamples: Int16Array;
  baseline: BaselineMetrics;
}): BeatTransferResult {
  const best = arg.best;
  best.samples = renderForTarget(
    best.patch,
    arg.target.length,
    arg.phaseModel,
  );
  const metrics = measureSelection(
    arg.target,
    best.samples,
    arg.sampleRate,
  );
  best.audit.candidateTrainRss = metrics.trainRss;
  best.audit.candidateGuardRss = metrics.guardRss;
  best.audit.candidateSelectionRss = metrics.selectionRss;
  if (metrics.selectionRss >= arg.baseline.selectionRss) {
    best.audit.applied = false;
    return {
      status: 'no-improvement',
      patch: clonePatch(arg.original),
      samples: arg.baselineSamples,
      audit: best.audit,
    };
  }
  return { status: 'candidate', ...best };
}

/** Строит один кандидат либо null, если уровни нельзя представить. */
function buildCandidate(arg: {
  original: ArgCreateSynth;
  target: ArrayLike<number>;
  fit: DampedBeatFit;
  sampleRate: number;
  phaseModel: PhaseModel;
  replaced: number[];
  free: number[];
  baseline: BaselineMetrics;
  renderContext: RenderContext;
}): Candidate | null {
  const available = [...arg.replaced, ...arg.free].sort(
    (a, b) => a - b,
  );
  const firstSlot = available[0];
  const secondSlot = available[1];
  if (firstSlot === undefined || secondSlot === undefined) {
    return null;
  }
  const remaining = clonePatch(arg.original);
  for (const index of arg.replaced) {
    const group = remaining.oscillators[index];
    if (group !== undefined) {
      group.osc.on = false;
    }
  }
  const remainingRaw = remainingRawAfterReplacement(
    arg.renderContext,
    arg.replaced,
  );
  const remainingSamples = clampSamples(remainingRaw);
  const residual = Float64Array.from(
    arg.target,
    (value, index) => value - (remainingSamples[index] ?? 0),
  );
  const coefficients = fitBoundedPair({
    residual,
    fit: arg.fit,
    sampleRate: arg.sampleRate,
  });
  const first = componentFromCoefficients({
    cosine: coefficients[0] ?? 0,
    sine: coefficients[1] ?? 0,
    frequency: arg.fit.f1,
    lambda: arg.fit.lambda,
    sampleRate: arg.sampleRate,
  });
  const second = componentFromCoefficients({
    cosine: coefficients[2] ?? 0,
    sine: coefficients[3] ?? 0,
    frequency: arg.fit.f2,
    lambda: arg.fit.lambda,
    sampleRate: arg.sampleRate,
  });
  if (first === null || second === null) {
    return null;
  }
  const patch = clonePatch(remaining);
  patch.oscillators[firstSlot] = first;
  patch.oscillators[secondSlot] = second;
  const samples = renderWithGroups(
    remainingRaw,
    [first, second],
    arg.phaseModel,
  );
  return {
    patch,
    samples,
    audit: makeCandidateAudit({
      mode: 'replace',
      replaced: arg.replaced,
      pair: [firstSlot, secondSlot],
      coefficients,
      groups: [first, second],
      baseline: arg.baseline,
      target: arg.target,
      samples,
      sampleRate: arg.sampleRate,
    }),
  };
}

/**
 * Подбирает замену нуля, одного или двух низких осцилляторов.
 * Коэффициенты подгоняются по 80–180 мс, а слоты выбираются по ошибке
 * на 80–180 мс плюс атаке и хвосту вне validation. Участок 180–300 мс
 * не участвует в отборе. Исходный `fit` должен быть принят на том же WAV.
 */
export function restoreBeatPair(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  fit: DampedBeatFit;
  sampleRate?: number;
  phaseModel?: PhaseModel;
}): BeatTransferResult {
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Перенос поддерживает только WAV 44100 Гц');
  }
  if (!arg.fit.accepted) {
    throw new Error('Нельзя переносить отклонённую модель биения');
  }
  if (arg.target.length === 0) {
    throw new Error('Пустой исходный WAV');
  }
  const baselineSamples = renderForTarget(
    arg.patch,
    arg.target.length,
    phaseModel,
  );
  const baseline = measureSelection(
    arg.target,
    baselineSamples,
    sampleRate,
  );
  const renderContext = buildRenderContext(
    arg.patch,
    phaseModel,
    arg.target.length,
  );
  const free = arg.patch.oscillators
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => !group.osc.on)
    .map(({ index }) => index);
  const low = arg.patch.oscillators
    .map((group, index) => ({ group, index }))
    .filter(
      ({ group }) =>
        group.osc.on &&
        group.osc.freqBase >= 25 &&
        group.osc.freqBase <= 250,
    )
    .map(({ index }) => index);
  let best: Candidate | null = null;
  for (const replaced of replacementSubsets(low)) {
    const candidate = buildCandidate({
      original: arg.patch,
      target: arg.target,
      fit: arg.fit,
      sampleRate,
      phaseModel,
      replaced,
      free,
      baseline,
      renderContext,
    });
    if (
      candidate !== null &&
      (best === null ||
        candidate.audit.candidateSelectionRss <
          best.audit.candidateSelectionRss)
    ) {
      best = candidate;
    }
  }
  if (best === null) {
    return {
      status: 'no-feasible-replacement',
      patch: clonePatch(arg.patch),
      samples: baselineSamples,
      audit: null,
    };
  }
  return finalizeBestCandidate({
    best,
    original: arg.patch,
    target: arg.target,
    sampleRate,
    phaseModel,
    baselineSamples,
    baseline,
  });
}

/** Рендерит один osc group с заданной фазой в int16-шкале без клиппинга суммы. */
function renderGroupPhase(
  group: OscillatorGroup,
  phase: number,
  phaseModel: PhaseModel,
  sampleCount: number,
): Float64Array {
  const copy = clonePatch({ oscillators: [group] }).oscillators[0];
  if (copy === undefined) {
    return new Float64Array(0);
  }
  copy.osc.phase = phase;
  const synth = createOscillatorGroup(copy, { phaseModel });
  return Float64Array.from(
    { length: sampleCount },
    (_, index) =>
      synth({ x: index / SAMPLE_RATE }) *
      MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  );
}

/** Возвращает только отсчёты обучающего участка. */
function trainingValues(
  samples: ArrayLike<number>,
  sampleRate: number,
): number[] {
  const values: number[] = [];
  const start = Math.round(0.08 * sampleRate);
  const end = Math.min(samples.length, Math.round(0.18 * sampleRate));
  for (let index = start; index < end; index += 1) {
    values.push(samples[index] ?? 0);
  }
  return values;
}

/** Подгоняет две пары sin/cos с единичной амплитудой каждой фазы. */
function fitPhaseCoefficients(
  columns: number[][],
  values: number[],
): number[] {
  const coefficients = solveLeastSquares(columns, values);
  capBlock(coefficients, 0, 1);
  capBlock(coefficients, 2, 1);
  let best = [...coefficients];
  let bestRss = coefficientRss(columns, best, values);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    for (const block of [0, 1]) {
      const other = block === 0 ? 2 : 0;
      const residual = values.map((value, index) => {
        const first = columns[other]?.[index] ?? 0;
        const second = columns[other + 1]?.[index] ?? 0;
        return (
          value -
          first * (coefficients[other] ?? 0) -
          second * (coefficients[other + 1] ?? 0)
        );
      });
      const pair = solveLeastSquares(
        columns.slice(block * 2, block * 2 + 2),
        residual,
      );
      coefficients[block * 2] = pair[0] ?? 0;
      coefficients[block * 2 + 1] = pair[1] ?? 0;
      capBlock(coefficients, block * 2, 1);
    }
    const rss = coefficientRss(columns, coefficients, values);
    if (rss < bestRss) {
      best = [...coefficients];
      bestRss = rss;
    } else {
      break;
    }
  }
  for (const offset of [0, 2]) {
    const cosine = best[offset] ?? 0;
    const sine = best[offset + 1] ?? 0;
    const amplitude = Math.hypot(cosine, sine);
    if (amplitude > 0) {
      best[offset] = cosine / amplitude;
      best[offset + 1] = sine / amplitude;
    }
  }
  return best;
}

/** Возвращает все пары слотов с наилучшим порядком f1/f2 для каждой. */
function phasePairs(
  patch: ArgCreateSynth,
  fit: DampedBeatFit,
): [number, number][] {
  const low = patch.oscillators
    .map((group, index) => ({ group, index }))
    .filter(
      ({ group }) =>
        group.osc.on &&
        group.osc.freqBase >= 25 &&
        group.osc.freqBase <= 250,
    );
  const pairs: { indices: [number, number]; cost: number }[] = [];
  for (let first = 0; first < low.length; first += 1) {
    for (let second = first + 1; second < low.length; second += 1) {
      const a = low[first];
      const b = low[second];
      if (a === undefined || b === undefined) {
        continue;
      }
      const forward =
        Math.abs(Math.log(a.group.osc.freqBase / fit.f1)) +
        Math.abs(Math.log(b.group.osc.freqBase / fit.f2));
      const reverse =
        Math.abs(Math.log(a.group.osc.freqBase / fit.f2)) +
        Math.abs(Math.log(b.group.osc.freqBase / fit.f1));
      pairs.push({
        indices:
          forward <= reverse
            ? [a.index, b.index]
            : [b.index, a.index],
        cost: Math.min(forward, reverse),
      });
    }
  }
  return pairs
    .sort((a, b) => a.cost - b.cost)
    .map(({ indices }) => indices);
}

/** Подгоняет фазы существующей пары к остатку и возвращает sin/cos коэффициенты. */
function fitExistingPairPhases(arg: {
  first: OscillatorGroup;
  second: OscillatorGroup;
  residual: ArrayLike<number>;
  sampleRate: number;
  phaseModel: PhaseModel;
  sampleCount: number;
}): { coefficients: number[]; phases: [number, number] } {
  const firstSin = renderGroupPhase(
    arg.first,
    0,
    arg.phaseModel,
    arg.sampleCount,
  );
  const firstCos = renderGroupPhase(
    arg.first,
    Math.PI / 2,
    arg.phaseModel,
    arg.sampleCount,
  );
  const secondSin = renderGroupPhase(
    arg.second,
    0,
    arg.phaseModel,
    arg.sampleCount,
  );
  const secondCos = renderGroupPhase(
    arg.second,
    Math.PI / 2,
    arg.phaseModel,
    arg.sampleCount,
  );
  const columns = [firstSin, firstCos, secondSin, secondCos].map(
    (samples) => trainingValues(samples, arg.sampleRate),
  );
  const coefficients = fitPhaseCoefficients(
    columns,
    trainingValues(arg.residual, arg.sampleRate),
  );
  const wrap = (sine: number, cosine: number): number =>
    ((Math.atan2(sine, cosine) % (2 * Math.PI)) + 2 * Math.PI) %
    (2 * Math.PI);
  return {
    coefficients,
    phases: [
      wrap(coefficients[1] ?? 0, coefficients[0] ?? 0),
      wrap(coefficients[3] ?? 0, coefficients[2] ?? 0),
    ],
  };
}

/** Строит кандидат с сохранёнными amp envelope двух существующих слотов. */
function buildPhaseCandidate(arg: {
  original: ArgCreateSynth;
  target: ArrayLike<number>;
  fit: DampedBeatFit;
  sampleRate: number;
  phaseModel: PhaseModel;
  pair: [number, number];
  baseline: BaselineMetrics;
  renderContext: RenderContext;
}): Candidate | null {
  const [firstSlot, secondSlot] = arg.pair;
  const originalFirst = arg.original.oscillators[firstSlot];
  const originalSecond = arg.original.oscillators[secondSlot];
  if (originalFirst === undefined || originalSecond === undefined) {
    return null;
  }
  const remainingRaw = remainingRawAfterReplacement(
    arg.renderContext,
    arg.pair,
  );
  const remaining = clampSamples(remainingRaw);
  const residual = Float64Array.from(
    arg.target,
    (value, index) => value - (remaining[index] ?? 0),
  );
  const first = clonePatch({ oscillators: [originalFirst] })
    .oscillators[0];
  const second = clonePatch({ oscillators: [originalSecond] })
    .oscillators[0];
  if (first === undefined || second === undefined) {
    return null;
  }
  first.osc.freqBase = arg.fit.f1;
  second.osc.freqBase = arg.fit.f2;
  const { coefficients, phases } = fitExistingPairPhases({
    first,
    second,
    residual,
    sampleRate: arg.sampleRate,
    phaseModel: arg.phaseModel,
    sampleCount: remainingRaw.length,
  });
  first.osc.phase = phases[0];
  second.osc.phase = phases[1];
  const patch = clonePatch(arg.original);
  patch.oscillators[firstSlot] = first;
  patch.oscillators[secondSlot] = second;
  const samples = renderWithGroups(
    remainingRaw,
    [first, second],
    arg.phaseModel,
  );
  return {
    patch,
    samples,
    audit: makeCandidateAudit({
      mode: 'phase-repair',
      replaced: arg.pair,
      pair: arg.pair,
      coefficients,
      groups: [first, second],
      baseline: arg.baseline,
      target: arg.target,
      samples,
      sampleRate: arg.sampleRate,
    }),
  };
}

/** Небольшие множители огибающей, проверяемые без validation. */
const ENVELOPE_KNOBS = {
  startLevel: [0.8, 0.9, 1, 1.1, 1.25],
  duration: [0.75, 0.8, 1, 1.25, 1.333],
  slope: [0.75, 0.8, 1, 1.25, 1.333],
  endLevel: [0.5, 1, 2],
} as const;

type EnvelopeKnob = keyof typeof ENVELOPE_KNOBS;

/** Применяет один множитель к amp envelope с границами синтезатора. */
function scaledEnvelopeGroup(
  source: OscillatorGroup,
  knob: EnvelopeKnob,
  multiplier: number,
): OscillatorGroup {
  const group = clonePatch({ oscillators: [source] }).oscillators[0];
  if (group === undefined) {
    return source;
  }
  if (knob === 'startLevel') {
    group.ampEnv.startLevel = Math.max(
      0.001,
      Math.min(1, group.ampEnv.startLevel * multiplier),
    );
  } else if (knob === 'duration') {
    group.ampEnv.duration = Math.max(
      1 / SAMPLE_RATE,
      Math.min(0.5, group.ampEnv.duration * multiplier),
    );
  } else if (knob === 'slope') {
    group.ampEnv.slope = Math.max(
      0.2,
      Math.min(2, group.ampEnv.slope * multiplier),
    );
  } else {
    group.ampEnv.endLevel = Math.max(
      0.001,
      Math.min(1, (group.ampEnv.endLevel ?? 0.001) * multiplier),
    );
  }
  return group;
}

/** Доводит две огибающие малыми шагами по train+guard, не по validation. */
function refineCandidateEnvelopes(arg: {
  candidate: Candidate;
  target: ArrayLike<number>;
  sampleRate: number;
  phaseModel: PhaseModel;
}): Candidate {
  const current = arg.candidate;
  current.audit.mode = 'envelope-repair';
  const context = buildRenderContext(
    current.patch,
    arg.phaseModel,
    current.samples.length,
  );
  for (let round = 0; round < 2; round += 1) {
    for (const slot of current.audit.pairOscillators) {
      let source = current.patch.oscillators[slot];
      if (source === undefined) {
        continue;
      }
      for (const knob of Object.keys(
        ENVELOPE_KNOBS,
      ) as EnvelopeKnob[]) {
        for (const multiplier of ENVELOPE_KNOBS[knob]) {
          const group = scaledEnvelopeGroup(source, knob, multiplier);
          const solo = renderGroupPhase(
            group,
            group.osc.phase,
            arg.phaseModel,
            context.rawSum.length,
          );
          const previous = context.solo[slot];
          const raw = new Float64Array(context.rawSum);
          for (let index = 0; index < raw.length; index += 1) {
            raw[index] =
              (raw[index] ?? 0) -
              (previous?.[index] ?? 0) +
              (solo[index] ?? 0);
          }
          const samples = clampSamples(raw);
          const train = trainingRss(
            arg.target,
            samples,
            arg.sampleRate,
          );
          const guard = guardRss(arg.target, samples, arg.sampleRate);
          const selection = train + guard;
          if (selection >= current.audit.candidateSelectionRss) {
            continue;
          }
          current.patch.oscillators[slot] = group;
          context.solo[slot] = solo;
          context.rawSum = raw;
          current.samples = samples;
          current.audit.candidateTrainRss = train;
          current.audit.candidateGuardRss = guard;
          current.audit.candidateSelectionRss = selection;
        }
        source = current.patch.oscillators[slot] ?? source;
      }
    }
  }
  current.audit.startLevels = current.audit.pairOscillators.map(
    (slot) =>
      current.patch.oscillators[slot]?.ampEnv.startLevel ?? 0.001,
  );
  const first =
    current.patch.oscillators[current.audit.pairOscillators[0] ?? -1];
  if (first !== undefined) {
    current.audit.durationSec = first.ampEnv.duration;
    current.audit.endLevel = first.ampEnv.endLevel ?? 0.001;
  }
  return current;
}

/**
 * По умолчанию меняет только freqBase и фазы двух существующих низких
 * осцилляторов; их startLevel и amp envelope сохраняются. При
 * `refineEnvelopes=true` затем проверяет малые множители startLevel,
 * duration, slope и endLevel. `freqStart`, duration и slope частотной
 * огибающей сохраняются во всех режимах.
 *
 * @remarks Selection — RSS на 80–180 мс плюс RSS на 0–80 мс и после
 *   300 мс. Участок 180–300 мс не участвует в выборе пары, фаз или
 *   огибающих. `candidate` улучшает только этот selection; validation
 *   R² и global проверяются отдельно и могут не вырасти.
 */
export function repairExistingBeatPair(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  fit: DampedBeatFit;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  refineEnvelopes?: boolean;
}): BeatTransferResult {
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Фазовый ремонт поддерживает только 44100 Гц');
  }
  if (!arg.fit.accepted) {
    throw new Error('Нельзя переносить отклонённую модель биения');
  }
  const baselineSamples = renderForTarget(
    arg.patch,
    arg.target.length,
    phaseModel,
  );
  const baseline = measureSelection(
    arg.target,
    baselineSamples,
    sampleRate,
  );
  const renderContext = buildRenderContext(
    arg.patch,
    phaseModel,
    arg.target.length,
  );
  let best: Candidate | null = null;
  for (const pair of phasePairs(arg.patch, arg.fit)) {
    const candidate = buildPhaseCandidate({
      original: arg.patch,
      target: arg.target,
      fit: arg.fit,
      sampleRate,
      phaseModel,
      pair,
      baseline,
      renderContext,
    });
    if (
      candidate !== null &&
      (best === null ||
        candidate.audit.candidateSelectionRss <
          best.audit.candidateSelectionRss)
    ) {
      best = candidate;
    }
  }
  if (best === null) {
    return {
      status: 'no-feasible-replacement',
      patch: clonePatch(arg.patch),
      samples: baselineSamples,
      audit: null,
    };
  }
  if (arg.refineEnvelopes === true) {
    best = refineCandidateEnvelopes({
      candidate: best,
      target: arg.target,
      sampleRate,
      phaseModel,
    });
  }
  return finalizeBestCandidate({
    best,
    original: arg.patch,
    target: arg.target,
    sampleRate,
    phaseModel,
    baselineSamples,
    baseline,
  });
}
