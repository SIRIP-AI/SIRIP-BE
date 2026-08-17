export type QualityReading = {
  temperatureC: number;
  measuredAt: Date;
};

export type QualityState = {
  equivalentQualityAgeDays: number;
  remainingQualityWindowDays: number;
  qualityEstimateStartedAt: Date;
  currentTemperatureC: number;
};

const millisecondsPerDay = 86_400_000;
const initialQualityWindowDays = 12;

export function calculateQualityState(readings: QualityReading[]): QualityState | null {
  if (!readings.length) return null;
  const ordered = [...readings].sort((left, right) => left.measuredAt.getTime() - right.measuredAt.getTime());
  let equivalentQualityAgeDays = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    const intervalDays = (current.measuredAt.getTime() - previous.measuredAt.getTime()) / millisecondsPerDay;
    equivalentQualityAgeDays += intervalDays * Math.exp(0.12 * previous.temperatureC);
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
