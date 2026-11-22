/**
 * Полосовые измерения WAV по времени. Метрика читает саму волну,
 * поэтому не зависит от того, сколькими осцилляторами представлен
 * один и тот же звук. Она нужна для проверки характера и поиска
 * перекосов, которые глобальный suppression скрывает.
 */
import { fftMagnitudeSpectrum } from './fft';

/** Максимальная длина окна, которую обрабатывает FFT без обрезки. */
const MAX_FFT_SAMPLES = 65536;

/** Полоса частот: нижняя граница включена, верхняя — нет. */
export interface WaveformBand {
  name: string;
  minHz: number;
  maxHz: number;
}

/** Временной участок в секундах от начала WAV. */
export interface WaveformRegion {
  name: string;
  startSec: number;
  endSec: number;
}

/** Энергия одной полосы на одном участке. */
export interface WaveformBandEnergy extends WaveformBand {
  region: string;
  energy: number;
}

/** Разница энергии кандидата против эталона в децибелах. */
export interface WaveformBandDelta extends WaveformBandEnergy {
  referenceEnergy: number;
  candidateEnergy: number;
  /** null означает, что в эталонной полосе нет энергии. */
  deltaDb: number | null;
}

/** Полосы, которые разделяют саб, низ, середину и верх бочки. */
export const DEFAULT_WAVEFORM_BANDS: readonly WaveformBand[] = [
  { name: 'sub', minHz: 30, maxHz: 60 },
  { name: 'low', minHz: 60, maxHz: 100 },
  { name: 'low-mid', minHz: 100, maxHz: 160 },
  { name: 'upper-low', minHz: 160, maxHz: 300 },
  { name: 'mid', minHz: 300, maxHz: 1000 },
  { name: 'upper-mid', minHz: 1000, maxHz: 4000 },
  { name: 'high', minHz: 4000, maxHz: 16000 },
];

/** Участки, на которых атаку и длинный хвост не смешиваем. */
export const DEFAULT_WAVEFORM_REGIONS: readonly WaveformRegion[] = [
  { name: 'attack', startSec: 0, endSec: 0.03 },
  { name: 'early', startSec: 0.03, endSec: 0.08 },
  { name: 'body', startSec: 0.08, endSec: 0.2 },
  { name: 'tail', startSec: 0.2, endSec: 0.45 },
];

/** Проверяет полосы, участки и допустимую длину окон FFT. */
function validateSpecs(
  sampleRate: number,
  bands: readonly WaveformBand[],
  regions: readonly WaveformRegion[],
): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate должен быть положительным');
  }
  for (const band of bands) {
    if (
      !Number.isFinite(band.minHz) ||
      !Number.isFinite(band.maxHz) ||
      band.minHz <= 0 ||
      band.maxHz <= band.minHz
    ) {
      throw new Error(`некорректная полоса ${band.name}`);
    }
  }
  for (const region of regions) {
    if (
      !Number.isFinite(region.startSec) ||
      !Number.isFinite(region.endSec) ||
      region.startSec < 0 ||
      region.endSec <= region.startSec
    ) {
      throw new Error(`некорректный участок ${region.name}`);
    }
    const length = Math.round(
      (region.endSec - region.startSec) * sampleRate,
    );
    if (length < 3) {
      throw new Error(`участок ${region.name} короче трёх отсчётов`);
    }
    if (length > MAX_FFT_SAMPLES) {
      throw new Error(
        `участок ${region.name} длиннее ${MAX_FFT_SAMPLES} отсчётов`,
      );
    }
  }
}

/**
 * Считает среднеквадратичную энергию каждой полосы на каждом
 * временном участке сигнала.
 *
 * @param samples - Отсчёты сигнала
 * @param sampleRate - Частота дискретизации в Гц
 * @param bands - Полосы частот; нижняя граница включена,
 *   верхняя — нет
 * @param regions - Участки в секундах от начала сигнала
 * @returns Энергии полос: сначала перебираются участки, затем полосы
 * @throws Error если частота дискретизации, полоса или границы
 *   участка некорректны, а также если участок короче трёх отсчётов
 *   или длиннее {@link MAX_FFT_SAMPLES} отсчётов
 * @remarks Окно Ханна подавляет утечку между полосами. Деление на
 *   энергию окна позволяет сравнивать участки разной длины.
 *   Недостающие отсчёты заменяются нулями, поэтому можно сравнивать
 *   WAV разной длины.
 */
export function measureWaveformBands(
  samples: ArrayLike<number>,
  sampleRate: number,
  bands: readonly WaveformBand[] = DEFAULT_WAVEFORM_BANDS,
  regions: readonly WaveformRegion[] = DEFAULT_WAVEFORM_REGIONS,
): WaveformBandEnergy[] {
  validateSpecs(sampleRate, bands, regions);
  const result: WaveformBandEnergy[] = [];
  for (const region of regions) {
    const start = Math.round(region.startSec * sampleRate);
    const length = Math.round(
      (region.endSec - region.startSec) * sampleRate,
    );
    const windowed = new Float64Array(length);
    let windowEnergy = 0;
    for (let i = 0; i < length; i += 1) {
      const weight =
        0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
      windowEnergy += weight * weight;
      windowed[i] = (samples[start + i] ?? 0) * weight;
    }
    const { magnitudes, fftSize } = fftMagnitudeSpectrum(windowed);
    for (const band of bands) {
      let spectralEnergy = 0;
      for (let k = 1; k < magnitudes.length; k += 1) {
        const frequencyHz = (k * sampleRate) / fftSize;
        if (frequencyHz >= band.minHz && frequencyHz < band.maxHz) {
          const magnitude = magnitudes[k] ?? 0;
          spectralEnergy += magnitude * magnitude;
        }
      }
      result.push({
        region: region.name,
        ...band,
        energy:
          windowEnergy > 0
            ? (2 * fftSize * spectralEnergy) / windowEnergy
            : 0,
      });
    }
  }
  return result;
}

/**
 * Переводит отношение энергий в децибелы.
 *
 * @param reference - Энергия эталона
 * @param candidate - Энергия кандидата
 * @returns Разница в децибелах; `null`, если эталонная энергия
 *   не положительна
 * @remarks Отношение кандидата к эталону ограничено снизу `1e-30`,
 *   поэтому ослабление не опускается ниже −300 дБ.
 */
function energyDeltaDb(
  reference: number,
  candidate: number,
): number | null {
  if (reference <= 0) {
    return null;
  }
  return 10 * Math.log10(Math.max(candidate / reference, 1e-30));
}

/**
 * Сравнивает энергию полос кандидата и эталона на одних участках.
 *
 * @param reference - Отсчёты эталонного сигнала
 * @param candidate - Отсчёты проверяемого сигнала
 * @param sampleRate - Частота дискретизации обоих сигналов в Гц
 * @param bands - Полосы частот; нижняя граница включена,
 *   верхняя — нет
 * @param regions - Участки в секундах от начала сигнала
 * @returns Энергии обоих сигналов и разница `deltaDb` в децибелах;
 *   `null` означает, что эталонная энергия не положительна, иначе
 *   ослабление не опускается ниже −300 дБ
 * @throws Error если частота дискретизации, полоса или границы
 *   участка некорректны, а также если участок короче трёх отсчётов
 *   или длиннее {@link MAX_FFT_SAMPLES} отсчётов
 * @remarks Ноль дБ означает равную энергию, отрицательное значение —
 *   ослабление, положительное — добавленную энергию. Метрика помогает
 *   проверять характер и находить перекосы, но не задаёт закон
 *   качества.
 */
export function compareWaveformBands(
  reference: ArrayLike<number>,
  candidate: ArrayLike<number>,
  sampleRate: number,
  bands: readonly WaveformBand[] = DEFAULT_WAVEFORM_BANDS,
  regions: readonly WaveformRegion[] = DEFAULT_WAVEFORM_REGIONS,
): WaveformBandDelta[] {
  const referenceMetrics = measureWaveformBands(
    reference,
    sampleRate,
    bands,
    regions,
  );
  const candidateMetrics = measureWaveformBands(
    candidate,
    sampleRate,
    bands,
    regions,
  );
  return referenceMetrics.map((referenceMetric, index) => {
    const candidateMetric = candidateMetrics[index];
    const candidateEnergy = candidateMetric?.energy ?? 0;
    return {
      ...referenceMetric,
      referenceEnergy: referenceMetric.energy,
      candidateEnergy,
      deltaDb: energyDeltaDb(referenceMetric.energy, candidateEnergy),
    };
  });
}
