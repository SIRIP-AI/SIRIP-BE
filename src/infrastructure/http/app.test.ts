import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { hashPassword } from '../auth/crypto';
import { createDatabase } from '../persistence/database';
import { createApp } from './app';

const connectionString = process.env.TEST_DATABASE_URL;

test('manages authenticated account operations', { skip: !connectionString }, async () => {
  const database = createDatabase(connectionString);
  await database.temperatureReading.deleteMany();
  await database.sensorSession.deleteMany();
  await database.planStep.deleteMany();
  await database.plan.deleteMany();
  await database.operationalEvent.deleteMany();
  await database.sensor.deleteMany();
  await database.batch.deleteMany();
  await database.fishingTrip.deleteMany();
  await database.coldStorage.deleteMany();
  await database.vehicle.deleteMany();
  await database.destination.deleteMany();
  await database.authSession.deleteMany();
  await database.user.deleteMany();
  const passwordHash = await hashPassword('demo-password');
  const operator = await database.user.create({
    data: { name: 'Test Operator', email: 'operator@sirip.local', phone: '+620000000000', passwordHash },
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
  await database.batch.create({
    data: { userId: operator.id, code: 'B-DELETED', weightKg: 80, grade: 'B', status: 'ACTIVE', receivedAt: new Date(), deletedAt: new Date() },
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
  const plan = await database.plan.create({
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
  const request = (path: string, method = 'GET', body?: object, sessionCookie = cookie) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    assert.equal((await request('/cold-storages')).status, 401);
    assert.equal((await request('/overview')).status, 401);
    assert.equal((await request('/fishing-trips')).status, 401);
    assert.equal((await request('/batches')).status, 401);
    const signupResponse = await request('/auth/signup', 'POST', {
      name: 'New Operator',
      email: 'new.operator@sirip.local',
      phone: '+628111111111',
      password: 'new-password',
    });
    assert.equal(signupResponse.status, 201);
    const signupCookie = signupResponse.headers.getSetCookie()[0]?.split(';', 1)[0] ?? '';
    assert.ok(signupCookie.startsWith('sirip_session='));
    assert.equal((await request('/auth/session', 'GET', undefined, signupCookie)).status, 200);
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

    const otherLoginResponse = await request('/auth/login', 'POST', { email: 'other.operator@sirip.local', password: 'demo-password' });
    assert.equal(otherLoginResponse.status, 200);
    const otherCookie = otherLoginResponse.headers.getSetCookie()[0]?.split(';', 1)[0] ?? '';
    assert.ok(otherCookie);
    const otherInitialReadiness = await request('/setup-readiness', 'GET', undefined, otherCookie).then((response) => response.json());
    assert.deepEqual(otherInitialReadiness, { ready: false, completedSteps: 0, totalSteps: 4, steps: [
      { key: 'coldStorages', label: 'Configure cold storage', complete: false, count: 0 },
      { key: 'vehicles', label: 'Configure trucks', complete: false, count: 0 },
      { key: 'destinations', label: 'Configure destinations', complete: false, count: 0 },
      { key: 'sensors', label: 'Configure sensors', complete: false, count: 0 },
    ] });
    const otherColdStorageResponse = await request('/cold-storages', 'POST', {
      name: 'Cold Room 1', capacityKg: 300, availableCapacityKg: 300, operationalStatus: 'AVAILABLE',
    }, otherCookie);
    assert.equal(otherColdStorageResponse.status, 201);
    const otherColdStorage = await otherColdStorageResponse.json() as { id: string };
    const otherVehicleResponse = await request('/vehicles', 'POST', {
      code: 'TR-02', capacityKg: 600, operationalStatus: 'AVAILABLE', restriction: null, availabilityStart: '08:00', availabilityEnd: '16:00',
    }, otherCookie);
    assert.equal(otherVehicleResponse.status, 201);
    const otherVehicle = await otherVehicleResponse.json() as { id: string };
    const otherDestinationResponse = await request('/destinations', 'POST', {
      name: 'Processor A', address: 'Other port', travelMinutes: 30, receivingStart: '08:00', receivingEnd: '16:00', status: 'AVAILABLE', notes: null,
    }, otherCookie);
    assert.equal(otherDestinationResponse.status, 201);
    const otherDestination = await otherDestinationResponse.json() as { id: string };
    const otherSensorResponse = await request('/sensors', 'POST', {
      code: 'S-003', deviceUid: 'other-esp32-s-003', provisioningStatus: 'PROVISIONED',
    }, otherCookie);
    assert.equal(otherSensorResponse.status, 201);
    const otherSensor = await otherSensorResponse.json() as { id: string };

    const otherTripResponse = await request('/fishing-trips', 'POST', { code: 'FT-DELETE', vesselName: 'KM Other' }, otherCookie);
    assert.equal(otherTripResponse.status, 201);
    const otherTrip = await otherTripResponse.json() as { id: string };
    const otherDeletableBatchResponse = await request('/batches', 'POST', { code: 'B-DELETE', fishingTripId: otherTrip.id, weightKg: 20, grade: 'A', receivedAt: new Date().toISOString() }, otherCookie);
    assert.equal(otherDeletableBatchResponse.status, 201);
    const otherDeletableBatch = await otherDeletableBatchResponse.json() as { id: string };

    const tripResponse = await request('/fishing-trips', 'POST', { code: 'FT-DELETE', vesselName: 'KM Test' });
    assert.equal(tripResponse.status, 201);
    const trip = await tripResponse.json() as { id: string };
    const deletableBatchResponse = await request('/batches', 'POST', { code: 'B-DELETE', fishingTripId: trip.id, weightKg: 10, grade: 'A', receivedAt: new Date().toISOString() });
    assert.equal(deletableBatchResponse.status, 201);
    const deletableBatch = await deletableBatchResponse.json() as { id: string };
    assert.equal((await request('/batches', 'POST', { code: 'B-CROSS', fishingTripId: otherTrip.id, weightKg: 10, grade: 'A', receivedAt: new Date().toISOString() })).status, 404);
    assert.equal((await request(`/batches/${deletableBatch.id}`, 'PUT', { code: 'B-DELETE', fishingTripId: otherTrip.id, weightKg: 11, grade: 'A', receivedAt: new Date().toISOString() })).status, 404);
    assert.equal((await request(`/batches/${otherDeletableBatch.id}`, 'DELETE')).status, 404);
    assert.equal((await request(`/fishing-trips/${otherTrip.id}/complete`)).status, 404);
    assert.deepEqual((await request('/fishing-trips').then((response) => response.json()) as Array<{ id: string }>).map(({ id }) => id), [trip.id]);
    assert.equal((await request('/batches?filter=invalid')).status, 400);
    assert.ok((await request('/batches?filter=active').then((response) => response.json()) as Array<{ id: string }>).some(({ id }) => id === deletableBatch.id));
    assert.equal((await request(`/fishing-trips/${trip.id}`, 'DELETE')).status, 409);
    assert.equal((await request(`/batches/${deletableBatch.id}`, 'DELETE')).status, 204);
    assert.equal((await request('/batches').then((response) => response.json()) as Array<{ id: string }>).some(({ id }) => id === deletableBatch.id), false);
    assert.equal((await request(`/fishing-trips/${trip.id}`, 'DELETE')).status, 204);
    assert.equal((await request('/fishing-trips').then((response) => response.json()) as Array<{ id: string }>).some(({ id }) => id === trip.id), false);
    const emptyTripResponse = await request('/fishing-trips', 'POST', { code: 'FT-EMPTY', vesselName: 'KM Empty' });
    assert.equal(emptyTripResponse.status, 201);
    const emptyTrip = await emptyTripResponse.json() as { id: string };
    assert.equal((await request(`/fishing-trips/${emptyTrip.id}`, 'DELETE')).status, 204);
    assert.equal((await request('/fishing-trips').then((response) => response.json()) as Array<{ id: string }>).some(({ id }) => id === emptyTrip.id), false);
    assert.ok((await request('/batches', 'GET', undefined, otherCookie).then((response) => response.json()) as Array<{ id: string }>).some(({ id }) => id === otherDeletableBatch.id));

    const coldStorageResponse = await request('/cold-storages', 'POST', {
      name: 'Cold Room 1',
      capacityKg: 500,
      availableCapacityKg: 220,
      operationalStatus: 'AVAILABLE',
    });
    assert.equal(coldStorageResponse.status, 201);
    const coldStorage = await coldStorageResponse.json() as { id: string };
    const updatedColdStorageResponse = await request(`/cold-storages/${coldStorage.id}`, 'PUT', {
      name: 'Cold Room 1',
      capacityKg: 500,
      availableCapacityKg: 0,
      operationalStatus: 'AVAILABLE',
    });
    assert.equal(updatedColdStorageResponse.status, 200);
    assert.equal((await updatedColdStorageResponse.json() as { status: string }).status, 'FULL');
    assert.equal((await request(`/cold-storages/${coldStorage.id}`, 'PUT', {
      name: 'Cold Room 1',
      capacityKg: 500,
      availableCapacityKg: 0,
      operationalStatus: 'UNAVAILABLE',
    })).status, 409);

    const vehicleResponse = await request('/vehicles', 'POST', {
      code: 'TR-02',
      capacityKg: 800,
      operationalStatus: 'AVAILABLE',
      restriction: 'Bridge weight restriction',
      availabilityStart: '08:00',
      availabilityEnd: '16:00',
    });
    assert.equal(vehicleResponse.status, 201);
    const vehicle = await vehicleResponse.json() as { id: string };
    const updatedVehicleResponse = await request(`/vehicles/${vehicle.id}`, 'PUT', {
      code: 'TR-02',
      capacityKg: 800,
      operationalStatus: 'AVAILABLE',
      restriction: null,
      availabilityStart: '09:00',
      availabilityEnd: '17:00',
    });
    assert.equal(updatedVehicleResponse.status, 200);
    assert.deepEqual(await updatedVehicleResponse.json().then((value) => ({ status: value.status, availabilityStart: value.availabilityStart, availabilityEnd: value.availabilityEnd })), { status: 'AVAILABLE', availabilityStart: '09:00', availabilityEnd: '17:00' });
    assert.equal((await request(`/vehicles/${vehicle.id}`, 'PUT', {
      code: 'TR-02', capacityKg: 800, operationalStatus: 'AVAILABLE', delayMinutes: 90, restriction: null, availabilityStart: '09:00', availabilityEnd: '17:00',
    })).status, 400);
    await database.vehicle.update({ where: { id: BigInt(vehicle.id) }, data: { delayMinutes: 90 } });
    await database.planStep.create({
      data: { planId: plan.id, sequence: 2, actionType: 'DISPATCH', batchId: batch.id, vehicleId: BigInt(vehicle.id), scheduledAt: new Date(), status: 'UPCOMING' },
    });
    const assignedVehicle = await request('/vehicles').then((response) => response.json()) as Array<{ status: string; delayMinutes: number }>;
    assert.deepEqual(assignedVehicle.map(({ status, delayMinutes }) => ({ status, delayMinutes })), [{ status: 'ASSIGNED', delayMinutes: 90 }]);

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
    const sensor = await sensorResponse.json() as { id: string; provisioningStatus: string; connectivityStatus: string; lastSeenAt: string | null };
    assert.equal(sensor.provisioningStatus, 'PROVISIONED');
    assert.equal(sensor.connectivityStatus, 'ONLINE');
    assert.ok(sensor.lastSeenAt && !Number.isNaN(Date.parse(sensor.lastSeenAt)));
    assert.deepEqual((await request('/cold-storages').then((response) => response.json()) as Array<{ id: string }>).map(({ id }) => id), [coldStorage.id]);
    assert.deepEqual((await request('/cold-storages', 'GET', undefined, otherCookie).then((response) => response.json()) as Array<{ id: string }>).map(({ id }) => id), [otherColdStorage.id]);
    assert.deepEqual((await request('/vehicles').then((response) => response.json()) as Array<{ id: string }>).map(({ id }) => id), [vehicle.id]);
    assert.deepEqual((await request('/vehicles', 'GET', undefined, otherCookie).then((response) => response.json()) as Array<{ id: string }>).map(({ id }) => id), [otherVehicle.id]);
    assert.deepEqual((await request('/destinations').then((response) => response.json()) as Array<{ id: string }>).map(({ id }) => id), [destination.id]);
    assert.deepEqual((await request('/destinations', 'GET', undefined, otherCookie).then((response) => response.json()) as Array<{ id: string }>).map(({ id }) => id), [otherDestination.id]);
    assert.deepEqual((await request('/sensors').then((response) => response.json()) as Array<{ id: string }>).map(({ id }) => id), [sensor.id]);
    assert.deepEqual((await request('/sensors', 'GET', undefined, otherCookie).then((response) => response.json()) as Array<{ id: string }>).map(({ id }) => id), [otherSensor.id]);
    assert.equal((await request(`/cold-storages/${otherColdStorage.id}`, 'PUT', { name: 'Stolen', capacityKg: 300, availableCapacityKg: 300, operationalStatus: 'AVAILABLE' })).status, 404);
    assert.equal((await request(`/vehicles/${otherVehicle.id}`, 'DELETE')).status, 404);
    assert.equal((await request(`/destinations/${otherDestination.id}`, 'DELETE')).status, 404);
    assert.equal((await request(`/sensors/${otherSensor.id}/diagnostics`)).status, 404);
    assert.equal((await request(`/sensors/${otherSensor.id}/assignment`, 'POST', { batchCode: 'B-OTHER' })).status, 404);
    assert.equal((await request(`/sensors/${sensor.id}/assignment`, 'POST', { batchCode: 'B-OTHER' })).status, 404);
    assert.equal((await request('/sensors', 'POST', { code: 'S-OTHER', deviceUid: 'other-esp32-s-003', provisioningStatus: 'PROVISIONED' })).status, 409);
    assert.deepEqual((await request('/sensor-assignment-options').then((response) => response.json()) as Array<{ code: string }>).map(({ code }) => code), ['B-017']);
    assert.deepEqual((await request('/sensor-assignment-options', 'GET', undefined, otherCookie).then((response) => response.json()) as Array<{ code: string }>).map(({ code }) => code), ['B-DELETE', 'B-OTHER']);
    assert.equal((await request(`/sensors/${otherSensor.id}/assignment`, 'POST', { batchCode: 'B-OTHER' }, otherCookie)).status, 200);
    assert.equal((await request(`/sensors/${otherSensor.id}/assignment`, 'DELETE')).status, 404);
    assert.equal((await request(`/sensors/${otherSensor.id}/assignment`, 'DELETE', undefined, otherCookie)).status, 200);
    const assignmentResponse = await request(`/sensors/${sensor.id}/assignment`, 'POST', { batchCode: 'B-017' });
    assert.equal(assignmentResponse.status, 200);
    assert.equal((await assignmentResponse.json() as { assignment: { batchCode: string } }).assignment.batchCode, 'B-017');
    assert.equal((await request(`/sensors/${sensor.id}/diagnostics`)).status, 200);
    assert.equal((await request(`/sensors/${sensor.id}`, 'DELETE')).status, 409);
    assert.equal((await request(`/batches/${batch.id}`, 'DELETE')).status, 204);
    const availableSensor = (await request('/sensors').then((response) => response.json()) as Array<{ id: string; status: string; assignment: unknown }>).find(({ id }) => id === sensor.id);
    assert.deepEqual(availableSensor, { id: sensor.id, status: 'AVAILABLE', assignment: null });
    assert.equal(await database.sensorSession.count({ where: { batchId: batch.id, status: 'COMPLETED' } }), 1);
    assert.equal(await database.operationalEvent.count({ where: { batchId: batch.id } }), 1);
    assert.equal(await database.planStep.count({ where: { batchId: batch.id } }), 2);
    const overviewAfterBatchDeletion = await request('/overview').then((response) => response.json()) as { summary: { activeBatchCount: number; activeAlertCount: number }; activePlan: { steps: unknown[] } };
    assert.equal(overviewAfterBatchDeletion.summary.activeBatchCount, 0);
    assert.equal(overviewAfterBatchDeletion.summary.activeAlertCount, 0);
    assert.deepEqual(overviewAfterBatchDeletion.activePlan.steps, []);
    const readiness = await request('/setup-readiness').then((response) => response.json()) as { ready: boolean; completedSteps: number };
    assert.equal(readiness.ready, true);
    assert.equal(readiness.completedSteps, 4);
    assert.equal((await request(`/sensors/${sensor.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/sensors/${sensor.id}/diagnostics`)).status, 404);
    assert.equal((await request('/sensors').then((response) => response.json()) as Array<{ id: string }>).some(({ id }) => id === sensor.id), false);
    const reprovisionedSensorResponse = await request('/sensors', 'POST', { code: 'S-003', deviceUid: 'esp32-s-003', provisioningStatus: 'PROVISIONED' });
    assert.equal(reprovisionedSensorResponse.status, 201);
    assert.equal((await reprovisionedSensorResponse.json() as { id: string }).id, sensor.id);
    assert.equal((await request('/cold-storages', 'POST', { name: 'Invalid', capacityKg: 100, availableCapacityKg: 101, operationalStatus: 'AVAILABLE' })).status, 400);
    assert.equal((await request(`/cold-storages/${coldStorage.id}`, 'DELETE')).status, 204);
    await database.planStep.deleteMany({ where: { vehicleId: BigInt(vehicle.id) } });
    assert.equal((await request(`/vehicles/${vehicle.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/destinations/${destination.id}`, 'DELETE')).status, 204);
    assert.equal((await request('/auth/session', 'DELETE')).status, 204);
    assert.equal((await request('/auth/session')).status, 401);
  } finally {
    server.close();
    await database.$disconnect();
  }
});
