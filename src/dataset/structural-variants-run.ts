/* eslint-disable no-console */
/**
 * Строит один offline-вариант T35 из готовых patch и spec. Роли берёт
 * только из spec, не запускает match/enhance/CD и не оценивает закон.
 *
 * Usage:
 *   npx tsx src/dataset/structural-variants-run.ts \
 *     --patch FILE --spec FILE --out DIR --seconds SEC
 * SEC лежит в [0.5/44100, 2], поэтому round(SEC * 44100) >= 1.
 *
 * SHA-256 исходника — lowercase hex от UTF-8 байтов JSON.stringify(patch)
 * после проверки структуры. JSON.parse сохраняет порядок ключей входа;
 * runner не сортирует их и не использует pretty-print для hash. Тот же
 * алгоритм задаёт hash кандидата в evaluation.json.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SAMPLE_RATE } from '../consts';
import {
  compareCharacter,
  type CharacterDelta,
} from '../character-metrics';
import { readWav } from '../read-wav';
import {
  MAX_OSCILLATORS,
  type ArgCreateSynth,
  type PhaseModel,
} from '../synth';
import {
  compareWaveformBands,
  type WaveformBandDelta,
} from '../waveform-bands';
import { writeWav } from '../write-wav';
import { assertPatchMatchesWav } from './beat-transfer-run';
import { renderSamples, writeJsonAtomic } from './shared';
import {
  makeStructuralVariant,
  verifyStructuralVariant,
  type StructuralVariantResult,
  type StructuralVariantSpec,
} from './structural-variants';

/** Минимум, который после round даёт один отсчёт при 44100 Гц. */
const MIN_SECONDS = 0.5 / SAMPLE_RATE;

/** Максимальная длительность offline-контроля в секундах. */
const MAX_SECONDS = 2;

/** Текст usage и определение hash доступны даже без чтения репозитория. */
export const STRUCTURAL_VARIANT_RUN_USAGE =
  'npx tsx src/dataset/structural-variants-run.ts ' +
  '--patch FILE --spec FILE --out DIR --seconds SEC\n' +
  'seconds: [0.5/44100, 2], rounded samples >= 1.\n' +
  'SHA-256: lowercase hex of UTF-8 JSON.stringify(parsed patch).';

/** Разобранные обязательные параметры CLI. */
export interface StructuralVariantCliOptions {
  patchPath: string;
  specPath: string;
  outDir: string;
  seconds: number;
  sampleCount: number;
}

/** Механические метрики вмешательства, без вердикта качества или закона. */
export interface StructuralVariantEvaluation {
  version: 1;
  hypothesisId: string;
  phaseModel: PhaseModel;
  sampleCount: number;
  sourcePatchSha256: string;
  candidatePatchSha256: string;
  wavSha256: string;
  candidateMatchesWav: true;
  sourceCandidatePcmEqual: boolean;
  character: CharacterDelta;
  bands: WaveformBandDelta[];
}

/** Пути и метрики одного завершённого offline-прогона. */
export interface StructuralVariantRunSummary {
  outDir: string;
  manifestPath: string;
  patchPath: string;
  auditPath: string;
  resultWavPath: string;
  evaluationPath: string;
  evaluation: StructuralVariantEvaluation;
}

/** Аргументы записи уже построенного варианта. */
export interface SaveStructuralVariantRunArg {
  source: ArgCreateSynth;
  spec: StructuralVariantSpec;
  outDir: string;
  sampleCount: number;
  variant: StructuralVariantResult;
}

/** Проверяет структуру patch до того, как его JSON станет входом hash. */
export function assertStructuralPatch(patch: ArgCreateSynth): void {
  if (
    typeof patch !== 'object' ||
    patch === null ||
    !Array.isArray(patch.oscillators)
  ) {
    throw new Error('patch должен содержать массив oscillators');
  }
  if (patch.oscillators.length > MAX_OSCILLATORS) {
    throw new Error(
      `patch содержит больше ${MAX_OSCILLATORS} осцилляторов`,
    );
  }
  patch.oscillators.forEach((group, index) => {
    if (typeof group !== 'object' || group === null) {
      throw new Error(`osc[${index}] должен быть объектом`);
    }
    const { osc, ampEnv } = group;
    if (
      typeof osc !== 'object' ||
      osc === null ||
      typeof ampEnv !== 'object' ||
      ampEnv === null
    ) {
      throw new Error(`osc[${index}] должен содержать osc и ampEnv`);
    }
    if (typeof osc.on !== 'boolean') {
      throw new Error(`osc[${index}].osc.on должен быть boolean`);
    }
    const numericFields: [string, unknown][] = [
      ['osc.freqBase', osc.freqBase],
      ['osc.freqStart', osc.freqStart],
      ['osc.duration', osc.duration],
      ['osc.slope', osc.slope],
      ['osc.phase', osc.phase],
      ['ampEnv.startLevel', ampEnv.startLevel],
      ['ampEnv.duration', ampEnv.duration],
      ['ampEnv.slope', ampEnv.slope],
    ];
    if (ampEnv.endLevel !== undefined) {
      numericFields.push(['ampEnv.endLevel', ampEnv.endLevel]);
    }
    if (ampEnv.attack !== undefined) {
      numericFields.push(['ampEnv.attack', ampEnv.attack]);
    }
    if (
      ampEnv.hardStop !== undefined &&
      typeof ampEnv.hardStop !== 'boolean'
    ) {
      throw new Error(
        `osc[${index}].ampEnv.hardStop должен быть boolean`,
      );
    }
    for (const [field, value] of numericFields) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `osc[${index}].${field} должен быть конечным числом`,
        );
      }
    }
  });
}

/** Возвращает SHA-256 канонического для runner JSON-представления patch. */
export function structuralPatchSha256(patch: ArgCreateSynth): string {
  assertStructuralPatch(patch);
  return createHash('sha256')
    .update(JSON.stringify(patch), 'utf8')
    .digest('hex');
}

/** Непустые строки не должны состоять только из пробелов. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Проверяет весь runtime-контракт spec до обращения к вложенным полям.
 * Runner принимает положительные целые seed, начиная с 1.
 */
export function assertStructuralSpecMetadata(
  spec: StructuralVariantSpec,
): void {
  if (typeof spec !== 'object' || spec === null) {
    throw new Error('spec должен быть объектом');
  }
  if (!isNonEmptyString(spec.hypothesisId)) {
    throw new Error('spec.hypothesisId должен быть непустой строкой');
  }
  if (typeof spec.source !== 'object' || spec.source === null) {
    throw new Error('spec должен содержать объект source');
  }
  if (!isNonEmptyString(spec.source.slug)) {
    throw new Error('spec.source.slug должен быть непустой строкой');
  }
  if (!Number.isInteger(spec.source.seed) || spec.source.seed < 1) {
    throw new Error('spec.source.seed должен быть целым числом >= 1');
  }
  if (
    spec.source.codeRevision !== null &&
    !isNonEmptyString(spec.source.codeRevision)
  ) {
    throw new Error(
      'spec.source.codeRevision должен быть непустой строкой или null',
    );
  }
  if (
    spec.source.phaseModel !== 'legacy' &&
    spec.source.phaseModel !== 'integral'
  ) {
    throw new Error(
      'spec.source.phaseModel должен быть legacy или integral',
    );
  }
  if (
    typeof spec.source.patchSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(spec.source.patchSha256)
  ) {
    throw new Error(
      'spec.source.patchSha256 должен содержать 64 lowercase hex-символа',
    );
  }
  if (
    typeof spec.assignment !== 'object' ||
    spec.assignment === null
  ) {
    throw new Error('spec должен содержать объект assignment');
  }
  if (
    !Array.isArray(spec.assignment.membrane) ||
    !Array.isArray(spec.assignment.attackLinked) ||
    !Array.isArray(spec.assignment.configuration)
  ) {
    throw new Error(
      'spec.assignment должен содержать три массива ролей',
    );
  }
  spec.assignment.attackLinked.forEach((link, index) => {
    if (
      typeof link !== 'object' ||
      link === null ||
      !Array.isArray(link.fields)
    ) {
      throw new Error(
        `spec.assignment.attackLinked[${index}] должен содержать fields`,
      );
    }
  });
  if (
    spec.operator !== 'membrane-only' &&
    spec.operator !== 'body-plus-named-attack' &&
    spec.operator !== 'all-components'
  ) {
    throw new Error('spec.operator содержит неизвестный оператор');
  }
  if (
    typeof spec.frequencyRatio !== 'number' ||
    !Number.isFinite(spec.frequencyRatio) ||
    spec.frequencyRatio <= 0
  ) {
    throw new Error('spec.frequencyRatio должен быть конечным и > 0');
  }
}

/** Сверяет исходник с заранее зафиксированным hash до make и синтеза. */
function assertSourcePatchHash(
  source: ArgCreateSynth,
  spec: StructuralVariantSpec,
): void {
  const actual = structuralPatchSha256(source);
  const expected = spec.source.patchSha256;
  if (actual !== expected) {
    throw new Error(
      `patchSha256 mismatch: spec=${expected}, actual=${actual}`,
    );
  }
}

/** Проверяет целое число отсчётов в поддерживаемом диапазоне. */
function assertSampleCount(sampleCount: number): void {
  if (
    !Number.isInteger(sampleCount) ||
    sampleCount < 1 ||
    sampleCount > MAX_SECONDS * SAMPLE_RATE
  ) {
    throw new Error(
      `sampleCount должен быть целым в диапазоне 1..${
        MAX_SECONDS * SAMPLE_RATE
      }`,
    );
  }
}

/** Разбирает четыре обязательные опции; роли из CLI не принимаются. */
export function parseStructuralVariantCliArgs(
  args: string[],
): StructuralVariantCliOptions {
  const allowed = new Set([
    '--patch',
    '--spec',
    '--out',
    '--seconds',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || !allowed.has(key)) {
      throw new Error(`Неизвестный аргумент: ${key ?? ''}`);
    }
    if (value === undefined) {
      throw new Error(`Нет значения для ${key}`);
    }
    if (values.has(key)) {
      throw new Error(`Повторный аргумент: ${key}`);
    }
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) {
      throw new Error(
        `Нужен аргумент ${key}\n${STRUCTURAL_VARIANT_RUN_USAGE}`,
      );
    }
    return value;
  };
  const seconds = Number(required('--seconds'));
  const sampleCount = Math.round(seconds * SAMPLE_RATE);
  if (
    !Number.isFinite(seconds) ||
    seconds < MIN_SECONDS ||
    seconds > MAX_SECONDS ||
    sampleCount < 1
  ) {
    throw new Error(
      '--seconds должен быть в диапазоне [0.5/44100, 2]; ' +
        'round(seconds * 44100) должен быть >= 1',
    );
  }
  assertSampleCount(sampleCount);
  return {
    patchPath: required('--patch'),
    specPath: required('--spec'),
    outDir: required('--out'),
    seconds,
    sampleCount,
  };
}

/** Рендерит ровно sampleCount отсчётов через общий renderSamples. */
export function renderStructuralVariantSamples(
  patch: ArgCreateSynth,
  sampleCount: number,
  phaseModel: PhaseModel,
): Int16Array {
  assertSampleCount(sampleCount);
  const samples = renderSamples(
    patch,
    (sampleCount + 0.5) / SAMPLE_RATE,
    { phaseModel },
  );
  if (samples.length !== sampleCount) {
    throw new Error(
      `renderSamples вернул ${samples.length} вместо ${sampleCount}`,
    );
  }
  return samples;
}

/** Нормализует -0 для семантического сравнения без мутации входа. */
function canonicalizeNumericZeros(value: unknown): unknown {
  if (typeof value === 'number') {
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeNumericZeros);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = canonicalizeNumericZeros(nested);
    }
    return result;
  }
  return value;
}

/** Игнорирует порядок ключей объекта, но сохраняет порядок массивов контракта. */
function canonicalDeepEqual(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(
    canonicalizeNumericZeros(a),
    canonicalizeNumericZeros(b),
  );
}

/**
 * Воспроизводит ожидаемый variant из source/spec и блокирует любые
 * подмены patch, manifest или audit. Переданному audit не доверяем.
 */
export function assertStructuralVariantIntegrity(
  source: ArgCreateSynth,
  spec: StructuralVariantSpec,
  variant: StructuralVariantResult,
): void {
  const expected = makeStructuralVariant(source, spec);
  const expectedViolations = verifyStructuralVariant(
    source,
    expected.patch,
    expected.manifest,
  );
  const candidateViolations = verifyStructuralVariant(
    source,
    variant.patch,
    variant.manifest,
  );
  const matches = {
    patch: canonicalDeepEqual(variant.patch, expected.patch),
    manifest: canonicalDeepEqual(variant.manifest, expected.manifest),
    audit: canonicalDeepEqual(variant.audit, expected.audit),
  };
  const expectedAuditValid =
    expected.audit.valid &&
    expected.audit.sourceUnchanged &&
    expected.audit.violations.length === 0;
  if (
    !expectedAuditValid ||
    expectedViolations.length > 0 ||
    candidateViolations.length > 0 ||
    !matches.patch ||
    !matches.manifest ||
    !matches.audit
  ) {
    throw new Error(
      'Structural variant нарушает инварианты: ' +
        JSON.stringify({
          expectedAuditValid,
          expectedViolations,
          candidateViolations,
          matches,
        }),
    );
  }
}

/** Сравнивает PCM без акустических или статистических допусков. */
function samplesEqual(a: Int16Array, b: Int16Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

/** Пишет WAV во временный файл и атомарно заменяет назначение. */
async function writeResultWavAtomic(
  filePath: string,
  samples: Int16Array,
): Promise<void> {
  const temporary = `${filePath}.tmp`;
  writeWav({ samples, sampleRate: SAMPLE_RATE, filePath: temporary });
  await rename(temporary, filePath);
}

/**
 * Воспроизводит ожидаемый variant и требует семантического совпадения
 * patch/manifest/audit до записи. JSON пишется атомарно до синтеза WAV.
 * Manifest и audit после рендера не перезаписываются.
 */
export async function saveStructuralVariantRun(
  arg: SaveStructuralVariantRunArg,
): Promise<StructuralVariantRunSummary> {
  const { source, spec, variant } = arg;
  assertStructuralPatch(source);
  assertStructuralSpecMetadata(spec);
  assertSourcePatchHash(source, spec);
  assertSampleCount(arg.sampleCount);
  assertStructuralVariantIntegrity(source, spec, variant);

  const outDir = resolve(arg.outDir);
  await mkdir(outDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  const patchPath = join(outDir, 'patch.json');
  const auditPath = join(outDir, 'audit.json');
  const resultWavPath = join(outDir, 'result.wav');
  const evaluationPath = join(outDir, 'evaluation.json');
  await writeJsonAtomic(manifestPath, variant.manifest);
  await writeJsonAtomic(patchPath, variant.patch);
  await writeJsonAtomic(auditPath, variant.audit);

  const { phaseModel } = spec.source;
  const sourceSamples = renderStructuralVariantSamples(
    source,
    arg.sampleCount,
    phaseModel,
  );
  const candidateSamples = renderStructuralVariantSamples(
    variant.patch,
    arg.sampleCount,
    phaseModel,
  );
  await writeResultWavAtomic(resultWavPath, candidateSamples);

  const writtenWav = readWav(resultWavPath);
  assertPatchMatchesWav(
    variant.patch,
    writtenWav.samples,
    phaseModel,
    writtenWav.sampleRate,
    arg.sampleCount,
  );
  const wavBytes = await readFile(resultWavPath);
  const evaluation: StructuralVariantEvaluation = {
    version: 1,
    hypothesisId: spec.hypothesisId,
    phaseModel,
    sampleCount: arg.sampleCount,
    sourcePatchSha256: structuralPatchSha256(source),
    candidatePatchSha256: structuralPatchSha256(variant.patch),
    wavSha256: createHash('sha256').update(wavBytes).digest('hex'),
    candidateMatchesWav: true,
    sourceCandidatePcmEqual: samplesEqual(
      sourceSamples,
      candidateSamples,
    ),
    character: compareCharacter(
      sourceSamples,
      candidateSamples,
      SAMPLE_RATE,
    ),
    bands: compareWaveformBands(
      sourceSamples,
      candidateSamples,
      SAMPLE_RATE,
    ),
  };
  await writeJsonAtomic(evaluationPath, evaluation);
  return {
    outDir,
    manifestPath,
    patchPath,
    auditPath,
    resultWavPath,
    evaluationPath,
    evaluation,
  };
}

/** Читает JSON без fallback: повреждённый вход обязан дать ошибку CLI. */
async function readJsonInput(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

/** Загружает ровно один patch/spec и строит один вариант в outDir. */
export async function runStructuralVariantFiles(
  options: StructuralVariantCliOptions,
): Promise<StructuralVariantRunSummary> {
  const source = (await readJsonInput(
    resolve(options.patchPath),
  )) as ArgCreateSynth;
  assertStructuralPatch(source);
  const spec = (await readJsonInput(
    resolve(options.specPath),
  )) as StructuralVariantSpec;
  assertStructuralSpecMetadata(spec);
  assertSourcePatchHash(source, spec);
  const variant = makeStructuralVariant(source, spec);
  return saveStructuralVariantRun({
    source,
    spec,
    outDir: options.outDir,
    sampleCount: options.sampleCount,
    variant,
  });
}

/** Точка входа: любая ошибка ввода или записи даёт ненулевой exit. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(STRUCTURAL_VARIANT_RUN_USAGE);
    return;
  }
  try {
    const options = parseStructuralVariantCliArgs(args);
    const result = await runStructuralVariantFiles(options);
    console.log(
      `RESULT ${result.resultWavPath} ` +
        `samples=${result.evaluation.sampleCount} ` +
        `sha256=${result.evaluation.wavSha256}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(STRUCTURAL_VARIANT_RUN_USAGE);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
