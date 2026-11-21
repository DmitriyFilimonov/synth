/**
 * Проверка одного патча против отношений, выведенных по эталонам.
 *
 * Пороги строятся по всему датасету эталонов (медианы по сидам на
 * таргет), а патч проверяется на нарушения. Так сервис получает
 * список дефектов в терминах закона, а не ощущений.
 *
 * Запуск:
 *   npx tsx src/dataset/law-check-patch.ts \
 *     --dataset datasets/reference-4 --patch patch.json
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  computeLawMetrics,
  type LawMetrics,
  type LawOsc,
} from './law-metrics';
import { readJsonOrNull } from './shared';
import { type ArgCreateSynth } from '../synth';
import {
  classifyOscillatorRole,
  extractOscillatorFeatures,
} from './extract-features';
import { dualWindowInitVector } from '../dual-window-init-vector';
import { readWav } from '../read-wav';
import { SAMPLE_RATE } from '../consts';

interface FeatureOsc {
  role: 'sustain' | 'transient';
  freqBase: number;
  freqStartToBase: number;
  ampStartLevel: number;
  decaySecToDb?: { db20: number | null };
}

interface RunFeatures {
  oscillators: FeatureOsc[];
}

function toLawOsc(o: FeatureOsc): LawOsc {
  return {
    role: o.role,
    freqBase: o.freqBase,
    freqStartToBase: o.freqStartToBase,
    ampStartLevel: o.ampStartLevel,
    decayDb20Sec: o.decaySecToDb?.db20 ?? null,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] ?? null;
  const a = s[mid - 1];
  const b = s[mid];
  return a !== undefined && b !== undefined ? (a + b) / 2 : null;
}

/** Медианы метрик по сидам каждого таргета датасета. */
async function referenceMetrics(
  datasetDir: string,
): Promise<LawMetrics[]> {
  const out: LawMetrics[] = [];
  for (const entry of readdirSync(datasetDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const runs: LawMetrics[] = [];
    const slugDir = join(datasetDir, entry.name);
    for (const seedDir of readdirSync(slugDir, {
      withFileTypes: true,
    })) {
      if (!seedDir.isDirectory() || !seedDir.name.startsWith('seed-'))
        continue;
      const features = await readJsonOrNull<RunFeatures>(
        join(slugDir, seedDir.name, 'features.json'),
      );
      if (features !== null) {
        runs.push(
          computeLawMetrics(features.oscillators.map(toLawOsc)),
        );
      }
    }
    if (runs.length === 0) continue;
    const pick = (
      get: (m: LawMetrics) => number | null,
    ): number | null =>
      median(runs.map(get).filter((v): v is number => v !== null));
    out.push({
      bodySweepMedian: pick((m) => m.bodySweepMedian),
      upperSweepMedian: pick((m) => m.upperSweepMedian),
      nearIntFraction: pick((m) => m.nearIntFraction),
      top3Share: pick((m) => m.top3Share),
      top3MaxFreq: pick((m) => m.top3MaxFreq),
      lowBandTop1Share: pick((m) => m.lowBandTop1Share),
      lowBandEffectiveCount: pick((m) => m.lowBandEffectiveCount),
      lowBandTop1Share: pick((m) => m.lowBandTop1Share),
      lowBandEffectiveCount: pick((m) => m.lowBandEffectiveCount),
      lowBandTop1Share: pick((m) => m.lowBandTop1Share),
      lowBandEffectiveCount: pick((m) => m.lowBandEffectiveCount),
      lowBandTop1Share: pick((m) => m.lowBandTop1Share),
      lowBandEffectiveCount: pick((m) => m.lowBandEffectiveCount),
      sustainCount: Math.round(pick((m) => m.sustainCount) ?? 0),
    });
  }
  return out;
}

/** Считает нарушения патча относительно диапазонов эталонов. */
function violations(patch: LawMetrics, refs: LawMetrics[]): string[] {
  const bad: string[] = [];
  const values = (get: (m: LawMetrics) => number | null): number[] =>
    refs.map(get).filter((v): v is number => v !== null);

  const body = patch.bodySweepMedian;
  if (body !== null && body < 1) {
    bad.push(
      `тело свипует вверх: медиана ${body.toFixed(2)} < 1, у эталонов минимум ${Math.min(...values((m) => m.bodySweepMedian)).toFixed(2)}`,
    );
  }
  const upper = patch.upperSweepMedian;
  const upperMax = Math.max(...values((m) => m.upperSweepMedian));
  if (upper !== null && upper > upperMax * 1.05) {
    bad.push(
      `верх свипует: ${upper.toFixed(2)} выше эталонного ${upperMax.toFixed(2)}`,
    );
  }
  const near = patch.nearIntFraction;
  const nearMax = Math.max(...values((m) => m.nearIntFraction));
  if (near !== null && near > nearMax + 0.02) {
    bad.push(
      `слишком гармоничен: ${near.toFixed(2)} выше эталонного ${nearMax.toFixed(2)}`,
    );
  }
  const share = patch.top3Share;
  const shareMin = Math.min(...values((m) => m.top3Share));
  if (share !== null && share < shareMin) {
    bad.push(
      `иерархия низа слабее: доля top3 ${share.toFixed(2)} ниже эталонной ${shareMin.toFixed(2)}`,
    );
  }
  const top1 = patch.lowBandTop1Share;
  const top1Max = Math.max(...values((m) => m.lowBandTop1Share));
  if (top1 !== null && top1 > top1Max + 0.02) {
    bad.push(
      `низ концентрируется в одном компоненте: доля top1 ${top1.toFixed(2)} выше эталонной ${top1Max.toFixed(2)}`,
    );
  }
  const maxFreq = patch.top3MaxFreq;
  const freqMax = Math.max(...values((m) => m.top3MaxFreq));
  if (maxFreq !== null && maxFreq > freqMax) {
    bad.push(
      `энергия низа выше тела: ${maxFreq.toFixed(0)} Гц выше эталонного ${freqMax.toFixed(0)} Гц`,
    );
  }
  return bad;
}

/** Переводит патч в признаки осцилляторов по ролям из init-вектора. */
function patchToLawOscs(
  patch: ArgCreateSynth,
  wavPath?: string,
): LawOsc[] {
  // Роли определяются по init-слотам, как в датасете. Если WAV не
  // дан, считаем по длительности огибающей: короткая — transient.
  let init: number[] | null = null;
  if (wavPath !== undefined) {
    init = dualWindowInitVector(
      readWav(wavPath).samples,
      SAMPLE_RATE,
      50,
    );
  }
  const out: LawOsc[] = [];
  patch.oscillators.forEach((group, index) => {
    if (!group.osc.on) return;
    const role =
      init !== null
        ? classifyOscillatorRole(init, index)
        : group.ampEnv.duration < 0.06
          ? 'transient'
          : 'sustain';
    const f = extractOscillatorFeatures({ group, index, role });
    if (f === null) return;
    out.push({
      role,
      freqBase: f.freqBase,
      freqStartToBase: f.freqStartToBase,
      ampStartLevel: f.ampStartLevel,
      decayDb20Sec: f.decaySecToDb.db20,
    });
  });
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const datasetArg = get('--dataset');
  const patchArg = get('--patch');
  if (datasetArg === undefined || patchArg === undefined) {
    throw new Error(
      'Usage: --dataset <dir> --patch <patch.json> [--wav <input.wav>]',
    );
  }
  const patch = JSON.parse(
    readFileSync(resolve(patchArg), 'utf8'),
  ) as ArgCreateSynth;
  const refs = await referenceMetrics(resolve(datasetArg));
  const metrics = computeLawMetrics(
    patchToLawOscs(patch, get('--wav')),
  );
  const bad = violations(metrics, refs);
  console.log(JSON.stringify({ metrics, violations: bad }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
