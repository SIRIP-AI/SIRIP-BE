import { Prisma } from '../../generated/prisma/client';
import { ConflictError, NotFoundError } from '../../domain/errors';
import type { FishingTripInput } from '../../domain/fishing-trips/fishing-trips';
import type { Database } from '../persistence/database';

const include = { _count: { select: { batches: { where: { deletedAt: null } } } } } as const;

type FishingTripResponse = Prisma.FishingTripGetPayload<{ include: typeof include }>;

function response(trip: FishingTripResponse) {
  return { id: trip.id.toString(), code: trip.code, vesselName: trip.vesselName, startedAt: trip.startedAt.toISOString(), endedAt: trip.endedAt?.toISOString() ?? null, status: trip.status, createdAt: trip.createdAt.toISOString(), batchCount: trip._count.batches };
}

function translate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw new ConflictError('A fishing trip with that code already exists');
    if (error.code === 'P2025') throw new NotFoundError('Fishing trip');
  }
  throw error;
}

export class FishingTripRepository {
  constructor(private readonly database: Database) {}

  async list(userId: bigint) {
    return (await this.database.fishingTrip.findMany({ where: { userId, deletedAt: null }, orderBy: { startedAt: 'desc' }, include })).map(response);
  }

  async create(userId: bigint, input: FishingTripInput) {
    try { return response(await this.database.fishingTrip.create({ data: { ...input, userId, startedAt: new Date(), status: 'ACTIVE' }, include })); } catch (error) { translate(error); }
  }

  async update(userId: bigint, id: bigint, input: FishingTripInput) {
    try { return response(await this.database.fishingTrip.update({ where: { id, userId, deletedAt: null }, data: input, include })); } catch (error) { translate(error); }
  }

  async complete(userId: bigint, id: bigint, batches: Array<{ weightKg: number; grade: string; sensorId: bigint }> | null) {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${userId})`;
      const trip = await transaction.fishingTrip.findFirst({ where: { id, userId, deletedAt: null }, include });
      if (!trip) throw new NotFoundError('Fishing trip');
      if (trip.status !== 'ACTIVE') throw new ConflictError('Fishing trip is already completed');
      if (batches === null) {
        if (!trip._count.batches) throw new ConflictError('At least one landed batch is required to complete the trip');
        return response(await transaction.fishingTrip.update({ where: { id }, data: { status: 'COMPLETED', endedAt: new Date() }, include }));
      }
      const sensorIds = batches.map(({ sensorId }) => sensorId);
      if (new Set(sensorIds.map(String)).size !== sensorIds.length) throw new ConflictError('Each landed batch requires a different sensor');
      const sensors = await transaction.sensor.findMany({ where: { id: { in: sensorIds }, userId, deletedAt: null, status: 'AVAILABLE', provisioningStatus: 'PROVISIONED' }, select: { id: true } });
      if (sensors.length !== sensorIds.length) throw new ConflictError('Every landed batch requires an available provisioned sensor');
      const completedAt = new Date();
      const created = [];
      for (const [index, batch] of batches.entries()) {
        const createdBatch = await transaction.batch.create({ data: { userId, fishingTripId: id, code: `${trip.code}-B${String(trip._count.batches + index + 1).padStart(2, '0')}`, weightKg: batch.weightKg, grade: batch.grade, status: 'MONITORING', receivedAt: completedAt, locationType: 'INTAKE' }, select: { id: true, code: true, weightKg: true, grade: true } });
        await transaction.sensorSession.create({ data: { sensorId: batch.sensorId, batchId: createdBatch.id, startedAt: completedAt, status: 'ACTIVE' } });
        await transaction.sensor.update({ where: { id: batch.sensorId }, data: { status: 'ASSIGNED' } });
        created.push({ ...createdBatch, id: createdBatch.id.toString(), sensorId: batch.sensorId.toString() });
      }
      const completed = await transaction.fishingTrip.update({ where: { id }, data: { status: 'COMPLETED', endedAt: completedAt }, include });
      return { trip: response(completed), batches: created };
    });
  }

  async delete(userId: bigint, id: bigint) {
    const trip = await this.database.fishingTrip.findFirst({ where: { id, userId, deletedAt: null }, include });
    if (!trip) throw new NotFoundError('Fishing trip');
    if (trip._count.batches) throw new ConflictError('Fishing trips with batches cannot be deleted');
    await this.database.fishingTrip.update({ where: { id, userId }, data: { deletedAt: new Date() } });
  }
}
