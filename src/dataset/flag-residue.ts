/**
 * Флажит осцилляторы, подозреваемые в моделировании остатков микса
 * (этап 2 плана `docs/plan-kick-enhancement.md`): автоматический
 * первый проход перед ручной чисткой.
 *
 * Правило-кандидат (по разведке BOg): осциллятор подозрителен, если
 * он стационарен (не затухает: RMS половин почти равны), сидит выше
 * тела (> 130 Гц) и попадает на ноту (±2% от ближайшего полутона).
 * Всё вместе — это признак «тонального чужого»; поодиночке каждый
 * признак законен (у бочки бывают и стационарные партиалы).
 *
 * Запуск:
 *   npx tsx src/dataset/flag-residue.ts --dataset datasets/reference-4
 *
 * Артефакты: residue-flags.json и residue-flags.md в каталоге
 * датасета; решения об отключении остаются за прослушиванием.
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type ArgCreateSynth } from '../synth';
import { calculateRMS } from '../rms';
import {
  readJsonOrNull,
  renderSamples,
  writeJsonAtomic,
  writeTextAtomic,
} from './shared';

/** Подозреваемый осциллятор одного прогона. */
interface ResidueFlag {
  slug: string;
  seed: number;
  oscIndex: number;
  freqHz: number;
  nearestNote: string;
  noteDistanceCents: number;
  halvesSpread: number;
  startLevel: number;
}

/** Порог стационарности: RMS первой половины к второй < этого. */
const STATIONARY_SPREAD = 1.6;
/** Низ тела живёт ниже; выше — кандидаты на чужое. */
const BODY_MAX_HZ = 130;
/** Близость к ноте в центах (1/100 полутона). */
const NOTE_CENTS = 60;

const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];

/** Находит ближайшую ноту частоте: имя и расстояние в центах. */
function nearestNote(freqHz: number): {
  name: string;
  cents: number;
} {
  const semis = 69 + 12 * Math.log2(freqHz / 440);
  const nearest = Math.round(semis);
  const cents = Math.abs(semis - nearest) * 100;
  const octave = Math.floor(nearest / 12) - 1;
  const name =
    (NOTE_NAMES[((nearest % 12) + 12) % 12] ?? '?') + octave;
  return { name, cents };
}

/**
 * Считает стационарность осциллятора: RMS первой половины к
 * второй на соло-рендере. Затухающий компонент даёт > 1.
 */
function halvesSpread(
  patch: ArgCreateSynth,
  oscIndex: number,
): number {
  const solo: ArgCreateSynth = {
    oscillators: patch.oscillators.map((g, i) => ({
      osc: { ...g.osc, on: i === oscIndex && g.osc.on },
      ampEnv: { ...g.ampEnv },
    })),
  };
  const samples = renderSamples(solo, 0.45);
  const half = Math.floor(samples.length / 2);
  const first = calculateRMS([...samples.slice(0, half)]);
  const second = calculateRMS([...samples.slice(half)]);
  return second > 0 ? first / second : 99;
}

/**
 * Проверяет один прогон: флажит осцилляторы по правилу-кандидату
 * и возвращает их список.
 */
async function flagRun(
  runDir: string,
  slug: string,
  seed: number,
): Promise<ResidueFlag[]> {
  const patch = await readJsonOrNull<ArgCreateSynth>(
    join(runDir, 'patch.json'),
  );
  if (patch === null) {
    return [];
  }
  const flags: ResidueFlag[] = [];
  patch.oscillators.forEach((group, index) => {
    const freq = group.osc.freqBase;
    if (!group.osc.on || freq <= BODY_MAX_HZ) {
      return;
    }
    const spread = halvesSpread(patch, index);
    if (spread >= STATIONARY_SPREAD) {
      return;
    }
    const note = nearestNote(freq);
    if (note.cents > NOTE_CENTS) {
      return;
    }
    flags.push({
      slug,
      seed,
      oscIndex: index,
      freqHz: Math.round(freq * 10) / 10,
      nearestNote: note.name,
      noteDistanceCents: Math.round(note.cents),
      halvesSpread: Math.round(spread * 100) / 100,
      startLevel: group.ampEnv.startLevel,
    });
  });
  return flags;
}

/** Строит markdown-таблицу флагов. */
function buildFlagsMarkdown(flags: ResidueFlag[]): string {
  const lines: string[] = [];
  lines.push('# Флаги остатков микса (кандидаты на ручную чистку)');
  lines.push('');
  lines.push(
    'Правило-кандидат: стационарен (RMS половин < 1.6), выше 130 Гц,',
  );
  lines.push(
    'попадает на ноту (±60 центов). Решения — за прослушиванием.',
  );
  lines.push('');
  lines.push(
    '| Таргет | Сид | Осц | Гц | Нота | Центы | Разброс | Уровень |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const f of flags) {
    lines.push(
      `| ${f.slug} | ${f.seed} | ${f.oscIndex} | ${f.freqHz} | ` +
        `${f.nearestNote} | ${f.noteDistanceCents} | ${f.halvesSpread} | ` +
        `${f.startLevel.toFixed(3)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Точка входа: обходит прогоны, пишет флаги. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--dataset');
  const datasetArg = idx >= 0 ? argv[idx + 1] : undefined;
  if (datasetArg === undefined) {
    throw new Error('Usage: --dataset <dir>');
  }
  const datasetDir = resolve(datasetArg);

  const flags: ResidueFlag[] = [];
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
      const seed = parseInt(seedDir.slice(5), 10);
      const runFlags = await flagRun(
        join(slugDir, seedDir),
        slug,
        seed,
      );
      flags.push(...runFlags);
    }
  }

  await writeJsonAtomic(
    join(datasetDir, 'residue-flags.json'),
    flags,
  );
  await writeTextAtomic(
    join(datasetDir, 'residue-flags.md'),
    buildFlagsMarkdown(flags),
  );
  console.log(`FLAGS ${flags.length} suspects across dataset`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
