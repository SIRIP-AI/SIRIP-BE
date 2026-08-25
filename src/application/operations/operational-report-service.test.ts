import assert from 'node:assert/strict';
import test from 'node:test';

import { OperationalReportService } from './operational-report-service';

const reportExtraction = {
  intent: 'REPORT', queryKind: null, query: null, entityType: 'vehicle', entityCode: 'TR-01', entityName: null, planRef: null, delayMinutes: null, status: 'UNAVAILABLE', instruction: null, missingFields: [],
} as const;

test('resolves an owned resource and persists a WEB report atomically', async () => {
  const updates: unknown[] = [];
  let eventData: Record<string, unknown> | undefined;
  const transaction = {
    vehicle: { update: async (value: unknown) => { updates.push(value); } },
    coldStorage: { update: async () => undefined }, destination: { update: async () => undefined }, batch: { update: async () => undefined }, sensor: { update: async () => undefined },
    planBatch: { findFirst: async () => null }, sensorSession: { findFirst: async () => null },
    operationalEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { eventData = data; return { id: 9n }; } },
  };
  const database = {
    vehicle: { findMany: async () => [{ id: 2n, code: 'TR-01' }] },
    coldStorage: { findMany: async () => [] }, destination: { findMany: async () => [] }, batch: { findMany: async () => [] }, sensor: { findMany: async () => [] },
    operationalEvent: { findFirst: async () => null },
    $transaction: async (callback: (value: typeof transaction) => unknown) => callback(transaction),
  };
  const service = new OperationalReportService(database as never);
  const resolved = await service.resolve(1n, reportExtraction as never, 'TR-01 tidak tersedia', new Date('2026-08-24T10:00:00Z'));
  assert.ok('report' in resolved);

  const event = await service.apply(1n, resolved.report, 'WEB', 'web-plan-change:1:key');
  assert.equal(event.id, 9n);
  assert.equal(eventData?.source, 'WEB');
  assert.equal(eventData?.dedupeKey, 'web-plan-change:1:key');
  assert.deepEqual(updates, [{ where: { id: 2n, userId: 1n }, data: { operationalStatus: 'UNAVAILABLE' } }]);
});

test('asks for clarification rather than guessing an unknown resource', async () => {
  const database = {
    vehicle: { findMany: async () => [] }, coldStorage: { findMany: async () => [] }, destination: { findMany: async () => [] }, batch: { findMany: async () => [] }, sensor: { findMany: async () => [] },
  };
  const resolved = await new OperationalReportService(database as never).resolve(1n, reportExtraction as never, 'TR-01 tidak tersedia', new Date());
  assert.deepEqual(resolved, { question: 'Truk terkonfigurasi mana yang dimaksud?' });
});
