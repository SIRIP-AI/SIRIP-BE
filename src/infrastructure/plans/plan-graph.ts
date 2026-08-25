import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

import type { PlanRepositoryPort, PlanValidator, PlanWorkflow, PlanWorkflowInput } from '../../application/plans/plan-service';
import { ConflictError } from '../../domain/errors';
import { generateMultiDestinationCandidates, type PlanCandidate } from '../../domain/plans/plan-candidates';
import { derivePlanningFacts, planSnapshot, type AiPlanResult, type PlanningContext, type PlanningFacts } from '../../domain/plans/plans';
import { applyPlanExplanation, createPlanExplanationModel, createPlanningModel, deterministicSelectionSummary, messageText, parsePlanSelection, planExplanationMessages, planningMessages, type PlanningModel } from './plan-generator';

const PlanGraphState = Annotation.Root({
  userId: Annotation<string>(),
  batchIds: Annotation<string[]>(),
  destinationId: Annotation<string | null>(),
  destinationIds: Annotation<string[]>(),
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
  destinationIds: z.array(positiveId).max(20).default([]),
  deadline: z.string().datetime({ offset: true }).nullable(),
  planId: positiveId.nullable(),
  instruction: z.string().trim().min(1).max(2000).nullable(),
});
const PlanGraphOutputSchema = z.object({ result: z.any(), freshContext: z.any() });

export type PlanGraphInput = Pick<typeof PlanGraphState.State, 'userId' | 'batchIds' | 'destinationId' | 'destinationIds' | 'deadline' | 'planId' | 'instruction'>;
export type PlanGraphDependencies = {
  repository: Pick<PlanRepositoryPort, 'loadContext'>;
  validate: PlanValidator;
  model?: () => PlanningModel;
  explanationModel?: () => PlanningModel;
};

function requireGenerationContext(context: PlanningContext) {
  if (!context.batches.length) throw new ConflictError('Setidaknya satu batch aktif diperlukan sebelum perencanaan');
  if (context.batches.length > 100) throw new ConflictError('Maksimal 100 batch aktif dapat direncanakan sekaligus');
  if (context.batches.some((batch) => !batch.quality)) throw new ConflictError('Setiap batch aktif memerlukan status mutu sebelum perencanaan');
  if (!context.vehicles.some((resource) => resource.operationalStatus === 'AVAILABLE')) throw new ConflictError('Setidaknya satu kendaraan tersedia diperlukan sebelum perencanaan');
  if (!context.destinations.some((resource) => resource.status === 'AVAILABLE')) throw new ConflictError('Setidaknya satu tujuan tersedia diperlukan sebelum perencanaan');
  if (context.selectedDestinationId && !context.destinations.some((resource) => resource.id === context.selectedDestinationId && resource.status === 'AVAILABLE')) throw new ConflictError('Tujuan yang dipilih harus tersedia dan dimiliki pengguna');
  if (context.acceptableDestinationIds?.some((destinationId) => !context.destinations.some((resource) => resource.id === destinationId && resource.status === 'AVAILABLE'))) throw new ConflictError('Setiap tujuan yang dapat diterima harus tersedia dan dimiliki pengguna');
}

function noCandidateResult(): AiPlanResult {
  return { status: 'NO_VALID_PROPOSAL_FOUND', reason: 'Tidak ditemukan rencana yang layak secara fisik dalam horizon perencanaan tujuh hari. Periksa ketersediaan sumber daya, kapasitas, dan jendela operasional.' };
}

export function createPlanGraph(dependencies: PlanGraphDependencies) {
  const { repository, validate, model = createPlanningModel } = dependencies;
  const explanationModel = dependencies.explanationModel ?? (dependencies.model ? null : createPlanExplanationModel);
  const destinationScope = (state: typeof PlanGraphState.State) => state.destinationIds.length ? state.destinationIds : state.destinationId ? [state.destinationId] : [];
  const loadContext = async (state: typeof PlanGraphState.State) => {
    const loaded = await repository.loadContext(BigInt(state.userId), state.batchIds.map(BigInt), state.planId ? BigInt(state.planId) : undefined);
    const destinationIds = destinationScope(state); const context = { ...loaded, selectedDestinationId: destinationIds.length === 1 ? destinationIds[0]! : null, acceptableDestinationIds: destinationIds, deadline: state.deadline };
    if (context.batches.length !== state.batchIds.length) throw new ConflictError('Setiap batch yang dipilih harus aktif dan dimiliki pengguna');
    requireGenerationContext(context);
    return { generationContext: context, generationFacts: null, candidates: [], freshContext: null, freshFacts: null, result: null };
  };
  const deriveFacts = (state: typeof PlanGraphState.State) => {
    if (!state.generationContext) throw new Error('Planning context is unavailable');
    return { generationFacts: derivePlanningFacts(state.generationContext) };
  };
  const generateCandidates = (state: typeof PlanGraphState.State) => {
    if (!state.generationContext || !state.generationFacts) throw new Error('Planning context is unavailable');
    return { candidates: generateMultiDestinationCandidates(state.generationContext, state.generationContext.acceptableDestinationIds ?? []) };
  };
  const selectCandidate = async (state: typeof PlanGraphState.State) => {
    if (!state.generationContext || !state.generationFacts) throw new Error('Planning context is unavailable');
    if (!state.candidates.length) return { result: noCandidateResult() };
    if (state.candidates.length === 1) {
      const proposal = state.candidates[0]!.proposal;
      return { result: { status: 'PROPOSAL' as const, ...proposal, summary: deterministicSelectionSummary(proposal, state.generationContext, state.instruction ?? undefined) } };
    }
    try {
      const response = await model().invoke(planningMessages(state.generationContext, state.generationFacts, state.candidates, state.instruction ?? undefined));
      const proposal = parsePlanSelection(messageText(response), state.candidates);
      return { result: { status: 'PROPOSAL' as const, ...proposal, summary: deterministicSelectionSummary(proposal, state.generationContext, state.instruction ?? undefined) } };
    } catch {
      console.warn('[AI plan selection failed; using deterministic candidate]', { planId: state.planId });
      const proposal = state.candidates[0]!.proposal;
      return { result: { status: 'PROPOSAL' as const, ...proposal, summary: deterministicSelectionSummary(proposal, state.generationContext, state.instruction ?? undefined) } };
    }
  };
  const refreshContext = async (state: typeof PlanGraphState.State) => {
    const loaded = await repository.loadContext(BigInt(state.userId), state.batchIds.map(BigInt), state.planId ? BigInt(state.planId) : undefined);
    const destinationIds = destinationScope(state); const context = { ...loaded, selectedDestinationId: destinationIds.length === 1 ? destinationIds[0]! : null, acceptableDestinationIds: destinationIds, deadline: state.deadline };
    if (context.batches.length !== state.batchIds.length) throw new ConflictError('Cakupan batch yang dipilih berubah selama pembuatan');
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
    const freshCandidates = generateMultiDestinationCandidates(state.freshContext, state.freshContext.acceptableDestinationIds ?? []);
    console.warn('[Selected plan became invalid; using fresh deterministic candidate]', { planId: state.planId, errors, candidates: freshCandidates.length });
    if (!freshCandidates.length) return { result: noCandidateResult() };
    const proposal = freshCandidates[0]!.proposal;
    return { result: { status: 'PROPOSAL' as const, ...proposal, summary: deterministicSelectionSummary(proposal, state.freshContext, state.instruction ?? undefined) } };
  };
  const explainPlan = async (state: typeof PlanGraphState.State) => {
    if (!state.result || state.result.status === 'NO_VALID_PROPOSAL_FOUND') return {};
    if (!state.freshContext || !state.freshFacts) throw new Error('Fresh planning context is unavailable');
    if (!explanationModel) return {};
    try {
      const response = await explanationModel().invoke(planExplanationMessages(state.freshContext, state.freshFacts, state.result, state.instruction ?? undefined));
      return { result: { status: 'PROPOSAL' as const, ...applyPlanExplanation(messageText(response), state.result) } };
    } catch {
      console.warn('[AI plan explanation failed; using deterministic explanation]', { planId: state.planId });
      return {};
    }
  };

  return new StateGraph(PlanGraphState, { input: PlanGraphInputSchema, output: PlanGraphOutputSchema })
    .addNode('load_context', loadContext)
    .addNode('derive_planning_facts', deriveFacts)
    .addNode('generate_candidates', generateCandidates)
    .addNode('select_candidate', selectCandidate)
    .addNode('refresh_context', refreshContext)
    .addNode('derive_fresh_planning_facts', deriveFreshFacts)
    .addNode('validate_or_fallback', validateOrFallback)
    .addNode('explain_plan', explainPlan)
    .addEdge(START, 'load_context')
    .addEdge('load_context', 'derive_planning_facts')
    .addEdge('derive_planning_facts', 'generate_candidates')
    .addEdge('generate_candidates', 'select_candidate')
    .addEdge('select_candidate', 'refresh_context')
    .addEdge('refresh_context', 'derive_fresh_planning_facts')
    .addEdge('derive_fresh_planning_facts', 'validate_or_fallback')
    .addEdge('validate_or_fallback', 'explain_plan')
    .addEdge('explain_plan', END)
    .compile();
}

export function createPlanWorkflow(graph: ReturnType<typeof createPlanGraph>): PlanWorkflow {
  return async (input: PlanWorkflowInput) => {
    const result = await graph.invoke({
      userId: input.userId.toString(),
      batchIds: input.batchIds.map(String),
      destinationId: null,
      destinationIds: input.destinationIds.map(String),
      deadline: input.deadline,
      planId: input.planId?.toString() ?? null,
      instruction: input.instruction ?? null,
    });
    if (!result.result || !result.freshContext) throw new Error('Plan graph completed without a validated result');
    return { result: result.result, context: result.freshContext };
  };
}
