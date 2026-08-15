import { Router } from 'express';

import { coldStorageStatuses, vehicleStatuses, type ColdStorageInput, type VehicleInput } from '../../domain/setup/resources';
import { RequestError } from '../../domain/setup/errors';
import type { SetupRepository } from '../persistence/setup-repository';

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

function nullableDateTime(body: Record<string, unknown>, field: string) {
  const value = body[field];
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new RequestError(`${field} must be a valid date and time`, 400);
  return new Date(value).toISOString();
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
  return { name: text(value, 'name'), capacityKg, availableCapacityKg, status: status(value, 'status', coldStorageStatuses) };
}

function vehicleInput(body: unknown): VehicleInput {
  const value = bodyObject(body);
  return {
    code: text(value, 'code'),
    capacityKg: positiveNumber(value, 'capacityKg'),
    status: status(value, 'status', vehicleStatuses),
    delayMinutes: integer(value, 'delayMinutes'),
    restriction: nullableText(value, 'restriction'),
    availableFrom: nullableDateTime(value, 'availableFrom'),
  };
}

export function createSetupRouter(repository: SetupRepository) {
  const router = Router();

  router.get('/cold-storages', async (_request, response) => response.json(await repository.listColdStorages()));
  router.post('/cold-storages', async (request, response) => response.status(201).json(await repository.createColdStorage(coldStorageInput(request.body))));
  router.put('/cold-storages/:id', async (request, response) => response.json(await repository.updateColdStorage(resourceId(request.params.id), coldStorageInput(request.body))));
  router.delete('/cold-storages/:id', async (request, response) => {
    await repository.deleteColdStorage(resourceId(request.params.id));
    response.sendStatus(204);
  });

  router.get('/vehicles', async (_request, response) => response.json(await repository.listVehicles()));
  router.post('/vehicles', async (request, response) => response.status(201).json(await repository.createVehicle(vehicleInput(request.body))));
  router.put('/vehicles/:id', async (request, response) => response.json(await repository.updateVehicle(resourceId(request.params.id), vehicleInput(request.body))));
  router.delete('/vehicles/:id', async (request, response) => {
    await repository.deleteVehicle(resourceId(request.params.id));
    response.sendStatus(204);
  });

  return router;
}
