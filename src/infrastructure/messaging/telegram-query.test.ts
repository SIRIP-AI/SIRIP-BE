import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from '../persistence/database';
import { telegramExtraction } from './telegram-extractor';
import { executeTelegramQuery } from './telegram-query';

function databaseWithStorages(storages: unknown[]) {
  let where: unknown;
  const database = { coldStorage: { findMany: async (query: { where: unknown }) => { where = query.where; return storages; } } } as unknown as Database;
  return { database, where: () => where };
}

test('filtered storage count uses authoritative batch occupancy and user scope', async () => {
  const memory = databaseWithStorages([
    { name: 'A', capacityKg: 1_000, operationalStatus: 'AVAILABLE', currentBatches: [{ weightKg: 300 }] },
    { name: 'B', capacityKg: 600, operationalStatus: 'AVAILABLE', currentBatches: [{ weightKg: 500 }] },
  ]);

  const result = await executeTelegramQuery(memory.database, 9n, { dataset: 'storage', operation: 'COUNT', metric: 'availableCapacityKg', operator: 'GT', threshold: 500, status: null });

  assert.deepEqual(memory.where(), { userId: 9n });
  assert.equal((result.facts as { count: number }).count, 1);
  assert.equal(result.fallback, 'Found 1 storage.');
});

test('storage totals sum computed occupied capacity', async () => {
  const memory = databaseWithStorages([
    { name: 'A', capacityKg: 1_000, operationalStatus: 'AVAILABLE', currentBatches: [{ weightKg: 300 }, { weightKg: 125.5 }] },
    { name: 'B', capacityKg: 600, operationalStatus: 'AVAILABLE', currentBatches: [{ weightKg: 100 }] },
  ]);

  const result = await executeTelegramQuery(memory.database, 9n, { dataset: 'storage', operation: 'SUM', metric: 'occupiedCapacityKg', operator: null, threshold: null, status: null });

  assert.equal((result.facts as { total: number }).total, 525.5);
  assert.equal(result.fallback, 'Total occupied capacity: 525.5 kg.');
});

test('ambiguous storage threshold is a valid clarification extraction', () => {
  const parsed = telegramExtraction.parse({ intent: 'QUERY', queryKind: null, query: { dataset: 'storage', operation: 'COUNT', metric: null, operator: null, threshold: null, status: null }, entityType: 'storage', entityCode: null, entityName: null, planRef: null, delayMinutes: null, status: null, instruction: null, missingFields: ['queryMetric'] });
  assert.deepEqual(parsed.missingFields, ['queryMetric']);
});

test('plan timing filters remain separate from lifecycle status', async () => {
  const database = { plan: { findMany: async () => [
    { version: 1, status: 'ACTIVE', timingStatus: 'DELAYED', delayedBySeconds: 900 },
    { version: 2, status: 'PROPOSED', timingStatus: 'ON_TIME', delayedBySeconds: 0 },
  ] } } as unknown as Database;

  const result = await executeTelegramQuery(database, 9n, { dataset: 'plan', operation: 'COUNT', metric: null, operator: null, threshold: null, status: 'DELAYED' });

  assert.equal((result.facts as { count: number }).count, 1);
});
