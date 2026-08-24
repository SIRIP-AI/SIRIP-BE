import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePlanningFacts, evaluatePlanQuality, parseAiPlanResult, validatePlanProposal, validateSensiblePlanProposal, type PlanningContext } from './plans';

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

const returnStep = (scheduledAt: string, vehicleId = '2', destinationId = '3') => ({ actionType: 'RETURN_TO_BASE' as const, vehicleId, destinationId, scheduledAt, rationale: 'Return to base.' });

test('parses proposal and no-valid-proposal results strictly', () => {
  assert.deepEqual(parseAiPlanResult('{"status":"NO_VALID_PROPOSAL_FOUND","reason":"No route"}'), { status: 'NO_VALID_PROPOSAL_FOUND', reason: 'No route' });
  assert.throws(() => parseAiPlanResult('{"status":"NO_VALID_PROPOSAL_FOUND","reason":"No route","steps":[]}'));
  assert.throws(() => parseAiPlanResult('{"status":"PROPOSAL","summary":"Legacy","steps":[{"actionType":"OTHER","batchId":"7","scheduledAt":"2026-08-20T13:00:00Z","rationale":"No"}]}'));
});

test('requires dispatch to the selected destination for every batch', () => {
  const errors = validatePlanProposal({ summary: 'Inspect only', steps: [{ actionType: 'INSPECT', batchId: '7', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Inspect.' }] }, context);
  assert.ok(errors.includes('Batch aktif 7 tidak dikirim ke tujuan yang dipilih'));
});

test('rejects another destination and arrival after the quality deadline', () => {
  const wrongDestination = validatePlanProposal({ summary: 'Wrong destination', steps: [{ actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T12:30:00.000Z', rationale: 'Load.' }, { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '4', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Dispatch.' }] }, context);
  assert.ok(wrongDestination.some((error) => error.includes('tidak menggunakan tujuan yang dipilih')));

  const expired = validatePlanProposal({ summary: 'Too late', steps: [{ actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-21T11:30:00.000Z', rationale: 'Load.' }, { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-21T12:00:00.000Z', rationale: 'Dispatch.' }] }, context);
  assert.ok(expired.some((error) => error.includes('tenggat mutu batch')));
});

test('rejects destination arrival after the plan deadline', () => {
  const errors = validatePlanProposal({ summary: 'Late arrival', steps: [{ actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-21T09:00:00.000Z', rationale: 'Load.' }, { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-21T09:30:00.000Z', rationale: 'Dispatch.' }] }, context);
  assert.ok(errors.some((error) => error.includes('tenggat rencana')));
});

test('requires dispatch to use the preceding load vehicle without forcing storage', () => {
  const direct = validatePlanProposal({ summary: 'Direct dispatch', steps: [
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load immediately.' },
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch directly.' },
    returnStep('2026-08-20T15:15:00.000Z'),
  ] }, context);
  assert.deepEqual(direct, []);

  const mismatched = validatePlanProposal({ summary: 'Wrong vehicle', steps: [
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load.' },
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '9', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
  ] }, context);
  assert.ok(mismatched.some((error) => error.includes('kendaraan dari pemuatan sebelumnya')));
});

test('requires exactly one return at the deterministic round-trip time', () => {
  const steps = [
    { actionType: 'LOAD' as const, batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load.' },
    { actionType: 'DISPATCH' as const, batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
  ];
  const late = validatePlanProposal({ summary: 'Late return', steps: [...steps, returnStep('2026-08-20T15:30:00.000Z')] }, context);
  assert.ok(late.some((error) => error.includes('tepat satu langkah RETURN_TO_BASE')));
  const duplicate = validatePlanProposal({ summary: 'Duplicate return', steps: [...steps, returnStep('2026-08-20T15:15:00.000Z'), returnStep('2026-08-20T15:15:00.000Z')] }, context);
  assert.ok(duplicate.some((error) => error.includes('menduplikasi kepulangan kendaraan')));
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
    returnStep('2026-08-20T15:15:00.000Z'),
    { actionType: 'LOAD' as const, batchId: '8', vehicleId: '2', scheduledAt: '2026-08-20T15:15:00.000Z', rationale: 'Reuse after return.' },
    { actionType: 'DISPATCH' as const, batchId: '8', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T15:30:00.000Z', rationale: 'Dispatch.' },
    returnStep('2026-08-20T17:30:00.000Z'),
  ] };
  assert.deepEqual(validatePlanProposal(proposal, shared), []);
  const reserved = { ...shared, resourceOccupancies: [{ resourceType: 'VEHICLE' as const, resourceId: '2', batchId: '99', weightKg: 55, start: '2026-08-20T12:30:00.000Z', end: '2026-08-20T14:00:00.000Z' }] };
  assert.ok(validatePlanProposal(proposal, reserved).some((error) => error.includes('Kendaraan Truck melampaui kapasitas bersamaan 60 kg')));
});

test('rejects an overlapping vehicle commitment even when capacity is sufficient', () => {
  const proposal = { summary: 'Conflicting trip', steps: [
    { actionType: 'LOAD' as const, batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load.' },
    { actionType: 'DISPATCH' as const, batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
    returnStep('2026-08-20T15:15:00.000Z'),
  ] };
  const reserved = { ...context, vehicles: [{ ...context.vehicles[0]!, capacityKg: 1_000 }], resourceOccupancies: [{ resourceType: 'VEHICLE' as const, resourceId: '2', batchId: '99', weightKg: 10, start: '2026-08-20T12:30:00.000Z', end: '2026-08-20T14:00:00.000Z', destinationId: '9', dispatchAt: '2026-08-20T12:45:00.000Z' }] };
  assert.ok(validatePlanProposal(proposal, reserved).some((error) => error.includes('perjalanan tumpang tindih yang tidak kompatibel')));
});

test('releases storage on load and enforces one store and load per batch', () => {
  const valid = validatePlanProposal({ summary: 'Stored journey', steps: [
    { actionType: 'STORE', batchId: '7', coldStorageId: '1', scheduledAt: '2026-08-20T12:30:00.000Z', rationale: 'Store.' },
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Release storage.' },
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
    returnStep('2026-08-20T15:15:00.000Z'),
  ] }, { ...context, resourceOccupancies: [{ resourceType: 'COLD_STORAGE', resourceId: '1', batchId: '99', weightKg: 95, start: '2026-08-20T13:00:00.000Z', end: '2026-08-20T14:00:00.000Z' }] });
  assert.deepEqual(valid, []);

  const duplicate = validatePlanProposal({ summary: 'Duplicates', steps: [
    { actionType: 'STORE', batchId: '7', coldStorageId: '1', scheduledAt: '2026-08-20T12:15:00.000Z', rationale: 'Store.' },
    { actionType: 'STORE', batchId: '7', coldStorageId: '1', scheduledAt: '2026-08-20T12:30:00.000Z', rationale: 'Store again.' },
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load.' },
    { actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T13:05:00.000Z', rationale: 'Load again.' },
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
  ] }, context);
  assert.ok(duplicate.some((error) => error.includes('menyimpan batch lebih dari satu kali')));
  assert.ok(duplicate.some((error) => error.includes('memuat batch lebih dari satu kali')));
});

test('uses a completed predecessor load as the unmatched load for dispatch', () => {
  const revised = { ...context, currentPlan: { id: '20', version: 1, summary: 'Old', destinationId: '3', deadline: context.deadline, steps: [
    { sequence: 1, actionType: 'LOAD' as const, batchId: '7', coldStorageId: null, vehicleId: '2', destinationId: null, scheduledAt: '2026-08-20T11:00:00.000Z', status: 'COMPLETED' as const, completedAt: '2026-08-20T11:05:00.000Z', rationale: null },
  ] }, resourceOccupancies: [{ resourceType: 'VEHICLE' as const, resourceId: '2', batchId: '7', weightKg: 10, start: '2026-08-20T11:00:00.000Z', end: null }] };
  assert.deepEqual(validatePlanProposal({ summary: 'Dispatch loaded batch', steps: [
    { actionType: 'DISPATCH', batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Continue the journey.' },
    returnStep('2026-08-20T15:00:00.000Z'),
  ] }, revised), []);
});

test('derives scarcity and rejects wasting the only capable vehicle when a validated alternative exists', () => {
  const scarceContext: PlanningContext = {
    ...context,
    deadline: '2026-08-22T10:00:00.000Z',
    batches: [
      { ...context.batches[0]!, id: '101', code: 'B-101', weightKg: 180, quality: { ...context.batches[0]!.quality!, remainingQualityWindowDays: 2 } },
      { ...context.batches[0]!, id: '102', code: 'B-102', weightKg: 420, quality: { ...context.batches[0]!.quality!, remainingQualityWindowDays: 2 } },
    ],
    vehicles: [
      { ...context.vehicles[0]!, id: '1', code: 'TR-01', capacityKg: 450 },
      { ...context.vehicles[0]!, id: '2', code: 'TR-02', capacityKg: 250 },
      { ...context.vehicles[0]!, id: '3', code: 'TR-03', capacityKg: 300 },
    ],
  };
  const bad = { summary: 'Waste TR-01', steps: [
    { actionType: 'LOAD' as const, batchId: '101', vehicleId: '1', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load.' },
    { actionType: 'DISPATCH' as const, batchId: '101', vehicleId: '1', destinationId: '3', scheduledAt: '2026-08-20T13:15:00.000Z', rationale: 'Dispatch.' },
    returnStep('2026-08-20T15:15:00.000Z', '1'),
    { actionType: 'LOAD' as const, batchId: '102', vehicleId: '1', scheduledAt: '2026-08-21T13:00:00.000Z', rationale: 'Wait.' },
    { actionType: 'DISPATCH' as const, batchId: '102', vehicleId: '1', destinationId: '3', scheduledAt: '2026-08-21T13:15:00.000Z', rationale: 'Dispatch tomorrow.' },
    returnStep('2026-08-21T15:15:00.000Z', '1'),
  ] };

  const facts = derivePlanningFacts(scarceContext);
  assert.equal(facts.batches.find(({ batchId }) => batchId === '102')?.resourceFlexibility, 'LOW');
  assert.deepEqual(validatePlanProposal(bad, scarceContext), []);
  assert.ok(evaluatePlanQuality(bad, scarceContext, facts).some(({ code }) => code === 'SCARCE_RESOURCE_MISALLOCATION'));
  assert.ok(validateSensiblePlanProposal(bad, scarceContext).some((error) => error.includes('SCARCE_RESOURCE_MISALLOCATION')));
});

test('rejects storage when removing it leaves the plan feasible', () => {
  const proposal = { summary: 'Unnecessary storage', steps: [
    { actionType: 'STORE' as const, batchId: '7', coldStorageId: '1', scheduledAt: '2026-08-20T12:01:00.000Z', rationale: 'Store.' },
    { actionType: 'LOAD' as const, batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T12:15:00.000Z', rationale: 'Load.' },
    { actionType: 'DISPATCH' as const, batchId: '7', vehicleId: '2', destinationId: '3', scheduledAt: '2026-08-20T12:30:00.000Z', rationale: 'Dispatch.' },
    returnStep('2026-08-20T14:30:00.000Z'),
  ] };
  assert.ok(evaluatePlanQuality(proposal, context).some(({ code }) => code === 'UNNECESSARY_STORAGE'));
});
