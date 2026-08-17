import { Router } from 'express';

import { RequestError } from '../../domain/errors';

function telemetryReading(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be an object', 400);
  const input = body as Record<string, unknown>;
  const sensorId = typeof input.sensorId === 'string' ? input.sensorId.trim() : '';
  if (!sensorId || sensorId.length > 200) throw new RequestError('sensorId is required and must be at most 200 characters', 400);
  if (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature)) throw new RequestError('temperature must be a finite number', 400);
  if (!Number.isSafeInteger(input.sequenceNumber) || (input.sequenceNumber as number) < 0) throw new RequestError('sequenceNumber must be a non-negative integer', 400);
  return { sensorId, temperature: input.temperature, sequenceNumber: input.sequenceNumber as number };
}

export function createTelemetryRouter() {
  const router = Router();
  router.post('/', (request, response) => {
    const reading = telemetryReading(request.body);
    console.log('[telemetry] reading received', reading);
    response.json({ acknowledged: true, sensorId: reading.sensorId, sequenceNumber: reading.sequenceNumber });
  });
  return router;
}
