import type { Prisma } from '../../generated/prisma/client';
import { evaluateStaleSensor, sensorOfflineRule } from '../../domain/monitoring/monitoring';
import { connectivityStatus } from '../../domain/resources/resources';
import type { Database } from '../persistence/database';

const activeBatchStatuses = ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] as const;
const qualityStatuses = ['NORMAL', 'WARNING', 'CRITICAL'] as const;

type QualityStatus = typeof qualityStatuses[number] | 'UNKNOWN';
type AlertMetadata = {
  active: true;
  severity: 'WARNING' | 'CRITICAL';
  title: string;
  description: string;
  qualityStatus?: QualityStatus;
};

function alertMetadata(value: Prisma.JsonValue): AlertMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const alert = value.alert;
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)) return null;
  const severity = alert.severity;
  const qualityStatus = alert.qualityStatus;
  if (alert.active !== true || (severity !== 'WARNING' && severity !== 'CRITICAL') || typeof alert.title !== 'string' || typeof alert.description !== 'string') return null;
  return {
    active: true,
    severity,
    title: alert.title,
    description: alert.description,
    qualityStatus: typeof qualityStatus === 'string' && qualityStatuses.includes(qualityStatus as typeof qualityStatuses[number]) ? qualityStatus as QualityStatus : undefined,
  };
}

function resource(step: {
  coldStorage: { name: string } | null;
  vehicle: { code: string } | null;
  destination: { name: string } | null;
}) {
  return step.coldStorage?.name ?? step.vehicle?.code ?? step.destination?.name ?? null;
}

export class OverviewRepository {
  constructor(private readonly database: Database) {}

  private async reconcileStaleSensors(userId: bigint, now: Date) {
    const sessions = await this.database.sensorSession.findMany({
      where: { status: 'ACTIVE', batch: { userId, deletedAt: null } },
      select: { id: true, batchId: true, startedAt: true, lastSyncedAt: true },
    });
    const decisions = sessions.flatMap((session) => {
      const decision = evaluateStaleSensor(session, now);
      return decision ? [{ session, decision }] : [];
    });
    const existing = await this.database.operationalEvent.findMany({
      where: { userId, dedupeKey: { contains: `:${sensorOfflineRule}:` } },
      select: { id: true, dedupeKey: true, structuredData: true },
    });
    const activeKeys = new Set(decisions.map(({ decision }) => decision.dedupeKey));
    for (const { session, decision } of decisions) {
      await this.database.operationalEvent.upsert({
        where: { dedupeKey: decision.dedupeKey },
        create: {
          dedupeKey: decision.dedupeKey,
          userId,
          type: decision.type,
          source: 'SYSTEM',
          batchId: session.batchId,
          rawMessage: null,
          structuredData: decision.structuredData,
          occurredAt: decision.occurredAt,
        },
        update: { structuredData: decision.structuredData },
      });
    }
    for (const event of existing) {
      if (!event.dedupeKey || activeKeys.has(event.dedupeKey)) continue;
      const data = event.structuredData;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const alert = data.alert;
      if (!alert || typeof alert !== 'object' || Array.isArray(alert) || alert.active !== true) continue;
      await this.database.operationalEvent.update({
        where: { id: event.id },
        data: { structuredData: { ...data, alert: { ...alert, active: false, resolvedAt: now.toISOString() } } },
      });
    }
  }

  async overview(userId: bigint) {
    const now = new Date();
    await this.reconcileStaleSensors(userId, now);
    const [batches, events, activePlan] = await Promise.all([
      this.database.batch.findMany({
        where: { userId, deletedAt: null, status: { in: [...activeBatchStatuses] } },
        select: {
          id: true,
          code: true,
          status: true,
          currentTemperatureC: true,
          remainingQualityWindowDays: true,
          sensorSessions: {
            where: { status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: { startedAt: true, lastSyncedAt: true, sensor: { select: { code: true, status: true, lastSeenAt: true } } },
          },
        },
      }),
      this.database.operationalEvent.findMany({
        where: { userId, OR: [{ batchId: null }, { batch: { deletedAt: null } }] },
        orderBy: { occurredAt: 'desc' },
        take: 50,
        select: { id: true, batchId: true, type: true, source: true, structuredData: true, occurredAt: true },
      }),
      this.database.plan.findFirst({
        where: { userId, status: 'ACTIVE' },
        select: {
          id: true,
          version: true,
          status: true,
          reason: true,
          steps: {
            where: { status: { in: ['UPCOMING', 'COMPLETED'] }, batch: { deletedAt: null } },
            orderBy: { sequence: 'asc' },
            take: 3,
            select: {
              id: true,
              sequence: true,
              actionType: true,
              scheduledAt: true,
              status: true,
              batch: { select: { code: true } },
              coldStorage: { select: { name: true } },
              vehicle: { select: { code: true } },
              destination: { select: { name: true } },
            },
          },
        },
      }),
    ]);

    const alerts = events.flatMap((event) => {
      const metadata = alertMetadata(event.structuredData);
      return metadata ? [{
        id: event.id.toString(),
        batchId: event.batchId?.toString() ?? null,
        type: event.type,
        source: event.source,
        severity: metadata.severity,
        title: metadata.title,
        description: metadata.description,
        occurredAt: event.occurredAt.toISOString(),
      }] : [];
    });
    const qualityByBatch = new Map<string, QualityStatus>();
    for (const event of events) {
      const status = alertMetadata(event.structuredData)?.qualityStatus;
      if (event.batchId && status && !qualityByBatch.has(event.batchId.toString())) qualityByBatch.set(event.batchId.toString(), status);
    }
    const priorityBatches = batches.map((batch) => {
      const session = batch.sensorSessions[0];
      const sensor = session?.sensor;
      const qualityStatus: QualityStatus = batch.status === 'INSPECTION_HOLD'
        ? 'CRITICAL'
        : qualityByBatch.get(batch.id.toString()) ?? (batch.remainingQualityWindowDays === null ? 'UNKNOWN' : 'NORMAL');
      return {
        code: batch.code,
        currentTemperatureC: batch.currentTemperatureC,
        remainingQualityWindowDays: batch.remainingQualityWindowDays,
        qualityStatus,
        sensor: sensor ? { code: sensor.code, connectivityStatus: connectivityStatus(sensor, now, session ? session.lastSyncedAt ?? session.startedAt : sensor.lastSeenAt) } : null,
      };
    }).sort((left, right) => {
      const rank = { CRITICAL: 0, WARNING: 1, NORMAL: 2, UNKNOWN: 3 };
      return rank[left.qualityStatus] - rank[right.qualityStatus]
        || (left.remainingQualityWindowDays ?? Number.POSITIVE_INFINITY) - (right.remainingQualityWindowDays ?? Number.POSITIVE_INFINITY);
    });

    return {
      updatedAt: now.toISOString(),
      summary: {
        activeBatchCount: batches.length,
        atRiskBatchCount: priorityBatches.filter((batch) => batch.qualityStatus === 'WARNING' || batch.qualityStatus === 'CRITICAL').length,
        activeAlertCount: alerts.length,
        activePlanVersion: activePlan?.version ?? null,
      },
      priorityBatches,
      activePlan: activePlan ? {
        id: activePlan.id.toString(),
        version: activePlan.version,
        status: activePlan.status,
        reason: activePlan.reason,
        steps: activePlan.steps.map((step) => ({
          id: step.id.toString(),
          sequence: step.sequence,
          actionType: step.actionType,
          scheduledAt: step.scheduledAt.toISOString(),
          status: step.status,
          batchCode: step.batch.code,
          resource: resource(step),
        })),
      } : null,
      alerts,
    };
  }
}
