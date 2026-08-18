import { calculateQualityState, compareCanonicalReadings } from '../quality/quality';
import type { CanonicalQualityReading } from '../quality/quality';

export const monitoringRuleVersion = 'v1';
export const temperatureExcursionThresholdC = 8;
export const qualityWarningWindowDays = 4;
export const qualityCriticalWindowDays = 2;

type MonitoringSeverity = 'WARNING' | 'CRITICAL';

export type MonitoringDecision = {
  dedupeKey: string;
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
  qualityStatus?: MonitoringSeverity;
  ruleMetadata?: Record<string, string | number>;
};

export function monitoringEventPrefix(batchId: bigint) {
  return `monitoring:${monitoringRuleVersion}:batch:${batchId}:`;
}

function decision(batchId: bigint, input: DecisionInput): MonitoringDecision {
  return {
    dedupeKey: `${monitoringEventPrefix(batchId)}${input.rule}:${input.qualifier}`,
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

  if (latest.temperatureC >= temperatureExcursionThresholdC) {
    let boundary = latest;
    for (let index = ordered.length - 2; index >= 0; index -= 1) {
      const reading = ordered[index];
      if (!reading || reading.temperatureC < temperatureExcursionThresholdC) break;
      boundary = reading;
    }
    decisions.push(decision(batchId, {
      rule: 'temperature-excursion',
      qualifier: boundary.id.toString(),
      severity: 'CRITICAL',
      title: 'Temperature excursion active',
      description: `Latest reading ${latest.temperatureC}°C is at or above the ${temperatureExcursionThresholdC}°C threshold; the current excursion started at ${boundary.measuredAt.toISOString()}.`,
      occurredAt: boundary.measuredAt,
      ruleMetadata: { thresholdC: temperatureExcursionThresholdC, boundaryReadingId: boundary.id.toString(), latestTemperatureC: latest.temperatureC },
    }));
  }

  const quality = calculateQualityState(ordered);
  if (quality && quality.remainingQualityWindowDays <= qualityCriticalWindowDays) {
    decisions.push(decision(batchId, {
      rule: 'quality-window',
      qualifier: 'critical',
      severity: 'CRITICAL',
      title: 'Quality window critical',
      description: `Remaining quality window is ${quality.remainingQualityWindowDays.toFixed(1)} days, at or below the ${qualityCriticalWindowDays}-day critical threshold.`,
      occurredAt: latest.measuredAt,
      qualityStatus: 'CRITICAL',
      ruleMetadata: { warningWindowDays: qualityWarningWindowDays, criticalWindowDays: qualityCriticalWindowDays, remainingQualityWindowDays: quality.remainingQualityWindowDays },
    }));
  } else if (quality && quality.remainingQualityWindowDays <= qualityWarningWindowDays) {
    decisions.push(decision(batchId, {
      rule: 'quality-window',
      qualifier: 'warning',
      severity: 'WARNING',
      title: 'Quality window warning',
      description: `Remaining quality window is ${quality.remainingQualityWindowDays.toFixed(1)} days, at or below the ${qualityWarningWindowDays}-day warning threshold.`,
      occurredAt: latest.measuredAt,
      qualityStatus: 'WARNING',
      ruleMetadata: { warningWindowDays: qualityWarningWindowDays, criticalWindowDays: qualityCriticalWindowDays, remainingQualityWindowDays: quality.remainingQualityWindowDays },
    }));
  }

  return decisions;
}
