/** Переводит diagnostic-onset candidate в настоящий canonical patch/WAV. */
import { SAMPLE_RATE } from '../consts';
import { computeUsefulZone } from '../optimize/evaluate';
import {
  oscConfigNormales,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import { groupFromAtom } from './matching-pursuit';
import type { AtomDescription } from './matching-pursuit';
import {
  clonePatch,
  createInitialState,
  measureMetrics,
  renderForTarget,
  type QuadratureFit,
  type RefitMetrics,
} from './quadrature-refit';

/** Один атом из сохранённого onset-отчёта. */
export interface DelayedCandidateAtom {
  slot: number;
  description: AtomDescription;
  delaySamples: number;
  fit: QuadratureFit;
}

/** Минимальная часть onset candidate, нужная для canonical patch. */
export interface DelayedCandidate {
  mode: 'K1' | 'K2';
  slots: number[];
  atoms: DelayedCandidateAtom[];
}

/** Результат canonical проверки и защиты исходного match. */
export interface DelayedPatchResult {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  baseline: RefitMetrics;
  candidateMetrics: RefitMetrics;
  metrics: RefitMetrics;
}

/**
 * Считает только атомы с фактически ненулевым onset.
 *
 * @param candidate - Кандидат K1 или K2 из onset-отчёта
 * @returns Число атомов с `delaySamples > 0`; в mixed K2 нулевой атом
 *   не входит в счёт
 */
export function countDelayedAtoms(
  candidate: DelayedCandidate,
): number {
  return candidate.atoms.filter((atom) => atom.delaySamples > 0)
    .length;
}

/**
 * Строит canonical patch из exact onset candidate, не меняя исходник.
 *
 * @param source - Исходный match-патч
 * @param candidate - Один или два атома с независимыми слотами и onset
 * @returns Независимый патч с заменёнными группами в слотах candidate
 * @throws Error если число атомов не соответствует слотам, слот невалиден
 *   или повторяется, либо onset не целый, отрицателен или превышает
 *   допустимый диапазон синтезатора
 * @remarks Нулевой onset не записывается в `osc.delay`, чтобы сохранить
 *   прежнюю форму JSON. Положительный onset переводится из отсчётов в
 *   секунды; остальные слоты остаются без изменений.
 */
export function patchFromDelayedCandidate(
  source: ArgCreateSynth,
  candidate: DelayedCandidate,
): ArgCreateSynth {
  if (
    candidate.atoms.length < 1 ||
    candidate.atoms.length > 2 ||
    candidate.atoms.length !== candidate.slots.length
  ) {
    throw new Error(
      'Delayed candidate должен содержать один или два атома',
    );
  }
  const patch = clonePatch(source);
  const used = new Set<number>();
  for (let index = 0; index < candidate.atoms.length; index += 1) {
    const atom = candidate.atoms[index];
    const slot = candidate.slots[index];
    if (
      atom === undefined ||
      slot === undefined ||
      atom.slot !== slot ||
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= patch.oscillators.length ||
      used.has(slot)
    ) {
      throw new Error(
        'Неверный или повторный слот delayed candidate',
      );
    }
    if (
      !Number.isInteger(atom.delaySamples) ||
      atom.delaySamples < 0 ||
      atom.delaySamples > oscDelayMaxSamples()
    ) {
      throw new Error(
        'delaySamples выходит за допустимый диапазон synth',
      );
    }
    const group = groupFromAtom(atom.description, atom.fit);
    const delay = atom.delaySamples / SAMPLE_RATE;
    patch.oscillators[slot] = {
      osc: delay === 0 ? group.osc : { ...group.osc, delay },
      ampEnv: group.ampEnv,
    };
    used.add(slot);
  }
  return patch;
}

/** Максимальное число отсчётов задержки из нормы synth 0.5 с. */
function oscDelayMaxSamples(): number {
  return Math.floor(oscConfigNormales.delay.max * SAMPLE_RATE);
}

/**
 * Рендерит delayed patch и принимает его только при росте global и J-floor.
 *
 * @param arg - Исходный патч, onset candidate, target PCM и опции синтеза;
 *   sample rate по умолчанию 44100 Гц, модель фазы — `legacy`
 * @returns Метрики baseline и candidate, а также принятый либо исходный
 *   patch и его canonical PCM
 * @throws Error если sample rate отличается от 44100 Гц, target пуст или
 *   candidate не проходит проверки слотов и задержек
 * @remarks Candidate принимается при строгом росте global и снижении
 *   windowed suppression не более чем на 0.05 п.п. При отказе функция
 *   возвращает клон исходного patch и его canonical samples. Новый
 *   coordinate descent не запускается.
 */
export function realizeDelayedCandidate(arg: {
  source: ArgCreateSynth;
  candidate: DelayedCandidate;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
}): DelayedPatchResult {
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Delayed patch поддерживает только 44100 Гц');
  }
  if (arg.target.length === 0) {
    throw new Error('Пустой target');
  }
  const target = Array.from(arg.target);
  const zone = computeUsefulZone(target, sampleRate);
  const initial = createInitialState({
    patch: arg.source,
    target,
    sampleRate,
    phaseModel,
    usefulZone: zone,
  });
  const candidatePatch = patchFromDelayedCandidate(
    arg.source,
    arg.candidate,
  );
  const candidateSamples = renderForTarget(
    candidatePatch,
    target.length,
    phaseModel,
  );
  const candidateMetrics = measureMetrics(
    candidateSamples,
    target,
    sampleRate,
    zone,
  );
  const accepted =
    candidateMetrics.globalSuppressionPercent >
      initial.metrics.globalSuppressionPercent &&
    candidateMetrics.windowedSuppressionPercent >=
      initial.metrics.windowedSuppressionPercent - 0.05;
  if (!accepted) {
    return {
      status: 'unchanged',
      patch: clonePatch(arg.source),
      samples: initial.samples,
      baseline: initial.metrics,
      candidateMetrics,
      metrics: initial.metrics,
    };
  }
  return {
    status: 'refined',
    patch: candidatePatch,
    samples: candidateSamples,
    baseline: initial.metrics,
    candidateMetrics,
    metrics: candidateMetrics,
  };
}
