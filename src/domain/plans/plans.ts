export const planActionTypes = ['STORE', 'LOAD', 'DISPATCH', 'RETURN_TO_BASE', 'HANDOVER', 'INSPECT', 'OTHER'] as const;
export const generatedPlanActionTypes = ['STORE', 'LOAD', 'DISPATCH', 'HANDOVER', 'RETURN_TO_BASE', 'INSPECT'] as const;
export const activeBatchStatuses = ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] as const;

export type PlanActionType = typeof planActionTypes[number];
export type GeneratedPlanActionType = typeof generatedPlanActionTypes[number];
export type ActiveBatchStatus = typeof activeBatchStatuses[number];
export type PlanStatus = 'PROPOSED' | 'ACTIVE' | 'COMPLETED' | 'SUPERSEDED' | 'DISMISSED';
export type PlanStepStatus = 'UPCOMING' | 'COMPLETED' | 'CANCELED';
export type PlanTimingStatus = 'ON_TIME' | 'DELAYED';
export type PlanTimingReasonCode = 'PLAN_DEADLINE_MISSED' | 'QUALITY_DEADLINE_MISSED' | 'NEXT_RECEIVING_WINDOW' | 'VEHICLE_DELAY' | 'VEHICLE_AVAILABILITY' | 'RESOURCE_RESERVATION';
export type PlanTimingReason = { code: PlanTimingReasonCode; severity: 'WARNING' | 'CRITICAL'; batchId: string | null; vehicleId: string | null; destinationId: string | null; targetAt: string | null; feasibleAt: string; delaySeconds: number; message: string };
export type PlanTimingAssessment = { status: PlanTimingStatus; delayedBySeconds: number; reasons: PlanTimingReason[] };

export type AiPlanStep = {
  actionType: GeneratedPlanActionType;
  batchId?: string;
  scheduledAt: string;
  coldStorageId?: string;
  vehicleId?: string;
  destinationId?: string;
  rationale: string;
  timingRationale?: string;
  latestSafeAt?: string;
};

export type AiPlanProposal = {
  summary: string;
  steps: AiPlanStep[];
  timing?: PlanTimingAssessment;
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
  location?: { type: 'INTAKE' } | { type: 'COLD_STORAGE'; resourceId: string } | { type: 'VEHICLE'; resourceId: string } | { type: 'DESTINATION'; resourceId: string };
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
  batchId: string | null;
  coldStorageId: string | null;
  vehicleId: string | null;
  destinationId: string | null;
  scheduledAt: string;
  status: PlanStepStatus;
  completedAt: string | null;
  rationale: string | null;
  timingRationale?: string | null;
  latestSafeAt?: string | null;
};

export type PlanningActivePlan = {
  id: string;
  version: number;
  summary: string;
  destinationId: string | null;
  destinationIds?: string[];
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
  destinationId?: string;
  dispatchAt?: string;
};

export type PlanningContext = {
  now: string;
  selectedDestinationId: string | null;
  acceptableDestinationIds?: string[];
  deadline: string | null;
  batches: PlanningBatch[];
  coldStorages: PlanningColdStorage[];
  vehicles: PlanningVehicle[];
  destinations: PlanningDestination[];
  currentPlan: PlanningActivePlan | null;
  resourceOccupancies?: PlanningResourceOccupancy[];
};

export type PlanningBatchFacts = {
  batchId: string;
  qualityDeadlineAt: string;
  effectiveArrivalDeadlineAt: string;
  feasibleVehicleIds: string[];
  feasibleColdStorageIds: string[];
  resourceFlexibility: 'NONE' | 'LOW' | 'HIGH';
  urgencyRank: number;
};

export type PlanningFacts = {
  batches: PlanningBatchFacts[];
  selectedDestination: {
    destinationId: string;
    travelMinutes: number;
    receivingIntervals: Array<{ start: string; end: string }>;
    dispatchIntervals: Array<{ start: string; end: string }>;
  } | null;
};

export type PlanQualityIssue = {
  code: 'SCARCE_RESOURCE_MISALLOCATION' | 'QUALITY_PRIORITY_INVERSION' | 'UNNECESSARY_STORAGE';
  message: string;
};

export function planSnapshot(plan: PlanningActivePlan | null) {
  return JSON.stringify(plan ? [
    plan.id,
    plan.version,
    plan.summary,
    plan.destinationId,
    plan.destinationIds ?? [],
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
      step.timingRationale,
      step.latestSafeAt,
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
  destinationIds?: string[];
  deadline: string | null;
  timing: PlanTimingAssessment;
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
    timingRationale: string | null;
    latestSafeAt: string | null;
    batch: { id: string; code: string } | null;
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
const stepFields = new Set(['actionType', 'batchId', 'scheduledAt', 'coldStorageId', 'vehicleId', 'destinationId', 'rationale', 'timingRationale', 'latestSafeAt']);

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
  const timingRationale = typeof step.timingRationale === 'string' ? step.timingRationale.trim() : undefined;
  if (timingRationale !== undefined && (!timingRationale || timingRationale.length > 1000)) invalid(`steps[${index}].timingRationale must contain 1 to 1000 characters`);
  const latestSafeAt = step.latestSafeAt === undefined ? undefined : typeof step.latestSafeAt === 'string' && isoDateTime.test(step.latestSafeAt) && Number.isFinite(Date.parse(step.latestSafeAt)) ? new Date(step.latestSafeAt).toISOString() : invalid(`steps[${index}].latestSafeAt must be an ISO datetime`);
  const coldStorageId = optionalId(step.coldStorageId, `steps[${index}].coldStorageId`);
  const vehicleId = optionalId(step.vehicleId, `steps[${index}].vehicleId`);
  const destinationId = optionalId(step.destinationId, `steps[${index}].destinationId`);
  const batchId = optionalId(step.batchId, `steps[${index}].batchId`);
  if (step.actionType === 'RETURN_TO_BASE' ? batchId !== undefined : batchId === undefined) invalid(`steps[${index}].batchId is invalid for ${step.actionType}`);
  return {
    actionType: step.actionType as GeneratedPlanActionType,
    ...(batchId ? { batchId } : {}),
    scheduledAt: new Date(step.scheduledAt).toISOString(),
    ...(coldStorageId ? { coldStorageId } : {}),
    ...(vehicleId ? { vehicleId } : {}),
    ...(destinationId ? { destinationId } : {}),
    rationale,
    ...(timingRationale ? { timingRationale } : {}),
    ...(latestSafeAt ? { latestSafeAt } : {}),
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

function intervalsOverlap(left: { start: string; end: string }, right: { start: string; end: string }) {
  return Date.parse(left.start) <= Date.parse(right.end) && Date.parse(right.start) <= Date.parse(left.end);
}

export function derivePlanningFacts(context: PlanningContext): PlanningFacts {
  const now = Date.parse(context.now);
  const destination = context.destinations.find(({ id }) => id === context.selectedDestinationId);
  const dispatchIntervals = destination?.receivingIntervals.map(({ start, end }) => ({
    start: new Date(Date.parse(start) - destination.travelMinutes * 60_000).toISOString(),
    end: new Date(Date.parse(end) - destination.travelMinutes * 60_000).toISOString(),
  })) ?? [];
  const batches = context.batches.map((batch) => {
    const qualityDeadline = new Date(now + (batch.quality?.remainingQualityWindowDays ?? 0) * 86_400_000);
    const planDeadline = context.deadline ? new Date(context.deadline) : null;
    const effectiveDeadline = planDeadline && planDeadline < qualityDeadline ? planDeadline : qualityDeadline;
    const reachableDispatchIntervals = dispatchIntervals.filter((interval) => Date.parse(interval.end) >= Math.max(Date.parse(interval.start), now));
    const feasibleVehicleIds = context.vehicles.filter((vehicle) => {
      if (vehicle.operationalStatus !== 'AVAILABLE' || vehicle.capacityKg < batch.weightKg) return false;
      const available = vehicle.availabilityIntervals ?? [{ start: context.now, end: reachableDispatchIntervals.at(-1)?.end ?? effectiveDeadline.toISOString() }];
      return reachableDispatchIntervals.some((dispatch) => available.some((interval) => intervalsOverlap(dispatch, interval) && Date.parse(dispatch.end) >= now + vehicle.delayMinutes * 60_000));
    }).map(({ id }) => id);
    return {
      batchId: batch.id,
      qualityDeadlineAt: qualityDeadline.toISOString(),
      effectiveArrivalDeadlineAt: effectiveDeadline.toISOString(),
      feasibleVehicleIds,
      feasibleColdStorageIds: context.coldStorages.filter((storage) => storage.operationalStatus === 'AVAILABLE' && storage.availableCapacityKg >= batch.weightKg).map(({ id }) => id),
      resourceFlexibility: feasibleVehicleIds.length === 0 ? 'NONE' as const : feasibleVehicleIds.length === 1 ? 'LOW' as const : 'HIGH' as const,
      urgencyRank: 0,
    };
  });
  const deadlines = [...new Set(batches.map(({ effectiveArrivalDeadlineAt }) => effectiveArrivalDeadlineAt))].sort((left, right) => Date.parse(left) - Date.parse(right));
  const ranks = new Map(deadlines.map((deadline, index) => [deadline, index + 1]));
  return {
    batches: batches.map((batch) => ({ ...batch, urgencyRank: ranks.get(batch.effectiveArrivalDeadlineAt)! })),
    selectedDestination: destination ? { destinationId: destination.id, travelMinutes: destination.travelMinutes, receivingIntervals: destination.receivingIntervals, dispatchIntervals } : null,
  };
}

function resourceCombination(step: AiPlanStep) {
  const present = [step.coldStorageId !== undefined, step.vehicleId !== undefined, step.destinationId !== undefined];
  if (step.actionType === 'STORE') return present[0] && !present[1] && !present[2];
  if (step.actionType === 'LOAD') return !present[0] && present[1] && !present[2];
  if (step.actionType === 'DISPATCH') return !present[0] && present[1] && present[2];
  if (step.actionType === 'HANDOVER') return !present[0] && present[1] && present[2];
  if (step.actionType === 'RETURN_TO_BASE') return !present[0] && present[1] && present[2];
  return !present[0] && !present[1] && !present[2];
}

export function orderPlanProposal(proposal: AiPlanProposal): AiPlanProposal {
  return { ...proposal, steps: [...proposal.steps].sort((left, right) => {
    const leftTime = Date.parse(left.scheduledAt);
    const rightTime = Date.parse(right.scheduledAt);
    return (Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY) - (Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY);
  }) };
}

export function addReturnToBaseSteps(proposal: AiPlanProposal, context: PlanningContext): AiPlanProposal {
  const deliverySteps = proposal.steps.filter((step) => step.actionType !== 'RETURN_TO_BASE' && step.actionType !== 'HANDOVER');
  const returns = new Map<string, AiPlanStep>();
  for (const dispatch of deliverySteps.filter((step) => step.actionType === 'DISPATCH')) {
    const destination = dispatch.destinationId ? context.destinations.find(({ id }) => id === dispatch.destinationId) : undefined;
    if (!dispatch.vehicleId || !dispatch.destinationId || !destination) continue;
    const key = `${dispatch.vehicleId}:${dispatch.destinationId}:${dispatch.scheduledAt}`;
    const expectedReturnAt = Date.parse(dispatch.scheduledAt) + destination.travelMinutes * 2 * 60_000;
    const vehicle = context.vehicles.find(({ id }) => id === dispatch.vehicleId);
    const nextLoadAt = deliverySteps.filter((step) => step.actionType === 'LOAD' && step.vehicleId === dispatch.vehicleId && Date.parse(step.scheduledAt) >= expectedReturnAt).map((step) => Date.parse(step.scheduledAt)).sort((left, right) => left - right)[0];
    const availabilityEnd = vehicle?.availabilityIntervals?.filter(({ end }) => Date.parse(end) >= expectedReturnAt).map(({ end }) => Date.parse(end)).sort((left, right) => left - right)[0];
    const returnLimits = [nextLoadAt, availabilityEnd].filter((value): value is number => value !== undefined);
    const latestSafeAt = returnLimits.length ? Math.max(expectedReturnAt, Math.min(...returnLimits)) : expectedReturnAt;
    returns.set(key, {
      actionType: 'RETURN_TO_BASE',
      vehicleId: dispatch.vehicleId,
      destinationId: dispatch.destinationId,
      scheduledAt: new Date(expectedReturnAt).toISOString(),
      rationale: 'Kembalikan kendaraan ke pangkalan setelah menyelesaikan perjalanan pengiriman bersama.',
      timingRationale: `Perkiraan waktu kembali menyediakan ${destination.travelMinutes} menit untuk perjalanan pergi dan ${destination.travelMinutes} menit untuk perjalanan pulang${nextLoadAt !== undefined ? ' sebelum kendaraan digunakan kembali' : ''}.`,
      latestSafeAt: new Date(latestSafeAt).toISOString(),
    });
  }
  return orderPlanProposal({ ...proposal, steps: [...deliverySteps, ...returns.values()] });
}

export function validatePlanProposal(proposal: AiPlanProposal, context: PlanningContext, options: { allowTargetLateness?: boolean } = {}) {
  const errors: string[] = [];
  const now = new Date(context.now);
  const batches = new Map(context.batches.map((batch) => [batch.id, batch]));
  const coldStorages = new Map(context.coldStorages.map((resource) => [resource.id, resource]));
  const vehicles = new Map(context.vehicles.map((resource) => [resource.id, resource]));
  const destinations = new Map(context.destinations.map((resource) => [resource.id, resource]));
  const covered = new Set<string>();
  const occupancies = (context.resourceOccupancies ?? []).map((occupancy) => ({ ...occupancy }));
  const selectedDestination = context.selectedDestinationId ? destinations.get(context.selectedDestinationId) : undefined;
  const acceptableDestinationIds = new Set(context.acceptableDestinationIds ?? (context.selectedDestinationId ? [context.selectedDestinationId] : []));
  const deadline = context.deadline ? new Date(context.deadline) : null;
  const dispatched = new Set<string>();
  const departed = new Set<string>();
  const requiresHandover = proposal.steps.some((step) => step.actionType === 'HANDOVER');
  const loadedVehicle = new Map<string, string>();
  const storedAt = new Map<string, { resourceId: string; start: string }>();
  const loadedAt = new Map<string, { resourceId: string; start: string }>();
  let previousTime = Number.NEGATIVE_INFINITY;

  for (const step of context.currentPlan?.steps.filter((candidate) => candidate.status === 'COMPLETED') ?? []) {
    if (step.actionType === 'STORE' && step.batchId && step.coldStorageId) storedAt.set(step.batchId, { resourceId: step.coldStorageId, start: step.scheduledAt });
    if (step.actionType === 'LOAD' && step.batchId && step.vehicleId) {
      storedAt.delete(step.batchId);
      loadedVehicle.set(step.batchId, step.vehicleId);
      loadedAt.set(step.batchId, { resourceId: step.vehicleId, start: step.scheduledAt });
    }
    if (step.actionType === 'DISPATCH' && step.batchId) { departed.add(step.batchId); if (!requiresHandover) dispatched.add(step.batchId); }
    if (step.actionType === 'HANDOVER' && step.batchId) dispatched.add(step.batchId);
    if (step.actionType === 'RETURN_TO_BASE' && step.vehicleId) for (const [batchId, vehicleId] of loadedVehicle) if (vehicleId === step.vehicleId) {
      loadedVehicle.delete(batchId);
      loadedAt.delete(batchId);
    }
  }

  if (!proposal.summary.trim() || proposal.summary.length > 1000) errors.push('Ringkasan rencana tidak valid');
  if (proposal.steps.length < 1 || proposal.steps.length > 100) errors.push('Rencana harus memuat 1 hingga 100 langkah mendatang');
  if (Number.isNaN(now.getTime())) errors.push('Waktu konteks perencanaan tidak valid');
  if (deadline && (Number.isNaN(deadline.getTime()) || (!options.allowTargetLateness && deadline.getTime() <= now.getTime()))) errors.push('Tenggat rencana harus berupa waktu mendatang yang valid');
  if (context.selectedDestinationId && (!selectedDestination || selectedDestination.status !== 'AVAILABLE')) errors.push('Tujuan yang dipilih tidak tersedia atau belum dikonfigurasi');
  for (const destinationId of acceptableDestinationIds) if (destinations.get(destinationId)?.status !== 'AVAILABLE') errors.push(`Tujuan yang dapat diterima ${destinationId} tidak tersedia atau belum dikonfigurasi`);
  for (const batch of context.batches) if (!batch.quality) errors.push(`Batch ${batch.id} tidak memiliki status mutu`);

  proposal.steps.forEach((step, index) => {
    const scheduledAt = new Date(step.scheduledAt);
    const batch = step.batchId ? batches.get(step.batchId) : undefined;
    const label = `Langkah ${index + 1} (${step.actionType}${batch ? ` ${batch.code}` : ''})`;
    if (step.actionType === 'RETURN_TO_BASE') {
      if (step.batchId !== undefined) errors.push(`${label} harus berupa langkah tingkat kendaraan tanpa batch`);
    } else if (!step.batchId || !positiveId.test(step.batchId) || !batch || !activeBatchStatuses.includes(batch.status)) errors.push(`${label} merujuk pada batch yang tidak aktif atau belum dikonfigurasi`);
    else covered.add(batch.id);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now.getTime()) errors.push(`${label} harus dijadwalkan pada waktu mendatang`);
    if (step.latestSafeAt && (!isoDateTime.test(step.latestSafeAt) || !Number.isFinite(Date.parse(step.latestSafeAt)) || Date.parse(step.latestSafeAt) < scheduledAt.getTime())) errors.push(`${label} memiliki batas waktu aman yang tidak valid`);
    if (step.timingRationale !== undefined && (!step.timingRationale.trim() || step.timingRationale.length > 1000)) errors.push(`${label} memiliki alasan waktu yang tidak valid`);
    if (!Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() < previousTime) errors.push(`${label} tidak tersusun secara kronologis`);
    if (!Number.isNaN(scheduledAt.getTime())) previousTime = scheduledAt.getTime();
    if (!resourceCombination(step)) errors.push(`${label} memiliki kombinasi tindakan/sumber daya yang tidak diizinkan`);
    if (step.batchId && dispatched.has(step.batchId)) errors.push(`${label} menjadwalkan pekerjaan setelah serah terima`);
    if (step.actionType === 'INSPECT' && batch?.status !== 'INSPECTION_HOLD') errors.push(`${label} membuat persyaratan pemeriksaan yang tidak ada`);

    const coldStorage = step.coldStorageId ? coldStorages.get(step.coldStorageId) : undefined;
    if (step.coldStorageId && (!positiveId.test(step.coldStorageId) || !coldStorage)) errors.push(`${label} merujuk pada penyimpanan dingin yang belum dikonfigurasi`);
    if (step.actionType === 'STORE' && coldStorage) {
      if (coldStorage.operationalStatus !== 'AVAILABLE' || coldStorage.availableCapacityKg <= 0) errors.push(`${label} menggunakan penyimpanan dingin yang tidak tersedia`);
      if (batch && batch.weightKg > coldStorage.availableCapacityKg) errors.push(`${label} berbobot ${batch.weightKg} kg, tetapi ${coldStorage.name} hanya memiliki kapasitas tersedia ${coldStorage.availableCapacityKg} kg`);
      if (batch && storedAt.has(batch.id)) errors.push(`${label} menyimpan batch lebih dari satu kali`);
      else if (batch) storedAt.set(batch.id, { resourceId: coldStorage.id, start: step.scheduledAt });
    }

    const vehicle = step.vehicleId ? vehicles.get(step.vehicleId) : undefined;
    if (step.vehicleId && (!positiveId.test(step.vehicleId) || !vehicle)) errors.push(`${label} merujuk pada kendaraan yang belum dikonfigurasi`);
    if ((step.actionType === 'LOAD' || step.actionType === 'DISPATCH') && vehicle) {
      if (vehicle.operationalStatus !== 'AVAILABLE') errors.push(`${label} menggunakan kendaraan yang tidak tersedia`);
      if (batch && batch.weightKg > vehicle.capacityKg) errors.push(`${label} berbobot ${batch.weightKg} kg, tetapi kapasitas ${vehicle.code} hanya ${vehicle.capacityKg} kg`);
      if (!Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() < now.getTime() + vehicle.delayMinutes * 60_000) errors.push(`${label} tidak memperhitungkan keterlambatan kendaraan`);
      if (!Number.isNaN(scheduledAt.getTime()) && !inIntervals(scheduledAt, vehicle.availabilityIntervals)) errors.push(`${label} pada ${scheduledAt.toISOString()} berada di luar waktu ketersediaan ${vehicle.code} ${JSON.stringify(vehicle.availabilityIntervals)}`);
      if (batch && step.actionType === 'LOAD') {
        if (loadedVehicle.has(batch.id)) errors.push(`${label} memuat batch lebih dari satu kali`);
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
    if (step.destinationId && (!positiveId.test(step.destinationId) || !destination)) errors.push(`${label} merujuk pada tujuan yang belum dikonfigurasi`);
    if (step.actionType === 'DISPATCH' && destination) {
      if (destination.status !== 'AVAILABLE') errors.push(`${label} menggunakan tujuan yang tidak tersedia`);
      const arrival = new Date(scheduledAt.getTime() + destination.travelMinutes * 60_000);
      if (!Number.isNaN(arrival.getTime()) && !inIntervals(arrival, destination.receivingIntervals)) errors.push(`${label} tiba pada ${arrival.toISOString()}, di luar interval penerimaan ${destination.name} ${JSON.stringify(destination.receivingIntervals)}`);
      if (step.actionType === 'DISPATCH' && batch) {
        const load = loadedAt.get(batch.id);
        if (!step.vehicleId || loadedVehicle.get(batch.id) !== step.vehicleId || !load) errors.push(`${label} harus menggunakan kendaraan dari pemuatan sebelumnya yang belum dipasangkan`);
        else {
          const physical = occupancies.find((occupancy) => occupancy.resourceType === 'VEHICLE' && occupancy.batchId === batch.id && occupancy.end === null);
          const expectedReturnAt = scheduledAt.getTime() + destination.travelMinutes * 2 * 60_000;
          const returnSteps = proposal.steps.filter((candidate) => candidate.actionType === 'RETURN_TO_BASE' && candidate.vehicleId === step.vehicleId && candidate.destinationId === step.destinationId && Date.parse(candidate.scheduledAt) === expectedReturnAt);
          const returnStep = returnSteps[0];
          if (returnSteps.length !== 1) errors.push(`${label} harus memiliki tepat satu langkah RETURN_TO_BASE pada ${new Date(expectedReturnAt).toISOString()}`);
          const occupiedUntil = returnStep?.scheduledAt ?? null;
          if (physical) physical.end = occupiedUntil;
          else occupancies.push({ resourceType: 'VEHICLE', resourceId: load.resourceId, batchId: batch.id, weightKg: batch.weightKg, start: load.start, end: occupiedUntil, destinationId: destination.id, dispatchAt: step.scheduledAt });
        }
        if (context.selectedDestinationId && step.destinationId !== context.selectedDestinationId) errors.push(`${label} tidak menggunakan tujuan yang dipilih`);
        if (acceptableDestinationIds.size && (!step.destinationId || !acceptableDestinationIds.has(step.destinationId))) errors.push(`${label} tidak menggunakan tujuan yang dapat diterima`);
        else { departed.add(batch.id); if (!requiresHandover) dispatched.add(batch.id); }
        if (batch.quality && !Number.isNaN(arrival.getTime())) {
          const deadline = now.getTime() + batch.quality.remainingQualityWindowDays * 86_400_000;
          if (!options.allowTargetLateness && arrival.getTime() > deadline) errors.push(`${label} tiba setelah tenggat mutu batch`);
        }
        if (!options.allowTargetLateness && deadline && !Number.isNaN(deadline.getTime()) && !Number.isNaN(arrival.getTime()) && arrival.getTime() > deadline.getTime()) errors.push(`${label} tiba setelah tenggat rencana`);
      }
    }
    if (step.actionType === 'HANDOVER' && batch && destination) {
      if (!step.vehicleId || loadedVehicle.get(batch.id) !== step.vehicleId || !departed.has(batch.id)) errors.push(`${label} mengharuskan batch dikirim dengan kendaraan yang sama`);
      const dispatch = proposal.steps.find((candidate) => candidate.actionType === 'DISPATCH' && candidate.batchId === batch.id && candidate.vehicleId === step.vehicleId && candidate.destinationId === step.destinationId);
      if (!dispatch || Date.parse(dispatch.scheduledAt) + destination.travelMinutes * 60_000 !== scheduledAt.getTime()) errors.push(`${label} harus terjadi saat tiba di tujuan`);
      if (context.selectedDestinationId && step.destinationId !== context.selectedDestinationId) errors.push(`${label} tidak menggunakan tujuan yang dipilih`);
      if (acceptableDestinationIds.size && (!step.destinationId || !acceptableDestinationIds.has(step.destinationId))) errors.push(`${label} tidak menggunakan tujuan yang dapat diterima`);
      else dispatched.add(batch.id);
    }
    if (step.actionType === 'RETURN_TO_BASE') {
      if (!step.vehicleId || !vehicle) errors.push(`${label} merujuk pada kendaraan yang belum dikonfigurasi`);
      if (!step.destinationId || !destination) errors.push(`${label} merujuk pada tujuan yang belum dikonfigurasi`);
      if (vehicle && !Number.isNaN(scheduledAt.getTime()) && !inIntervals(scheduledAt, vehicle.availabilityIntervals)) errors.push(`${label} berada di luar waktu ketersediaan ${vehicle.code}`);
      const matchingDispatch = proposal.steps.some((candidate) => candidate.actionType === 'DISPATCH' && candidate.vehicleId === step.vehicleId && candidate.destinationId === step.destinationId && Date.parse(candidate.scheduledAt) + (destination?.travelMinutes ?? 0) * 2 * 60_000 === scheduledAt.getTime());
      const duplicateReturns = proposal.steps.filter((candidate) => candidate.actionType === 'RETURN_TO_BASE' && candidate.vehicleId === step.vehicleId && candidate.destinationId === step.destinationId && candidate.scheduledAt === step.scheduledAt).length;
      if (!matchingDispatch) errors.push(`${label} tidak memiliki perjalanan pulang-pergi yang sesuai`);
      if (duplicateReturns !== 1) errors.push(`${label} menduplikasi kepulangan kendaraan`);
    }
  });

  for (const resourceType of ['COLD_STORAGE', 'VEHICLE'] as const) {
    const resourceIds = new Set(occupancies.filter((occupancy) => occupancy.resourceType === resourceType).map((occupancy) => occupancy.resourceId));
    for (const resourceId of resourceIds) {
      const capacity = resourceType === 'COLD_STORAGE' ? coldStorages.get(resourceId)?.capacityKg : vehicles.get(resourceId)?.capacityKg;
      if (capacity === undefined) continue;
      const events = occupancies.filter((occupancy) => occupancy.resourceType === resourceType && occupancy.resourceId === resourceId).flatMap((occupancy) => {
        const start = Date.parse(occupancy.start);
        const end = occupancy.end === null ? Number.POSITIVE_INFINITY : Date.parse(occupancy.end);
        return Number.isFinite(start) && end > start ? [{ at: start, delta: occupancy.weightKg }, { at: end, delta: -occupancy.weightKg }] : [];
      }).sort((left, right) => left.at - right.at || left.delta - right.delta);
      let occupiedKg = 0;
      if (events.some((event) => (occupiedKg += event.delta) > capacity)) {
        const name = resourceType === 'COLD_STORAGE' ? coldStorages.get(resourceId)?.name : vehicles.get(resourceId)?.code;
        errors.push(`${resourceType === 'COLD_STORAGE' ? 'Penyimpanan dingin' : 'Kendaraan'} ${name ?? resourceId} melampaui kapasitas bersamaan ${capacity} kg`);
      }
    }
  }
  const vehicleOccupancies = occupancies.filter((occupancy) => occupancy.resourceType === 'VEHICLE');
  for (let leftIndex = 0; leftIndex < vehicleOccupancies.length; leftIndex += 1) {
    const left = vehicleOccupancies[leftIndex]!;
    for (const right of vehicleOccupancies.slice(leftIndex + 1)) {
      if (left.resourceId !== right.resourceId || left.batchId === right.batchId) continue;
      const overlap = Date.parse(left.start) < (right.end === null ? Number.POSITIVE_INFINITY : Date.parse(right.end))
        && Date.parse(right.start) < (left.end === null ? Number.POSITIVE_INFINITY : Date.parse(left.end));
      if (!overlap) continue;
      const sharedTrip = left.destinationId !== undefined && left.destinationId === right.destinationId
        && left.dispatchAt !== undefined && left.dispatchAt === right.dispatchAt
        && left.end !== null && left.end === right.end;
      if (!sharedTrip) errors.push(`Kendaraan ${vehicles.get(left.resourceId)?.code ?? left.resourceId} memiliki perjalanan tumpang tindih yang tidak kompatibel`);
    }
  }
  for (const batch of context.batches) if (!covered.has(batch.id)) errors.push(`Batch aktif ${batch.id} tidak tercakup dalam rencana`);
  if (context.selectedDestinationId || acceptableDestinationIds.size) for (const batch of context.batches) if (!dispatched.has(batch.id)) errors.push(context.selectedDestinationId ? `Batch aktif ${batch.id} tidak dikirim ke tujuan yang dipilih` : `Batch aktif ${batch.id} tidak diserahterimakan ke tujuan yang dapat diterima`);
  return errors;
}

function journey(proposal: AiPlanProposal, batchId: string) {
  const load = proposal.steps.find((step) => step.batchId === batchId && step.actionType === 'LOAD');
  const dispatch = proposal.steps.find((step) => step.batchId === batchId && step.actionType === 'DISPATCH');
  return load && dispatch ? { load, dispatch } : null;
}

function replaceSteps(proposal: AiPlanProposal, replace: (step: AiPlanStep) => AiPlanStep | null) {
  return orderPlanProposal({ ...proposal, steps: proposal.steps.flatMap((step) => {
    const replacement = replace(step);
    return replacement ? [replacement] : [];
  }) });
}

export function evaluatePlanQuality(proposal: AiPlanProposal, context: PlanningContext, facts = derivePlanningFacts(context)): PlanQualityIssue[] {
  const issues: PlanQualityIssue[] = [];

  for (const step of proposal.steps) {
    if (step.actionType !== 'STORE') continue;
    const withoutStorage = addReturnToBaseSteps(replaceSteps(proposal, (candidate) => candidate === step ? null : candidate), context);
    const load = proposal.steps.find((candidate) => candidate.batchId === step.batchId && candidate.actionType === 'LOAD');
    if (load && Date.parse(load.scheduledAt) - Date.parse(context.now) <= 30 * 60_000 && validatePlanProposal(withoutStorage, context).length === 0) {
      const batch = context.batches.find(({ id }) => id === step.batchId);
      issues.push({ code: 'UNNECESSARY_STORAGE', message: `${batch?.code ?? `Batch ${step.batchId}`} disimpan meskipun rencana pemuatan dan pengiriman yang sama layak dilakukan tanpa penyimpanan.` });
    }
  }

  for (const constrained of facts.batches.filter(({ feasibleVehicleIds }) => feasibleVehicleIds.length === 1)) {
    const constrainedJourney = journey(proposal, constrained.batchId);
    if (!constrainedJourney) continue;
    const scarceVehicleId = constrained.feasibleVehicleIds[0]!;
    for (const flexible of facts.batches.filter(({ batchId, feasibleVehicleIds }) => batchId !== constrained.batchId && feasibleVehicleIds.length > 1)) {
      const flexibleJourney = journey(proposal, flexible.batchId);
      if (!flexibleJourney || flexibleJourney.load.vehicleId !== scarceVehicleId || Date.parse(flexibleJourney.dispatch.scheduledAt) >= Date.parse(constrainedJourney.dispatch.scheduledAt)) continue;
      for (const alternative of flexible.feasibleVehicleIds.filter((vehicleId) => vehicleId !== scarceVehicleId)) {
        const candidate = addReturnToBaseSteps(replaceSteps(proposal, (step) => {
          if (step.batchId === constrained.batchId && step.actionType === 'STORE') return null;
          if (step.batchId === constrained.batchId && step.actionType === 'LOAD') return { ...step, vehicleId: scarceVehicleId, scheduledAt: flexibleJourney.load.scheduledAt };
          if (step.batchId === constrained.batchId && step.actionType === 'DISPATCH') return { ...step, vehicleId: scarceVehicleId, scheduledAt: flexibleJourney.dispatch.scheduledAt };
          if (step.batchId === flexible.batchId && (step.actionType === 'LOAD' || step.actionType === 'DISPATCH')) return { ...step, vehicleId: alternative };
          return step;
        }), context);
        if (validatePlanProposal(candidate, context).length === 0) {
          const constrainedBatch = context.batches.find(({ id }) => id === constrained.batchId);
          const flexibleBatch = context.batches.find(({ id }) => id === flexible.batchId);
          const scarceVehicle = context.vehicles.find(({ id }) => id === scarceVehicleId);
          issues.push({ code: 'SCARCE_RESOURCE_MISALLOCATION', message: `${scarceVehicle?.code ?? `Kendaraan ${scarceVehicleId}`} adalah satu-satunya kendaraan yang layak untuk ${constrainedBatch?.code ?? constrained.batchId}, tetapi digunakan lebih dahulu untuk batch fleksibel ${flexibleBatch?.code ?? flexible.batchId}; alokasi alternatif tervalidasi menghindari keterlambatan tersebut.` });
          break;
        }
      }
    }
  }

  for (const urgent of facts.batches) {
    const urgentJourney = journey(proposal, urgent.batchId);
    if (!urgentJourney) continue;
    for (const laterPriority of facts.batches.filter(({ urgencyRank }) => urgencyRank > urgent.urgencyRank)) {
      const otherJourney = journey(proposal, laterPriority.batchId);
      if (!otherJourney || Date.parse(otherJourney.dispatch.scheduledAt) >= Date.parse(urgentJourney.dispatch.scheduledAt)) continue;
      const candidate = addReturnToBaseSteps(replaceSteps(proposal, (step) => {
        if (step.batchId === urgent.batchId && step.actionType === 'LOAD') return { ...step, scheduledAt: otherJourney.load.scheduledAt };
        if (step.batchId === urgent.batchId && step.actionType === 'DISPATCH') return { ...step, scheduledAt: otherJourney.dispatch.scheduledAt };
        if (step.batchId === laterPriority.batchId && step.actionType === 'LOAD') return { ...step, scheduledAt: urgentJourney.load.scheduledAt };
        if (step.batchId === laterPriority.batchId && step.actionType === 'DISPATCH') return { ...step, scheduledAt: urgentJourney.dispatch.scheduledAt };
        return step;
      }), context);
      if (validatePlanProposal(candidate, context).length === 0) {
        const urgentBatch = context.batches.find(({ id }) => id === urgent.batchId);
        const otherBatch = context.batches.find(({ id }) => id === laterPriority.batchId);
        issues.push({ code: 'QUALITY_PRIORITY_INVERSION', message: `${urgentBatch?.code ?? urgent.batchId} memiliki tenggat efektif lebih awal daripada ${otherBatch?.code ?? laterPriority.batchId}, dan pertukaran jadwal tervalidasi melayaninya lebih dahulu.` });
      }
    }
  }

  return issues.filter((issue, index) => issues.findIndex((candidate) => candidate.code === issue.code && candidate.message === issue.message) === index);
}

export function validateSensiblePlanProposal(proposal: AiPlanProposal, context: PlanningContext) {
  const hardErrors = validatePlanProposal(proposal, context);
  if (hardErrors.length) return hardErrors;
  return evaluatePlanQuality(proposal, context).map((issue) => `PLAN_QUALITY ${issue.code}: ${issue.message}`);
}

export function assessPlanTiming(proposal: AiPlanProposal, context: PlanningContext): PlanTimingAssessment {
  const formatDuration = (seconds: number) => {
    const minutes = Math.ceil(seconds / 60); const hours = Math.floor(minutes / 60); const remainder = minutes % 60;
    return [hours ? `${hours} jam` : '', remainder ? `${remainder} menit` : ''].filter(Boolean).join(' ') || 'kurang dari satu menit';
  };
  const reasons: PlanTimingReason[] = [];
  for (const step of proposal.steps.filter((candidate) => candidate.actionType === 'DISPATCH' && candidate.batchId && candidate.destinationId)) {
    const batch = context.batches.find(({ id }) => id === step.batchId);
    const destination = context.destinations.find(({ id }) => id === step.destinationId);
    if (!batch || !destination) continue;
    const feasibleAt = new Date(Date.parse(step.scheduledAt) + destination.travelMinutes * 60_000).toISOString();
    const targets = [
      ...(context.deadline ? [{ code: 'PLAN_DEADLINE_MISSED' as const, severity: 'WARNING' as const, targetAt: context.deadline, label: 'tenggat kedatangan rencana' }] : []),
      ...(batch.quality ? [{ code: 'QUALITY_DEADLINE_MISSED' as const, severity: 'CRITICAL' as const, targetAt: new Date(Date.parse(context.now) + batch.quality.remainingQualityWindowDays * 86_400_000).toISOString(), label: `tenggat mutu ${batch.code}` }] : []),
    ];
    for (const target of targets) {
      const delaySeconds = Math.max(0, Math.ceil((Date.parse(feasibleAt) - Date.parse(target.targetAt)) / 1000));
      if (!delaySeconds) continue;
      reasons.push({ code: target.code, severity: target.severity, batchId: batch.id, vehicleId: step.vehicleId ?? null, destinationId: destination.id, targetAt: target.targetAt, feasibleAt, delaySeconds, message: `${batch.code} diperkirakan tiba ${formatDuration(delaySeconds)} setelah ${target.label}.` });
    }
  }
  const delayedBySeconds = reasons.reduce((maximum, reason) => Math.max(maximum, reason.delaySeconds), 0);
  if (delayedBySeconds) {
    for (const reason of reasons.filter(({ code }) => code === 'PLAN_DEADLINE_MISSED' || code === 'QUALITY_DEADLINE_MISSED')) {
      const step = proposal.steps.find((candidate) => candidate.actionType === 'DISPATCH' && candidate.batchId === reason.batchId && candidate.destinationId === reason.destinationId);
      const destination = context.destinations.find(({ id }) => id === reason.destinationId);
      const receiving = destination?.receivingIntervals.find(({ start, end }) => Date.parse(reason.feasibleAt) >= Date.parse(start) && Date.parse(reason.feasibleAt) <= Date.parse(end));
      if (step && destination && receiving && reason.targetAt && Date.parse(receiving.start) > Date.parse(reason.targetAt) && !reasons.some(({ code, batchId }) => code === 'NEXT_RECEIVING_WINDOW' && batchId === reason.batchId)) {
        const waitSeconds = Math.ceil((Date.parse(receiving.start) - Date.parse(reason.targetAt)) / 1000);
        reasons.push({ code: 'NEXT_RECEIVING_WINDOW', severity: reason.severity, batchId: reason.batchId, vehicleId: step.vehicleId ?? null, destinationId: destination.id, targetAt: reason.targetAt, feasibleAt: receiving.start, delaySeconds: waitSeconds, message: `Jendela penerimaan valid berikutnya di ${destination.name} dimulai ${formatDuration(waitSeconds)} setelah target yang terlewat.` });
      }
    }
    const vehicleIds = new Set(reasons.flatMap(({ vehicleId }) => vehicleId ? [vehicleId] : []));
    for (const vehicleId of vehicleIds) {
      const vehicle = context.vehicles.find(({ id }) => id === vehicleId);
      if (vehicle?.delayMinutes) reasons.push({ code: 'VEHICLE_DELAY', severity: 'WARNING', batchId: null, vehicleId, destinationId: null, targetAt: null, feasibleAt: new Date(Date.parse(context.now) + vehicle.delayMinutes * 60_000).toISOString(), delaySeconds: vehicle.delayMinutes * 60, message: `${vehicle.code} terlambat ${vehicle.delayMinutes} menit.` });
    }
  }
  return { status: delayedBySeconds ? 'DELAYED' : 'ON_TIME', delayedBySeconds, reasons };
}

export function validateApprovablePlanProposal(proposal: AiPlanProposal, context: PlanningContext) {
  return validatePlanProposal(proposal, context, { allowTargetLateness: true });
}
