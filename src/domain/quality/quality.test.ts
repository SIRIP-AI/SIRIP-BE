import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateQualityState, initialQualityWindowDays } from './quality';

const hour = 60 * 60 * 1000;
const at = (hours: number) => new Date(Date.UTC(2026, 0, 1) + hours * hour);

test('quality is canonical for out-of-order input and retains cumulative exposure', () => {
  const readings = [
    { id: 5n, sequenceNumber: 2n, temperatureC: 0, measuredAt: at(2) },
    { id: 2n, sequenceNumber: 1n, temperatureC: 10, measuredAt: at(0) },
    { id: 6n, sequenceNumber: 1n, temperatureC: 15, measuredAt: at(0) },
    { id: 3n, sequenceNumber: 0n, temperatureC: 20, measuredAt: at(0) },
    { id: 4n, sequenceNumber: 2n, temperatureC: 0, measuredAt: at(1) },
    { id: 1n, sequenceNumber: 0n, temperatureC: 5, measuredAt: at(0) },
  ];
  const state = calculateQualityState(readings);
  const reversed = calculateQualityState([...readings].reverse());
  const expectedAge = (Math.exp(1.8) + 1) / 24;
  assert.deepEqual(state, reversed);
  assert.ok(state);
  assert.ok(Math.abs(state.equivalentQualityAgeDays - expectedAge) < 1e-12);
  assert.ok(Math.abs(state.remainingQualityWindowDays - (initialQualityWindowDays - expectedAge)) < 1e-12);
  assert.equal(state.currentTemperatureC, 0);
  assert.equal(state.qualityEstimateStartedAt.getTime(), at(0).getTime());
});
