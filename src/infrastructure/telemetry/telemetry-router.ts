import { Router } from 'express';

import { RequestError } from '../../domain/errors';
import type { TelemetryBlocklist } from '../demo/telemetry-blocklist';
import type { TelemetryInput, TelemetryRepository } from './telemetry-repository';

const isoDateTime = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function telemetryReading(body: unknown, now: number): TelemetryInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Setiap pembacaan harus berupa objek', 400);
  const input = body as Record<string, unknown>;
  const sensorId = typeof input.sensorId === 'string' ? input.sensorId.trim() : '';
  const deviceUid = typeof input.deviceUid === 'string' ? input.deviceUid.trim() : '';
  if (!sensorId || sensorId.length > 200) throw new RequestError('sensorId wajib diisi dan maksimal 200 karakter', 400);
  if (!deviceUid || deviceUid.length > 200) throw new RequestError('deviceUid wajib diisi dan maksimal 200 karakter', 400);
  if (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) || input.temperature < -50 || input.temperature > 100) throw new RequestError('temperature harus berupa angka terhingga antara -50 dan 100', 400);
  if (!Number.isSafeInteger(input.sequenceNumber) || (input.sequenceNumber as number) < 0) throw new RequestError('sequenceNumber harus berupa bilangan bulat aman yang tidak negatif', 400);
  const readingUid = `${deviceUid}:${input.sequenceNumber}`;
  if (input.readingUid !== undefined && input.readingUid !== readingUid) throw new RequestError('readingUid harus sesuai dengan deviceUid dan sequenceNumber', 400);
  if (input.syncRemaining !== undefined && (!Number.isSafeInteger(input.syncRemaining) || (input.syncRemaining as number) < 0)) throw new RequestError('syncRemaining harus berupa bilangan bulat aman yang tidak negatif', 400);
  if (typeof input.measuredAt !== 'string') throw new RequestError('measuredAt harus berupa datetime ISO dengan zona waktu eksplisit', 400);
  const match = isoDateTime.exec(input.measuredAt);
  const measuredAtMs = Date.parse(input.measuredAt);
  if (!match || !Number.isFinite(measuredAtMs)) throw new RequestError('measuredAt harus berupa datetime ISO dengan zona waktu eksplisit', 400);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth) throw new RequestError('measuredAt harus berupa datetime ISO yang valid', 400);
  if (measuredAtMs > now + 5 * 60_000) throw new RequestError('measuredAt tidak boleh lebih dari 5 menit di masa depan', 400);
  return { sensorId, deviceUid, temperature: input.temperature, sequenceNumber: input.sequenceNumber as number, readingUid, measuredAt: new Date(measuredAtMs), syncRemaining: input.syncRemaining as number | undefined ?? 0 };
}

export function parseTelemetryReadings(body: unknown, now = Date.now()) {
  const bulk = Array.isArray(body) || !!body && typeof body === 'object' && !Array.isArray(body) && 'readings' in body;
  const values = Array.isArray(body) ? body : bulk ? (body as Record<string, unknown>).readings : [body];
  if (!Array.isArray(values)) throw new RequestError('readings harus berupa array', 400);
  if (!values.length || values.length > 500) throw new RequestError('Permintaan telemetri harus berisi antara 1 dan 500 pembacaan', 400);
  const readings = values.map((value) => telemetryReading(value, now));
  const first = readings[0]!;
  if (readings.some((reading) => reading.sensorId !== first.sensorId || reading.deviceUid !== first.deviceUid)) throw new RequestError('Semua pembacaan harus ditujukan ke sensor yang sama', 400);
  return { bulk, readings };
}

export function createTelemetryRouter(repository: Pick<TelemetryRepository, 'ingestMany'>, blocklist?: Pick<TelemetryBlocklist, 'has'>) {
  const router = Router();
  router.post('/', async (request, response) => {
    const { bulk, readings } = parseTelemetryReadings(request.body);
    if (blocklist?.has(readings[0]!.deviceUid)) {
      request.socket.destroy();
      return;
    }
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
