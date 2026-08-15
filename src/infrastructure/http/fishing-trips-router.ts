import { Router } from 'express';
import { RequestError } from '../../domain/errors';
import type { FishingTripInput } from '../../domain/fishing-trips';
import type { FishingTripRepository } from '../persistence/fishing-trip-repository';

function object(body: unknown) { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be an object', 400); return body as Record<string, unknown>; }
function text(body: Record<string, unknown>, field: string) { const value = body[field]; if (typeof value !== 'string' || !value.trim()) throw new RequestError(`${field} is required`, 400); if (value.trim().length > 100) throw new RequestError(`${field} must be at most 100 characters`, 400); return value.trim(); }
function input(body: unknown): FishingTripInput { const value = object(body); for (const field of ['startedAt', 'endedAt', 'status']) if (field in value) throw new RequestError(`${field} cannot be provided for fishing trips`, 400); return { code: text(value, 'code'), vesselName: text(value, 'vesselName') }; }
function id(value: string) { try { const parsed = BigInt(value); if (parsed <= 0n) throw new Error(); return parsed; } catch { throw new RequestError('Fishing trip ID must be a positive integer', 400); } }

export function createFishingTripsRouter(repository: FishingTripRepository) {
  const router = Router();
  router.get('/', async (_request, response) => response.json(await repository.list()));
  router.post('/', async (request, response) => response.status(201).json(await repository.create(input(request.body))));
  router.put('/:id', async (request, response) => response.json(await repository.update(id(request.params.id), input(request.body))));
  router.post('/:id/complete', async (request, response) => response.json(await repository.complete(id(request.params.id))));
  router.delete('/:id', async (request, response) => { await repository.delete(id(request.params.id)); response.sendStatus(204); });
  return router;
}
