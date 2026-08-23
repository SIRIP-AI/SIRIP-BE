import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

import type { PlanRepositoryPort, PlanValidator, PlanWorkflow, PlanWorkflowInput } from '../../application/plans/plan-service';
import { ConflictError, RequestError } from '../../domain/errors';
import { derivePlanningFacts, evaluatePlanQuality, InvalidPlanProposalError, orderPlanProposal, parseAiPlanResult, planSnapshot, type AiPlanResult, type PlanningContext, type PlanningFacts } from '../../domain/plans/plans';
import { createPlanningModel, messageText, normalizePlanResponse, planningMessages, planningProviderError, type PlanningModel } from './plan-generator';

const PlanGraphState = Annotation.Root({
  userId: Annotation<string>(),
  batchIds: Annotation<string[]>(),
  destinationId: Annotation<string | null>(),
  deadline: Annotation<string | null>(),
  planId: Annotation<string | null>(),
  instruction: Annotation<string | null>(),
  generationContext: Annotation<PlanningContext | null>(),
  generationFacts: Annotation<PlanningFacts | null>(),
  freshContext: Annotation<PlanningContext | null>(),
  freshFacts: Annotation<PlanningFacts | null>(),
  rawOutput: Annotation<string | null>(),
  result: Annotation<AiPlanResult | null>(),
  parserError: Annotation<string | null>(),
  parserRepairCount: Annotation<number>(),
  validationErrors: Annotation<string[]>(),
  validationRepairCount: Annotation<number>(),
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

export function createPlanGraph({ repository, validate, model = createPlanningModel }: PlanGraphDependencies) {
  const load = async (state: typeof PlanGraphState.State) => {
    const loaded = await repository.loadContext(BigInt(state.userId), state.batchIds.map(BigInt), state.planId ? BigInt(state.planId) : undefined);
    const context = { ...loaded, selectedDestinationId: state.destinationId, deadline: state.deadline };
    if (context.batches.length !== state.batchIds.length) throw new ConflictError('Every selected batch must be active and owned by the user');
    requireGenerationContext(context);
    return { generationContext: context, generationFacts: null, freshContext: null, freshFacts: null, rawOutput: null, result: null, parserError: null, parserRepairCount: 0, validationErrors: [], validationRepairCount: 0 };
  };
  const derive = (state: typeof PlanGraphState.State) => {
    if (!state.generationContext) throw new Error('Planning context is unavailable');
    return { generationFacts: derivePlanningFacts(state.generationContext) };
  };
  const generate = async (state: typeof PlanGraphState.State) => {
    if (!state.generationContext || !state.generationFacts) throw new Error('Planning context is unavailable');
    try {
      const response = await model().invoke(planningMessages(state.generationContext, state.generationFacts, state.instruction ?? undefined, state.parserError ?? undefined, state.validationErrors, state.rawOutput ?? undefined));
      const rawOutput = messageText(response);
      return { rawOutput, result: null };
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw planningProviderError(error);
    }
  };
  const parse = (state: typeof PlanGraphState.State) => {
    try {
      const result = parseAiPlanResult(normalizePlanResponse(state.rawOutput ?? ''));
      return { result: result.status === 'PROPOSAL' ? { status: 'PROPOSAL' as const, ...orderPlanProposal(result) } : result, parserError: null };
    } catch (error) {
      if (!(error instanceof InvalidPlanProposalError)) throw error;
      const parserError = error.message.slice(0, 300);
      console.warn('[AI plan parse rejected]', { planId: state.planId, error: parserError });
      return { result: null, parserError, parserRepairCount: (state.parserRepairCount ?? 0) + 1 };
    }
  };
  const afterParse = (state: typeof PlanGraphState.State) => {
    if (state.result) return 'refresh_context';
    if ((state.parserRepairCount ?? 0) <= 1) return 'generate';
    throw new RequestError('AI provider returned an invalid plan', 502);
  };
  const refresh = async (state: typeof PlanGraphState.State) => {
    const loaded = await repository.loadContext(BigInt(state.userId), state.batchIds.map(BigInt), state.planId ? BigInt(state.planId) : undefined);
    const context = { ...loaded, selectedDestinationId: state.destinationId, deadline: state.deadline };
    if (context.batches.length !== state.batchIds.length) throw new ConflictError('Selected batch scope changed during generation');
    requireGenerationContext(context);
    return { freshContext: context };
  };
  const deriveFresh = (state: typeof PlanGraphState.State) => {
    if (!state.freshContext) throw new Error('Fresh planning context is unavailable');
    return { freshFacts: derivePlanningFacts(state.freshContext) };
  };
  const validateProposal = (state: typeof PlanGraphState.State) => {
    if (!state.result || !state.generationContext || !state.freshContext) throw new Error('Plan validation state is incomplete');
    const changed = planSnapshot(state.generationContext.currentPlan) !== planSnapshot(state.freshContext.currentPlan);
    if (changed && (state.validationRepairCount ?? 0) > 0) throw new ConflictError('Current plan changed during generation');
    const validationErrors = changed ? ['Current plan changed during generation'] : state.result.status === 'NO_VALID_PROPOSAL_FOUND' ? [] : validate(state.result, state.freshContext);
    if (validationErrors.length) {
      console.warn('[AI plan validation rejected]', { planId: state.planId, errors: validationErrors });
    }
    return { validationErrors };
  };
  const evaluateQuality = (state: typeof PlanGraphState.State) => {
    if (!state.result || !state.freshContext || !state.freshFacts) throw new Error('Plan quality state is incomplete');
    if (state.result.status === 'NO_VALID_PROPOSAL_FOUND' || state.validationErrors.length) return {};
    const validationErrors = evaluatePlanQuality(state.result, state.freshContext, state.freshFacts).map((issue) => `PLAN_QUALITY ${issue.code}: ${issue.message}`);
    if (validationErrors.length) console.warn('[AI plan quality rejected]', { planId: state.planId, errors: validationErrors });
    return { validationErrors };
  };
  const afterValidation = (state: typeof PlanGraphState.State) => {
    if (!state.validationErrors.length) return END;
    if ((state.validationRepairCount ?? 0) < 2) return 'prepare_validation_repair';
    throw new RequestError('AI generated an infeasible plan', 502);
  };
  const prepareRepair = (state: typeof PlanGraphState.State) => ({
    generationContext: state.freshContext,
    generationFacts: state.freshFacts,
    result: null,
    parserError: null,
    parserRepairCount: 0,
    validationRepairCount: (state.validationRepairCount ?? 0) + 1,
  });

  return new StateGraph(PlanGraphState, { input: PlanGraphInputSchema, output: PlanGraphOutputSchema })
    .addNode('load_context', load)
    .addNode('derive_planning_facts', derive)
    .addNode('generate', generate)
    .addNode('parse', parse)
    .addNode('refresh_context', refresh)
    .addNode('derive_fresh_planning_facts', deriveFresh)
    .addNode('validate_hard_constraints', validateProposal)
    .addNode('evaluate_plan_quality', evaluateQuality)
    .addNode('prepare_validation_repair', prepareRepair)
    .addEdge(START, 'load_context')
    .addEdge('load_context', 'derive_planning_facts')
    .addEdge('derive_planning_facts', 'generate')
    .addEdge('generate', 'parse')
    .addConditionalEdges('parse', afterParse, ['generate', 'refresh_context'])
    .addEdge('refresh_context', 'derive_fresh_planning_facts')
    .addEdge('derive_fresh_planning_facts', 'validate_hard_constraints')
    .addEdge('validate_hard_constraints', 'evaluate_plan_quality')
    .addConditionalEdges('evaluate_plan_quality', afterValidation, ['prepare_validation_repair', END])
    .addEdge('prepare_validation_repair', 'generate')
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
