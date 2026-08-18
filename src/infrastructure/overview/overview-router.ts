import { Router } from 'express';

import type { AuthLocals } from '../auth/auth-router';
import type { OverviewRepository } from './overview-repository';

export function createOverviewRouter(repository: OverviewRepository) {
  const router = Router();

  router.get('/overview', async (_request, response) => {
    const user = (response.locals as AuthLocals).user;
    response.json(await repository.overview(BigInt(user.id)));
  });

  return router;
}
