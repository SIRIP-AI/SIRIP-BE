import { evaluateMonitoring, evaluateStaleSensor, monitoringEventPrefix, sensorOfflineRule, type MonitoringDecision, type MonitoringRuleFamily } from '../../domain/monitoring/monitoring';
import type { Prisma } from '../../generated/prisma/client';
import type { Database } from '../persistence/database';

export type MonitoringAlert = {
  eventId: bigint;
  userId: bigint;
  batchId: bigint;
  batchCode: string;
  sensorCode: string | null;
  type: MonitoringDecision['type'];
  severity: 'WARNING' | 'CRITICAL';
  title: string;
  description: string;
};

export type MonitoringNotifier = { sendMonitoringAlert(alert: MonitoringAlert): Promise<unknown> };

export class MonitoringProcessor {
  constructor(private readonly database: Database, private readonly notifier?: MonitoringNotifier) {}

  async processTelemetry(transaction: Prisma.TransactionClient, input: { userId: bigint | null; batchId: bigint; batchCode: string; sensorId: bigint; sensorCode: string; syncedAt: Date; readings: Parameters<typeof evaluateMonitoring>[1] }) {
    const alerts = await this.reconcile(transaction, input.userId, input.batchId, 'telemetry', evaluateMonitoring(input.batchId, input.readings), input.syncedAt, input.sensorId);
    await this.reconcile(transaction, input.userId, input.batchId, 'offline', [], input.syncedAt, input.sensorId);
    return alerts.map((alert) => ({ ...alert, batchCode: input.batchCode, sensorCode: input.sensorCode }));
  }

  async sweepStaleSensors(now = new Date()) {
    const sessions = await this.database.sensorSession.findMany({
      where: { status: 'ACTIVE', batch: { deletedAt: null }, sensor: { deletedAt: null } },
      select: { id: true, batchId: true, startedAt: true, lastSyncedAt: true, batch: { select: { userId: true, code: true } }, sensor: { select: { id: true, code: true, status: true } } },
    });
    const notifications: MonitoringAlert[] = [];
    for (const session of sessions) {
      const created = await this.database.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${session.id})`;
        const decision = evaluateStaleSensor(session, now);
        const alerts = await this.reconcile(transaction, session.batch.userId, session.batchId, 'offline', decision ? [decision] : [], now, session.sensor.id);
        if (session.sensor.status !== 'ERROR') await transaction.sensor.update({ where: { id: session.sensor.id }, data: { status: decision ? 'OFFLINE' : 'ASSIGNED' } });
        return alerts.map((alert) => ({ ...alert, batchCode: session.batch.code, sensorCode: session.sensor.code }));
      });
      notifications.push(...created);
    }
    await this.notify(notifications);
    return notifications;
  }

  async notify(alerts: MonitoringAlert[]) {
    for (const alert of alerts) {
      try { await this.notifier?.sendMonitoringAlert(alert); }
      catch (error) { console.error('Telegram monitoring notification failed', error instanceof Error ? error.message : 'Unknown error'); }
    }
  }

  private async reconcile(transaction: Prisma.TransactionClient, userId: bigint | null, batchId: bigint, family: MonitoringRuleFamily, decisions: MonitoringDecision[], resolvedAt: Date, sensorId: bigint) {
    const existing = await transaction.operationalEvent.findMany({
      where: family === 'offline'
        ? { batchId, dedupeKey: { startsWith: `${monitoringEventPrefix(batchId)}${sensorOfflineRule}:` } }
        : { batchId, dedupeKey: { startsWith: monitoringEventPrefix(batchId), not: { contains: `:${sensorOfflineRule}:` } } },
      select: { id: true, dedupeKey: true, structuredData: true },
    });
    const activeKeys = new Set(decisions.map(({ dedupeKey }) => dedupeKey));
    const activeExistingKeys = new Set(existing.flatMap((event) => {
      const data = event.structuredData;
      return event.dedupeKey && data && typeof data === 'object' && !Array.isArray(data)
        && data.alert && typeof data.alert === 'object' && !Array.isArray(data.alert) && data.alert.active === true
        ? [event.dedupeKey]
        : [];
    }));
    const created: MonitoringAlert[] = [];
    for (const item of decisions) {
      const event = await transaction.operationalEvent.upsert({
        where: { dedupeKey: item.dedupeKey },
        create: { dedupeKey: item.dedupeKey, userId, type: item.type, source: 'SYSTEM', batchId, sensorId, rawMessage: item.structuredData.alert.description, structuredData: item.structuredData, occurredAt: item.occurredAt },
        update: { type: item.type, sensorId, rawMessage: item.structuredData.alert.description, structuredData: item.structuredData, occurredAt: item.occurredAt },
        select: { id: true },
      });
      if (userId && !activeExistingKeys.has(item.dedupeKey)) created.push({ eventId: event.id, userId, batchId, batchCode: '', sensorCode: null, type: item.type, ...item.structuredData.alert });
    }
    for (const event of existing) {
      if (!event.dedupeKey || activeKeys.has(event.dedupeKey)) continue;
      const data = event.structuredData;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const alert = data.alert;
      if (!alert || typeof alert !== 'object' || Array.isArray(alert) || alert.active !== true) continue;
      await transaction.operationalEvent.update({ where: { id: event.id }, data: { structuredData: { ...data, alert: { ...alert, active: false, resolvedAt: resolvedAt.toISOString() } } } });
    }
    return created;
  }
}
