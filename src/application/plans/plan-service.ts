import { ConflictError, RequestError } from '../../domain/errors';
import type { AiPlanProposal, AiPlanResult, PlanList, PlanningActivePlan, PlanningContext, PlanView } from '../../domain/plans/plans';

export type PlanValidator = (proposal: AiPlanProposal, context: PlanningContext) => string[];
export type PlanWorkflowInput = { userId: bigint; batchIds: bigint[]; destinationIds: bigint[]; deadline: string | null; planId?: bigint; instruction?: string };
export type PlanWorkflow = (input: PlanWorkflowInput) => Promise<{ result: AiPlanResult; context: PlanningContext }>;
export type PlanGenerationResult = { status: 'PROPOSAL'; proposal: PlanView } | { status: 'NO_VALID_PROPOSAL_FOUND'; reason: string };

export type PlanRepositoryPort = {
  list(userId: bigint): Promise<PlanList>;
  get(userId: bigint, planId: bigint): Promise<PlanView>;
  loadContext(userId: bigint, batchIds: bigint[], planId?: bigint): Promise<PlanningContext>;
  saveProposal(userId: bigint, proposal: AiPlanProposal, batchIds: bigint[], destinationIds: bigint[], deadline: string | null, expectedPlan: PlanningActivePlan | null, options?: { triggerEventId?: bigint; replaceProposalId?: bigint }): Promise<PlanView>;
  activateProposal(userId: bigint, planId: bigint): Promise<PlanView>;
  dismissProposal(userId: bigint, planId: bigint): Promise<PlanView>;
  completeStep(userId: bigint, planId: bigint, stepId: bigint): Promise<PlanView>;
};

export class PlanService {
  constructor(
    private readonly repository: PlanRepositoryPort,
    private readonly workflow: PlanWorkflow,
    private readonly validate: PlanValidator,
  ) {}

  list(userId: bigint) {
    return this.repository.list(userId);
  }

  get(userId: bigint, planId: bigint) {
    return this.repository.get(userId, planId);
  }

  async generateProposal(userId: bigint, batchIds: bigint[], destinationInput: bigint | bigint[], deadline: string, triggerEventId?: bigint) {
    const destinationIds = Array.isArray(destinationInput) ? destinationInput : [destinationInput];
    return this.generateAndSave(userId, batchIds, destinationIds, deadline, undefined, undefined, triggerEventId);
  }

  async revise(userId: bigint, planId: bigint, instruction: string, triggerEventId?: bigint) {
    const plan = await this.repository.get(userId, planId);
    if (plan.status !== 'ACTIVE' && plan.status !== 'PROPOSED') throw new ConflictError('Only active or proposed plans can be revised');
    const destinationIds = plan.destinationIds?.length ? plan.destinationIds.map(BigInt) : plan.destinationId ? [BigInt(plan.destinationId)] : [];
    if (!destinationIds.length) throw new ConflictError('Legacy plan has no destination scope');
    return this.generateAndSave(userId, plan.batches.map(({ id }) => BigInt(id)), destinationIds, plan.deadline, planId, instruction, triggerEventId, plan.status === 'PROPOSED' ? planId : undefined);
  }

  private async generateAndSave(userId: bigint, batchIds: bigint[], destinationIds: bigint[], deadline: string | null, planId?: bigint, instruction?: string, triggerEventId?: bigint, replaceProposalId?: bigint): Promise<PlanGenerationResult> {
    const { result, context } = await this.workflow({ userId, batchIds, destinationIds, deadline, ...(planId !== undefined ? { planId } : {}), ...(instruction ? { instruction } : {}) });
    if (result.status === 'NO_VALID_PROPOSAL_FOUND') return result;
    if (!destinationIds.length) throw new ConflictError('At least one plan destination is required');
    const proposal = { summary: result.summary, steps: result.steps };
    const validationErrors = this.validate(proposal, context);
    if (validationErrors.length) {
      console.warn('[AI plan final validation rejected]', { planId: planId?.toString() ?? null, errors: validationErrors });
      throw new RequestError('AI generated an invalid plan', 502);
    }
    return { status: 'PROPOSAL', proposal: await this.repository.saveProposal(userId, proposal, batchIds, destinationIds, deadline, context.currentPlan, { ...(triggerEventId !== undefined ? { triggerEventId } : {}), ...(replaceProposalId !== undefined ? { replaceProposalId } : {}) }) };
  }

  approve(userId: bigint, planId: bigint) {
    return this.repository.activateProposal(userId, planId);
  }

  dismiss(userId: bigint, planId: bigint) {
    return this.repository.dismissProposal(userId, planId);
  }

  completeStep(userId: bigint, planId: bigint, stepId: bigint) {
    return this.repository.completeStep(userId, planId, stepId);
  }
}
