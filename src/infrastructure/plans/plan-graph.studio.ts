import { validatePlanProposal } from '../../domain/plans/plans';
import { createDatabase } from '../persistence/database';
import { createPlanGraph } from './plan-graph';
import { PlanRepository } from './plan-repository';

const database = createDatabase();
const repository = new PlanRepository(database);

export const planWorkflow = createPlanGraph({ repository, validate: validatePlanProposal });
