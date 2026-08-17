import { ConflictError, RequestError } from '../../domain/errors';
import { calculateQualityState } from '../../domain/quality/quality';
import type { TelemetryUpload } from '../../domain/telemetry/telemetry';
import type { Database } from '../persistence/database';

export class TelemetryRepository {
  constructor(private readonly database: Database) {}

  async ingest(upload: TelemetryUpload) {
    const receivedAt = new Date();
    return this.database.$transaction(async (transaction) => {
      const sensor = await transaction.sensor.findUnique({ where: { deviceUid: upload.sensorId } });
      if (!sensor || sensor.provisioningStatus !== 'PROVISIONED') throw new RequestError('Sensor authentication failed', 401);
      await transaction.sensor.update({ where: { id: sensor.id }, data: { lastSeenAt: receivedAt } });
      const session = await transaction.sensorSession.findFirst({
        where: { sensorId: sensor.id, status: 'ACTIVE', batch: { deletedAt: null } },
        orderBy: { startedAt: 'desc' },
      });
      if (!session) throw new ConflictError('Sensor has no active batch assignment');
      const data = upload.readings.map((reading) => ({
        sensorSessionId: session.id,
        temperatureC: reading.temperatureC,
        measuredAt: reading.measuredAt,
        receivedAt,
        readingUid: `${session.id}:${reading.sequenceNumber}`,
      }));
      const pending = new Map(data.map((reading) => [reading.readingUid, reading]));
      const existing = await transaction.temperatureReading.findMany({
        where: { readingUid: { in: [...pending.keys()] } },
        select: { readingUid: true, temperatureC: true, measuredAt: true },
      });
      if (existing.some((stored) => {
        const candidate = pending.get(stored.readingUid);
        return !candidate || candidate.temperatureC !== stored.temperatureC || candidate.measuredAt.getTime() !== stored.measuredAt.getTime();
      })) throw new ConflictError('A sequence number was already used for a different reading');
      const inserted = await transaction.temperatureReading.createMany({ data, skipDuplicates: true });
      const readings = await transaction.temperatureReading.findMany({
        where: { sensorSession: { batchId: session.batchId } },
        orderBy: { measuredAt: 'asc' },
        select: { temperatureC: true, measuredAt: true },
      });
      const quality = calculateQualityState(readings);
      await Promise.all([
        transaction.sensorSession.update({ where: { id: session.id }, data: { lastSyncedAt: receivedAt } }),
        quality ? transaction.batch.update({ where: { id: session.batchId }, data: quality }) : Promise.resolve(),
      ]);
      return {
        acknowledgedSequenceNumbers: upload.readings.map(({ sequenceNumber }) => sequenceNumber),
        insertedCount: inserted.count,
        duplicateCount: upload.readings.length - inserted.count,
        receivedAt: receivedAt.toISOString(),
      };
    });
  }
}
