import assert from 'node:assert/strict';
import test from 'node:test';

import { isUnsafeSeedSession } from './seed-baseline';

test('seed reset only accepts sessions wholly owned by the target account', () => {
  const userId = 7n;
  assert.equal(isUnsafeSeedSession(userId, { sensor: { userId }, batch: { userId } }), false);
  assert.equal(isUnsafeSeedSession(userId, { sensor: { userId: 8n }, batch: { userId } }), true);
  assert.equal(isUnsafeSeedSession(userId, { sensor: { userId }, batch: { userId: 8n } }), true);
  assert.equal(isUnsafeSeedSession(userId, { sensor: { userId: null }, batch: { userId } }), true);
});
