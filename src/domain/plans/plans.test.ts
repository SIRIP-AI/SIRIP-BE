import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAiPlanResult, validatePlanProposal, type PlanningContext } from './plans';

const receivingIntervals = [{ start: '2026-08-20T00:00:00.000Z', end: '2026-08-22T00:00:00.000Z' }];

const context: PlanningContext = {
  now: '2026-08-20T12:00:00.000Z',
  selectedDestinationId: '3',
  deadline: '2026-08-21T10:00:00.000Z',
  batches: [{ id: '7', code: 'B-7', weightKg: 10, grade: 'A', status: 'ACTIVE', quality: { equivalentQualityAgeDays: 1, remainingQualityWindowDays: 1, qualityEstimateStartedAt: '2026-08-20T00:00:00.000Z', currentTemperatureC: 2 }, telemetry: [] }],
  coldStorages: [{ id: '1', name: 'Cold', capacityKg: 100, availableCapacityKg: 100, operationalStatus: 'AVAILABLE' }],
  vehicles: [{ id: '2', code: 'Truck', capacityKg: 100, operationalStatus: 'AVAILABLE', delayMinutes: 0, delayPersistent: false, restriction: null, availabilityIntervals: null }],
  destinations: [{ id: '3', name: 'Port', address: 'A', travelMinutes: 60, receivingIntervals, status: 'AVAILABLE', notes: null }, { id: '4', name: 'Other', address: 'B', travelMinutes: 0, receivingIntervals, status: 'AVAILABLE', notes: null }],
  currentPlan: null,
};

test('parses proposal and no-valid-proposal results strictly', () => {
  assert.deepEqual(parseAiPlanResult('{"status":"NO_VALID_PROPOSAL_FOUND","reason":"No route"}'), { status: 'NO_VALID_PROPOSAL_FOUND', reason: 'No route' });
  assert.throws(() => parseAiPlanResult('{"status":"NO_VALID_PROPOSAL_FOUND","reason":"No route","steps":[]}'));
  assert.throws(() => parseAiPlanResult('{"status":"PROPOSAL","summary":"Legacy","steps":[{"actionType":"OTHER","batchId":"7","scheduledAt":"2026-08-20T13:00:00Z","rationale":"No"}]}'));
});

test('requires dispatch to the selected destination for every batch', () => {
  const errors = validatePlanProposal({ summary: 'Inspect only', steps: [{ actionType: 'INSPECT', batchId: '7', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Inspect.' }] }, context);
  assert.ok(errors.includes('Active batch 7 is not dispatched to the selected destination'));
});

test('rejects another destination and arrival after the quality deadline', () => {
  const wrongDestination = validatePlanProposal({ summary: 'Wrong destination', steps: [{ actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T12:30:00.000Z', rationale: 'Load.' }, { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '4', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Dispatch.' }] }, context);
  assert.ok(wrongDestination.some((error) => error.includes('does not use the selected destination')));

  const expired = validatePlanProposal({ summary: 'Too late', steps: [{ actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-21T11:30:00.000Z', rationale: 'Load.' }, { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-21T12:00:00.000Z', rationale: 'Dispatch.' }] }, context);
  assert.ok(expired.some((error) => error.includes('quality deadline')));
});

test('rejects destination arrival after the plan deadline', () => {
  const errors = validatePlanProposal({ summary: 'Late arrival', steps: [{ actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-21T09:00:00.000Z', rationale: 'Load.' }, { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-21T09:30:00.000Z', rationale: 'Dispatch.' }] }, context);
  assert.ok(errors.some((error) => error.includes('plan deadline')));
});

test('requires dispatch to use the preceding load vehicle without forcing storage', () => {
  const direct = validatePlanProposal({ summary: 'Direct dispatch', steps: [
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load immediately.' },
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch directly.' },
  ] }, context);
  assert.deepEqual(direct, []);

  const mismatched = validatePlanProposal({ summary: 'Wrong vehicle', steps: [
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load.' },
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '9', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
  ] }, context);
  assert.ok(mismatched.some((error) => error.includes('vehicle from the preceding load')));
});

test('allows sequential resource reuse and rejects concurrent reserved weight', () => {
  const batches = [
    context.batches[0]!,
    { ...context.batches[0]!, id: '8', code: 'B-8', weightKg: 60 },
  ];
  const shared = { ...context, batches, vehicles: [{ ...context.vehicles[0]!, capacityKg: 60 }] };
  const proposal = { summary: 'Sequential trips', steps: [
    { actionType: 'LOAD' as const, batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load.' },
    { actionType: 'DISPATCH' as const, batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
    { actionType: 'LOAD' as const, batchId: '8', vehicleId: '2', scheduledAt: '2026-08-20T14:15:00.000Z', rationale: 'Reuse after arrival.' },
    { actionType: 'DISPATCH' as const, batchId: '8', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T14:30:00.000Z', rationale: 'Dispatch.' },
  ] };
  assert.deepEqual(validatePlanProposal(proposal, shared), []);
  const reserved = { ...shared, resourceOccupancies: [{ resourceType: 'VEHICLE' as const, resourceId: '2', batchId: '99', weightKg: 55, start: '2026-08-20T12:30:00.000Z', end: '2026-08-20T14:00:00.000Z' }] };
  assert.ok(validatePlanProposal(proposal, reserved).some((error) => error.includes('Vehicle Truck exceeds its 60 kg concurrent capacity')));
});

test('releases storage on load and enforces one store and load per batch', () => {
  const valid = validatePlanProposal({ summary: 'Stored journey', steps: [
    { actionType: 'STORE', batchId: '7', coldStorageId: '1', scheduledAt: '2026-08-20T12:30:00.000Z', rationale: 'Store.' },
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Release storage.' },
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
  ] }, { ...context, resourceOccupancies: [{ resourceType: 'COLD_STORAGE', resourceId: '1', batchId: '99', weightKg: 95, start: '2026-08-20T13:00:00.000Z', end: '2026-08-20T14:00:00.000Z' }] });
  assert.deepEqual(valid, []);

  const duplicate = validatePlanProposal({ summary: 'Duplicates', steps: [
    { actionType: 'STORE', batchId: '7', coldStorageId: '1', scheduledAt: '2026-08-20T12:15:00.000Z', rationale: 'Store.' },
    { actionType: 'STORE', batchId: '7', coldStorageId: '1', scheduledAt: '2026-08-20T12:30:00.000Z', rationale: 'Store again.' },
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load.' },
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:05:00.000Z', rationale: 'Load again.' },
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
  ] }, context);
  assert.ok(duplicate.some((error) => error.includes('stores a batch more than once')));
  assert.ok(duplicate.some((error) => error.includes('loads a batch more than once')));
});

test('uses a completed predecessor load as the unmatched load for dispatch', () => {
  const revised = { ...context, currentPlan: { id: '20', version: 1, summary: 'Old', destinationId: '3', deadline: context.deadline, steps: [
    { sequence: 1, actionType: 'LOAD' as const, batchId: '7', coldStorageId: null, vehicleId: '2', destinationId: null, scheduledAt: '2026-08-20T11:00:00.000Z', status: 'COMPLETED' as const, completedAt: '2026-08-20T11:05:00.000Z', rationale: null },
  ] }, resourceOccupancies: [{ resourceType: 'VEHICLE' as const, resourceId: '2', batchId: '7', weightKg: 10, start: '2026-08-20T11:00:00.000Z', end: null }] };
  assert.deepEqual(validatePlanProposal({ summary: 'Dispatch loaded batch', steps: [
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Continue the journey.' },
  ] }, revised), []);
});
