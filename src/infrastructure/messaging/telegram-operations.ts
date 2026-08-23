import { Prisma } from '../../generated/prisma/client';
import { ConflictError } from '../../domain/errors';
import type { PlanService } from '../../application/plans/plan-service';
import type { PlanView } from '../../domain/plans/plans';
import type { Database } from '../persistence/database';
import { createTelegramInterpretationModel, extractTelegramRequest, telegramExtraction, type InterpretationMessage, type TelegramExtraction, type TelegramInterpretationModel } from './telegram-extractor';
import { composeTelegramQueryResponse } from './telegram-response-composer';
import { executeTelegramQuery } from './telegram-query';
import { loadTelegramOperationalSnapshot } from './telegram-snapshot';
import type { MonitoringAlert } from '../telemetry/monitoring-processor';

const pageSize = 5;
const conversationLifetimeMs = 30 * 60_000;
const historyLimit = 10;
const maximumHistoryText = 2000;

export type TelegramReply = { text: string; format?: 'HTML'; buttons?: Array<Array<{ text: string; callback_data: string }>> };
type QueryKind = 'batches' | 'plans' | 'steps' | 'alerts' | 'sensors' | 'resources';
type ResourceScope = 'vehicle' | 'storage' | 'destination';
type ReportKind = 'VEHICLE_DELAY' | 'VEHICLE_STATUS' | 'STORAGE_STATUS' | 'DESTINATION_STATUS' | 'BATCH_STATUS' | 'SENSOR_STATUS';
type Report = { kind: ReportKind; entityId: string; entityName: string; value: number | 'AVAILABLE' | 'UNAVAILABLE' | 'INSPECTION_HOLD' | 'ACTIVE' | 'ERROR'; occurredAt: string; rawMessage: string; planRef?: string };
export type State =
  | { kind: 'CLARIFY'; slots: TelegramExtraction; receivedAt: string }
  | { kind: 'REPORT_CONFIRM'; report: Report; slots?: TelegramExtraction }
  | { kind: 'REPLAN'; eventId: string; planIds: string[]; instruction: string }
  | { kind: 'REPLAN_CONFIRM'; planId: string; instruction: string; triggerEventId?: string }
  | { kind: 'PROPOSAL'; planId: string }
  | { kind: 'EDIT_CONFIRM'; planId: string; instruction: string }
  | { kind: 'APPROVE_CONFIRM'; planId: string };

const positiveId = /^[1-9]\d*$/;
const reportKinds: ReportKind[] = ['VEHICLE_DELAY', 'VEHICLE_STATUS', 'STORAGE_STATUS', 'DESTINATION_STATUS', 'BATCH_STATUS', 'SENSOR_STATUS'];
const reportValues: Report['value'][] = ['AVAILABLE', 'UNAVAILABLE', 'INSPECTION_HOLD', 'ACTIVE', 'ERROR'];
export type ChatMessage = InterpretationMessage;
export type Conversation = { pending: State | null; messages: ChatMessage[] };
export type PreparedTelegramTurn = { userId: bigint; input: string; receivedAt: Date; conversation: Conversation; extraction: TelegramExtraction; inbound: ChatMessage };
export type PreparedTelegramResult = { kind: 'READY'; turn: PreparedTelegramTurn } | { kind: 'REPLY'; reply: TelegramReply };

function formatWIB(date: Date | string | null | undefined): string {
  if (!date) return 'never';
  const parsed = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(parsed.getTime())) return 'never';
  return parsed.toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) + ' WIB';
}

function html(value: unknown) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function duration(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return [hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '', remainder ? `${remainder} minute${remainder === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || '0 minutes';
}

export function telegramPlanTimingText(plan: PlanView) {
  if (plan.timing.status === 'ON_TIME') return '';
  const critical = plan.timing.reasons.some(({ severity }) => severity === 'CRITICAL');
  return [`WARNING · PLAN DELAYED ${duration(plan.timing.delayedBySeconds)}`, ...(critical ? ['CRITICAL QUALITY TIMING RISK'] : []), ...plan.timing.reasons.map(({ message }) => `- ${message}`)].join('\n');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textField(value: unknown, maximum = 2000) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}

function reportState(value: unknown): Report | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.kind !== 'string' || !reportKinds.includes(candidate.kind as ReportKind)) return null;
  const entityId = textField(candidate.entityId, 100);
  const entityName = textField(candidate.entityName, 200);
  const occurredAt = textField(candidate.occurredAt, 100);
  const rawMessage = textField(candidate.rawMessage);
  const parsedAt = occurredAt ? new Date(occurredAt) : null;
  const validValue = candidate.kind === 'VEHICLE_DELAY'
    ? typeof candidate.value === 'number' && Number.isInteger(candidate.value) && candidate.value >= 0 && candidate.value <= 100_000
    : candidate.kind === 'BATCH_STATUS'
      ? candidate.value === 'ACTIVE' || candidate.value === 'INSPECTION_HOLD'
      : candidate.kind === 'SENSOR_STATUS'
        ? candidate.value === 'AVAILABLE' || candidate.value === 'ERROR'
        : reportValues.includes(candidate.value as Report['value']) && (candidate.value === 'AVAILABLE' || candidate.value === 'UNAVAILABLE');
  if (!entityId || !positiveId.test(entityId) || !entityName || !parsedAt || Number.isNaN(parsedAt.getTime()) || !rawMessage || !validValue) return null;
  const planRef = candidate.planRef === undefined ? undefined : textField(candidate.planRef, 100);
  if (candidate.planRef !== undefined && !planRef) return null;
  return { kind: candidate.kind as ReportKind, entityId, entityName, value: candidate.value as Report['value'], occurredAt: parsedAt.toISOString(), rawMessage, ...(planRef ? { planRef } : {}) };
}

function state(value: unknown): State | null {
  const candidate = record(value);
  if (!candidate) return null;
  if (candidate.kind === 'CLARIFY') {
    const slots = telegramExtraction.safeParse(candidate.slots); const receivedAt = textField(candidate.receivedAt, 100); const parsed = receivedAt ? new Date(receivedAt) : null;
    return slots.success && parsed && !Number.isNaN(parsed.getTime()) ? { kind: 'CLARIFY', slots: slots.data, receivedAt: parsed.toISOString() } : null;
  }
  if (candidate.kind === 'REPORT_CONFIRM') { const report = reportState(candidate.report); const slots = candidate.slots === undefined ? undefined : telegramExtraction.safeParse(candidate.slots); return report && (slots === undefined || slots.success) ? { kind: 'REPORT_CONFIRM', report, ...(slots?.success ? { slots: slots.data } : {}) } : null; }
  if (candidate.kind === 'REPLAN') {
    const eventId = textField(candidate.eventId, 100);
    const planIds = Array.isArray(candidate.planIds) && candidate.planIds.every((id) => typeof id === 'string' && positiveId.test(id)) ? candidate.planIds as string[] : null;
    const instruction = textField(candidate.instruction);
    return eventId && positiveId.test(eventId) && planIds?.length && instruction ? { kind: 'REPLAN', eventId, planIds, instruction } : null;
  }
  if (candidate.kind === 'REPLAN_CONFIRM' || candidate.kind === 'EDIT_CONFIRM') {
    const planId = textField(candidate.planId, 100); const instruction = textField(candidate.instruction);
    const triggerEventId = candidate.triggerEventId === undefined ? undefined : textField(candidate.triggerEventId, 100);
    if (!planId || !positiveId.test(planId) || !instruction || (triggerEventId !== undefined && (!triggerEventId || !positiveId.test(triggerEventId)))) return null;
    return candidate.kind === 'EDIT_CONFIRM' ? { kind: 'EDIT_CONFIRM', planId, instruction } : { kind: 'REPLAN_CONFIRM', planId, instruction, ...(triggerEventId ? { triggerEventId } : {}) };
  }
  if (candidate.kind === 'PROPOSAL' || candidate.kind === 'APPROVE_CONFIRM') {
    const planId = textField(candidate.planId, 100);
    return planId && positiveId.test(planId) ? { kind: candidate.kind, planId } : null;
  }
  return null;
}

function chatMessage(value: unknown): ChatMessage | null {
  const candidate = record(value);
  const text = textField(candidate?.text, maximumHistoryText);
  const timestamp = textField(candidate?.timestamp, 100);
  const parsed = timestamp ? new Date(timestamp) : null;
  if (!candidate || (candidate.role !== 'user' && candidate.role !== 'assistant') || !text || !parsed || Number.isNaN(parsed.getTime())) return null;
  return { role: candidate.role, text, timestamp: parsed.toISOString() };
}

export function parseConversation(value: unknown): Conversation | null {
  const candidate = record(value);
  if (!candidate) return null;
  if ('pending' in candidate || 'messages' in candidate) {
    if (candidate.pending !== null && state(candidate.pending) === null) return null;
    if (!Array.isArray(candidate.messages)) return null;
    const messages = candidate.messages.map(chatMessage);
    if (messages.some((message) => !message)) return null;
    return { pending: candidate.pending === null ? null : state(candidate.pending), messages: (messages as ChatMessage[]).slice(-historyLimit) };
  }
  const legacy = state(candidate);
  return legacy ? { pending: legacy, messages: [] } : null;
}

export function reportOccurrence(text: string, receivedAt: Date) {
  const match = text.match(/\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}))\b/);
  if (!match?.[1]) return receivedAt;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? receivedAt : parsed;
}

export function recoveredSensorStatus(hasActiveSession: boolean) { return hasActiveSession ? 'ASSIGNED' as const : 'AVAILABLE' as const; }
export function recoveredBatchStatus(hasActivePlan: boolean) { return hasActivePlan ? 'ACTIVE' as const : 'MONITORING' as const; }

export function mergeTelegramSlots(previous: TelegramExtraction, next: TelegramExtraction): TelegramExtraction {
  return {
    intent: next.intent === 'UNKNOWN' ? previous.intent : next.intent,
    queryKind: next.queryKind ?? previous.queryKind,
    query: next.query ?? previous.query,
    entityType: next.entityType ?? previous.entityType,
    entityCode: next.entityCode ?? previous.entityCode,
    entityName: next.entityName ?? previous.entityName,
    planRef: next.planRef ?? previous.planRef,
    delayMinutes: next.delayMinutes ?? previous.delayMinutes,
    status: next.status ?? previous.status,
    instruction: next.instruction ?? previous.instruction,
    missingFields: next.missingFields,
  };
}

function reportSlots(report: Report): TelegramExtraction {
  const entityType = report.kind.startsWith('VEHICLE') ? 'vehicle' : report.kind === 'STORAGE_STATUS' ? 'storage' : report.kind === 'DESTINATION_STATUS' ? 'destination' : report.kind === 'BATCH_STATUS' ? 'batch' : 'sensor';
  const status = report.kind === 'VEHICLE_DELAY' ? 'DELAYED' : report.value === 'AVAILABLE' || report.value === 'ACTIVE' ? 'RECOVERED' : report.value === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'ISSUE';
  return { intent: 'REPORT', queryKind: null, query: null, entityType, entityCode: report.entityName, entityName: null, planRef: report.planRef ?? null, delayMinutes: report.kind === 'VEHICLE_DELAY' ? report.value as number : null, status, instruction: null, missingFields: [] };
}

export function resolvePlanReference(plans: PlanView[], reference: string) {
  const trimmed = reference.trim();
  const normalized = trimmed.toLowerCase();
  const explicitVersion = /^(?:plan\s*)?v\s*(\d+)$/i.exec(trimmed) ?? /^plan\s+(\d+)$/i.exec(trimmed);
  if (explicitVersion?.[1]) {
    const matches = plans.filter((plan) => plan.version === Number(explicitVersion[1]));
    return matches.length === 1 ? matches[0]! : null;
  }
  const batches = plans.filter((plan) => plan.batches.some((batch) => batch.code.toLowerCase() === normalized));
  if (batches.length) return batches.length === 1 ? batches[0]! : null;
  if (/^\d+$/.test(trimmed)) {
    const byId = plans.filter((plan) => plan.id === trimmed);
    if (byId.length) return byId.length === 1 ? byId[0]! : null;
    const byVersion = plans.filter((plan) => plan.version === Number(trimmed));
    return byVersion.length === 1 ? byVersion[0]! : null;
  }
  return null;
}

function proposalText(plan: PlanView) {
  const steps = plan.steps.filter((step) => step.status === 'UPCOMING').map((step) => `${step.sequence}. ${step.actionType} ${step.batch?.code ?? 'vehicle'}${step.resources.length ? ` -> ${step.resources.map((resource) => resource.name).join(' -> ')}` : ''} at ${formatWIB(step.scheduledAt)}`);
  const reason = plan.summary.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (match) => formatWIB(match));
  return [`Plan v${plan.version} proposal`, `Reason: ${reason}`, ...(telegramPlanTimingText(plan) ? ['', telegramPlanTimingText(plan)] : []), ...steps].join('\n');
}

export class TelegramOperations {
  constructor(private readonly database: Database, private readonly plans: PlanService, private readonly model: () => TelegramInterpretationModel = createTelegramInterpretationModel) {}

  async monitoringImpact(alert: MonitoringAlert): Promise<TelegramReply> {
    const affected = await this.database.plan.findMany({ where: { userId: alert.userId, status: 'ACTIVE', batches: { some: { batchId: alert.batchId } } }, orderBy: { version: 'asc' }, select: { id: true, version: true } });
    const heading = `<b>${html(alert.title.toUpperCase())}</b>\n\n<b>Batch</b>\n${html(alert.batchCode)}${alert.sensorCode ? ` · ${html(alert.sensorCode)}` : ''}\n\n<b>Severity</b>\n${alert.severity}\n\n${html(alert.description)}`;
    if (!affected.length) return { format: 'HTML', text: `${heading}\n\n<b>Plan impact</b>\nNo active plan directly includes this batch.` };
    const assessments = await Promise.all(affected.map(async (plan) => ({ ...plan, errors: await this.plans.assess(alert.userId, plan.id) })));
    const impacted = assessments.filter(({ errors }) => errors.length > 0);
    if (!impacted.length) return { format: 'HTML', text: `${heading}\n\n<b>Plan impact</b>\nAffected active plans remain feasible under current deterministic constraints.` };
    const instruction = `Revise future steps to account for monitoring alert ${alert.eventId}: ${alert.title} for batch ${alert.batchCode}.`;
    await this.savePending(alert.userId, { kind: 'REPLAN', eventId: alert.eventId.toString(), planIds: impacted.map(({ id }) => id.toString()), instruction });
    return { format: 'HTML', text: `${heading}\n\n<b>Plan impact</b>\n${impacted.map(({ version }) => `V${version} is no longer valid under current operational constraints.`).join('\n')}\n\n<i>No proposal will be created unless you choose Replan.</i>`, buttons: [...impacted.map((plan) => [{ text: `Replan V${plan.version}`, callback_data: `replan:${plan.id}` }]), [{ text: 'Keep current plan', callback_data: 'replan:cancel' }]] };
  }

  async handle(userId: bigint, text: string | null, callback: string | null, receivedAt = new Date()): Promise<TelegramReply> {
    if (callback) return this.handleCallback(userId, callback, receivedAt);
    const prepared = await this.prepareText(userId, text, receivedAt);
    return prepared.kind === 'REPLY' ? prepared.reply : this.executePrepared(prepared.turn);
  }

  async handleCallback(userId: bigint, callback: string, receivedAt = new Date()): Promise<TelegramReply> {
    const conversation = await this.loadConversation(userId, receivedAt);
    const current = conversation.pending;
    const semantic = this.callbackLabel(callback);
    const reply = await this.callback(userId, callback, current);
    return this.remember(userId, conversation.messages, semantic ? { role: 'user', text: semantic, timestamp: receivedAt.toISOString() } : null, reply, receivedAt);
  }

  async prepareText(userId: bigint, text: string | null, receivedAt = new Date()): Promise<PreparedTelegramResult> {
    const conversation = await this.loadConversation(userId, receivedAt);
    const current = conversation.pending;
    const input = text?.trim() ?? '';
    if (!input) return { kind: 'REPLY', reply: { text: 'Send a question or operational report.' } };
    const snapshot = await loadTelegramOperationalSnapshot(this.database, this.plans, userId);
    const extracted = await extractTelegramRequest(this.model, snapshot, conversation.messages, current, input);
    const inbound: ChatMessage = { role: 'user', text: input.slice(0, maximumHistoryText), timestamp: receivedAt.toISOString() };
    if (!extracted) return { kind: 'REPLY', reply: await this.remember(userId, conversation.messages, inbound, { text: 'I could not interpret that request right now. Please retry.' }, receivedAt, current) };
    return { kind: 'READY', turn: { userId, input, receivedAt, conversation, extraction: extracted, inbound } };
  }

  async executePrepared(turn: PreparedTelegramTurn): Promise<TelegramReply> {
    const { userId, input, receivedAt, conversation, inbound } = turn;
    const current = conversation.pending;
    const extracted = turn.extraction;
    const extraction = current?.kind === 'CLARIFY' ? mergeTelegramSlots(current.slots, extracted) : current?.kind === 'REPORT_CONFIRM' && extracted.intent === 'REPORT' ? mergeTelegramSlots(current.slots ?? reportSlots(current.report), extracted) : extracted;
    const reply = await this.interpreted(userId, input, extraction, current, receivedAt);
    return this.remember(userId, conversation.messages, inbound, reply, receivedAt);
  }

  private async interpreted(userId: bigint, input: string, extraction: TelegramExtraction, current: State | null, receivedAt: Date): Promise<TelegramReply> {
    if (extraction.intent === 'CANCEL') { await this.clearPending(userId); return { text: 'Canceled. No pending action was applied.' }; }
    if (extraction.intent === 'CONFIRM') return this.typedConfirm(userId, current);
    if (current?.kind === 'PROPOSAL' && extraction.intent === 'PROPOSAL_EDIT' && extraction.instruction) {
      await this.savePending(userId, { kind: 'EDIT_CONFIRM', planId: current.planId, instruction: extraction.instruction });
      return { format: 'HTML', text: `<b>PLAN EDIT PREVIEW</b>\n\n<b>Requested change</b>\n${html(extraction.instruction)}\n\n<i>No plan has changed yet.</i>`, buttons: [[{ text: 'Confirm edit', callback_data: 'edit:confirm' }, { text: 'Cancel', callback_data: 'edit:cancel' }]] };
    }
    if (extraction.intent === 'REPLAN') {
      if (!extraction.planRef || !extraction.instruction) return this.clarify(userId, extraction, receivedAt, 'Include the active plan ID/version or exact batch code and the revision instruction.');
      const plan = await this.resolvePlan(userId, extraction.planRef);
      if (!plan) return this.clarify(userId, extraction, receivedAt, 'I could not resolve one active plan. Use its ID/version or an exact batch code.');
      await this.savePending(userId, { kind: 'REPLAN_CONFIRM', planId: plan.id, instruction: extraction.instruction });
      return { format: 'HTML', text: `<b>REPLAN PREVIEW</b>\n\n<b>Plan</b>\nV${plan.version} · ${plan.batches.map((batch) => html(batch.code)).join(', ')}\n\n<b>Instruction</b>\n${html(extraction.instruction)}\n\n<i>The active plan remains unchanged until a proposal is approved.</i>`, buttons: [[{ text: 'Confirm replan', callback_data: 'replan:confirm' }, { text: 'Cancel', callback_data: 'replan:cancel' }]] };
    }
    if (extraction.intent === 'QUERY' && extraction.missingFields.includes('queryMetric')) return this.clarify(userId, extraction, receivedAt, 'Do you mean total, available, or occupied cold-storage capacity?');
    if (extraction.intent === 'QUERY' && extraction.query) {
      const result = await executeTelegramQuery(this.database, userId, extraction.query);
      return { text: await composeTelegramQueryResponse(this.model, input, result.facts, result.fallback) };
    }
    if (extraction.intent === 'QUERY' && extraction.queryKind) {
      const broad = extraction.queryKind === 'batch_detail' ? 'batches' : extraction.queryKind === 'plan_detail' ? 'plans' : extraction.queryKind === 'sensor_detail' ? 'sensors' : extraction.queryKind === 'resource_detail' ? 'resources' : extraction.queryKind;
      if (extraction.queryKind.endsWith('_detail')) {
        const exact = await this.exactQuery(userId, input, extraction);
        if (exact) return { ...exact, text: await composeTelegramQueryResponse(this.model, input, { answer: exact.text }, exact.text) };
      }
      const resourceScope = broad === 'resources' && (extraction.entityType === 'vehicle' || extraction.entityType === 'storage' || extraction.entityType === 'destination') ? extraction.entityType : undefined;
      return this.query(userId, broad as QueryKind, 0, input, resourceScope);
    }
    const reportReceivedAt = current?.kind === 'CLARIFY' ? new Date(current.receivedAt) : receivedAt;
    if (extraction.intent !== 'REPORT') return { text: 'I can query operations, record supported reports, or revise an existing plan.' };
    const parsed = await this.parseReport(userId, extraction, input, reportReceivedAt);
    if ('question' in parsed) {
      await this.savePending(userId, { kind: 'CLARIFY', slots: extraction, receivedAt: reportReceivedAt.toISOString() });
      return { text: parsed.question };
    }
    await this.savePending(userId, { kind: 'REPORT_CONFIRM', report: parsed.report, slots: extraction });
    return { format: 'HTML', text: `<b>REPORT PREVIEW</b>\n\n<b>Reported condition</b>\n${html(this.reportText(parsed.report))}\n\n<b>Occurrence</b>\n${html(formatWIB(parsed.report.occurredAt))}\n\n<i>This report has not been recorded yet.</i>`, buttons: [[{ text: 'Confirm report', callback_data: 'report:confirm' }, { text: 'Cancel', callback_data: 'report:cancel' }]] };
  }

  private async resolvePlan(userId: bigint, reference: string) {
    const list = await this.plans.list(userId);
    return resolvePlanReference(list.activePlans, reference);
  }

  private async exactQuery(userId: bigint, input: string, extraction: TelegramExtraction): Promise<TelegramReply | null> {
    if (/\b(how many|count|jumlah)\b.*\bbatches?\b|\bbatches?\b.*\b(how many|count|jumlah)\b/i.test(input)) {
      const count = await this.database.batch.count({ where: { userId, deletedAt: null } });
      return { text: `${count} batch${count === 1 ? '' : 'es'}.` };
    }
    const batches = await this.database.batch.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, code: true, status: true, currentTemperatureC: true, equivalentQualityAgeDays: true, remainingQualityWindowDays: true, sensorSessions: { where: { status: 'ACTIVE' }, take: 1, select: { sensor: { select: { code: true, status: true } } } } },
    });
    const lowered = (extraction.entityCode ?? extraction.entityName ?? '').toLowerCase();
    const batch = extraction.entityType === 'batch' ? batches.find((item) => item.code.toLowerCase() === lowered) : undefined;
    if (batch) {
      const sensor = batch.sensorSessions[0]?.sensor;
      return { text: `${batch.code}: ${batch.status}\nTemperature: ${batch.currentTemperatureC === null ? 'unknown' : `${batch.currentTemperatureC.toFixed(1)} C`}\nQuality age: ${batch.equivalentQualityAgeDays === null ? 'unknown' : `${batch.equivalentQualityAgeDays.toFixed(1)} days`}\nRemaining quality: ${batch.remainingQualityWindowDays === null ? 'unknown' : `${batch.remainingQualityWindowDays.toFixed(1)} days`}\nSensor: ${sensor ? `${sensor.code} (${sensor.status})` : 'none'}` };
    }
    if (/\b(current|active)\s+plan\b|\bplan\b.*\b(current|active)\b/i.test(input)) {
      const list = await this.plans.list(userId);
      const matches = list.activePlans;
      if (!matches.length) return { text: 'No active plans.' };
      const lines = matches.flatMap((plan) => {
        const reason = plan.summary.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (match) => formatWIB(match));
        return [`Plan v${plan.version} ACTIVE: ${reason}`, ...(telegramPlanTimingText(plan) ? [telegramPlanTimingText(plan)] : []), ...plan.steps.filter((step) => step.status === 'UPCOMING').map((step) => `#${step.sequence} ${step.actionType} ${step.batch?.code ?? 'vehicle'}${step.resources.length ? ` -> ${step.resources.map((resource) => resource.name).join(' -> ')}` : ''} at ${formatWIB(step.scheduledAt)}`)];
      });
      return { text: lines.join('\n') };
    }
    const planReference = extraction.planRef;
    if (planReference) {
      const list = await this.plans.list(userId);
      const plan = resolvePlanReference([...list.activePlans, ...list.proposedPlans, ...list.history], planReference);
      return plan ? { text: proposalText(plan).replace(' proposal', ` ${plan.status}`) } : { text: 'Plan not found.' };
    }
    const sensors = await this.database.sensor.findMany({ where: { userId, deletedAt: null }, select: { code: true, status: true, provisioningStatus: true, lastSeenAt: true, sessions: { where: { status: 'ACTIVE' }, take: 1, select: { batch: { select: { code: true } }, lastSyncedAt: true } } } });
    const sensor = extraction.entityType === 'sensor' ? sensors.find((item) => item.code.toLowerCase() === lowered) : undefined;
    if (sensor) {
      const session = sensor.sessions[0];
      return { text: `${sensor.code}: ${sensor.status}, ${sensor.provisioningStatus}\nBatch: ${session?.batch.code ?? 'unassigned'}\nLast seen: ${formatWIB(sensor.lastSeenAt)}\nLast synced: ${formatWIB(session?.lastSyncedAt)}` };
    }
    if (extraction.entityType === 'vehicle' || extraction.entityType === 'storage' || extraction.entityType === 'destination') {
      const [vehicles, storages, destinations] = await Promise.all([
        this.database.vehicle.findMany({ where: { userId }, select: { code: true, operationalStatus: true, delayMinutes: true } }),
        this.database.coldStorage.findMany({ where: { userId }, select: { name: true, operationalStatus: true, capacityKg: true, currentBatches: { where: { userId, deletedAt: null }, select: { weightKg: true } } } }),
        this.database.destination.findMany({ where: { userId }, select: { name: true, status: true } }),
      ]);
      const vehicle = extraction.entityType === 'vehicle' ? vehicles.find((item) => item.code.toLowerCase() === lowered) : undefined;
      if (vehicle) return { text: `Truck ${vehicle.code}: ${vehicle.operationalStatus}${vehicle.delayMinutes ? `, delayed ${vehicle.delayMinutes} minutes` : ', no delay'}` };
      const storage = extraction.entityType === 'storage' ? storages.find((item) => item.name.toLowerCase() === lowered) : undefined;
      if (storage) return { text: `Storage ${storage.name}: ${storage.operationalStatus}, ${Math.max(0, storage.capacityKg - storage.currentBatches.reduce((sum, batch) => sum + batch.weightKg, 0))}kg free` };
      const destination = extraction.entityType === 'destination' ? destinations.find((item) => item.name.toLowerCase() === lowered) : undefined;
      if (destination) return { text: `Destination ${destination.name}: ${destination.status}` };
    }
    return null;
  }

  private async query(userId: bigint, kind: QueryKind, page: number, question: string, resourceScope?: ResourceScope): Promise<TelegramReply> {
    const rows = await this.queryRows(userId, kind, resourceScope);
    const start = page * pageSize;
    const shown = rows.slice(start, start + pageSize);
    const text = shown.length ? `${kind[0]?.toUpperCase()}${kind.slice(1)} (${start + 1}-${start + shown.length} of ${rows.length})\n${shown.join('\n')}` : `No ${kind} found.`;
    const composed = await composeTelegramQueryResponse(this.model, question, { kind, range: shown.length ? { from: start + 1, to: start + shown.length, total: rows.length } : null, rows: shown }, text);
    const scopeSuffix = kind === 'resources' && resourceScope ? `:${resourceScope}` : '';
    return { text: composed, ...(start + pageSize < rows.length ? { buttons: [[{ text: 'Show more', callback_data: `more:${kind}:${page + 1}${scopeSuffix}` }]] } : {}) };
  }

  private async queryRows(userId: bigint, kind: QueryKind, resourceScope?: ResourceScope): Promise<string[]> {
    if (kind === 'batches') return this.database.batch.findMany({ where: { userId, deletedAt: null }, orderBy: { receivedAt: 'desc' }, select: { code: true, status: true, remainingQualityWindowDays: true } }).then((items) => items.map((item) => `${item.code}: ${item.status}${item.remainingQualityWindowDays === null ? '' : `, ${item.remainingQualityWindowDays.toFixed(1)} days remaining`}`));
    if (kind === 'sensors') return this.database.sensor.findMany({ where: { userId, deletedAt: null }, orderBy: { code: 'asc' }, select: { code: true, status: true, lastSeenAt: true } }).then((items) => items.map((item) => `${item.code}: ${item.status}, last seen ${formatWIB(item.lastSeenAt)}`));
    if (kind === 'alerts') return this.database.operationalEvent.findMany({ where: { userId, structuredData: { path: ['alert', 'active'], equals: true } }, orderBy: { occurredAt: 'desc' }, select: { type: true, rawMessage: true, structuredData: true, occurredAt: true } }).then((items) => items.map((item) => { const data = record(item.structuredData); const alert = record(data?.alert); return `${item.type}: ${typeof alert?.description === 'string' ? alert.description : item.rawMessage ?? 'Active operational alert'} (${formatWIB(item.occurredAt)})`; }));
    if (kind === 'resources') {
      const [vehicles, storages, destinations] = await Promise.all([
        this.database.vehicle.findMany({ where: { userId }, orderBy: { code: 'asc' } }),
        this.database.coldStorage.findMany({ where: { userId }, orderBy: { name: 'asc' }, select: { name: true, operationalStatus: true, capacityKg: true, currentBatches: { where: { userId, deletedAt: null }, select: { weightKg: true } } } }),
        this.database.destination.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
      ]);
      const rows = {
        vehicle: vehicles.map((item) => `Truck ${item.code}: ${item.operationalStatus}${item.delayMinutes ? `, delayed ${item.delayMinutes}m` : ''}`),
        storage: storages.map((item) => `Storage ${item.name}: ${item.operationalStatus}, ${Math.max(0, item.capacityKg - item.currentBatches.reduce((sum, batch) => sum + batch.weightKg, 0))}kg free`),
        destination: destinations.map((item) => `Destination ${item.name}: ${item.status}`),
      };
      return resourceScope ? rows[resourceScope] : [...rows.vehicle, ...rows.storage, ...rows.destination];
    }
    const list = await this.plans.list(userId);
    const plans = [...list.activePlans, ...list.proposedPlans];
    if (kind === 'plans') return plans.map((plan) => {
      const reason = plan.summary.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (match) => formatWIB(match));
      return `v${plan.version} ${plan.status}${plan.timing.status === 'DELAYED' ? `, DELAYED ${duration(plan.timing.delayedBySeconds)}` : ''}: ${plan.batches.map((batch) => batch.code).join(', ')} - ${reason}`;
    });
    return plans.flatMap((plan) => plan.steps.filter((step) => step.status === 'UPCOMING').map((step) => `v${plan.version} #${step.sequence}: ${step.actionType} ${step.batch?.code ?? 'vehicle'}${step.resources.length ? ` -> ${step.resources.map((resource) => resource.name).join(' -> ')}` : ''} at ${formatWIB(step.scheduledAt)}`)).sort();
  }

  private async parseReport(userId: bigint, extraction: TelegramExtraction, text: string, receivedAt: Date): Promise<{ report: Report } | { question: string }> {
    const resources = await Promise.all([
      this.database.vehicle.findMany({ where: { userId }, select: { id: true, code: true } }),
      this.database.coldStorage.findMany({ where: { userId }, select: { id: true, name: true } }),
      this.database.destination.findMany({ where: { userId }, select: { id: true, name: true } }),
      this.database.batch.findMany({ where: { userId, deletedAt: null }, select: { id: true, code: true } }),
      this.database.sensor.findMany({ where: { userId, deletedAt: null }, select: { id: true, code: true } }),
    ]);
    const reference = (extraction.entityCode ?? extraction.entityName ?? '').toLowerCase();
    const matches = <T extends { id: bigint }>(items: T[], name: (item: T) => string) => items.filter((item) => name(item).toLowerCase() === reference);
    const unavailable = extraction.status === 'UNAVAILABLE';
    const recovered = extraction.status === 'RECOVERED';
    const at = reportOccurrence(text, receivedAt).toISOString();
    const make = (kind: ReportKind, item: { id: bigint }, entityName: string, value: Report['value']): { report: Report } => ({ report: { kind, entityId: item.id.toString(), entityName, value, occurredAt: at, rawMessage: text, ...(extraction.planRef ? { planRef: extraction.planRef } : {}) } });
    const vehicles = extraction.entityType === 'vehicle' ? matches(resources[0], (item) => item.code) : [];
    if (extraction.status === 'DELAYED' || extraction.delayMinutes !== null) {
      if (vehicles.length !== 1) return { question: vehicles.length ? 'Which truck did you mean?' : 'Which configured truck is delayed?' };
      if (extraction.delayMinutes === null) return { question: 'How many minutes is the truck delayed?' };
      return make('VEHICLE_DELAY', vehicles[0]!, vehicles[0]!.code, extraction.delayMinutes);
    }
    if (extraction.entityType === 'vehicle') {
      if (vehicles.length !== 1) return { question: 'Which configured truck do you mean?' };
      if (!unavailable && !recovered) return { question: 'Is the truck unavailable or recovered?' };
      return make('VEHICLE_STATUS', vehicles[0]!, vehicles[0]!.code, unavailable ? 'UNAVAILABLE' : 'AVAILABLE');
    }
    const storages = extraction.entityType === 'storage' ? matches(resources[1], (item) => item.name) : [];
    if (extraction.entityType === 'storage') {
      if (storages.length !== 1) return { question: 'Which configured cold storage do you mean?' };
      if (!unavailable && !recovered) return { question: 'Is the cold storage unavailable or recovered?' };
      return make('STORAGE_STATUS', storages[0]!, storages[0]!.name, unavailable ? 'UNAVAILABLE' : 'AVAILABLE');
    }
    const destinations = extraction.entityType === 'destination' ? matches(resources[2], (item) => item.name) : [];
    if (extraction.entityType === 'destination') {
      if (destinations.length !== 1) return { question: 'Which configured destination do you mean?' };
      if (!unavailable && !recovered) return { question: 'Is the destination unavailable or recovered?' };
      return make('DESTINATION_STATUS', destinations[0]!, destinations[0]!.name, unavailable ? 'UNAVAILABLE' : 'AVAILABLE');
    }
    const batches = extraction.entityType === 'batch' ? matches(resources[3], (item) => item.code) : [];
    if (extraction.entityType === 'batch') {
      if (batches.length !== 1) return { question: 'Which active batch do you mean?' };
      if (!extraction.status) return { question: 'Is the batch entering inspection hold or recovering?' };
      return make('BATCH_STATUS', batches[0]!, batches[0]!.code, recovered ? 'ACTIVE' : 'INSPECTION_HOLD');
    }
    const sensors = extraction.entityType === 'sensor' ? matches(resources[4], (item) => item.code) : [];
    if (extraction.entityType === 'sensor') {
      if (sensors.length !== 1) return { question: 'Which configured sensor do you mean?' };
      if (!extraction.status) return { question: 'Is the sensor in error or recovered?' };
      return make('SENSOR_STATUS', sensors[0]!, sensors[0]!.code, recovered ? 'AVAILABLE' : 'ERROR');
    }
    return { question: 'I can query batches, plans, next steps, alerts, sensors, or resources. For a report, include the configured name/code and whether it is delayed, unavailable, affected, or recovered.' };
  }

  private reportText(report: Report) {
    if (report.kind === 'VEHICLE_DELAY') return `${report.entityName} delayed ${report.value} minutes`;
    return `${report.entityName} -> ${report.value}`;
  }

  private clarify(userId: bigint, slots: TelegramExtraction, receivedAt: Date, question: string) {
    return this.savePending(userId, { kind: 'CLARIFY', slots, receivedAt: receivedAt.toISOString() }).then(() => ({ text: question }));
  }

  private async typedConfirm(userId: bigint, current: State | null): Promise<TelegramReply> {
    if (current?.kind === 'REPORT_CONFIRM') return this.confirmReport(userId, current.report);
    if (current?.kind === 'REPLAN_CONFIRM') return this.revise(userId, BigInt(current.planId), current.instruction, current.triggerEventId ? BigInt(current.triggerEventId) : undefined);
    if (current?.kind === 'EDIT_CONFIRM') return this.revise(userId, BigInt(current.planId), current.instruction);
    if (current?.kind === 'REPLAN' && current.planIds.length === 1) return this.revise(userId, BigInt(current.planIds[0]!), current.instruction, BigInt(current.eventId));
    if (current?.kind === 'REPLAN') return { text: 'More than one active plan is affected. Select the plan to revise using the buttons above.' };
    if (current?.kind === 'PROPOSAL') {
      await this.savePending(userId, { kind: 'APPROVE_CONFIRM', planId: current.planId });
      return this.approvalConfirmation(current.planId);
    }
    if (current?.kind === 'APPROVE_CONFIRM') {
      return this.approve(userId, current.planId);
    }
    return { text: 'There is no pending action to confirm.' };
  }

  private callbackLabel(callback: string) {
    if (callback === 'report:confirm') return 'Confirm report';
    if (callback === 'report:cancel') return 'Cancel report';
    if (callback === 'replan:confirm') return 'Confirm replan';
    if (callback === 'replan:cancel') return 'Cancel replan';
    if (callback === 'edit:confirm') return 'Confirm edit';
    if (callback === 'edit:cancel') return 'Cancel edit';
    if (callback === 'proposal:cancel') return 'Cancel approval';
    if (callback.startsWith('approve-final:')) return 'Confirm plan approval';
    if (callback.startsWith('approve:')) return 'Approve proposal';
    if (callback.startsWith('dismiss:')) return 'Dismiss proposal';
    if (callback.startsWith('replan:')) return 'Select plan revision';
    if (callback.startsWith('more:')) return 'Show more';
    return null;
  }

  private async callback(userId: bigint, callback: string, current: State | null): Promise<TelegramReply> {
    const more = /^more:(batches|plans|steps|alerts|sensors|resources):(\d+)(?::(vehicle|storage|destination))?$/.exec(callback);
    if (more?.[1] && more[2]) return this.query(userId, more[1] as QueryKind, Number(more[2]), 'Show more', more[3] as ResourceScope | undefined);
    if (callback === 'report:cancel') { await this.clearPending(userId); return { text: 'Report canceled. No operational state changed.' }; }
    if (callback === 'report:confirm' && current?.kind === 'REPORT_CONFIRM') return this.confirmReport(userId, current.report);
    if (callback === 'replan:cancel' && (current?.kind === 'REPLAN' || current?.kind === 'REPLAN_CONFIRM')) { await this.clearPending(userId); return { text: 'Canceled. No planner request was made.' }; }
    if (callback === 'edit:cancel' && current?.kind === 'EDIT_CONFIRM') { await this.clearPending(userId); return { text: 'Canceled. No planner request was made.' }; }
    if (callback === 'replan:confirm' && current?.kind === 'REPLAN_CONFIRM') return this.revise(userId, BigInt(current.planId), current.instruction, current.triggerEventId ? BigInt(current.triggerEventId) : undefined);
    if (callback === 'edit:confirm' && current?.kind === 'EDIT_CONFIRM') return this.revise(userId, BigInt(current.planId), current.instruction);
    if (callback.startsWith('replan:') && current?.kind === 'REPLAN') {
      const planId = callback.slice(7);
      if (!current.planIds.includes(planId)) return { text: 'This action has expired.' };
      return this.revise(userId, BigInt(planId), current.instruction, BigInt(current.eventId));
    }
    if (callback.startsWith('approve:') && current?.kind === 'PROPOSAL' && callback.slice(8) === current.planId) {
      await this.savePending(userId, { kind: 'APPROVE_CONFIRM', planId: current.planId });
      return this.approvalConfirmation(current.planId);
    }
    if (callback.startsWith('approve-final:') && current?.kind === 'APPROVE_CONFIRM' && callback.slice(14) === current.planId) {
      return this.approve(userId, current.planId);
    }
    if (callback.startsWith('dismiss:') && current?.kind === 'PROPOSAL' && callback.slice(8) === current.planId) {
      const plan = await this.plans.dismiss(userId, BigInt(current.planId)); await this.clearPending(userId); return { text: `Plan v${plan.version} was dismissed.` };
    }
    if (callback === 'proposal:cancel') { await this.clearPending(userId); return { text: 'Approval canceled. The proposal remains pending.' }; }
    return { text: 'This action has expired. Send your request again.' };
  }

  private async confirmReport(userId: bigint, report: Report): Promise<TelegramReply> {
    const entityId = BigInt(report.entityId);
    const event = await this.database.$transaction(async (transaction) => {
      const data: Prisma.OperationalEventCreateInput = { type: this.eventType(report.kind), source: 'TELEGRAM', rawMessage: report.rawMessage, occurredAt: new Date(report.occurredAt), structuredData: { report: { kind: report.kind, value: report.value } }, user: { connect: { id: userId } } };
      if (report.kind === 'VEHICLE_DELAY' || report.kind === 'VEHICLE_STATUS') { await transaction.vehicle.update({ where: { id: entityId, userId }, data: report.kind === 'VEHICLE_DELAY' ? { delayMinutes: report.value as number } : { operationalStatus: report.value as 'AVAILABLE' | 'UNAVAILABLE' } }); data.vehicle = { connect: { id: entityId } }; }
      if (report.kind === 'STORAGE_STATUS') { await transaction.coldStorage.update({ where: { id: entityId, userId }, data: { operationalStatus: report.value as 'AVAILABLE' | 'UNAVAILABLE' } }); data.coldStorage = { connect: { id: entityId } }; }
      if (report.kind === 'DESTINATION_STATUS') { await transaction.destination.update({ where: { id: entityId, userId }, data: { status: report.value as 'AVAILABLE' | 'UNAVAILABLE' } }); data.destination = { connect: { id: entityId } }; }
      if (report.kind === 'BATCH_STATUS') {
        const recoveredStatus = report.value === 'ACTIVE'
          ? await transaction.planBatch.findFirst({ where: { batchId: entityId, plan: { userId, status: 'ACTIVE' } }, select: { batchId: true } }).then((active) => recoveredBatchStatus(!!active))
          : 'INSPECTION_HOLD' as const;
        await transaction.batch.update({ where: { id: entityId, userId, deletedAt: null }, data: { status: recoveredStatus } }); data.batch = { connect: { id: entityId } };
      }
      if (report.kind === 'SENSOR_STATUS') {
        const recoveredStatus = report.value === 'AVAILABLE'
          ? await transaction.sensorSession.findFirst({ where: { sensorId: entityId, status: 'ACTIVE', batch: { userId, deletedAt: null } }, select: { id: true } }).then((session) => recoveredSensorStatus(!!session))
          : 'ERROR' as const;
        await transaction.sensor.update({ where: { id: entityId, userId, deletedAt: null }, data: { status: recoveredStatus } }); data.sensor = { connect: { id: entityId } };
      }
      return transaction.operationalEvent.create({ data, select: { id: true } });
    });
    const affected = await this.database.plan.findMany({ where: { userId, status: 'ACTIVE', steps: { some: { status: 'UPCOMING', ...(report.kind.startsWith('VEHICLE') ? { vehicleId: entityId } : report.kind === 'STORAGE_STATUS' ? { coldStorageId: entityId } : report.kind === 'DESTINATION_STATUS' ? { destinationId: entityId } : report.kind === 'BATCH_STATUS' ? { batchId: entityId } : { batch: { sensorSessions: { some: { sensorId: entityId, status: 'ACTIVE' } } } }) } } }, orderBy: { version: 'asc' }, select: { id: true, version: true } });
    if (!affected.length || report.value === 'AVAILABLE' || report.value === 'ACTIVE' || report.value === 0) { await this.clearPending(userId); return { format: 'HTML', text: `<b>REPORT RECORDED</b>\n\n${html(this.reportText(report))}\n\n<b>Plan impact</b>\nNo active plan has an affected upcoming step.` }; }
    const instruction = `Revise future steps to account for this confirmed operational report: ${this.reportText(report)}.`;
    const assessments = await Promise.all(affected.map(async (plan) => ({ ...plan, errors: await this.plans.assess(userId, plan.id) })));
    await this.savePending(userId, { kind: 'REPLAN', eventId: event.id.toString(), planIds: affected.map((plan) => plan.id.toString()), instruction });
    const assessmentText = assessments.map((plan) => `<b>V${plan.version}</b> · ${plan.errors.length ? 'Replanning recommended\nThe confirmed condition makes one or more upcoming steps infeasible under current operational constraints.' : 'Current plan remains feasible\nIts upcoming steps still satisfy current timing, resource, destination, and quality constraints.'}`).join('\n\n');
    return { format: 'HTML', text: `<b>PLAN IMPACT</b>\n\n<b>Report recorded</b>\n${html(this.reportText(report))}\n\n${assessmentText}\n\n<i>You can revise a plan even when it remains feasible.</i>`, buttons: [...affected.map((plan) => [{ text: assessments.find(({ id }) => id === plan.id)!.errors.length ? `Revise V${plan.version}` : `Replan V${plan.version} anyway`, callback_data: `replan:${plan.id}` }]), [{ text: 'Keep current plan', callback_data: 'replan:cancel' }]] };
  }

  private eventType(kind: ReportKind): 'TRUCK_DELAY' | 'STORAGE_CHANGE' | 'DESTINATION_CHANGE' | 'INSPECTION_HOLD' | 'OTHER' {
    if (kind.startsWith('VEHICLE')) return 'TRUCK_DELAY';
    if (kind === 'STORAGE_STATUS') return 'STORAGE_CHANGE';
    if (kind === 'DESTINATION_STATUS') return 'DESTINATION_CHANGE';
    if (kind === 'BATCH_STATUS') return 'INSPECTION_HOLD';
    return 'OTHER';
  }

  private async revise(userId: bigint, planId: bigint, instruction: string, triggerEventId?: bigint): Promise<TelegramReply> {
    const result = await this.plans.revise(userId, planId, instruction, triggerEventId);
    if (result.status === 'NO_VALID_PROPOSAL_FOUND') {
      await this.clearPending(userId);
      return { text: `No valid revision proposal was found: ${result.reason}\n\nThe active plan remains unchanged.` };
    }
    await this.savePending(userId, { kind: 'PROPOSAL', planId: result.proposal.id });
    return { format: 'HTML', text: `<b>REVISION PROPOSAL · V${result.proposal.version}</b>\n\n${html(proposalText(result.proposal).split('\n').slice(1).join('\n'))}\n\n<i>The active plan remains unchanged until final approval.</i>\nReply with a natural-language edit or choose an action.`, buttons: [[{ text: 'Approve', callback_data: `approve:${result.proposal.id}` }, { text: 'Dismiss', callback_data: `dismiss:${result.proposal.id}` }]] };
  }

  private approvalConfirmation(planId: string): TelegramReply {
    return { format: 'HTML', text: '<b>FINAL CONFIRMATION</b>\n\nActivate this proposal and supersede its active predecessor?\n\n<i>Current operational facts will be revalidated before activation.</i>', buttons: [[{ text: 'Yes, approve', callback_data: `approve-final:${planId}` }, { text: 'Cancel', callback_data: 'proposal:cancel' }]] };
  }

  private async approve(userId: bigint, planId: string): Promise<TelegramReply> {
    try {
      const plan = await this.plans.approve(userId, BigInt(planId));
      await this.clearPending(userId);
      return { format: 'HTML', text: `<b>PLAN ACTIVATED</b>\n\nPlan <b>V${plan.version}</b> is now active. Its predecessor has been superseded.` };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      await this.clearPending(userId);
      return { format: 'HTML', text: '<b>PROPOSAL EXPIRED</b>\n\nOperational conditions changed and this proposal is no longer valid. The active plan remains unchanged.\n\nRequest a new revision using the latest facts.' };
    }
  }

  private async loadConversation(userId: bigint, now: Date): Promise<Conversation> {
    const record = await this.database.messagingConversation.findUnique({ where: { userId_channel: { userId, channel: 'TELEGRAM' } } });
    if (!record) return { pending: null, messages: [] };
    if (record.expiresAt <= now) { await this.deleteConversation(userId); return { pending: null, messages: [] }; }
    const parsed = parseConversation(record.state);
    if (!parsed) { await this.deleteConversation(userId); return { pending: null, messages: [] }; }
    return parsed;
  }
  private async savePending(userId: bigint, pending: State | null) {
    const current = await this.loadConversation(userId, new Date());
    return this.saveConversation(userId, { pending, messages: current.messages }, new Date());
  }
  private clearPending(userId: bigint) { return this.savePending(userId, null); }
  private saveConversation(userId: bigint, value: Conversation, now: Date) {
    const expiresAt = new Date(now.getTime() + conversationLifetimeMs);
    return this.database.messagingConversation.upsert({ where: { userId_channel: { userId, channel: 'TELEGRAM' } }, create: { userId, channel: 'TELEGRAM', state: value, expiresAt }, update: { state: value, expiresAt } });
  }
  private async remember(userId: bigint, prior: ChatMessage[], inbound: ChatMessage | null, reply: TelegramReply, now: Date, pendingOverride?: State | null) {
    const current = await this.loadConversation(userId, now);
    const assistant: ChatMessage = { role: 'assistant', text: reply.text.slice(0, maximumHistoryText), timestamp: now.toISOString() };
    const messages = [...prior, ...(inbound ? [inbound] : []), assistant].slice(-historyLimit);
    await this.saveConversation(userId, { pending: pendingOverride === undefined ? current.pending : pendingOverride, messages }, now);
    return reply;
  }
  async recordAssistant(userId: bigint, text: string, now = new Date()) {
    if (!text || text.length > maximumHistoryText) return;
    const current = await this.loadConversation(userId, now);
    const message: ChatMessage = { role: 'assistant', text, timestamp: now.toISOString() };
    await this.saveConversation(userId, { pending: current.pending, messages: [...current.messages, message].slice(-historyLimit) }, now);
  }
  private deleteConversation(userId: bigint) { return this.database.messagingConversation.deleteMany({ where: { userId, channel: 'TELEGRAM' } }); }
}
