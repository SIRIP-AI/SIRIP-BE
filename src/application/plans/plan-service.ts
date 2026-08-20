import { ConflictError, RequestError } from '../../domain/errors';
import { planSnapshot, orderPlanProposal, type AiPlanProposal, type PlanList, type PlanningActivePlan, type PlanningContext, type PlanView } from '../../domain/plans/plans';

export type PlanGenerationFeedback = { validationErrors: string[] };
export type PlanGenerationRequest = { instruction?: string };
export type PlanGenerator = (context: PlanningContext, request?: PlanGenerationRequest, feedback?: PlanGenerationFeedback) => Promise<AiPlanProposal>;
export type PlanValidator = (proposal: AiPlanProposal, context: PlanningContext) => string[];

export type PlanRepositoryPort = {
  list(userId: bigint): Promise<PlanList>;
  get(userId: bigint, planId: bigint): Promise<PlanView>;
  loadContext(userId: bigint, batchIds: bigint[], planId?: bigint): Promise<PlanningContext>;
  saveProposal(userId: bigint, proposal: AiPlanProposal, batchIds: bigint[], expectedPlan: PlanningActivePlan | null, options?: { triggerEventId?: bigint; replaceProposalId?: bigint }): Promise<PlanView>;
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

  get(userId: bigint, planId: bigint) {
    return this.repository.get(userId, planId);
  }

  async generateProposal(userId: bigint, batchIds: bigint[], triggerEventId?: bigint) {
    return this.generateAndSave(userId, batchIds, undefined, undefined, triggerEventId);
  }

  async revise(userId: bigint, planId: bigint, instruction: string) {
    const plan = await this.repository.get(userId, planId);
    if (plan.status !== 'ACTIVE' && plan.status !== 'PROPOSED') throw new ConflictError('Only active or proposed plans can be revised');
    return this.generateAndSave(userId, plan.batches.map(({ id }) => BigInt(id)), planId, instruction, undefined, plan.status === 'PROPOSED' ? planId : undefined);
  }

  private async generateAndSave(userId: bigint, batchIds: bigint[], planId?: bigint, instruction?: string, triggerEventId?: bigint, replaceProposalId?: bigint) {
    let generationContext = await this.repository.loadContext(userId, batchIds, planId);
    if (generationContext.batches.length !== batchIds.length) throw new ConflictError('Every selected batch must be active and owned by the user');
    requireGenerationContext(generationContext);
    let proposal = orderPlanProposal(await this.generate(generationContext, { ...(instruction ? { instruction } : {}) }));
    let freshContext = await this.repository.loadContext(userId, batchIds, planId);
    if (freshContext.batches.length !== batchIds.length) throw new ConflictError('Selected batch scope changed during generation');
    requireGenerationContext(freshContext);
    const planChanged = planSnapshot(generationContext.currentPlan) !== planSnapshot(freshContext.currentPlan);
    let errors = planChanged ? ['Current plan changed during generation'] : this.validate(proposal, freshContext);
    if (errors.length) {
      generationContext = freshContext;
      proposal = orderPlanProposal(await this.generate(generationContext, { ...(instruction ? { instruction } : {}) }, feedback(errors)));
      freshContext = await this.repository.loadContext(userId, batchIds, planId);
      if (freshContext.batches.length !== batchIds.length) throw new ConflictError('Selected batch scope changed during generation');
      requireGenerationContext(freshContext);
      if (planSnapshot(generationContext.currentPlan) !== planSnapshot(freshContext.currentPlan)) throw new ConflictError('Current plan changed during generation');
      errors = this.validate(proposal, freshContext);
    }
    if (errors.length) throw new RequestError('AI generated an infeasible plan', 502);
    return this.repository.saveProposal(userId, proposal, batchIds, freshContext.currentPlan, { ...(triggerEventId !== undefined ? { triggerEventId } : {}), ...(replaceProposalId !== undefined ? { replaceProposalId } : {}) });
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
