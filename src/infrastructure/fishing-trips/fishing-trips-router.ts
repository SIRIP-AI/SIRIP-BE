import { Router } from 'express';
import { RequestError } from '../../domain/errors';
import type { FishingTripInput } from '../../domain/fishing-trips/fishing-trips';
import type { AuthLocals } from '../auth/auth-router';
import type { FishingTripRepository } from './fishing-trip-repository';

function object(body: unknown) { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Isi permintaan harus berupa objek', 400); return body as Record<string, unknown>; }
function text(body: Record<string, unknown>, field: string) { const value = body[field]; if (typeof value !== 'string' || !value.trim()) throw new RequestError(`${field} wajib diisi`, 400); if (value.trim().length > 100) throw new RequestError(`${field} maksimal 100 karakter`, 400); return value.trim(); }
function input(body: unknown): FishingTripInput { const value = object(body); for (const field of ['startedAt', 'endedAt', 'status']) if (field in value) throw new RequestError(`${field} tidak boleh diberikan untuk perjalanan penangkapan`, 400); return { code: text(value, 'code'), vesselName: text(value, 'vesselName') }; }
function id(value: string) { try { const parsed = BigInt(value); if (parsed <= 0n) throw new Error(); return parsed; } catch { throw new RequestError('ID perjalanan penangkapan harus berupa bilangan bulat positif', 400); } }
function completionInput(body: unknown) {
  if (body === undefined || (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)) return null;
  const value = object(body);
  if (!Array.isArray(value.batches) || value.batches.length < 1 || value.batches.length > 100) throw new RequestError('batches harus berisi 1 sampai 100 batch hasil pendaratan', 400);
  return value.batches.map((candidate, index) => {
    const batch = object(candidate);
    const weightKg = batch.weightKg;
    if (typeof weightKg !== 'number' || !Number.isFinite(weightKg) || weightKg <= 0) throw new RequestError(`batches[${index}].weightKg harus lebih besar dari nol`, 400);
    return { weightKg, grade: text(batch, 'grade'), sensorId: id(String(batch.sensorId ?? '')) };
  });
}
function userId(locals: object) { return BigInt((locals as AuthLocals).user.id); }

export function createFishingTripsRouter(repository: FishingTripRepository) {
  const router = Router();
  router.get('/', async (_request, response) => response.json(await repository.list(userId(response.locals))));
  router.post('/', async (request, response) => response.status(201).json(await repository.create(userId(response.locals), input(request.body))));
  router.put('/:id', async (request, response) => response.json(await repository.update(userId(response.locals), id(request.params.id), input(request.body))));
  router.post('/:id/complete', async (request, response) => response.json(await repository.complete(userId(response.locals), id(request.params.id), completionInput(request.body))));
  router.delete('/:id', async (request, response) => { await repository.delete(userId(response.locals), id(request.params.id)); response.sendStatus(204); });
  return router;
}
