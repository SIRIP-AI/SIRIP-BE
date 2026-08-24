import { calculateQualityState, compareCanonicalReadings } from '../quality/quality';
import type { CanonicalQualityReading } from '../quality/quality';
import { sensorOfflineThresholdMs } from '../resources/resources';

export const monitoringRuleVersion = 'v1';
export const temperatureExcursionThresholdC = 8;
export const temperatureExcursionSampleCount = 5;
export const qualityWarningWindowDays = 4;
export const qualityCriticalWindowDays = 2;
export const sensorOfflineRule = 'sensor-offline';

type MonitoringSeverity = 'WARNING' | 'CRITICAL';
type MonitoringEventType = 'TEMPERATURE_EXCURSION' | 'QUALITY_WINDOW' | 'SENSOR_OFFLINE';
export type MonitoringRuleFamily = 'telemetry' | 'offline';

export type MonitoringDecision = {
  dedupeKey: string;
  type: MonitoringEventType;
  occurredAt: Date;
  structuredData: {
    rule: Record<string, string | number>;
    alert: {
      active: true;
      severity: MonitoringSeverity;
      title: string;
      description: string;
      qualityStatus?: MonitoringSeverity;
    };
  };
};

type DecisionInput = {
  rule: string;
  qualifier: string;
  severity: MonitoringSeverity;
  title: string;
  description: string;
  occurredAt: Date;
  type?: MonitoringEventType;
  qualityStatus?: MonitoringSeverity;
  ruleMetadata?: Record<string, string | number>;
};

export function monitoringEventPrefix(batchId: bigint) {
  return `monitoring:${monitoringRuleVersion}:batch:${batchId}:`;
}

export function monitoringFamilyPrefix(batchId: bigint, family: MonitoringRuleFamily) {
  return `${monitoringEventPrefix(batchId)}${family === 'offline' ? sensorOfflineRule : ''}`;
}

function decision(batchId: bigint, input: DecisionInput): MonitoringDecision {
  return {
    dedupeKey: `${monitoringEventPrefix(batchId)}${input.rule}:${input.qualifier}`,
    type: input.type ?? 'TEMPERATURE_EXCURSION',
    occurredAt: input.occurredAt,
    structuredData: {
      rule: { version: monitoringRuleVersion, name: input.rule, ...input.ruleMetadata },
      alert: {
        active: true,
        severity: input.severity,
        title: input.title,
        description: input.description,
        ...(input.qualityStatus ? { qualityStatus: input.qualityStatus } : {}),
      },
    },
  };
}

export function evaluateMonitoring(batchId: bigint, readings: CanonicalQualityReading[]): MonitoringDecision[] {
  const ordered = [...readings].sort(compareCanonicalReadings);
  const latest = ordered[ordered.length - 1];
  if (!latest) return [];
  const decisions: MonitoringDecision[] = [];

  const latestWindowStart = ordered.length - temperatureExcursionSampleCount;
  const latestWindow = ordered.slice(latestWindowStart);
  const latestAverage = latestWindow.reduce((sum, reading) => sum + reading.temperatureC, 0) / temperatureExcursionSampleCount;
  if (latestWindow.length === temperatureExcursionSampleCount && latestAverage >= temperatureExcursionThresholdC) {
    let boundaryIndex = latestWindowStart;
    for (let start = latestWindowStart - 1; start >= 0; start -= 1) {
      const average = ordered.slice(start, start + temperatureExcursionSampleCount).reduce((sum, reading) => sum + reading.temperatureC, 0) / temperatureExcursionSampleCount;
      if (average < temperatureExcursionThresholdC) break;
      boundaryIndex = start;
    }
    const boundary = ordered[boundaryIndex]!;
    decisions.push(decision(batchId, {
      rule: 'temperature-excursion',
      qualifier: boundary.id.toString(),
      severity: 'CRITICAL',
      title: 'Penyimpangan suhu aktif',
      description: `Rata-rata ${temperatureExcursionSampleCount} pembacaan terakhir adalah ${latestAverage.toFixed(1)}°C, sama dengan atau di atas ambang ${temperatureExcursionThresholdC}°C; penyimpangan saat ini dimulai pada ${boundary.measuredAt.toISOString()}.`,
      occurredAt: boundary.measuredAt,
      ruleMetadata: { thresholdC: temperatureExcursionThresholdC, sampleCount: temperatureExcursionSampleCount, boundaryReadingId: boundary.id.toString(), averageTemperatureC: latestAverage, latestTemperatureC: latest.temperatureC },
    }));
  }

  const quality = calculateQualityState(ordered);
  if (quality && quality.remainingQualityWindowDays <= qualityCriticalWindowDays) {
    decisions.push(decision(batchId, {
      rule: 'quality-window',
      qualifier: 'critical',
      severity: 'CRITICAL',
      type: 'QUALITY_WINDOW',
      title: 'Jendela mutu kritis',
      description: `Sisa jendela mutu adalah ${quality.remainingQualityWindowDays.toFixed(1)} hari, sama dengan atau di bawah ambang kritis ${qualityCriticalWindowDays} hari.`,
      occurredAt: latest.measuredAt,
      qualityStatus: 'CRITICAL',
      ruleMetadata: { warningWindowDays: qualityWarningWindowDays, criticalWindowDays: qualityCriticalWindowDays, remainingQualityWindowDays: quality.remainingQualityWindowDays },
    }));
  } else if (quality && quality.remainingQualityWindowDays <= qualityWarningWindowDays) {
    decisions.push(decision(batchId, {
      rule: 'quality-window',
      qualifier: 'warning',
      severity: 'WARNING',
      type: 'QUALITY_WINDOW',
      title: 'Peringatan jendela mutu',
      description: `Sisa jendela mutu adalah ${quality.remainingQualityWindowDays.toFixed(1)} hari, sama dengan atau di bawah ambang peringatan ${qualityWarningWindowDays} hari.`,
      occurredAt: latest.measuredAt,
      qualityStatus: 'WARNING',
      ruleMetadata: { warningWindowDays: qualityWarningWindowDays, criticalWindowDays: qualityCriticalWindowDays, remainingQualityWindowDays: quality.remainingQualityWindowDays },
    }));
  }

  return decisions;
}

export function evaluateStaleSensor(session: { id: bigint; batchId: bigint; startedAt: Date; lastSyncedAt: Date | null }, now: Date): MonitoringDecision | null {
  const basis = session.lastSyncedAt ?? session.startedAt;
  if (now.getTime() - basis.getTime() <= sensorOfflineThresholdMs) return null;
  return decision(session.batchId, {
    rule: sensorOfflineRule,
    qualifier: session.id.toString(),
    type: 'SENSOR_OFFLINE',
    severity: 'WARNING',
    title: 'Sensor tidak terhubung',
    description: `Telemetri belum diterima selama lebih dari ${sensorOfflineThresholdMs / 60000} menit; perekaman lokal mungkin tetap berjalan dan pembacaan akan disinkronkan saat koneksi kembali.`,
    occurredAt: new Date(basis.getTime() + sensorOfflineThresholdMs),
    ruleMetadata: { offlineThresholdMs: sensorOfflineThresholdMs, sessionId: session.id.toString() },
  });
}
