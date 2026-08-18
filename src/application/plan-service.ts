import { ConflictError, RequestError } from '../domain/errors';
import { activePlanSnapshot, orderPlanProposal, type AiPlanProposal, type PlanList, type PlanningActivePlan, type PlanningContext, type PlanView } from '../domain/plans';

export type PlanGenerationFeedback = { validationErrors: string[] };
export type PlanGenerator = (context: PlanningContext, feedback?: PlanGenerationFeedback) => Promise<AiPlanProposal>;
export type PlanValidator = (proposal: AiPlanProposal, context: PlanningContext) => string[];

export type PlanRepositoryPort = {
  list(userId: bigint): Promise<PlanList>;
  loadContext(userId: bigint): Promise<PlanningContext>;
  saveProposal(userId: bigint, proposal: AiPlanProposal, expectedActivePlan: PlanningActivePlan | null): Promise<PlanView>;
  activateProposal(userId: bigint, planId: bigint, validate: PlanValidator): Promise<PlanView>;
  dismissProposal(userId: bigint, planId: bigint): Promise<PlanView>;
  completeStep(userId: bigint, planId: bigint, stepId: bigint): Promise<PlanView>;
};

function feedback(errors: string[]) {
  return { validationErrors: errors.slice(0, 20).map((error) => error.slice(0, 300)) };
}

function requireGenerationContext(context: PlanningContext) {
  if (!context.batches.length) throw new ConflictError('At least one active batch is required before planning');
  if (context.batches.length > 100) throw new ConflictError('At most 100 active batches can be planned at once');
  if (context.batches.some((batch) => !batch.quality)) throw new ConflictError('Every active batch requires a quality state before planning');
  if (!context.coldStorages.some((resource) => resource.operationalStatus === 'AVAILABLE')) throw new ConflictError('At least one available cold storage is required before planning');
  if (!context.vehicles.some((resource) => resource.operationalStatus === 'AVAILABLE')) throw new ConflictError('At least one available vehicle is required before planning');
  if (!context.destinations.some((resource) => resource.status === 'AVAILABLE')) throw new ConflictError('At least one available destination is required before planning');
}

export class PlanService {
  constructor(
    private readonly repository: PlanRepositoryPort,
    private readonly generate: PlanGenerator,
    private readonly validate: PlanValidator,
  ) {}

  list(userId: bigint) {
    return this.repository.list(userId);
  }

  async generateProposal(userId: bigint) {
    let generationContext = await this.repository.loadContext(userId);
    requireGenerationContext(generationContext);
    let proposal = orderPlanProposal(await this.generate(generationContext));
    let freshContext = await this.repository.loadContext(userId);
    requireGenerationContext(freshContext);
    const activePlanChanged = activePlanSnapshot(generationContext.activePlan) !== activePlanSnapshot(freshContext.activePlan);
    let errors = activePlanChanged ? ['Active plan changed during generation'] : this.validate(proposal, freshContext);
    if (errors.length) {
      generationContext = freshContext;
      proposal = orderPlanProposal(await this.generate(generationContext, feedback(errors)));
      freshContext = await this.repository.loadContext(userId);
      requireGenerationContext(freshContext);
      if (activePlanSnapshot(generationContext.activePlan) !== activePlanSnapshot(freshContext.activePlan)) throw new ConflictError('Active plan changed during generation');
      errors = this.validate(proposal, freshContext);
    }
    if (errors.length) throw new RequestError('AI generated an infeasible plan', 502);
    return this.repository.saveProposal(userId, proposal, freshContext.activePlan);
  }

  approve(userId: bigint, planId: bigint) {
    return this.repository.activateProposal(userId, planId, this.validate);
  }

  dismiss(userId: bigint, planId: bigint) {
    return this.repository.dismissProposal(userId, planId);
  }

  completeStep(userId: bigint, planId: bigint, stepId: bigint) {
    return this.repository.completeStep(userId, planId, stepId);
  }
}
