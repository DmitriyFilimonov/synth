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
import {
  createSynth,
  type ArgCreateSynth,
  type SynthOptions,
} from '../synth';

/**
 * Читает JSON-файл асинхронно; при отсутствии файла или битом
 * JSON возвращает null вместо исключения.
 *
 * @param path - Путь к JSON-файлу
 * @returns Распарсенное содержимое файла или null
 */
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

/**
 * Читает JSON-файл синхронно; при отсутствии файла или битом
 * JSON возвращает null вместо исключения.
 *
 * @param path - Путь к JSON-файлу
 * @returns Распарсенное содержимое файла или null
 */
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

/**
 * Пишет JSON атомарно (асинхронно): сначала во временный файл,
 * затем переименовывает его в целевой.
 *
 * @param path - Путь к целевому JSON-файлу
 * @param data - Сериализуемые в JSON данные
 */
export async function writeJsonAtomic(
  path: string,
  data: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

/**
 * Пишет JSON атомарно (синхронно): сначала во временный файл,
 * затем переименовывает его в целевой.
 *
 * @param path - Путь к целевому JSON-файлу
 * @param data - Сериализуемые в JSON данные
 */
export function writeJsonAtomicSync(
  path: string,
  data: unknown,
): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/**
 * Пишет текст атомарно (асинхронно): сначала во временный файл,
 * затем переименовывает его в целевой.
 *
 * @param path - Путь к целевому файлу
 * @param data - Текст для записи
 */
export async function writeTextAtomic(
  path: string,
  data: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * Синтезирует патч в сэмплы Int16 заданной длительности.
 *
 * @param patch - Конфигурация осцилляторов для синтеза
 * @param seconds - Длительность рендера в секундах
 * @returns Сэмплы 16-битного знакового PCM
 */
export function renderSamples(
  patch: ArgCreateSynth,
  seconds: number,
  options: SynthOptions = {},
): Int16Array {
  const synth = createSynth(patch, options);
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

/**
 * Считает квантиль выборки с линейной интерполяцией между
 * соседними отсортированными значениями.
 *
 * @param values - Исходная выборка (не изменяется)
 * @param q - Уровень квантиля от 0 до 1
 * @returns Значение квантиля или null для пустой выборки
 */
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
