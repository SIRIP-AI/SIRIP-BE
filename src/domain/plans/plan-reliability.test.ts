import assert from 'node:assert/strict';
import test from 'node:test';

import { generatePlanCandidates } from './plan-candidates';
import { derivePlanningFacts, validateApprovablePlanProposal, type PlanningContext } from './plans';

const baseline: PlanningContext = {
  now: '2026-08-20T12:00:00.000Z',
  selectedDestinationId: '3',
  deadline: '2026-08-21T12:00:00.000Z',
  batches: [{ id: '7', code: 'B-7', weightKg: 50, grade: 'A', status: 'ACTIVE', quality: { equivalentQualityAgeDays: 1, remainingQualityWindowDays: 2, qualityEstimateStartedAt: '2026-08-20T00:00:00.000Z', currentTemperatureC: 2 }, telemetry: [] }],
  coldStorages: [],
  vehicles: [{ id: '2', code: 'TR-2', capacityKg: 100, operationalStatus: 'AVAILABLE', delayMinutes: 0, delayPersistent: false, restriction: null, availabilityIntervals: [{ start: '2026-08-20T12:00:00.000Z', end: '2026-08-20T18:00:00.000Z' }] }],
  destinations: [{ id: '3', name: 'Port', address: 'A', travelMinutes: 30, receivingIntervals: [{ start: '2026-08-20T13:00:00.000Z', end: '2026-08-20T18:00:00.000Z' }], status: 'AVAILABLE', notes: null }],
  currentPlan: null,
};

type Scenario = { name: string; context: PlanningContext; feasible: boolean };
const scenarios: Scenario[] = [
  ...[0, 15, 30, 45, 60, 75, 90, 105, 120].map((delayMinutes) => ({ name: `vehicle delay ${delayMinutes} minutes`, context: { ...baseline, vehicles: [{ ...baseline.vehicles[0]!, delayMinutes }] }, feasible: true })),
  ...[15, 30, 45, 60, 75].map((travelMinutes) => ({ name: `destination travel ${travelMinutes} minutes`, context: { ...baseline, destinations: [{ ...baseline.destinations[0]!, travelMinutes }] }, feasible: true })),
  ...[50, 60, 75, 100, 200].map((capacityKg) => ({ name: `vehicle capacity ${capacityKg} kg`, context: { ...baseline, vehicles: [{ ...baseline.vehicles[0]!, capacityKg }] }, feasible: true })),
  { name: 'second vehicle provides alternatives', context: { ...baseline, vehicles: [...baseline.vehicles, { ...baseline.vehicles[0]!, id: '4', code: 'TR-4' }] }, feasible: true },
  { name: 'two batches reuse one vehicle sequentially', context: { ...baseline, batches: [...baseline.batches, { ...baseline.batches[0]!, id: '8', code: 'B-8' }] }, feasible: true },
  { name: 'later vehicle window remains reachable', context: { ...baseline, vehicles: [{ ...baseline.vehicles[0]!, availabilityIntervals: [{ start: '2026-08-20T14:00:00.000Z', end: '2026-08-20T18:00:00.000Z' }] }] }, feasible: true },
  { name: 'completed load continues directly to dispatch', context: { ...baseline, currentPlan: { id: '10', version: 1, summary: 'Loaded', destinationId: '3', deadline: baseline.deadline, steps: [{ sequence: 1, actionType: 'LOAD', batchId: '7', coldStorageId: null, vehicleId: '2', destinationId: null, scheduledAt: '2026-08-20T11:30:00.000Z', status: 'COMPLETED', completedAt: '2026-08-20T11:45:00.000Z', rationale: null }] }, resourceOccupancies: [{ resourceType: 'VEHICLE', resourceId: '2', batchId: '7', weightKg: 50, start: '2026-08-20T11:30:00.000Z', end: null }] }, feasible: true },
  { name: 'existing reservation ends before dispatch', context: { ...baseline, resourceOccupancies: [{ resourceType: 'VEHICLE', resourceId: '2', batchId: '9', weightKg: 100, start: '2026-08-20T11:00:00.000Z', end: '2026-08-20T12:30:00.000Z' }] }, feasible: true },
  { name: 'tight but reachable quality window', context: { ...baseline, batches: [{ ...baseline.batches[0]!, quality: { ...baseline.batches[0]!.quality!, remainingQualityWindowDays: 0.2 } }] }, feasible: true },
  { name: 'insufficient capacity', context: { ...baseline, vehicles: [{ ...baseline.vehicles[0]!, capacityKg: 49 }] }, feasible: false },
  { name: 'unavailable vehicle', context: { ...baseline, vehicles: [{ ...baseline.vehicles[0]!, operationalStatus: 'UNAVAILABLE' }] }, feasible: false },
  { name: 'deadline before reachable arrival', context: { ...baseline, deadline: '2026-08-20T12:10:00.000Z' }, feasible: true },
  { name: 'receiving window already passed', context: { ...baseline, destinations: [{ ...baseline.destinations[0]!, receivingIntervals: [{ start: '2026-08-20T10:00:00.000Z', end: '2026-08-20T11:00:00.000Z' }] }] }, feasible: false },
  { name: 'vehicle fully reserved through receiving window', context: { ...baseline, resourceOccupancies: [{ resourceType: 'VEHICLE', resourceId: '2', batchId: '9', weightKg: 100, start: '2026-08-20T12:00:00.000Z', end: '2026-08-20T20:00:00.000Z' }] }, feasible: false },
];

assert.equal(scenarios.length, 30);

for (const scenario of scenarios) {
  test(`planning scenario: ${scenario.name}`, () => {
    const candidates = generatePlanCandidates(scenario.context, derivePlanningFacts(scenario.context));
    assert.equal(candidates.length > 0, scenario.feasible);
    for (const candidate of candidates) {
      assert.deepEqual(validateApprovablePlanProposal(candidate.proposal, scenario.context), []);
      assert.ok(candidate.proposal.steps.every((step) => step.rationale && step.timingRationale && step.latestSafeAt && Date.parse(step.latestSafeAt) >= Date.parse(step.scheduledAt)));
    }
  });
}
