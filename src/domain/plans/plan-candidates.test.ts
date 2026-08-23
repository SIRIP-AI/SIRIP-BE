import assert from 'node:assert/strict';
import test from 'node:test';

import { generatePlanCandidates } from './plan-candidates';
import { derivePlanningFacts, validateSensiblePlanProposal, type PlanningContext } from './plans';

const context: PlanningContext = {
  now: '2026-08-20T12:00:00.000Z',
  selectedDestinationId: '3',
  deadline: '2026-08-21T10:00:00.000Z',
  batches: [{ id: '7', code: 'B-7', weightKg: 10, grade: 'A', status: 'ACTIVE', quality: { equivalentQualityAgeDays: 1, remainingQualityWindowDays: 1, qualityEstimateStartedAt: '2026-08-20T00:00:00.000Z', currentTemperatureC: 2 }, telemetry: [] }],
  coldStorages: [],
  vehicles: [{ id: '2', code: 'TR-2', capacityKg: 100, operationalStatus: 'AVAILABLE', delayMinutes: 0, delayPersistent: false, restriction: null, availabilityIntervals: [{ start: '2026-08-20T12:00:00.000Z', end: '2026-08-20T16:00:00.000Z' }] }],
  destinations: [{ id: '3', name: 'Port', address: 'A', travelMinutes: 60, receivingIntervals: [{ start: '2026-08-20T13:00:00.000Z', end: '2026-08-20T18:00:00.000Z' }], status: 'AVAILABLE', notes: null }],
  currentPlan: null,
};

test('generates only sensible deterministic candidates', () => {
  const candidates = generatePlanCandidates(context, derivePlanningFacts(context));
  assert.ok(candidates.length > 0);
  assert.ok(candidates.length <= 3);
  assert.ok(candidates.every(({ proposal }) => validateSensiblePlanProposal(proposal, context).length === 0));
  assert.deepEqual(candidates[0]!.proposal.steps.map(({ actionType }) => actionType), ['LOAD', 'DISPATCH', 'RETURN_TO_BASE']);
  assert.ok(candidates[0]!.proposal.steps.every((step) => step.rationale && step.timingRationale && step.latestSafeAt && Date.parse(step.latestSafeAt) >= Date.parse(step.scheduledAt)));
  const dispatch = candidates[0]!.proposal.steps.find(({ actionType }) => actionType === 'DISPATCH');
  const load = candidates[0]!.proposal.steps.find(({ actionType }) => actionType === 'LOAD');
  assert.equal(dispatch?.latestSafeAt, '2026-08-20T14:00:00.000Z');
  assert.equal(load?.latestSafeAt, '2026-08-20T13:45:00.000Z');
  assert.match(dispatch?.timingRationale ?? '', /availability and return trip/);
});

test('returns no candidate when no vehicle can carry the batch', () => {
  const impossible = { ...context, vehicles: [{ ...context.vehicles[0]!, capacityKg: 5 }] };
  assert.deepEqual(generatePlanCandidates(impossible, derivePlanningFacts(impossible)), []);
});

test('continues from a completed load without generating another load', () => {
  const loaded: PlanningContext = {
    ...context,
    currentPlan: { id: '10', version: 1, summary: 'Loaded', destinationId: '3', deadline: context.deadline, steps: [{ sequence: 1, actionType: 'LOAD', batchId: '7', coldStorageId: null, vehicleId: '2', destinationId: null, scheduledAt: '2026-08-20T11:30:00.000Z', status: 'COMPLETED', completedAt: '2026-08-20T11:45:00.000Z', rationale: null }] },
    resourceOccupancies: [{ resourceType: 'VEHICLE', resourceId: '2', batchId: '7', weightKg: 10, start: '2026-08-20T11:30:00.000Z', end: null }],
  };
  const candidates = generatePlanCandidates(loaded, derivePlanningFacts(loaded));
  assert.ok(candidates.length > 0);
  assert.deepEqual(candidates[0]!.proposal.steps.map(({ actionType }) => actionType), ['DISPATCH', 'RETURN_TO_BASE']);
});

test('keeps a vehicle occupied for the full round trip and shares one return across a trip', () => {
  const shared = { ...context, batches: [...context.batches, { ...context.batches[0]!, id: '8', code: 'B-8' }] };
  const candidates = generatePlanCandidates(shared, derivePlanningFacts(shared));
  assert.ok(candidates.length > 0);
  const first = candidates[0]!.proposal;
  const returns = first.steps.filter(({ actionType }) => actionType === 'RETURN_TO_BASE');
  assert.ok(returns.length >= 1);
  for (const load of first.steps.filter(({ actionType }) => actionType === 'LOAD')) {
    const previousReturn = returns.filter((step) => step.vehicleId === load.vehicleId && Date.parse(step.scheduledAt) <= Date.parse(load.scheduledAt)).at(-1);
    const previousDispatch = first.steps.filter((step) => step.actionType === 'DISPATCH' && step.vehicleId === load.vehicleId && Date.parse(step.scheduledAt) < Date.parse(load.scheduledAt)).at(-1);
    if (previousDispatch) assert.ok(previousReturn, 'a reused vehicle must have returned before its next load');
  }
});
