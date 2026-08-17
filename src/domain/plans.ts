export const planActionTypes = ['STORE', 'LOAD', 'DISPATCH', 'HANDOVER', 'INSPECT', 'OTHER'] as const;
export const activeBatchStatuses = ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] as const;

export type PlanActionType = typeof planActionTypes[number];
export type ActiveBatchStatus = typeof activeBatchStatuses[number];
export type PlanStatus = 'PROPOSED' | 'ACTIVE' | 'SUPERSEDED' | 'DISMISSED';
export type PlanStepStatus = 'UPCOMING' | 'COMPLETED' | 'CANCELED';

export type AiPlanStep = {
  actionType: PlanActionType;
  batchId: string;
  scheduledAt: string;
  coldStorageId?: string;
  vehicleId?: string;
  destinationId?: string;
  notes?: string;
};

export type AiPlanProposal = {
  reason: string;
  steps: AiPlanStep[];
};

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
  restriction: string | null;
  availabilityStart: string | null;
  availabilityEnd: string | null;
};

export type PlanningDestination = {
  id: string;
  name: string;
  address: string;
  travelMinutes: number;
  receivingStart: string;
  receivingEnd: string;
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
  notes: string | null;
};

export type PlanningActivePlan = {
  id: string;
  version: number;
  reason: string;
  steps: PlanningPlanStep[];
};

export type PlanningContext = {
  now: string;
  batches: PlanningBatch[];
  coldStorages: PlanningColdStorage[];
  vehicles: PlanningVehicle[];
  destinations: PlanningDestination[];
  activePlan: PlanningActivePlan | null;
};

export function activePlanSnapshot(plan: PlanningActivePlan | null) {
  return JSON.stringify(plan ? [
    plan.id,
    plan.version,
    plan.reason,
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
      step.notes,
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
  reason: string;
  createdAt: string;
  approvedAt: string | null;
  trigger: {
    type: string;
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
    notes: string | null;
    batch: { id: string; code: string };
    resource: PlanResource | null;
  }>;
};

export type PlanList = {
  updatedAt: string;
  activePlan: PlanView | null;
  proposedPlans: PlanView[];
  history: PlanView[];
};

export class InvalidPlanProposalError extends Error {}

const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const positiveId = /^[1-9]\d*$/;
const stepFields = new Set(['actionType', 'batchId', 'scheduledAt', 'coldStorageId', 'vehicleId', 'destinationId', 'notes']);

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
  if (typeof step.actionType !== 'string' || !planActionTypes.includes(step.actionType as PlanActionType)) invalid(`steps[${index}].actionType is invalid`);
  if (typeof step.scheduledAt !== 'string' || !isoDateTime.test(step.scheduledAt) || !Number.isFinite(Date.parse(step.scheduledAt))) invalid(`steps[${index}].scheduledAt must be an ISO datetime`);
  const notes = step.notes === undefined || step.notes === null ? undefined : typeof step.notes === 'string' ? step.notes.trim() : invalid(`steps[${index}].notes must be text`);
  if (notes !== undefined && (!notes || notes.length > 500)) invalid(`steps[${index}].notes must contain 1 to 500 characters`);
  const coldStorageId = optionalId(step.coldStorageId, `steps[${index}].coldStorageId`);
  const vehicleId = optionalId(step.vehicleId, `steps[${index}].vehicleId`);
  const destinationId = optionalId(step.destinationId, `steps[${index}].destinationId`);
  return {
    actionType: step.actionType as PlanActionType,
    batchId: id(step.batchId, `steps[${index}].batchId`),
    scheduledAt: new Date(step.scheduledAt).toISOString(),
    ...(coldStorageId ? { coldStorageId } : {}),
    ...(vehicleId ? { vehicleId } : {}),
    ...(destinationId ? { destinationId } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function parseAiPlanProposal(content: string): AiPlanProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    invalid('AI proposal must be valid JSON');
  }
  const proposal = object(parsed, 'proposal');
  exactFields(proposal, new Set(['reason', 'steps']), 'proposal');
  const reason = typeof proposal.reason === 'string' ? proposal.reason.trim() : '';
  if (!reason || reason.length > 1000) invalid('proposal.reason must contain 1 to 1000 characters');
  if (!Array.isArray(proposal.steps) || proposal.steps.length < 1 || proposal.steps.length > 100) invalid('proposal.steps must contain 1 to 100 steps');
  return { reason, steps: proposal.steps.map(parseStep) };
}

function minute(value: string | null) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minutes] = value.split(':').map(Number);
  if (hour === undefined || minutes === undefined || hour > 23 || minutes > 59) return null;
  return hour * 60 + minutes;
}

function utcMinute(value: Date) {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

function inWindow(value: Date, start: string | null, end: string | null) {
  const startMinute = minute(start);
  const endMinute = minute(end);
  if (startMinute === null && endMinute === null) return true;
  if (startMinute === null || endMinute === null) return false;
  const current = utcMinute(value);
  return current >= startMinute && current <= endMinute;
}

function resourceCombination(step: AiPlanStep) {
  const present = [step.coldStorageId !== undefined, step.vehicleId !== undefined, step.destinationId !== undefined];
  if (step.actionType === 'STORE') return present[0] && !present[1] && !present[2];
  if (step.actionType === 'LOAD') return !present[0] && present[1] && !present[2];
  if (step.actionType === 'DISPATCH' || step.actionType === 'HANDOVER') return !present[0] && !present[1] && present[2];
  return !present[0] && !present[1] && !present[2];
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
  let previousTime = Number.NEGATIVE_INFINITY;

  if (!proposal.reason.trim() || proposal.reason.length > 1000) errors.push('Plan reason is invalid');
  if (proposal.steps.length < 1 || proposal.steps.length > 100) errors.push('Plan must contain 1 to 100 future steps');
  if (Number.isNaN(now.getTime())) errors.push('Planning context time is invalid');
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
    if (step.actionType === 'LOAD' && vehicle) {
      if (vehicle.operationalStatus !== 'AVAILABLE') errors.push(`${label} uses an unavailable vehicle`);
      if (batch && batch.weightKg > vehicle.capacityKg) errors.push(`${label} exceeds vehicle capacity for the batch`);
      if (!Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() < now.getTime() + vehicle.delayMinutes * 60_000) errors.push(`${label} does not account for vehicle delay`);
      if (!Number.isNaN(scheduledAt.getTime()) && !inWindow(scheduledAt, vehicle.availabilityStart, vehicle.availabilityEnd)) errors.push(`${label} is outside vehicle availability`);
      if (batch) {
        const assigned = vehicleAssignments.get(vehicle.id) ?? new Set<string>();
        assigned.add(batch.id);
        vehicleAssignments.set(vehicle.id, assigned);
      }
    }

    const destination = step.destinationId ? destinations.get(step.destinationId) : undefined;
    if (step.destinationId && (!positiveId.test(step.destinationId) || !destination)) errors.push(`${label} references an unconfigured destination`);
    if ((step.actionType === 'DISPATCH' || step.actionType === 'HANDOVER') && destination) {
      if (destination.status !== 'AVAILABLE') errors.push(`${label} uses an unavailable destination`);
      const arrival = new Date(scheduledAt.getTime() + (step.actionType === 'DISPATCH' ? destination.travelMinutes * 60_000 : 0));
      if (!Number.isNaN(arrival.getTime()) && !inWindow(arrival, destination.receivingStart, destination.receivingEnd)) errors.push(`${label} arrives outside the destination receiving window`);
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
  return errors;
}
