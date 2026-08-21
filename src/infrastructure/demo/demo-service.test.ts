import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateMonitoring } from '../../domain/monitoring/monitoring';
import { demoBatches, demoDeviceUid, demoTrips, isUnsafeDemoSession } from './demo-service';

test('demo dataset defines three trips, two batches per trip, and thirty safe readings', () => {
  assert.equal(demoTrips.length, 3);
  assert.equal(demoBatches.length, 6);
  assert.equal(new Set(demoTrips.map(({ code }) => code)).size, 3);
  assert.equal(new Set(demoBatches.map(({ code }) => code)).size, 6);
  assert.equal(new Set(demoBatches.map(({ sensorCode }) => sensorCode)).size, 6);
  assert.deepEqual(demoTrips.map(({ code }) => demoBatches.filter((batch) => batch.tripCode === code).length), [2, 2, 2]);
  assert.equal(demoBatches.reduce((count, batch) => count + batch.temperatures.length, 0), 30);
  assert.deepEqual(new Set(demoBatches.map(({ profile }) => profile)), new Set(['healthy', 'warming']));

  for (const [batchIndex, batch] of demoBatches.entries()) {
    assert.equal(batch.temperatures.length, 5);
    const readings = batch.temperatures.map((temperatureC, index) => ({
      id: BigInt(batchIndex * 5 + index + 1),
      sequenceNumber: BigInt(index + 1),
      temperatureC,
      measuredAt: new Date(Date.UTC(2026, 7, 20, index * 6)),
    }));
    assert.equal(evaluateMonitoring(BigInt(batchIndex + 1), readings).some((event) => event.structuredData.rule.name === 'temperature-excursion'), false);
  }
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
  assert.equal(demoTrips[0].code, 'DEMO-TRIP');
  assert.equal(demoBatches[0].code, 'DEMO-BATCH');
  assert.equal(demoBatches[0].sensorCode, 'DEMO-SENSOR');
  assert.deepEqual(demoBatches.slice(0, 2).map((_, index) => demoDeviceUid(7n, index)), ['sirip-demo-device:7:1', 'sirip-demo-device:7:2']);
  assert.equal(new Set(demoBatches.map((_, index) => demoDeviceUid(7n, index))).size, 6);
  assert.notEqual(demoDeviceUid(7n, 0), demoDeviceUid(8n, 0));
});
