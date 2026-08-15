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
  await database.batch.deleteMany();
  await database.coldStorage.deleteMany();
  await database.vehicle.deleteMany();
  await database.destination.deleteMany();
  await database.batch.create({
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
