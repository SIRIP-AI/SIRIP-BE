import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from '../persistence/database';
import { ResourceRepository } from './resource-repository';

function vehicle(planSteps: Array<{ id: bigint }>, operationalStatus = 'AVAILABLE') {
  return {
    id: 2n,
    code: 'TR-02',
    capacityKg: 250,
    operationalStatus,
    delayMinutes: 0,
    delayPersistent: false,
    restriction: null,
    availabilityStart: null,
    availabilityEnd: null,
    updatedAt: new Date('2026-08-23T00:00:00.000Z'),
    planSteps,
  };
}

test('vehicle assignment includes vehicle-level return steps', async () => {
  let query: Record<string, unknown> | undefined;
  const database = {
    vehicle: {
      findMany: async (value: Record<string, unknown>) => {
        query = value;
        return [vehicle([{ id: 9n }])];
      },
    },
  } as unknown as Database;

  const [result] = await new ResourceRepository(database).listVehicles(1n);

  assert.equal(result?.status, 'ASSIGNED');
  assert.deepEqual((query?.include as { planSteps: { where: unknown } }).planSteps.where, {
    status: 'UPCOMING',
    plan: { userId: 1n, status: 'ACTIVE' },
    OR: [{ batch: { deletedAt: null } }, { actionType: 'RETURN_TO_BASE', batchId: null }],
  });
});

test('vehicle becomes available only when no upcoming assignment remains', async () => {
  const database = { vehicle: { findMany: async () => [vehicle([])] } } as unknown as Database;

  const [result] = await new ResourceRepository(database).listVehicles(1n);

  assert.equal(result?.status, 'AVAILABLE');
});

test('operational unavailability overrides an upcoming assignment', async () => {
  const database = { vehicle: { findMany: async () => [vehicle([{ id: 9n }], 'UNAVAILABLE')] } } as unknown as Database;

  const [result] = await new ResourceRepository(database).listVehicles(1n);

  assert.equal(result?.status, 'UNAVAILABLE');
});
