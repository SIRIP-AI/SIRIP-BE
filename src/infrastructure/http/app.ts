import express, { type ErrorRequestHandler } from 'express';

import { PlanService } from '../../application/plans/plan-service';
import { RequestError } from '../../domain/errors';
import { validateApprovablePlanProposal } from '../../domain/plans/plans';
import { AuthService } from '../auth/auth-service';
import { createPlanGraph, createPlanWorkflow } from '../plans/plan-graph';
import { BatchRepository } from '../batches/batch-repository';
import { createBatchesRouter } from '../batches/batches-router';
import { FishingTripRepository } from '../fishing-trips/fishing-trip-repository';
import { createFishingTripsRouter } from '../fishing-trips/fishing-trips-router';
import { createDemoRouter } from '../demo/demo-router';
import { DemoService } from '../demo/demo-service';
import { OverviewRepository } from '../overview/overview-repository';
import { createOverviewRouter } from '../overview/overview-router';
import { PlanRepository } from '../plans/plan-repository';
import { createPlansRouter } from '../plans/plans-router';
import { ResourceRepository } from '../resources/resource-repository';
import { createResourcesRouter } from '../resources/resources-router';
import { TelemetryRepository } from '../telemetry/telemetry-repository';
import { createTelemetryRouter } from '../telemetry/telemetry-router';
import { requireAuth, createAuthRouter } from '../auth/auth-router';
import type { Database } from '../persistence/database';
import type { TelegramService } from '../messaging/telegram-service';
import { createTelegramAccountRouter, createTelegramWebhookRouter } from '../messaging/telegram-router';

export function createApp(database: Database, telegram: TelegramService) {
  const app = express();
  const auth = new AuthService(database);
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

  app.use((request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sensor-api-key');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    next();
  });
  app.use(express.json());
  app.get('/', (_request, response) => response.json({ message: 'SIRIP API' }));
  app.use('/api/integrations/telegram', createTelegramWebhookRouter(telegram));
  app.use('/api/auth', createAuthRouter(auth));
  const telemetry = new TelemetryRepository(database, telegram);
  app.use('/api/telemetry', createTelemetryRouter(telemetry));
  app.use('/api', requireAuth(auth));
  app.use('/api/debug', createDemoRouter(new DemoService(database, telemetry)));
  app.use('/api/integrations/telegram', createTelegramAccountRouter(telegram));
  app.use('/api', createOverviewRouter(new OverviewRepository(database)), createResourcesRouter(new ResourceRepository(database)));
  app.use('/api/fishing-trips', createFishingTripsRouter(new FishingTripRepository(database)));
  app.use('/api/batches', createBatchesRouter(new BatchRepository(database)));
  const plans = new PlanRepository(database);
  const planWorkflow = createPlanWorkflow(createPlanGraph({ repository: plans, validate: validateApprovablePlanProposal }));
  app.use('/api/plans', createPlansRouter(new PlanService(plans, planWorkflow, validateApprovablePlanProposal)));

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
