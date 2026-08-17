import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateQualityState } from './quality';

test('calculates quality from measurement time in chronological order', () => {
  const start = new Date('2026-08-17T00:00:00.000Z');
  const end = new Date('2026-08-18T00:00:00.000Z');
  const state = calculateQualityState([
    { temperatureC: 2, measuredAt: end },
    { temperatureC: 0, measuredAt: start },
  ]);

  assert.ok(state);
  assert.equal(state.equivalentQualityAgeDays, 1);
  assert.equal(state.remainingQualityWindowDays, 11);
  assert.equal(state.qualityEstimateStartedAt.toISOString(), start.toISOString());
  assert.equal(state.currentTemperatureC, 2);
});

test('returns the first reading as an unaged quality state', () => {
  const measuredAt = new Date('2026-08-17T00:00:00.000Z');
  assert.deepEqual(calculateQualityState([{ temperatureC: 4, measuredAt }]), {
    equivalentQualityAgeDays: 0,
    remainingQualityWindowDays: 12,
    qualityEstimateStartedAt: measuredAt,
    currentTemperatureC: 4,
  });
});
