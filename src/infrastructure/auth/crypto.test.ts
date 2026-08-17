import assert from 'node:assert/strict';
import test from 'node:test';

import { hashPassword, verifyPassword } from './crypto';

test('hashes and verifies passwords', async () => {
  const passwordHash = await hashPassword('demo-password');
  assert.equal(await verifyPassword('demo-password', passwordHash), true);
  assert.equal(await verifyPassword('wrong-password', passwordHash), false);
});
