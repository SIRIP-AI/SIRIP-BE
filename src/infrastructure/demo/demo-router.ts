import { Router } from 'express';

import type { AuthLocals } from '../auth/auth-router';
import type { DemoService } from './demo-service';

export function createDemoRouter(service: DemoService) {
  const router = Router();
  router.post('/demo', async (_request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.generate(BigInt(user.id)));
  });
  router.post('/demo/reset', async (_request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.reset(user));
  });
  return router;
}
