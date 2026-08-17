import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { RequestError } from '../../domain/errors';
import type { TelemetryReading, TelemetryUpload } from '../../domain/telemetry';
import type { TelemetryRepository } from '../persistence/telemetry-repository';

function bodyObject(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be an object', 400);
  return body as Record<string, unknown>;
}

function reading(value: unknown, index: number): TelemetryReading {
  const input = bodyObject(value);
  if (!Number.isSafeInteger(input.sequenceNumber) || (input.sequenceNumber as number) < 0) throw new RequestError(`readings[${index}].sequenceNumber must be a non-negative integer`, 400);
  if (typeof input.temperatureC !== 'number' || !Number.isFinite(input.temperatureC) || input.temperatureC < -100 || input.temperatureC > 100) throw new RequestError(`readings[${index}].temperatureC must be between -100 and 100`, 400);
  if (typeof input.measuredAt !== 'string') throw new RequestError(`readings[${index}].measuredAt must be a valid timestamp`, 400);
  const measuredAt = new Date(input.measuredAt);
  if (Number.isNaN(measuredAt.getTime())) throw new RequestError(`readings[${index}].measuredAt must be a valid timestamp`, 400);
  return { sequenceNumber: input.sequenceNumber as number, temperatureC: input.temperatureC, measuredAt };
}

function upload(body: unknown): TelemetryUpload {
  const input = bodyObject(body);
  const sensorId = typeof input.sensorId === 'string' ? input.sensorId.trim() : '';
  if (!sensorId || sensorId.length > 200) throw new RequestError('sensorId is required and must be at most 200 characters', 400);
  if (!Array.isArray(input.readings) || !input.readings.length || input.readings.length > 1000) throw new RequestError('readings must contain between 1 and 1000 readings', 400);
  const readings = input.readings.map(reading);
  if (new Set(readings.map(({ sequenceNumber }) => sequenceNumber)).size !== readings.length) throw new RequestError('readings must have unique sequence numbers', 400);
  return { sensorId, readings };
}

function authenticated(authorization: string | undefined, apiKey: string | undefined) {
  if (!apiKey || !authorization?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(apiKey);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createTelemetryRouter(repository: Pick<TelemetryRepository, 'ingest'>, apiKey = process.env.SENSOR_API_KEY) {
  const router = Router();
  router.post('/', async (request, response) => {
    if (!authenticated(request.headers.authorization, apiKey)) throw new RequestError('Sensor authentication failed', 401);
    response.json(await repository.ingest(upload(request.body)));
  });
  return router;
}
