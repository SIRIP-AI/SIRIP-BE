import { ConflictError, NotFoundError, RequestError } from '../../domain/errors';
import type { AuthUser } from '../../domain/auth/auth';
import type { Database } from '../persistence/database';
import { resetSeedBaseline, seededUser } from '../persistence/seed-baseline';
import { parseTelemetryReadings } from '../telemetry/telemetry-router';
import type { TelemetryRepository } from '../telemetry/telemetry-repository';

const hour = 60 * 60_000;

export const demoTrips = [
  { code: 'DEMO-TRIP', vesselName: 'KM Demo Laut', ageHours: 42 },
  { code: 'DEMO-TRIP-02', vesselName: 'KM Sinar Tuna', ageHours: 36 },
  { code: 'DEMO-TRIP-03', vesselName: 'KM Bahari Jaya', ageHours: 30 },
] as const;

export const demoBatches = [
  { code: 'DEMO-BATCH', tripCode: 'DEMO-TRIP', sensorCode: 'DEMO-SENSOR', weightKg: 350, grade: 'A', profile: 'healthy', temperatures: [1.8, 2, 2.1, 2.2, 2.3] },
  { code: 'DEMO-BATCH-02', tripCode: 'DEMO-TRIP', sensorCode: 'DEMO-SENSOR-02', weightKg: 280, grade: 'A', profile: 'warming', temperatures: [2.2, 3.1, 4.2, 5.3, 6.4] },
  { code: 'DEMO-BATCH-03', tripCode: 'DEMO-TRIP-02', sensorCode: 'DEMO-SENSOR-03', weightKg: 410, grade: 'A', profile: 'healthy', temperatures: [1.6, 1.8, 2, 2.1, 2.2] },
  { code: 'DEMO-BATCH-04', tripCode: 'DEMO-TRIP-02', sensorCode: 'DEMO-SENSOR-04', weightKg: 320, grade: 'B', profile: 'warming', temperatures: [2.4, 3.3, 4.5, 5.8, 7.2] },
  { code: 'DEMO-BATCH-05', tripCode: 'DEMO-TRIP-03', sensorCode: 'DEMO-SENSOR-05', weightKg: 295, grade: 'A', profile: 'healthy', temperatures: [1.9, 2, 2.2, 2.3, 2.4] },
  { code: 'DEMO-BATCH-06', tripCode: 'DEMO-TRIP-03', sensorCode: 'DEMO-SENSOR-06', weightKg: 365, grade: 'B', profile: 'warming', temperatures: [2.1, 3, 4.1, 5.5, 6.8] },
] as const;

export function demoDeviceUid(userId: bigint, sensorIndex: number) {
  return `sirip-demo-device:${userId}:${sensorIndex + 1}`;
}

type DemoSession = {
  sensorId: bigint;
  batchId: bigint;
  sensor: { userId: bigint | null };
  batch: { userId: bigint | null };
};

export function isUnsafeDemoSession(userId: bigint, reservedSensorIds: ReadonlySet<bigint>, reservedBatchIds: ReadonlySet<bigint>, session: DemoSession) {
  return session.sensor.userId !== userId
    || session.batch.userId !== userId
    || !reservedSensorIds.has(session.sensorId)
    || !reservedBatchIds.has(session.batchId);
}

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
    const prepared = await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${userId})`;

      const trips = [];
      for (const definition of demoTrips) {
        trips.push(await transaction.fishingTrip.upsert({
          where: { userId_code: { userId, code: definition.code } },
          create: { userId, code: definition.code, vesselName: definition.vesselName, startedAt: new Date(now.getTime() - definition.ageHours * hour), status: 'ACTIVE' },
          update: { vesselName: definition.vesselName, startedAt: new Date(now.getTime() - definition.ageHours * hour), endedAt: null, status: 'ACTIVE', deletedAt: null },
        }));
      }
      const tripsByCode = new Map(trips.map((trip) => [trip.code, trip]));

      const batches = [];
      const sensors = [];
      for (const [index, definition] of demoBatches.entries()) {
        const trip = tripsByCode.get(definition.tripCode)!;
        batches.push(await transaction.batch.upsert({
          where: { userId_code: { userId, code: definition.code } },
          create: { userId, code: definition.code, fishingTripId: trip.id, weightKg: definition.weightKg, grade: definition.grade, status: 'MONITORING', receivedAt: new Date(now.getTime() - 24 * hour) },
          update: { fishingTripId: trip.id, weightKg: definition.weightKg, grade: definition.grade, status: 'MONITORING', receivedAt: new Date(now.getTime() - 24 * hour), handedOverAt: null, deletedAt: null },
        }));
        const deviceUid = demoDeviceUid(userId, index);
        sensors.push(await transaction.sensor.upsert({
          where: { userId_code: { userId, code: definition.sensorCode } },
          create: { userId, code: definition.sensorCode, deviceUid, status: 'ASSIGNED', provisioningStatus: 'PROVISIONED' },
          update: { deviceUid, status: 'ASSIGNED', provisioningStatus: 'PROVISIONED', lastSeenAt: null, deletedAt: null },
        }));
      }

      const reservedSensorIds = new Set(sensors.map(({ id }) => id));
      const reservedBatchIds = new Set(batches.map(({ id }) => id));
      const sessions = await transaction.sensorSession.findMany({
        where: { OR: [{ sensorId: { in: [...reservedSensorIds] } }, { batchId: { in: [...reservedBatchIds] } }] },
        select: { id: true, sensorId: true, batchId: true, sensor: { select: { userId: true } }, batch: { select: { userId: true } } },
      });
      if (sessions.some((session) => isUnsafeDemoSession(userId, reservedSensorIds, reservedBatchIds, session))) {
        throw new ConflictError('Demo load aborted because reserved sensors or batches have conflicting assignments');
      }

      const sessionIds = sessions.map(({ id }) => id);
      await transaction.temperatureReading.deleteMany({ where: { sensorSessionId: { in: sessionIds } } });
      await transaction.sensorSession.deleteMany({ where: { id: { in: sessionIds } } });
      await transaction.batch.updateMany({
        where: { id: { in: [...reservedBatchIds] } },
        data: { equivalentQualityAgeDays: null, remainingQualityWindowDays: null, qualityEstimateStartedAt: null, currentTemperatureC: null },
      });
      for (const [index, batch] of batches.entries()) {
        await transaction.sensorSession.create({ data: { sensorId: sensors[index]!.id, batchId: batch.id, startedAt: new Date(now.getTime() - 24 * hour), status: 'ACTIVE' } });
      }
      return { trips, batches, sensors };
    });

    for (const [index, definition] of demoBatches.entries()) {
      const sensor = prepared.sensors[index]!;
      const payload = definition.temperatures.map((temperature, sequenceNumber) => ({
        sensorId: definition.sensorCode,
        deviceUid: sensor.deviceUid,
        temperature,
        sequenceNumber: sequenceNumber + 1,
        measuredAt: new Date(now.getTime() - (24 - sequenceNumber * 6) * hour).toISOString(),
      }));
      const { readings } = parseTelemetryReadings({ readings: payload }, now.getTime());
      await this.telemetry.ingestMany(readings);
    }

    const quality = await this.database.batch.findMany({
      where: { id: { in: prepared.batches.map(({ id }) => id) } },
      select: { id: true, currentTemperatureC: true, remainingQualityWindowDays: true },
    });
    const qualityById = new Map(quality.map((batch) => [batch.id, batch]));
    return {
      trips: prepared.trips.map((trip) => ({ id: trip.id.toString(), code: trip.code })),
      batches: prepared.batches.map((batch, index) => ({
        id: batch.id.toString(),
        code: batch.code,
        tripCode: demoBatches[index]!.tripCode,
        currentTemperatureC: qualityById.get(batch.id)!.currentTemperatureC,
        remainingQualityWindowDays: qualityById.get(batch.id)!.remainingQualityWindowDays,
      })),
      sensors: prepared.sensors.map((sensor, index) => ({ id: sensor.id.toString(), code: sensor.code, batchCode: demoBatches[index]!.code, readingCount: demoBatches[index]!.temperatures.length })),
      readingCount: demoBatches.reduce((count, batch) => count + batch.temperatures.length, 0),
      generatedAt: now.toISOString(),
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
