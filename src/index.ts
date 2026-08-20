import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { createApp } from './infrastructure/http/app';
import { createDatabase } from './infrastructure/persistence/database';
import { TelegramService } from './infrastructure/messaging/telegram-service';
import { TelegramOperations } from './infrastructure/messaging/telegram-operations';
import { PlanRepository } from './infrastructure/plans/plan-repository';
import { createPlanGraph, createPlanWorkflow } from './infrastructure/plans/plan-graph';
import { PlanService } from './application/plans/plan-service';
import { validatePlanProposal } from './domain/plans/plans';

if (existsSync('.env')) loadEnvFile('.env');

const database = createDatabase();
const planRepository = new PlanRepository(database);
const planService = new PlanService(planRepository, createPlanWorkflow(createPlanGraph({ repository: planRepository, validate: validatePlanProposal })), validatePlanProposal);
const telegram = new TelegramService(database, new TelegramOperations(database, planService));
const app = createApp(database, telegram);
const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
  void telegram.initialize().then((initialized) => console.log(initialized ? 'Telegram integration initialized' : 'Telegram integration disabled')).catch((error) => console.error('Telegram initialization failed', error instanceof Error ? error.message : 'Unknown error'));
});

async function shutdown() {
  server.close();
  await database.$disconnect();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
