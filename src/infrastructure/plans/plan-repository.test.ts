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
