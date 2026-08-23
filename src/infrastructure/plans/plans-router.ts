import { Router } from 'express';

import type { PlanService } from '../../application/plans/plan-service';
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
    throw new RequestError(`${label} must be a positive integer`, 400);
  }
}

function proposalRequest(body: unknown) {
  if (typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be an object', 400);
  const request = body as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== 'batchIds' && key !== 'destinationId' && key !== 'destinationIds' && key !== 'deadline' && key !== 'triggerEventId')) throw new RequestError('Request body contains unsupported fields', 400);
  if (!Array.isArray(request.batchIds) || request.batchIds.length < 1 || request.batchIds.length > 100) throw new RequestError('batchIds must contain 1 to 100 IDs', 400);
  const batchIds = request.batchIds.map((value) => {
    if (typeof value !== 'string') throw new RequestError('batchIds must contain positive integer strings', 400);
    return id(value, 'Batch ID');
  });
  if (new Set(batchIds).size !== batchIds.length) throw new RequestError('batchIds must be distinct', 400);
  const rawDestinationIds = Array.isArray(request.destinationIds) ? request.destinationIds : request.destinationId === undefined ? [] : [request.destinationId];
  if (rawDestinationIds.length < 1 || rawDestinationIds.length > 20) throw new RequestError('destinationIds must contain 1 to 20 IDs', 400);
  const destinationIds = rawDestinationIds.map((value) => typeof value === 'string' ? id(value, 'destinationId') : (() => { throw new RequestError('destinationIds must contain positive integer strings', 400); })());
  if (typeof request.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(request.deadline)) throw new RequestError('deadline must be an ISO datetime with timezone', 400);
  const parsedDeadline = new Date(request.deadline);
  if (Number.isNaN(parsedDeadline.getTime()) || parsedDeadline.getTime() <= Date.now()) throw new RequestError('deadline must be in the future', 400);
  const deadline = parsedDeadline.toISOString();
  const triggerEventId = request.triggerEventId === undefined || request.triggerEventId === null
    ? undefined
    : typeof request.triggerEventId === 'string' ? id(request.triggerEventId, 'triggerEventId') : (() => { throw new RequestError('triggerEventId must be a positive integer', 400); })();
  return { batchIds, destinationIds, deadline, ...(triggerEventId !== undefined ? { triggerEventId } : {}) };
}

function revisionInstruction(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be an object', 400);
  const request = body as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== 'instruction')) throw new RequestError('Request body contains unsupported fields', 400);
  const instruction = typeof request.instruction === 'string' ? request.instruction.trim() : '';
  if (!instruction || instruction.length > 2000) throw new RequestError('instruction must contain 1 to 2000 characters', 400);
  return instruction;
}

export function createPlansRouter(service: PlanService) {
  const router = Router();
  router.get('/', async (_request, response) => response.json(await service.list(userId(response.locals))));
  router.post('/proposals', async (request, response) => {
    const input = proposalRequest(request.body);
    const result = await service.generateProposal(userId(response.locals), input.batchIds, input.destinationIds, input.deadline, input.triggerEventId);
    response.status(result.status === 'PROPOSAL' ? 201 : 200).json(result);
  });
  router.post('/options', async (request, response) => { const input = proposalRequest(request.body); response.json(await service.recommendOptions(userId(response.locals), input.batchIds, input.destinationIds, input.deadline)); });
  router.get('/:id', async (request, response) => response.json(await service.get(userId(response.locals), id(request.params.id, 'Plan ID'))));
  router.post('/:id/revisions', async (request, response) => {
    const result = await service.revise(userId(response.locals), id(request.params.id, 'Plan ID'), revisionInstruction(request.body));
    response.status(result.status === 'PROPOSAL' ? 201 : 200).json(result);
  });
  router.post('/:id/approve', async (request, response) => response.json(await service.approve(userId(response.locals), id(request.params.id, 'Plan ID'))));
  router.post('/:id/dismiss', async (request, response) => response.json(await service.dismiss(userId(response.locals), id(request.params.id, 'Plan ID'))));
  router.post('/:id/steps/:stepId/complete', async (request, response) => response.json(await service.completeStep(userId(response.locals), id(request.params.id, 'Plan ID'), id(request.params.stepId, 'Plan step ID'))));
  return router;
}
