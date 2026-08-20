import { ConflictError, NotFoundError, RequestError } from '../../domain/errors';
import type { AuthUser } from '../../domain/auth/auth';
import type { Database } from '../persistence/database';
import { resetSeedBaseline, seededUser } from '../persistence/seed-baseline';
import { parseTelemetryReadings } from '../telemetry/telemetry-router';
import type { TelemetryRepository } from '../telemetry/telemetry-repository';

const tripCode = 'DEMO-TRIP';
const batchCode = 'DEMO-BATCH';
const sensorCode = 'DEMO-SENSOR';

export class DemoService {
  constructor(private readonly database: Database, private readonly telemetry: Pick<TelemetryRepository, 'ingestMany'>) {}

  async reset(user: AuthUser) {
    if (user.email !== seededUser.email) throw new RequestError('Demo reset is only available for the seeded account', 403);
    const userId = BigInt(user.id);
    const resetAt = new Date();
    const result = await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${userId})`;
      const currentUser = await transaction.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!currentUser || currentUser.email !== seededUser.email) throw new RequestError('Demo reset is only available for the seeded account', 403);
      await transaction.user.update({ where: { id: userId }, data: { name: seededUser.name, phone: seededUser.phone } });
      return resetSeedBaseline(transaction, userId);
    });
    return { resetAt: resetAt.toISOString(), ...result, sessionPreserved: true as const };
  }

  async generate(userId: bigint, now = new Date()) {
    const deviceUid = `sirip-demo-device:${userId}`;
    const { trip, batch, sensor } = await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${userId})`;

      const trip = await transaction.fishingTrip.upsert({
        where: { userId_code: { userId, code: tripCode } },
        create: { userId, code: tripCode, vesselName: 'KM Demo Laut', startedAt: new Date(now.getTime() - 36 * 60 * 60_000), status: 'ACTIVE' },
        update: { vesselName: 'KM Demo Laut', startedAt: new Date(now.getTime() - 36 * 60 * 60_000), endedAt: null, status: 'ACTIVE', deletedAt: null },
      });
      const batch = await transaction.batch.upsert({
        where: { userId_code: { userId, code: batchCode } },
        create: { userId, code: batchCode, fishingTripId: trip.id, weightKg: 350, grade: 'A', status: 'MONITORING', receivedAt: new Date(now.getTime() - 24 * 60 * 60_000) },
        update: { fishingTripId: trip.id, weightKg: 350, grade: 'A', status: 'MONITORING', receivedAt: new Date(now.getTime() - 24 * 60 * 60_000), handedOverAt: null, equivalentQualityAgeDays: null, remainingQualityWindowDays: null, qualityEstimateStartedAt: null, currentTemperatureC: null, deletedAt: null },
      });
      const sensor = await transaction.sensor.upsert({
        where: { userId_code: { userId, code: sensorCode } },
        create: { userId, code: sensorCode, deviceUid, status: 'ASSIGNED', provisioningStatus: 'PROVISIONED' },
        update: { deviceUid, status: 'ASSIGNED', provisioningStatus: 'PROVISIONED', lastSeenAt: null, deletedAt: null },
      });
      const foreignAssignment = await transaction.sensorSession.findFirst({ where: { batchId: batch.id, status: 'ACTIVE', sensorId: { not: sensor.id } } });
      if (foreignAssignment) throw new ConflictError('Demo batch is assigned to another sensor; unassign it before loading demo data');

      const oldSessions = await transaction.sensorSession.findMany({ where: { OR: [{ sensorId: sensor.id }, { batchId: batch.id }] }, select: { id: true } });
      await transaction.temperatureReading.deleteMany({ where: { sensorSessionId: { in: oldSessions.map(({ id }) => id) } } });
      await transaction.sensorSession.updateMany({ where: { id: { in: oldSessions.map(({ id }) => id) }, status: 'ACTIVE' }, data: { status: 'COMPLETED', endedAt: now } });
      await transaction.sensorSession.create({ data: { sensorId: sensor.id, batchId: batch.id, startedAt: new Date(now.getTime() - 24 * 60 * 60_000), status: 'ACTIVE' } });
      return { trip, batch, sensor };
    });

    const hour = 60 * 60_000;
    const samples = [
      [-24 * hour, 2.1],
      [-18 * hour, 2.4],
      [-12 * hour, 3.0],
      [-6 * hour, 5.6],
      [-60_000, 9.2],
    ];
    const payload = samples.map(([offset, temperature], sequenceNumber) => ({
      sensorId: sensorCode,
      deviceUid,
      temperature,
      sequenceNumber: sequenceNumber + 1,
      measuredAt: new Date(now.getTime() + offset).toISOString(),
    }));
    const { readings } = parseTelemetryReadings({ readings: payload }, now.getTime());
    await this.telemetry.ingestMany(readings);

    const result = await this.database.batch.findUniqueOrThrow({ where: { id: batch.id }, select: { currentTemperatureC: true, remainingQualityWindowDays: true } });
    return {
      trip: { id: trip.id.toString(), code: trip.code },
      batch: { id: batch.id.toString(), code: batch.code },
      sensor: { id: sensor.id.toString(), code: sensor.code },
      readingCount: readings.length,
      generatedAt: now.toISOString(),
      currentTemperatureC: result.currentTemperatureC,
      remainingQualityWindowDays: result.remainingQualityWindowDays,
    };
  }

  async simulateExcursion(userId: bigint, sensorId: bigint, now = new Date()) {
    const sensor = await this.database.sensor.findFirst({
      where: { id: sensorId, userId, deletedAt: null },
      include: { sessions: { where: { status: 'ACTIVE' }, take: 1 } },
    });
    if (!sensor) throw new NotFoundError('Sensor');
    if (sensor.provisioningStatus !== 'PROVISIONED' || !sensor.sessions[0]) throw new ConflictError('Sensor must be provisioned and assigned before simulating an excursion');
    const maximum = await this.database.temperatureReading.aggregate({ where: { sensorSessionId: sensor.sessions[0].id }, _max: { sequenceNumber: true } });
    const firstSequence = Number(maximum._max.sequenceNumber ?? -1n) + 1;
    if (!Number.isSafeInteger(firstSequence + 4)) throw new ConflictError('Sensor sequence number is too large to simulate telemetry');
    const temperatures = [9.2, 9.5, 9.8, 10.1, 10.3];
    const readings = temperatures.map((temperature, index) => ({
      sensorId: sensor.code,
      deviceUid: sensor.deviceUid,
      temperature,
      sequenceNumber: firstSequence + index,
      measuredAt: new Date(now.getTime() - (temperatures.length - 1 - index) * 1000),
    }));
    await this.telemetry.ingestMany(readings);
    return { sensorId: sensor.id.toString(), readingCount: readings.length, temperatures, generatedAt: now.toISOString() };
  }
}
