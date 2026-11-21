/**
 * Тесты движка улучшения (режим A): анкерные параметры не двигаются,
 * свободные тянутся к приорам на величину силы, слой атаки
 * достраивается только при достаточной силе.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ArgCreateSynth } from '../synth';
import {
  enhancePatch,
  type IdentifiabilityMap,
  type PriorsFile,
} from './engine';

/** Собирает минимальный патч: один саб + один короткий пик. */
function makePatch(): ArgCreateSynth {
  return {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 50,
          freqStart: 200,
          slope: 0.8,
          duration: 0.25,
          phase: 1,
        },
        ampEnv: {
          duration: 0.2,
          endLevel: 0.5,
          slope: 0.8,
          startLevel: 0.3,
        },
      },
      {
        osc: {
          on: false,
          freqBase: 3000,
          freqStart: 3000,
          slope: 2,
          duration: 0.04,
          phase: 0,
        },
        ampEnv: {
          duration: 0.04,
          endLevel: 0.001,
          slope: 2,
          startLevel: 0.1,
        },
      },
    ],
  };
}

/** Карта идентифицируемости по мотивам BOg: частоты анкерные, огибающие свободные, endLevel залип на init. */
function makeMap(): IdentifiabilityMap {
  return {
    version: 1,
    params: {
      freqBase: { verdict: 'anchored' },
      freqStart: { verdict: 'anchored' },
      ampEnvDuration: { verdict: 'free' },
      startLevel: { verdict: 'free' },
      endLevel: { verdict: 'prior-owned' },
      phase: { verdict: 'free' },
    },
  };
}

/** Приоры с одним sustain-кластером около 50 Гц и одним transient. */
function makePriors(): PriorsFile {
  return {
    version: 1,
    clusters: [
      {
        id: 'sustain-00',
        role: 'sustain',
        freqBaseHz: { median: 50, p10: 45, p90: 60 },
        ampEnvDurationSec: { median: 0.4, p10: 0.3, p90: 0.5 },
        ampStartLevel: { median: 0.6, p10: 0.5, p90: 0.7 },
        ampEndLevel: { median: 0.001, p10: 0.001, p90: 0.001 },
      },
      {
        id: 'transient-00',
        role: 'transient',
        freqBaseHz: { median: 3000, p10: 2000, p90: 4000 },
        ampEnvDurationSec: { median: 0.03, p10: 0.02, p90: 0.04 },
        ampStartLevel: { median: 0.2, p10: 0.15, p90: 0.25 },
        ampEndLevel: { median: 0.001, p10: 0.001, p90: 0.001 },
      },
    ],
  };
}

test('strength 0 returns the patch untouched', () => {
  const patch = makePatch();
  const result = enhancePatch({
    patch,
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 0,
  });
  assert.equal(result.patch, patch);
  assert.equal(result.audits.length, 0);
});

test('anchored parameters stay put at full strength', () => {
  const result = enhancePatch({
    patch: makePatch(),
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 1,
  });
  const osc = result.patch.oscillators[0];
  assert.equal(osc?.osc.freqBase, 50);
  assert.equal(osc?.osc.freqStart, 200);
});

test('prior-owned endLevel moves fully to the prior at strength 1', () => {
  const result = enhancePatch({
    patch: makePatch(),
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 1,
  });
  const osc = result.patch.oscillators[0];
  assert.ok(Math.abs((osc?.ampEnv.endLevel ?? 0) - 0.001) < 1e-9);
});

test('free envelope extends toward the prior but never shortens', () => {
  const result = enhancePatch({
    patch: makePatch(),
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 1,
  });
  const osc = result.patch.oscillators[0];
  assert.ok(
    Math.abs((osc?.ampEnv.duration ?? 0) - 0.4) < 1e-9,
    `duration should reach the prior 0.4, got ${osc?.ampEnv.duration}`,
  );
});

test('missing click layer is added only at sufficient strength', () => {
  const weak = enhancePatch({
    patch: makePatch(),
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 0.3,
  });
  assert.equal(
    weak.patch.oscillators[1]?.osc.on,
    false,
    'at 0.3 the click must not appear',
  );
  const strong = enhancePatch({
    patch: makePatch(),
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 1,
  });
  assert.equal(
    strong.patch.oscillators[1]?.osc.on,
    true,
    'at 1.0 the click must appear',
  );
  assert.equal(strong.patch.oscillators[1]?.osc.freqBase, 3000);
});

test('full patch: the weakest inaudible yields its slot to the click', () => {
  const patch = makePatch();
  // Занимаем все слоты: включаем второй осциллятор неслышимо тихим.
  const second = patch.oscillators[1];
  if (second !== undefined) {
    second.osc.on = true;
    second.ampEnv.startLevel = 0.005;
  }
  const result = enhancePatch({
    patch,
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 1,
  });
  const names = result.audits.map((a) => a.name);
  assert.ok(names.includes('removeOscillator'));
  assert.ok(names.includes('addTransientClick'));
});

test('full patch with only audible oscillators is not displaced', () => {
  const patch = makePatch();
  const second = patch.oscillators[1];
  if (second !== undefined) {
    second.osc.on = true;
    second.osc.freqBase = 2000;
    second.ampEnv.startLevel = 0.5;
    second.ampEnv.duration = 0.03;
  }
  const result = enhancePatch({
    patch,
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 1,
  });
  const names = result.audits.map((a) => a.name);
  assert.ok(!names.includes('removeOscillator'));
});

test('primitive body gains 2f and 3f harmonics at full strength', () => {
  const patch = makePatch();
  // Второй осциллятор — слышимый transient, чтобы click не
  // занимал слоты; осцилляторы 2 и 3 свободны для гармоник.
  const second = patch.oscillators[1];
  if (second !== undefined) {
    second.osc.on = true;
    second.ampEnv.startLevel = 0.4;
  }
  patch.oscillators.push(
    {
      osc: {
        on: false,
        freqBase: 100,
        freqStart: 100,
        slope: 1,
        duration: 0.1,
        phase: 0,
      },
      ampEnv: {
        duration: 0.1,
        endLevel: 0.001,
        slope: 1,
        startLevel: 0.01,
      },
    },
    {
      osc: {
        on: false,
        freqBase: 100,
        freqStart: 100,
        slope: 1,
        duration: 0.1,
        phase: 0,
      },
      ampEnv: {
        duration: 0.1,
        endLevel: 0.001,
        slope: 1,
        startLevel: 0.01,
      },
    },
  );
  // Усиление фундаменталки перед обогащением меняло бы уровни
  // гармоник: для проверки формул обогащения замораживаем уровень.
  const map = makeMap();
  map.params['startLevel'] = { verdict: 'anchored' };
  const result = enhancePatch({
    patch,
    identifiability: map,
    priors: makePriors(),
    strength: 1,
  });
  const enriched = result.patch.oscillators.filter(
    (g) =>
      g.osc.on &&
      (Math.abs(g.osc.freqBase - 100) < 1e-9 ||
        Math.abs(g.osc.freqBase - 150) < 1e-9),
  );
  assert.equal(enriched.length, 2);
  assert.ok(
    Math.abs((enriched[0]?.ampEnv.startLevel ?? 0) - 0.105) < 1e-9,
    `2f level ${enriched[0]?.ampEnv.startLevel}`,
  );
  assert.ok(
    Math.abs((enriched[1]?.ampEnv.startLevel ?? 0) - 0.054) < 1e-9,
    `3f level ${enriched[1]?.ampEnv.startLevel}`,
  );
});

test('enrichment follows the dataset body profile when present', () => {
  const patch = makePatch();
  // Слышимый transient, чтобы click не занял слот; слот под партиал свободен.
  const second = patch.oscillators[1];
  if (second !== undefined) {
    second.osc.on = true;
    second.ampEnv.startLevel = 0.4;
  }
  patch.oscillators.push({
    osc: {
      on: false,
      freqBase: 100,
      freqStart: 100,
      slope: 1,
      duration: 0.1,
      phase: 0,
    },
    ampEnv: {
      duration: 0.1,
      endLevel: 0.001,
      slope: 1,
      startLevel: 0.01,
    },
  });
  const priors = makePriors();
  priors.bodyProfile = [
    {
      rank: 1,
      runs: 16,
      freqRatio: { median: 1.85, p10: 1.6, p90: 2.1 },
      levelRatio: { median: 0.7, p10: 0.5, p90: 0.9 },
      durRatio: { median: 0.9, p10: 0.8, p90: 1.0 },
    },
  ];
  // Замораживаем уровень фундаменталки, чтобы проверять формулы
  // профиля, а не игру усиления с обогащением.
  const map = makeMap();
  map.params['startLevel'] = { verdict: 'anchored' };
  const result = enhancePatch({
    patch,
    identifiability: map,
    priors,
    strength: 1,
  });
  const partial = result.patch.oscillators.find(
    (g) => g.osc.on && Math.abs(g.osc.freqBase - 50 * 1.85) < 1e-9,
  );
  assert.ok(partial !== undefined, 'partial at 1.85x must exist');
  assert.ok(
    Math.abs((partial?.ampEnv.startLevel ?? 0) - 0.3 * 0.7) < 1e-9,
    `partial level ${partial?.ampEnv.startLevel}`,
  );
});

test('an oscillator is claimed by at most one profile slot', () => {
  const patch = makePatch();
  const second = patch.oscillators[1];
  if (second !== undefined) {
    second.osc.on = true;
    second.osc.freqBase = 118;
    second.ampEnv.startLevel = 0.1;
    second.ampEnv.duration = 0.2;
  }
  const priors = makePriors();
  priors.bodyProfile = [
    {
      rank: 1,
      runs: 16,
      freqRatio: { median: 2.2, p10: 2.0, p90: 2.4 },
      levelRatio: { median: 1.0, p10: 0.8, p90: 1.2 },
      durRatio: { median: 0.9, p10: 0.8, p90: 1.0 },
    },
    {
      rank: 2,
      runs: 16,
      freqRatio: { median: 2.4, p10: 2.2, p90: 2.6 },
      levelRatio: { median: 1.0, p10: 0.8, p90: 1.2 },
      durRatio: { median: 0.9, p10: 0.8, p90: 1.0 },
    },
  ];
  const map = makeMap();
  map.params['startLevel'] = { verdict: 'anchored' };
  const result = enhancePatch({
    patch,
    identifiability: map,
    priors,
    strength: 1,
  });
  const boosts = result.audits.filter(
    (a) => a.name === 'boostOscillator',
  );
  assert.equal(boosts.length, 1, 'one boost, not two');
  const second2 = result.patch.oscillators[1];
  assert.ok(
    Math.abs((second2?.ampEnv.startLevel ?? 0) - 0.3) < 1e-9,
    `single boost reaches the target 0.3, got ${second2?.ampEnv.startLevel}`,
  );
});

test('quiet patch is pulled toward the family loudness norm', () => {
  const patch = makePatch();
  const priors = makePriors();
  priors.loudness = { rms: { median: 0.25, p10: 0.2, p90: 0.3 } };
  const map = makeMap();
  map.params['startLevel'] = { verdict: 'anchored' };
  const result = enhancePatch({
    patch,
    identifiability: map,
    priors,
    strength: 1,
  });
  const names = result.audits.map((a) => a.name);
  assert.ok(names.includes('scaleLevels'), 'loudness must scale');
  const osc = result.patch.oscillators[0];
  assert.ok(
    (osc?.ampEnv.startLevel ?? 0) > 0.3,
    `level should rise above 0.3, got ${osc?.ampEnv.startLevel}`,
  );
});

test('signature adoption adds the whole archetype jointly', () => {
  const patch = makePatch();
  // Слышимый transient, чтобы click не занял слот; два свободных.
  const second = patch.oscillators[1];
  if (second !== undefined) {
    second.osc.on = true;
    second.ampEnv.startLevel = 0.4;
  }
  patch.oscillators.push(
    {
      osc: {
        on: false,
        freqBase: 100,
        freqStart: 100,
        slope: 1,
        duration: 0.1,
        phase: 0,
      },
      ampEnv: {
        duration: 0.1,
        endLevel: 0.001,
        slope: 1,
        startLevel: 0.01,
      },
    },
    {
      osc: {
        on: false,
        freqBase: 100,
        freqStart: 100,
        slope: 1,
        duration: 0.1,
        phase: 0,
      },
      ampEnv: {
        duration: 0.1,
        endLevel: 0.001,
        slope: 1,
        startLevel: 0.01,
      },
    },
  );
  const priors = makePriors();
  priors.bodySignatures = [
    {
      slug: 'archetype-a',
      fundamentalHz: 50,
      partials: [
        { ratio: 1.43, level: 0.9, dur: 0.26, sweep: 1.34 },
        { ratio: 2.04, level: 0.58, dur: 0.34, sweep: 1.22 },
      ],
    },
  ];
  const map = makeMap();
  map.params['startLevel'] = { verdict: 'anchored' };
  const result = enhancePatch({
    patch,
    identifiability: map,
    priors,
    strength: 1,
  });
  const added = result.patch.oscillators.filter(
    (g) =>
      g.osc.on &&
      (Math.abs(g.osc.freqBase - 71.5) < 1e-6 ||
        Math.abs(g.osc.freqBase - 102) < 1e-6),
  );
  assert.equal(added.length, 2, 'both signature partials added');
  const first = added[0];
  assert.ok(Math.abs((first?.osc.freqBase ?? 0) - 71.5) < 1e-6);
  assert.ok(
    Math.abs((first?.osc.freqStart ?? 0) - 71.5 * 1.34) < 1e-6,
    `partial sweep from signature, got ${first?.osc.freqStart}`,
  );
});

test('a body with covered profile slots is not enriched', () => {
  const patch = makePatch();
  // Тело уже покрывает оба слота умолчания (2f=100, 3f=150)
  // громкими партиалами — обогащению нечего делать.
  const second = patch.oscillators[1];
  if (second !== undefined) {
    second.osc.on = true;
    second.osc.freqBase = 100;
    second.ampEnv.startLevel = 0.4;
    second.ampEnv.duration = 0.2;
  }
  patch.oscillators.push({
    osc: {
      on: true,
      freqBase: 150,
      freqStart: 150,
      slope: 1,
      duration: 0.2,
      phase: 0,
    },
    ampEnv: {
      duration: 0.2,
      endLevel: 0.001,
      slope: 1,
      startLevel: 0.4,
    },
  });
  const result = enhancePatch({
    patch,
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 1,
  });
  const names = result.audits.map((a) => a.name);
  assert.ok(!names.includes('enrichBody'));
});

test('anchored endLevel is not moved', () => {
  const map = makeMap();
  map.params['endLevel'] = { verdict: 'anchored' };
  const result = enhancePatch({
    patch: makePatch(),
    identifiability: map,
    priors: makePriors(),
    strength: 1,
  });
  const osc = result.patch.oscillators[0];
  assert.equal(osc?.ampEnv.endLevel, 0.5);
});

test('input patch is never mutated', () => {
  const patch = makePatch();
  const snapshot = JSON.stringify(patch);
  enhancePatch({
    patch,
    identifiability: makeMap(),
    priors: makePriors(),
    strength: 1,
  });
  assert.equal(JSON.stringify(patch), snapshot);
});
