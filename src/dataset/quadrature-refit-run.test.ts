import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attackWeighting } from '../optimize/evaluate';
import { withAttackBoost } from './quadrature-refit-run';

test('attack boost applies inside the run and restores after success', async () => {
  const previous = attackWeighting.boost;
  const observed = await withAttackBoost(4, () => {
    return attackWeighting.boost;
  });
  assert.equal(observed, 4);
  assert.equal(attackWeighting.boost, previous);
});

test('attack boost restores after failure and rejects invalid values', async () => {
  const previous = attackWeighting.boost;
  await assert.rejects(
    withAttackBoost(8, () => {
      assert.equal(attackWeighting.boost, 8);
      throw new Error('known failure');
    }),
    /known failure/,
  );
  assert.equal(attackWeighting.boost, previous);
  await assert.rejects(
    withAttackBoost(-1, () => undefined),
    /attackBoost/,
  );
  assert.equal(attackWeighting.boost, previous);
});
