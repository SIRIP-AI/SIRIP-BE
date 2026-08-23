import { evaluatePlanQuality, orderPlanProposal, validatePlanProposal, type AiPlanProposal, type AiPlanStep, type PlanningContext, type PlanningFacts } from './plans';

export type PlanCandidate = { id: string; proposal: AiPlanProposal };

const stepMinutes = 15;
const maximumChoicesPerBatch = 36;
const maximumTimesPerVehicle = 12;
const maximumPartialPlans = 24;
const maximumCandidates = 3;

function completedState(context: PlanningContext, batchId: string) {
  let vehicleId: string | undefined;
  let dispatched = false;
  for (const step of context.currentPlan?.steps.filter((candidate) => candidate.status === 'COMPLETED' && candidate.batchId === batchId) ?? []) {
    if (step.actionType === 'LOAD' && step.vehicleId) {
      vehicleId = step.vehicleId;
    }
    if (step.actionType === 'DISPATCH') dispatched = true;
  }
  return { vehicleId, dispatched };
}

function scheduleChoices(context: PlanningContext, facts: PlanningFacts, batchId: string): AiPlanStep[][] {
  const batch = context.batches.find((candidate) => candidate.id === batchId);
  const batchFacts = facts.batches.find((candidate) => candidate.batchId === batchId);
  const destination = facts.selectedDestination;
  if (!batch || !batchFacts || !destination) return [];

  const state = completedState(context, batchId);
  if (state.dispatched) return [[]];
  const vehicleIds = state.vehicleId ? [state.vehicleId] : batchFacts.feasibleVehicleIds;
  const now = Date.parse(context.now);
  const latestArrival = Date.parse(batchFacts.effectiveArrivalDeadlineAt);
  const choices: AiPlanStep[][] = [];

  for (const vehicleId of vehicleIds) {
    const vehicle = context.vehicles.find((candidate) => candidate.id === vehicleId);
    if (!vehicle || vehicle.operationalStatus !== 'AVAILABLE' || vehicle.capacityKg < batch.weightKg) continue;
    const availability = vehicle.availabilityIntervals ?? [{ start: context.now, end: batchFacts.effectiveArrivalDeadlineAt }];
    let vehicleChoices = 0;
    for (const dispatchWindow of destination.dispatchIntervals) {
      for (const vehicleWindow of availability) {
        const earliestLoad = Math.max(now + 60_000, Date.parse(dispatchWindow.start) - stepMinutes * 60_000, Date.parse(vehicleWindow.start), now + vehicle.delayMinutes * 60_000);
        const earliestDispatch = Math.max(earliestLoad + (state.vehicleId ? 0 : stepMinutes * 60_000), Date.parse(dispatchWindow.start), Date.parse(vehicleWindow.start));
        const latestDispatch = Math.min(Date.parse(dispatchWindow.end), Date.parse(vehicleWindow.end), latestArrival - destination.travelMinutes * 60_000);
        const firstDispatch = Math.ceil(earliestDispatch / (stepMinutes * 60_000)) * stepMinutes * 60_000;
        for (let dispatchAt = firstDispatch; dispatchAt <= latestDispatch && choices.length < maximumChoicesPerBatch && vehicleChoices < maximumTimesPerVehicle; dispatchAt += stepMinutes * 60_000) {
          const dispatch: AiPlanStep = {
            actionType: 'DISPATCH',
            batchId,
            vehicleId,
            destinationId: destination.destinationId,
            scheduledAt: new Date(dispatchAt).toISOString(),
            rationale: `Dispatch ${batch.code} within its receiving and quality windows.`,
          };
          if (state.vehicleId) choices.push([dispatch]);
          else choices.push([{
            actionType: 'LOAD',
            batchId,
            vehicleId,
            scheduledAt: new Date(dispatchAt - stepMinutes * 60_000).toISOString(),
            rationale: `Load ${batch.code} for direct dispatch.`,
          }, dispatch]);
          vehicleChoices += 1;
        }
      }
    }
  }
  return choices;
}

function partialContext(context: PlanningContext, batchIds: Set<string>): PlanningContext {
  return { ...context, batches: context.batches.filter((batch) => batchIds.has(batch.id)) };
}

function proposal(steps: AiPlanStep[]): AiPlanProposal {
  return orderPlanProposal({ summary: 'Deterministic feasible logistics plan', steps });
}

function proposalKey(value: AiPlanProposal) {
  return JSON.stringify(value.steps.map((step) => [step.actionType, step.batchId, step.scheduledAt, step.coldStorageId ?? null, step.vehicleId ?? null, step.destinationId ?? null]));
}

export function generatePlanCandidates(context: PlanningContext, facts: PlanningFacts): PlanCandidate[] {
  const orderedBatches = [...facts.batches].sort((left, right) => left.urgencyRank - right.urgencyRank || left.feasibleVehicleIds.length - right.feasibleVehicleIds.length || left.batchId.localeCompare(right.batchId));
  let partials: AiPlanStep[][] = [[]];
  const included = new Set<string>();

  for (const batch of orderedBatches) {
    included.add(batch.batchId);
    const choices = scheduleChoices(context, facts, batch.batchId);
    if (!choices.length) return [];
    const next: AiPlanStep[][] = [];
    const seen = new Set<string>();
    for (const partial of partials) {
      for (const choice of choices) {
        const candidate = proposal([...partial, ...choice]);
        if (validatePlanProposal(candidate, partialContext(context, included)).length) continue;
        const key = proposalKey(candidate);
        if (!seen.has(key)) {
          seen.add(key);
          next.push(candidate.steps);
        }
      }
    }
    partials = next.slice(0, maximumPartialPlans);
    if (!partials.length) return [];
  }

  return partials
    .map(proposal)
    .filter((candidate) => validatePlanProposal(candidate, context).length === 0 && evaluatePlanQuality(candidate, context, facts).length === 0)
    .slice(0, maximumCandidates)
    .map((candidate, index) => ({ id: `candidate-${index + 1}`, proposal: candidate }));
}
