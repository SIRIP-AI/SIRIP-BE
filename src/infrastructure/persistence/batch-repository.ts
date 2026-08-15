import { Prisma } from '../../generated/prisma/client';
import type { BatchFilter, BatchInput } from '../../domain/batches';
import { ConflictError, NotFoundError } from '../../domain/errors';
import type { Database } from './database';

const include = { fishingTrip: { select: { id: true, code: true, vesselName: true } }, sensorSessions: { where: { status: 'ACTIVE' as const }, select: { sensor: { select: { code: true, status: true } } }, take: 1 } } as const;

function response(batch: Prisma.BatchGetPayload<{ include: typeof include }>) {
  const sensor = batch.sensorSessions[0]?.sensor ?? null;
  return { id: batch.id.toString(), code: batch.code, fishingTripId: batch.fishingTripId?.toString() ?? null, fishingTrip: batch.fishingTrip ? { ...batch.fishingTrip, id: batch.fishingTrip.id.toString() } : null, weightKg: batch.weightKg, grade: batch.grade, status: batch.status, receivedAt: batch.receivedAt.toISOString(), handedOverAt: batch.handedOverAt?.toISOString() ?? null, equivalentQualityAgeDays: batch.equivalentQualityAgeDays, remainingQualityWindowDays: batch.remainingQualityWindowDays, qualityEstimateStartedAt: batch.qualityEstimateStartedAt?.toISOString() ?? null, currentTemperatureC: batch.currentTemperatureC, activeSensor: sensor, createdAt: batch.createdAt.toISOString(), updatedAt: batch.updatedAt.toISOString() };
}

function translate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw new ConflictError('A batch with that code already exists');
    if (error.code === 'P2003') throw new NotFoundError('Fishing trip');
    if (error.code === 'P2025') throw new NotFoundError('Batch');
  }
  throw error;
}

export class BatchRepository {
  constructor(private readonly database: Database) {}
  async list(filter?: BatchFilter) {
    const where: Prisma.BatchWhereInput = { deletedAt: null };
    if (filter === 'active') where.status = { in: ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] };
    if (filter === 'closed') where.status = { in: ['HANDED_OVER', 'CLOSED'] };
    if (filter === 'at-risk') where.OR = [{ status: 'INSPECTION_HOLD' }, { remainingQualityWindowDays: { lte: 2 } }];
    return (await this.database.batch.findMany({ where, orderBy: { receivedAt: 'desc' }, include })).map(response);
  }
  async create(input: BatchInput) { try { return response(await this.database.batch.create({ data: { ...input, receivedAt: new Date(input.receivedAt), status: 'MONITORING' }, include })); } catch (error) { translate(error); } }
  async update(id: bigint, input: BatchInput) { try { return response(await this.database.batch.update({ where: { id, deletedAt: null }, data: { ...input, receivedAt: new Date(input.receivedAt) }, include })); } catch (error) { translate(error); } }
  async delete(id: bigint) {
    const batch = await this.database.batch.findFirst({ where: { id, deletedAt: null }, include: { _count: { select: { sensorSessions: true, operationalEvents: true, planSteps: true } } } });
    if (!batch) throw new NotFoundError('Batch');
    if (batch._count.sensorSessions || batch._count.operationalEvents || batch._count.planSteps) throw new ConflictError('Batches with sensor, event, or plan history cannot be deleted');
    await this.database.batch.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
