export const planActionTypes = ['STORE', 'LOAD', 'DISPATCH', 'HANDOVER', 'INSPECT', 'OTHER'] as const;
export const generatedPlanActionTypes = ['STORE', 'LOAD', 'DISPATCH', 'INSPECT'] as const;
export const activeBatchStatuses = ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] as const;

export type PlanActionType = typeof planActionTypes[number];
export type GeneratedPlanActionType = typeof generatedPlanActionTypes[number];
export type ActiveBatchStatus = typeof activeBatchStatuses[number];
export type PlanStatus = 'PROPOSED' | 'ACTIVE' | 'COMPLETED' | 'SUPERSEDED' | 'DISMISSED';
export type PlanStepStatus = 'UPCOMING' | 'COMPLETED' | 'CANCELED';

export type AiPlanStep = {
  actionType: GeneratedPlanActionType;
  batchId: string;
  scheduledAt: string;
  coldStorageId?: string;
  vehicleId?: string;
  destinationId?: string;
  rationale: string;
};

export type AiPlanProposal = {
  summary: string;
  steps: AiPlanStep[];
};

export type AiPlanResult =
  | ({ status: 'PROPOSAL' } & AiPlanProposal)
  | { status: 'NO_VALID_PROPOSAL_FOUND'; reason: string };

export type PlanningBatch = {
  id: string;
  code: string;
  weightKg: number;
  grade: string;
  status: ActiveBatchStatus;
  quality: {
    equivalentQualityAgeDays: number;
    remainingQualityWindowDays: number;
    qualityEstimateStartedAt: string;
    currentTemperatureC: number;
  } | null;
  telemetry: Array<{
    temperatureC: number;
    measuredAt: string;
    receivedAt: string;
  }>;
};

export type PlanningColdStorage = {
  id: string;
  name: string;
  capacityKg: number;
  availableCapacityKg: number;
  operationalStatus: 'AVAILABLE' | 'UNAVAILABLE';
};

export type PlanningVehicle = {
  id: string;
  code: string;
  capacityKg: number;
  operationalStatus: 'AVAILABLE' | 'UNAVAILABLE';
  delayMinutes: number;
  delayPersistent: boolean;
  restriction: string | null;
  availabilityIntervals: Array<{ start: string; end: string }> | null;
};

export type PlanningDestination = {
  id: string;
  name: string;
  address: string;
  travelMinutes: number;
  receivingIntervals: Array<{ start: string; end: string }>;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  notes: string | null;
};

export type PlanningPlanStep = {
  sequence: number;
  actionType: PlanActionType;
  batchId: string;
  coldStorageId: string | null;
  vehicleId: string | null;
  destinationId: string | null;
  scheduledAt: string;
  status: PlanStepStatus;
  completedAt: string | null;
  rationale: string | null;
};

export type PlanningActivePlan = {
  id: string;
  version: number;
  summary: string;
  destinationId: string | null;
  deadline: string | null;
  steps: PlanningPlanStep[];
};

export type PlanningResourceOccupancy = {
  resourceType: 'COLD_STORAGE' | 'VEHICLE';
  resourceId: string;
  batchId: string;
  weightKg: number;
  start: string;
  end: string | null;
};

export type PlanningContext = {
  now: string;
  selectedDestinationId: string | null;
  deadline: string | null;
  batches: PlanningBatch[];
  coldStorages: PlanningColdStorage[];
  vehicles: PlanningVehicle[];
  destinations: PlanningDestination[];
  currentPlan: PlanningActivePlan | null;
  resourceOccupancies?: PlanningResourceOccupancy[];
};

export function planSnapshot(plan: PlanningActivePlan | null) {
  return JSON.stringify(plan ? [
    plan.id,
    plan.version,
    plan.summary,
    plan.destinationId,
    plan.deadline,
    plan.steps.map((step) => [
      step.sequence,
      step.actionType,
      step.batchId,
      step.coldStorageId,
      step.vehicleId,
      step.destinationId,
      step.scheduledAt,
      step.status,
      step.completedAt,
      step.rationale,
    ]),
  ] : null);
}

export type PlanResource = {
  type: 'COLD_STORAGE' | 'VEHICLE' | 'DESTINATION';
  id: string;
  name: string;
};

export type PlanView = {
  id: string;
  version: number;
  status: PlanStatus;
  previousPlanId: string | null;
  summary: string;
  destinationId: string | null;
  deadline: string | null;
  createdAt: string;
  approvedAt: string | null;
  completedAt: string | null;
  batches: Array<{ id: string; code: string }>;
  trigger: {
    id: string;
    type: string;
    source: string;
    message: string;
    occurredAt: string;
  } | null;
  steps: Array<{
    id: string;
    sequence: number;
    actionType: PlanActionType;
    scheduledAt: string;
    status: PlanStepStatus;
    completedAt: string | null;
    rationale: string | null;
    batch: { id: string; code: string };
    resources: PlanResource[];
  }>;
};

export type PlanList = {
  updatedAt: string;
  activePlans: PlanView[];
  proposedPlans: PlanView[];
  history: PlanView[];
};

export class InvalidPlanProposalError extends Error {}

const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const positiveId = /^[1-9]\d*$/;
const stepFields = new Set(['actionType', 'batchId', 'scheduledAt', 'coldStorageId', 'vehicleId', 'destinationId', 'rationale']);

function invalid(message: string): never {
  throw new InvalidPlanProposalError(message);
}

function object(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`${label}.${unknown} is not allowed`);
}

function id(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length > 100 || !positiveId.test(value)) invalid(`${label} must be a positive string ID`);
  return value;
}

function optionalId(value: unknown, label: string) {
  if (value === undefined || value === null) return undefined;
  return id(value, label);
}

function parseStep(value: unknown, index: number): AiPlanStep {
  const step = object(value, `steps[${index}]`);
  exactFields(step, stepFields, `steps[${index}]`);
  if (typeof step.actionType !== 'string' || !generatedPlanActionTypes.includes(step.actionType as GeneratedPlanActionType)) invalid(`steps[${index}].actionType is invalid`);
  if (typeof step.scheduledAt !== 'string' || !isoDateTime.test(step.scheduledAt) || !Number.isFinite(Date.parse(step.scheduledAt))) invalid(`steps[${index}].scheduledAt must be an ISO datetime`);
  const rationale = typeof step.rationale === 'string' ? step.rationale.trim() : invalid(`steps[${index}].rationale must be text`);
  if (!rationale || rationale.length > 500) invalid(`steps[${index}].rationale must contain 1 to 500 characters`);
  const coldStorageId = optionalId(step.coldStorageId, `steps[${index}].coldStorageId`);
  const vehicleId = optionalId(step.vehicleId, `steps[${index}].vehicleId`);
  const destinationId = optionalId(step.destinationId, `steps[${index}].destinationId`);
  return {
    actionType: step.actionType as GeneratedPlanActionType,
    batchId: id(step.batchId, `steps[${index}].batchId`),
    scheduledAt: new Date(step.scheduledAt).toISOString(),
    ...(coldStorageId ? { coldStorageId } : {}),
    ...(vehicleId ? { vehicleId } : {}),
    ...(destinationId ? { destinationId } : {}),
    rationale,
  };
}

export function parseAiPlanResult(content: string): AiPlanResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    invalid('AI proposal must be valid JSON');
  }
  const proposal = object(parsed, 'proposal');
  if (proposal.status !== 'PROPOSAL' && proposal.status !== 'NO_VALID_PROPOSAL_FOUND') invalid('proposal.status must be PROPOSAL or NO_VALID_PROPOSAL_FOUND');
  if (proposal.status === 'NO_VALID_PROPOSAL_FOUND') {
    const reason = typeof proposal.reason === 'string' ? proposal.reason.trim() : '';
    if (!reason || reason.length > 1000) invalid('proposal.reason must contain 1 to 1000 characters');
    exactFields(proposal, new Set(['status', 'reason']), 'proposal');
    return { status: 'NO_VALID_PROPOSAL_FOUND', reason };
  }
  const summary = typeof proposal.summary === 'string' ? proposal.summary.trim() : '';
  if (!summary || summary.length > 1000) invalid('proposal.summary must contain 1 to 1000 characters');
  exactFields(proposal, new Set(['status', 'summary', 'steps']), 'proposal');
  if (!Array.isArray(proposal.steps) || proposal.steps.length < 1 || proposal.steps.length > 100) invalid('proposal.steps must contain 1 to 100 steps');
  return { status: 'PROPOSAL', summary, steps: proposal.steps.map(parseStep) };
}

function inIntervals(value: Date, intervals: Array<{ start: string; end: string }> | null) {
  if (intervals === null) return true;
  return intervals.some(({ start, end }) => value >= new Date(start) && value <= new Date(end));
}

function resourceCombination(step: AiPlanStep) {
  const present = [step.coldStorageId !== undefined, step.vehicleId !== undefined, step.destinationId !== undefined];
  if (step.actionType === 'STORE') return present[0] && !present[1] && !present[2];
  if (step.actionType === 'LOAD') return !present[0] && present[1] && !present[2];
  if (step.actionType === 'DISPATCH') return !present[0] && present[1] && present[2];
  return !present[0] && !present[1] && !present[2];
}

export function orderPlanProposal(proposal: AiPlanProposal): AiPlanProposal {
  return { ...proposal, steps: [...proposal.steps].sort((left, right) => {
    const leftTime = Date.parse(left.scheduledAt);
    const rightTime = Date.parse(right.scheduledAt);
    return (Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY) - (Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY);
  }) };
}

export function validatePlanProposal(proposal: AiPlanProposal, context: PlanningContext) {
  const errors: string[] = [];
  const now = new Date(context.now);
  const batches = new Map(context.batches.map((batch) => [batch.id, batch]));
  const coldStorages = new Map(context.coldStorages.map((resource) => [resource.id, resource]));
  const vehicles = new Map(context.vehicles.map((resource) => [resource.id, resource]));
  const destinations = new Map(context.destinations.map((resource) => [resource.id, resource]));
  const covered = new Set<string>();
  const occupancies = (context.resourceOccupancies ?? []).map((occupancy) => ({ ...occupancy }));
  const selectedDestination = context.selectedDestinationId ? destinations.get(context.selectedDestinationId) : undefined;
  const deadline = context.deadline ? new Date(context.deadline) : null;
  const dispatched = new Set<string>();
  const loadedVehicle = new Map<string, string>();
  const storedAt = new Map<string, { resourceId: string; start: string }>();
  const loadedAt = new Map<string, { resourceId: string; start: string }>();
  let previousTime = Number.NEGATIVE_INFINITY;

  for (const step of context.currentPlan?.steps.filter((candidate) => candidate.status === 'COMPLETED') ?? []) {
    if (step.actionType === 'STORE' && step.coldStorageId) storedAt.set(step.batchId, { resourceId: step.coldStorageId, start: step.scheduledAt });
    if (step.actionType === 'LOAD' && step.vehicleId) {
      storedAt.delete(step.batchId);
      loadedVehicle.set(step.batchId, step.vehicleId);
      loadedAt.set(step.batchId, { resourceId: step.vehicleId, start: step.scheduledAt });
    }
    if (step.actionType === 'DISPATCH') {
      loadedVehicle.delete(step.batchId);
      loadedAt.delete(step.batchId);
      dispatched.add(step.batchId);
    }
  }

  if (!proposal.summary.trim() || proposal.summary.length > 1000) errors.push('Plan summary is invalid');
  if (proposal.steps.length < 1 || proposal.steps.length > 100) errors.push('Plan must contain 1 to 100 future steps');
  if (Number.isNaN(now.getTime())) errors.push('Planning context time is invalid');
  if (deadline && (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime())) errors.push('Plan deadline must be a valid future datetime');
  if (context.selectedDestinationId && (!selectedDestination || selectedDestination.status !== 'AVAILABLE')) errors.push('Selected destination is unavailable or unconfigured');
  for (const batch of context.batches) if (!batch.quality) errors.push(`Batch ${batch.id} has no quality state`);

  proposal.steps.forEach((step, index) => {
    const scheduledAt = new Date(step.scheduledAt);
    const batch = batches.get(step.batchId);
    const label = `Step ${index + 1} (${step.actionType} ${batch?.code ?? `batch ${step.batchId}`})`;
    if (!positiveId.test(step.batchId) || !batch || !activeBatchStatuses.includes(batch.status)) errors.push(`${label} references an inactive or unconfigured batch`);
    else covered.add(batch.id);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now.getTime()) errors.push(`${label} must be scheduled in the future`);
    if (!Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() < previousTime) errors.push(`${label} is not in chronological order`);
    if (!Number.isNaN(scheduledAt.getTime())) previousTime = scheduledAt.getTime();
    if (!resourceCombination(step)) errors.push(`${label} has an illegal action/resource combination`);
    if (dispatched.has(step.batchId)) errors.push(`${label} schedules work after dispatch`);
    if (step.actionType === 'INSPECT' && batch?.status !== 'INSPECTION_HOLD') errors.push(`${label} invents an inspection requirement`);

    const coldStorage = step.coldStorageId ? coldStorages.get(step.coldStorageId) : undefined;
    if (step.coldStorageId && (!positiveId.test(step.coldStorageId) || !coldStorage)) errors.push(`${label} references an unconfigured cold storage`);
    if (step.actionType === 'STORE' && coldStorage) {
      if (coldStorage.operationalStatus !== 'AVAILABLE' || coldStorage.availableCapacityKg <= 0) errors.push(`${label} uses unavailable cold storage`);
      if (batch && batch.weightKg > coldStorage.availableCapacityKg) errors.push(`${label} weighs ${batch.weightKg} kg but ${coldStorage.name} has ${coldStorage.availableCapacityKg} kg available`);
      if (batch && storedAt.has(batch.id)) errors.push(`${label} stores a batch more than once`);
      else if (batch) storedAt.set(batch.id, { resourceId: coldStorage.id, start: step.scheduledAt });
    }

    const vehicle = step.vehicleId ? vehicles.get(step.vehicleId) : undefined;
    if (step.vehicleId && (!positiveId.test(step.vehicleId) || !vehicle)) errors.push(`${label} references an unconfigured vehicle`);
    if ((step.actionType === 'LOAD' || step.actionType === 'DISPATCH') && vehicle) {
      if (vehicle.operationalStatus !== 'AVAILABLE') errors.push(`${label} uses an unavailable vehicle`);
      if (batch && batch.weightKg > vehicle.capacityKg) errors.push(`${label} weighs ${batch.weightKg} kg but ${vehicle.code} carries ${vehicle.capacityKg} kg`);
      if (!Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() < now.getTime() + vehicle.delayMinutes * 60_000) errors.push(`${label} does not account for vehicle delay`);
      if (!Number.isNaN(scheduledAt.getTime()) && !inIntervals(scheduledAt, vehicle.availabilityIntervals)) errors.push(`${label} at ${scheduledAt.toISOString()} is outside ${vehicle.code} availability ${JSON.stringify(vehicle.availabilityIntervals)}`);
      if (batch && step.actionType === 'LOAD') {
        if (loadedVehicle.has(batch.id)) errors.push(`${label} loads a batch more than once`);
        else {
          loadedVehicle.set(batch.id, vehicle.id);
          loadedAt.set(batch.id, { resourceId: vehicle.id, start: step.scheduledAt });
          const stored = storedAt.get(batch.id);
          const physical = occupancies.find((occupancy) => occupancy.resourceType === 'COLD_STORAGE' && occupancy.batchId === batch.id && occupancy.end === null);
          if (physical) physical.end = step.scheduledAt;
          else if (stored) occupancies.push({ resourceType: 'COLD_STORAGE', resourceId: stored.resourceId, batchId: batch.id, weightKg: batch.weightKg, start: stored.start, end: step.scheduledAt });
        }
      }
    }

    const destination = step.destinationId ? destinations.get(step.destinationId) : undefined;
    if (step.destinationId && (!positiveId.test(step.destinationId) || !destination)) errors.push(`${label} references an unconfigured destination`);
    if (step.actionType === 'DISPATCH' && destination) {
      if (destination.status !== 'AVAILABLE') errors.push(`${label} uses an unavailable destination`);
      const arrival = new Date(scheduledAt.getTime() + destination.travelMinutes * 60_000);
      if (!Number.isNaN(arrival.getTime()) && !inIntervals(arrival, destination.receivingIntervals)) errors.push(`${label} arrives at ${arrival.toISOString()}, outside ${destination.name} receiving intervals ${JSON.stringify(destination.receivingIntervals)}`);
      if (step.actionType === 'DISPATCH' && batch) {
        const load = loadedAt.get(batch.id);
        if (!step.vehicleId || loadedVehicle.get(batch.id) !== step.vehicleId || !load) errors.push(`${label} must use the vehicle from the preceding load, which must be unmatched`);
        else {
          const physical = occupancies.find((occupancy) => occupancy.resourceType === 'VEHICLE' && occupancy.batchId === batch.id && occupancy.end === null);
          if (physical) physical.end = arrival.toISOString();
          else occupancies.push({ resourceType: 'VEHICLE', resourceId: load.resourceId, batchId: batch.id, weightKg: batch.weightKg, start: load.start, end: arrival.toISOString() });
        }
        if (context.selectedDestinationId && step.destinationId !== context.selectedDestinationId) errors.push(`${label} does not use the selected destination`);
        else dispatched.add(batch.id);
        if (batch.quality && !Number.isNaN(arrival.getTime())) {
          const deadline = now.getTime() + batch.quality.remainingQualityWindowDays * 86_400_000;
          if (arrival.getTime() > deadline) errors.push(`${label} arrives after the batch quality deadline`);
        }
        if (deadline && !Number.isNaN(deadline.getTime()) && !Number.isNaN(arrival.getTime()) && arrival.getTime() > deadline.getTime()) errors.push(`${label} arrives after the plan deadline`);
      }
    }
  });

  for (const resourceType of ['COLD_STORAGE', 'VEHICLE'] as const) {
    const resourceIds = new Set(occupancies.filter((occupancy) => occupancy.resourceType === resourceType).map((occupancy) => occupancy.resourceId));
    for (const resourceId of resourceIds) {
      const capacity = resourceType === 'COLD_STORAGE' ? coldStorages.get(resourceId)?.availableCapacityKg : vehicles.get(resourceId)?.capacityKg;
      if (capacity === undefined) continue;
      const events = occupancies.filter((occupancy) => occupancy.resourceType === resourceType && occupancy.resourceId === resourceId).flatMap((occupancy) => {
        const start = Date.parse(occupancy.start);
        const end = occupancy.end === null ? Number.POSITIVE_INFINITY : Date.parse(occupancy.end);
        return Number.isFinite(start) && end > start ? [{ at: start, delta: occupancy.weightKg }, { at: end, delta: -occupancy.weightKg }] : [];
      }).sort((left, right) => left.at - right.at || left.delta - right.delta);
      let occupiedKg = 0;
      if (events.some((event) => (occupiedKg += event.delta) > capacity)) {
        const name = resourceType === 'COLD_STORAGE' ? coldStorages.get(resourceId)?.name : vehicles.get(resourceId)?.code;
        errors.push(`${resourceType === 'COLD_STORAGE' ? 'Cold storage' : 'Vehicle'} ${name ?? resourceId} exceeds its ${capacity} kg concurrent capacity`);
      }
    }
  }
  for (const batch of context.batches) if (!covered.has(batch.id)) errors.push(`Active batch ${batch.id} is not covered by the plan`);
  if (context.selectedDestinationId) for (const batch of context.batches) if (!dispatched.has(batch.id)) errors.push(`Active batch ${batch.id} is not dispatched to the selected destination`);
  return errors;
}
