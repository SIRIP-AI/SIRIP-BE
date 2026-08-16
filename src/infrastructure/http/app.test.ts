import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { hashPassword } from '../auth/crypto';
import { createDatabase } from '../persistence/database';
import { createApp } from './app';

const connectionString = process.env.TEST_DATABASE_URL;

test('manages setup resources', { skip: !connectionString }, async () => {
  const database = createDatabase(connectionString);
  await database.plan.deleteMany();
  await database.operationalEvent.deleteMany();
  await database.temperatureReading.deleteMany();
  await database.sensorSession.deleteMany();
  await database.sensor.deleteMany();
  await database.batch.deleteMany();
  await database.coldStorage.deleteMany();
  await database.vehicle.deleteMany();
  await database.destination.deleteMany();
  await database.authSession.deleteMany();
  await database.user.deleteMany({ where: { email: { in: ['new.operator@sirip.local', 'other.operator@sirip.local'] } } });
  const passwordHash = await hashPassword('demo-password');
  const operator = await database.user.upsert({
    where: { email: 'operator@sirip.local' },
    update: { passwordHash },
    create: { name: 'Test Operator', email: 'operator@sirip.local', phone: '+620000000000', passwordHash },
  });
  const otherOperator = await database.user.create({
    data: { name: 'Other Operator', email: 'other.operator@sirip.local', phone: '+620000000001', passwordHash },
  });
  const batch = await database.batch.create({
    data: { userId: operator.id, code: 'B-017', weightKg: 120, grade: 'A', status: 'ACTIVE', receivedAt: new Date(), currentTemperatureC: 8, remainingQualityWindowDays: 4.2 },
  });
  const otherBatch = await database.batch.create({
    data: { userId: otherOperator.id, code: 'B-OTHER', weightKg: 90, grade: 'A', status: 'ACTIVE', receivedAt: new Date() },
  });
  await database.operationalEvent.createMany({ data: [
    {
      userId: operator.id,
      batchId: batch.id,
      type: 'TEMPERATURE_EXCURSION',
      source: 'SYSTEM',
      structuredData: { alert: { active: true, severity: 'CRITICAL', qualityStatus: 'WARNING', title: 'B-017 temperature excursion', description: '8.0°C for 42 min · 4.2 days remaining' } },
      occurredAt: new Date(),
    },
    {
      userId: otherOperator.id,
      batchId: otherBatch.id,
      type: 'OTHER',
      source: 'SYSTEM',
      structuredData: { alert: { active: true, severity: 'WARNING', title: 'Other alert', description: 'Must not be visible' } },
      occurredAt: new Date(),
    },
  ] });
  await database.plan.create({
    data: {
      userId: operator.id,
      version: 3,
      status: 'ACTIVE',
      reason: 'Prioritize B-017 after its temperature excursion.',
      approvedById: operator.id,
      approvedAt: new Date(),
      steps: { create: { sequence: 1, actionType: 'INSPECT', batchId: batch.id, scheduledAt: new Date(Date.now() + 60_000), status: 'UPCOMING' } },
    },
  });
  await database.plan.create({
    data: { userId: otherOperator.id, version: 3, status: 'ACTIVE', reason: 'Other plan' },
  });
  const server = createApp(database).listen(0);
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = '';
  const request = (path: string, method = 'GET', body?: object) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    assert.equal((await request('/cold-storages')).status, 401);
    assert.equal((await request('/overview')).status, 401);
    const signupResponse = await request('/auth/signup', 'POST', {
      name: 'New Operator',
      email: 'new.operator@sirip.local',
      phone: '+628111111111',
      password: 'new-password',
    });
    assert.equal(signupResponse.status, 201);
    assert.ok(signupResponse.headers.getSetCookie()[0]?.startsWith('sirip_session='));
    assert.equal((await request('/auth/signup', 'POST', {
      name: 'Duplicate Operator',
      email: 'new.operator@sirip.local',
      phone: '+628222222222',
      password: 'new-password',
    })).status, 409);
    assert.equal((await request('/auth/signup', 'POST', {
      name: 'Invalid Operator',
      email: 'invalid',
      phone: '123',
      password: 'short',
    })).status, 400);
    assert.equal((await request('/auth/login', 'POST', { email: 'operator@sirip.local', password: 'wrong-password' })).status, 401);
    const loginResponse = await request('/auth/login', 'POST', { email: 'operator@sirip.local', password: 'demo-password' });
    assert.equal(loginResponse.status, 200);
    cookie = loginResponse.headers.getSetCookie()[0]?.split(';', 1)[0] ?? '';
    assert.ok(cookie);
    assert.equal((await request('/auth/session')).status, 200);
    const overviewResponse = await request('/overview');
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json() as {
      summary: { activeBatchCount: number; atRiskBatchCount: number; activeAlertCount: number; activePlanVersion: number | null };
      priorityBatches: Array<{ code: string; qualityStatus: string }>;
      activePlan: { version: number; steps: Array<{ batchCode: string }> } | null;
      alerts: Array<{ title: string }>;
    };
    assert.deepEqual(overview.summary, { activeBatchCount: 1, atRiskBatchCount: 1, activeAlertCount: 1, activePlanVersion: 3 });
    assert.deepEqual(overview.priorityBatches.map((item) => [item.code, item.qualityStatus]), [['B-017', 'WARNING']]);
    assert.equal(overview.activePlan?.steps[0]?.batchCode, 'B-017');
    assert.deepEqual(overview.alerts.map((alert) => alert.title), ['B-017 temperature excursion']);

    const coldStorageResponse = await request('/cold-storages', 'POST', {
      name: 'Cold Room 1',
      capacityKg: 500,
      availableCapacityKg: 220,
      status: 'AVAILABLE',
    });
    assert.equal(coldStorageResponse.status, 201);
    const coldStorage = await coldStorageResponse.json() as { id: string };

    const updatedColdStorageResponse = await request(`/cold-storages/${coldStorage.id}`, 'PUT', {
      name: 'Cold Room 1',
      capacityKg: 500,
      availableCapacityKg: 0,
      status: 'FULL',
    });
    assert.equal(updatedColdStorageResponse.status, 200);
    assert.equal((await updatedColdStorageResponse.json() as { status: string }).status, 'FULL');
    assert.equal((await request('/cold-storages').then((response) => response.json()) as unknown[]).length, 1);

    const vehicleResponse = await request('/vehicles', 'POST', {
      code: 'TR-02',
      capacityKg: 800,
      status: 'DELAYED',
      delayMinutes: 90,
      restriction: 'Bridge weight restriction',
      availableFrom: '2026-08-15T12:00:00.000Z',
    });
    assert.equal(vehicleResponse.status, 201);
    const vehicle = await vehicleResponse.json() as { id: string };

    const updatedVehicleResponse = await request(`/vehicles/${vehicle.id}`, 'PUT', {
      code: 'TR-02',
      capacityKg: 800,
      status: 'AVAILABLE',
      delayMinutes: 0,
      restriction: null,
      availableFrom: null,
    });
    assert.equal(updatedVehicleResponse.status, 200);
    assert.equal((await updatedVehicleResponse.json() as { status: string }).status, 'AVAILABLE');

    const destinationResponse = await request('/destinations', 'POST', {
      name: 'Processor A',
      address: 'Tanjung Perak, Surabaya',
      travelMinutes: 45,
      receivingStart: '08:00',
      receivingEnd: '16:00',
      status: 'AVAILABLE',
      notes: 'Call before dispatch',
    });
    assert.equal(destinationResponse.status, 201);
    const destination = await destinationResponse.json() as { id: string };

    const updatedDestinationResponse = await request(`/destinations/${destination.id}`, 'PUT', {
      name: 'Processor A',
      address: 'Tanjung Perak, Surabaya',
      travelMinutes: 50,
      receivingStart: '09:00',
      receivingEnd: '17:00',
      status: 'UNAVAILABLE',
      notes: null,
    });
    assert.equal(updatedDestinationResponse.status, 200);
    assert.equal((await updatedDestinationResponse.json() as { status: string }).status, 'UNAVAILABLE');

    const sensorResponse = await request('/sensors', 'POST', {
      code: 'S-003',
      deviceUid: 'esp32-s-003',
      provisioningStatus: 'PROVISIONED',
    });
    assert.equal(sensorResponse.status, 201);
    const sensor = await sensorResponse.json() as { id: string };

    const assignmentResponse = await request(`/sensors/${sensor.id}/assignment`, 'POST', { batchCode: 'B-017' });
    assert.equal(assignmentResponse.status, 200);
    assert.equal((await assignmentResponse.json() as { assignment: { batchCode: string } }).assignment.batchCode, 'B-017');
    assert.equal((await request(`/sensors/${sensor.id}/diagnostics`)).status, 200);
    assert.equal((await request(`/sensors/${sensor.id}/assignment`, 'DELETE')).status, 200);

    const readiness = await request('/setup-readiness').then((response) => response.json()) as { ready: boolean; completedSteps: number };
    assert.equal(readiness.ready, true);
    assert.equal(readiness.completedSteps, 3);

    const invalidResponse = await request('/cold-storages', 'POST', {
      name: 'Invalid',
      capacityKg: 100,
      availableCapacityKg: 101,
      status: 'AVAILABLE',
    });
    assert.equal(invalidResponse.status, 400);

    assert.equal((await request(`/cold-storages/${coldStorage.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/vehicles/${vehicle.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/destinations/${destination.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/sensors/${sensor.id}`, 'DELETE')).status, 409);
  } finally {
    server.close();
    await database.$disconnect();
  }
});
