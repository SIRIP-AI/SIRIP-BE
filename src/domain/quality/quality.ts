export type QualityReading = {
  temperatureC: number;
  measuredAt: Date;
};

export type CanonicalQualityReading = QualityReading & {
  sequenceNumber: bigint;
  id: bigint;
};

export type QualityState = {
  equivalentQualityAgeDays: number;
  remainingQualityWindowDays: number;
  qualityEstimateStartedAt: Date;
  currentTemperatureC: number;
};

const millisecondsPerDay = 86_400_000;
export const initialQualityWindowDays = 12;

export function calculateQualityAgeIncrement(previous: QualityReading, current: QualityReading) {
  const intervalDays = Math.max(0, current.measuredAt.getTime() - previous.measuredAt.getTime()) / millisecondsPerDay;
  return intervalDays * Math.exp(0.12 * previous.temperatureC);
}

export function calculateQualityState(readings: CanonicalQualityReading[]): QualityState | null {
  if (!readings.length) return null;
  const ordered = [...readings].sort((left, right) => left.measuredAt.getTime() - right.measuredAt.getTime() || Number(left.sequenceNumber - right.sequenceNumber) || Number(left.id - right.id));
  let equivalentQualityAgeDays = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    equivalentQualityAgeDays += calculateQualityAgeIncrement(previous, current);
  }
  const latest = ordered[ordered.length - 1];
  if (!latest) return null;
  return {
    equivalentQualityAgeDays,
    remainingQualityWindowDays: initialQualityWindowDays - equivalentQualityAgeDays,
    qualityEstimateStartedAt: ordered[0]?.measuredAt ?? latest.measuredAt,
    currentTemperatureC: latest.temperatureC,
  };
}
