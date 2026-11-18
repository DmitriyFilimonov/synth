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
import { mkdirSync, readFileSync } from 'node:fs';
import { renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import {
  ampEnvConfigNormales,
  createSynth,
  oscConfigNormales,
  type ArgCreateSynth,
} from '../synth';
import { writeWav } from '../write-wav';

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

/** Читает и парсит JSON-файл с понятной ошибкой при неудаче. */
function readJson<T>(path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Cannot read file: ${path}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Cannot parse JSON: ${path}`);
  }
}

/** Возвращает [min, max] допустимых значений параметра по нормалям. */
function paramRange(param: MangleParam): [number, number] {
  switch (param) {
    case 'freqBase':
      return [
        oscConfigNormales.freqBase.min,
        oscConfigNormales.freqBase.max,
      ];
    case 'freqStart':
      return [
        oscConfigNormales.freqStart.min,
        oscConfigNormales.freqStart.max,
      ];
    case 'freqEnvSlope':
      return [
        oscConfigNormales.slope.min,
        oscConfigNormales.slope.max,
      ];
    case 'freqEnvDuration':
      return [
        oscConfigNormales.duration.min,
        oscConfigNormales.duration.max,
      ];
    case 'phase':
      return [
        oscConfigNormales.phase.min,
        oscConfigNormales.phase.max,
      ];
    case 'ampEnvDuration':
      return [
        ampEnvConfigNormales.duration.min,
        ampEnvConfigNormales.duration.max,
      ];
    case 'ampEndLevel':
      return [
        ampEnvConfigNormales.endLevel.min,
        ampEnvConfigNormales.endLevel.max,
      ];
    case 'ampEnvSlope':
      return [
        ampEnvConfigNormales.slope.min,
        ampEnvConfigNormales.slope.max,
      ];
    case 'ampStartLevel':
      return [
        ampEnvConfigNormales.startLevel.min,
        ampEnvConfigNormales.startLevel.max,
      ];
  }
}

/** Читает значение параметра из группы осциллятора. */
function readGroupParam(
  group: ArgCreateSynth['oscillators'][number],
  param: MangleParam,
): number {
  switch (param) {
    case 'freqBase':
      return group.osc.freqBase;
    case 'freqStart':
      return group.osc.freqStart;
    case 'freqEnvSlope':
      return group.osc.slope;
    case 'freqEnvDuration':
      return group.osc.duration;
    case 'phase':
      return group.osc.phase;
    case 'ampEnvDuration':
      return group.ampEnv.duration;
    case 'ampEndLevel':
      return group.ampEnv.endLevel ?? 0.001;
    case 'ampEnvSlope':
      return group.ampEnv.slope;
    case 'ampStartLevel':
      return group.ampEnv.startLevel;
  }
}

/** Записывает значение параметра в группу осциллятора. */
function writeGroupParam(
  group: ArgCreateSynth['oscillators'][number],
  param: MangleParam,
  value: number,
): void {
  switch (param) {
    case 'freqBase':
      group.osc.freqBase = value;
      break;
    case 'freqStart':
      group.osc.freqStart = value;
      break;
    case 'freqEnvSlope':
      group.osc.slope = value;
      break;
    case 'freqEnvDuration':
      group.osc.duration = value;
      break;
    case 'phase':
      group.osc.phase = value;
      break;
    case 'ampEnvDuration':
      group.ampEnv.duration = value;
      break;
    case 'ampEndLevel':
      group.ampEnv.endLevel = value;
      break;
    case 'ampEnvSlope':
      group.ampEnv.slope = value;
      break;
    case 'ampStartLevel':
      group.ampEnv.startLevel = value;
      break;
  }
}

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
  const [min, max] = paramRange(param);
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
    const from = readGroupParam(group, param);
    const to = jitterParam(param, from, args.strength, rng);
    writeGroupParam(group, param, to);
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
  const overrides = readJson<OverrideEdit[]>(resolve(overridesPath));
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
    const from = readGroupParam(group, param);
    writeGroupParam(group, param, edit.value);
    edits.push({ index: edit.index, param, from, to: edit.value });
  }
  return edits;
}

/** Синтезирует патч в Int16-сэмплы заданной длительности. */
function renderSamples(
  patch: ArgCreateSynth,
  seconds: number,
): Int16Array {
  const synth = createSynth(patch);
  const total = Math.floor(SAMPLE_RATE * seconds);
  const samples = new Int16Array(total);
  for (let i = 0; i < total; i += 1) {
    samples[i] = Math.round(
      synth({ x: i / SAMPLE_RATE }) *
        MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
    );
  }
  return samples;
}

/** Пишет JSON атомарно: временный файл + rename. */
function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/** Точка входа: портит патч выбранным режимом, пишет артефакты. */
function main(): void {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const patch = readJson<ArgCreateSynth>(resolve(args.patchPath));
    const outDir = resolve(args.outDir);
    mkdirSync(outDir, { recursive: true });

    const edits =
      args.mode === 'targeted' && args.overridesPath !== undefined
        ? mangleTargeted(patch, args.overridesPath)
        : mangleRandom(patch, args);
    if (edits.length === 0) {
      throw new Error('No edits applied');
    }

    writeJsonAtomic(join(outDir, 'patch.json'), patch);
    writeJsonAtomic(join(outDir, 'mangle.json'), {
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
