import { Prisma } from '../../generated/prisma/client';
import { ConflictError, NotFoundError } from '../../domain/errors';
import { calculateQualityAgeIncrement, initialQualityWindowDays } from '../../domain/quality/quality';
import type { Database } from '../persistence/database';

export type TelemetryInput = {
  sensorId: string;
  deviceUid: string;
  temperature: number;
  sequenceNumber: number;
};

export class TelemetryRepository {
  constructor(private readonly database: Database) {}

  async ingest(input: TelemetryInput) {
    const receivedAt = new Date();
    const readingUid = `${input.deviceUid}:${input.sequenceNumber}`;
    const sensor = await this.database.sensor.findUnique({
      where: { deviceUid: input.deviceUid },
      include: { sessions: { where: { status: 'ACTIVE' }, orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    if (!sensor || sensor.deletedAt || sensor.provisioningStatus !== 'PROVISIONED' || sensor.code !== input.sensorId) {
      throw new NotFoundError('Provisioned sensor');
    }

    const existing = await this.database.temperatureReading.findUnique({
      where: { readingUid },
      select: { sensorSession: { select: { sensorId: true } } },
    });
    if (existing) {
      if (existing.sensorSession.sensorId !== sensor.id) throw new ConflictError('Reading identity is already in use');
      await this.database.sensor.update({ where: { id: sensor.id }, data: { lastSeenAt: receivedAt } });
      return;
    }

    const session = sensor.sessions[0];
    if (!session) {
      await this.database.sensor.update({ where: { id: sensor.id }, data: { lastSeenAt: receivedAt } });
      throw new ConflictError('Sensor must be assigned before telemetry can be stored');
    }

    try {
      await this.database.$transaction(async (transaction) => {
        const [previousReading, batch] = await Promise.all([
          transaction.temperatureReading.findFirst({ where: { sensorSessionId: session.id }, orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }] }),
          transaction.batch.findUniqueOrThrow({
            where: { id: session.batchId },
            select: { equivalentQualityAgeDays: true, remainingQualityWindowDays: true, qualityEstimateStartedAt: true },
          }),
        ]);
        const currentReading = { temperatureC: input.temperature, measuredAt: receivedAt };
        const previousQualityAge = batch.equivalentQualityAgeDays ?? (batch.remainingQualityWindowDays === null ? 0 : initialQualityWindowDays - batch.remainingQualityWindowDays);
        const equivalentQualityAgeDays = previousQualityAge + (previousReading ? calculateQualityAgeIncrement(previousReading, currentReading) : 0);

        await transaction.temperatureReading.create({
          data: {
            sensorSessionId: session.id,
            temperatureC: input.temperature,
            measuredAt: receivedAt,
            receivedAt,
            readingUid,
          },
        });
        await transaction.sensor.update({ where: { id: sensor.id }, data: { lastSeenAt: receivedAt } });
        await transaction.sensorSession.update({ where: { id: session.id }, data: { lastSyncedAt: receivedAt } });
        await transaction.batch.update({
          where: { id: session.batchId },
          data: {
            currentTemperatureC: input.temperature,
            equivalentQualityAgeDays,
            remainingQualityWindowDays: initialQualityWindowDays - equivalentQualityAgeDays,
            qualityEstimateStartedAt: batch.qualityEstimateStartedAt ?? receivedAt,
          },
        });

        const retained = await transaction.temperatureReading.findMany({
          where: { sensorSession: { sensorId: sensor.id } },
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          take: 100,
          select: { id: true },
        });
        await transaction.temperatureReading.deleteMany({
          where: { sensorSession: { sensorId: sensor.id }, id: { notIn: retained.map(({ id }) => id) } },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
  }
}
