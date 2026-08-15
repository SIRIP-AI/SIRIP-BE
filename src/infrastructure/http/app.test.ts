import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createApp } from './app';
import { createDatabase } from '../persistence/database';

const connectionString = process.env.TEST_DATABASE_URL;

test('manages operational resources', { skip: !connectionString }, async () => {
  const database = createDatabase(connectionString);
  await database.temperatureReading.deleteMany();
  await database.sensorSession.deleteMany();
  await database.sensor.deleteMany();
  await database.planStep.deleteMany();
  await database.plan.deleteMany();
  await database.operationalEvent.deleteMany();
  await database.batch.deleteMany();
  await database.coldStorage.deleteMany();
  await database.vehicle.deleteMany();
  await database.destination.deleteMany();
  const batch = await database.batch.create({
    data: { code: 'B-017', weightKg: 120, grade: 'A', status: 'ACTIVE', receivedAt: new Date() },
  });
  const server = createApp(database).listen(0);
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (path: string, method = 'GET', body?: object) => fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
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
    assert.equal((await request('/cold-storages').then((response) => response.json()) as unknown[]).length, 1);

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
    assert.equal((await updatedVehicleResponse.json() as { status: string }).status, 'AVAILABLE');
    assert.equal((await request(`/vehicles/${vehicle.id}`, 'PUT', {
      code: 'TR-02',
      capacityKg: 800,
      operationalStatus: 'AVAILABLE',
      delayMinutes: 90,
      restriction: null,
      availabilityStart: '09:00',
      availabilityEnd: '17:00',
    })).status, 400);

    await database.vehicle.update({ where: { id: BigInt(vehicle.id) }, data: { delayMinutes: 90 } });
    const delayedVehicle = await request('/vehicles').then((response) => response.json()) as Array<{ status: string; delayMinutes: number }>;
    assert.equal(delayedVehicle[0].status, 'AVAILABLE');
    assert.equal(delayedVehicle[0].delayMinutes, 90);

    const plan = await database.plan.create({ data: { version: 1, status: 'ACTIVE', reason: 'Integration test' } });
    await database.planStep.create({
      data: { planId: plan.id, sequence: 1, actionType: 'DISPATCH', batchId: batch.id, vehicleId: BigInt(vehicle.id), scheduledAt: new Date(), status: 'UPCOMING' },
    });
    const assignedVehicle = await request('/vehicles').then((response) => response.json()) as Array<{ status: string }>;
    assert.equal(assignedVehicle[0].status, 'ASSIGNED');

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

    const invalidResponse = await request('/cold-storages', 'POST', {
      name: 'Invalid',
      capacityKg: 100,
      availableCapacityKg: 101,
      operationalStatus: 'AVAILABLE',
    });
    assert.equal(invalidResponse.status, 400);

    assert.equal((await request(`/cold-storages/${coldStorage.id}`, 'DELETE')).status, 204);
    await database.plan.delete({ where: { id: plan.id } });
    assert.equal((await request(`/vehicles/${vehicle.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/destinations/${destination.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/sensors/${sensor.id}`, 'DELETE')).status, 409);
  } finally {
    server.close();
    await database.$disconnect();
  }
});
