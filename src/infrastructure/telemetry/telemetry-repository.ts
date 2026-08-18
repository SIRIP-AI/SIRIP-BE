import { ConflictError, NotFoundError } from '../../domain/errors';
import { evaluateMonitoring, monitoringEventPrefix, type MonitoringDecision } from '../../domain/monitoring/monitoring';
import { calculateQualityState } from '../../domain/quality/quality';
import type { Prisma } from '../../generated/prisma/client';
import type { Database } from '../persistence/database';

export type TelemetryInput = {
  sensorId: string;
  deviceUid: string;
  temperature: number;
  sequenceNumber: number;
  measuredAt: Date;
};

export class TelemetryRepository {
  constructor(private readonly database: Database) {}

  async ingest(input: TelemetryInput) {
    await this.ingestMany([input]);
  }

  async ingestMany(inputs: TelemetryInput[]) {
    const first = inputs[0];
    if (!first) return;
    if (inputs.some((input) => input.sensorId !== first.sensorId || input.deviceUid !== first.deviceUid)) throw new ConflictError('All readings must target the same sensor');
    const sensor = await this.database.sensor.findUnique({
      where: { deviceUid: first.deviceUid },
      include: { sessions: { where: { status: 'ACTIVE' }, orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    if (!sensor || sensor.deletedAt || sensor.provisioningStatus !== 'PROVISIONED' || sensor.code !== first.sensorId) throw new NotFoundError('Provisioned sensor');
    const resolvedSession = sensor.sessions[0];
    if (!resolvedSession) throw new ConflictError('Sensor must be assigned before telemetry can be stored');

    const readingsBySequence = new Map<number, TelemetryInput>();
    for (const input of inputs) {
      const duplicate = readingsBySequence.get(input.sequenceNumber);
      if (duplicate && (duplicate.temperature !== input.temperature || duplicate.measuredAt.getTime() !== input.measuredAt.getTime())) throw new ConflictError('Reading identity has conflicting values');
      readingsBySequence.set(input.sequenceNumber, input);
    }
    const readings = [...readingsBySequence.values()];

    await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${resolvedSession.id})`;
      const currentSensor = await transaction.sensor.findUnique({ where: { deviceUid: first.deviceUid } });
      if (!currentSensor || currentSensor.id !== sensor.id || currentSensor.deletedAt || currentSensor.provisioningStatus !== 'PROVISIONED' || currentSensor.code !== first.sensorId) throw new NotFoundError('Provisioned sensor');
      const session = await transaction.sensorSession.findFirst({ where: { id: resolvedSession.id, sensorId: sensor.id, status: 'ACTIVE' } });
      if (!session) throw new ConflictError('Sensor assignment changed before telemetry could be stored');

      const existing = await transaction.temperatureReading.findMany({
        where: { sensorSessionId: session.id, sequenceNumber: { in: readings.map(({ sequenceNumber }) => BigInt(sequenceNumber)) } },
      });
      const existingBySequence = new Map(existing.map((reading) => [reading.sequenceNumber.toString(), reading]));
      const pending = readings.filter((input) => {
        const replay = existingBySequence.get(input.sequenceNumber.toString());
        if (!replay) return true;
        if (replay.temperatureC !== input.temperature || replay.measuredAt.getTime() !== input.measuredAt.getTime()) throw new ConflictError('Reading identity has conflicting values');
        return false;
      });
      const syncedAt = new Date();
      const receivedAtStart = syncedAt.getTime() - pending.length;
      for (const [index, input] of pending.entries()) {
        await transaction.temperatureReading.create({
          data: {
            sensorSessionId: session.id,
            sequenceNumber: BigInt(input.sequenceNumber),
            temperatureC: input.temperature,
            measuredAt: input.measuredAt,
            receivedAt: new Date(receivedAtStart + index),
            readingUid: `session:${session.id}:${input.sequenceNumber}`,
          },
        });
      }

      const retained = await transaction.temperatureReading.findMany({
        where: { sensorSession: { batchId: session.batchId } },
        orderBy: [{ measuredAt: 'asc' }, { sequenceNumber: 'asc' }, { id: 'asc' }],
        select: { id: true, sequenceNumber: true, temperatureC: true, measuredAt: true },
      });
      const quality = calculateQualityState(retained);
      if (!quality) throw new ConflictError('Batch has no retained telemetry');
      const batch = await transaction.batch.update({ where: { id: session.batchId }, data: quality });
      await this.reconcileMonitoringEvents(transaction, batch.userId, session.batchId, evaluateMonitoring(session.batchId, retained), syncedAt);
      await transaction.sensor.update({ where: { id: sensor.id }, data: { lastSeenAt: syncedAt } });
      await transaction.sensorSession.update({ where: { id: session.id }, data: { lastSyncedAt: syncedAt } });
    });
  }

  private async reconcileMonitoringEvents(transaction: Prisma.TransactionClient, userId: bigint | null, batchId: bigint, decisions: MonitoringDecision[], syncedAt: Date) {
    const existing = await transaction.operationalEvent.findMany({
      where: { batchId, dedupeKey: { startsWith: monitoringEventPrefix(batchId) } },
      select: { id: true, dedupeKey: true, structuredData: true },
    });
    const activeKeys = new Set(decisions.map((decision) => decision.dedupeKey));
    for (const decision of decisions) {
      await transaction.operationalEvent.upsert({
        where: { dedupeKey: decision.dedupeKey },
        create: {
          dedupeKey: decision.dedupeKey,
          userId,
          type: 'TEMPERATURE_EXCURSION',
          source: 'SYSTEM',
          batchId,
          rawMessage: null,
          structuredData: decision.structuredData,
          occurredAt: decision.occurredAt,
        },
        update: { structuredData: decision.structuredData },
      });
    }
    for (const event of existing) {
      if (!event.dedupeKey || activeKeys.has(event.dedupeKey)) continue;
      const data = event.structuredData;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const alert = data.alert;
      if (!alert || typeof alert !== 'object' || Array.isArray(alert) || alert.active !== true) continue;
      await transaction.operationalEvent.update({
        where: { id: event.id },
        data: { structuredData: { ...data, alert: { ...alert, active: false, resolvedAt: syncedAt.toISOString() } } },
      });
    }
  }
}
