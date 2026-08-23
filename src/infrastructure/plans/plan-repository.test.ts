import assert from 'node:assert/strict';
import test from 'node:test';

import { PlanRepository } from './plan-repository';
import type { Database } from '../persistence/database';

function databaseWithUpcoming(upcoming: boolean) {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const storedPlan = {
    id: 10n,
    version: 1,
    status: upcoming ? 'ACTIVE' : 'COMPLETED',
    previousPlanId: null,
    summary: 'Plan',
    destinationId: 3n,
    deadline: new Date('2026-08-21T12:00:00Z'),
    createdAt: new Date('2026-08-20T09:00:00Z'),
    approvedAt: new Date('2026-08-20T09:30:00Z'),
    completedAt: upcoming ? null : new Date('2026-08-20T10:00:00Z'),
    batches: [],
    triggerEvent: null,
    destination: { id: 3n, name: 'Port' },
    steps: [],
  };
  const transaction = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    plan: {
      findFirst: async () => ({ status: 'ACTIVE' }),
      update: async (value: unknown) => { calls.push({ operation: 'plan.update', value }); return storedPlan; },
      updateMany: async (value: unknown) => { calls.push({ operation: 'plan.updateMany', value }); return { count: 1 }; },
      findUniqueOrThrow: async () => storedPlan,
    },
    planStep: {
      findFirst: async ({ where }: { where: { status?: string } }) => where.status === 'UPCOMING'
        ? (upcoming ? { id: 12n } : null)
        : { status: 'UPCOMING', batch: { deletedAt: null } },
      update: async (value: unknown) => { calls.push({ operation: 'planStep.update', value }); return {}; },
      findMany: async () => [{ vehicleId: 7n }],
    },
    vehicle: {
      updateMany: async (value: unknown) => { calls.push({ operation: 'vehicle.updateMany', value }); return { count: 1 }; },
    },
  };
  const database = {
    $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction),
  } as unknown as Database;
  return { repository: new PlanRepository(database), calls };
}

test('completing a non-final step keeps its plan active', async () => {
  const { repository, calls } = databaseWithUpcoming(true);

  const plan = await repository.completeStep(1n, 10n, 11n);

  assert.equal(plan.status, 'ACTIVE');
  assert.deepEqual(calls.map(({ operation }) => operation), ['planStep.update']);
});

test('completing the final step completes the plan and applies guarded cleanup', async () => {
  const { repository, calls } = databaseWithUpcoming(false);

  await repository.completeStep(1n, 10n, 11n);

  const stepUpdate = calls.find(({ operation }) => operation === 'planStep.update')?.value as { data: { completedAt: Date } };
  const planUpdate = calls.find(({ operation }) => operation === 'plan.update')?.value as { data: { status: string; completedAt: Date } };
  assert.equal(planUpdate.data.status, 'COMPLETED');
  assert.equal(planUpdate.data.completedAt, stepUpdate.data.completedAt);
  assert.deepEqual(calls.find(({ operation }) => operation === 'plan.updateMany')?.value, {
    where: { previousPlanId: 10n, status: 'PROPOSED' },
    data: { status: 'DISMISSED' },
  });
  assert.deepEqual(calls.find(({ operation }) => operation === 'vehicle.updateMany')?.value, {
    where: {
      id: { in: [7n] },
      delayPersistent: false,
      planSteps: { none: { status: 'UPCOMING', plan: { status: 'ACTIVE' } } },
    },
    data: { delayMinutes: 0, delayPersistent: false },
  });
});

test('does not complete a later load before the vehicle return is confirmed', async () => {
  let dependencyWhere: unknown;
  const transaction = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    plan: { findFirst: async () => ({ status: 'ACTIVE' }) },
    planStep: {
      findFirst: async ({ where }: { where: { id?: bigint; actionType?: string } }) => where.id
        ? { status: 'UPCOMING', actionType: 'LOAD', vehicleId: 2n, sequence: 5, scheduledAt: new Date('2026-08-20T16:00:00Z'), batch: { deletedAt: null } }
        : where.actionType === 'RETURN_TO_BASE' ? (dependencyWhere = where, { id: 4n }) : null,
    },
  };
  const database = { $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction) } as unknown as Database;

  await assert.rejects(() => new PlanRepository(database).completeStep(1n, 10n, 5n), /marked returned/);
  assert.deepEqual((dependencyWhere as { plan: unknown }).plan, { userId: 1n, status: 'ACTIVE' });
  assert.deepEqual((dependencyWhere as { scheduledAt: unknown }).scheduledAt, { lte: new Date('2026-08-20T16:00:00Z') });
});

test('does not complete dispatch before its load', async () => {
  const transaction = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    plan: { findFirst: async () => ({ status: 'ACTIVE' }) },
    planStep: {
      findFirst: async ({ where }: { where: { id?: bigint; actionType?: string } }) => where.id
        ? { status: 'UPCOMING', actionType: 'DISPATCH', batchId: 7n, vehicleId: 2n, sequence: 2, scheduledAt: new Date('2026-08-20T13:15:00Z'), batch: { deletedAt: null } }
        : where.actionType === 'LOAD' ? { id: 1n } : null,
    },
  };
  const database = { $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction) } as unknown as Database;

  await assert.rejects(() => new PlanRepository(database).completeStep(1n, 10n, 2n), /marked loaded/);
});

test('planning context reserves other active plans and only completed predecessor holds', async () => {
  const step = (planBatchId: bigint, status: 'UPCOMING' | 'COMPLETED', actionType: 'STORE' | 'LOAD', scheduledAt: string) => ({ actionType, batchId: planBatchId, coldStorageId: actionType === 'STORE' ? 1n : null, vehicleId: actionType === 'LOAD' ? 2n : null, destinationId: null, scheduledAt: new Date(scheduledAt), status, batch: { weightKg: 40 } });
  const database = {
    batch: { findMany: async () => [] },
    coldStorage: { findMany: async () => [{ id: 1n, name: 'Cold', capacityKg: 100, availableCapacityKg: 100, operationalStatus: 'AVAILABLE' }] },
    vehicle: { findMany: async () => [{ id: 2n, code: 'Truck', capacityKg: 100, operationalStatus: 'AVAILABLE', delayMinutes: 0, delayPersistent: false, restriction: null, availabilityStart: null, availabilityEnd: null }] },
    destination: { findMany: async () => [{ id: 3n, name: 'Port', address: 'A', travelMinutes: 60, receivingStart: new Date('1970-01-01T00:00:00Z'), receivingEnd: new Date('1970-01-01T23:59:00Z'), status: 'AVAILABLE', notes: null }] },
    plan: {
      findFirst: async () => ({ id: 10n, version: 1, summary: 'Old', destinationId: 3n, deadline: new Date(Date.now() + 86_400_000), steps: [
        { sequence: 1, ...step(7n, 'COMPLETED', 'STORE', '2026-08-20T10:00:00Z'), completedAt: new Date('2026-08-20T10:05:00Z'), rationale: null },
        { sequence: 2, ...step(7n, 'UPCOMING', 'LOAD', '2026-08-20T14:00:00Z'), completedAt: null, rationale: null },
      ] }),
      findMany: async () => [
        { id: 10n, steps: [step(7n, 'COMPLETED', 'STORE', '2026-08-20T10:00:00Z'), step(7n, 'UPCOMING', 'LOAD', '2026-08-20T14:00:00Z')] },
        { id: 11n, steps: [step(8n, 'UPCOMING', 'STORE', '2026-08-20T12:00:00Z'), step(8n, 'UPCOMING', 'LOAD', '2026-08-20T13:00:00Z')] },
        { id: 12n, steps: [
          { ...step(9n, 'COMPLETED', 'LOAD', '2026-08-20T13:00:00Z'), completedAt: new Date('2026-08-20T13:00:00Z') },
          { actionType: 'DISPATCH', batchId: 9n, coldStorageId: null, vehicleId: 2n, destinationId: 3n, scheduledAt: new Date('2026-08-20T13:15:00Z'), status: 'COMPLETED', completedAt: new Date('2026-08-20T13:15:00Z'), batch: { weightKg: 40 } },
          { actionType: 'RETURN_TO_BASE', batchId: null, coldStorageId: null, vehicleId: 2n, destinationId: 3n, scheduledAt: new Date('2026-08-20T15:15:00Z'), status: 'COMPLETED', completedAt: new Date('2026-08-20T15:30:00Z'), batch: null },
          { ...step(9n, 'UPCOMING', 'LOAD', '2026-08-20T16:00:00Z'), completedAt: null },
        ] },
      ],
    },
  } as unknown as Database;

  const loaded = await new PlanRepository(database).loadContext(1n, [7n], 10n);
  assert.deepEqual(loaded.resourceOccupancies, [
    { resourceType: 'COLD_STORAGE', resourceId: '1', batchId: '7', weightKg: 40, start: '2026-08-20T10:00:00.000Z', end: null },
    { resourceType: 'COLD_STORAGE', resourceId: '1', batchId: '8', weightKg: 40, start: '2026-08-20T12:00:00.000Z', end: '2026-08-20T13:00:00.000Z' },
    { resourceType: 'VEHICLE', resourceId: '2', batchId: '8', weightKg: 40, start: '2026-08-20T13:00:00.000Z', end: null },
    { resourceType: 'VEHICLE', resourceId: '2', batchId: '9', weightKg: 40, start: '2026-08-20T13:00:00.000Z', end: '2026-08-20T15:30:00.000Z' },
    { resourceType: 'VEHICLE', resourceId: '2', batchId: '9', weightKg: 40, start: '2026-08-20T16:00:00.000Z', end: null },
  ]);
});
