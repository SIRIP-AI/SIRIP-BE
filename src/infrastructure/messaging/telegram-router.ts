import { Router } from 'express';

import { RequestError } from '../../domain/errors';
import type { AuthLocals } from '../auth/auth-router';
import type { TelegramService } from './telegram-service';

export function createTelegramWebhookRouter(service: TelegramService) {
  const router = Router();
  router.post('/webhook', async (request, response) => {
    const secret = request.headers['x-telegram-bot-api-secret-token'];
    if (!service.verifySecret(typeof secret === 'string' ? secret : undefined)) throw new RequestError('Secret webhook Telegram tidak valid', 401);
    await service.receive(request.body);
    response.sendStatus(204);
  });
  return router;
}

export function createTelegramAccountRouter(service: TelegramService) {
  const router = Router();
  router.get('/', async (_request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.status(BigInt(user.id)));
  });
  router.post('/link', async (_request, response) => {
    const { user } = response.locals as AuthLocals;
    response.json(await service.createLink(BigInt(user.id)));
  });
  router.delete('/', async (_request, response) => {
    const { user } = response.locals as AuthLocals;
    await service.disconnect(BigInt(user.id));
    response.sendStatus(204);
  });
  return router;
}
