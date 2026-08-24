import { ConflictError, NotFoundError } from '../../domain/errors';
import { calculateQualityState } from '../../domain/quality/quality';
import type { Database } from '../persistence/database';
import { MonitoringProcessor, type MonitoringNotifier } from './monitoring-processor';

export type TelemetryInput = {
  sensorId: string;
  deviceUid: string;
  temperature: number;
  sequenceNumber: number;
  readingUid: string;
  measuredAt: Date;
  syncRemaining: number;
};

export class TelemetryRepository {
  readonly monitoring: MonitoringProcessor;

  constructor(private readonly database: Database, notifier?: MonitoringNotifier) {
    this.monitoring = new MonitoringProcessor(database, notifier);
  }

  async ingest(input: TelemetryInput) {
    await this.ingestMany([input]);
  }

  async ingestMany(inputs: TelemetryInput[]) {
    const first = inputs[0];
    if (!first) return;
    if (inputs.some((input) => input.sensorId !== first.sensorId || input.deviceUid !== first.deviceUid)) throw new ConflictError('Semua pembacaan harus ditujukan ke sensor yang sama');
    const sensor = await this.database.sensor.findUnique({ where: { deviceUid: first.deviceUid } });
    if (!sensor || sensor.deletedAt || sensor.provisioningStatus !== 'PROVISIONED' || sensor.code !== first.sensorId) throw new NotFoundError('Sensor yang telah diprovisioning');

    const byUid = new Map<string, TelemetryInput>();
    for (const input of inputs) {
      const duplicate = byUid.get(input.readingUid);
      if (duplicate && (duplicate.temperature !== input.temperature || duplicate.measuredAt.getTime() !== input.measuredAt.getTime())) throw new ConflictError('Identitas pembacaan memiliki nilai yang bertentangan');
      byUid.set(input.readingUid, input);
    }
    const readings = [...byUid.values()];
    const syncedAt = new Date();
    const notifications = await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${sensor.id})`;
      const currentSensor = await transaction.sensor.findUnique({ where: { deviceUid: first.deviceUid } });
      if (!currentSensor || currentSensor.id !== sensor.id || currentSensor.deletedAt || currentSensor.provisioningStatus !== 'PROVISIONED' || currentSensor.code !== first.sensorId) throw new NotFoundError('Sensor yang telah diprovisioning');

      const existing = await transaction.temperatureReading.findMany({ where: { readingUid: { in: readings.map(({ readingUid }) => readingUid) } } });
      const existingByUid = new Map(existing.map((reading) => [reading.readingUid, reading]));
      const pending = readings.filter((input) => {
        const replay = existingByUid.get(input.readingUid);
        if (!replay) return true;
        if (replay.sequenceNumber !== BigInt(input.sequenceNumber) || replay.temperatureC !== input.temperature || replay.measuredAt.getTime() !== input.measuredAt.getTime()) throw new ConflictError('Identitas pembacaan memiliki nilai yang bertentangan');
        return false;
      });

      const minimum = pending.reduce((value, reading) => Math.min(value, reading.measuredAt.getTime()), Number.POSITIVE_INFINITY);
      const maximum = pending.reduce((value, reading) => Math.max(value, reading.measuredAt.getTime()), Number.NEGATIVE_INFINITY);
      const sessions = pending.length ? await transaction.sensorSession.findMany({
        where: { sensorId: sensor.id, startedAt: { lte: new Date(maximum) }, OR: [{ endedAt: null }, { endedAt: { gt: new Date(minimum) } }] },
        orderBy: { startedAt: 'asc' },
      }) : [];
      const affectedSessionIds = new Set<bigint>();
      for (const input of pending) {
        const session = sessions.find((candidate) => candidate.startedAt <= input.measuredAt && (!candidate.endedAt || input.measuredAt < candidate.endedAt));
        if (!session) throw new ConflictError(`Pembacaan ${input.readingUid} tidak termasuk dalam sesi penugasan sensor`, 'READING_OUTSIDE_SENSOR_SESSION');
        await transaction.temperatureReading.create({
          data: { sensorSessionId: session.id, sequenceNumber: BigInt(input.sequenceNumber), temperatureC: input.temperature, measuredAt: input.measuredAt, receivedAt: syncedAt, readingUid: input.readingUid },
        });
        affectedSessionIds.add(session.id);
      }

      const affectedSessions = await transaction.sensorSession.findMany({ where: { id: { in: [...affectedSessionIds] } }, select: { id: true, batchId: true } });
      const affectedBatchIds = [...new Set(affectedSessions.map(({ batchId }) => batchId))];
      const created = [];
      for (const batchId of affectedBatchIds) {
        const retained = await transaction.temperatureReading.findMany({
          where: { sensorSession: { batchId } },
          orderBy: [{ measuredAt: 'asc' }, { sequenceNumber: 'asc' }, { id: 'asc' }],
          select: { id: true, sequenceNumber: true, temperatureC: true, measuredAt: true },
        });
        const quality = calculateQualityState(retained);
        if (!quality) throw new ConflictError('Batch tidak memiliki telemetri tersimpan');
        const batch = await transaction.batch.update({ where: { id: batchId }, data: quality });
        created.push(...await this.monitoring.processTelemetry(transaction, { userId: batch.userId, batchId, batchCode: batch.code, sensorId: sensor.id, sensorCode: sensor.code, syncedAt, readings: retained }));
      }

      const activeSession = await transaction.sensorSession.findFirst({ where: { sensorId: sensor.id, status: 'ACTIVE' }, orderBy: { startedAt: 'desc' } });
      await transaction.sensor.update({ where: { id: sensor.id }, data: { lastSeenAt: syncedAt, pendingReadingCount: readings.at(-1)?.syncRemaining ?? 0, ...(sensor.status === 'ERROR' ? {} : { status: activeSession ? 'ASSIGNED' : 'AVAILABLE' }) } });
      if (activeSession) await transaction.sensorSession.update({ where: { id: activeSession.id }, data: { lastSyncedAt: syncedAt } });
      return created;
    });
    await this.monitoring.notify(notifications);
  }
}
