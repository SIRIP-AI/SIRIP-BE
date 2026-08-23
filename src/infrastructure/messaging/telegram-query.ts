import type { Database } from '../persistence/database';
import type { OperationalQuery } from './telegram-extractor';

type QueryRow = { label: string; status: string | null; statuses?: string[]; metrics: Partial<Record<NonNullable<OperationalQuery['metric']>, number>> };

const metricsByDataset: Record<OperationalQuery['dataset'], Array<NonNullable<OperationalQuery['metric']>>> = {
  storage: ['capacityKg', 'availableCapacityKg', 'occupiedCapacityKg'],
  vehicle: ['capacityKg', 'delayMinutes'],
  destination: [],
  batch: ['weightKg', 'remainingQualityWindowDays'],
  plan: ['delayedBySeconds'],
  step: [],
  sensor: [],
  alert: [],
};

function compare(value: number, operator: NonNullable<OperationalQuery['operator']>, threshold: number) {
  if (operator === 'GT') return value > threshold;
  if (operator === 'GTE') return value >= threshold;
  if (operator === 'LT') return value < threshold;
  if (operator === 'LTE') return value <= threshold;
  return value === threshold;
}

function quantity(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function unit(metric: NonNullable<OperationalQuery['metric']>) {
  if (metric === 'delayMinutes') return ' minutes';
  if (metric === 'delayedBySeconds') return ' seconds';
  if (metric === 'remainingQualityWindowDays') return ' days';
  return ' kg';
}

function plural(dataset: OperationalQuery['dataset']) {
  if (dataset === 'batch') return 'batches';
  if (dataset === 'storage') return 'storage locations';
  return `${dataset}s`;
}

async function loadRows(database: Database, userId: bigint, dataset: OperationalQuery['dataset']): Promise<QueryRow[]> {
  if (dataset === 'storage') {
    const storages = await database.coldStorage.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
      select: { name: true, capacityKg: true, operationalStatus: true, currentBatches: { where: { userId, deletedAt: null }, select: { weightKg: true } } },
    });
    return storages.map((storage) => {
      const occupiedCapacityKg = storage.currentBatches.reduce((sum, batch) => sum + batch.weightKg, 0);
      const availableCapacityKg = Math.max(0, storage.capacityKg - occupiedCapacityKg);
      return { label: storage.name, status: storage.operationalStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : availableCapacityKg === 0 ? 'FULL' : 'AVAILABLE', metrics: { capacityKg: storage.capacityKg, occupiedCapacityKg, availableCapacityKg } };
    });
  }
  if (dataset === 'vehicle') return database.vehicle.findMany({ where: { userId }, orderBy: { code: 'asc' }, select: { code: true, capacityKg: true, operationalStatus: true, delayMinutes: true, planSteps: { where: { status: 'UPCOMING', plan: { userId, status: 'ACTIVE' } }, take: 1, select: { id: true } } } }).then((items) => items.map((item) => ({ label: item.code, status: item.operationalStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : item.planSteps.length ? 'ASSIGNED' : 'AVAILABLE', metrics: { capacityKg: item.capacityKg, delayMinutes: item.delayMinutes } })));
  if (dataset === 'destination') return database.destination.findMany({ where: { userId }, orderBy: { name: 'asc' }, select: { name: true, status: true } }).then((items) => items.map((item) => ({ label: item.name, status: item.status, metrics: {} })));
  if (dataset === 'batch') return database.batch.findMany({ where: { userId, deletedAt: null }, orderBy: { code: 'asc' }, select: { code: true, status: true, weightKg: true, remainingQualityWindowDays: true } }).then((items) => items.map((item) => ({ label: item.code, status: item.status, metrics: { weightKg: item.weightKg, ...(item.remainingQualityWindowDays === null ? {} : { remainingQualityWindowDays: item.remainingQualityWindowDays }) } })));
  if (dataset === 'plan') return database.plan.findMany({ where: { userId }, orderBy: { version: 'asc' }, select: { version: true, status: true, timingStatus: true, delayedBySeconds: true } }).then((items) => items.map((item) => ({ label: `Plan v${item.version}`, status: item.status, statuses: [item.timingStatus], metrics: { delayedBySeconds: item.delayedBySeconds } })));
  if (dataset === 'step') return database.planStep.findMany({ where: { plan: { userId } }, orderBy: [{ plan: { version: 'asc' } }, { sequence: 'asc' }], select: { sequence: true, status: true, plan: { select: { version: true } } } }).then((items) => items.map((item) => ({ label: `Plan v${item.plan.version} step ${item.sequence}`, status: item.status, metrics: {} })));
  if (dataset === 'sensor') return database.sensor.findMany({ where: { userId, deletedAt: null }, orderBy: { code: 'asc' }, select: { code: true, status: true } }).then((items) => items.map((item) => ({ label: item.code, status: item.status, metrics: {} })));
  return database.operationalEvent.findMany({ where: { userId, structuredData: { path: ['alert', 'active'], equals: true } }, orderBy: { occurredAt: 'desc' }, select: { type: true, occurredAt: true } }).then((items) => items.map((item) => ({ label: `${item.type} at ${item.occurredAt.toISOString()}`, status: 'ACTIVE', metrics: {} })));
}

export async function executeTelegramQuery(database: Database, userId: bigint, query: OperationalQuery) {
  if (query.metric && !metricsByDataset[query.dataset].includes(query.metric)) {
    return { facts: { error: 'unsupported_metric', dataset: query.dataset, metric: query.metric }, fallback: `That metric is not available for ${query.dataset} queries.` };
  }
  let rows = await loadRows(database, userId, query.dataset);
  const status = query.status?.toUpperCase();
  if (status) rows = rows.filter((row) => row.status === status || row.statuses?.includes(status));
  if (query.metric && query.operator && query.threshold !== null) rows = rows.filter((row) => {
    const value = row.metrics[query.metric!];
    return value !== undefined && compare(value, query.operator!, query.threshold!);
  });
  if (query.operation === 'COUNT') {
    const fallback = `${rows.length} ${rows.length === 1 ? query.dataset : plural(query.dataset)} found.`;
    return { facts: { dataset: query.dataset, operation: query.operation, status: query.status, comparison: query.metric ? { metric: query.metric, operator: query.operator, threshold: query.threshold } : null, count: rows.length }, fallback };
  }
  if (query.operation === 'SUM' && query.metric) {
    const total = rows.reduce((sum, row) => sum + (row.metrics[query.metric!] ?? 0), 0);
    const fallback = `Total ${query.metric}: ${quantity(total)}${unit(query.metric)}.`;
    return { facts: { dataset: query.dataset, operation: query.operation, metric: query.metric, status: query.status, total }, fallback };
  }
  const displayed = rows.slice(0, 5).map((row) => ({ label: row.label, status: row.status, ...(query.metric && row.metrics[query.metric] !== undefined ? { value: row.metrics[query.metric], metric: query.metric } : {}) }));
  const fallback = rows.length ? `${plural(query.dataset)[0]!.toUpperCase()}${plural(query.dataset).slice(1)} (1-${displayed.length} of ${rows.length})\n${displayed.map((row) => `${row.label}: ${row.status ?? 'unknown'}${'value' in row ? `, ${quantity(row.value!)}${unit(row.metric!)}` : ''}`).join('\n')}` : `No ${plural(query.dataset)} found.`;
  return { facts: { dataset: query.dataset, operation: query.operation, total: rows.length, rows: displayed }, fallback };
}
