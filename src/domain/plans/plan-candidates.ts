import { addReturnToBaseSteps, assessPlanTiming, derivePlanningFacts, evaluatePlanQuality, orderPlanProposal, validatePlanProposal, type AiPlanProposal, type AiPlanStep, type PlanningContext, type PlanningFacts } from './plans';

export type PlanCandidate = { id: string; proposal: AiPlanProposal };

const stepMinutes = 15;
const maximumChoicesPerBatch = 36;
const maximumTimesPerVehicle = 12;
const maximumPartialPlans = 24;
const maximumCandidates = 3;

function completedState(context: PlanningContext, batchId: string) {
  const batch = context.batches.find(({ id }) => id === batchId);
  let vehicleId = batch?.location?.type === 'VEHICLE' ? batch.location.resourceId : undefined;
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
  const choices: AiPlanStep[][] = [];

  for (const vehicleId of vehicleIds) {
    const vehicle = context.vehicles.find((candidate) => candidate.id === vehicleId);
    if (!vehicle || vehicle.operationalStatus !== 'AVAILABLE' || vehicle.capacityKg < batch.weightKg) continue;
    const availability = vehicle.availabilityIntervals ?? [{ start: context.now, end: destination.dispatchIntervals.at(-1)?.end ?? batchFacts.effectiveArrivalDeadlineAt }];
    let vehicleChoices = 0;
    for (const dispatchWindow of destination.dispatchIntervals) {
      for (const vehicleWindow of availability) {
        const earliestLoad = Math.max(now + 60_000, Date.parse(dispatchWindow.start) - stepMinutes * 60_000, Date.parse(vehicleWindow.start), now + vehicle.delayMinutes * 60_000);
        const earliestDispatch = Math.max(earliestLoad + (state.vehicleId ? 0 : stepMinutes * 60_000), Date.parse(dispatchWindow.start), Date.parse(vehicleWindow.start));
        const destinationLimit = Date.parse(dispatchWindow.end);
        const vehicleReturnLimit = Date.parse(vehicleWindow.end) - destination.travelMinutes * 2 * 60_000;
        const latestDispatch = Math.min(destinationLimit, vehicleReturnLimit);
        const bindingConstraints = [
          ...(latestDispatch === destinationLimit ? ['jendela penerimaan tujuan'] : []),
          ...(latestDispatch === vehicleReturnLimit ? [`ketersediaan dan perjalanan pulang ${vehicle.code}`] : []),
        ];
        const firstDispatch = Math.ceil(earliestDispatch / (stepMinutes * 60_000)) * stepMinutes * 60_000;
        for (let dispatchAt = firstDispatch; dispatchAt <= latestDispatch && choices.length < maximumChoicesPerBatch && vehicleChoices < maximumTimesPerVehicle; dispatchAt += stepMinutes * 60_000) {
          const dispatch: AiPlanStep = {
            actionType: 'DISPATCH',
            batchId,
            vehicleId,
            destinationId: destination.destinationId,
            scheduledAt: new Date(dispatchAt).toISOString(),
            rationale: `Kirim langsung ${batch.code} dengan ${vehicle.code} untuk menghindari penyimpanan dan penanganan yang tidak perlu.`,
            timingRationale: `Keberangkatan ini mencapai ${context.destinations.find(({ id }) => id === destination.destinationId)?.name ?? 'tujuan'} dalam jendela penerimaannya. Batas keberangkatan aman terakhir ditentukan oleh ${bindingConstraints.join(', ')}.`,
            latestSafeAt: new Date(latestDispatch).toISOString(),
          };
          if (state.vehicleId) choices.push([dispatch]);
          else {
            const load: AiPlanStep = {
              actionType: 'LOAD',
            batchId,
              vehicleId,
              scheduledAt: new Date(dispatchAt - stepMinutes * 60_000).toISOString(),
              rationale: `Muat ${batch.code} ke ${vehicle.code}, yang memiliki kapasitas memadai dan mendukung pengiriman langsung.`,
              timingRationale: `Pemuatan dimulai ${stepMinutes} menit sebelum keberangkatan yang dipilih agar batch siap tanpa waktu tunggu yang dapat dihindari.`,
              latestSafeAt: new Date(latestDispatch - stepMinutes * 60_000).toISOString(),
            };
            const shouldStore = (batch.location?.type ?? 'INTAKE') === 'INTAKE' && dispatchAt - now > 30 * 60_000;
            if (shouldStore && batchFacts.feasibleColdStorageIds.length) for (const storageId of batchFacts.feasibleColdStorageIds) choices.push([{ actionType: 'STORE', batchId, coldStorageId: storageId, scheduledAt: new Date(now + 60_000).toISOString(), rationale: `Lindungi ${batch.code} di penyimpanan dingin selama menunggu pengiriman.`, timingRationale: 'Pengiriman masih lebih dari 30 menit, sehingga penyimpanan membatasi paparan yang dapat dihindari di area penerimaan.', latestSafeAt: load.scheduledAt }, load, dispatch]);
            else choices.push([load, dispatch]);
          }
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

function proposal(context: PlanningContext, steps: AiPlanStep[]): AiPlanProposal {
  const planned = addReturnToBaseSteps(orderPlanProposal({ summary: 'Rencana logistik deterministik yang layak secara fisik', steps }), context);
  return { ...planned, timing: assessPlanTiming(planned, context) };
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
        const candidate = proposal(context, [...partial, ...choice]);
        if (validatePlanProposal(candidate, partialContext(context, included), { allowTargetLateness: true }).length) continue;
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
    .map((steps) => proposal(context, steps))
    .filter((candidate) => validatePlanProposal(candidate, context, { allowTargetLateness: true }).length === 0)
    .sort((left, right) => (left.timing?.delayedBySeconds ?? 0) - (right.timing?.delayedBySeconds ?? 0) || evaluatePlanQuality(left, context, facts).length - evaluatePlanQuality(right, context, facts).length)
    .slice(0, maximumCandidates)
    .map((candidate, index) => ({ id: `candidate-${index + 1}`, proposal: candidate }));
}

export function generateMultiDestinationCandidates(context: PlanningContext, destinationIds: string[]): PlanCandidate[] {
  if (destinationIds.length === 1) {
    const scoped = { ...context, selectedDestinationId: destinationIds[0]!, acceptableDestinationIds: destinationIds };
    return generatePlanCandidates(scoped, derivePlanningFacts(scoped));
  }
  let assignments: string[][] = [[]];
  for (const _batch of context.batches) {
    const next = assignments.flatMap((assignment) => destinationIds.map((destinationId) => [...assignment, destinationId]));
    assignments = next.slice(0, 64);
  }
  const diverseAssignments = [
    ...destinationIds.map((destinationId) => context.batches.map(() => destinationId)),
    ...destinationIds.map((_, offset) => context.batches.map((__, index) => destinationIds[(index + offset) % destinationIds.length]!)),
    ...assignments,
  ];
  assignments = [...new Map(diverseAssignments.map((assignment) => [assignment.join(':'), assignment])).values()].slice(0, 64);
  const candidates: AiPlanProposal[] = [];
  for (const assignment of assignments) {
    let partials: AiPlanStep[][] = [[]];
    let feasible = true;
    for (const destinationId of new Set(assignment)) {
      const batchIds = new Set(context.batches.filter((_, index) => assignment[index] === destinationId).map(({ id }) => id));
      const scoped = { ...context, batches: context.batches.filter(({ id }) => batchIds.has(id)), selectedDestinationId: destinationId, acceptableDestinationIds: destinationIds };
      const groupCandidates = generatePlanCandidates(scoped, derivePlanningFacts(scoped));
      if (!groupCandidates.length) { feasible = false; break; }
      partials = partials.flatMap((partial) => groupCandidates.map((candidate) => [...partial, ...candidate.proposal.steps])).slice(0, maximumPartialPlans);
    }
    if (!feasible) continue;
    for (const steps of partials) {
      const scopedContext = { ...context, selectedDestinationId: null, acceptableDestinationIds: destinationIds };
      const planned = addReturnToBaseSteps(orderPlanProposal({ summary: 'Rencana logistik deterministik untuk beberapa tujuan', steps }), scopedContext);
      const proposal = { ...planned, timing: assessPlanTiming(planned, scopedContext) };
      if (validatePlanProposal(proposal, scopedContext, { allowTargetLateness: true }).length === 0) candidates.push(proposal);
    }
  }
  const unique = [...new Map(candidates.map((proposal) => [proposalKey(proposal), proposal])).values()].sort((left, right) => (left.timing?.delayedBySeconds ?? 0) - (right.timing?.delayedBySeconds ?? 0)).slice(0, maximumCandidates);
  return unique.map((proposal, index) => ({ id: `candidate-${index + 1}`, proposal }));
}
