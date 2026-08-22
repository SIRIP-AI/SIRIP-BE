import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateMonitoring } from '../../domain/monitoring/monitoring';
import { calculateQualityState } from '../../domain/quality/quality';
import { baselineTemperatures, demoActiveBatches, demoBatches, demoDeviceUid, demoTrips, isUnsafeDemoSession } from './demo-service';

test('demo dataset defines the reproducible completed-trip and batch state', () => {
  assert.deepEqual(demoTrips.map(({ code }) => code), ['FT-101', 'FT-102', 'FT-103']);
  assert.deepEqual(demoBatches.map(({ code }) => code), ['B-101', 'B-102', 'B-103', 'B-104', 'B-105', 'B-106']);
  assert.deepEqual(demoTrips.map(({ code }) => demoBatches.filter((batch) => batch.tripCode === code).length), [2, 2, 2]);
  assert.deepEqual(demoBatches.slice(0, 3).map((batch) => [batch.status, batch.weightKg, 'sensorCode' in batch ? batch.sensorCode : null]), [
    ['MONITORING', 180, 'SIM-S-101'],
    ['MONITORING', 420, 'SIM-S-102'],
    ['MONITORING', 220, 'SIM-S-103'],
  ]);
  assert.deepEqual(demoBatches.slice(3).map((batch) => [batch.status, 'sensorCode' in batch]), [['CLOSED', false], ['CLOSED', false], ['CLOSED', false]]);
});

test('baseline telemetry stays near 2C without alerts and yields ordered quality windows', () => {
  const now = Date.UTC(2026, 7, 20);
  const windows = demoActiveBatches.map((batch, batchIndex) => {
    const durationDays = (12 - batch.qualityWindowDays) / Math.exp(0.12 * 2);
    const readings = baselineTemperatures.map((temperatureC, index) => ({
      id: BigInt(batchIndex * 5 + index + 1),
      sequenceNumber: BigInt(index + 1),
      temperatureC,
      measuredAt: new Date(now - durationDays * 86_400_000 + index * durationDays * 86_400_000 / (baselineTemperatures.length - 1)),
    }));
    assert.equal(evaluateMonitoring(BigInt(batchIndex + 1), readings).some((event) => event.structuredData.rule.name === 'temperature-excursion'), false);
    assert.equal(calculateQualityState(readings)?.currentTemperatureC, 2);
    return calculateQualityState(readings)!.remainingQualityWindowDays;
  });
  assert.ok(Math.abs(windows[0]! - 2.4) < 0.1);
  assert.ok(Math.abs(windows[1]! - 2.7) < 0.1);
  assert.ok(Math.abs(windows[2]! - 3) < 0.1);
  assert.ok(windows[0]! < windows[1]! && windows[1]! < windows[2]!);
});

test('demo session validation accepts only wholly owned reserved-to-reserved assignments', () => {
  const userId = 7n;
  const sensorIds = new Set([11n, 12n]);
  const batchIds = new Set([21n, 22n]);
  const session = { sensorId: 11n, batchId: 21n, sensor: { userId }, batch: { userId } };

  assert.equal(isUnsafeDemoSession(userId, sensorIds, batchIds, session), false);
  assert.equal(isUnsafeDemoSession(userId, sensorIds, batchIds, { ...session, sensorId: 13n }), true);
  assert.equal(isUnsafeDemoSession(userId, sensorIds, batchIds, { ...session, batchId: 23n }), true);
  assert.equal(isUnsafeDemoSession(userId, sensorIds, batchIds, { ...session, sensor: { userId: 8n } }), true);
  assert.equal(isUnsafeDemoSession(userId, sensorIds, batchIds, { ...session, batch: { userId: null } }), true);
});

test('reserved codes and per-user device UIDs are stable and distinct', () => {
  assert.equal(demoTrips[0].code, 'FT-101');
  assert.equal(demoBatches[0].code, 'B-101');
  assert.equal(demoBatches[0].sensorCode, 'SIM-S-101');
  assert.deepEqual(demoBatches.slice(0, 2).map((_, index) => demoDeviceUid(7n, index)), ['sirip-demo-device:7:1', 'sirip-demo-device:7:2']);
  assert.equal(new Set(demoBatches.slice(0, 3).map((_, index) => demoDeviceUid(7n, index))).size, 3);
  assert.notEqual(demoDeviceUid(7n, 0), demoDeviceUid(8n, 0));
});
