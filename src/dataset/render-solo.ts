/**
 * Рендерит соло- и минус-треки осцилляторов патча (инструментарий
 * ручной чистки, этап 2 плана `docs/plan-kick-enhancement.md`).
 *
 * На каждый активный осциллятор пишет два WAV: соло (звучит только
 * он) и минус (звучит всё, кроме него). Слушая соло, находим
 * осцилляторы, которые моделируют чужой микс-остаток; слушая минус,
 * проверяем, что их отключение не задевает полезную часть бочки.
 *
 * Запуск:
 *   npx tsx src/dataset/render-solo.ts \
 *     --patch datasets/reference-4/<slug>/seed-1/patch.json
 *   npx tsx src/dataset/render-solo.ts \
 *     --run datasets/reference-4/<slug>/seed-1 --seconds 0.5
 *
 * Раскладка артефактов в выходном каталоге:
 *   full.wav              — весь патч
 *   solo/osc-XX.wav       — только осциллятор XX
 *   minus/osc-XX.wav      — всё без осциллятора XX
 *   index.json            — сводка: параметры и пути треков
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import { createSynth, type ArgCreateSynth } from '../synth';
import { writeWav } from '../write-wav';

/** Аргументы командной строки рендерера. */
interface CliArgs {
  patchPath: string;
  outDir: string;
  seconds: number;
}

/** Сводка одного осциллятора в index.json. */
interface SoloIndexEntry {
  index: number;
  freqBase: number;
  freqStart: number;
  ampStartLevel: number;
  ampEnvDurationSec: number;
  solo: string;
  minus: string;
}

/**
 * Разбирает аргументы командной строки в {@link CliArgs}.
 * Принимает либо `--patch <файл>`, либо `--run <каталог прогона>`
 * (тогда патч читается из `<каталог>/patch.json`).
 */
function parseCliArgs(argv: string[]): CliArgs {
  let patchPath: string | null = null;
  let outDir: string | null = null;
  let seconds = 0.5;

  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for argument: ${key}`);
    }
    switch (key) {
      case '--patch':
        patchPath = value;
        break;
      case '--run':
        patchPath = join(value, 'patch.json');
        outDir = join(value, 'solo');
        break;
      case '--out':
        outDir = value;
        break;
      case '--seconds': {
        const n = parseFloat(value);
        if (Number.isNaN(n) || n <= 0) {
          throw new Error(
            `--seconds must be positive, got: ${value}`,
          );
        }
        seconds = n;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (patchPath === null) {
    throw new Error('Either --patch or --run is required');
  }
  return {
    patchPath,
    outDir: outDir ?? `${patchPath}.solo`,
    seconds,
  };
}

/** Читает и парсит patch.json с понятной ошибкой при неудаче. */
function loadPatch(patchPath: string): ArgCreateSynth {
  let raw: string;
  try {
    raw = readFileSync(patchPath, 'utf8');
  } catch {
    throw new Error(`Cannot read patch file: ${patchPath}`);
  }
  try {
    return JSON.parse(raw) as ArgCreateSynth;
  } catch {
    throw new Error(`Cannot parse patch file as JSON: ${patchPath}`);
  }
}

/**
 * Возвращает копию патча, где включён только осциллятор `index`
 * (если он активен в оригинале), остальные выключены.
 */
function soloPatch(
  patch: ArgCreateSynth,
  index: number,
): ArgCreateSynth {
  return {
    oscillators: patch.oscillators.map((group, i) => ({
      ...group,
      osc: { ...group.osc, on: i === index && group.osc.on },
    })),
  };
}

/**
 * Возвращает копию патча с выключенным осциллятором `index`;
 * состояние остальных не меняется.
 */
function minusPatch(
  patch: ArgCreateSynth,
  index: number,
): ArgCreateSynth {
  return {
    oscillators: patch.oscillators.map((group, i) => ({
      ...group,
      osc: { ...group.osc, on: i === index ? false : group.osc.on },
    })),
  };
}

/** Синтезирует патч в сэмплы Int16 заданной длительности. */
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

/** Пишет один WAV-трек в подкаталог выходной директории. */
function writeTrack(arg: {
  patch: ArgCreateSynth;
  filePath: string;
  seconds: number;
}): void {
  const samples = renderSamples(arg.patch, arg.seconds);
  writeWav({
    samples,
    sampleRate: SAMPLE_RATE,
    filePath: arg.filePath,
  });
}

/**
 * Рендерит полный набор треков и пишет index.json со сводкой.
 * Возвращает число активных осцилляторов.
 */
function renderTrackSet(
  args: CliArgs,
  patch: ArgCreateSynth,
): number {
  mkdirSync(join(args.outDir, 'solo'), { recursive: true });
  mkdirSync(join(args.outDir, 'minus'), { recursive: true });

  writeTrack({
    patch,
    filePath: join(args.outDir, 'full.wav'),
    seconds: args.seconds,
  });

  const index: SoloIndexEntry[] = [];
  patch.oscillators.forEach((group, i) => {
    if (!group.osc.on) {
      return;
    }
    const name = `osc-${String(i).padStart(2, '0')}.wav`;
    writeTrack({
      patch: soloPatch(patch, i),
      filePath: join(args.outDir, 'solo', name),
      seconds: args.seconds,
    });
    writeTrack({
      patch: minusPatch(patch, i),
      filePath: join(args.outDir, 'minus', name),
      seconds: args.seconds,
    });
    index.push({
      index: i,
      freqBase: group.osc.freqBase,
      freqStart: group.osc.freqStart,
      ampStartLevel: group.ampEnv.startLevel,
      ampEnvDurationSec: group.ampEnv.duration,
      solo: `solo/${name}`,
      minus: `minus/${name}`,
    });
    if (index.length % 10 === 0) {
      console.log(`RENDER ${index.length} oscillators done`);
    }
  });

  writeIndexAtomic(args.outDir, index);
  return index.length;
}

/** Пишет index.json со сводкой: временный файл + rename. */
function writeIndexAtomic(
  outDir: string,
  index: SoloIndexEntry[],
): void {
  const tmp = join(outDir, 'index.json.tmp');
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, join(outDir, 'index.json'));
}

/** Точка входа: читает патч и рендерит набор треков. */
function main(): void {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const patch = loadPatch(resolve(args.patchPath));
    const outDir = resolve(args.outDir);
    const rendered = renderTrackSet({ ...args, outDir }, patch);
    console.log(
      `DONE rendered full + ${rendered} solo + ${rendered} minus ` +
        `tracks to ${outDir}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main();
