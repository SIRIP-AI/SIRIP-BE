import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

import type { PlanRepositoryPort, PlanValidator, PlanWorkflow, PlanWorkflowInput } from '../../application/plans/plan-service';
import { ConflictError } from '../../domain/errors';
import { generatePlanCandidates, type PlanCandidate } from '../../domain/plans/plan-candidates';
import { derivePlanningFacts, planSnapshot, type AiPlanResult, type PlanningContext, type PlanningFacts } from '../../domain/plans/plans';
import { createPlanningModel, messageText, parsePlanSelection, planningMessages, type PlanningModel } from './plan-generator';

const PlanGraphState = Annotation.Root({
  userId: Annotation<string>(),
  batchIds: Annotation<string[]>(),
  destinationId: Annotation<string | null>(),
  deadline: Annotation<string | null>(),
  planId: Annotation<string | null>(),
  instruction: Annotation<string | null>(),
  generationContext: Annotation<PlanningContext | null>(),
  generationFacts: Annotation<PlanningFacts | null>(),
  candidates: Annotation<PlanCandidate[]>(),
  freshContext: Annotation<PlanningContext | null>(),
  freshFacts: Annotation<PlanningFacts | null>(),
  result: Annotation<AiPlanResult | null>(),
});

const positiveId = z.string().regex(/^[1-9]\d*$/);
const PlanGraphInputSchema = z.object({
  userId: positiveId,
  batchIds: z.array(positiveId).min(1).max(100),
  destinationId: positiveId.nullable(),
  deadline: z.string().datetime({ offset: true }).nullable(),
  planId: positiveId.nullable(),
  instruction: z.string().trim().min(1).max(2000).nullable(),
});
const PlanGraphOutputSchema = z.object({ result: z.any(), freshContext: z.any() });

export type PlanGraphInput = Pick<typeof PlanGraphState.State, 'userId' | 'batchIds' | 'destinationId' | 'deadline' | 'planId' | 'instruction'>;
export type PlanGraphDependencies = {
  repository: Pick<PlanRepositoryPort, 'loadContext'>;
  validate: PlanValidator;
  model?: () => PlanningModel;
};

function requireGenerationContext(context: PlanningContext) {
  if (!context.batches.length) throw new ConflictError('At least one active batch is required before planning');
  if (context.batches.length > 100) throw new ConflictError('At most 100 active batches can be planned at once');
  if (context.batches.some((batch) => !batch.quality)) throw new ConflictError('Every active batch requires a quality state before planning');
  if (!context.vehicles.some((resource) => resource.operationalStatus === 'AVAILABLE')) throw new ConflictError('At least one available vehicle is required before planning');
  if (!context.destinations.some((resource) => resource.status === 'AVAILABLE')) throw new ConflictError('At least one available destination is required before planning');
  if (context.selectedDestinationId && !context.destinations.some((resource) => resource.id === context.selectedDestinationId && resource.status === 'AVAILABLE')) throw new ConflictError('Selected destination must be available and owned by the user');
}

function noCandidateResult(): AiPlanResult {
  return { status: 'NO_VALID_PROPOSAL_FOUND', reason: 'No feasible plan was found for the current operational constraints.' };
}

export function createPlanGraph({ repository, validate, model = createPlanningModel }: PlanGraphDependencies) {
  const loadContext = async (state: typeof PlanGraphState.State) => {
    const loaded = await repository.loadContext(BigInt(state.userId), state.batchIds.map(BigInt), state.planId ? BigInt(state.planId) : undefined);
    const context = { ...loaded, selectedDestinationId: state.destinationId, deadline: state.deadline };
    if (context.batches.length !== state.batchIds.length) throw new ConflictError('Every selected batch must be active and owned by the user');
    requireGenerationContext(context);
    return { generationContext: context, generationFacts: null, candidates: [], freshContext: null, freshFacts: null, result: null };
  };
  const deriveFacts = (state: typeof PlanGraphState.State) => {
    if (!state.generationContext) throw new Error('Planning context is unavailable');
    return { generationFacts: derivePlanningFacts(state.generationContext) };
  };
  const generateCandidates = (state: typeof PlanGraphState.State) => {
    if (!state.generationContext || !state.generationFacts) throw new Error('Planning context is unavailable');
    return { candidates: generatePlanCandidates(state.generationContext, state.generationFacts) };
  };
  const selectCandidate = async (state: typeof PlanGraphState.State) => {
    if (!state.generationContext || !state.generationFacts) throw new Error('Planning context is unavailable');
    if (!state.candidates.length) return { result: noCandidateResult() };
    if (state.candidates.length === 1) return { result: { status: 'PROPOSAL' as const, ...state.candidates[0]!.proposal } };
    try {
      const response = await model().invoke(planningMessages(state.generationContext, state.generationFacts, state.candidates, state.instruction ?? undefined));
      return { result: { status: 'PROPOSAL' as const, ...parsePlanSelection(messageText(response), state.candidates) } };
    } catch {
      console.warn('[AI plan selection failed; using deterministic candidate]', { planId: state.planId });
      return { result: { status: 'PROPOSAL' as const, ...state.candidates[0]!.proposal } };
    }
  };
  const refreshContext = async (state: typeof PlanGraphState.State) => {
    const loaded = await repository.loadContext(BigInt(state.userId), state.batchIds.map(BigInt), state.planId ? BigInt(state.planId) : undefined);
    const context = { ...loaded, selectedDestinationId: state.destinationId, deadline: state.deadline };
    if (context.batches.length !== state.batchIds.length) throw new ConflictError('Selected batch scope changed during generation');
    requireGenerationContext(context);
    return { freshContext: context };
  };
  const deriveFreshFacts = (state: typeof PlanGraphState.State) => {
    if (!state.freshContext) throw new Error('Fresh planning context is unavailable');
    return { freshFacts: derivePlanningFacts(state.freshContext) };
  };
  const validateOrFallback = (state: typeof PlanGraphState.State) => {
    if (!state.result || !state.generationContext || !state.freshContext || !state.freshFacts) throw new Error('Plan validation state is incomplete');
    if (state.result.status === 'NO_VALID_PROPOSAL_FOUND') return {};
    const changed = planSnapshot(state.generationContext.currentPlan) !== planSnapshot(state.freshContext.currentPlan);
    const errors = changed ? ['Current plan changed during generation'] : validate(state.result, state.freshContext);
    if (!errors.length) return {};
    const freshCandidates = generatePlanCandidates(state.freshContext, state.freshFacts);
    console.warn('[Selected plan became invalid; using fresh deterministic candidate]', { planId: state.planId, errors, candidates: freshCandidates.length });
    return { result: freshCandidates.length ? { status: 'PROPOSAL' as const, ...freshCandidates[0]!.proposal } : noCandidateResult() };
  };

  return new StateGraph(PlanGraphState, { input: PlanGraphInputSchema, output: PlanGraphOutputSchema })
    .addNode('load_context', loadContext)
    .addNode('derive_planning_facts', deriveFacts)
    .addNode('generate_candidates', generateCandidates)
    .addNode('select_candidate', selectCandidate)
    .addNode('refresh_context', refreshContext)
    .addNode('derive_fresh_planning_facts', deriveFreshFacts)
    .addNode('validate_or_fallback', validateOrFallback)
    .addEdge(START, 'load_context')
    .addEdge('load_context', 'derive_planning_facts')
    .addEdge('derive_planning_facts', 'generate_candidates')
    .addEdge('generate_candidates', 'select_candidate')
    .addEdge('select_candidate', 'refresh_context')
    .addEdge('refresh_context', 'derive_fresh_planning_facts')
    .addEdge('derive_fresh_planning_facts', 'validate_or_fallback')
    .addEdge('validate_or_fallback', END)
    .compile();
}

export function createPlanWorkflow(graph: ReturnType<typeof createPlanGraph>): PlanWorkflow {
  return async (input: PlanWorkflowInput) => {
    const result = await graph.invoke({
      userId: input.userId.toString(),
      batchIds: input.batchIds.map(String),
      destinationId: input.destinationId?.toString() ?? null,
      deadline: input.deadline,
      planId: input.planId?.toString() ?? null,
      instruction: input.instruction ?? null,
    });
    if (!result.result || !result.freshContext) throw new Error('Plan graph completed without a validated result');
    return { result: result.result, context: result.freshContext };
  };
}
