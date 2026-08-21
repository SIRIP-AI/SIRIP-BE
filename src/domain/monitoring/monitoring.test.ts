import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateMonitoring, monitoringEventPrefix } from './monitoring';

const hour = 60 * 60 * 1000;
const at = (hours: number) => new Date(Date.UTC(2026, 0, 1) + hours * hour);
const reading = (id: number, sequenceNumber: number, temperatureC: number, hours: number) => ({ id: BigInt(id), sequenceNumber: BigInt(sequenceNumber), temperatureC, measuredAt: at(hours) });
const batchId = 7n;

test('no alerts while temperature and quality window stay within limits', () => {
  assert.deepEqual(evaluateMonitoring(batchId, [reading(1, 0, 2, 0), reading(2, 1, 3, 1)]), []);
  assert.deepEqual(evaluateMonitoring(batchId, []), []);
});

test('temperature excursion requires the latest five-reading average to reach the threshold', () => {
  const decisions = evaluateMonitoring(batchId, [
    reading(1, 0, 2, 0),
    reading(2, 1, 9, 1),
    reading(3, 2, 9, 2),
    reading(4, 3, 9, 3),
    reading(5, 4, 9, 4),
    reading(6, 5, 9, 5),
  ]);
  assert.equal(decisions.length, 1);
  const excursion = decisions[0];
  assert.ok(excursion);
  assert.equal(excursion.dedupeKey, `${monitoringEventPrefix(batchId)}temperature-excursion:2`);
  assert.equal(excursion.occurredAt.getTime(), at(1).getTime());
  assert.equal(excursion.structuredData.alert.active, true);
  assert.equal(excursion.structuredData.alert.severity, 'CRITICAL');
});

test('temperature excursion deactivates when the latest five-reading average falls below the threshold', () => {
  const activeReadings = [reading(1, 0, 9, 0), reading(2, 1, 9, 1), reading(3, 2, 9, 2), reading(4, 3, 9, 3), reading(5, 4, 9, 4)];
  const active = evaluateMonitoring(batchId, activeReadings);
  assert.equal(active.length, 1);
  const resolved = evaluateMonitoring(batchId, [...activeReadings, reading(6, 5, 2, 5), reading(7, 6, 2, 6)]);
  assert.deepEqual(resolved, []);
});

test('fewer than five readings and one isolated spike do not trigger an excursion', () => {
  assert.deepEqual(evaluateMonitoring(batchId, [reading(1, 0, 10, 0), reading(2, 1, 10, 1), reading(3, 2, 10, 2), reading(4, 3, 10, 3)]), []);
  assert.deepEqual(evaluateMonitoring(batchId, [reading(1, 0, 2, 0), reading(2, 1, 2, 1), reading(3, 2, 30, 2), reading(4, 3, 2, 3), reading(5, 4, 2, 4)]), []);
});

test('quality warning activates without critical and critical replaces warning', () => {
  const warning = evaluateMonitoring(batchId, [reading(1, 0, 7, 0), reading(2, 1, 7, 88)]);
  assert.equal(warning.length, 1);
  assert.equal(warning[0]?.dedupeKey, `${monitoringEventPrefix(batchId)}quality-window:warning`);
  assert.equal(warning[0]?.structuredData.alert.severity, 'WARNING');
  assert.equal(warning[0]?.structuredData.alert.qualityStatus, 'WARNING');
  assert.equal(warning[0]?.occurredAt.getTime(), at(88).getTime());

  const critical = evaluateMonitoring(batchId, [reading(1, 0, 7, 0), reading(2, 1, 7, 104)]);
  assert.equal(critical.length, 1);
  assert.equal(critical[0]?.dedupeKey, `${monitoringEventPrefix(batchId)}quality-window:critical`);
  assert.equal(critical[0]?.structuredData.alert.severity, 'CRITICAL');
  assert.equal(critical[0]?.structuredData.alert.qualityStatus, 'CRITICAL');
  assert.ok(critical.every((decision) => !decision.dedupeKey.endsWith(':warning')));
});

test('dedupe keys are stable for the same canonical boundary', () => {
  const readings = [reading(1, 0, 9, 0), reading(2, 1, 9, 1), reading(3, 2, 9, 2), reading(4, 3, 9, 3), reading(5, 4, 9, 4)];
  const first = evaluateMonitoring(batchId, readings);
  const second = evaluateMonitoring(batchId, readings);
  assert.deepEqual(first, second);
  assert.equal(first[0]?.dedupeKey, `${monitoringEventPrefix(batchId)}temperature-excursion:1`);
});

test('evaluation is deterministic for shuffled readings', () => {
  const readings = [
    reading(5, 4, 9, 4),
    reading(1, 0, 2, 0),
    reading(3, 2, 9, 2),
    reading(4, 3, 9, 3),
    reading(2, 1, 9, 1),
  ];
  const shuffled = [readings[3]!, readings[4]!, readings[0]!, readings[2]!, readings[1]!];
  assert.deepEqual(evaluateMonitoring(batchId, readings), evaluateMonitoring(batchId, shuffled));
});
