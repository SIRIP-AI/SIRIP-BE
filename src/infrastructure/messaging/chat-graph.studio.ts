import { createChatGraph } from './chat-graph';
import { createDatabase } from '../persistence/database';
import { PlanRepository } from '../plans/plan-repository';
import { createPlanGraph, createPlanWorkflow } from '../plans/plan-graph';
import { PlanService } from '../../application/plans/plan-service';
import { validateApprovablePlanProposal } from '../../domain/plans/plans';
import { TelegramOperations } from './telegram-operations';

const database = createDatabase();
const repository = new PlanRepository(database);
const plans = new PlanService(repository, createPlanWorkflow(createPlanGraph({ repository, validate: validateApprovablePlanProposal })), validateApprovablePlanProposal);
export const chatWorkflow = createChatGraph(new TelegramOperations(database, plans));
