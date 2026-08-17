import assert from 'node:assert/strict';
import test from 'node:test';

import { activePlanSnapshot, type AiPlanProposal, type PlanList, type PlanningContext, type PlanView } from '../domain/plans';
import { PlanService, type PlanRepositoryPort } from './plan-service';

const proposal: AiPlanProposal = {
  reason: 'Keep the batch cold.',
  steps: [{ actionType: 'INSPECT', batchId: '1', scheduledAt: '2026-08-17T09:00:00.000Z' }],
};

const view: PlanView = {
  id: '7',
  version: 2,
  status: 'PROPOSED',
  previousPlanId: '6',
  reason: proposal.reason,
  createdAt: '2026-08-17T08:00:00.000Z',
  approvedAt: null,
  trigger: null,
  steps: [],
};

function context(): PlanningContext {
  return {
    now: '2026-08-17T08:00:00.000Z',
    batches: [{
      id: '1',
      code: 'B-017',
      weightKg: 100,
      grade: 'A',
      status: 'ACTIVE',
      quality: { equivalentQualityAgeDays: 1, remainingQualityWindowDays: 11, qualityEstimateStartedAt: '2026-08-16T00:00:00.000Z', currentTemperatureC: 2 },
      telemetry: [],
    }],
    coldStorages: [{ id: '2', name: 'Cold Room', capacityKg: 500, availableCapacityKg: 500, operationalStatus: 'AVAILABLE' }],
    vehicles: [{ id: '3', code: 'TR-01', capacityKg: 500, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: null, availabilityStart: null, availabilityEnd: null }],
    destinations: [{ id: '4', name: 'Processor', address: 'Port', travelMinutes: 30, receivingStart: '08:00', receivingEnd: '16:00', status: 'AVAILABLE', notes: null }],
    activePlan: { id: '6', version: 1, reason: 'Current', steps: [] },
  };
}

function fakeRepository(calls: string[]): PlanRepositoryPort {
  return {
    async list(): Promise<PlanList> { throw new Error('not used'); },
    async loadContext() { calls.push('context'); return context(); },
    async saveProposal(_userId, value, activePlan) { calls.push(`save:${activePlan?.id ?? null}:${value.reason}`); return view; },
    async activateProposal(_userId, _planId, validate) {
      calls.push('activate');
      const errors = validate(proposal, context());
      calls.push(`atomic-validation:${errors.length}`);
      return { ...view, status: 'ACTIVE' };
    },
    async dismissProposal() { throw new Error('not used'); },
    async completeStep() { throw new Error('not used'); },
  };
}

test('repairs one deterministically invalid proposal and persists only the valid repair', async () => {
  const calls: string[] = [];
  const repaired = { ...proposal, reason: 'Repaired feasible plan.' };
  let generatorCalls = 0;
  const service = new PlanService(fakeRepository(calls), async (_context, feedback) => {
    generatorCalls += 1;
    if (generatorCalls === 1) {
      assert.equal(feedback, undefined);
      return proposal;
    }
    assert.deepEqual(feedback, { validationErrors: ['capacity exceeded'] });
    return repaired;
  }, (value) => value.reason === proposal.reason ? ['capacity exceeded'] : []);
  const saved = await service.generateProposal(1n);
  assert.equal(saved, view);
  assert.equal(generatorCalls, 2);
  assert.deepEqual(calls, ['context', 'context', 'context', 'save:6:Repaired feasible plan.']);
});

test('does not persist after one failed deterministic repair', async () => {
  const calls: string[] = [];
  let generatorCalls = 0;
  const service = new PlanService(fakeRepository(calls), async (_context, feedback) => {
    generatorCalls += 1;
    if (generatorCalls === 2) assert.deepEqual(feedback, { validationErrors: ['invalid'] });
    return proposal;
  }, () => ['invalid']);
  await assert.rejects(service.generateProposal(1n), /infeasible/);
  assert.equal(generatorCalls, 2);
  assert.deepEqual(calls, ['context', 'context', 'context']);
});

test('regenerates once against a changed active plan snapshot', async () => {
  const calls: string[] = [];
  const repository = fakeRepository(calls);
  const initial = context();
  const changed = { ...context(), activePlan: { ...context().activePlan!, version: 2, reason: 'Changed active plan' } };
  const contexts = [initial, changed, changed];
  repository.loadContext = async () => contexts.shift()!;
  repository.saveProposal = async (_userId, value, expected) => {
    calls.push(`save:${expected?.version}:${value.reason}`);
    assert.equal(activePlanSnapshot(expected), activePlanSnapshot(changed.activePlan));
    return view;
  };
  let generatorCalls = 0;
  const service = new PlanService(repository, async (state, repair) => {
    generatorCalls += 1;
    if (generatorCalls === 1) assert.equal(state.activePlan?.version, 1);
    else {
      assert.equal(state.activePlan?.version, 2);
      assert.deepEqual(repair, { validationErrors: ['Active plan changed during generation'] });
    }
    return { ...proposal, reason: `Attempt ${generatorCalls}` };
  }, () => []);
  await service.generateProposal(1n);
  assert.equal(generatorCalls, 2);
  assert.deepEqual(calls, ['save:2:Attempt 2']);
});

test('rejects a second active plan snapshot change without persisting', async () => {
  const calls: string[] = [];
  const repository = fakeRepository(calls);
  const states = [
    context(),
    { ...context(), activePlan: { ...context().activePlan!, version: 2 } },
    { ...context(), activePlan: { ...context().activePlan!, version: 2, steps: [{ sequence: 1, actionType: 'INSPECT' as const, batchId: '1', coldStorageId: null, vehicleId: null, destinationId: null, scheduledAt: '2026-08-17T08:30:00.000Z', status: 'COMPLETED' as const, completedAt: '2026-08-17T08:31:00.000Z', notes: null }] } },
  ];
  repository.loadContext = async () => states.shift()!;
  let generatorCalls = 0;
  const service = new PlanService(repository, async () => { generatorCalls += 1; return proposal; }, () => []);
  await assert.rejects(service.generateProposal(1n), (error) => error instanceof Error && 'status' in error && error.status === 409);
  assert.equal(generatorCalls, 2);
  assert.deepEqual(calls, []);
});

test('delegates approval validation to atomic activation', async () => {
  const calls: string[] = [];
  const service = new PlanService(fakeRepository(calls), async () => proposal, (value, state) => {
    calls.push(`validate:${value.reason}:${state.activePlan?.id}`);
    return [];
  });
  const active = await service.approve(1n, 7n);
  assert.equal(active.status, 'ACTIVE');
  assert.deepEqual(calls, ['activate', 'validate:Keep the batch cold.:6', 'atomic-validation:0']);
});

test('does not call the provider when planning preconditions fail', async () => {
  const base = context();
  const invalidContexts: PlanningContext[] = [
    { ...base, batches: [] },
    { ...base, batches: Array.from({ length: 101 }, (_, index) => ({ ...base.batches[0]!, id: `${index + 1}`, code: `B-${index + 1}` })) },
    { ...base, batches: [{ ...base.batches[0]!, quality: null }] },
    { ...base, coldStorages: [{ ...base.coldStorages[0]!, operationalStatus: 'UNAVAILABLE' }] },
    { ...base, vehicles: [{ ...base.vehicles[0]!, operationalStatus: 'UNAVAILABLE' }] },
    { ...base, destinations: [{ ...base.destinations[0]!, status: 'UNAVAILABLE' }] },
  ];
  for (const state of invalidContexts) {
    const repository = fakeRepository([]);
    repository.loadContext = async () => state;
    let generated = false;
    const service = new PlanService(repository, async () => { generated = true; return proposal; }, () => []);
    await assert.rejects(service.generateProposal(1n));
    assert.equal(generated, false);
  }
});

test('rechecks planning preconditions after generation', async () => {
  const calls: string[] = [];
  const repository = fakeRepository(calls);
  let loads = 0;
  repository.loadContext = async () => {
    loads += 1;
    return loads === 1 ? context() : { ...context(), destinations: [] };
  };
  const service = new PlanService(repository, async () => proposal, () => []);
  await assert.rejects(service.generateProposal(1n), /available destination/);
  assert.equal(loads, 2);
});

test('delegates active-step completion to persistence', async () => {
  const repository = fakeRepository([]);
  let completed: [bigint, bigint, bigint] | undefined;
  repository.completeStep = async (...ids) => { completed = ids; return { ...view, status: 'ACTIVE' }; };
  const service = new PlanService(repository, async () => proposal, () => []);
  assert.equal((await service.completeStep(1n, 7n, 9n)).status, 'ACTIVE');
  assert.deepEqual(completed, [1n, 7n, 9n]);
});
