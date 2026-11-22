import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArgCreateSynth } from '../synth';
import { transferHighAttack } from './attack-transfer';

function group(
  on: boolean,
  freqBase: number,
  startLevel = 0.1,
  duration = 0.03,
): ArgCreateSynth['oscillators'][number] {
  return {
    osc: {
      on,
      freqBase,
      freqStart: freqBase,
      slope: 1,
      duration: 0.1,
      phase: 0,
    },
    ampEnv: {
      duration,
      endLevel: 0.001,
      slope: 2,
      startLevel,
    },
  };
}

test('high attack uses only free slots and excludes ringing impulses', () => {
  const patch = {
    oscillators: [
      group(true, 50, 0.8),
      group(false, 20),
      group(false, 20),
    ],
  };
  const attackPatch = {
    oscillators: [
      group(true, 5000, 0.1),
      group(true, 6000, 0.2),
      group(true, 7000, 0.9, 1 / 44100),
    ],
  };
  const before = JSON.stringify([patch, attackPatch]);
  const result = transferHighAttack({ patch, attackPatch });
  assert.equal(result.audit?.name, 'transferHighAttack');
  assert.equal(result.patch.oscillators[0]?.osc.freqBase, 50);
  assert.equal(result.patch.oscillators[0]?.ampEnv.startLevel, 0.8);
  assert.equal(result.patch.oscillators[1]?.osc.freqBase, 6000);
  assert.equal(result.patch.oscillators[2]?.osc.freqBase, 5000);
  assert.equal(result.patch.oscillators.length, 3);
  assert.equal(JSON.stringify([patch, attackPatch]), before);
});

test('no free slot or no eligible component leaves input untouched', () => {
  const occupied = { oscillators: [group(true, 50)] };
  const high = { oscillators: [group(true, 5000)] };
  const full = transferHighAttack({
    patch: occupied,
    attackPatch: high,
  });
  assert.equal(full.patch, occupied);
  assert.equal(full.audit, null);
  const empty = transferHighAttack({
    patch: { oscillators: [group(false, 20)] },
    attackPatch: {
      oscillators: [group(true, 5000, 0.1, 1 / 44100)],
    },
  });
  assert.equal(empty.audit, null);
  assert.equal(empty.patch.oscillators[0]?.osc.on, false);
});
