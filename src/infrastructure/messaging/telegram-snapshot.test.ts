import assert from 'node:assert/strict';
import test from 'node:test';

import type { PlanService } from '../../application/plans/plan-service';
import type { Database } from '../persistence/database';
import { loadTelegramOperationalSnapshot } from './telegram-snapshot';

test('operational snapshot contains scoped current facts and bounds alert text', async () => {
  const queries: unknown[] = [];
  const database = {
    batch: { findMany: async (query: unknown) => { queries.push(query); return [{ code: 'B-01', status: 'ACTIVE', currentTemperatureC: 4.2, remainingQualityWindowDays: 3.5, sensorSessions: [{ sensor: { code: 'S-01' } }] }]; } },
    vehicle: { findMany: async () => [{ code: 'TR-01', operationalStatus: 'AVAILABLE', delayMinutes: 30, capacityKg: 500 }] },
    coldStorage: { findMany: async () => [{ name: 'CR-01', operationalStatus: 'AVAILABLE', capacityKg: 1000, availableCapacityKg: 400 }] },
    destination: { findMany: async () => [{ name: 'Processor A', status: 'AVAILABLE', travelMinutes: 60 }] },
    sensor: { findMany: async (query: unknown) => { queries.push(query); return [{ code: 'S-01', status: 'ASSIGNED', sessions: [{ batch: { code: 'B-01' } }] }]; } },
    operationalEvent: { findMany: async () => [{ type: 'TEMPERATURE_EXCURSION', rawMessage: 'x'.repeat(300), occurredAt: new Date('2026-08-21T10:00:00.000Z') }] },
  } as unknown as Database;
  const plans = { list: async () => ({ updatedAt: '', proposedPlans: [], history: [{ secret: 'excluded' }], activePlans: [{ id: '20', version: 2, status: 'ACTIVE', previousPlanId: null, summary: 'excluded summary', destinationId: '3', deadline: null, createdAt: '', approvedAt: null, completedAt: null, batches: [{ id: '1', code: 'B-01' }], trigger: null, steps: [{ id: '4', sequence: 1, actionType: 'LOAD', scheduledAt: '2026-08-22T10:00:00.000Z', status: 'UPCOMING', completedAt: null, rationale: null, batch: { id: '1', code: 'B-01' }, resources: [{ type: 'VEHICLE', id: '1', name: 'TR-01' }] }] }] }) } as unknown as PlanService;

  const snapshot = await loadTelegramOperationalSnapshot(database, plans, 1n);
  assert.equal(snapshot.plans[0]?.version, 2);
  assert.equal(snapshot.batches[0]?.sensor, 'S-01');
  assert.equal(snapshot.alerts[0]?.summary?.length, 160);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
  assert.ok(queries.every((query) => typeof query === 'object' && query !== null && 'where' in query && JSON.stringify((query as { where: unknown }).where, (_, value) => typeof value === 'bigint' ? value.toString() : value).includes('deletedAt')));
});
