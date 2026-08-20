import { Router } from 'express';

import {
  destinationStatuses,
  resourceOperationalStatuses,
  sensorProvisioningStatuses,
  type ColdStorageInput,
  type DestinationInput,
  type SensorAssignmentInput,
  type SensorInput,
  type VehicleInput,
} from '../../domain/resources/resources';
import { RequestError } from '../../domain/errors';
import type { AuthLocals } from '../auth/auth-router';
import type { ResourceRepository } from './resource-repository';

function bodyObject(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be an object', 400);
  return body as Record<string, unknown>;
}

function text(body: Record<string, unknown>, field: string) {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) throw new RequestError(`${field} is required`, 400);
  if (value.trim().length > 100) throw new RequestError(`${field} must be at most 100 characters`, 400);
  return value.trim();
}

function positiveNumber(body: Record<string, unknown>, field: string, allowZero = false) {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new RequestError(`${field} must be ${allowZero ? 'zero or greater' : 'greater than zero'}`, 400);
  }
  return value;
}

function integer(body: Record<string, unknown>, field: string) {
  const value = positiveNumber(body, field, true);
  if (!Number.isInteger(value)) throw new RequestError(`${field} must be a whole number`, 400);
  return value;
}

function status<const T extends readonly string[]>(body: Record<string, unknown>, field: string, values: T): T[number] {
  const value = body[field];
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new RequestError(`${field} must be one of: ${values.join(', ')}`, 400);
  }
  return value as T[number];
}

function nullableText(body: Record<string, unknown>, field: string) {
  const value = body[field];
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new RequestError(`${field} must be text`, 400);
  if (value.trim().length > 500) throw new RequestError(`${field} must be at most 500 characters`, 400);
  return value.trim() || null;
}

function time(body: Record<string, unknown>, field: string) {
  const value = body[field];
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new RequestError(`${field} must use HH:mm format`, 400);
  }
  return value;
}

function nullableTime(body: Record<string, unknown>, field: string) {
  const value = body[field];
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new RequestError(`${field} must use HH:mm format`, 400);
  }
  return value;
}

function rejectField(body: Record<string, unknown>, field: string) {
  if (field in body) throw new RequestError(`${field} cannot be changed through resource configuration`, 400);
}

function resourceId(value: string) {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error();
    return id;
  } catch {
    throw new RequestError('Resource ID must be a positive integer', 400);
  }
}

function coldStorageInput(body: unknown): ColdStorageInput {
  const value = bodyObject(body);
  const capacityKg = positiveNumber(value, 'capacityKg');
  const availableCapacityKg = positiveNumber(value, 'availableCapacityKg', true);
  if (availableCapacityKg > capacityKg) throw new RequestError('availableCapacityKg cannot exceed capacityKg', 400);
  rejectField(value, 'status');
  return { name: text(value, 'name'), capacityKg, availableCapacityKg, operationalStatus: status(value, 'operationalStatus', resourceOperationalStatuses) };
}

function vehicleInput(body: unknown): VehicleInput {
  const value = bodyObject(body);
  rejectField(value, 'status');
  rejectField(value, 'delayMinutes');
  rejectField(value, 'delayPersistent');
  const availabilityStart = nullableTime(value, 'availabilityStart');
  const availabilityEnd = nullableTime(value, 'availabilityEnd');
  if ((availabilityStart === null) !== (availabilityEnd === null)) throw new RequestError('availabilityStart and availabilityEnd must both be provided', 400);
  if (availabilityStart && availabilityEnd && availabilityEnd <= availabilityStart) throw new RequestError('availabilityEnd must be after availabilityStart', 400);
  return {
    code: text(value, 'code'),
    capacityKg: positiveNumber(value, 'capacityKg'),
    operationalStatus: status(value, 'operationalStatus', resourceOperationalStatuses),
    restriction: nullableText(value, 'restriction'),
    availabilityStart,
    availabilityEnd,
  };
}

function destinationInput(body: unknown): DestinationInput {
  const value = bodyObject(body);
  const receivingStart = time(value, 'receivingStart');
  const receivingEnd = time(value, 'receivingEnd');
  if (receivingEnd <= receivingStart) throw new RequestError('receivingEnd must be after receivingStart', 400);
  return {
    name: text(value, 'name'),
    address: text(value, 'address'),
    travelMinutes: integer(value, 'travelMinutes'),
    receivingStart,
    receivingEnd,
    status: status(value, 'status', destinationStatuses),
    notes: nullableText(value, 'notes'),
  };
}

function sensorInput(body: unknown): SensorInput {
  const value = bodyObject(body);
  return {
    code: text(value, 'code'),
    deviceUid: text(value, 'deviceUid'),
    provisioningStatus: status(value, 'provisioningStatus', sensorProvisioningStatuses),
  };
}

function sensorAssignmentInput(body: unknown): SensorAssignmentInput {
  const value = bodyObject(body);
  return { batchCode: text(value, 'batchCode') };
}

function userId(locals: object) {
  return BigInt((locals as AuthLocals).user.id);
}

export function createResourcesRouter(repository: ResourceRepository) {
  const router = Router();

  router.get('/setup-readiness', async (_request, response) => response.json(await repository.setupReadiness(userId(response.locals))));
  router.get('/cold-storages', async (_request, response) => response.json(await repository.listColdStorages(userId(response.locals))));
  router.post('/cold-storages', async (request, response) => response.status(201).json(await repository.createColdStorage(userId(response.locals), coldStorageInput(request.body))));
  router.put('/cold-storages/:id', async (request, response) => response.json(await repository.updateColdStorage(userId(response.locals), resourceId(request.params.id), coldStorageInput(request.body))));
  router.delete('/cold-storages/:id', async (request, response) => {
    await repository.deleteColdStorage(userId(response.locals), resourceId(request.params.id));
    response.sendStatus(204);
  });

  router.get('/vehicles', async (_request, response) => response.json(await repository.listVehicles(userId(response.locals))));
  router.post('/vehicles', async (request, response) => response.status(201).json(await repository.createVehicle(userId(response.locals), vehicleInput(request.body))));
  router.put('/vehicles/:id', async (request, response) => response.json(await repository.updateVehicle(userId(response.locals), resourceId(request.params.id), vehicleInput(request.body))));
  router.delete('/vehicles/:id', async (request, response) => {
    await repository.deleteVehicle(userId(response.locals), resourceId(request.params.id));
    response.sendStatus(204);
  });

  router.get('/destinations', async (_request, response) => response.json(await repository.listDestinations(userId(response.locals))));
  router.post('/destinations', async (request, response) => response.status(201).json(await repository.createDestination(userId(response.locals), destinationInput(request.body))));
  router.put('/destinations/:id', async (request, response) => response.json(await repository.updateDestination(userId(response.locals), resourceId(request.params.id), destinationInput(request.body))));
  router.delete('/destinations/:id', async (request, response) => {
    await repository.deleteDestination(userId(response.locals), resourceId(request.params.id));
    response.sendStatus(204);
  });

  router.get('/sensors', async (_request, response) => response.json(await repository.listSensors(userId(response.locals))));
  router.get('/sensors/:id/readings', async (request, response) => response.json(await repository.sensorReadings(userId(response.locals), resourceId(request.params.id))));
  router.post('/sensors', async (request, response) => response.status(201).json(await repository.createSensor(userId(response.locals), sensorInput(request.body))));
  router.put('/sensors/:id', async (request, response) => response.json(await repository.updateSensor(userId(response.locals), resourceId(request.params.id), sensorInput(request.body))));
  router.delete('/sensors/:id', async (request, response) => {
    await repository.deleteSensor(userId(response.locals), resourceId(request.params.id));
    response.sendStatus(204);
  });
  router.get('/sensor-assignment-options', async (_request, response) => response.json(await repository.listSensorAssignmentOptions(userId(response.locals))));
  router.post('/sensors/:id/assignment', async (request, response) => response.json(await repository.assignSensor(userId(response.locals), resourceId(request.params.id), sensorAssignmentInput(request.body))));
  router.delete('/sensors/:id/assignment', async (request, response) => response.json(await repository.unassignSensor(userId(response.locals), resourceId(request.params.id))));
  router.get('/sensors/:id/diagnostics', async (request, response) => response.json(await repository.sensorDiagnostics(userId(response.locals), resourceId(request.params.id))));

  return router;
}
