import assert from 'node:assert/strict';
import test from 'node:test';

import { TelemetryBlocklist } from './telemetry-blocklist';

test('blocks and reconnects only the selected telemetry device', () => {
  const blocklist = new TelemetryBlocklist();

  blocklist.block('ESP32-1');
  assert.equal(blocklist.has('ESP32-1'), true);
  assert.equal(blocklist.has('ESP32-2'), false);

  blocklist.unblock('ESP32-1');
  assert.equal(blocklist.has('ESP32-1'), false);
});
