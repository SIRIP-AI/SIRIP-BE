import { Prisma } from '../../generated/prisma/client';
import type { TelegramExtraction } from '../../infrastructure/messaging/telegram-extractor';
import type { Database } from '../../infrastructure/persistence/database';

export type OperationalReportKind = 'VEHICLE_DELAY' | 'VEHICLE_STATUS' | 'STORAGE_STATUS' | 'DESTINATION_STATUS' | 'BATCH_STATUS' | 'SENSOR_STATUS';
export type OperationalReport = {
  kind: OperationalReportKind;
  entityId: string;
  entityName: string;
  value: number | 'AVAILABLE' | 'UNAVAILABLE' | 'INSPECTION_HOLD' | 'ACTIVE' | 'ERROR';
  occurredAt: string;
  rawMessage: string;
  planRef?: string;
};

function reportOccurrence(text: string, receivedAt: Date) {
  const match = text.match(/\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}))\b/);
  if (!match?.[1]) return receivedAt;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? receivedAt : parsed;
}

function recoveredSensorStatus(hasActiveSession: boolean) { return hasActiveSession ? 'ASSIGNED' as const : 'AVAILABLE' as const; }
function recoveredBatchStatus(hasActivePlan: boolean) { return hasActivePlan ? 'ACTIVE' as const : 'MONITORING' as const; }

export function operationalReportText(report: OperationalReport) {
  if (report.kind === 'VEHICLE_DELAY') return `${report.entityName} terlambat ${report.value} menit`;
  return `${report.entityName} -> ${report.value}`;
}

function eventType(kind: OperationalReportKind): 'TRUCK_DELAY' | 'STORAGE_CHANGE' | 'DESTINATION_CHANGE' | 'INSPECTION_HOLD' | 'OTHER' {
  if (kind.startsWith('VEHICLE')) return 'TRUCK_DELAY';
  if (kind === 'STORAGE_STATUS') return 'STORAGE_CHANGE';
  if (kind === 'DESTINATION_STATUS') return 'DESTINATION_CHANGE';
  if (kind === 'BATCH_STATUS') return 'INSPECTION_HOLD';
  return 'OTHER';
}

export class OperationalReportService {
  constructor(private readonly database: Database) {}

  async resolve(userId: bigint, extraction: TelegramExtraction, text: string, receivedAt: Date): Promise<{ report: OperationalReport } | { question: string }> {
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
    const make = (kind: OperationalReportKind, item: { id: bigint }, entityName: string, value: OperationalReport['value']): { report: OperationalReport } => ({ report: { kind, entityId: item.id.toString(), entityName, value, occurredAt: at, rawMessage: text, ...(extraction.planRef ? { planRef: extraction.planRef } : {}) } });
    const vehicles = extraction.entityType === 'vehicle' ? matches(resources[0], (item) => item.code) : [];
    if (extraction.status === 'DELAYED' || extraction.delayMinutes !== null) {
      if (vehicles.length !== 1) return { question: vehicles.length ? 'Truk mana yang dimaksud?' : 'Truk terkonfigurasi mana yang terlambat?' };
      if (extraction.delayMinutes === null) return { question: 'Berapa menit keterlambatan truk tersebut?' };
      return make('VEHICLE_DELAY', vehicles[0]!, vehicles[0]!.code, extraction.delayMinutes);
    }
    if (extraction.entityType === 'vehicle') {
      if (vehicles.length !== 1) return { question: 'Truk terkonfigurasi mana yang dimaksud?' };
      if (!unavailable && !recovered) return { question: 'Apakah truk tidak tersedia atau sudah pulih?' };
      return make('VEHICLE_STATUS', vehicles[0]!, vehicles[0]!.code, unavailable ? 'UNAVAILABLE' : 'AVAILABLE');
    }
    const storages = extraction.entityType === 'storage' ? matches(resources[1], (item) => item.name) : [];
    if (extraction.entityType === 'storage') {
      if (storages.length !== 1) return { question: 'Penyimpanan dingin terkonfigurasi mana yang dimaksud?' };
      if (!unavailable && !recovered) return { question: 'Apakah penyimpanan dingin tidak tersedia atau sudah pulih?' };
      return make('STORAGE_STATUS', storages[0]!, storages[0]!.name, unavailable ? 'UNAVAILABLE' : 'AVAILABLE');
    }
    const destinations = extraction.entityType === 'destination' ? matches(resources[2], (item) => item.name) : [];
    if (extraction.entityType === 'destination') {
      if (destinations.length !== 1) return { question: 'Tujuan terkonfigurasi mana yang dimaksud?' };
      if (!unavailable && !recovered) return { question: 'Apakah tujuan tidak tersedia atau sudah pulih?' };
      return make('DESTINATION_STATUS', destinations[0]!, destinations[0]!.name, unavailable ? 'UNAVAILABLE' : 'AVAILABLE');
    }
    const batches = extraction.entityType === 'batch' ? matches(resources[3], (item) => item.code) : [];
    if (extraction.entityType === 'batch') {
      if (batches.length !== 1) return { question: 'Batch aktif mana yang dimaksud?' };
      if (!extraction.status) return { question: 'Apakah batch memasuki penahanan inspeksi atau sedang pulih?' };
      return make('BATCH_STATUS', batches[0]!, batches[0]!.code, recovered ? 'ACTIVE' : 'INSPECTION_HOLD');
    }
    const sensors = extraction.entityType === 'sensor' ? matches(resources[4], (item) => item.code) : [];
    if (extraction.entityType === 'sensor') {
      if (sensors.length !== 1) return { question: 'Sensor terkonfigurasi mana yang dimaksud?' };
      if (!extraction.status) return { question: 'Apakah sensor mengalami kesalahan atau sudah pulih?' };
      return make('SENSOR_STATUS', sensors[0]!, sensors[0]!.code, recovered ? 'AVAILABLE' : 'ERROR');
    }
    return { question: 'Sertakan nama atau kode sumber daya dan kondisi operasionalnya.' };
  }

  async apply(userId: bigint, report: OperationalReport, source: 'TELEGRAM' | 'WEB', dedupeKey?: string) {
    if (dedupeKey) {
      const existing = await this.database.operationalEvent.findFirst({ where: { userId, dedupeKey }, select: { id: true } });
      if (existing) return existing;
    }
    const entityId = BigInt(report.entityId);
    return this.database.$transaction(async (transaction) => {
      const data: Prisma.OperationalEventCreateInput = { type: eventType(report.kind), source, rawMessage: report.rawMessage, occurredAt: new Date(report.occurredAt), structuredData: { report: { kind: report.kind, value: report.value } }, ...(dedupeKey ? { dedupeKey } : {}), user: { connect: { id: userId } } };
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
  }
}
