import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SAMPLE_RATE } from '../consts';
import { readWav } from '../read-wav';
import type { ArgCreateSynth } from '../synth';
import {
  makeStructuralVariant,
  verifyStructuralVariant,
  type StructuralVariantManifest,
  type StructuralVariantResult,
  type StructuralVariantSpec,
} from './structural-variants';
import {
  assertStructuralSpecMetadata,
  parseStructuralVariantCliArgs,
  renderStructuralVariantSamples,
  runStructuralVariantFiles,
  saveStructuralVariantRun,
  structuralPatchSha256,
  STRUCTURAL_VARIANT_RUN_USAGE,
  type StructuralVariantCliOptions,
  type StructuralVariantEvaluation,
} from './structural-variants-run';

/** Известный patch с полной ручной разметкой и одним off-слотом. */
function createRunPatch(): ArgCreateSynth {
  return {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 50,
          freqStart: 150,
          duration: 0.25,
          slope: 1,
          phase: 0.1,
        },
        ampEnv: {
          startLevel: 0.5,
          endLevel: 0.01,
          duration: 0.5,
          slope: 0.8,
        },
      },
      {
        osc: {
          on: true,
          freqBase: 4000,
          freqStart: 6000,
          duration: 0.04,
          slope: 2,
          phase: 0,
        },
        ampEnv: {
          startLevel: 0.2,
          endLevel: 0.001,
          duration: 0.04,
          slope: 2,
        },
      },
      {
        osc: {
          on: true,
          freqBase: 80,
          freqStart: 80,
          duration: 0.4,
          slope: 1,
          phase: 0.4,
        },
        ampEnv: {
          startLevel: 0.3,
          endLevel: 0.02,
          duration: 0.5,
          slope: 1,
        },
      },
      {
        osc: {
          on: false,
          freqBase: 900,
          freqStart: 900,
          duration: 0.2,
          slope: 1,
          phase: 0,
        },
        ampEnv: {
          startLevel: 0.1,
          endLevel: 0.001,
          duration: 0.2,
          slope: 1,
        },
      },
    ],
  };
}

/** Hash берётся из того же определения, которое CLI обещает в usage. */
function createRunSpec(
  patch: ArgCreateSynth,
  frequencyRatio = 1.2,
): StructuralVariantSpec {
  return {
    hypothesisId: 'manual-membrane-and-base-only-attack',
    source: {
      slug: 'known-offline-patch',
      seed: 3,
      phaseModel: 'integral',
      codeRevision: 'test-revision',
      patchSha256: structuralPatchSha256(patch),
    },
    assignment: {
      membrane: [0],
      attackLinked: [{ index: 1, fields: ['osc.freqBase'] }],
      configuration: [2],
    },
    operator: 'body-plus-named-attack',
    frequencyRatio,
  };
}

async function createTempDir(): Promise<string> {
  const base = join(tmpdir(), 'opencode');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'structural-variants-run-'));
}

async function writeInputs(
  root: string,
  patch: ArgCreateSynth,
  spec: StructuralVariantSpec,
): Promise<{ patchPath: string; specPath: string }> {
  const patchPath = join(root, 'source.json');
  const specPath = join(root, 'spec.json');
  await writeFile(patchPath, JSON.stringify(patch), 'utf8');
  await writeFile(specPath, JSON.stringify(spec), 'utf8');
  return { patchPath, specPath };
}

function optionsFor(
  root: string,
  outDir: string,
  seconds = '0.5',
): StructuralVariantCliOptions {
  return parseStructuralVariantCliArgs([
    '--patch',
    join(root, 'source.json'),
    '--spec',
    join(root, 'spec.json'),
    '--out',
    outDir,
    '--seconds',
    seconds,
  ]);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

type RawSpec = Record<string, unknown>;

function createRawSpec(): RawSpec {
  const patch = createRunPatch();
  return structuredClone(createRunSpec(patch)) as unknown as RawSpec;
}

function rawSource(spec: RawSpec): RawSpec {
  const source = spec.source;
  assert.ok(typeof source === 'object' && source !== null);
  return source as RawSpec;
}

function asSpec(spec: RawSpec): StructuralVariantSpec {
  return spec as unknown as StructuralVariantSpec;
}

void test('CLI defines canonical hash and renders the rounded sample count', () => {
  const patch = createRunPatch();
  const expectedHash = createHash('sha256')
    .update(JSON.stringify(patch), 'utf8')
    .digest('hex');
  assert.equal(structuralPatchSha256(patch), expectedHash);
  assert.match(STRUCTURAL_VARIANT_RUN_USAGE, /JSON\.stringify/);

  const options = parseStructuralVariantCliArgs([
    '--seconds',
    '0.0015',
    '--out',
    'out',
    '--spec',
    'spec.json',
    '--patch',
    'patch.json',
  ]);
  assert.equal(options.seconds, 0.0015);
  assert.equal(options.sampleCount, Math.round(0.0015 * SAMPLE_RATE));
  assert.equal(
    renderStructuralVariantSamples(
      patch,
      options.sampleCount,
      'integral',
    ).length,
    options.sampleCount,
  );
  const oneSample = optionsFor(
    '/unused',
    '/unused/out',
    String(0.5 / SAMPLE_RATE),
  );
  assert.equal(oneSample.sampleCount, 1);
  assert.equal(
    renderStructuralVariantSamples(
      patch,
      oneSample.sampleCount,
      'integral',
    ).length,
    1,
  );
  assert.throws(() => parseStructuralVariantCliArgs([]), /--seconds/);
  for (const seconds of [
    '0',
    '2.1',
    'NaN',
    String(0.49 / SAMPLE_RATE),
  ]) {
    assert.throws(
      () => optionsFor('/unused', '/unused/out', seconds),
      /--seconds/,
    );
  }
});

void test('runtime validation rejects missing and malformed source metadata', () => {
  const invalidByField: Record<string, unknown[]> = {
    slug: [undefined, '', '   ', 7],
    seed: [undefined, 0, -1, 1.5, Number.NaN, '3'],
    codeRevision: [undefined, '', '   ', 7],
    phaseModel: [undefined, 'other', 7],
    patchSha256: [
      undefined,
      'A'.repeat(64),
      'g'.repeat(64),
      '0'.repeat(63),
      7,
    ],
  };
  for (const [field, values] of Object.entries(invalidByField)) {
    for (const value of values) {
      const malformed = createRawSpec();
      rawSource(malformed)[field] = value;
      assert.throws(
        () => assertStructuralSpecMetadata(asSpec(malformed)),
        Error,
        `${field}=${String(value)} должен быть отклонён`,
      );
    }

    const missing = createRawSpec();
    delete rawSource(missing)[field];
    assert.throws(
      () => assertStructuralSpecMetadata(asSpec(missing)),
      Error,
      `отсутствующий ${field} должен быть отклонён`,
    );

    const undefinedField = createRawSpec();
    rawSource(undefinedField)[field] = undefined;
    const jsonWithoutField = JSON.parse(
      JSON.stringify(undefinedField),
    ) as RawSpec;
    assert.throws(
      () => assertStructuralSpecMetadata(asSpec(jsonWithoutField)),
      Error,
      `JSON не должен молча терять обязательный ${field}`,
    );
  }

  const valid = createRawSpec();
  rawSource(valid).codeRevision = null;
  rawSource(valid).seed = 1;
  assert.doesNotThrow(() =>
    assertStructuralSpecMetadata(asSpec(valid)),
  );
});

void test('runtime validation rejects missing and malformed top-level spec fields', () => {
  const invalidByField: Record<string, unknown[]> = {
    hypothesisId: [undefined, '', '   ', 7],
    source: [undefined, null, 7],
    assignment: [undefined, null, {}],
    operator: [undefined, 'unknown', 7],
    frequencyRatio: [undefined, 0, -1, Number.NaN, '1.2'],
  };
  for (const [field, values] of Object.entries(invalidByField)) {
    for (const value of values) {
      const malformed = createRawSpec();
      malformed[field] = value;
      assert.throws(
        () => assertStructuralSpecMetadata(asSpec(malformed)),
        Error,
        `${field}=${String(value)} должен быть отклонён`,
      );
    }

    const missing = createRawSpec();
    delete missing[field];
    assert.throws(
      () => assertStructuralSpecMetadata(asSpec(missing)),
      Error,
      `отсутствующий ${field} должен быть отклонён`,
    );

    const undefinedField = createRawSpec();
    undefinedField[field] = undefined;
    const jsonWithoutField = JSON.parse(
      JSON.stringify(undefinedField),
    ) as RawSpec;
    assert.throws(
      () => assertStructuralSpecMetadata(asSpec(jsonWithoutField)),
      Error,
      `JSON не должен молча терять обязательный ${field}`,
    );
  }
  assert.throws(
    () =>
      assertStructuralSpecMetadata(
        null as unknown as StructuralVariantSpec,
      ),
    /spec должен быть объектом/,
  );
});

void test('runner writes canonical deterministic artifacts and mechanical metrics', async (t) => {
  const root = await createTempDir();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const source = createRunPatch();
  const spec = createRunSpec(source);
  await writeInputs(root, source, spec);
  const expected = makeStructuralVariant(source, spec);

  const first = await runStructuralVariantFiles(
    optionsFor(root, join(root, 'out-a')),
  );
  const second = await runStructuralVariantFiles(
    optionsFor(root, join(root, 'out-b')),
  );
  const manifest = await readJson<StructuralVariantManifest>(
    first.manifestPath,
  );
  const candidate = await readJson<ArgCreateSynth>(first.patchPath);
  const audit = await readJson<StructuralVariantResult['audit']>(
    first.auditPath,
  );
  const evaluation = await readJson<StructuralVariantEvaluation>(
    first.evaluationPath,
  );
  assert.deepEqual(manifest, expected.manifest);
  assert.deepEqual(candidate, expected.patch);
  assert.deepEqual(audit, expected.audit);
  assert.ok(manifest.plannedEdits.length > 0);
  assert.equal(evaluation.sourcePatchSha256, spec.source.patchSha256);
  assert.equal(
    evaluation.candidatePatchSha256,
    structuralPatchSha256(candidate),
  );
  assert.equal(evaluation.candidateMatchesWav, true);
  assert.equal(evaluation.sampleCount, 22050);
  assert.ok(evaluation.bands.length > 0);
  assert.equal('pass' in evaluation, false);

  const wavBytes = await readFile(first.resultWavPath);
  const wav = readWav(first.resultWavPath);
  assert.equal(wav.sampleRate, SAMPLE_RATE);
  assert.equal(wav.samples.length, evaluation.sampleCount);
  assert.equal(
    evaluation.wavSha256,
    createHash('sha256').update(wavBytes).digest('hex'),
  );

  const names = [
    'manifest.json',
    'patch.json',
    'audit.json',
    'result.wav',
    'evaluation.json',
  ];
  for (const name of names) {
    const firstBytes = await readFile(join(first.outDir, name));
    const secondBytes = await readFile(join(second.outDir, name));
    assert.ok(
      firstBytes.equals(secondBytes),
      `${name} должен быть детерминированным`,
    );
  }
});

void test('ratio 1 gives identical source and candidate PCM', async (t) => {
  const root = await createTempDir();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const source = createRunPatch();
  const spec = createRunSpec(source, 1);
  await writeInputs(root, source, spec);
  const options = optionsFor(root, join(root, 'out'));
  const result = await runStructuralVariantFiles(options);
  const candidate = await readJson<ArgCreateSynth>(result.patchPath);
  const sourceSamples = renderStructuralVariantSamples(
    source,
    options.sampleCount,
    spec.source.phaseModel,
  );
  const candidateSamples = renderStructuralVariantSamples(
    candidate,
    options.sampleCount,
    spec.source.phaseModel,
  );

  assert.deepEqual(candidateSamples, sourceSamples);
  assert.deepEqual(
    readWav(result.resultWavPath).samples,
    sourceSamples,
  );
  assert.equal(result.evaluation.sourceCandidatePcmEqual, true);
  assert.equal(
    result.evaluation.candidatePatchSha256,
    result.evaluation.sourcePatchSha256,
  );
});

void test('source hash mismatch is rejected before any WAV or JSON output', async (t) => {
  const root = await createTempDir();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const source = createRunPatch();
  const spec = createRunSpec(source);
  spec.source.patchSha256 = '0'.repeat(64);
  await writeInputs(root, source, spec);
  const outDir = join(root, 'out');

  await assert.rejects(
    runStructuralVariantFiles(optionsFor(root, outDir)),
    /patchSha256 mismatch/,
  );
  assert.equal(existsSync(join(outDir, 'result.wav')), false);
  assert.equal(existsSync(join(outDir, 'manifest.json')), false);
});

void test('candidate manifest and audit tampering block rendering before artifacts', async (t) => {
  const root = await createTempDir();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const source = createRunPatch();
  const sourceSnapshot = structuredClone(source);
  const spec = createRunSpec(source);
  const original = makeStructuralVariant(source, spec);
  const mutations: [
    string,
    (variant: StructuralVariantResult) => void,
  ][] = [
    [
      'planned',
      (variant): void => {
        const group = variant.patch.oscillators[0];
        assert.ok(group);
        group.osc.freqBase += 1;
      },
    ],
    [
      'frozen',
      (variant): void => {
        const group = variant.patch.oscillators[2];
        assert.ok(group);
        group.osc.phase += 0.1;
      },
    ],
    [
      'combined-candidate-manifest',
      (variant): void => {
        const group = variant.patch.oscillators[2];
        assert.ok(group);
        group.osc.phase += 0.1;
        variant.manifest.frozenFields =
          variant.manifest.frozenFields.filter(
            (frozen) =>
              frozen.oscillatorIndex !== 2 ||
              frozen.field !== 'osc.phase',
          );
      },
    ],
    [
      'forged-audit',
      (variant): void => {
        variant.audit = {
          valid: true,
          sourceUnchanged: true,
          actualEdits: [],
          violations: [],
        };
      },
    ],
  ];

  for (const [name, mutate] of mutations) {
    const variant = structuredClone(original);
    mutate(variant);
    if (
      name === 'combined-candidate-manifest' ||
      name === 'forged-audit'
    ) {
      assert.deepEqual(
        verifyStructuralVariant(
          source,
          variant.patch,
          variant.manifest,
        ),
        [],
        `${name} обходит проверку только по переданному manifest`,
      );
    }
    const outDir = join(root, `out-${name}`);
    await assert.rejects(
      saveStructuralVariantRun({
        source,
        spec,
        outDir,
        sampleCount: 441,
        variant,
      }),
      /нарушает инварианты/,
    );
    assert.equal(existsSync(join(outDir, 'result.wav')), false);
    assert.equal(existsSync(join(outDir, 'manifest.json')), false);
  }
  assert.deepEqual(source, sourceSnapshot);
});
