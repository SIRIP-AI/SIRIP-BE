import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateQualityAgeIncrement, calculateQualityState } from './quality';

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

test('calculates the documented temperature-adjusted quality increment', () => {
  const start = new Date('2026-08-17T00:00:00.000Z');
  const end = new Date('2026-08-18T00:00:00.000Z');
  assert.equal(calculateQualityAgeIncrement({ temperatureC: 0, measuredAt: start }, { temperatureC: 8, measuredAt: end }), 1);
  assert.ok(Math.abs(calculateQualityAgeIncrement({ temperatureC: 4, measuredAt: start }, { temperatureC: 0, measuredAt: end }) - Math.exp(0.48)) < 1e-12);
  assert.equal(calculateQualityAgeIncrement({ temperatureC: 4, measuredAt: end }, { temperatureC: 0, measuredAt: start }), 0);
});
