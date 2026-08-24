import { Router } from 'express';

import type { AuthLocals } from '../auth/auth-router';
import type { DemoService } from './demo-service';
import { RequestError } from '../../domain/errors';

function id(value: string) {
  if (!/^[1-9]\d*$/.test(value)) throw new RequestError('ID sensor harus berupa bilangan bulat positif', 400);
  return BigInt(value);
}

export function createDemoRouter(service: DemoService) {
  const router = Router();
  router.post('/demo', async (_request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.load(user));
  });
  router.post('/demo/reset', async (_request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.reset(user));
  });
  router.post('/demo/sensors/:id/excursion', async (request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.simulateExcursion(user, id(request.params.id ?? '')));
  });
  router.post('/demo/sensors/:id/recovery', async (request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.simulateRecovery(user, id(request.params.id ?? '')));
  });
  router.post('/demo/sensors/:id/offline', async (request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.simulateOffline(user, id(request.params.id ?? '')));
  });
  router.post('/demo/sensors/:id/reconnect', async (request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.reconnectSensor(user, id(request.params.id ?? '')));
  });
  router.post('/demo/batches/:id/quality-risk', async (request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.simulateQualityRisk(user, id(request.params.id ?? '')));
  });
  return router;
}
