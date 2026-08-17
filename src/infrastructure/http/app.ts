import express, { type ErrorRequestHandler } from 'express';

import { PlanService } from '../../application/plan-service';
import { RequestError } from '../../domain/errors';
import { validatePlanProposal } from '../../domain/plans';
import { generateAiPlan } from '../ai/plan-generator';
import { AuthService } from '../auth/auth-service';
import { BatchRepository } from '../persistence/batch-repository';
import type { Database } from '../persistence/database';
import { FishingTripRepository } from '../persistence/fishing-trip-repository';
import { OverviewRepository } from '../persistence/overview-repository';
import { PlanRepository } from '../persistence/plan-repository';
import { ResourceRepository } from '../persistence/resource-repository';
import { TelemetryRepository } from '../persistence/telemetry-repository';
import { createAuthRouter, requireAuth } from './auth-router';
import { createBatchesRouter } from './batches-router';
import { createFishingTripsRouter } from './fishing-trips-router';
import { createOverviewRouter } from './overview-router';
import { createPlansRouter } from './plans-router';
import { createResourcesRouter } from './resources-router';
import { createTelemetryRouter } from './telemetry-router';

export function createApp(database: Database) {
  const app = express();
  const auth = new AuthService(database);
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

  app.use((request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    next();
  });
  app.use(express.json());
  app.get('/', (_request, response) => response.json({ message: 'SIRIP API' }));
  app.use('/api/auth', createAuthRouter(auth));
  app.use('/api/telemetry', createTelemetryRouter(new TelemetryRepository(database)));
  app.use('/api', requireAuth(auth));
  app.use('/api', createOverviewRouter(new OverviewRepository(database)), createResourcesRouter(new ResourceRepository(database)));
  app.use('/api/fishing-trips', createFishingTripsRouter(new FishingTripRepository(database)));
  app.use('/api/batches', createBatchesRouter(new BatchRepository(database)));
  app.use('/api/plans', createPlansRouter(new PlanService(new PlanRepository(database), generateAiPlan, validatePlanProposal)));

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
