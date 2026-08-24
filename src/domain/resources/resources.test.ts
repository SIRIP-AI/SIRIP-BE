import assert from 'node:assert/strict';
import test from 'node:test';

import { connectivityStatus, sensorOfflineThresholdMs } from './resources';

test('derives syncing only for a recently communicating sensor with queued readings', () => {
  const now = new Date('2026-08-24T12:00:00Z');
  assert.equal(connectivityStatus({ status: 'ASSIGNED', lastSeenAt: now, pendingReadingCount: 3 }, now), 'SYNCING');
  assert.equal(connectivityStatus({ status: 'ASSIGNED', lastSeenAt: now, pendingReadingCount: 0 }, now), 'ONLINE');
  assert.equal(connectivityStatus({ status: 'ASSIGNED', lastSeenAt: new Date(now.getTime() - sensorOfflineThresholdMs - 1), pendingReadingCount: 3 }, now), 'OFFLINE');
});
