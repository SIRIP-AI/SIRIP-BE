import { ConflictError, RequestError } from '../../domain/errors';
import type { AiPlanProposal, AiPlanResult, PlanList, PlanningActivePlan, PlanningContext, PlanView } from '../../domain/plans/plans';

export type PlanValidator = (proposal: AiPlanProposal, context: PlanningContext) => string[];
export type PlanWorkflowInput = { userId: bigint; batchIds: bigint[]; destinationId?: bigint; deadline: string | null; planId?: bigint; instruction?: string };
export type PlanWorkflow = (input: PlanWorkflowInput) => Promise<{ result: AiPlanResult; context: PlanningContext }>;
export type PlanGenerationResult = { status: 'FEASIBLE'; proposal: PlanView } | { status: 'INFEASIBLE'; reason: string };

export type PlanRepositoryPort = {
  list(userId: bigint): Promise<PlanList>;
  get(userId: bigint, planId: bigint): Promise<PlanView>;
  loadContext(userId: bigint, batchIds: bigint[], planId?: bigint): Promise<PlanningContext>;
  saveProposal(userId: bigint, proposal: AiPlanProposal, batchIds: bigint[], deadline: string | null, expectedPlan: PlanningActivePlan | null, options?: { triggerEventId?: bigint; replaceProposalId?: bigint }): Promise<PlanView>;
  activateProposal(userId: bigint, planId: bigint, validate: PlanValidator): Promise<PlanView>;
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

  async generateProposal(userId: bigint, batchIds: bigint[], destinationId: bigint, deadline: string, triggerEventId?: bigint) {
    return this.generateAndSave(userId, batchIds, destinationId, deadline, undefined, undefined, triggerEventId);
  }

  async revise(userId: bigint, planId: bigint, instruction: string) {
    const plan = await this.repository.get(userId, planId);
    if (plan.status !== 'ACTIVE' && plan.status !== 'PROPOSED') throw new ConflictError('Only active or proposed plans can be revised');
    return this.generateAndSave(userId, plan.batches.map(({ id }) => BigInt(id)), undefined, plan.deadline, planId, instruction, undefined, plan.status === 'PROPOSED' ? planId : undefined);
  }

  private async generateAndSave(userId: bigint, batchIds: bigint[], destinationId: bigint | undefined, deadline: string | null, planId?: bigint, instruction?: string, triggerEventId?: bigint, replaceProposalId?: bigint): Promise<PlanGenerationResult> {
    const { result, context } = await this.workflow({ userId, batchIds, destinationId, deadline, ...(planId !== undefined ? { planId } : {}), ...(instruction ? { instruction } : {}) });
    if (result.status === 'INFEASIBLE') return result;
    const proposal = { reason: result.reason, steps: result.steps };
    if (this.validate(proposal, context).length) throw new RequestError('AI generated an infeasible plan', 502);
    return { status: 'FEASIBLE', proposal: await this.repository.saveProposal(userId, proposal, batchIds, deadline, context.currentPlan, { ...(triggerEventId !== undefined ? { triggerEventId } : {}), ...(replaceProposalId !== undefined ? { replaceProposalId } : {}) }) };
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
