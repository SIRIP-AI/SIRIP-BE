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

export type PlanningContext = {
  now: string;
  selectedDestinationId: string | null;
  deadline: string | null;
  batches: PlanningBatch[];
  coldStorages: PlanningColdStorage[];
  vehicles: PlanningVehicle[];
  destinations: PlanningDestination[];
  currentPlan: PlanningActivePlan | null;
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
  const storageAssignments = new Map<string, Set<string>>();
  const vehicleAssignments = new Map<string, Set<string>>();
  const selectedDestination = context.selectedDestinationId ? destinations.get(context.selectedDestinationId) : undefined;
  const deadline = context.deadline ? new Date(context.deadline) : null;
  const dispatched = new Set<string>();
  const loadedVehicle = new Map<string, string>();
  let previousTime = Number.NEGATIVE_INFINITY;

  if (!proposal.summary.trim() || proposal.summary.length > 1000) errors.push('Plan summary is invalid');
  if (proposal.steps.length < 1 || proposal.steps.length > 100) errors.push('Plan must contain 1 to 100 future steps');
  if (Number.isNaN(now.getTime())) errors.push('Planning context time is invalid');
  if (deadline && (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime())) errors.push('Plan deadline must be a valid future datetime');
  if (context.selectedDestinationId && (!selectedDestination || selectedDestination.status !== 'AVAILABLE')) errors.push('Selected destination is unavailable or unconfigured');
  for (const batch of context.batches) if (!batch.quality) errors.push(`Batch ${batch.id} has no quality state`);

  proposal.steps.forEach((step, index) => {
    const label = `Step ${index + 1}`;
    const scheduledAt = new Date(step.scheduledAt);
    const batch = batches.get(step.batchId);
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
      if (batch && batch.weightKg > coldStorage.availableCapacityKg) errors.push(`${label} exceeds cold-storage capacity for the batch`);
      if (batch) {
        const assigned = storageAssignments.get(coldStorage.id) ?? new Set<string>();
        assigned.add(batch.id);
        storageAssignments.set(coldStorage.id, assigned);
      }
    }

    const vehicle = step.vehicleId ? vehicles.get(step.vehicleId) : undefined;
    if (step.vehicleId && (!positiveId.test(step.vehicleId) || !vehicle)) errors.push(`${label} references an unconfigured vehicle`);
    if ((step.actionType === 'LOAD' || step.actionType === 'DISPATCH') && vehicle) {
      if (vehicle.operationalStatus !== 'AVAILABLE') errors.push(`${label} uses an unavailable vehicle`);
      if (batch && batch.weightKg > vehicle.capacityKg) errors.push(`${label} exceeds vehicle capacity for the batch`);
      if (!Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() < now.getTime() + vehicle.delayMinutes * 60_000) errors.push(`${label} does not account for vehicle delay`);
      if (!Number.isNaN(scheduledAt.getTime()) && !inIntervals(scheduledAt, vehicle.availabilityIntervals)) errors.push(`${label} is outside vehicle availability`);
      if (batch) {
        const assigned = vehicleAssignments.get(vehicle.id) ?? new Set<string>();
        assigned.add(batch.id);
        vehicleAssignments.set(vehicle.id, assigned);
        if (step.actionType === 'LOAD') {
          if (loadedVehicle.has(batch.id)) errors.push(`${label} loads a batch more than once`);
          loadedVehicle.set(batch.id, vehicle.id);
        }
      }
    }

    const destination = step.destinationId ? destinations.get(step.destinationId) : undefined;
    if (step.destinationId && (!positiveId.test(step.destinationId) || !destination)) errors.push(`${label} references an unconfigured destination`);
    if (step.actionType === 'DISPATCH' && destination) {
      if (destination.status !== 'AVAILABLE') errors.push(`${label} uses an unavailable destination`);
      const arrival = new Date(scheduledAt.getTime() + destination.travelMinutes * 60_000);
      if (!Number.isNaN(arrival.getTime()) && !inIntervals(arrival, destination.receivingIntervals)) errors.push(`${label} arrives outside the destination receiving window`);
      if (step.actionType === 'DISPATCH' && batch) {
        if (!step.vehicleId || loadedVehicle.get(batch.id) !== step.vehicleId) errors.push(`${label} must use the vehicle from the preceding load`);
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

  for (const [resourceId, assigned] of storageAssignments) {
    const resource = coldStorages.get(resourceId);
    const assignedWeight = [...assigned].reduce((total, batchId) => total + (batches.get(batchId)?.weightKg ?? 0), 0);
    if (resource && assignedWeight > resource.availableCapacityKg) errors.push(`Cold storage ${resourceId} is overbooked`);
  }
  for (const [resourceId, assigned] of vehicleAssignments) {
    const resource = vehicles.get(resourceId);
    const assignedWeight = [...assigned].reduce((total, batchId) => total + (batches.get(batchId)?.weightKg ?? 0), 0);
    if (resource && assignedWeight > resource.capacityKg) errors.push(`Vehicle ${resourceId} is overbooked`);
  }
  for (const batch of context.batches) if (!covered.has(batch.id)) errors.push(`Active batch ${batch.id} is not covered by the plan`);
  if (context.selectedDestinationId) for (const batch of context.batches) if (!dispatched.has(batch.id)) errors.push(`Active batch ${batch.id} is not dispatched to the selected destination`);
  return errors;
}
