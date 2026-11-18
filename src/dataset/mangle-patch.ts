/**
 * Портит патч контролируемо (механика этапа 4 плана
 * `docs/plan-kick-enhancement.md`): музыку ломает плохое сочетание
 * параметров синтеза, поэтому для оценки сервиса мы портим патчи,
 * а не волны.
 *
 * Два режима:
 *
 * - `random` — сдвигает случайные параметры случайных активных
 *   осцилляторов. Страховка от слепых зон адресных гипотез.
 * - `targeted` — применяет явный список правок из JSON-файла
 *   ([{index, param, value}]). Адресная порча: гипотеза этапа 3
 *   задаёт, что именно нарушаем.
 *
 * Запуск:
 *   npx tsx src/dataset/mangle-patch.ts \
 *     --patch <patch.json> --out <dir> --seed 7 --strength 0.3
 *   npx tsx src/dataset/mangle-patch.ts \
 *     --patch <patch.json> --out <dir> --overrides overrides.json
 *
 * Артефакты в выходном каталоге: patch.json (испорченный),
 * result.wav (его синтез), mangle.json (протокол порчи: что на что
 * поменяли — по этому протоколу потом проверяем восстановление).
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SAMPLE_RATE } from '../consts';
import {
  ampEnvConfigNormales,
  oscConfigNormales,
  type ArgCreateSynth,
} from '../synth';
import { writeWav } from '../write-wav';
import {
  readJsonOrNullSync,
  renderSamples,
  writeJsonAtomicSync,
} from './shared';

/** Аргументы командной строки. */
interface CliArgs {
  patchPath: string;
  outDir: string;
  mode: 'random' | 'targeted';
  seed: number;
  strength: number;
  count: number;
  overridesPath?: string;
}

/** Одна правка протокола порчи. */
interface MangleEdit {
  index: number;
  param: string;
  from: number;
  to: number;
}

/** Явная правка для режима targeted. */
interface OverrideEdit {
  index: number;
  param: string;
  value: number;
}

/** Имена непрерывных параметров, которые портит режим random. */
const MANGLE_PARAMS = [
  'freqBase',
  'freqStart',
  'freqEnvSlope',
  'freqEnvDuration',
  'phase',
  'ampEnvDuration',
  'ampEndLevel',
  'ampEnvSlope',
  'ampStartLevel',
] as const;

type MangleParam = (typeof MANGLE_PARAMS)[number];

/**
 * Детерминированный ГПСЧ (mulberry32). Локальная копия генератора
 * из coordinate-descent.ts: экспортировать его из оптимизатора
 * ради одной утилиты не хочется, а воспроизводимость порчи по
 * сиду нужна так же, как воспроизводимость прогона.
 */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Разбирает аргументы командной строки в {@link CliArgs}. */
function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    patchPath: '',
    outDir: '',
    mode: 'random',
    seed: 1,
    strength: 0.3,
    count: 4,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for argument: ${key}`);
    }
    switch (key) {
      case '--patch':
        args.patchPath = value;
        break;
      case '--out':
        args.outDir = value;
        break;
      case '--seed':
        args.seed = parseInt(value, 10);
        if (Number.isNaN(args.seed)) {
          throw new Error(`--seed must be an integer, got: ${value}`);
        }
        break;
      case '--strength':
        args.strength = parseFloat(value);
        if (Number.isNaN(args.strength) || args.strength <= 0) {
          throw new Error(
            `--strength must be positive, got: ${value}`,
          );
        }
        break;
      case '--count':
        args.count = parseInt(value, 10);
        if (Number.isNaN(args.count) || args.count < 1) {
          throw new Error(`--count must be a positive integer`);
        }
        break;
      case '--overrides':
        args.mode = 'targeted';
        args.overridesPath = value;
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (args.patchPath === '' || args.outDir === '') {
    throw new Error('Both --patch and --out are required');
  }
  return args;
}

/** Читает JSON обязательного файла; неудача — ошибка с путём. */
function readJsonRequired<T>(path: string): T {
  const data = readJsonOrNullSync<T>(path);
  if (data === null) {
    throw new Error(`Cannot read or parse JSON: ${path}`);
  }
  return data;
}

/** Группа осциллятора из патча: параметры + флаг включения. */
type OscGroup = ArgCreateSynth['oscillators'][number];

/**
 * Дескриптор параметра: как его читать, писать и каков допустимый
 * диапазон. Одна таблица вместо трёх switch-диспетчеров: добавление
 * параметра правится в одном месте (замечание ревизии декомпозиции).
 */
interface ParamDescriptor {
  read: (group: OscGroup) => number;
  write: (group: OscGroup, value: number) => void;
  range: [number, number];
}

/** Таблица дескрипторов всех порчащихся параметров. */
const PARAM_DESCRIPTORS: Record<MangleParam, ParamDescriptor> = {
  freqBase: {
    read: (g) => g.osc.freqBase,
    write: (g, v) => {
      g.osc.freqBase = v;
    },
    range: [
      oscConfigNormales.freqBase.min,
      oscConfigNormales.freqBase.max,
    ],
  },
  freqStart: {
    read: (g) => g.osc.freqStart,
    write: (g, v) => {
      g.osc.freqStart = v;
    },
    range: [
      oscConfigNormales.freqStart.min,
      oscConfigNormales.freqStart.max,
    ],
  },
  freqEnvSlope: {
    read: (g) => g.osc.slope,
    write: (g, v) => {
      g.osc.slope = v;
    },
    range: [oscConfigNormales.slope.min, oscConfigNormales.slope.max],
  },
  freqEnvDuration: {
    read: (g) => g.osc.duration,
    write: (g, v) => {
      g.osc.duration = v;
    },
    range: [
      oscConfigNormales.duration.min,
      oscConfigNormales.duration.max,
    ],
  },
  phase: {
    read: (g) => g.osc.phase,
    write: (g, v) => {
      g.osc.phase = v;
    },
    range: [oscConfigNormales.phase.min, oscConfigNormales.phase.max],
  },
  ampEnvDuration: {
    read: (g) => g.ampEnv.duration,
    write: (g, v) => {
      g.ampEnv.duration = v;
    },
    range: [
      ampEnvConfigNormales.duration.min,
      ampEnvConfigNormales.duration.max,
    ],
  },
  ampEndLevel: {
    read: (g) => g.ampEnv.endLevel ?? 0.001,
    write: (g, v) => {
      g.ampEnv.endLevel = v;
    },
    range: [
      ampEnvConfigNormales.endLevel.min,
      ampEnvConfigNormales.endLevel.max,
    ],
  },
  ampEnvSlope: {
    read: (g) => g.ampEnv.slope,
    write: (g, v) => {
      g.ampEnv.slope = v;
    },
    range: [
      ampEnvConfigNormales.slope.min,
      ampEnvConfigNormales.slope.max,
    ],
  },
  ampStartLevel: {
    read: (g) => g.ampEnv.startLevel,
    write: (g, v) => {
      g.ampEnv.startLevel = v;
    },
    range: [
      ampEnvConfigNormales.startLevel.min,
      ampEnvConfigNormales.startLevel.max,
    ],
  },
};

/**
 * Сдвигает параметр на случайную величину: частоты, длительности и
 * уровни — мультипликативно (они логарифмичны по восприятию),
 * кривизны и фазу — аддитивно. Результат clamp'ится в нормали.
 */
function jitterParam(
  param: MangleParam,
  value: number,
  strength: number,
  rng: () => number,
): number {
  const [min, max] = PARAM_DESCRIPTORS[param].range;
  let next: number;
  if (param === 'phase') {
    next = value + (rng() * 2 - 1) * Math.PI * strength;
  } else if (param === 'freqEnvSlope' || param === 'ampEnvSlope') {
    next = value + (rng() * 2 - 1) * strength;
  } else {
    next = value * (1 + (rng() * 2 - 1) * strength);
  }
  return Math.max(min, Math.min(max, next));
}

/**
 * Режим random: выбирает `count` случайных правок по активным
 * осцилляторам и применяет их. Возвращает протокол правок.
 */
function mangleRandom(
  patch: ArgCreateSynth,
  args: CliArgs,
): MangleEdit[] {
  const rng = createRng(args.seed);
  const activeIndices = patch.oscillators
    .map((group, i) => (group.osc.on ? i : -1))
    .filter((i) => i >= 0);
  if (activeIndices.length === 0) {
    throw new Error('Patch has no active oscillators to mangle');
  }

  const edits: MangleEdit[] = [];
  for (let n = 0; n < args.count; n += 1) {
    const index =
      activeIndices[Math.floor(rng() * activeIndices.length)] ?? 0;
    const param =
      MANGLE_PARAMS[Math.floor(rng() * MANGLE_PARAMS.length)] ??
      'freqBase';
    const group = patch.oscillators[index];
    if (group === undefined) {
      continue;
    }
    const descriptor = PARAM_DESCRIPTORS[param];
    const from = descriptor.read(group);
    const to = jitterParam(param, from, args.strength, rng);
    descriptor.write(group, to);
    edits.push({ index, param, from, to });
  }
  return edits;
}

/**
 * Режим targeted: применяет явный список правок из JSON-файла
 * вида [{index, param, value}]. Возвращает протокол правок.
 */
function mangleTargeted(
  patch: ArgCreateSynth,
  overridesPath: string,
): MangleEdit[] {
  const overrides = readJsonRequired<OverrideEdit[]>(
    resolve(overridesPath),
  );
  const edits: MangleEdit[] = [];
  for (const edit of overrides) {
    const group = patch.oscillators[edit.index];
    if (group === undefined) {
      console.log(
        `WARN override skipped: no oscillator ${edit.index}`,
      );
      continue;
    }
    const param = edit.param as MangleParam;
    if (!MANGLE_PARAMS.includes(param)) {
      console.log(
        `WARN override skipped: unknown param ${edit.param}`,
      );
      continue;
    }
    const descriptor = PARAM_DESCRIPTORS[param];
    const from = descriptor.read(group);
    descriptor.write(group, edit.value);
    edits.push({ index: edit.index, param, from, to: edit.value });
  }
  return edits;
}

/** Точка входа: портит патч выбранным режимом, пишет артефакты. */
function main(): void {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const patch = readJsonRequired<ArgCreateSynth>(
      resolve(args.patchPath),
    );
    const outDir = resolve(args.outDir);
    mkdirSync(outDir, { recursive: true });

    const edits =
      args.mode === 'targeted' && args.overridesPath !== undefined
        ? mangleTargeted(patch, args.overridesPath)
        : mangleRandom(patch, args);
    if (edits.length === 0) {
      throw new Error('No edits applied');
    }

    writeJsonAtomicSync(join(outDir, 'patch.json'), patch);
    writeJsonAtomicSync(join(outDir, 'mangle.json'), {
      mode: args.mode,
      seed: args.seed,
      strength: args.strength,
      edits,
    });
    writeWav({
      samples: renderSamples(patch, 0.5),
      sampleRate: SAMPLE_RATE,
      filePath: join(outDir, 'result.wav'),
    });
    for (const edit of edits) {
      console.log(
        `MANGLE osc[${edit.index}].${edit.param}: ` +
          `${edit.from.toPrecision(4)} -> ${edit.to.toPrecision(4)}`,
      );
    }
    console.log(`DONE ${edits.length} edits, artifacts in ${outDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main();
