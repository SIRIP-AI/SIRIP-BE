import type { PlanService } from '../../application/plans/plan-service';
import type { Database } from '../persistence/database';

const collectionLimit = 100;
const textLimit = 160;

function bounded(value: string | null) {
  if (!value) return null;
  return value.length <= textLimit ? value : `${value.slice(0, textLimit - 3)}...`;
}

export function formatWIB(date: Date | string | null | undefined): string {
  if (!date) return 'never';
  const parsed = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(parsed.getTime())) return 'never';
  return parsed.toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) + ' WIB';
}

export async function loadTelegramOperationalSnapshot(database: Database, plans: PlanService, userId: bigint) {
  const [planList, batches, vehicles, storages, destinations, sensors, alerts] = await Promise.all([
    plans.list(userId),
    database.batch.findMany({
      where: { userId, deletedAt: null, status: { in: ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] } },
      orderBy: { code: 'asc' },
      take: collectionLimit,
      select: { code: true, status: true, currentTemperatureC: true, remainingQualityWindowDays: true, sensorSessions: { where: { status: 'ACTIVE' }, take: 1, select: { sensor: { select: { code: true } } } } },
    }),
    database.vehicle.findMany({ where: { userId }, orderBy: { code: 'asc' }, take: collectionLimit, select: { code: true, operationalStatus: true, delayMinutes: true, capacityKg: true } }),
    database.coldStorage.findMany({ where: { userId }, orderBy: { name: 'asc' }, take: collectionLimit, select: { name: true, operationalStatus: true, capacityKg: true, availableCapacityKg: true } }),
    database.destination.findMany({ where: { userId }, orderBy: { name: 'asc' }, take: collectionLimit, select: { name: true, status: true, travelMinutes: true } }),
    database.sensor.findMany({ where: { userId, deletedAt: null }, orderBy: { code: 'asc' }, take: collectionLimit, select: { code: true, status: true, sessions: { where: { status: 'ACTIVE', batch: { deletedAt: null } }, take: 1, select: { batch: { select: { code: true } } } } } }),
    database.operationalEvent.findMany({ where: { userId, structuredData: { path: ['alert', 'active'], equals: true } }, orderBy: { occurredAt: 'desc' }, take: 20, select: { type: true, rawMessage: true, occurredAt: true } }),
  ]);
  const visiblePlans = [...planList.activePlans, ...planList.proposedPlans];
  return {
    plans: visiblePlans.map((plan) => ({
      id: plan.id,
      version: plan.version,
      status: plan.status,
      batches: plan.batches.map(({ code }) => code),
      upcomingSteps: plan.steps.filter(({ status }) => status === 'UPCOMING').slice(0, 20).map((step) => ({ sequence: step.sequence, action: step.actionType, batch: step.batch?.code ?? null, resources: step.resources.map((resource) => bounded(resource.name)), scheduledAt: formatWIB(step.scheduledAt) })),
    })),
    batches: batches.map((batch) => ({ code: batch.code, status: batch.status, temperatureC: batch.currentTemperatureC, qualityRemainingDays: batch.remainingQualityWindowDays, sensor: batch.sensorSessions[0]?.sensor.code ?? null })),
    vehicles: vehicles.map((vehicle) => ({ code: vehicle.code, status: vehicle.operationalStatus, delayMinutes: vehicle.delayMinutes, capacityKg: vehicle.capacityKg })),
    storages: storages.map((storage) => ({ name: storage.name, status: storage.operationalStatus, capacityKg: storage.capacityKg, availableCapacityKg: storage.availableCapacityKg })),
    destinations: destinations.map((destination) => ({ name: destination.name, status: destination.status, travelMinutes: destination.travelMinutes })),
    sensors: sensors.map((sensor) => ({ code: sensor.code, status: sensor.status, batch: sensor.sessions[0]?.batch.code ?? null })),
    alerts: alerts.map((alert) => ({ type: alert.type, summary: bounded(alert.rawMessage), occurredAt: formatWIB(alert.occurredAt) })),
    truncation: { collections: collectionLimit, alerts: 20, upcomingStepsPerPlan: 20, textCharacters: textLimit },
  };
}

export type TelegramOperationalSnapshot = Awaited<ReturnType<typeof loadTelegramOperationalSnapshot>>;
