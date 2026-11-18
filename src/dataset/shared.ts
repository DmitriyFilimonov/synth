/**
 * Общие хелперы dataset-утилит: терпимое чтение JSON, атомарная
 * запись, синтез патча в сэмплы, квантиль. Собраны здесь, чтобы
 * не дублировать побуквенно в каждом модуле (замечание ревизии
 * декомпозиции).
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import {
  MAX_AMPLITUDE_16_BIT_WAV_ENCODED,
  SAMPLE_RATE,
} from '../consts';
import { createSynth, type ArgCreateSynth } from '../synth';

/** Читает JSON асинхронно; при отсутствии или битом файле — null. */
export async function readJsonOrNull<T>(
  path: string,
): Promise<T | null> {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Читает JSON синхронно; при отсутствии или битом файле — null. */
export function readJsonOrNullSync<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Пишет JSON атомарно (асинхронно): временный файл + rename. */
export async function writeJsonAtomic(
  path: string,
  data: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

/** Пишет JSON атомарно (синхронно): временный файл + rename. */
export function writeJsonAtomicSync(
  path: string,
  data: unknown,
): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/** Пишет текст атомарно (асинхронно): временный файл + rename. */
export async function writeTextAtomic(
  path: string,
  data: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Синтезирует патч в сэмплы Int16 заданной длительности. */
export function renderSamples(
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

/** Считает квантиль с линейной интерполяцией; пустой ввод — null. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const lower = sorted[lo] ?? 0;
  const upper = sorted[hi] ?? lower;
  return lower + (upper - lower) * (pos - lo);
}
