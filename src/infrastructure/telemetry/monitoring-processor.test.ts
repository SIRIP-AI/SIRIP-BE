import assert from 'node:assert/strict';
import test from 'node:test';

import type { Prisma } from '../../generated/prisma/client';
import type { Database } from '../persistence/database';
import { MonitoringProcessor, type MonitoringAlert } from './monitoring-processor';

test('same-key alert notifies only on inactive-to-active transitions', async () => {
  type Event = { id: bigint; dedupeKey: string; structuredData: Prisma.JsonValue; type: string; sensorId: bigint; rawMessage: string; occurredAt: Date };
  const events: Event[] = [];
  const transaction = {
    operationalEvent: {
      findMany: async ({ where }: { where: { dedupeKey: { startsWith: string; not?: { contains: string } } } }) => events
        .filter((event) => event.dedupeKey.startsWith(where.dedupeKey.startsWith) && (!where.dedupeKey.not || !event.dedupeKey.includes(where.dedupeKey.not.contains)))
        .map(({ id, dedupeKey, structuredData }) => ({ id, dedupeKey, structuredData })),
      upsert: async ({ where, create, update }: { where: { dedupeKey: string }; create: Omit<Event, 'id'>; update: Partial<Event> }) => {
        const existing = events.find((event) => event.dedupeKey === where.dedupeKey);
        if (existing) Object.assign(existing, update);
        else events.push({ id: BigInt(events.length + 1), ...create });
        return { id: (existing ?? events.at(-1))!.id };
      },
      update: async ({ where, data }: { where: { id: bigint }; data: { structuredData: Prisma.JsonValue } }) => {
        const event = events.find(({ id }) => id === where.id)!;
        event.structuredData = data.structuredData;
        return event;
      },
    },
  } as unknown as Prisma.TransactionClient;
  const notified: MonitoringAlert[] = [];
  const processor = new MonitoringProcessor({} as Database, { sendMonitoringAlert: async (alert) => { notified.push(alert); } });
  const input = (temperatureC: number) => ({
    userId: 1n,
    batchId: 2n,
    batchCode: 'B-101',
    sensorId: 3n,
    sensorCode: 'SIM-S-101',
    syncedAt: new Date('2026-08-24T12:00:00.000Z'),
    readings: Array.from({ length: 5 }, (_, index) => ({ id: BigInt(index + 1), sequenceNumber: BigInt(index + 1), temperatureC, measuredAt: new Date(Date.UTC(2026, 7, 24, index)) })),
  });

  const first = await processor.processTelemetry(transaction, input(9));
  await processor.notify(first);
  assert.equal(first.length, 1);
  assert.equal(notified.length, 1);

  const unchanged = await processor.processTelemetry(transaction, input(9));
  await processor.notify(unchanged);
  assert.deepEqual(unchanged, []);
  assert.equal(notified.length, 1);

  const resolved = await processor.processTelemetry(transaction, input(2));
  await processor.notify(resolved);
  assert.deepEqual(resolved, []);
  assert.equal((events[0]!.structuredData as { alert: { active: boolean } }).alert.active, false);

  const reactivated = await processor.processTelemetry(transaction, input(9));
  await processor.notify(reactivated);
  assert.equal(reactivated.length, 1);
  assert.equal(reactivated[0]?.eventId, first[0]?.eventId);
  assert.equal(notified.length, 2);
  assert.equal((events[0]!.structuredData as { alert: { active: boolean } }).alert.active, true);
});
