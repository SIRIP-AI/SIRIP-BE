import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestError } from '../../domain/errors';
import { parseTelemetryReadings } from './telemetry-router';

test('parses deterministic bulk telemetry and rejects readings beyond the fixed clock', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const reading = { sensorId: 'DEMO-SENSOR', deviceUid: 'demo:1', temperature: 2.5, sequenceNumber: 1, measuredAt: '2026-08-20T11:45:00.000Z' };
  const result = parseTelemetryReadings({ readings: [reading, { ...reading, sequenceNumber: 2 }] }, now);

  assert.equal(result.bulk, true);
  assert.deepEqual(result.readings.map(({ sequenceNumber }) => sequenceNumber), [1, 2]);
  assert.equal(result.readings[0]?.measuredAt.toISOString(), reading.measuredAt);
  assert.throws(
    () => parseTelemetryReadings({ ...reading, measuredAt: '2026-08-20T12:06:00.000Z' }, now),
    (error) => error instanceof RequestError && error.message === 'measuredAt cannot be more than 5 minutes in the future',
  );
});
