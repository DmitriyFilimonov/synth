import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SAMPLE_RATE } from './consts';
import { renderSamples } from './dataset/shared';
import { synthPreset1 } from './presets';
import type { ArgCreateSynth, PhaseModel } from './synth';
import {
  mapSynthConfigToVector,
  mapSynthConfigToVectorWithFixedDelays,
} from './synth-config-to-vector';

function localizedTone(hardStop = true): ArgCreateSynth {
  return {
    oscillators: [
      {
        osc: {
          on: true,
          freqBase: 6000,
          freqStart: 9000,
          duration: 0.03,
          slope: 1.2,
          phase: 0.7,
          delay: 221 / SAMPLE_RATE,
        },
        ampEnv: {
          startLevel: 0.3,
          endLevel: 0.5,
          duration: 100 / SAMPLE_RATE,
          slope: 2,
          attack: 22 / SAMPLE_RATE,
          hardStop,
        },
      },
    ],
  };
}

function withExplicitDefaults(patch: ArgCreateSynth): ArgCreateSynth {
  return {
    oscillators: patch.oscillators.map((group) => ({
      osc: { ...group.osc },
      ampEnv: {
        ...group.ampEnv,
        attack: 0,
        hardStop: false,
      },
    })),
  };
}

test('missing, zero attack and false hardStop preserve both phase models', () => {
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const original = renderSamples(synthPreset1, 0.2, { phaseModel });
    const explicit = renderSamples(
      withExplicitDefaults(synthPreset1),
      0.2,
      { phaseModel },
    );
    assert.deepEqual(explicit, original);
  }
});

test('default PCM keeps pre-refactor known-answer hashes in both phases', () => {
  const expected = {
    legacy:
      'e1616a33ff5b73c348336377ef75ac53208a5e1722ea5de55d36c6b031e21005',
    integral:
      '1b1a825a219672d8b2011596c9f6011ba77e832fae1b475561a18f2a9c912819',
  } as const;
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const pcm = renderSamples(synthPreset1, 0.2, { phaseModel });
    const digest = createHash('sha256')
      .update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
      .digest('hex');
    assert.equal(digest, expected[phaseModel]);
  }
});

test('onset 221, attack 22 and exact support end bound the localized tone', () => {
  for (const phaseModel of ['legacy', 'integral'] as PhaseModel[]) {
    const stopped = renderSamples(localizedTone(true), 0.012, {
      phaseModel,
    });
    const tail = renderSamples(localizedTone(false), 0.012, {
      phaseModel,
    });
    const supportEnd = 221 + 22 + 100;
    assert.ok(stopped.slice(0, 221).every((value) => value === 0));
    assert.ok(
      stopped.slice(222, supportEnd).some((value) => value !== 0),
    );
    assert.equal(stopped[supportEnd], 0);
    assert.ok(
      stopped.slice(supportEnd).every((value) => value === 0),
    );
    assert.deepEqual(
      stopped.slice(0, supportEnd),
      tail.slice(0, supportEnd),
    );
    assert.ok(
      tail.slice(supportEnd + 1).some((value) => value !== 0),
    );
  }
});

test('invalid localized amplitude fields fail instead of corrupting decay', () => {
  for (const attack of [-1 / SAMPLE_RATE, Number.NaN, 0.501]) {
    const patch = localizedTone();
    const group = patch.oscillators[0];
    assert.ok(group);
    group.ampEnv.attack = attack;
    assert.throws(
      () => renderSamples(patch, 0.01),
      /Attack must be finite/,
    );
  }
  const invalidStop = localizedTone();
  const group = invalidStop.oscillators[0];
  assert.ok(group);
  group.ampEnv.hardStop = 1 as unknown as boolean;
  assert.throws(() => renderSamples(invalidStop, 0.01), /HardStop/);
  const zeroEnd = localizedTone();
  assert.ok(zeroEnd.oscillators[0]);
  zeroEnd.oscillators[0].ampEnv.endLevel = 0;
  assert.throws(
    () => renderSamples(zeroEnd, 0.01),
    /Должно быть > 0/,
  );
});

test('vector and fixed-delay extraction reject active and future-on localized fields', () => {
  for (const on of [true, false]) {
    for (const localized of ['attack', 'hardStop'] as const) {
      const patch = localizedTone();
      const group = patch.oscillators[0];
      assert.ok(group);
      group.osc.on = on;
      group.osc.delay = 0;
      if (localized === 'attack') {
        group.ampEnv.hardStop = false;
      } else {
        group.ampEnv.attack = 0;
      }
      assert.throws(
        () => mapSynthConfigToVector(patch),
        /Localized amplitude patches/,
      );
      assert.throws(
        () => mapSynthConfigToVectorWithFixedDelays(patch),
        /Localized amplitude patches/,
      );
    }
  }
  const patch = localizedTone();
  const group = patch.oscillators[0];
  assert.ok(group);
  group.osc.delay = 0;
  group.ampEnv.attack = 0;
  group.ampEnv.hardStop = false;
  assert.equal(mapSynthConfigToVector(patch).length, 10);
  assert.deepEqual(
    mapSynthConfigToVectorWithFixedDelays(patch).fixedDelaySeconds,
    [0],
  );
});
