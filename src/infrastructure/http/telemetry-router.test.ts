import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type ErrorRequestHandler } from 'express';

import { RequestError } from '../../domain/errors';
import { createTelemetryRouter } from './telemetry-router';

test('accepts and validates an ESP32 telemetry reading', async (context) => {
  const log = context.mock.method(console, 'log', () => undefined);
  const app = express();
  app.use(express.json());
  app.use('/telemetry', createTelemetryRouter());
  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof RequestError) response.status(error.status).json({ error: error.message });
    else response.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);
  const server = app.listen(0);
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/telemetry`;

  try {
    const body = { sensorId: ' S-001 ', temperature: 2.8, sequenceNumber: 1 };
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { acknowledged: true, sensorId: 'S-001', sequenceNumber: 1 });
    assert.deepEqual(log.mock.calls[0]?.arguments, ['[telemetry] reading received', { sensorId: 'S-001', temperature: 2.8, sequenceNumber: 1 }]);

    for (const invalidBody of [
      { temperature: 2.8, sequenceNumber: 1 },
      { sensorId: 'S-001', temperature: '2.8', sequenceNumber: 1 },
      { sensorId: 'S-001', temperature: 2.8, sequenceNumber: -1 },
    ]) {
      const invalidResponse = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(invalidBody) });
      assert.equal(invalidResponse.status, 400);
    }
  } finally {
    server.close();
  }
});
