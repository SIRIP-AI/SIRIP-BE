import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';

import { ConflictError, RequestError } from '../../domain/errors';
import { TelemetryBlocklist } from '../demo/telemetry-blocklist';
import { createTelemetryRouter, parseTelemetryReadings } from './telemetry-router';

test('parses deterministic bulk telemetry and rejects readings beyond the fixed clock', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const reading = { sensorId: 'DEMO-SENSOR', deviceUid: 'demo:1', temperature: 2.5, sequenceNumber: 1, measuredAt: '2026-08-20T11:45:00.000Z' };
  const result = parseTelemetryReadings({ readings: [reading, { ...reading, sequenceNumber: 2 }] }, now);

  assert.equal(result.bulk, true);
  assert.deepEqual(result.readings.map(({ sequenceNumber }) => sequenceNumber), [1, 2]);
  assert.equal(result.readings[0]?.measuredAt.toISOString(), reading.measuredAt);
  assert.throws(
    () => parseTelemetryReadings({ ...reading, measuredAt: '2026-08-20T12:06:00.000Z' }, now),
    (error) => error instanceof RequestError && error.message === 'measuredAt tidak boleh lebih dari 5 menit di masa depan',
  );
});

test('derives and validates stable reading identity and synchronization backlog', () => {
  const body = { sensorId: 'S-001', deviceUid: 'ESP32-1', temperature: 2, sequenceNumber: 7, readingUid: 'ESP32-1:7', measuredAt: '2026-08-20T11:45:00Z', syncRemaining: 3 };
  const parsed = parseTelemetryReadings(body, Date.parse('2026-08-20T12:00:00Z')).readings[0];
  assert.equal(parsed?.readingUid, body.readingUid);
  assert.equal(parsed?.syncRemaining, 3);
  assert.throws(() => parseTelemetryReadings({ ...body, readingUid: 'other:7' }), (error) => error instanceof RequestError && error.status === 400);
  assert.throws(() => parseTelemetryReadings({ ...body, syncRemaining: -1 }), (error) => error instanceof RequestError && error.status === 400);
});

test('identifies a permanently rejected reading with a stable error code', () => {
  const error = new ConflictError('Pembacaan ESP32-1:7 tidak termasuk dalam sesi penugasan sensor', 'READING_OUTSIDE_SENSOR_SESSION');

  assert.equal(error.status, 409);
  assert.equal(error.code, 'READING_OUTSIDE_SENSOR_SESSION');
});

test('drops blocked device connections before telemetry ingestion', async () => {
  const ingested: string[] = [];
  const blocklist = new TelemetryBlocklist();
  blocklist.block('ESP32-1');
  const app = express().use(express.json()).use(createTelemetryRouter({ ingestMany: async (readings) => { ingested.push(readings[0]!.deviceUid); } }, blocklist));
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const body = { sensorId: 'S-001', deviceUid: 'ESP32-1', temperature: 2, sequenceNumber: 7, measuredAt: new Date().toISOString() };

  try {
    await assert.rejects(fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    assert.deepEqual(ingested, []);

    blocklist.unblock('ESP32-1');
    const response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.deepEqual(ingested, ['ESP32-1']);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
