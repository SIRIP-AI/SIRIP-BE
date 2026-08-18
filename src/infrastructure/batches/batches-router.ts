import { Router } from 'express';
import { batchFilters, type BatchFilter, type BatchInput } from '../../domain/batches/batches';
import { RequestError } from '../../domain/errors';
import type { AuthLocals } from '../auth/auth-router';
import type { BatchRepository } from './batch-repository';

const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function object(body: unknown) { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be an object', 400); return body as Record<string, unknown>; }
function text(body: Record<string, unknown>, field: string) { const value = body[field]; if (typeof value !== 'string' || !value.trim()) throw new RequestError(`${field} is required`, 400); if (value.trim().length > 100) throw new RequestError(`${field} must be at most 100 characters`, 400); return value.trim(); }
function id(value: unknown, label: string) { try { if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new Error(); const parsed = BigInt(value); if (parsed <= 0n) throw new Error(); return parsed; } catch { throw new RequestError(`${label} must be a positive integer`, 400); } }
function input(body: unknown): BatchInput { const value = object(body); if ('status' in value) throw new RequestError('status cannot be provided for batches', 400); if (typeof value.weightKg !== 'number' || !Number.isFinite(value.weightKg) || value.weightKg <= 0) throw new RequestError('weightKg must be greater than zero', 400); if (typeof value.receivedAt !== 'string' || !isoDateTime.test(value.receivedAt) || !Number.isFinite(Date.parse(value.receivedAt))) throw new RequestError('receivedAt must be a valid ISO datetime', 400); return { code: text(value, 'code'), fishingTripId: id(value.fishingTripId, 'fishingTripId'), weightKg: value.weightKg, grade: text(value, 'grade'), receivedAt: new Date(value.receivedAt).toISOString() }; }
function filter(value: unknown): BatchFilter | undefined { if (value === undefined) return undefined; if (typeof value !== 'string' || !batchFilters.includes(value as BatchFilter)) throw new RequestError(`filter must be one of: ${batchFilters.join(', ')}`, 400); return value as BatchFilter; }
function userId(locals: object) { return BigInt((locals as AuthLocals).user.id); }

export function createBatchesRouter(repository: BatchRepository) {
  const router = Router();
  router.get('/', async (request, response) => response.json(await repository.list(userId(response.locals), filter(request.query.filter))));
  router.post('/', async (request, response) => response.status(201).json(await repository.create(userId(response.locals), input(request.body))));
  router.put('/:id', async (request, response) => response.json(await repository.update(userId(response.locals), id(request.params.id, 'Batch ID'), input(request.body))));
  router.delete('/:id', async (request, response) => { await repository.delete(userId(response.locals), id(request.params.id, 'Batch ID')); response.sendStatus(204); });
  return router;
}
