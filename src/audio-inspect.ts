/**
 * Инспектор звука — «уши» для анализа WAV без прослушивания:
 * уровни, спектральные пики, центроид и плоскость по окнам,
 * сравнение двух файлов (глобально и по полосам).
 *
 * Стоит на собственных модулях проекта (read-wav, fft, rms,
 * cancellation-assessment) — без внешних зависимостей. Решение по
 * аудио-MCP: не подключаем, своего достаточно (см. реестр задач
 * docs/plan-kick-enhancement.md).
 *
 * Запуск:
 *   npx tsx src/audio-inspect.ts <file.wav>
 *   npx tsx src/audio-inspect.ts <a.wav> --compare <b.wav>
 *   флаги: --top 12 (пиков), --window-ms 50 (окно станционарности)
 */
import { SAMPLE_RATE } from './consts';
import { fftExtractHarmonics, fftMagnitudeSpectrum } from './fft';
import { evaluateSuppressionFromWaveform } from './optimize/evaluate';
import { readWav } from './read-wav';
import { calculateRMS } from './rms';

/** Аргументы командной строки инспектора. */
interface CliArgs {
  file: string;
  compare?: string;
  top: number;
  windowMs: number;
}

/** Сводка одного окна станционарности. */
interface WindowStats {
  tStartSec: number;
  rms: number;
  centroidHz: number;
  flatness: number;
}

/** Полный разбор одного файла. */
interface FileReport {
  durationSec: number;
  rms: number;
  peak: number;
  crestDb: number;
  peaks: { frequency: number; magnitude: number }[];
  windows: WindowStats[];
}

/** Полосы для сравнения остатка: границы в Гц. */
const COMPARE_BANDS: { name: string; lo: number; hi: number }[] = [
  { name: 'sub 20–120', lo: 20, hi: 120 },
  { name: 'low 120–800', lo: 120, hi: 800 },
  { name: 'mid 800–4000', lo: 800, hi: 4000 },
  { name: 'high 4000–16000', lo: 4000, hi: 16000 },
];

/** Разбирает аргументы командной строки в {@link CliArgs}. */
function parseCliArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const args: CliArgs = { file: '', top: 12, windowMs: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (
      arg === '--compare' ||
      arg === '--top' ||
      arg === '--window-ms'
    ) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      if (arg === '--compare') {
        args.compare = value;
      } else if (arg === '--top') {
        args.top = parseInt(value, 10);
      } else {
        args.windowMs = parseFloat(value);
      }
      continue;
    }
    if (arg !== undefined) {
      positional.push(arg);
    }
  }
  const file = positional[0];
  if (file === undefined) {
    throw new Error(
      'Usage: audio-inspect <file.wav> [--compare b.wav]',
    );
  }
  args.file = file;
  return args;
}

/** Считает спектральный центроид окна: энергетическое среднее частоты. */
function spectralCentroid(
  magnitudes: number[],
  fftSize: number,
): number {
  let weighted = 0;
  let total = 0;
  for (let k = 1; k < magnitudes.length; k++) {
    const m = magnitudes[k] ?? 0;
    weighted += ((k * SAMPLE_RATE) / fftSize) * m;
    total += m;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * Считает спектральную плоскость окна: отношение геометрического
 * среднего спектра к арифметическому. 1 — белый шум, 0 — чистый тон.
 */
function spectralFlatness(magnitudes: number[]): number {
  let logSum = 0;
  let total = 0;
  const eps = 1e-12;
  for (let k = 1; k < magnitudes.length; k++) {
    logSum += Math.log((magnitudes[k] ?? 0) + eps);
    total += magnitudes[k] ?? 0;
  }
  const bins = magnitudes.length - 1;
  const arithmetic = total / bins;
  if (arithmetic <= 0) {
    return 0;
  }
  return Math.exp(logSum / bins) / arithmetic;
}

/** Разбирает окно сигнала: RMS, центроид, плоскость. */
function analyzeWindow(
  samples: Float64Array,
  start: number,
  length: number,
  tStartSec: number,
): WindowStats {
  const slice = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    // Окно Ханна гасит краевые выбросы спектра.
    const hann =
      0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
    slice[i] = (samples[start + i] ?? 0) * hann;
  }
  const { magnitudes, fftSize } = fftMagnitudeSpectrum(slice);
  return {
    tStartSec,
    rms: calculateRMS([...slice]),
    centroidHz: spectralCentroid(magnitudes, fftSize),
    flatness: spectralFlatness(magnitudes),
  };
}

/** Собирает полный разбор файла: уровни, пики, окна. */
function analyzeFile(path: string, args: CliArgs): FileReport {
  const wav = readWav(path);
  const n = wav.samples.length;
  const floats = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = (wav.samples[i] ?? 0) / 32768;
    floats[i] = v;
    if (Math.abs(v) > peak) {
      peak = Math.abs(v);
    }
  }
  const rms = calculateRMS([...floats]);
  const crestDb = rms > 0 ? 20 * Math.log10(peak / rms) : 0;

  const peaks = fftExtractHarmonics(
    wav.samples,
    wav.sampleRate,
    args.top,
  );

  const windowLen = Math.floor(
    (wav.sampleRate * args.windowMs) / 1000,
  );
  const hop = Math.floor(windowLen / 2);
  const windows: WindowStats[] = [];
  for (let start = 0; start + windowLen <= n; start += hop) {
    windows.push(
      analyzeWindow(floats, start, windowLen, start / wav.sampleRate),
    );
  }

  return {
    durationSec: n / wav.sampleRate,
    rms,
    peak,
    crestDb,
    peaks,
    windows,
  };
}

/** Печатает разбор одного файла. */
function printFileReport(path: string, report: FileReport): void {
  console.log(`Файл: ${path}`);
  console.log(
    `  длительность ${report.durationSec.toFixed(3)}с, ` +
      `RMS ${report.rms.toFixed(4)}, пик ${report.peak.toFixed(4)}, ` +
      `крест-фактор ${report.crestDb.toFixed(1)} дБ`,
  );
  console.log('  Топ пиков:');
  const maxMag = Math.max(
    ...report.peaks.map((p) => p.magnitude),
    1e-12,
  );
  for (const p of report.peaks) {
    console.log(
      `    ${p.frequency.toFixed(1).padStart(8)} Гц  ` +
        `${(p.magnitude / maxMag).toFixed(3)}`,
    );
  }
  console.log('  Окна (время / RMS / центроид Гц / плоскость):');
  for (const w of report.windows) {
    console.log(
      `    ${w.tStartSec.toFixed(3)}с  ${w.rms.toFixed(4)}  ` +
        `${w.centroidHz.toFixed(0).padStart(6)}  ${w.flatness.toFixed(3)}`,
    );
  }
}

/** Энергия спектра в полосе [lo, hi) Гц (сумма квадратов). */
function bandEnergy(
  magnitudes: number[],
  fftSize: number,
  lo: number,
  hi: number,
): number {
  let sum = 0;
  for (let k = 1; k < magnitudes.length; k++) {
    const f = (k * SAMPLE_RATE) / fftSize;
    if (f >= lo && f < hi) {
      const m = magnitudes[k] ?? 0;
      sum += m * m;
    }
  }
  return sum;
}

/**
 * Сравнивает b против a: глобальный suppression и остаток по
 * полосам (доля энергии остатка к энергии эталона в полосе).
 */
function compareFiles(pathA: string, pathB: string): void {
  const a = readWav(pathA);
  const b = readWav(pathB);
  const n = Math.max(a.samples.length, b.samples.length);
  const aSamples: number[] = new Array<number>(n).fill(0);
  const bSamples: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    aSamples[i] = a.samples[i] ?? 0;
    bSamples[i] = b.samples[i] ?? 0;
  }

  const global = evaluateSuppressionFromWaveform(bSamples, aSamples);
  console.log(`A (эталон): ${pathA}`);
  console.log(`B (проверяемый): ${pathB}`);
  console.log(
    `  globalSuppression B против A: ${global.toFixed(2)}%`,
  );

  const residual = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    residual[i] = ((aSamples[i] ?? 0) - (bSamples[i] ?? 0)) / 32768;
  }
  const targetFloat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    targetFloat[i] = (aSamples[i] ?? 0) / 32768;
  }
  const resSpec = fftMagnitudeSpectrum(residual);
  const tgtSpec = fftMagnitudeSpectrum(targetFloat);

  console.log('  Остаток по полосам (энергия остатка / энергия A):');
  for (const band of COMPARE_BANDS) {
    const res = bandEnergy(
      resSpec.magnitudes,
      resSpec.fftSize,
      band.lo,
      band.hi,
    );
    const tgt = bandEnergy(
      tgtSpec.magnitudes,
      tgtSpec.fftSize,
      band.lo,
      band.hi,
    );
    const ratio = tgt > 0 ? res / tgt : 0;
    console.log(
      `    ${band.name.padEnd(16)} ${(ratio * 100).toFixed(2)}%`,
    );
  }
}

/** Точка входа: разбор файла и опциональное сравнение. */
function main(): void {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    printFileReport(args.file, analyzeFile(args.file, args));
    if (args.compare !== undefined) {
      console.log('');
      compareFiles(args.file, args.compare);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main();
