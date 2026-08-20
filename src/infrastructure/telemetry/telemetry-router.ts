import { timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';

import { RequestError } from '../../domain/errors';
import type { TelemetryInput, TelemetryRepository } from './telemetry-repository';

const isoDateTime = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const authenticate: RequestHandler = (request, _response, next) => {
  const expected = process.env.SENSOR_API_KEY;
  if (!expected) throw new RequestError('Sensor authentication is unavailable', 503);
  const provided = request.headers['x-sensor-api-key'];
  if (typeof provided !== 'string') throw new RequestError('Invalid sensor API key', 401);
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes) || expected !== provided) throw new RequestError('Invalid sensor API key', 401);
  next();
};

function telemetryReading(body: unknown, now: number): TelemetryInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Each reading must be an object', 400);
  const input = body as Record<string, unknown>;
  const sensorId = typeof input.sensorId === 'string' ? input.sensorId.trim() : '';
  const deviceUid = typeof input.deviceUid === 'string' ? input.deviceUid.trim() : '';
  if (!sensorId || sensorId.length > 200) throw new RequestError('sensorId is required and must be at most 200 characters', 400);
  if (!deviceUid || deviceUid.length > 200) throw new RequestError('deviceUid is required and must be at most 200 characters', 400);
  if (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) || input.temperature < -50 || input.temperature > 100) throw new RequestError('temperature must be a finite number between -50 and 100', 400);
  if (!Number.isSafeInteger(input.sequenceNumber) || (input.sequenceNumber as number) < 0) throw new RequestError('sequenceNumber must be a non-negative safe integer', 400);
  if (typeof input.measuredAt !== 'string') throw new RequestError('measuredAt must be an ISO datetime with an explicit timezone', 400);
  const match = isoDateTime.exec(input.measuredAt);
  const measuredAtMs = Date.parse(input.measuredAt);
  if (!match || !Number.isFinite(measuredAtMs)) throw new RequestError('measuredAt must be an ISO datetime with an explicit timezone', 400);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth) throw new RequestError('measuredAt must be a valid ISO datetime', 400);
  if (measuredAtMs > now + 5 * 60_000) throw new RequestError('measuredAt cannot be more than 5 minutes in the future', 400);
  return { sensorId, deviceUid, temperature: input.temperature, sequenceNumber: input.sequenceNumber as number, measuredAt: new Date(measuredAtMs) };
}

export function parseTelemetryReadings(body: unknown, now = Date.now()) {
  const bulk = Array.isArray(body) || !!body && typeof body === 'object' && !Array.isArray(body) && 'readings' in body;
  const values = Array.isArray(body) ? body : bulk ? (body as Record<string, unknown>).readings : [body];
  if (!Array.isArray(values)) throw new RequestError('readings must be an array', 400);
  if (!values.length || values.length > 500) throw new RequestError('Telemetry requests must contain between 1 and 500 readings', 400);
  const readings = values.map((value) => telemetryReading(value, now));
  const first = readings[0]!;
  if (readings.some((reading) => reading.sensorId !== first.sensorId || reading.deviceUid !== first.deviceUid)) throw new RequestError('All readings must target the same sensor', 400);
  return { bulk, readings };
}

export function createTelemetryRouter(repository: Pick<TelemetryRepository, 'ingestMany'>) {
  const router = Router();
  router.use(authenticate);
  router.post('/', async (request, response) => {
    const { bulk, readings } = parseTelemetryReadings(request.body);
    await repository.ingestMany(readings);
    if (!bulk) {
      const reading = readings[0]!;
      response.json({ acknowledged: true, sensorId: reading.sensorId, sequenceNumber: reading.sequenceNumber });
      return;
    }
    response.json({ acknowledged: true, readings: readings.map(({ sensorId, sequenceNumber }) => ({ acknowledged: true, sensorId, sequenceNumber })) });
  });
  return router;
}
