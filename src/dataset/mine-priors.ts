/**
 * Майнер приоров (T7 → контракт C2 из `docs/spec-kick-enhancement.md`):
 * кластеризует осцилляторы всех завершённых прогонов датасета по
 * log-частоте (отдельно по ролям) и выписывает распределения
 * признаков каждого воспроизводимого кластера.
 *
 * Кластер считаем воспроизводимым, если он представлен не менее
 * чем в половине сидов хотя бы одного таргета и содержит не менее
 * двух членов. Покрытие сидов — главный фильтр достоверности:
 * кластер, видимый одним прогоном, — шум оптимизатора, а не
 * закономерность.
 *
 * Запуск:
 *   npx tsx src/dataset/mine-priors.ts --dataset datasets/reference-4
 *
 * Артефакты: priors.json (по контракту C2) и priors.md (таблицы)
 * в каталоге датасета.
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  quantile,
  readJsonOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';
import { readWav } from '../read-wav';
import { calculateRMS } from '../rms';

/** Срез признаков осциллятора, который читает майнер. */
interface OscFeatures {
  index: number;
  role: 'sustain' | 'transient';
  freqBase: number;
  freqStartToBase: number;
  ampStartLevel: number;
  ampEndLevel: number;
  ampEnvDurationSec: number;
  decaySecToDb: { db20: number | null };
}

/** Срез features.json уровня прогона. */
interface RunFeatures {
  slug: string;
  seed: number;
  oscillators: OscFeatures[];
}

/** Осциллятор с привязкой к прогону. */
interface TaggedOsc extends OscFeatures {
  slug: string;
  seed: number;
}

/** Распределение одного признака в кластере. */
interface FeatureDist {
  median: number | null;
  p10: number | null;
  p90: number | null;
}

/** Кластер в priors.json. */
interface PriorCluster {
  id: string;
  role: 'sustain' | 'transient';
  members: number;
  targetsPresent: string[];
  seedCoverage: number;
  freqBaseHz: FeatureDist;
  freqStartToBase: FeatureDist;
  ampEnvDurationSec: FeatureDist;
  ampStartLevel: FeatureDist;
  ampEndLevel: FeatureDist;
  decayDb20Sec: FeatureDist;
}

/**
 * Слот профиля тела: отношения частоты, уровня и длительности
 * N-го партиала к фундаменталке, собранные по прогонам. Партиалы
 * реальных бочек не кратны — профиль несёт это в себе.
 */
interface BodyProfileSlot {
  rank: number;
  runs: number;
  freqRatio: FeatureDist;
  levelRatio: FeatureDist;
  durRatio: FeatureDist;
}

/** Уровень слышимости осциллятора при майнинге профиля тела. */
const AUDIBLE_LEVEL = 0.03;

/** Зазор в log-частоте, после которого режем новый кластер. */
const CLUSTER_GAP_LOG = 0.35;

/** Минимум членов и покрытие сидов для воспроизводимого кластера. */
const MIN_MEMBERS = 2;
const MIN_SEED_COVERAGE = 0.5;

/** Загружает все features.json датасета в плоский список. */
async function loadAllOscillators(
  datasetDir: string,
): Promise<TaggedOsc[]> {
  const out: TaggedOsc[] = [];
  const slugs = readdirSync(datasetDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const slug of slugs) {
    const slugDir = join(datasetDir, slug);
    const seedDirs = readdirSync(slugDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('seed-'))
      .map((d) => d.name)
      .sort();
    for (const seedDir of seedDirs) {
      const features = await readJsonOrNull<RunFeatures>(
        join(slugDir, seedDir, 'features.json'),
      );
      if (features === null) {
        continue;
      }
      for (const osc of features.oscillators) {
        out.push({
          ...osc,
          slug: features.slug,
          seed: features.seed,
        });
      }
    }
  }
  return out;
}

/**
 * Режет отсортированный по log-частоте список на кластеры: новый
 * кластер начинается там, где соседние члены дальше порога.
 */
function clusterByLogFreq(
  oscs: TaggedOsc[],
  gapLog: number,
): TaggedOsc[][] {
  const sorted = [...oscs].sort((a, b) => a.freqBase - b.freqBase);
  const clusters: TaggedOsc[][] = [];
  let current: TaggedOsc[] = [];
  let prevLog = -Infinity;
  for (const osc of sorted) {
    const logF = Math.log(osc.freqBase);
    if (current.length > 0 && logF - prevLog > gapLog) {
      clusters.push(current);
      current = [];
    }
    current.push(osc);
    prevLog = logF;
  }
  if (current.length > 0) {
    clusters.push(current);
  }
  return clusters;
}

/** Считает распределение признака: медиана и квантили 10/90. */
function distOf(values: number[]): FeatureDist {
  return {
    median: quantile(values, 0.5),
    p10: quantile(values, 0.1),
    p90: quantile(values, 0.9),
  };
}

/** Собирает кластер в запись priors по контракту C2. */
function buildPriorCluster(
  role: 'sustain' | 'transient',
  ordinal: number,
  members: TaggedOsc[],
  totalSeedsPerTarget: Map<string, number>,
): PriorCluster {
  const targetsPresent = [
    ...new Set(members.map((m) => m.slug)),
  ].sort();
  let coverageSum = 0;
  for (const slug of targetsPresent) {
    const present = new Set(
      members.filter((m) => m.slug === slug).map((m) => m.seed),
    ).size;
    const total = totalSeedsPerTarget.get(slug) ?? present;
    coverageSum += present / total;
  }
  const decayValues = members
    .map((m) => m.decaySecToDb.db20)
    .filter((d): d is number => d !== null);
  return {
    id: `${role}-${String(ordinal).padStart(2, '0')}`,
    role,
    members: members.length,
    targetsPresent,
    seedCoverage:
      targetsPresent.length > 0
        ? coverageSum / targetsPresent.length
        : 0,
    freqBaseHz: distOf(members.map((m) => m.freqBase)),
    freqStartToBase: distOf(members.map((m) => m.freqStartToBase)),
    ampEnvDurationSec: distOf(
      members.map((m) => m.ampEnvDurationSec),
    ),
    ampStartLevel: distOf(members.map((m) => m.ampStartLevel)),
    ampEndLevel: distOf(members.map((m) => m.ampEndLevel)),
    decayDb20Sec: distOf(decayValues),
  };
}

/**
 * Считает профиль тела по прогонам: фундаменталка — самый низкий
 * слышимый sustain, партиалы — слышимые sustain в зоне 1.5f–12f,
 * топ-3 по уровню. Отношения собираются по рангам слотов.
 */
function computeBodyProfile(all: TaggedOsc[]): BodyProfileSlot[] {
  const byRun = new Map<string, TaggedOsc[]>();
  for (const osc of all) {
    const key = `${osc.slug}/seed-${osc.seed}`;
    if (!byRun.has(key)) {
      byRun.set(key, []);
    }
    (byRun.get(key) ?? []).push(osc);
  }

  const slots: {
    freqRatio: number[];
    levelRatio: number[];
    durRatio: number[];
  }[] = [0, 1, 2].map(() => ({
    freqRatio: [],
    levelRatio: [],
    durRatio: [],
  }));

  for (const oscs of byRun.values()) {
    const sustain = oscs.filter(
      (o) => o.role === 'sustain' && o.ampStartLevel >= AUDIBLE_LEVEL,
    );
    if (sustain.length === 0) {
      continue;
    }
    const fund = sustain.reduce((a, b) =>
      a.freqBase <= b.freqBase ? a : b,
    );
    const partials = sustain
      .filter(
        (o) =>
          o.freqBase >= fund.freqBase * 1.5 &&
          o.freqBase <= fund.freqBase * 12,
      )
      .sort((a, b) => b.ampStartLevel - a.ampStartLevel)
      .slice(0, 3);
    partials.forEach((p, rank) => {
      const slot = slots[rank];
      if (slot === undefined || fund.ampStartLevel <= 0) {
        return;
      }
      slot.freqRatio.push(p.freqBase / fund.freqBase);
      slot.levelRatio.push(p.ampStartLevel / fund.ampStartLevel);
      if (fund.ampEnvDurationSec > 0) {
        slot.durRatio.push(
          p.ampEnvDurationSec / fund.ampEnvDurationSec,
        );
      }
    });
  }

  return slots
    .map((slot, rank) => ({
      rank: rank + 1,
      runs: slot.freqRatio.length,
      freqRatio: distOf(slot.freqRatio),
      levelRatio: distOf(slot.levelRatio),
      durRatio: distOf(slot.durRatio),
    }))
    .filter((s) => s.runs > 0);
}

/**
 * Считает семейную норму громкости: RMS таргетов датасета по
 * манифесту. Бочка с неверной громкостью — тоже дефект, и
 * нормализация идёт к этой норме.
 */
async function computeLoudnessNorm(
  datasetDir: string,
): Promise<FeatureDist | null> {
  const manifest = await readJsonOrNull<{
    targetsDir?: string;
    targets?: string[];
  }>(join(datasetDir, 'manifest.json'));
  if (
    manifest?.targetsDir === undefined ||
    manifest.targets === undefined
  ) {
    return null;
  }
  const values: number[] = [];
  for (const target of manifest.targets) {
    try {
      const wav = readWav(join(manifest.targetsDir, target));
      values.push(
        calculateRMS([...wav.samples].map((s) => s / 32768)),
      );
    } catch {
      continue;
    }
  }
  return values.length === 0 ? null : distOf(values);
}

/** Читает ревизию кода из git; при недоступности git — null. */
function readCodeRevision(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** Форматирует распределение для markdown-таблицы. */
function fmtDist(d: FeatureDist, digits = 2): string {
  if (d.median === null) {
    return '—';
  }
  const p10 = d.p10?.toFixed(digits) ?? '?';
  const p90 = d.p90?.toFixed(digits) ?? '?';
  return `${d.median.toFixed(digits)} [${p10}…${p90}]`;
}

/** Строит markdown-отчёт по кластерам. */
function buildPriorsMarkdown(clusters: PriorCluster[]): string {
  const lines: string[] = [];
  lines.push('# Приоры датасета (кластеры осцилляторов)');
  lines.push('');
  lines.push(
    `Воспроизводимых кластеров: ${clusters.length}. ` +
      'Формат ячеек: медиана [p10…p90].',
  );
  lines.push('');
  lines.push(
    '| Кластер | Членов | Таргетов | Покрытие сидов | freqBase Гц | freqStart/base | ampEnv с | decay −20 дБ с |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of clusters) {
    lines.push(
      `| ${c.id} | ${c.members} | ${c.targetsPresent.length} | ` +
        `${(c.seedCoverage * 100).toFixed(0)}% | ` +
        `${fmtDist(c.freqBaseHz, 1)} | ${fmtDist(c.freqStartToBase)} | ` +
        `${fmtDist(c.ampEnvDurationSec, 3)} | ${fmtDist(c.decayDb20Sec, 3)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Точка входа: грузит признаки, кластеризует, пишет приоры. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const datasetIdx = argv.indexOf('--dataset');
  const datasetArg =
    datasetIdx >= 0 ? argv[datasetIdx + 1] : undefined;
  if (datasetArg === undefined) {
    throw new Error('Usage: --dataset <dir> [--gap <log-fraction>]');
  }
  const gapIdx = argv.indexOf('--gap');
  const gapParsed =
    gapIdx >= 0 ? parseFloat(argv[gapIdx + 1] ?? '') : NaN;
  const gap = Number.isNaN(gapParsed) ? CLUSTER_GAP_LOG : gapParsed;
  const datasetDir = resolve(datasetArg);

  const all = await loadAllOscillators(datasetDir);
  console.log(`MINE loaded ${all.length} oscillators`);

  const totalSeedsPerTarget = new Map<string, number>();
  for (const osc of all) {
    const seen = new Set<number>();
    for (const other of all) {
      if (other.slug === osc.slug) {
        seen.add(other.seed);
      }
    }
    totalSeedsPerTarget.set(osc.slug, seen.size);
  }

  const clusters: PriorCluster[] = [];
  for (const role of ['sustain', 'transient'] as const) {
    const roleOscs = all.filter((o) => o.role === role);
    const groups = clusterByLogFreq(roleOscs, gap);
    let ordinal = 0;
    for (const group of groups) {
      if (group.length < MIN_MEMBERS) {
        continue;
      }
      const cluster = buildPriorCluster(
        role,
        ordinal,
        group,
        totalSeedsPerTarget,
      );
      if (cluster.seedCoverage < MIN_SEED_COVERAGE) {
        continue;
      }
      ordinal += 1;
      clusters.push(cluster);
    }
  }

  const bodyProfile = computeBodyProfile(all);
  const loudness = await computeLoudnessNorm(datasetDir);
  await writeJsonAtomic(join(datasetDir, 'priors.json'), {
    version: 1,
    createdFrom: {
      dataset: datasetDir,
      codeRevision: readCodeRevision(),
    },
    note: 'Кластеры уровня компонентов (по ролям). Семейства уровня таргетов появятся с ростом датасета.',
    bodyProfile,
    loudness: loudness === null ? undefined : { rms: loudness },
    clusters,
  });
  await writeTextAtomic(
    join(datasetDir, 'priors.md'),
    buildPriorsMarkdown(clusters),
  );
  console.log(
    `MINE ${clusters.length} reproducible clusters, priors written`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
