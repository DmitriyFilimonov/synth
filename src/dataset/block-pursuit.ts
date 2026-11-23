/**
 * Screening совместного residual pursuit для одного или двух слотов.
 * Оба режима используют один словарь и проверяют несколько слотов.
 * Это offline-эксперимент: production match, enhance и API его не
 * вызывают. Результат screening не доказывает закон T35.
 */
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import {
  computeUsefulZone,
  type UsefulZone,
} from '../optimize/evaluate';
import type { ArgCreateSynth, PhaseModel } from '../synth';
import { solveBoundedQuadratureSystem } from './bounded-quadrature';
import {
  buildContributions,
  buildPursuitDictionary,
  globalOfSamples,
  groupFromAtom,
  type AtomDescription,
  type SearchWindow,
} from './matching-pursuit';
import {
  clonePatch,
  createInitialState,
  measureMetrics,
  quantizeRaw,
  renderForTarget,
  renderGroup,
  unitGroup,
  type QuadratureFit,
  type RefitMetrics,
  type RenderState,
} from './quadrature-refit';

/** Число одновременно заменяемых слотов. */
export type PursuitBlockSize = 1 | 2;

/** Один атом, принятый внутри одиночного или парного блока. */
export interface BlockPursuitAtom {
  slot: number;
  replacedFrequency: number | null;
  frequency: number;
  freqStart: number;
  duration: number;
  slope: number;
  oscDuration: number;
  oscSlope: number;
  window: SearchWindow;
  sweepTemplateIndex: number | null;
  localGain: number;
  startLevel: number;
  phase: number;
}

/** Метрики и стоимость одного принятого блока. */
export interface BlockPursuitStep {
  step: number;
  atoms: BlockPursuitAtom[];
  before: RefitMetrics;
  after: RefitMetrics;
  exactCandidates: number;
  jointCandidates: number;
  slotSetsEvaluated: number;
}

/** Итог поиска; unchanged всегда возвращает исходный patch и WAV. */
export interface BlockPursuitResult {
  status: 'refined' | 'unchanged';
  patch: ArgCreateSynth;
  samples: Int16Array;
  baseline: RefitMetrics;
  metrics: RefitMetrics;
  steps: BlockPursuitStep[];
  localEvaluations: number;
  jointEvaluations: number;
  exactEvaluations: number;
  basisRenders: number;
  slotSetsEvaluated: number;
  replacementCount: number;
}

interface SlotSetChoice {
  slots: number[];
  rawWithout: Float64Array;
  globalAfterRemoval: number;
}

interface PreparedAtom {
  description: AtomDescription;
  sine: Float64Array;
  cosine: Float64Array;
  selfGram: number[];
  rhs: number[];
}

interface JointFit {
  fits: QuadratureFit[];
  gain: number;
}

interface BlockCandidate {
  state: RenderState;
  atoms: PreparedAtom[];
  fits: QuadratureFit[];
  choice: SlotSetChoice;
}

interface AttemptCounters {
  localEvaluations: number;
  jointEvaluations: number;
  exactEvaluations: number;
  basisRenders: number;
  slotSetsEvaluated: number;
}

interface AcceptedBlock {
  state: RenderState;
  contributions: (Float64Array | null)[];
  audit: BlockPursuitStep;
}

const DEFAULT_BLOCKS = 6;
export const MAX_BLOCKS = 12;
const SLOT_SHORTLIST_SIZE = 4;
const SLOT_SETS_TO_SEARCH = 2;
const EXACT_PAIRS_PER_SLOT_SET = 8;
const MIN_GLOBAL_GAIN = 0.005;
const CURRENT_WINDOWED_TOLERANCE = 0.01;
const INITIAL_WINDOWED_TOLERANCE = 0.05;

/** Скалярное произведение двух одинаково длинных массивов. */
function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let value = 0;
  for (let index = 0; index < a.length; index += 1) {
    value += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return value;
}

/**
 * Совместно подгоняет один или два атома к остатку полного сигнала.
 *
 * @param arg - Sine/cosine-базисы, target PCM в int16-шкале и
 *   необрезанная сумма синтеза без выбранных слотов
 * @returns Квадратуры атомов либо `null` при несовместимых размерах,
 *   вырожденном базисе или отсутствии допустимого решения
 * @remarks Порядок базисов: sine/cosine первого атома, затем второго.
 *   Норма квадратур каждого атома ограничена диапазоном [0.001, 1].
 */
export function fitQuadratureBlock(arg: {
  basis: Float64Array[];
  target: ArrayLike<number>;
  rawWithout: ArrayLike<number>;
}): QuadratureFit[] | null {
  const atomCount = arg.basis.length / 2;
  if (
    !Number.isInteger(atomCount) ||
    atomCount < 1 ||
    atomCount > 2 ||
    arg.target.length === 0 ||
    arg.target.length !== arg.rawWithout.length ||
    arg.basis.some((basis) => basis.length !== arg.target.length)
  ) {
    return null;
  }
  const size = atomCount * 2;
  const gram = new Array<number>(size * size).fill(0);
  for (let row = 0; row < size; row += 1) {
    for (let column = row; column < size; column += 1) {
      const value = dot(
        arg.basis[row] ?? new Float64Array(),
        arg.basis[column] ?? new Float64Array(),
      );
      gram[row * size + column] = value;
      gram[column * size + row] = value;
    }
  }
  const residual = Float64Array.from(
    { length: arg.target.length },
    (_, index) =>
      (arg.target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      (arg.rawWithout[index] ?? 0),
  );
  const rhs = arg.basis.map((basis) => dot(basis, residual));
  return solveBoundedQuadratureSystem(gram, rhs, atomCount);
}

/** Вычитает вклады выбранных слотов из необрезанной суммы синтеза. */
function rawWithoutSlots(arg: {
  rawSum: Float64Array;
  contributions: (Float64Array | null)[];
  slots: number[];
}): Float64Array {
  const raw = new Float64Array(arg.rawSum);
  for (const slot of arg.slots) {
    const contribution = arg.contributions[slot];
    if (contribution === null || contribution === undefined) {
      continue;
    }
    for (let index = 0; index < raw.length; index += 1) {
      raw[index] = (raw[index] ?? 0) - (contribution[index] ?? 0);
    }
  }
  return raw;
}

/** Ранжирует все ещё не менявшиеся слоты по потере global при удалении. */
function rankSingleSlots(arg: {
  state: RenderState;
  contributions: (Float64Array | null)[];
  target: number[];
  usedSlots: ReadonlySet<number>;
}): SlotSetChoice[] {
  const ranked: SlotSetChoice[] = [];
  for (
    let slot = 0;
    slot < arg.state.patch.oscillators.length;
    slot += 1
  ) {
    if (arg.usedSlots.has(slot)) {
      continue;
    }
    const group = arg.state.patch.oscillators[slot];
    if (group === undefined) {
      continue;
    }
    const rawWithout = rawWithoutSlots({
      rawSum: arg.state.rawSum,
      contributions: arg.contributions,
      slots: [slot],
    });
    const globalAfterRemoval = group.osc.on
      ? globalOfSamples(quantizeRaw(rawWithout), arg.target)
      : arg.state.metrics.globalSuppressionPercent;
    ranked.push({ slots: [slot], rawWithout, globalAfterRemoval });
  }
  ranked.sort(
    (a, b) =>
      b.globalAfterRemoval - a.globalAfterRemoval ||
      (a.slots[0] ?? 0) - (b.slots[0] ?? 0),
  );
  return ranked;
}

/** Строит до двух одиночных слотов или двух пар из четырёх лучших слотов. */
function rankSlotSets(arg: {
  state: RenderState;
  contributions: (Float64Array | null)[];
  target: number[];
  usedSlots: ReadonlySet<number>;
  blockSize: PursuitBlockSize;
}): SlotSetChoice[] {
  const singles = rankSingleSlots(arg);
  if (arg.blockSize === 1) {
    return singles.slice(0, SLOT_SETS_TO_SEARCH);
  }
  const pairs: SlotSetChoice[] = [];
  const shortlist = singles.slice(0, SLOT_SHORTLIST_SIZE);
  for (let first = 0; first < shortlist.length; first += 1) {
    for (
      let second = first + 1;
      second < shortlist.length;
      second += 1
    ) {
      const firstChoice = shortlist[first];
      const secondChoice = shortlist[second];
      if (firstChoice === undefined || secondChoice === undefined) {
        continue;
      }
      const slots = [
        firstChoice.slots[0] ?? -1,
        secondChoice.slots[0] ?? -1,
      ];
      const rawWithout = rawWithoutSlots({
        rawSum: arg.state.rawSum,
        contributions: arg.contributions,
        slots,
      });
      pairs.push({
        slots,
        rawWithout,
        globalAfterRemoval: globalOfSamples(
          quantizeRaw(rawWithout),
          arg.target,
        ),
      });
    }
  }
  pairs.sort(
    (a, b) =>
      b.globalAfterRemoval - a.globalAfterRemoval ||
      (a.slots[0] ?? 0) - (b.slots[0] ?? 0) ||
      (a.slots[1] ?? 0) - (b.slots[1] ?? 0),
  );
  return pairs.slice(0, SLOT_SETS_TO_SEARCH);
}

/** Точно рендерит sine/cosine базисы описания и считает его проекции. */
function prepareAtom(arg: {
  description: AtomDescription;
  target: number[];
  fitResidual: Float64Array;
  phaseModel: PhaseModel;
}): PreparedAtom {
  const template = groupFromAtom(arg.description, {
    sineCoefficient: 1,
    cosineCoefficient: 0,
    startLevel: 1,
    phase: 0,
  });
  const sine = renderGroup(
    unitGroup(template, 0),
    arg.target.length,
    arg.phaseModel,
  );
  const cosine = renderGroup(
    unitGroup(template, Math.PI / 2),
    arg.target.length,
    arg.phaseModel,
  );
  return {
    description: arg.description,
    sine,
    cosine,
    selfGram: [
      dot(sine, sine),
      dot(sine, cosine),
      dot(cosine, cosine),
    ],
    rhs: [dot(sine, arg.fitResidual), dot(cosine, arg.fitResidual)],
  };
}

/** Собирает нормальную систему из одного или двух подготовленных атомов. */
function equationsForAtoms(atoms: PreparedAtom[]): {
  gram: number[];
  rhs: number[];
} {
  const size = atoms.length * 2;
  const gram = new Array<number>(size * size).fill(0);
  const rhs = atoms.flatMap((atom) => atom.rhs);
  for (let atomIndex = 0; atomIndex < atoms.length; atomIndex += 1) {
    const atom = atoms[atomIndex];
    if (atom === undefined) {
      continue;
    }
    const offset = atomIndex * 2;
    gram[offset * size + offset] = atom.selfGram[0] ?? 0;
    gram[offset * size + offset + 1] = atom.selfGram[1] ?? 0;
    gram[(offset + 1) * size + offset] = atom.selfGram[1] ?? 0;
    gram[(offset + 1) * size + offset + 1] = atom.selfGram[2] ?? 0;
    for (
      let otherIndex = atomIndex + 1;
      otherIndex < atoms.length;
      otherIndex += 1
    ) {
      const other = atoms[otherIndex];
      if (other === undefined) {
        continue;
      }
      const otherOffset = otherIndex * 2;
      const cross = [
        dot(atom.sine, other.sine),
        dot(atom.sine, other.cosine),
        dot(atom.cosine, other.sine),
        dot(atom.cosine, other.cosine),
      ];
      for (let row = 0; row < 2; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          const value = cross[row * 2 + column] ?? 0;
          gram[(offset + row) * size + otherOffset + column] = value;
          gram[(otherOffset + column) * size + offset + row] = value;
        }
      }
    }
  }
  return { gram, rhs };
}

/** Совместно подгоняет атомы и оценивает локальное снижение RSS. */
function fitPreparedAtoms(atoms: PreparedAtom[]): JointFit | null {
  const equations = equationsForAtoms(atoms);
  const fits = solveBoundedQuadratureSystem(
    equations.gram,
    equations.rhs,
    atoms.length,
  );
  if (fits === null) {
    return null;
  }
  const coefficients = fits.flatMap((fit) => [
    fit.sineCoefficient,
    fit.cosineCoefficient,
  ]);
  let linear = 0;
  let quadratic = 0;
  for (let row = 0; row < coefficients.length; row += 1) {
    linear += (coefficients[row] ?? 0) * (equations.rhs[row] ?? 0);
    for (let column = 0; column < coefficients.length; column += 1) {
      quadratic +=
        (coefficients[row] ?? 0) *
        (equations.gram[row * coefficients.length + column] ?? 0) *
        (coefficients[column] ?? 0);
    }
  }
  const gain = 2 * linear - quadratic;
  return Number.isFinite(gain) ? { fits, gain } : null;
}

/** Строит кандидат и считает обе метрики по полному квантованному WAV. */
function renderBlockCandidate(arg: {
  state: RenderState;
  choice: SlotSetChoice;
  atoms: PreparedAtom[];
  fits: QuadratureFit[];
  target: number[];
  sampleRate: number;
  zone: UsefulZone;
}): BlockCandidate | null {
  if (arg.atoms.length !== arg.fits.length) {
    return null;
  }
  const rawSum = new Float64Array(arg.choice.rawWithout);
  for (
    let atomIndex = 0;
    atomIndex < arg.atoms.length;
    atomIndex += 1
  ) {
    const atom = arg.atoms[atomIndex];
    const fit = arg.fits[atomIndex];
    if (atom === undefined || fit === undefined) {
      return null;
    }
    for (let index = 0; index < rawSum.length; index += 1) {
      rawSum[index] =
        (rawSum[index] ?? 0) +
        fit.sineCoefficient * (atom.sine[index] ?? 0) +
        fit.cosineCoefficient * (atom.cosine[index] ?? 0);
    }
  }
  const samples = quantizeRaw(rawSum);
  const metrics = measureMetrics(
    samples,
    arg.target,
    arg.sampleRate,
    arg.zone,
  );
  if (
    !Number.isFinite(metrics.globalSuppressionPercent) ||
    !Number.isFinite(metrics.windowedSuppressionPercent)
  ) {
    return null;
  }
  const patch = clonePatch(arg.state.patch);
  for (
    let atomIndex = 0;
    atomIndex < arg.atoms.length;
    atomIndex += 1
  ) {
    const atom = arg.atoms[atomIndex];
    const fit = arg.fits[atomIndex];
    const slot = arg.choice.slots[atomIndex];
    if (
      atom === undefined ||
      fit === undefined ||
      slot === undefined
    ) {
      return null;
    }
    patch.oscillators[slot] = groupFromAtom(atom.description, fit);
  }
  return {
    state: { patch, rawSum, samples, metrics },
    atoms: arg.atoms,
    fits: arg.fits,
    choice: arg.choice,
  };
}

/** Проверяет строгий прирост global и оба ограничения на windowed J. */
function acceptsCandidate(arg: {
  current: RefitMetrics;
  candidate: RefitMetrics;
  windowedFloor: number;
}): boolean {
  return (
    arg.candidate.globalSuppressionPercent >=
      arg.current.globalSuppressionPercent + MIN_GLOBAL_GAIN &&
    arg.candidate.windowedSuppressionPercent >=
      arg.current.windowedSuppressionPercent -
        CURRENT_WINDOWED_TOLERANCE &&
    arg.candidate.windowedSuppressionPercent >= arg.windowedFloor
  );
}

/** Сравнивает кандидатов сначала по global, затем по windowed J. */
function betterCandidate(
  candidate: BlockCandidate,
  best: BlockCandidate | null,
): boolean {
  if (best === null) {
    return true;
  }
  const globalDelta =
    candidate.state.metrics.globalSuppressionPercent -
    best.state.metrics.globalSuppressionPercent;
  return (
    globalDelta > 1e-9 ||
    (Math.abs(globalDelta) <= 1e-9 &&
      candidate.state.metrics.windowedSuppressionPercent >
        best.state.metrics.windowedSuppressionPercent)
  );
}

/** Готовит общий словарь и базисы одной пары или одиночного слота. */
function prepareSlotSet(arg: {
  state: RenderState;
  choice: SlotSetChoice;
  target: number[];
  phaseModel: PhaseModel;
  zone: UsefulZone;
  diverseShortlist: boolean;
}): {
  atoms: PreparedAtom[];
  localEvaluations: number;
  basisRenders: number;
} {
  const withoutSamples = quantizeRaw(arg.choice.rawWithout);
  const searchResidual = Float64Array.from(
    arg.target,
    (value, index) =>
      (value - (withoutSamples[index] ?? 0)) /
      MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  );
  const dictionary = buildPursuitDictionary({
    patch: arg.state.patch,
    residual: searchResidual,
    zone: arg.zone,
    phaseModel: arg.phaseModel,
    diverseShortlist: arg.diverseShortlist,
  });
  const fitResidual = Float64Array.from(
    { length: arg.target.length },
    (_, index) =>
      (arg.target[index] ?? 0) / MAX_AMPLITUDE_16_BIT_WAV_ENCODED -
      (arg.choice.rawWithout[index] ?? 0),
  );
  const atoms = dictionary.descriptions.map((description) =>
    prepareAtom({
      description,
      target: arg.target,
      fitResidual,
      phaseModel: arg.phaseModel,
    }),
  );
  return {
    atoms,
    localEvaluations: dictionary.localEvaluations,
    basisRenders: atoms.length * 2,
  };
}

/** Точно проверяет одиночные атомы или восемь лучших совместных пар. */
function searchPreparedSlotSet(arg: {
  state: RenderState;
  choice: SlotSetChoice;
  atoms: PreparedAtom[];
  blockSize: PursuitBlockSize;
  target: number[];
  sampleRate: number;
  zone: UsefulZone;
  windowedFloor: number;
}): {
  best: BlockCandidate | null;
  exactEvaluations: number;
  jointEvaluations: number;
} {
  const combinations: {
    atoms: PreparedAtom[];
    fit: JointFit | null;
  }[] = [];
  let jointEvaluations = 0;
  if (arg.blockSize === 1) {
    for (const atom of arg.atoms) {
      const fit = fitPreparedAtoms([atom]);
      jointEvaluations += 1;
      combinations.push({ atoms: [atom], fit });
    }
  } else {
    for (let first = 0; first < arg.atoms.length; first += 1) {
      for (
        let second = first + 1;
        second < arg.atoms.length;
        second += 1
      ) {
        const firstAtom = arg.atoms[first];
        const secondAtom = arg.atoms[second];
        if (firstAtom === undefined || secondAtom === undefined) {
          continue;
        }
        const atoms = [firstAtom, secondAtom];
        const fit = fitPreparedAtoms(atoms);
        jointEvaluations += 1;
        if (fit !== null) {
          combinations.push({ atoms, fit });
        }
      }
    }
    combinations.sort(
      (a, b) =>
        (b.fit?.gain ?? -Infinity) - (a.fit?.gain ?? -Infinity),
    );
    combinations.splice(EXACT_PAIRS_PER_SLOT_SET);
  }
  let best: BlockCandidate | null = null;
  let exactEvaluations = 0;
  for (const combination of combinations) {
    if (combination.fit === null) {
      continue;
    }
    const candidate = renderBlockCandidate({
      state: arg.state,
      choice: arg.choice,
      atoms: combination.atoms,
      fits: combination.fit.fits,
      target: arg.target,
      sampleRate: arg.sampleRate,
      zone: arg.zone,
    });
    exactEvaluations += 1;
    if (
      candidate !== null &&
      acceptsCandidate({
        current: arg.state.metrics,
        candidate: candidate.state.metrics,
        windowedFloor: arg.windowedFloor,
      }) &&
      betterCandidate(candidate, best)
    ) {
      best = candidate;
    }
  }
  return { best, exactEvaluations, jointEvaluations };
}

/** Сохраняет новые solo-вклады всех слотов принятого блока. */
function replaceBlockContributions(arg: {
  contributions: (Float64Array | null)[];
  candidate: BlockCandidate;
  sampleCount: number;
  phaseModel: PhaseModel;
}): (Float64Array | null)[] {
  const next = [...arg.contributions];
  for (
    let index = 0;
    index < arg.candidate.choice.slots.length;
    index += 1
  ) {
    const slot = arg.candidate.choice.slots[index];
    const group = arg.candidate.state.patch.oscillators[slot ?? -1];
    if (slot === undefined || group === undefined) {
      continue;
    }
    next[slot] = renderGroup(group, arg.sampleCount, arg.phaseModel);
  }
  return next;
}

/** Создаёт запись аудита для каждого атома принятого блока. */
function auditAtoms(arg: {
  previousPatch: ArgCreateSynth;
  candidate: BlockCandidate;
}): BlockPursuitAtom[] {
  const atoms: BlockPursuitAtom[] = [];
  for (
    let index = 0;
    index < arg.candidate.atoms.length;
    index += 1
  ) {
    const atom = arg.candidate.atoms[index];
    const fit = arg.candidate.fits[index];
    const slot = arg.candidate.choice.slots[index];
    if (
      atom === undefined ||
      fit === undefined ||
      slot === undefined
    ) {
      continue;
    }
    const previous = arg.previousPatch.oscillators[slot];
    atoms.push({
      slot,
      replacedFrequency: previous?.osc.on
        ? previous.osc.freqBase
        : null,
      frequency: atom.description.frequency,
      freqStart: atom.description.freqStart,
      duration: atom.description.duration,
      slope: atom.description.slope,
      oscDuration: atom.description.oscDuration,
      oscSlope: atom.description.oscSlope,
      window: atom.description.window,
      sweepTemplateIndex: atom.description.sweepTemplateIndex,
      localGain: atom.description.localGain,
      startLevel: fit.startLevel,
      phase: fit.phase,
    });
  }
  return atoms;
}

/** Пробует до двух наборов слотов и возвращает лучший принятый блок. */
function pursueOneBlock(arg: {
  state: RenderState;
  contributions: (Float64Array | null)[];
  target: number[];
  sampleRate: number;
  phaseModel: PhaseModel;
  zone: UsefulZone;
  windowedFloor: number;
  step: number;
  blockSize: PursuitBlockSize;
  usedSlots: ReadonlySet<number>;
  diverseShortlist: boolean;
}): { accepted: AcceptedBlock | null; counters: AttemptCounters } {
  const counters: AttemptCounters = {
    localEvaluations: 0,
    jointEvaluations: 0,
    exactEvaluations: 0,
    basisRenders: 0,
    slotSetsEvaluated: 0,
  };
  const choices = rankSlotSets({
    state: arg.state,
    contributions: arg.contributions,
    target: arg.target,
    usedSlots: arg.usedSlots,
    blockSize: arg.blockSize,
  });
  let best: BlockCandidate | null = null;
  for (const choice of choices) {
    counters.slotSetsEvaluated += 1;
    const prepared = prepareSlotSet({
      state: arg.state,
      choice,
      target: arg.target,
      phaseModel: arg.phaseModel,
      zone: arg.zone,
      diverseShortlist: arg.diverseShortlist,
    });
    counters.localEvaluations += prepared.localEvaluations;
    counters.basisRenders += prepared.basisRenders;
    const searched = searchPreparedSlotSet({
      state: arg.state,
      choice,
      atoms: prepared.atoms,
      blockSize: arg.blockSize,
      target: arg.target,
      sampleRate: arg.sampleRate,
      zone: arg.zone,
      windowedFloor: arg.windowedFloor,
    });
    counters.exactEvaluations += searched.exactEvaluations;
    counters.jointEvaluations += searched.jointEvaluations;
    if (
      searched.best !== null &&
      betterCandidate(searched.best, best)
    ) {
      best = searched.best;
    }
  }
  if (best === null) {
    return { accepted: null, counters };
  }
  const audit: BlockPursuitStep = {
    step: arg.step,
    atoms: auditAtoms({
      previousPatch: arg.state.patch,
      candidate: best,
    }),
    before: arg.state.metrics,
    after: best.state.metrics,
    exactCandidates: counters.exactEvaluations,
    jointCandidates: counters.jointEvaluations,
    slotSetsEvaluated: counters.slotSetsEvaluated,
  };
  return {
    accepted: {
      state: best.state,
      contributions: replaceBlockContributions({
        contributions: arg.contributions,
        candidate: best,
        sampleCount: arg.target.length,
        phaseModel: arg.phaseModel,
      }),
      audit,
    },
    counters,
  };
}

/** Возвращает исходный результат и накопленную стоимость неудачного поиска. */
function unchangedResult(arg: {
  patch: ArgCreateSynth;
  initial: RenderState;
  counters: AttemptCounters;
}): BlockPursuitResult {
  return {
    status: 'unchanged',
    patch: clonePatch(arg.patch),
    samples: arg.initial.samples,
    baseline: arg.initial.metrics,
    metrics: arg.initial.metrics,
    steps: [],
    ...arg.counters,
    replacementCount: 0,
  };
}

/**
 * Выполняет не более `maxBlocks` жадных одиночных или парных замен.
 *
 * @param arg - Готовый match, target PCM и размер блока K=1 или K=2
 * @returns Лучший patch/WAV, полный аудит и стоимость; при неудаче —
 *   исходные данные
 * @remarks K1 и K2 используют общий словарь и проверяют до двух наборов
 *   слотов на шаг. K2 ранжирует пары совместным МНК 4×4 и точно проверяет
 *   восемь лучших пар на набор. Слот меняется не более одного раза за
 *   прогон. Каждый блок повышает global минимум на 0.005 п.п.; J не падает
 *   больше чем на 0.01 п.п. от текущего и 0.05 п.п. от исходного match.
 *   Финальный WAV получается каноническим рендером патча. Новый CD не
 *   запускается. Production match, enhance и API не вызывают этот
 *   offline-эксперимент; его результат не доказывает закон T35.
 * @throws Error если target пуст, sample rate не 44100 Гц, blockSize
 *   не 1 и не 2 или maxBlocks не является целым от 1 до 12
 */
export function pursueResidualBlocks(arg: {
  patch: ArgCreateSynth;
  target: ArrayLike<number>;
  sampleRate?: number;
  phaseModel?: PhaseModel;
  blockSize: PursuitBlockSize;
  maxBlocks?: number;
  diverseShortlist?: boolean;
}): BlockPursuitResult {
  const sampleRate = arg.sampleRate ?? SAMPLE_RATE;
  const phaseModel = arg.phaseModel ?? 'legacy';
  const maxBlocks = arg.maxBlocks ?? DEFAULT_BLOCKS;
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error('Block pursuit поддерживает только 44100 Гц');
  }
  if (arg.target.length === 0) {
    throw new Error('Пустой target');
  }
  if (arg.blockSize !== 1 && arg.blockSize !== 2) {
    throw new Error('blockSize должен быть 1 или 2');
  }
  if (
    !Number.isInteger(maxBlocks) ||
    maxBlocks < 1 ||
    maxBlocks > MAX_BLOCKS
  ) {
    throw new Error(
      `maxBlocks должен быть целым от 1 до ${MAX_BLOCKS}`,
    );
  }
  const target = Array.from(arg.target);
  const zone = computeUsefulZone(target, sampleRate);
  const initial = createInitialState({
    patch: arg.patch,
    target,
    sampleRate,
    phaseModel,
    usefulZone: zone,
  });
  let state = initial;
  let contributions = buildContributions(
    state.patch,
    target.length,
    phaseModel,
  );
  const usedSlots = new Set<number>();
  const steps: BlockPursuitStep[] = [];
  const counters: AttemptCounters = {
    localEvaluations: 0,
    jointEvaluations: 0,
    exactEvaluations: 0,
    basisRenders: 0,
    slotSetsEvaluated: 0,
  };
  const windowedFloor =
    initial.metrics.windowedSuppressionPercent -
    INITIAL_WINDOWED_TOLERANCE;
  for (let step = 1; step <= maxBlocks; step += 1) {
    const attempt = pursueOneBlock({
      state,
      contributions,
      target,
      sampleRate,
      phaseModel,
      zone,
      windowedFloor,
      step,
      blockSize: arg.blockSize,
      usedSlots,
      diverseShortlist: arg.diverseShortlist ?? false,
    });
    for (const key of Object.keys(
      counters,
    ) as (keyof AttemptCounters)[]) {
      counters[key] += attempt.counters[key];
    }
    if (attempt.accepted === null) {
      break;
    }
    state = attempt.accepted.state;
    contributions = attempt.accepted.contributions;
    steps.push(attempt.accepted.audit);
    for (const atom of attempt.accepted.audit.atoms) {
      usedSlots.add(atom.slot);
    }
  }
  if (steps.length === 0) {
    return unchangedResult({ patch: arg.patch, initial, counters });
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
    zone,
  );
  if (
    !Number.isFinite(finalMetrics.globalSuppressionPercent) ||
    !Number.isFinite(finalMetrics.windowedSuppressionPercent) ||
    finalMetrics.globalSuppressionPercent <
      initial.metrics.globalSuppressionPercent +
        steps.length * MIN_GLOBAL_GAIN ||
    finalMetrics.windowedSuppressionPercent <
      state.metrics.windowedSuppressionPercent -
        CURRENT_WINDOWED_TOLERANCE ||
    finalMetrics.windowedSuppressionPercent < windowedFloor
  ) {
    return unchangedResult({ patch: arg.patch, initial, counters });
  }
  return {
    status: 'refined',
    patch: state.patch,
    samples: finalSamples,
    baseline: initial.metrics,
    metrics: finalMetrics,
    steps,
    ...counters,
    replacementCount: steps.reduce(
      (sum, step) => sum + step.atoms.length,
      0,
    ),
  };
}
