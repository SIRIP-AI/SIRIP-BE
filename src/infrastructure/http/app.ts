import express, { type ErrorRequestHandler } from 'express';

import { RequestError } from '../../domain/setup/errors';
import { AuthService } from '../auth/auth-service';
import type { Database } from '../persistence/database';
import { OverviewRepository } from '../persistence/overview-repository';
import { SetupRepository } from '../persistence/setup-repository';
import { createAuthRouter, requireAuth } from './auth-router';
import { createOverviewRouter } from './overview-router';
import { createSetupRouter } from './setup-router';

export function createApp(database: Database) {
  const app = express();
  const auth = new AuthService(database);
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

  app.use((request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    next();
  });
  app.use(express.json());
  app.get('/', (_request, response) => response.json({ message: 'SIRIP API' }));
  app.use('/api/auth', createAuthRouter(auth));
  app.use('/api', requireAuth(auth), createOverviewRouter(new OverviewRepository(database)), createSetupRouter(new SetupRepository(database)));

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof RequestError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      response.status(400).json({ error: 'Request body must contain valid JSON' });
      return;
    }
    response.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
}
