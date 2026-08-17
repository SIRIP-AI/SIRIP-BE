import { Router } from 'express';

import type { OverviewRepository } from '../persistence/overview-repository';
import type { AuthLocals } from './auth-router';

export function createOverviewRouter(repository: OverviewRepository) {
  const router = Router();

  router.get('/overview', async (_request, response) => {
    const user = (response.locals as AuthLocals).user;
    response.json(await repository.overview(BigInt(user.id)));
  });

  return router;
}
