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
  assert.deepEqual(candidates[0]!.proposal.steps.map(({ actionType }) => actionType), ['LOAD', 'DISPATCH']);
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
  assert.deepEqual(candidates[0]!.proposal.steps.map(({ actionType }) => actionType), ['DISPATCH']);
});
