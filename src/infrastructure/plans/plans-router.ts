import { Router } from 'express';

import type { PlanService } from '../../application/plans/plan-service';
import type { PlanChangeService } from '../../application/plans/plan-change-service';
import { RequestError } from '../../domain/errors';
import type { AuthLocals } from '../auth/auth-router';

function userId(locals: object) {
  return BigInt((locals as AuthLocals).user.id);
}

function id(value: string, label: string) {
  try {
    if (!/^[1-9]\d*$/.test(value)) throw new Error();
    const parsed = BigInt(value);
    if (parsed > 9_223_372_036_854_775_807n) throw new Error();
    return parsed;
  } catch {
    throw new RequestError(`${label} harus berupa bilangan bulat positif`, 400);
  }
}

function proposalRequest(body: unknown) {
  if (typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Isi permintaan harus berupa objek', 400);
  const request = body as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== 'batchIds' && key !== 'destinationId' && key !== 'destinationIds' && key !== 'deadline' && key !== 'triggerEventId')) throw new RequestError('Isi permintaan memuat field yang tidak didukung', 400);
  if (!Array.isArray(request.batchIds) || request.batchIds.length < 1 || request.batchIds.length > 100) throw new RequestError('batchIds harus berisi 1 sampai 100 ID', 400);
  const batchIds = request.batchIds.map((value) => {
    if (typeof value !== 'string') throw new RequestError('batchIds harus berisi string bilangan bulat positif', 400);
    return id(value, 'Batch ID');
  });
  if (new Set(batchIds).size !== batchIds.length) throw new RequestError('batchIds harus unik', 400);
  const rawDestinationIds = Array.isArray(request.destinationIds) ? request.destinationIds : request.destinationId === undefined ? [] : [request.destinationId];
  if (rawDestinationIds.length < 1 || rawDestinationIds.length > 20) throw new RequestError('destinationIds harus berisi 1 sampai 20 ID', 400);
  const destinationIds = rawDestinationIds.map((value) => typeof value === 'string' ? id(value, 'destinationId') : (() => { throw new RequestError('destinationIds harus berisi string bilangan bulat positif', 400); })());
  if (new Set(destinationIds).size !== destinationIds.length) throw new RequestError('destinationIds harus unik', 400);
  if (typeof request.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(request.deadline)) throw new RequestError('deadline harus berupa datetime ISO dengan zona waktu', 400);
  const parsedDeadline = new Date(request.deadline);
  if (Number.isNaN(parsedDeadline.getTime()) || parsedDeadline.getTime() <= Date.now()) throw new RequestError('deadline harus berada di masa depan', 400);
  const deadline = parsedDeadline.toISOString();
  const triggerEventId = request.triggerEventId === undefined || request.triggerEventId === null
    ? undefined
    : typeof request.triggerEventId === 'string' ? id(request.triggerEventId, 'triggerEventId') : (() => { throw new RequestError('triggerEventId harus berupa bilangan bulat positif', 400); })();
  return { batchIds, destinationIds, deadline, ...(triggerEventId !== undefined ? { triggerEventId } : {}) };
}

function revisionInstruction(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Isi permintaan harus berupa objek', 400);
  const request = body as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== 'instruction')) throw new RequestError('Isi permintaan memuat field yang tidak didukung', 400);
  const instruction = typeof request.instruction === 'string' ? request.instruction.trim() : '';
  if (!instruction || instruction.length > 2000) throw new RequestError('instruction harus berisi 1 sampai 2000 karakter', 400);
  return instruction;
}

function changeRequest(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Isi permintaan harus berupa objek', 400);
  const request = body as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== 'instruction' && key !== 'idempotencyKey')) throw new RequestError('Isi permintaan memuat field yang tidak didukung', 400);
  const instruction = typeof request.instruction === 'string' ? request.instruction.trim() : '';
  if (!instruction || instruction.length > 2000) throw new RequestError('instruction harus berisi 1 sampai 2000 karakter', 400);
  if (typeof request.idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.idempotencyKey)) throw new RequestError('idempotencyKey harus berupa UUID', 400);
  return { instruction, idempotencyKey: request.idempotencyKey };
}

export function createPlansRouter(service: PlanService, changes: PlanChangeService) {
  const router = Router();
  router.get('/', async (_request, response) => response.json(await service.list(userId(response.locals))));
  router.post('/proposals', async (request, response) => {
    const input = proposalRequest(request.body);
    const result = await service.generateProposal(userId(response.locals), input.batchIds, input.destinationIds, input.deadline, input.triggerEventId);
    response.status(result.status === 'PROPOSAL' ? 201 : 200).json(result);
  });
  router.get('/:id', async (request, response) => response.json(await service.get(userId(response.locals), id(request.params.id, 'Plan ID'))));
  router.post('/:id/revisions', async (request, response) => {
    const result = await service.revise(userId(response.locals), id(request.params.id, 'Plan ID'), revisionInstruction(request.body));
    response.status(result.status === 'PROPOSAL' ? 201 : 200).json(result);
  });
  router.post('/:id/changes', async (request, response) => {
    const input = changeRequest(request.body);
    response.status(201).json(await changes.submit(userId(response.locals), id(request.params.id, 'Plan ID'), input.instruction, input.idempotencyKey));
  });
  router.post('/:id/approve', async (request, response) => response.json(await service.approve(userId(response.locals), id(request.params.id, 'Plan ID'))));
  router.post('/:id/dismiss', async (request, response) => response.json(await service.dismiss(userId(response.locals), id(request.params.id, 'Plan ID'))));
  router.post('/:id/steps/:stepId/complete', async (request, response) => response.json(await service.completeStep(userId(response.locals), id(request.params.id, 'Plan ID'), id(request.params.stepId, 'Plan step ID'))));
  return router;
}
