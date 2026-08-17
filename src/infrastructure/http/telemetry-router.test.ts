import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type ErrorRequestHandler } from 'express';

import { RequestError } from '../../domain/errors';
import type { TelemetryUpload } from '../../domain/telemetry';
import { createTelemetryRouter } from './telemetry-router';

test('accepts an authenticated dummy ESP32 telemetry upload', async () => {
  let upload: TelemetryUpload | undefined;
  const repository = {
    ingest: async (value: TelemetryUpload) => {
      upload = value;
      return { acknowledgedSequenceNumbers: [7], insertedCount: 1, duplicateCount: 0, receivedAt: '2026-08-17T00:01:00.000Z' };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/telemetry', createTelemetryRouter(repository, 'test-key'));
  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof RequestError) response.status(error.status).json({ error: error.message });
    else response.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);
  const server = app.listen(0);
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/telemetry`;

  try {
    const body = { sensorId: 'dummy-esp32', readings: [{ sequenceNumber: 7, measuredAt: '2026-08-17T00:00:00.000Z', temperatureC: 2.5 }] };
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: JSON.stringify(body) })).status, 401);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { acknowledgedSequenceNumbers: [7], insertedCount: 1, duplicateCount: 0, receivedAt: '2026-08-17T00:01:00.000Z' });
    assert.equal(upload?.sensorId, 'dummy-esp32');
    assert.equal(upload?.readings[0]?.measuredAt.toISOString(), body.readings[0]?.measuredAt);
  } finally {
    server.close();
  }
});
