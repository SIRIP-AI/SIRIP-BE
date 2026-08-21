import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAiPlanResult, validatePlanProposal, type PlanningContext } from './plans';

const context: PlanningContext = {
  now: '2026-08-20T12:00:00.000Z',
  selectedDestinationId: '3',
  deadline: '2026-08-21T10:00:00.000Z',
  batches: [{ id: '7', code: 'B-7', weightKg: 10, grade: 'A', status: 'ACTIVE', quality: { equivalentQualityAgeDays: 1, remainingQualityWindowDays: 1, qualityEstimateStartedAt: '2026-08-20T00:00:00.000Z', currentTemperatureC: 2 }, telemetry: [] }],
  coldStorages: [{ id: '1', name: 'Cold', capacityKg: 100, availableCapacityKg: 100, operationalStatus: 'AVAILABLE' }],
  vehicles: [{ id: '2', code: 'Truck', capacityKg: 100, operationalStatus: 'AVAILABLE', delayMinutes: 0, delayPersistent: false, restriction: null, availabilityStart: null, availabilityEnd: null }],
  destinations: [{ id: '3', name: 'Port', address: 'A', travelMinutes: 60, receivingStart: '00:00', receivingEnd: '23:59', status: 'AVAILABLE', notes: null }, { id: '4', name: 'Other', address: 'B', travelMinutes: 0, receivingStart: '00:00', receivingEnd: '23:59', status: 'AVAILABLE', notes: null }],
  currentPlan: null,
};

test('parses feasible and infeasible planning results strictly', () => {
  assert.deepEqual(parseAiPlanResult('{"status":"INFEASIBLE","reason":"No route"}'), { status: 'INFEASIBLE', reason: 'No route' });
  assert.throws(() => parseAiPlanResult('{"status":"INFEASIBLE","reason":"No route","steps":[]}'));
});

test('requires dispatch to the selected destination for every batch', () => {
  const errors = validatePlanProposal({ reason: 'Inspect only', steps: [{ actionType: 'INSPECT', batchId: '7', scheduledAt: '2026-08-20T13:00:00.000Z' }] }, context);
  assert.ok(errors.includes('Active batch 7 is not dispatched to the selected destination'));
});

test('rejects another destination and arrival after the quality deadline', () => {
  const wrongDestination = validatePlanProposal({ reason: 'Wrong destination', steps: [{ actionType: 'DISPATCH', batchId: '7', destinationId: '4', scheduledAt: '2026-08-20T13:00:00.000Z' }] }, context);
  assert.ok(wrongDestination.some((error) => error.includes('does not use the selected destination')));

  const expired = validatePlanProposal({ reason: 'Too late', steps: [{ actionType: 'DISPATCH', batchId: '7', destinationId: '3', scheduledAt: '2026-08-21T12:00:00.000Z' }] }, context);
  assert.ok(expired.some((error) => error.includes('quality deadline')));
});

test('rejects destination arrival after the plan deadline', () => {
  const errors = validatePlanProposal({ reason: 'Late arrival', steps: [{ actionType: 'DISPATCH', batchId: '7', destinationId: '3', scheduledAt: '2026-08-21T09:30:00.000Z' }] }, context);
  assert.ok(errors.some((error) => error.includes('plan deadline')));
});
