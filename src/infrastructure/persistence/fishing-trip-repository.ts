import { Prisma } from '../../generated/prisma/client';
import { ConflictError, NotFoundError } from '../../domain/errors';
import type { FishingTripInput } from '../../domain/fishing-trips';
import type { Database } from './database';

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

  async complete(userId: bigint, id: bigint) {
    const result = await this.database.fishingTrip.updateMany({ where: { id, userId, deletedAt: null, status: 'ACTIVE' }, data: { status: 'COMPLETED', endedAt: new Date() } });
    if (!result.count) {
      const trip = await this.database.fishingTrip.findFirst({ where: { id, userId, deletedAt: null } });
      if (!trip) throw new NotFoundError('Fishing trip');
      throw new ConflictError('Fishing trip is already completed');
    }
    return response(await this.database.fishingTrip.findFirstOrThrow({ where: { id, userId, deletedAt: null }, include }));
  }

  async delete(userId: bigint, id: bigint) {
    const trip = await this.database.fishingTrip.findFirst({ where: { id, userId, deletedAt: null }, include });
    if (!trip) throw new NotFoundError('Fishing trip');
    if (trip._count.batches) throw new ConflictError('Fishing trips with batches cannot be deleted');
    await this.database.fishingTrip.update({ where: { id, userId }, data: { deletedAt: new Date() } });
  }
}
