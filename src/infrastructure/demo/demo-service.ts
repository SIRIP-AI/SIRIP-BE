import { ConflictError, NotFoundError, RequestError } from '../../domain/errors';
import type { AuthUser } from '../../domain/auth/auth';
import type { Database } from '../persistence/database';
import { resetSeedBaseline, seededUser } from '../persistence/seed-baseline';
import { parseTelemetryReadings } from '../telemetry/telemetry-router';
import type { TelemetryRepository } from '../telemetry/telemetry-repository';

const hour = 60 * 60_000;
const day = 24 * hour;

export const demoTrips = [
  { code: 'FT-101', vesselName: 'KM Demo Laut', ageHours: 216 },
  { code: 'FT-102', vesselName: 'KM Sinar Tuna', ageHours: 204 },
  { code: 'FT-103', vesselName: 'KM Bahari Jaya', ageHours: 192 },
] as const;

export const demoActiveBatches = [
  { code: 'B-101', tripCode: 'FT-101', sensorCode: 'SIM-S-101', weightKg: 180, grade: 'A', status: 'MONITORING', qualityWindowDays: 2.4 },
  { code: 'B-102', tripCode: 'FT-102', sensorCode: 'SIM-S-102', weightKg: 420, grade: 'A', status: 'MONITORING', qualityWindowDays: 2.7 },
  { code: 'B-103', tripCode: 'FT-103', sensorCode: 'SIM-S-103', weightKg: 220, grade: 'A', status: 'MONITORING', qualityWindowDays: 3 },
] as const;

export const demoBatches = [
  ...demoActiveBatches,
  { code: 'B-104', tripCode: 'FT-101', weightKg: 260, grade: 'A', status: 'CLOSED' },
  { code: 'B-105', tripCode: 'FT-102', weightKg: 310, grade: 'B', status: 'CLOSED' },
  { code: 'B-106', tripCode: 'FT-103', weightKg: 240, grade: 'A', status: 'CLOSED' },
] as const;

export const baselineTemperatures = [2, 2.1, 1.9, 2, 2] as const;

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
      return resetSeedBaseline(transaction, userId, true);
    });
    return { resetAt: resetAt.toISOString(), ...result, sessionPreserved: true as const };
  }

  async load(user: AuthUser, now = new Date()) {
    await this.reset(user);
    const userId = BigInt(user.id);
    const prepared = await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${userId})`;

      const trips = [];
      for (const definition of demoTrips) {
        trips.push(await transaction.fishingTrip.upsert({
          where: { userId_code: { userId, code: definition.code } },
          create: { userId, code: definition.code, vesselName: definition.vesselName, startedAt: new Date(now.getTime() - definition.ageHours * hour), endedAt: new Date(now.getTime() - 8 * hour), status: 'COMPLETED' },
          update: { vesselName: definition.vesselName, startedAt: new Date(now.getTime() - definition.ageHours * hour), endedAt: new Date(now.getTime() - 8 * hour), status: 'COMPLETED', deletedAt: null },
        }));
      }
      const tripsByCode = new Map(trips.map((trip) => [trip.code, trip]));

      const batches = [];
      const sensors = [];
      for (const [index, definition] of demoBatches.entries()) {
        const trip = tripsByCode.get(definition.tripCode)!;
        batches.push(await transaction.batch.upsert({
          where: { userId_code: { userId, code: definition.code } },
          create: { userId, code: definition.code, fishingTripId: trip.id, weightKg: definition.weightKg, grade: definition.grade, status: definition.status, receivedAt: new Date(now.getTime() - 8 * day), handedOverAt: definition.status === 'CLOSED' ? new Date(now.getTime() - 6 * hour) : null },
          update: { fishingTripId: trip.id, weightKg: definition.weightKg, grade: definition.grade, status: definition.status, receivedAt: new Date(now.getTime() - 8 * day), handedOverAt: definition.status === 'CLOSED' ? new Date(now.getTime() - 6 * hour) : null, deletedAt: null },
        }));
        if (!('sensorCode' in definition)) continue;
        const deviceUid = demoDeviceUid(userId, index);
        sensors.push(await transaction.sensor.upsert({
          where: { userId_code: { userId, code: definition.sensorCode } },
          create: { userId, code: definition.sensorCode, deviceUid, status: 'ASSIGNED', provisioningStatus: 'PROVISIONED' },
          update: { deviceUid, status: 'ASSIGNED', provisioningStatus: 'PROVISIONED', lastSeenAt: null, deletedAt: null },
        }));
      }

      const reservedSensorIds = new Set(sensors.map(({ id }) => id));
      const activeBatches = batches.slice(0, sensors.length);
      const reservedBatchIds = new Set(activeBatches.map(({ id }) => id));
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
      for (const [index, batch] of activeBatches.entries()) {
        const definition = demoActiveBatches[index]!;
        const durationDays = (12 - definition.qualityWindowDays) / Math.exp(0.12 * 2);
        await transaction.sensorSession.create({ data: { sensorId: sensors[index]!.id, batchId: batch.id, startedAt: new Date(now.getTime() - durationDays * day), status: 'ACTIVE' } });
      }
      return { trips, batches, sensors };
    });

    for (const [index, definition] of demoActiveBatches.entries()) {
      const sensor = prepared.sensors[index]!;
      const durationDays = (12 - definition.qualityWindowDays) / Math.exp(0.12 * 2);
      const payload = baselineTemperatures.map((temperature, sequenceNumber) => ({
        sensorId: definition.sensorCode,
        deviceUid: sensor.deviceUid,
        temperature,
        sequenceNumber: sequenceNumber + 1,
        measuredAt: new Date(now.getTime() - durationDays * day + sequenceNumber * durationDays * day / (baselineTemperatures.length - 1)).toISOString(),
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
      sensors: prepared.sensors.map((sensor, index) => ({ id: sensor.id.toString(), code: sensor.code, batchCode: demoActiveBatches[index]!.code, readingCount: baselineTemperatures.length })),
      readingCount: prepared.sensors.length * baselineTemperatures.length,
      generatedAt: now.toISOString(),
    };
  }

  async simulateExcursion(userId: bigint, sensorId: bigint, now = new Date()) {
    return this.simulateTelemetry(userId, sensorId, [9.2, 9.5, 9.8, 10.1, 10.3], now);
  }

  async simulateRecovery(userId: bigint, sensorId: bigint, now = new Date()) {
    return this.simulateTelemetry(userId, sensorId, [2.1, 2, 1.9, 2, 2.1], now);
  }

  private async simulateTelemetry(userId: bigint, sensorId: bigint, temperatures: number[], now: Date) {
    const sensor = await this.database.sensor.findFirst({
      where: { id: sensorId, userId, deletedAt: null },
      include: { sessions: { where: { status: 'ACTIVE' }, take: 1 } },
    });
    if (!sensor) throw new NotFoundError('Sensor');
    if (sensor.provisioningStatus !== 'PROVISIONED' || !sensor.sessions[0]) throw new ConflictError('Sensor must be provisioned and assigned before simulating telemetry');
    const maximum = await this.database.temperatureReading.aggregate({ where: { sensorSessionId: sensor.sessions[0].id }, _max: { sequenceNumber: true } });
    const firstSequence = Number(maximum._max.sequenceNumber ?? -1n) + 1;
    if (!Number.isSafeInteger(firstSequence + 4)) throw new ConflictError('Sensor sequence number is too large to simulate telemetry');
    const payload = temperatures.map((temperature, index) => ({
      sensorId: sensor.code,
      deviceUid: sensor.deviceUid,
      temperature,
      sequenceNumber: firstSequence + index,
      measuredAt: new Date(now.getTime() - (temperatures.length - 1 - index) * 1000).toISOString(),
    }));
    const { readings } = parseTelemetryReadings({ readings: payload }, now.getTime());
    await this.telemetry.ingestMany(readings);
    return { sensorId: sensor.id.toString(), readingCount: readings.length, temperatures, generatedAt: now.toISOString() };
  }
}
