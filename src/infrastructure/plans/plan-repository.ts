import type { PlanRepositoryPort, PlanValidator } from '../../application/plans/plan-service';
import { ConflictError, NotFoundError } from '../../domain/errors';
import { activePlanSnapshot, type AiPlanProposal, type PlanningActivePlan, type PlanView, type PlanningContext, type PlanningPlanStep } from '../../domain/plans/plans';
import { Prisma } from '../../generated/prisma/client';
import type { Database } from '../persistence/database';

const activeBatchStatuses = ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] as const;
const maximumListedPlans = 50;
const recentReadingsPerBatch = 24;

const planInclude = {
  triggerEvent: { select: { type: true, rawMessage: true, structuredData: true, occurredAt: true } },
  steps: {
    orderBy: { sequence: 'asc' as const },
    include: {
      batch: { select: { id: true, code: true } },
      coldStorage: { select: { id: true, name: true } },
      vehicle: { select: { id: true, code: true } },
      destination: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.PlanInclude;

type StoredPlan = Prisma.PlanGetPayload<{ include: typeof planInclude }>;

function eventMessage(event: NonNullable<StoredPlan['triggerEvent']>) {
  if (event.rawMessage?.trim()) return event.rawMessage.trim();
  if (event.structuredData && typeof event.structuredData === 'object' && !Array.isArray(event.structuredData)) {
    const message = event.structuredData.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
    const alert = event.structuredData.alert;
    if (alert && typeof alert === 'object' && !Array.isArray(alert) && typeof alert.description === 'string' && alert.description.trim()) return alert.description.trim();
  }
  return event.type.replaceAll('_', ' ').toLowerCase();
}

function serializePlan(plan: StoredPlan): PlanView {
  return {
    id: plan.id.toString(),
    version: plan.version,
    status: plan.status,
    previousPlanId: plan.previousPlanId?.toString() ?? null,
    reason: plan.reason,
    createdAt: plan.createdAt.toISOString(),
    approvedAt: plan.approvedAt?.toISOString() ?? null,
    trigger: plan.triggerEvent ? {
      type: plan.triggerEvent.type,
      message: eventMessage(plan.triggerEvent),
      occurredAt: plan.triggerEvent.occurredAt.toISOString(),
    } : null,
    steps: plan.steps.map((step) => {
      const resource = step.actionType === 'STORE' && step.coldStorage
        ? { type: 'COLD_STORAGE' as const, id: step.coldStorage.id.toString(), name: step.coldStorage.name }
        : step.actionType === 'LOAD' && step.vehicle
          ? { type: 'VEHICLE' as const, id: step.vehicle.id.toString(), name: step.vehicle.code }
          : (step.actionType === 'DISPATCH' || step.actionType === 'HANDOVER') && step.destination
            ? { type: 'DESTINATION' as const, id: step.destination.id.toString(), name: step.destination.name }
            : null;
      return {
        id: step.id.toString(),
        sequence: step.sequence,
        actionType: step.actionType,
        scheduledAt: step.scheduledAt.toISOString(),
        status: step.status,
        completedAt: step.completedAt?.toISOString() ?? null,
        notes: step.notes,
        batch: { id: step.batch.id.toString(), code: step.batch.code },
        resource,
      };
    }),
  };
}

function planningStep(step: {
  sequence: number;
  actionType: PlanningPlanStep['actionType'];
  batchId: bigint;
  coldStorageId: bigint | null;
  vehicleId: bigint | null;
  destinationId: bigint | null;
  scheduledAt: Date;
  status: PlanningPlanStep['status'];
  completedAt: Date | null;
  notes: string | null;
}): PlanningPlanStep {
  return {
    sequence: step.sequence,
    actionType: step.actionType,
    batchId: step.batchId.toString(),
    coldStorageId: step.coldStorageId?.toString() ?? null,
    vehicleId: step.vehicleId?.toString() ?? null,
    destinationId: step.destinationId?.toString() ?? null,
    scheduledAt: step.scheduledAt.toISOString(),
    status: step.status,
    completedAt: step.completedAt?.toISOString() ?? null,
    notes: step.notes,
  };
}

async function lockUser(transaction: Prisma.TransactionClient, userId: bigint) {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${userId})`;
}

function proposalStep(step: AiPlanProposal['steps'][number], sequence: number) {
  return {
    sequence,
    actionType: step.actionType,
    batchId: BigInt(step.batchId),
    coldStorageId: step.coldStorageId ? BigInt(step.coldStorageId) : null,
    vehicleId: step.vehicleId ? BigInt(step.vehicleId) : null,
    destinationId: step.destinationId ? BigInt(step.destinationId) : null,
    scheduledAt: new Date(step.scheduledAt),
    status: 'UPCOMING' as const,
    notes: step.notes ?? null,
  };
}

function completedFacts(steps: Array<{
  sequence: number;
  actionType: string;
  batchId: bigint;
  coldStorageId: bigint | null;
  vehicleId: bigint | null;
  destinationId: bigint | null;
  scheduledAt: Date;
  completedAt: Date | null;
  notes: string | null;
}>) {
  return JSON.stringify(steps.map((step) => [
    step.sequence,
    step.actionType,
    step.batchId.toString(),
    step.coldStorageId?.toString() ?? null,
    step.vehicleId?.toString() ?? null,
    step.destinationId?.toString() ?? null,
    step.scheduledAt.toISOString(),
    step.completedAt?.toISOString() ?? null,
    step.notes,
  ]));
}

type PlanningClient = Pick<Prisma.TransactionClient, 'batch' | 'coldStorage' | 'vehicle' | 'destination' | 'plan'>;

async function loadPlanningContext(client: PlanningClient, userId: bigint): Promise<PlanningContext> {
  const [batches, coldStorages, vehicles, destinations, activePlan] = await Promise.all([
    client.batch.findMany({
      where: { userId, deletedAt: null, status: { in: [...activeBatchStatuses] } },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        weightKg: true,
        grade: true,
        status: true,
        equivalentQualityAgeDays: true,
        remainingQualityWindowDays: true,
        qualityEstimateStartedAt: true,
        currentTemperatureC: true,
        sensorSessions: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: {
            readings: {
              orderBy: { measuredAt: 'desc' },
              take: recentReadingsPerBatch,
              select: { temperatureC: true, measuredAt: true, receivedAt: true },
            },
          },
        },
      },
    }),
    client.coldStorage.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
    client.vehicle.findMany({ where: { userId }, orderBy: { code: 'asc' } }),
    client.destination.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
    client.plan.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: {
        id: true,
        version: true,
        reason: true,
        steps: { orderBy: { sequence: 'asc' }, select: { sequence: true, actionType: true, batchId: true, coldStorageId: true, vehicleId: true, destinationId: true, scheduledAt: true, status: true, completedAt: true, notes: true } },
      },
    }),
  ]);
  return {
    now: new Date().toISOString(),
    batches: batches.map((batch) => {
      const quality = batch.equivalentQualityAgeDays !== null && batch.remainingQualityWindowDays !== null && batch.qualityEstimateStartedAt && batch.currentTemperatureC !== null ? {
        equivalentQualityAgeDays: batch.equivalentQualityAgeDays,
        remainingQualityWindowDays: batch.remainingQualityWindowDays,
        qualityEstimateStartedAt: batch.qualityEstimateStartedAt.toISOString(),
        currentTemperatureC: batch.currentTemperatureC,
      } : null;
      return {
        id: batch.id.toString(),
        code: batch.code,
        weightKg: batch.weightKg,
        grade: batch.grade,
        status: batch.status as typeof activeBatchStatuses[number],
        quality,
        telemetry: (batch.sensorSessions[0]?.readings ?? []).map((reading) => ({
          temperatureC: reading.temperatureC,
          measuredAt: reading.measuredAt.toISOString(),
          receivedAt: reading.receivedAt.toISOString(),
        })).reverse(),
      };
    }),
    coldStorages: coldStorages.map((resource) => ({
      id: resource.id.toString(),
      name: resource.name,
      capacityKg: resource.capacityKg,
      availableCapacityKg: resource.availableCapacityKg,
      operationalStatus: resource.operationalStatus,
    })),
    vehicles: vehicles.map((resource) => ({
      id: resource.id.toString(),
      code: resource.code,
      capacityKg: resource.capacityKg,
      operationalStatus: resource.operationalStatus,
      delayMinutes: resource.delayMinutes,
      restriction: resource.restriction,
      availabilityStart: resource.availabilityStart?.toISOString().slice(11, 16) ?? null,
      availabilityEnd: resource.availabilityEnd?.toISOString().slice(11, 16) ?? null,
    })),
    destinations: destinations.map((resource) => ({
      id: resource.id.toString(),
      name: resource.name,
      address: resource.address,
      travelMinutes: resource.travelMinutes,
      receivingStart: resource.receivingStart.toISOString().slice(11, 16),
      receivingEnd: resource.receivingEnd.toISOString().slice(11, 16),
      status: resource.status,
      notes: resource.notes,
    })),
    activePlan: activePlan ? {
      id: activePlan.id.toString(),
      version: activePlan.version,
      reason: activePlan.reason,
      steps: activePlan.steps.map(planningStep),
    } : null,
  };
}

function storedProposal(plan: {
  reason: string;
  steps: Array<{
    actionType: AiPlanProposal['steps'][number]['actionType'];
    batchId: bigint;
    coldStorageId: bigint | null;
    vehicleId: bigint | null;
    destinationId: bigint | null;
    scheduledAt: Date;
    notes: string | null;
  }>;
}): AiPlanProposal {
  return {
    reason: plan.reason,
    steps: plan.steps.map((step) => ({
      actionType: step.actionType,
      batchId: step.batchId.toString(),
      scheduledAt: step.scheduledAt.toISOString(),
      ...(step.coldStorageId ? { coldStorageId: step.coldStorageId.toString() } : {}),
      ...(step.vehicleId ? { vehicleId: step.vehicleId.toString() } : {}),
      ...(step.destinationId ? { destinationId: step.destinationId.toString() } : {}),
      ...(step.notes ? { notes: step.notes } : {}),
    })),
  };
}

async function lockApprovalContext(transaction: Prisma.TransactionClient, userId: bigint, planId: bigint) {
  await lockUser(transaction, userId);
  await transaction.$queryRaw`SELECT "id" FROM "plans" WHERE "user_id" = ${userId} AND ("id" = ${planId} OR "status" = 'ACTIVE') FOR UPDATE`;
  await transaction.$queryRaw`SELECT "id" FROM "plan_steps" WHERE "plan_id" IN (SELECT "id" FROM "plans" WHERE "user_id" = ${userId} AND ("id" = ${planId} OR "status" = 'ACTIVE')) FOR UPDATE`;
  await transaction.$queryRaw`SELECT "id" FROM "batches" WHERE "user_id" = ${userId} AND "deleted_at" IS NULL AND "status" IN ('MONITORING', 'ACTIVE', 'INSPECTION_HOLD') FOR UPDATE`;
  await transaction.$queryRaw`SELECT "id" FROM "cold_storages" WHERE "user_id" = ${userId} FOR UPDATE`;
  await transaction.$queryRaw`SELECT "id" FROM "vehicles" WHERE "user_id" = ${userId} FOR UPDATE`;
  await transaction.$queryRaw`SELECT "id" FROM "destinations" WHERE "user_id" = ${userId} FOR UPDATE`;
}

export class PlanRepository implements PlanRepositoryPort {
  constructor(private readonly database: Database) {}

  async list(userId: bigint) {
    const [activePlan, plans] = await this.database.$transaction(async (transaction) => {
      const active = await transaction.plan.findFirst({ where: { userId, status: 'ACTIVE' }, include: planInclude });
      const others = await transaction.plan.findMany({ where: { userId, status: { not: 'ACTIVE' } }, orderBy: { createdAt: 'desc' }, take: maximumListedPlans, include: planInclude });
      return [active, others] as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const serialized = plans.map(serializePlan);
    return {
      updatedAt: new Date().toISOString(),
      activePlan: activePlan ? serializePlan(activePlan) : null,
      proposedPlans: serialized.filter((plan) => plan.status === 'PROPOSED'),
      history: serialized.filter((plan) => plan.status !== 'PROPOSED'),
    };
  }

  loadContext(userId: bigint) {
    return loadPlanningContext(this.database, userId);
  }

  async saveProposal(userId: bigint, proposal: AiPlanProposal, expectedActivePlan: PlanningActivePlan | null) {
    return this.database.$transaction(async (transaction) => {
      await lockUser(transaction, userId);
      const activePlan = await transaction.plan.findFirst({
        where: { userId, status: 'ACTIVE' },
        select: {
          id: true,
          version: true,
          reason: true,
          steps: {
            orderBy: { sequence: 'asc' },
            select: { sequence: true, actionType: true, batchId: true, coldStorageId: true, vehicleId: true, destinationId: true, scheduledAt: true, status: true, completedAt: true, notes: true },
          },
        },
      });
      const currentSnapshot = activePlan ? {
        id: activePlan.id.toString(),
        version: activePlan.version,
        reason: activePlan.reason,
        steps: activePlan.steps.map(planningStep),
      } : null;
      if (activePlanSnapshot(currentSnapshot) !== activePlanSnapshot(expectedActivePlan)) throw new ConflictError('Active plan changed while generating the proposal');
      const latest = await transaction.plan.aggregate({ where: { userId }, _max: { version: true } });
      const completed = activePlan?.steps.filter((step) => step.status === 'COMPLETED') ?? [];
      const nextSequence = completed.reduce((maximum, step) => Math.max(maximum, step.sequence), 0) + 1;
      return serializePlan(await transaction.plan.create({
        data: {
          userId,
          version: (latest._max.version ?? 0) + 1,
          status: 'PROPOSED',
          previousPlanId: activePlan?.id ?? null,
          reason: proposal.reason,
          steps: {
            create: [
              ...completed.map((step) => ({ ...step, status: 'COMPLETED' as const })),
              ...proposal.steps.map((step, index) => proposalStep(step, nextSequence + index)),
            ],
          },
        },
        include: planInclude,
      }));
    });
  }

  async activateProposal(userId: bigint, planId: bigint, validate: PlanValidator) {
    return this.database.$transaction(async (transaction) => {
      await lockApprovalContext(transaction, userId, planId);
      const proposal = await transaction.plan.findFirst({
        where: { id: planId, userId },
        select: {
          status: true,
          previousPlanId: true,
          reason: true,
          steps: { orderBy: { sequence: 'asc' }, select: { sequence: true, status: true, actionType: true, batchId: true, coldStorageId: true, vehicleId: true, destinationId: true, scheduledAt: true, completedAt: true, notes: true } },
        },
      });
      if (!proposal) throw new NotFoundError('Plan');
      if (proposal.status !== 'PROPOSED') throw new ConflictError('Plan is not a proposal');
      const context = await loadPlanningContext(transaction, userId);
      const errors = validate(storedProposal({ reason: proposal.reason, steps: proposal.steps.filter((step) => step.status === 'UPCOMING') }), context);
      if (errors.length) throw new ConflictError('Plan proposal is no longer feasible');
      const activePlanId = context.activePlan?.id ?? null;
      if ((proposal.previousPlanId?.toString() ?? null) !== activePlanId) throw new ConflictError('Plan proposal is stale');
      const completed = proposal.steps.filter((step) => step.status === 'COMPLETED');
      const activeCompleted = context.activePlan?.steps.filter((step) => step.status === 'COMPLETED').map((step) => ({
        ...step,
        batchId: BigInt(step.batchId),
        coldStorageId: step.coldStorageId ? BigInt(step.coldStorageId) : null,
        vehicleId: step.vehicleId ? BigInt(step.vehicleId) : null,
        destinationId: step.destinationId ? BigInt(step.destinationId) : null,
        scheduledAt: new Date(step.scheduledAt),
        completedAt: step.completedAt ? new Date(step.completedAt) : null,
      })) ?? [];
      if (completedFacts(completed) !== completedFacts(activeCompleted)) throw new ConflictError('Plan proposal is stale');
      if (activePlanId) await transaction.plan.update({ where: { id: BigInt(activePlanId) }, data: { status: 'SUPERSEDED' } });
      return serializePlan(await transaction.plan.update({
        where: { id: planId },
        data: { status: 'ACTIVE', approvedAt: new Date(), approvedById: userId },
        include: planInclude,
      }));
    });
  }

  async dismissProposal(userId: bigint, planId: bigint) {
    return this.database.$transaction(async (transaction) => {
      await lockUser(transaction, userId);
      const proposal = await transaction.plan.findFirst({ where: { id: planId, userId } });
      if (!proposal) throw new NotFoundError('Plan');
      if (proposal.status !== 'PROPOSED') throw new ConflictError('Plan is not a proposal');
      return serializePlan(await transaction.plan.update({ where: { id: planId }, data: { status: 'DISMISSED' }, include: planInclude }));
    });
  }

  async completeStep(userId: bigint, planId: bigint, stepId: bigint) {
    return this.database.$transaction(async (transaction) => {
      await lockUser(transaction, userId);
      await transaction.$queryRaw`SELECT ps."id" FROM "plan_steps" ps JOIN "plans" p ON p."id" = ps."plan_id" WHERE p."user_id" = ${userId} AND p."id" = ${planId} AND ps."id" = ${stepId} FOR UPDATE OF p, ps`;
      const plan = await transaction.plan.findFirst({ where: { id: planId, userId }, select: { status: true } });
      if (!plan) throw new NotFoundError('Plan');
      const step = await transaction.planStep.findFirst({ where: { id: stepId, planId }, select: { status: true } });
      if (!step) throw new NotFoundError('Plan step');
      if (plan.status !== 'ACTIVE') throw new ConflictError('Plan is not active');
      if (step.status !== 'UPCOMING') throw new ConflictError('Plan step is not upcoming');
      await transaction.planStep.update({ where: { id: stepId }, data: { status: 'COMPLETED', completedAt: new Date() } });
      return serializePlan(await transaction.plan.findUniqueOrThrow({ where: { id: planId }, include: planInclude }));
    });
  }
}
