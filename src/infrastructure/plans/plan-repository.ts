import { Prisma } from '../../generated/prisma/client';
import { ConflictError, NotFoundError } from '../../domain/errors';
import { planSnapshot, type AiPlanProposal, type PlanActionType, type PlanningActivePlan, type PlanView, type PlanningContext, type PlanningPlanStep, type PlanningResourceOccupancy } from '../../domain/plans/plans';
import type { PlanRepositoryPort } from '../../application/plans/plan-service';
import type { Database } from '../persistence/database';

const activeBatchStatuses = ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] as const;
const maximumListedPlans = 50;
const recentReadingsPerBatch = 24;
const jakartaOffsetMilliseconds = 7 * 60 * 60_000;

function dailyIntervals(now: Date, start: Date, end: Date) {
  const local = new Date(now.getTime() + jakartaOffsetMilliseconds);
  const startMinute = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMinute = end.getUTCHours() * 60 + end.getUTCMinutes();
  return [0, 1, 2].map((day) => {
    const startAt = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, start.getUTCHours() - 7, start.getUTCMinutes()));
    const endAt = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day + (endMinute < startMinute ? 1 : 0), end.getUTCHours() - 7, end.getUTCMinutes()));
    return { start: startAt.toISOString(), end: endAt.toISOString() };
  }).filter(({ end }) => new Date(end) > now).slice(0, 2);
}

const planInclude = {
  destination: { select: { id: true, name: true } },
  batches: { orderBy: { batchId: 'asc' as const }, select: { batch: { select: { id: true, code: true } } } },
  acceptableDestinations: { orderBy: { destinationId: 'asc' as const }, select: { destination: { select: { id: true, name: true } } } },
  triggerEvent: { select: { id: true, type: true, source: true, rawMessage: true, structuredData: true, occurredAt: true } },
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
    summary: plan.summary,
    destinationId: plan.destinationId?.toString() ?? null,
    destinationIds: (plan.acceptableDestinations ?? []).map(({ destination }) => destination.id.toString()),
    deadline: plan.deadline?.toISOString() ?? null,
    createdAt: plan.createdAt.toISOString(),
    approvedAt: plan.approvedAt?.toISOString() ?? null,
    completedAt: plan.completedAt?.toISOString() ?? null,
    batches: plan.batches.map(({ batch }) => ({ id: batch.id.toString(), code: batch.code })),
    trigger: plan.triggerEvent ? {
      id: plan.triggerEvent.id.toString(),
      type: plan.triggerEvent.type,
      source: plan.triggerEvent.source,
      message: eventMessage(plan.triggerEvent),
      occurredAt: plan.triggerEvent.occurredAt.toISOString(),
    } : null,
    steps: plan.steps.map((step) => {
      const resources = [
        ...(step.coldStorage ? [{ type: 'COLD_STORAGE' as const, id: step.coldStorage.id.toString(), name: step.coldStorage.name }] : []),
        ...(step.vehicle ? [{ type: 'VEHICLE' as const, id: step.vehicle.id.toString(), name: step.vehicle.code }] : []),
        ...(step.destination ? [{ type: 'DESTINATION' as const, id: step.destination.id.toString(), name: step.destination.name }] : []),
      ];
      return {
        id: step.id.toString(),
        sequence: step.sequence,
        actionType: step.actionType,
        scheduledAt: step.scheduledAt.toISOString(),
        status: step.status,
        completedAt: step.completedAt?.toISOString() ?? null,
        rationale: step.rationale,
        timingRationale: step.timingRationale,
        latestSafeAt: step.latestSafeAt?.toISOString() ?? null,
        batch: step.batch ? { id: step.batch.id.toString(), code: step.batch.code } : null,
        resources,
      };
    }),
  };
}

function planningStep(step: {
  sequence: number;
  actionType: PlanningPlanStep['actionType'];
  batchId: bigint | null;
  coldStorageId: bigint | null;
  vehicleId: bigint | null;
  destinationId: bigint | null;
  scheduledAt: Date;
  status: PlanningPlanStep['status'];
  completedAt: Date | null;
  rationale: string | null;
  timingRationale?: string | null;
  latestSafeAt?: Date | null;
}): PlanningPlanStep {
  return {
    sequence: step.sequence,
    actionType: step.actionType,
    batchId: step.batchId?.toString() ?? null,
    coldStorageId: step.coldStorageId?.toString() ?? null,
    vehicleId: step.vehicleId?.toString() ?? null,
    destinationId: step.destinationId?.toString() ?? null,
    scheduledAt: step.scheduledAt.toISOString(),
    status: step.status,
    completedAt: step.completedAt?.toISOString() ?? null,
    rationale: step.rationale,
    timingRationale: step.timingRationale,
    latestSafeAt: step.latestSafeAt?.toISOString() ?? null,
  };
}

async function lockUser(transaction: Prisma.TransactionClient, userId: bigint) {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${userId})`;
}

function proposalStep(step: AiPlanProposal['steps'][number], sequence: number) {
  return {
    sequence,
    actionType: step.actionType,
    batchId: step.batchId ? BigInt(step.batchId) : null,
    coldStorageId: step.coldStorageId ? BigInt(step.coldStorageId) : null,
    vehicleId: step.vehicleId ? BigInt(step.vehicleId) : null,
    destinationId: step.destinationId ? BigInt(step.destinationId) : null,
    scheduledAt: new Date(step.scheduledAt),
    status: 'UPCOMING' as const,
    rationale: step.rationale,
    timingRationale: step.timingRationale ?? null,
    latestSafeAt: step.latestSafeAt ? new Date(step.latestSafeAt) : null,
  };
}

type PlanningClient = Pick<Prisma.TransactionClient, 'batch' | 'coldStorage' | 'vehicle' | 'destination' | 'plan'>;

function resourceOccupancies(plans: Array<{
  id: bigint;
  steps: Array<{ actionType: PlanActionType; batchId: bigint | null; coldStorageId: bigint | null; vehicleId: bigint | null; destinationId: bigint | null; scheduledAt: Date; status: PlanningPlanStep['status']; completedAt: Date | null; batch: { weightKg: number } | null }>;
}>, predecessorId: bigint | undefined, travelMinutes: Map<string, number>): PlanningResourceOccupancy[] {
  const occupancies: PlanningResourceOccupancy[] = [];
  for (const plan of plans) {
    const states = new Map<string, { storage?: { resourceId: string; start: string }; vehicle?: { resourceId: string; start: string; weightKg: number; destinationId?: string; dispatchAt?: string; expectedReturnAt?: string } }>();
    for (const step of plan.steps) {
      if (step.status === 'CANCELED' || (plan.id === predecessorId && step.status !== 'COMPLETED')) continue;
      if (step.actionType === 'RETURN_TO_BASE' && step.vehicleId) {
        for (const [batchId, state] of states) if (state.vehicle?.resourceId === step.vehicleId.toString()) {
          if (step.destinationId && state.vehicle.destinationId !== step.destinationId.toString()) continue;
          if (state.vehicle.expectedReturnAt && state.vehicle.expectedReturnAt !== step.scheduledAt.toISOString()) continue;
          occupancies.push({ resourceType: 'VEHICLE', resourceId: state.vehicle.resourceId, batchId, weightKg: state.vehicle.weightKg, start: state.vehicle.start, end: (step.status === 'COMPLETED' ? step.completedAt ?? step.scheduledAt : step.scheduledAt).toISOString(), ...(state.vehicle.destinationId ? { destinationId: state.vehicle.destinationId } : {}), ...(state.vehicle.dispatchAt ? { dispatchAt: state.vehicle.dispatchAt } : {}) });
          state.vehicle = undefined;
        }
        continue;
      }
      if (!step.batchId || !step.batch) continue;
      const batchId = step.batchId.toString();
      const state = states.get(batchId) ?? {};
      if (step.actionType === 'STORE' && step.coldStorageId) state.storage = { resourceId: step.coldStorageId.toString(), start: step.scheduledAt.toISOString() };
      if (step.actionType === 'LOAD' && step.vehicleId) {
        if (state.storage) occupancies.push({ resourceType: 'COLD_STORAGE', resourceId: state.storage.resourceId, batchId, weightKg: step.batch.weightKg, start: state.storage.start, end: step.scheduledAt.toISOString() });
        state.storage = undefined;
        state.vehicle = { resourceId: step.vehicleId.toString(), start: step.scheduledAt.toISOString(), weightKg: step.batch.weightKg };
      }
      if (step.actionType === 'DISPATCH' && step.destinationId && state.vehicle) {
        const travel = travelMinutes.get(step.destinationId.toString());
        state.vehicle.destinationId = step.destinationId.toString();
        state.vehicle.dispatchAt = step.scheduledAt.toISOString();
        if (travel !== undefined) state.vehicle.expectedReturnAt = new Date(step.scheduledAt.getTime() + travel * 2 * 60_000).toISOString();
      }
      states.set(batchId, state);
    }
    for (const [batchId, state] of states) {
      if (state.storage) occupancies.push({ resourceType: 'COLD_STORAGE', resourceId: state.storage.resourceId, batchId, weightKg: plan.steps.find((step) => step.batchId?.toString() === batchId)!.batch!.weightKg, start: state.storage.start, end: null });
      if (state.vehicle) occupancies.push({ resourceType: 'VEHICLE', resourceId: state.vehicle.resourceId, batchId, weightKg: state.vehicle.weightKg, start: state.vehicle.start, end: state.vehicle.expectedReturnAt ?? null, ...(state.vehicle.destinationId ? { destinationId: state.vehicle.destinationId } : {}), ...(state.vehicle.dispatchAt ? { dispatchAt: state.vehicle.dispatchAt } : {}) });
    }
  }
  return occupancies;
}

async function loadPlanningContext(client: PlanningClient, userId: bigint, batchIds: bigint[], planId?: bigint): Promise<PlanningContext> {
  const now = new Date();
  const [batches, coldStorages, vehicles, destinations, currentPlan, activePlans] = await Promise.all([
    client.batch.findMany({
      where: { id: { in: batchIds }, userId, deletedAt: null, status: { in: [...activeBatchStatuses] } },
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
          locationType: true,
          currentColdStorageId: true,
          currentVehicleId: true,
          currentDestinationId: true,
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
    client.coldStorage.findMany({ where: { userId }, orderBy: { name: 'asc' }, include: { currentBatches: { where: { userId, deletedAt: null }, select: { id: true, weightKg: true } } } }),
    client.vehicle.findMany({ where: { userId }, orderBy: { code: 'asc' } }),
    client.destination.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
    planId === undefined ? null : client.plan.findFirst({
      where: { id: planId, userId },
      select: {
        id: true,
        version: true,
        summary: true,
        destinationId: true,
        acceptableDestinations: { select: { destinationId: true } },
        deadline: true,
        steps: { orderBy: { sequence: 'asc' }, select: { sequence: true, actionType: true, batchId: true, coldStorageId: true, vehicleId: true, destinationId: true, scheduledAt: true, status: true, completedAt: true, rationale: true, timingRationale: true, latestSafeAt: true } },
      },
    }),
    client.plan.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { id: true, steps: { orderBy: { sequence: 'asc' }, select: { actionType: true, batchId: true, coldStorageId: true, vehicleId: true, destinationId: true, scheduledAt: true, status: true, completedAt: true, batch: { select: { weightKg: true } } } } },
    }),
  ]);
  return {
    now: now.toISOString(),
    selectedDestinationId: currentPlan?.destinationId?.toString() ?? null,
    acceptableDestinationIds: currentPlan?.acceptableDestinations?.map(({ destinationId }) => destinationId.toString()) ?? [],
    deadline: currentPlan?.deadline?.toISOString() ?? null,
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
        location: batch.locationType === 'COLD_STORAGE' && batch.currentColdStorageId ? { type: 'COLD_STORAGE' as const, resourceId: batch.currentColdStorageId.toString() } : batch.locationType === 'VEHICLE' && batch.currentVehicleId ? { type: 'VEHICLE' as const, resourceId: batch.currentVehicleId.toString() } : batch.locationType === 'DESTINATION' && batch.currentDestinationId ? { type: 'DESTINATION' as const, resourceId: batch.currentDestinationId.toString() } : { type: 'INTAKE' as const },
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
      availableCapacityKg: Math.max(0, resource.capacityKg - (resource.currentBatches ?? []).reduce((total, batch) => total + batch.weightKg, 0)),
      operationalStatus: resource.operationalStatus,
    })),
    vehicles: vehicles.map((resource) => ({
      id: resource.id.toString(),
      code: resource.code,
      capacityKg: resource.capacityKg,
      operationalStatus: resource.operationalStatus,
      delayMinutes: resource.delayMinutes,
      delayPersistent: resource.delayPersistent,
      restriction: resource.restriction,
      availabilityIntervals: resource.availabilityStart && resource.availabilityEnd ? dailyIntervals(now, resource.availabilityStart, resource.availabilityEnd) : null,
    })),
    destinations: destinations.map((resource) => ({
      id: resource.id.toString(),
      name: resource.name,
      address: resource.address,
      travelMinutes: resource.travelMinutes,
      receivingIntervals: dailyIntervals(now, resource.receivingStart, resource.receivingEnd),
      status: resource.status,
      notes: resource.notes,
    })),
    currentPlan: currentPlan ? {
      id: currentPlan.id.toString(),
      version: currentPlan.version,
      summary: currentPlan.summary,
      destinationId: currentPlan.destinationId?.toString() ?? null,
      destinationIds: currentPlan.acceptableDestinations?.map(({ destinationId }) => destinationId.toString()) ?? (currentPlan.destinationId ? [currentPlan.destinationId.toString()] : []),
      deadline: currentPlan.deadline?.toISOString() ?? null,
      steps: currentPlan.steps.map(planningStep),
    } : null,
    resourceOccupancies: (() => {
      const planned = resourceOccupancies(activePlans, planId, new Map(destinations.map((destination) => [destination.id.toString(), destination.travelMinutes])));
      for (const storage of coldStorages) for (const batch of storage.currentBatches ?? []) if (!planned.some((occupancy) => occupancy.resourceType === 'COLD_STORAGE' && occupancy.batchId === batch.id.toString() && occupancy.end === null)) planned.push({ resourceType: 'COLD_STORAGE', resourceId: storage.id.toString(), batchId: batch.id.toString(), weightKg: batch.weightKg, start: now.toISOString(), end: null });
      return planned;
    })(),
  };
}

export class PlanRepository implements PlanRepositoryPort {
  constructor(private readonly database: Database) {}

  async list(userId: bigint) {
    const [activePlans, plans] = await this.database.$transaction(async (transaction) => {
      const active = await transaction.plan.findMany({ where: { userId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, include: planInclude });
      const others = await transaction.plan.findMany({ where: { userId, status: { not: 'ACTIVE' } }, orderBy: { createdAt: 'desc' }, take: maximumListedPlans, include: planInclude });
      return [active, others] as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const serialized = plans.map(serializePlan);
    return {
      updatedAt: new Date().toISOString(),
      activePlans: activePlans.map(serializePlan),
      proposedPlans: serialized.filter((plan) => plan.status === 'PROPOSED'),
      history: serialized.filter((plan) => plan.status !== 'PROPOSED'),
    };
  }

  async get(userId: bigint, planId: bigint) {
    const plan = await this.database.plan.findFirst({ where: { id: planId, userId }, include: planInclude });
    if (!plan) throw new NotFoundError('Plan');
    return serializePlan(plan);
  }

  loadContext(userId: bigint, batchIds: bigint[], planId?: bigint) {
    return loadPlanningContext(this.database, userId, batchIds, planId);
  }

  async saveProposal(userId: bigint, proposal: AiPlanProposal, batchIds: bigint[], destinationIds: bigint[], deadline: string | null, expectedPlan: PlanningActivePlan | null, options: { triggerEventId?: bigint; replaceProposalId?: bigint } = {}) {
    return this.database.$transaction(async (transaction) => {
      await lockUser(transaction, userId);
      if (options.triggerEventId !== undefined) {
        const triggerEvent = await transaction.operationalEvent.findFirst({ where: { id: options.triggerEventId, userId }, select: { id: true } });
        if (!triggerEvent) throw new NotFoundError('Operational event');
      }
      const currentPlan = expectedPlan ? await transaction.plan.findFirst({
        where: { id: BigInt(expectedPlan.id), userId },
        select: {
          id: true,
          status: true,
          previousPlanId: true,
          version: true,
          summary: true,
          destinationId: true,
          acceptableDestinations: { select: { destinationId: true } },
          deadline: true,
          steps: {
            orderBy: { sequence: 'asc' },
            select: { sequence: true, actionType: true, batchId: true, coldStorageId: true, vehicleId: true, destinationId: true, scheduledAt: true, status: true, completedAt: true, rationale: true, timingRationale: true, latestSafeAt: true },
          },
        },
      }) : null;
      const currentSnapshot = currentPlan ? {
        id: currentPlan.id.toString(),
        version: currentPlan.version,
        summary: currentPlan.summary,
        destinationId: currentPlan.destinationId?.toString() ?? null,
        destinationIds: currentPlan.acceptableDestinations?.map(({ destinationId }) => destinationId.toString()) ?? (currentPlan.destinationId ? [currentPlan.destinationId.toString()] : []),
        deadline: currentPlan.deadline?.toISOString() ?? null,
        steps: currentPlan.steps.map(planningStep),
      } : null;
      if (planSnapshot(currentSnapshot) !== planSnapshot(expectedPlan)) throw new ConflictError('Current plan changed while generating the proposal');
      if (currentSnapshot && deadline !== currentSnapshot.deadline) throw new ConflictError('Plan deadline changed while generating the proposal');
      if (currentSnapshot && JSON.stringify(currentSnapshot.destinationIds) !== JSON.stringify(destinationIds.map(String))) throw new ConflictError('Plan destination scope changed while generating the proposal');
      if (options.replaceProposalId !== undefined && (currentPlan?.id !== options.replaceProposalId || currentPlan.status !== 'PROPOSED')) throw new ConflictError('Proposal changed while generating its replacement');
      if (currentPlan && options.replaceProposalId === undefined && currentPlan.status !== 'ACTIVE') throw new ConflictError('Active plan changed while generating its revision');
      const latest = await transaction.plan.aggregate({ where: { userId }, _max: { version: true } });
      const completed = currentPlan?.steps.filter((step) => step.status === 'COMPLETED') ?? [];
      const nextSequence = completed.reduce((maximum, step) => Math.max(maximum, step.sequence), 0) + 1;
      const usedDestinations = [...new Set(proposal.steps.flatMap((step) => step.actionType === 'HANDOVER' && step.destinationId ? [step.destinationId] : []))];
      const saved = await transaction.plan.create({
        data: {
          userId,
          version: (latest._max.version ?? 0) + 1,
          status: 'PROPOSED',
          previousPlanId: currentPlan?.status === 'PROPOSED' ? currentPlan.previousPlanId : currentPlan?.id ?? null,
          triggerEventId: options.triggerEventId ?? null,
          summary: proposal.summary,
          destinationId: usedDestinations.length === 1 ? BigInt(usedDestinations[0]!) : null,
          deadline: deadline ? new Date(deadline) : null,
          batches: { create: batchIds.map((batchId) => ({ batchId })) },
          acceptableDestinations: { create: destinationIds.map((destinationId) => ({ destinationId })) },
          steps: {
            create: [
              ...completed.map((step) => ({ ...step, status: 'COMPLETED' as const })),
              ...proposal.steps.map((step, index) => proposalStep(step, nextSequence + index)),
            ],
          },
        },
        include: planInclude,
      });
      if (options.replaceProposalId !== undefined) await transaction.plan.update({ where: { id: options.replaceProposalId }, data: { status: 'DISMISSED' } });
      return serializePlan(saved);
    });
  }

  async activateProposal(userId: bigint, planId: bigint) {
    return this.database.$transaction(async (transaction) => {
      await lockUser(transaction, userId);
      const proposal = await transaction.plan.findFirst({
        where: { id: planId, userId },
        select: {
          status: true,
          previousPlanId: true,
          batches: { select: { batchId: true } },
        },
      });
      if (!proposal) throw new NotFoundError('Plan');
      if (proposal.status !== 'PROPOSED') throw new ConflictError('Plan is not a proposal');
      const scope = proposal.batches.map(({ batchId }) => batchId);
      if (!scope.length) throw new ConflictError('Plan proposal has no batch scope');
      if (proposal.previousPlanId) {
        const predecessor = await transaction.plan.findUnique({ where: { id: proposal.previousPlanId }, select: { status: true } });
        if (predecessor?.status !== 'ACTIVE') throw new ConflictError('Plan proposal is stale');
      }
      const overlap = await transaction.planBatch.findFirst({ where: { batchId: { in: scope }, plan: { userId, status: 'ACTIVE', ...(proposal.previousPlanId ? { id: { not: proposal.previousPlanId } } : {}) } } });
      if (overlap) throw new ConflictError('A batch is already assigned to another active plan');
      if (proposal.previousPlanId) await transaction.plan.update({ where: { id: proposal.previousPlanId }, data: { status: 'SUPERSEDED' } });
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
      const step = await transaction.planStep.findFirst({ where: { id: stepId, planId }, select: { status: true, actionType: true, batchId: true, coldStorageId: true, vehicleId: true, destinationId: true, sequence: true, scheduledAt: true, batch: { select: { deletedAt: true, weightKg: true, locationType: true, currentColdStorageId: true, currentVehicleId: true, currentDestinationId: true } } } });
      if (!step) throw new NotFoundError('Plan step');
      if (plan.status !== 'ACTIVE') throw new ConflictError('Plan is not active');
      if (step.status !== 'UPCOMING') throw new ConflictError('Plan step is not upcoming');
      if (step.batch?.deletedAt) throw new ConflictError('Plan step batch is no longer active');
      if (step.actionType === 'LOAD' && step.vehicleId) {
        const pendingReturn = await transaction.planStep.findFirst({ where: { vehicleId: step.vehicleId, actionType: 'RETURN_TO_BASE', status: 'UPCOMING', scheduledAt: { lte: step.scheduledAt }, plan: { userId, status: 'ACTIVE' }, OR: [{ planId: { not: planId } }, { planId, sequence: { lt: step.sequence } }] }, select: { id: true } });
        if (pendingReturn) throw new ConflictError('Vehicle must be marked returned before it can be loaded again');
      }
      if (step.actionType === 'DISPATCH' && step.batchId) {
        const pendingLoad = await transaction.planStep.findFirst({ where: { planId, batchId: step.batchId, actionType: 'LOAD', status: 'UPCOMING', sequence: { lt: step.sequence } }, select: { id: true } });
        if (pendingLoad) throw new ConflictError('Batch must be marked loaded before it can be dispatched');
      }
      if (step.actionType === 'HANDOVER' && step.batchId) {
        const pendingDispatch = await transaction.planStep.findFirst({ where: { planId, batchId: step.batchId, actionType: 'DISPATCH', status: 'UPCOMING', sequence: { lt: step.sequence } }, select: { id: true } });
        if (pendingDispatch) throw new ConflictError('Batch must be dispatched before handover');
      }
      if (step.actionType === 'RETURN_TO_BASE' && step.vehicleId) {
        const pendingDispatch = await transaction.planStep.findFirst({ where: { planId, vehicleId: step.vehicleId, actionType: 'DISPATCH', status: 'UPCOMING', sequence: { lt: step.sequence } }, select: { id: true } });
        if (pendingDispatch) throw new ConflictError('Vehicle cannot be marked returned before its dispatch is completed');
      }
      const completedAt = new Date();
      if (step.actionType === 'STORE' && step.batchId && step.coldStorageId && step.batch) {
        if (step.batch.locationType !== 'INTAKE') throw new ConflictError('Only a batch at intake can be stored');
        const storage = await transaction.coldStorage.findFirst({ where: { id: step.coldStorageId, userId, operationalStatus: 'AVAILABLE' }, select: { capacityKg: true } });
        if (!storage) throw new ConflictError('Cold storage is unavailable');
        const occupied = await transaction.batch.aggregate({ where: { userId, deletedAt: null, locationType: 'COLD_STORAGE', currentColdStorageId: step.coldStorageId }, _sum: { weightKg: true } });
        if ((occupied._sum.weightKg ?? 0) + step.batch.weightKg > storage.capacityKg) throw new ConflictError('Cold storage no longer has enough capacity');
        await transaction.batch.update({ where: { id: step.batchId }, data: { locationType: 'COLD_STORAGE', currentColdStorageId: step.coldStorageId, currentVehicleId: null, currentDestinationId: null, locationUpdatedAt: completedAt } });
      }
      if (step.actionType === 'LOAD' && step.batchId && step.vehicleId && step.batch) {
        if (step.batch.locationType !== 'INTAKE' && step.batch.locationType !== 'COLD_STORAGE') throw new ConflictError('Batch is not available for loading');
        const vehicle = await transaction.vehicle.findFirst({ where: { id: step.vehicleId, userId, operationalStatus: 'AVAILABLE' }, select: { capacityKg: true } });
        if (!vehicle) throw new ConflictError('Vehicle is unavailable');
        const loaded = await transaction.batch.aggregate({ where: { userId, deletedAt: null, locationType: 'VEHICLE', currentVehicleId: step.vehicleId }, _sum: { weightKg: true } });
        if ((loaded._sum.weightKg ?? 0) + step.batch.weightKg > vehicle.capacityKg) throw new ConflictError('Vehicle no longer has enough capacity');
        await transaction.batch.update({ where: { id: step.batchId }, data: { locationType: 'VEHICLE', currentColdStorageId: null, currentVehicleId: step.vehicleId, currentDestinationId: null, locationUpdatedAt: completedAt } });
      }
      if (step.actionType === 'HANDOVER' && step.destinationId && step.batch?.locationType === 'DESTINATION' && step.batch.currentDestinationId === step.destinationId) {
        // Dispatch already fulfilled legacy generated handovers.
      } else if ((step.actionType === 'DISPATCH' || step.actionType === 'HANDOVER') && step.batchId && step.vehicleId && step.destinationId && step.batch) {
        if (step.batch.locationType !== 'VEHICLE' || step.batch.currentVehicleId !== step.vehicleId) throw new ConflictError('Batch is not on the planned vehicle');
        await transaction.batch.update({ where: { id: step.batchId }, data: { status: 'HANDED_OVER', handedOverAt: completedAt, locationType: 'DESTINATION', currentColdStorageId: null, currentVehicleId: null, currentDestinationId: step.destinationId, locationUpdatedAt: completedAt } });
        const sessions = await transaction.sensorSession.findMany({ where: { batchId: step.batchId, status: 'ACTIVE' }, select: { sensorId: true } });
        await transaction.sensorSession.updateMany({ where: { batchId: step.batchId, status: 'ACTIVE' }, data: { status: 'COMPLETED', endedAt: completedAt } });
        await transaction.sensor.updateMany({ where: { id: { in: sessions.map(({ sensorId }) => sensorId) } }, data: { status: 'AVAILABLE' } });
      }
      await transaction.planStep.update({ where: { id: stepId }, data: { status: 'COMPLETED', completedAt } });
      const upcoming = await transaction.planStep.findFirst({ where: { planId, status: 'UPCOMING' }, select: { id: true } });
      if (!upcoming) {
        await transaction.plan.update({ where: { id: planId }, data: { status: 'COMPLETED', completedAt } });
        await transaction.plan.updateMany({ where: { previousPlanId: planId, status: 'PROPOSED' }, data: { status: 'DISMISSED' } });
        const vehicles = await transaction.planStep.findMany({ where: { planId, vehicleId: { not: null } }, distinct: ['vehicleId'], select: { vehicleId: true } });
        await transaction.vehicle.updateMany({
          where: {
            id: { in: vehicles.flatMap(({ vehicleId }) => vehicleId === null ? [] : [vehicleId]) },
            delayPersistent: false,
            planSteps: { none: { status: 'UPCOMING', plan: { status: 'ACTIVE' } } },
          },
          data: { delayMinutes: 0, delayPersistent: false },
        });
      }
      return serializePlan(await transaction.plan.findUniqueOrThrow({ where: { id: planId }, include: planInclude }));
    });
  }
}
