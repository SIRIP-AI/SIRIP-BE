import { ConflictError, RequestError } from '../../domain/errors';
import type { AiPlanProposal, AiPlanResult, PlanList, PlanningActivePlan, PlanningContext, PlanView } from '../../domain/plans/plans';
import { derivePlanningFacts } from '../../domain/plans/plans';
import { generatePlanCandidates } from '../../domain/plans/plan-candidates';

export type PlanValidator = (proposal: AiPlanProposal, context: PlanningContext) => string[];
export type PlanWorkflowInput = { userId: bigint; batchIds: bigint[]; destinationId?: bigint; deadline: string | null; planId?: bigint; instruction?: string };
export type PlanWorkflow = (input: PlanWorkflowInput) => Promise<{ result: AiPlanResult; context: PlanningContext }>;
export type PlanGenerationResult = { status: 'PROPOSAL'; proposal: PlanView } | { status: 'NO_VALID_PROPOSAL_FOUND'; reason: string };

export type PlanRepositoryPort = {
  list(userId: bigint): Promise<PlanList>;
  get(userId: bigint, planId: bigint): Promise<PlanView>;
  loadContext(userId: bigint, batchIds: bigint[], planId?: bigint): Promise<PlanningContext>;
  saveProposal(userId: bigint, proposal: AiPlanProposal, batchIds: bigint[], destinationId: bigint, deadline: string | null, expectedPlan: PlanningActivePlan | null, options?: { triggerEventId?: bigint; replaceProposalId?: bigint }): Promise<PlanView>;
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

  async recommendOptions(userId: bigint, batchIds: bigint[], destinationIds: bigint[], deadline: string) {
    const loaded = await this.repository.loadContext(userId, batchIds);
    const destinations = destinationIds.map((destinationId) => {
      const context = { ...loaded, selectedDestinationId: destinationId.toString(), deadline };
      const resource = loaded.destinations.find(({ id }) => id === destinationId.toString());
      const candidates = resource?.status === 'AVAILABLE' ? generatePlanCandidates(context, derivePlanningFacts(context)) : [];
      return { id: destinationId.toString(), feasible: candidates.length > 0, candidateCount: candidates.length, travelMinutes: resource?.travelMinutes ?? null, reason: candidates.length ? `${candidates.length} validated option${candidates.length === 1 ? '' : 's'} with ${resource?.travelMinutes ?? 0} minutes travel.` : 'No validated plan currently reaches this destination.' };
    }).sort((left, right) => Number(right.feasible) - Number(left.feasible) || (left.travelMinutes ?? Number.MAX_SAFE_INTEGER) - (right.travelMinutes ?? Number.MAX_SAFE_INTEGER));
    const facts = derivePlanningFacts({ ...loaded, deadline });
    return { batches: facts.batches.map((batch) => ({ ...batch, recommended: batch.urgencyRank === 1 || batch.resourceFlexibility === 'LOW', reason: batch.urgencyRank === 1 ? 'Earliest effective quality deadline.' : batch.resourceFlexibility === 'LOW' ? 'Limited vehicle flexibility.' : 'Eligible for planning.' })), destinations };
  }

  async generateProposal(userId: bigint, batchIds: bigint[], destinationInput: bigint | bigint[], deadline: string, triggerEventId?: bigint) {
    if (!Array.isArray(destinationInput)) return this.generateAndSave(userId, batchIds, destinationInput, deadline, undefined, undefined, triggerEventId);
    const destinationIds = Array.isArray(destinationInput) ? destinationInput : [destinationInput];
    const options = await this.recommendOptions(userId, batchIds, destinationIds, deadline);
    const chosen = options.destinations.find(({ feasible }) => feasible);
    if (!chosen) return { status: 'NO_VALID_PROPOSAL_FOUND' as const, reason: 'No selected destination has a feasible validated plan.' };
    return this.generateAndSave(userId, batchIds, BigInt(chosen.id), deadline, undefined, undefined, triggerEventId);
  }

  async revise(userId: bigint, planId: bigint, instruction: string, triggerEventId?: bigint) {
    const plan = await this.repository.get(userId, planId);
    if (plan.status !== 'ACTIVE' && plan.status !== 'PROPOSED') throw new ConflictError('Only active or proposed plans can be revised');
    if (!plan.destinationId) throw new ConflictError('Legacy plan has no selected destination');
    return this.generateAndSave(userId, plan.batches.map(({ id }) => BigInt(id)), BigInt(plan.destinationId), plan.deadline, planId, instruction, triggerEventId, plan.status === 'PROPOSED' ? planId : undefined);
  }

  private async generateAndSave(userId: bigint, batchIds: bigint[], destinationId: bigint | undefined, deadline: string | null, planId?: bigint, instruction?: string, triggerEventId?: bigint, replaceProposalId?: bigint): Promise<PlanGenerationResult> {
    const { result, context } = await this.workflow({ userId, batchIds, destinationId, deadline, ...(planId !== undefined ? { planId } : {}), ...(instruction ? { instruction } : {}) });
    if (result.status === 'NO_VALID_PROPOSAL_FOUND') return result;
    if (destinationId === undefined) throw new ConflictError('Plan destination is required');
    const proposal = { summary: result.summary, steps: result.steps };
    const validationErrors = this.validate(proposal, context);
    if (validationErrors.length) {
      console.warn('[AI plan final validation rejected]', { planId: planId?.toString() ?? null, errors: validationErrors });
      throw new RequestError('AI generated an invalid plan', 502);
    }
    return { status: 'PROPOSAL', proposal: await this.repository.saveProposal(userId, proposal, batchIds, destinationId, deadline, context.currentPlan, { ...(triggerEventId !== undefined ? { triggerEventId } : {}), ...(replaceProposalId !== undefined ? { replaceProposalId } : {}) }) };
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
