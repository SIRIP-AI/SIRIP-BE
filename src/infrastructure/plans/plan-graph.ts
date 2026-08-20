import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

import type { PlanRepositoryPort, PlanValidator, PlanWorkflow, PlanWorkflowInput } from '../../application/plans/plan-service';
import { ConflictError, RequestError } from '../../domain/errors';
import { InvalidPlanProposalError, orderPlanProposal, parseAiPlanProposal, planSnapshot, type AiPlanProposal, type PlanningContext } from '../../domain/plans/plans';
import { createPlanningModel, messageText, planningMessages, planningProviderError, type PlanningModel } from './plan-generator';

const PlanGraphState = Annotation.Root({
  userId: Annotation<string>(),
  batchIds: Annotation<string[]>(),
  planId: Annotation<string | null>(),
  instruction: Annotation<string | null>(),
  generationContext: Annotation<PlanningContext | null>(),
  freshContext: Annotation<PlanningContext | null>(),
  rawOutput: Annotation<string | null>(),
  proposal: Annotation<AiPlanProposal | null>(),
  parserError: Annotation<string | null>(),
  parserRepairCount: Annotation<number>(),
  validationErrors: Annotation<string[]>(),
  validationRepairCount: Annotation<number>(),
});

const positiveId = z.string().regex(/^[1-9]\d*$/);
const PlanGraphInputSchema = z.object({
  userId: positiveId,
  batchIds: z.array(positiveId).min(1).max(100),
  planId: positiveId.nullable(),
  instruction: z.string().trim().min(1).max(2000).nullable(),
});
const PlanGraphOutputSchema = z.object({ proposal: z.any(), freshContext: z.any() });

export type PlanGraphInput = Pick<typeof PlanGraphState.State, 'userId' | 'batchIds' | 'planId' | 'instruction'>;
export type PlanGraphDependencies = {
  repository: Pick<PlanRepositoryPort, 'loadContext'>;
  validate: PlanValidator;
  model?: () => PlanningModel;
};

function requireGenerationContext(context: PlanningContext) {
  if (!context.batches.length) throw new ConflictError('At least one active batch is required before planning');
  if (context.batches.length > 100) throw new ConflictError('At most 100 active batches can be planned at once');
  if (context.batches.some((batch) => !batch.quality)) throw new ConflictError('Every active batch requires a quality state before planning');
  if (!context.coldStorages.some((resource) => resource.operationalStatus === 'AVAILABLE')) throw new ConflictError('At least one available cold storage is required before planning');
  if (!context.vehicles.some((resource) => resource.operationalStatus === 'AVAILABLE')) throw new ConflictError('At least one available vehicle is required before planning');
  if (!context.destinations.some((resource) => resource.status === 'AVAILABLE')) throw new ConflictError('At least one available destination is required before planning');
}

export function createPlanGraph({ repository, validate, model = createPlanningModel }: PlanGraphDependencies) {
  const load = async (state: typeof PlanGraphState.State) => {
    const context = await repository.loadContext(BigInt(state.userId), state.batchIds.map(BigInt), state.planId ? BigInt(state.planId) : undefined);
    if (context.batches.length !== state.batchIds.length) throw new ConflictError('Every selected batch must be active and owned by the user');
    requireGenerationContext(context);
    return { generationContext: context, freshContext: null, rawOutput: null, proposal: null, parserError: null, parserRepairCount: 0, validationErrors: [], validationRepairCount: 0 };
  };
  const generate = async (state: typeof PlanGraphState.State) => {
    if (!state.generationContext) throw new Error('Planning context is unavailable');
    try {
      const response = await model().invoke(planningMessages(state.generationContext, state.instruction ?? undefined, state.parserError ?? undefined, state.validationErrors));
      return { rawOutput: messageText(response), proposal: null };
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw planningProviderError(error);
    }
  };
  const parse = (state: typeof PlanGraphState.State) => {
    try {
      return { proposal: orderPlanProposal(parseAiPlanProposal(state.rawOutput ?? '')), parserError: null };
    } catch (error) {
      if (!(error instanceof InvalidPlanProposalError)) throw error;
      return { proposal: null, parserError: error.message.slice(0, 300), parserRepairCount: (state.parserRepairCount ?? 0) + 1 };
    }
  };
  const afterParse = (state: typeof PlanGraphState.State) => {
    if (state.proposal) return 'refresh_context';
    if ((state.parserRepairCount ?? 0) <= 1) return 'generate';
    throw new RequestError('AI provider returned an invalid plan', 502);
  };
  const refresh = async (state: typeof PlanGraphState.State) => {
    const context = await repository.loadContext(BigInt(state.userId), state.batchIds.map(BigInt), state.planId ? BigInt(state.planId) : undefined);
    if (context.batches.length !== state.batchIds.length) throw new ConflictError('Selected batch scope changed during generation');
    requireGenerationContext(context);
    return { freshContext: context };
  };
  const validateProposal = (state: typeof PlanGraphState.State) => {
    if (!state.proposal || !state.generationContext || !state.freshContext) throw new Error('Plan validation state is incomplete');
    const changed = planSnapshot(state.generationContext.currentPlan) !== planSnapshot(state.freshContext.currentPlan);
    if (changed && (state.validationRepairCount ?? 0) > 0) throw new ConflictError('Current plan changed during generation');
    return { validationErrors: changed ? ['Current plan changed during generation'] : validate(state.proposal, state.freshContext) };
  };
  const afterValidation = (state: typeof PlanGraphState.State) => {
    if (!state.validationErrors.length) return END;
    if ((state.validationRepairCount ?? 0) === 0) return 'prepare_validation_repair';
    throw new RequestError('AI generated an infeasible plan', 502);
  };
  const prepareRepair = (state: typeof PlanGraphState.State) => ({
    generationContext: state.freshContext,
    rawOutput: null,
    proposal: null,
    parserError: null,
    parserRepairCount: 0,
    validationRepairCount: 1,
  });

  return new StateGraph(PlanGraphState, { input: PlanGraphInputSchema, output: PlanGraphOutputSchema })
    .addNode('load_context', load)
    .addNode('generate', generate)
    .addNode('parse', parse)
    .addNode('refresh_context', refresh)
    .addNode('validate', validateProposal)
    .addNode('prepare_validation_repair', prepareRepair)
    .addEdge(START, 'load_context')
    .addEdge('load_context', 'generate')
    .addEdge('generate', 'parse')
    .addConditionalEdges('parse', afterParse, ['generate', 'refresh_context'])
    .addEdge('refresh_context', 'validate')
    .addConditionalEdges('validate', afterValidation, ['prepare_validation_repair', END])
    .addEdge('prepare_validation_repair', 'generate')
    .compile();
}

export function createPlanWorkflow(graph: ReturnType<typeof createPlanGraph>): PlanWorkflow {
  return async (input: PlanWorkflowInput) => {
    const result = await graph.invoke({
      userId: input.userId.toString(),
      batchIds: input.batchIds.map(String),
      planId: input.planId?.toString() ?? null,
      instruction: input.instruction ?? null,
    });
    if (!result.proposal || !result.freshContext) throw new Error('Plan graph completed without a validated proposal');
    return { proposal: result.proposal, context: result.freshContext };
  };
}
