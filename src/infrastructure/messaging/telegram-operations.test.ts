import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';

import type { PlanService } from '../../application/plans/plan-service';
import type { PlanView } from '../../domain/plans/plans';
import type { Database } from '../persistence/database';
import { mergeTelegramSlots, parseConversation, recoveredBatchStatus, recoveredSensorStatus, reportOccurrence, resolvePlanReference, telegramPlanTimingText, TelegramOperations, type Conversation } from './telegram-operations';
import type { TelegramExtraction, TelegramInterpretationModel } from './telegram-extractor';

const base: TelegramExtraction = { intent: 'UNKNOWN', queryKind: null, query: null, entityType: null, entityCode: null, entityName: null, planRef: null, delayMinutes: null, status: null, instruction: null, missingFields: [] };
const emptyPlans = { list: async () => ({ activePlans: [], proposedPlans: [], history: [], updatedAt: '' }) } as unknown as PlanService;
const model = (...values: Array<Partial<TelegramExtraction>>): (() => TelegramInterpretationModel) => {
  let index = 0;
  return () => ({ invoke: async () => new AIMessage(JSON.stringify({ ...base, ...values[Math.min(index++, values.length - 1)] })) } as unknown as TelegramInterpretationModel);
};

function memoryDatabase(initial: unknown = null) {
  let conversation: { state: unknown; expiresAt: Date } | null = initial === null ? null : { state: initial, expiresAt: new Date(Date.now() + 60 * 60_000) };
  const database = {
    messagingConversation: {
      findUnique: async () => conversation,
      upsert: async ({ create, update }: { create: { state: unknown; expiresAt: Date }; update: { state: unknown; expiresAt: Date } }) => { conversation = conversation ? update : create; return conversation; },
      deleteMany: async () => { conversation = null; return { count: 1 }; },
    },
    vehicle: { findMany: async () => [{ id: 1n, code: 'TR-01' }] },
    coldStorage: { findMany: async () => [] },
    destination: { findMany: async () => [] },
    batch: { findMany: async () => [] },
    sensor: { findMany: async () => [] },
    operationalEvent: { findMany: async () => [] },
  } as unknown as Database;
  return { database, get: () => conversation };
}

test('conversation parser accepts legacy pending state and validates bounded history', () => {
  assert.deepEqual(parseConversation({ kind: 'PROPOSAL', planId: '31' }), { pending: { kind: 'PROPOSAL', planId: '31' }, messages: [] });
  assert.equal(parseConversation({ pending: null, messages: [{ role: 'user', text: '', timestamp: new Date().toISOString() }] }), null);
});

test('history keeps newest ten total messages and survives service recreation', async () => {
  const memory = memoryDatabase();
  for (let index = 0; index < 6; index += 1) await new TelegramOperations(memory.database, emptyPlans, model({ intent: 'UNKNOWN' })).handle(1n, `message ${index}`, null, new Date(`2026-08-21T10:0${index}:00.000Z`));
  const persisted = parseConversation(memory.get()!.state)!;
  assert.equal(persisted.messages.length, 10);
  assert.equal(persisted.messages[0]!.text, 'message 1');
  await new TelegramOperations(memory.database, emptyPlans, model({ intent: 'UNKNOWN' })).handle(1n, 'after restart', null, new Date('2026-08-21T10:10:00.000Z'));
  assert.equal(parseConversation(memory.get()!.state)!.messages.at(-2)!.text, 'after restart');
});

test('TR-01, 30 minutes extraction produces delay 30 and correction replaces delay 1 preview', async () => {
  const memory = memoryDatabase();
  const operations = new TelegramOperations(memory.database, emptyPlans, model(
    { intent: 'REPORT', entityType: 'vehicle', entityCode: 'TR-01', delayMinutes: 1 },
    { intent: 'REPORT', entityType: 'vehicle', entityCode: 'TR-01', delayMinutes: 30 },
  ));
  const now = new Date();
  await operations.handle(1n, 'TR-01 delayed 1 minute', null, now);
  const reply = await operations.handle(1n, 'correction: TR-01, 30 minutes', null, new Date(now.getTime() + 60_000));
  const pending = parseConversation(memory.get()!.state)!.pending;
  assert.match(reply.text, /30 menit/);
  assert.equal(pending?.kind === 'REPORT_CONFIRM' ? pending.report.value : null, 30);
});

test('Indonesian TR-02 delay extracts to preview, confirms mutation, and flags its active plan', async () => {
  const memory = memoryDatabase();
  let delayMinutes = 0;
  const events: Record<string, unknown>[] = [];
  const database = memory.database as unknown as {
    vehicle: { findMany: () => Promise<Array<{ id: bigint; code: string }>> };
    plan: { findMany: () => Promise<Array<{ id: bigint; version: number }>> };
    $transaction: (operation: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  database.vehicle.findMany = async () => [{ id: 2n, code: 'TR-02' }];
  database.plan = { findMany: async () => [{ id: 30n, version: 3 }] };
  database.$transaction = async (operation) => operation({
    vehicle: { update: async ({ data }: { data: { delayMinutes: number } }) => { delayMinutes = data.delayMinutes; } },
    operationalEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return { id: 41n }; } },
  });
  const plans = { ...emptyPlans, assess: async () => ['Step 1 does not account for vehicle delay'] } as unknown as PlanService;
  const operations = new TelegramOperations(memory.database, plans, model({ intent: 'REPORT', entityType: 'vehicle', entityCode: 'TR-02', delayMinutes: 90, status: 'DELAYED' }));

  const preview = await operations.handle(1n, 'TR-02 telat 90 menit', null, new Date('2026-08-21T10:00:00.000Z'));
  assert.match(preview.text, /TR-02 terlambat 90 menit/);
  assert.match(preview.text, /21 Agu 2026, 17\.00 WIB/);
  assert.doesNotMatch(preview.text, /✅|⚠️|🚨/);
  assert.equal(parseConversation(memory.get()!.state)!.pending?.kind, 'REPORT_CONFIRM');

  const confirmed = await operations.handle(1n, null, 'report:confirm', new Date('2026-08-21T10:01:00.000Z'));
  assert.equal(delayMinutes, 90);
  assert.equal(events[0]?.source, 'TELEGRAM');
  assert.match(confirmed.text, /^✅/);
  assert.match(confirmed.text, /V3.*Perencanaan ulang disarankan/s);
  assert.equal(parseConversation(memory.get()!.state)!.pending?.kind, 'REPLAN');
});

test('adverse monitoring impact requires explicit replan permission and carries trigger event', async () => {
  const memory = memoryDatabase();
  (memory.database as unknown as { plan: { findMany: () => Promise<Array<{ id: bigint; version: number }>> } }).plan = { findMany: async () => [{ id: 30n, version: 3 }] };
  let revisions = 0;
  const plans = { ...emptyPlans, assess: async () => ['quality deadline missed'], revise: async () => { revisions += 1; throw new Error('not expected'); } } as unknown as PlanService;
  const operations = new TelegramOperations(memory.database, plans);
  const reply = await operations.monitoringImpact({ eventId: 41n, userId: 1n, batchId: 7n, batchCode: 'B-101', sensorCode: 'SIM-S-101', type: 'QUALITY_WINDOW', severity: 'WARNING', title: 'Quality window warning', description: '3.8 days remain.' });
  assert.equal(revisions, 0);
  assert.match(reply.text, /^⚠️/);
  assert.match(reply.text, /<b>Quality window warning<\/b>/);
  assert.match(reply.text, /<b>Keparahan<\/b>\nWARNING/);
  assert.match(reply.text, /B-101 · SIM-S-101/);
  assert.match(reply.text, /3\.8 days remain\./);
  assert.match(reply.text, /Usulan tidak akan dibuat kecuali Anda memilih Rencanakan ulang/);
  assert.deepEqual(parseConversation(memory.get()!.state)!.pending, { kind: 'REPLAN', eventId: '41', planIds: ['30'], instruction: 'Revisi langkah mendatang untuk memperhitungkan peringatan pemantauan 41: Quality window warning untuk batch B-101.' });
  assert.equal(reply.buttons?.at(-1)?.[0]?.text, 'Pertahankan rencana saat ini');
});

test('stale monitoring cancel callback cannot clear a newer pending action', async () => {
  const memory = memoryDatabase({ pending: { kind: 'PROPOSAL', planId: '31' }, messages: [] });
  const reply = await new TelegramOperations(memory.database, emptyPlans).handle(1n, null, 'replan:cancel', new Date());
  assert.match(reply.text, /kedaluwarsa/i);
  assert.deepEqual(parseConversation(memory.get()!.state)!.pending, { kind: 'PROPOSAL', planId: '31' });
});

test('truck count scopes rows and pagination to vehicles', async () => {
  const memory = memoryDatabase();
  const database = memory.database as unknown as {
    vehicle: { findMany: () => Promise<unknown[]> };
    coldStorage: { findMany: () => Promise<unknown[]> };
    destination: { findMany: () => Promise<unknown[]> };
  };
  database.vehicle.findMany = async () => [
    { id: 1n, code: 'TR-01', capacityKg: 450, operationalStatus: 'AVAILABLE', delayMinutes: 0 },
    { id: 2n, code: 'TR-02', capacityKg: 250, operationalStatus: 'AVAILABLE', delayMinutes: 0 },
    { id: 3n, code: 'TR-03', capacityKg: 300, operationalStatus: 'AVAILABLE', delayMinutes: 0 },
  ];
  database.coldStorage.findMany = async () => [{ id: 4n, name: 'CR-01', operationalStatus: 'AVAILABLE', capacityKg: 600, currentBatches: [] }];
  database.destination.findMany = async () => [{ id: 5n, name: 'Processor A', status: 'AVAILABLE' }];
  let calls = 0;
  const queryModel = () => ({ invoke: async () => new AIMessage(calls++ === 0
    ? JSON.stringify({ ...base, intent: 'QUERY', queryKind: 'resources', entityType: 'vehicle' })
    : '{"text":"Anda memiliki 3 truk."}') }) as unknown as TelegramInterpretationModel;

  const reply = await new TelegramOperations(memory.database, emptyPlans, queryModel).handle(1n, 'how many trucks do i have', null);

  assert.equal(reply.text, 'Anda memiliki 3 truk.');
  assert.equal(reply.buttons, undefined);
});

test('semantic callback history never stores callback payload', async () => {
  const memory = memoryDatabase({ pending: { kind: 'REPORT_CONFIRM', report: { kind: 'VEHICLE_DELAY', entityId: '1', entityName: 'TR-01', value: 30, occurredAt: '2026-08-21T10:00:00.000Z', rawMessage: 'delay' } }, messages: [] });
  await new TelegramOperations(memory.database, emptyPlans).handle(1n, null, 'report:cancel', new Date('2026-08-21T10:01:00.000Z'));
  const texts = parseConversation(memory.get()!.state)!.messages.map(({ text }) => text);
  assert.equal(texts[0], 'Batalkan laporan');
  assert.ok(!texts.some((text) => text.includes('report:cancel')));
});

test('outbound alert text is persisted as assistant context', async () => {
  const memory = memoryDatabase();
  await new TelegramOperations(memory.database, emptyPlans).recordAssistant(1n, 'SIRIP - TEMPERATURE ALERT', new Date('2026-08-21T10:00:00.000Z'));
  assert.deepEqual(parseConversation(memory.get()!.state)!.messages.map(({ role, text }) => ({ role, text })), [{ role: 'assistant', text: 'SIRIP - TEMPERATURE ALERT' }]);
});

test('missing report fields store structured clarification slots', async () => {
  const memory = memoryDatabase();
  const extraction: Partial<TelegramExtraction> = { intent: 'REPORT', entityType: 'vehicle', delayMinutes: 30, missingFields: ['entity'] };
  const reply = await new TelegramOperations(memory.database, emptyPlans, model(extraction)).handle(1n, 'truck delayed 30 minutes', null, new Date());
  const pending = parseConversation(memory.get()!.state)!.pending;
  assert.match(reply.text, /Truk terkonfigurasi mana/);
  assert.equal(pending?.kind, 'CLARIFY');
  assert.equal(pending?.kind === 'CLARIFY' ? pending.slots.delayMinutes : null, 30);
});

test('provider failure preserves pending and history without mutation or planning', async () => {
  const initial: Conversation = { pending: { kind: 'PROPOSAL', planId: '31' }, messages: [{ role: 'assistant', text: 'proposal', timestamp: '2026-08-21T09:59:00.000Z' }] };
  const memory = memoryDatabase(initial);
  let revisions = 0;
  const plans = { list: emptyPlans.list.bind(emptyPlans), revise: async () => { revisions += 1; throw new Error('unexpected'); } } as unknown as PlanService;
  const unavailable = () => ({ invoke: async () => { throw new Error('fetch failed'); } });
  const reply = await new TelegramOperations(memory.database, plans, unavailable).handle(1n, 'change it', null, new Date());
  const persisted = parseConversation(memory.get()!.state)!;
  assert.match(reply.text, /coba lagi/);
  assert.deepEqual(persisted.pending, initial.pending);
  assert.equal(revisions, 0);
});

test('typed confirmation starts the final approval confirmation for a proposal', async () => {
  const memory = memoryDatabase({ pending: { kind: 'PROPOSAL', planId: '31' }, messages: [] });
  let approvals = 0;
  const plans = { list: emptyPlans.list.bind(emptyPlans), approve: async () => { approvals += 1; throw new Error('unexpected'); } } as unknown as PlanService;
  const reply = await new TelegramOperations(memory.database, plans, model({ intent: 'CONFIRM' })).handle(1n, 'confirm', null, new Date());

  assert.match(reply.text, /<b>Konfirmasi akhir<\/b>/);
  assert.match(reply.text, /gantikan rencana aktif sebelumnya/);
  assert.match(reply.text, /divalidasi ulang sebelum aktivasi/);
  assert.equal(parseConversation(memory.get()!.state)!.pending?.kind, 'APPROVE_CONFIRM');
  assert.equal(approvals, 0);
});

function plan(status: PlanView['status'] = 'ACTIVE'): PlanView {
  return { id: '30', version: 3, status, previousPlanId: null, summary: 'Current route', destinationId: '3', deadline: null, timing: { status: 'ON_TIME', delayedBySeconds: 0, reasons: [] }, createdAt: '2026-08-21T00:00:00.000Z', approvedAt: null, completedAt: null, batches: [{ id: '7', code: 'B-07' }], trigger: null, steps: [] };
}

test('direct replanning remains preview-only until confirmation', async () => {
  const memory = memoryDatabase();
  let revisions = 0;
  const plans = { list: async () => ({ activePlans: [plan()], proposedPlans: [], history: [], updatedAt: '' }), revise: async () => { revisions += 1; throw new Error('unexpected'); } } as unknown as PlanService;
  const reply = await new TelegramOperations(memory.database, plans, model({ intent: 'REPLAN', planRef: '3', instruction: 'use another truck' })).handle(1n, 'replan plan 3 because use another truck', null, new Date('2026-08-21T10:00:00.000Z'));
  assert.match(reply.text, /<b>Pratinjau perencanaan ulang<\/b>/);
  assert.match(reply.text, /Rencana aktif tetap tidak berubah sampai usulan disetujui/);
  assert.equal(revisions, 0);
});

test('unsuccessful replanning keeps the active plan unchanged', async () => {
  const memory = memoryDatabase({ pending: { kind: 'REPLAN_CONFIRM', planId: '30', instruction: 'use another truck' }, messages: [] });
  let dismissals = 0;
  const plans = {
    revise: async () => ({ status: 'NO_VALID_PROPOSAL_FOUND' as const, reason: 'No replacement truck is available.' }),
    dismiss: async () => { dismissals += 1; return plan('DISMISSED'); },
  } as unknown as PlanService;
  const reply = await new TelegramOperations(memory.database, plans).handle(1n, null, 'replan:confirm', new Date());
  assert.match(reply.text, /tetap tidak berubah/);
  assert.equal(dismissals, 0);
  assert.equal(parseConversation(memory.get()!.state)!.pending, null);
});

test('report occurrence and recovery helpers preserve deterministic behavior', () => {
  const receipt = new Date('2026-08-21T10:00:00.000Z');
  assert.equal(reportOccurrence('received now', receipt), receipt);
  assert.equal(reportOccurrence('at 2026-08-20T08:30:00Z', receipt).toISOString(), '2026-08-20T08:30:00.000Z');
  assert.equal(recoveredSensorStatus(true), 'ASSIGNED');
  assert.equal(recoveredSensorStatus(false), 'AVAILABLE');
  assert.equal(recoveredBatchStatus(true), 'ACTIVE');
  assert.equal(recoveredBatchStatus(false), 'MONITORING');
});

test('clarification merge preserves prior report slots and overrides corrections', () => {
  const prior = { ...base, intent: 'REPORT' as const, entityType: 'vehicle' as const, entityCode: 'TR-01', planRef: 'V2', status: 'DELAYED' as const };
  const next = { ...base, intent: 'REPORT' as const, delayMinutes: 30 };
  assert.deepEqual(mergeTelegramSlots(prior, next), { ...prior, delayMinutes: 30 });
});

test('explicit V2 resolves display version 2 rather than database ID 2', () => {
  const byId = { ...plan(), id: '2', version: 9 };
  const byVersion = { ...plan(), id: '30', version: 2 };
  assert.equal(resolvePlanReference([byId, byVersion], 'V2')?.id, '30');
  assert.equal(resolvePlanReference([byId, byVersion], 'plan 2')?.id, '30');
});

test('Telegram plan warnings show exact delay and critical quality reasons', () => {
  const delayed = { ...plan(), timing: { status: 'DELAYED' as const, delayedBySeconds: 5400, reasons: [{ code: 'QUALITY_DEADLINE_MISSED' as const, severity: 'CRITICAL' as const, batchId: '7', vehicleId: '2', destinationId: '3', targetAt: '2026-08-21T10:00:00.000Z', feasibleAt: '2026-08-21T11:30:00.000Z', delaySeconds: 5400, message: 'B-07 diperkirakan tiba 1 jam 30 menit setelah tenggat mutunya.' }] } };
  const text = telegramPlanTimingText(delayed);
  assert.match(text, /WARNING · Rencana terlambat 1 jam 30 menit/);
  assert.match(text, /CRITICAL risiko waktu mutu/);
  assert.match(text, /B-07/);
  assert.match(text, /1 jam 30 menit setelah tenggat mutunya/);
});

test('three-turn delayed report preserves plan and vehicle until duration preview', async () => {
  const memory = memoryDatabase();
  const operations = new TelegramOperations(memory.database, emptyPlans, model(
    { intent: 'REPORT', entityType: 'vehicle', planRef: 'V2', status: 'DELAYED', missingFields: ['entity', 'delayMinutes'] },
    { intent: 'REPORT', entityType: 'vehicle', entityCode: 'TR-01', missingFields: ['delayMinutes'] },
    { intent: 'REPORT', delayMinutes: 30 },
  ));
  assert.match((await operations.handle(1n, 'for plan v2, truck is delayed', null)).text, /Truk terkonfigurasi mana/);
  assert.match((await operations.handle(1n, 'TR-01', null)).text, /Berapa menit/);
  const reply = await operations.handle(1n, '30 minutes', null);
  const pending = parseConversation(memory.get()!.state)!.pending;
  assert.match(reply.text, /TR-01 terlambat 30 menit/);
  assert.equal(pending?.kind === 'REPORT_CONFIRM' ? pending.report.planRef : null, 'V2');
});
