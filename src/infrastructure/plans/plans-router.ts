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

function optionalTriggerEventId(body: unknown) {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be an object', 400);
  const value = (body as Record<string, unknown>).triggerEventId;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RequestError('triggerEventId must be a positive integer', 400);
  return id(value, 'triggerEventId');
}

export function createPlansRouter(service: PlanService) {
  const router = Router();
  router.get('/', async (_request, response) => response.json(await service.list(userId(response.locals))));
  router.post('/proposals', async (request, response) => response.status(201).json(await service.generateProposal(userId(response.locals), optionalTriggerEventId(request.body))));
  router.post('/:id/approve', async (request, response) => response.json(await service.approve(userId(response.locals), id(request.params.id, 'Plan ID'))));
  router.post('/:id/dismiss', async (request, response) => response.json(await service.dismiss(userId(response.locals), id(request.params.id, 'Plan ID'))));
  router.post('/:id/steps/:stepId/complete', async (request, response) => response.json(await service.completeStep(userId(response.locals), id(request.params.id, 'Plan ID'), id(request.params.stepId, 'Plan step ID'))));
  return router;
}
