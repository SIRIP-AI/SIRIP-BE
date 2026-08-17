import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidPlanProposalError, parseAiPlanProposal, type PlanningContext, validatePlanProposal } from './plans';

function context(): PlanningContext {
  return {
    now: '2026-08-17T08:00:00.000Z',
    batches: [{
      id: '1',
      code: 'B-017',
      weightKg: 120,
      grade: 'A',
      status: 'ACTIVE',
      quality: {
        equivalentQualityAgeDays: 7.8,
        remainingQualityWindowDays: 4.2,
        qualityEstimateStartedAt: '2026-08-16T00:00:00.000Z',
        currentTemperatureC: 8,
      },
      telemetry: [{ temperatureC: 8, measuredAt: '2026-08-17T07:45:00.000Z', receivedAt: '2026-08-17T07:45:05.000Z' }],
    }],
    coldStorages: [{ id: '2', name: 'Cold Room 1', capacityKg: 500, availableCapacityKg: 220, operationalStatus: 'AVAILABLE' }],
    vehicles: [{ id: '3', code: 'TR-02', capacityKg: 800, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: 'Bridge restriction', availabilityStart: '08:00', availabilityEnd: '16:00' }],
    destinations: [{ id: '4', name: 'Processor A', address: 'Port', travelMinutes: 45, receivingStart: '08:00', receivingEnd: '16:00', status: 'AVAILABLE', notes: 'Call before dispatch' }],
    activePlan: null,
  };
}

const validProposal = {
  reason: 'Prioritize the batch with the lowest remaining quality window.',
  steps: [
    { actionType: 'STORE' as const, batchId: '1', coldStorageId: '2', scheduledAt: '2026-08-17T09:00:00.000Z' },
    { actionType: 'LOAD' as const, batchId: '1', vehicleId: '3', scheduledAt: '2026-08-17T10:00:00.000Z' },
    { actionType: 'DISPATCH' as const, batchId: '1', destinationId: '4', scheduledAt: '2026-08-17T11:00:00.000Z' },
  ],
};

test('parses strict structured AI proposals', () => {
  assert.deepEqual(parseAiPlanProposal(JSON.stringify(validProposal)), validProposal);
  assert.throws(() => parseAiPlanProposal('{"reason":"x","steps":[],"extra":true}'), InvalidPlanProposalError);
  assert.throws(() => parseAiPlanProposal('{"reason":"x","steps":[{"actionType":"STORE","batchId":"0","scheduledAt":"soon"}]}'), InvalidPlanProposalError);
});

test('accepts a feasible proposal', () => {
  assert.deepEqual(validatePlanProposal(validProposal, context()), []);
});

test('rejects unscoped resources, unavailable capacity, delayed vehicles, receiving windows, missing quality, and uncovered batches', () => {
  const state = context();
  state.batches[0]!.quality = null;
  state.batches.push({ ...state.batches[0]!, id: '5', code: 'B-018', quality: { equivalentQualityAgeDays: 2, remainingQualityWindowDays: 10, qualityEstimateStartedAt: '2026-08-16T00:00:00.000Z', currentTemperatureC: 2 } });
  state.coldStorages[0]!.availableCapacityKg = 100;
  state.vehicles[0]!.delayMinutes = 240;
  state.destinations[0]!.receivingEnd = '12:00';
  const invalid = {
    reason: 'Invalid plan',
    steps: [
      { actionType: 'STORE' as const, batchId: '1', coldStorageId: '2', scheduledAt: '2026-08-17T09:00:00.000Z' },
      { actionType: 'LOAD' as const, batchId: '1', vehicleId: '99', scheduledAt: '2026-08-17T09:30:00.000Z' },
      { actionType: 'LOAD' as const, batchId: '1', vehicleId: '3', scheduledAt: '2026-08-17T11:00:00.000Z' },
      { actionType: 'DISPATCH' as const, batchId: '1', destinationId: '4', scheduledAt: '2026-08-17T11:30:00.000Z' },
    ],
  };
  const errors = validatePlanProposal(invalid, state).join('\n');
  assert.match(errors, /no quality state/);
  assert.match(errors, /cold-storage capacity/);
  assert.match(errors, /unconfigured vehicle/);
  assert.match(errors, /vehicle delay/);
  assert.match(errors, /destination receiving window/);
  assert.match(errors, /Active batch 5 is not covered/);
});

test('rejects aggregate cold-storage and vehicle overbooking without double-counting repeated assignments', () => {
  const state = context();
  state.batches[0]!.weightKg = 120;
  state.batches.push({ ...state.batches[0]!, id: '5', code: 'B-018', weightKg: 120 });
  state.coldStorages[0]!.availableCapacityKg = 200;
  state.vehicles[0]!.capacityKg = 200;
  const errors = validatePlanProposal({
    reason: 'Group compatible batches.',
    steps: [
      { actionType: 'STORE', batchId: '1', coldStorageId: '2', scheduledAt: '2026-08-17T09:00:00.000Z' },
      { actionType: 'STORE', batchId: '1', coldStorageId: '2', scheduledAt: '2026-08-17T09:15:00.000Z' },
      { actionType: 'STORE', batchId: '5', coldStorageId: '2', scheduledAt: '2026-08-17T09:30:00.000Z' },
      { actionType: 'LOAD', batchId: '1', vehicleId: '3', scheduledAt: '2026-08-17T10:00:00.000Z' },
      { actionType: 'LOAD', batchId: '1', vehicleId: '3', scheduledAt: '2026-08-17T10:15:00.000Z' },
      { actionType: 'LOAD', batchId: '5', vehicleId: '3', scheduledAt: '2026-08-17T10:30:00.000Z' },
    ],
  }, state);
  assert.equal(errors.filter((error) => error === 'Cold storage 2 is overbooked').length, 1);
  assert.equal(errors.filter((error) => error === 'Vehicle 3 is overbooked').length, 1);
  const repeatedOnly = validatePlanProposal({
    reason: 'Repeat one batch assignment without duplicate capacity.',
    steps: [
      { actionType: 'STORE', batchId: '1', coldStorageId: '2', scheduledAt: '2026-08-17T09:00:00.000Z' },
      { actionType: 'STORE', batchId: '1', coldStorageId: '2', scheduledAt: '2026-08-17T09:15:00.000Z' },
      { actionType: 'LOAD', batchId: '1', vehicleId: '3', scheduledAt: '2026-08-17T10:00:00.000Z' },
      { actionType: 'LOAD', batchId: '1', vehicleId: '3', scheduledAt: '2026-08-17T10:15:00.000Z' },
      { actionType: 'INSPECT', batchId: '5', scheduledAt: '2026-08-17T10:30:00.000Z' },
    ],
  }, state);
  assert.equal(repeatedOnly.some((error) => error.includes('overbooked')), false);
});

test('rejects legacy dispatch vehicle combinations', () => {
  const invalid = { ...validProposal, steps: [{ actionType: 'DISPATCH' as const, batchId: '1', vehicleId: '3', destinationId: '4', scheduledAt: '2026-08-17T11:00:00.000Z' }] };
  assert.match(validatePlanProposal(invalid, context()).join('\n'), /illegal action\/resource combination/);
});
