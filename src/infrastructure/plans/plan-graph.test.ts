import assert from 'node:assert/strict';
import test from 'node:test';

import { AIMessage, type BaseMessage } from '@langchain/core/messages';

import { validatePlanProposal, type PlanningContext } from '../../domain/plans/plans';
import { createPlanGraph } from './plan-graph';
import { deterministicSelectionSummary, parsePlanSelection, type PlanningModel } from './plan-generator';

const context: PlanningContext = {
  now: '2026-08-20T12:00:00.000Z',
  selectedDestinationId: '3',
  deadline: '2026-08-21T12:00:00.000Z',
  batches: [{ id: '7', code: 'B-7', weightKg: 10, grade: 'A', status: 'ACTIVE', quality: { equivalentQualityAgeDays: 1, remainingQualityWindowDays: 2, qualityEstimateStartedAt: '2026-08-20T00:00:00.000Z', currentTemperatureC: 2 }, telemetry: [] }],
  coldStorages: [],
  vehicles: [{ id: '2', code: 'Truck', capacityKg: 100, operationalStatus: 'AVAILABLE', delayMinutes: 0, delayPersistent: false, restriction: null, availabilityIntervals: null }],
  destinations: [{ id: '3', name: 'Port', address: 'A', travelMinutes: 10, receivingIntervals: [{ start: '2026-08-20T12:30:00.000Z', end: '2026-08-20T15:00:00.000Z' }], status: 'AVAILABLE', notes: null }],
  currentPlan: null,
};

function graph(model: PlanningModel, loadContext = async () => context) {
  return createPlanGraph({ repository: { loadContext }, model: () => model, validate: validatePlanProposal });
}

test('LangGraph asks the model to select an immutable deterministic candidate', async () => {
  let prompt = '';
  const model = { invoke: async (messages: BaseMessage[]) => {
    prompt = messages.map((message) => String(message.content)).join('\n');
    return new AIMessage(JSON.stringify({ candidateId: 'candidate-2' }));
  } } as PlanningModel;
  const result = await graph(model).invoke({ userId: '1', batchIds: ['7'], destinationId: '3', deadline: context.deadline, planId: null, instruction: 'Depart a little later' });
  assert.equal(result.result?.status === 'PROPOSAL' ? result.result.summary : null, 'Deterministic physically valid logistics plan');
  assert.match(prompt, /Depart a little later/);
  assert.match(prompt, /candidate-2/);
});

test('LangGraph falls back to the first candidate when selector output is invalid', async () => {
  const model = { invoke: async () => new AIMessage('not json') } as unknown as PlanningModel;
  const result = await graph(model).invoke({ userId: '1', batchIds: ['7'], destinationId: '3', deadline: context.deadline, planId: null, instruction: null });
  assert.equal(result.result?.status, 'PROPOSAL');
  assert.equal(result.result?.status === 'PROPOSAL' ? result.result.summary : null, 'Deterministic physically valid logistics plan');
});

for (const [name, invoke] of [
  ['provider timeout', async () => { throw new Error('request timeout'); }],
  ['unknown candidate', async () => new AIMessage(JSON.stringify({ candidateId: 'invented' }))],
] as const) {
  test(`LangGraph falls back deterministically after ${name}`, async () => {
    const result = await graph({ invoke } as unknown as PlanningModel).invoke({ userId: '1', batchIds: ['7'], destinationId: '3', deadline: context.deadline, planId: null, instruction: null });
    assert.equal(result.result?.status, 'PROPOSAL');
    assert.equal(result.result?.status === 'PROPOSAL' ? result.result.summary : null, 'Deterministic physically valid logistics plan');
  });
}

test('LangGraph skips the model when deterministic planning finds no candidate', async () => {
  let calls = 0;
  const model = { invoke: async () => { calls += 1; return new AIMessage('{}'); } } as unknown as PlanningModel;
  const impossible = { ...context, vehicles: [{ ...context.vehicles[0]!, capacityKg: 1 }] };
  const result = await graph(model, async () => impossible).invoke({ userId: '1', batchIds: ['7'], destinationId: '3', deadline: context.deadline, planId: null, instruction: null });
  assert.equal(result.result?.status, 'NO_VALID_PROPOSAL_FOUND');
  assert.equal(calls, 0);
});

test('LangGraph replaces a stale selection with a candidate from refreshed state', async () => {
  let loads = 0;
  const refreshed = { ...context, vehicles: [{ ...context.vehicles[0]!, id: '4', code: 'Fresh truck' }] };
  const model = { invoke: async () => new AIMessage(JSON.stringify({ candidateId: 'candidate-1' })) } as unknown as PlanningModel;
  const result = await graph(model, async () => ++loads === 1 ? context : refreshed).invoke({ userId: '1', batchIds: ['7'], destinationId: '3', deadline: context.deadline, planId: null, instruction: null });
  assert.equal(result.result?.status, 'PROPOSAL');
  assert.equal(result.result?.status === 'PROPOSAL' ? result.result.steps.find(({ actionType }: { actionType: string }) => actionType === 'LOAD')?.vehicleId : null, '4');
});

test('selector rejects hallucinated summary fields and deterministic revision summary preserves exact vehicle roles', () => {
  const proposal = { summary: 'Deterministic feasible logistics plan', steps: [{ actionType: 'LOAD' as const, batchId: '7', vehicleId: '3', scheduledAt: '2026-08-20T13:00:00.000Z', rationale: 'Load on configured replacement.' }] };
  assert.throws(() => parsePlanSelection(JSON.stringify({ candidateId: 'candidate-1', summary: 'TR-03 was delayed' }), [{ id: 'candidate-1', proposal }]));
  const revisionContext: PlanningContext = {
    ...context,
    vehicles: [{ ...context.vehicles[0]!, id: '1', code: 'TR-01' }, { ...context.vehicles[0]!, id: '3', code: 'TR-03' }],
    currentPlan: { id: '9', version: 1, summary: 'Current plan', destinationId: '3', destinationIds: ['3'], deadline: context.deadline, steps: [{ sequence: 1, actionType: 'LOAD', batchId: '7', coldStorageId: null, vehicleId: '1', destinationId: null, scheduledAt: '2026-08-20T12:30:00.000Z', status: 'UPCOMING', completedAt: null, rationale: null }] },
  };
  const summary = deterministicSelectionSummary(proposal, revisionContext, 'TR-01 delayed 30 minutes.');
  assert.match(summary, /TR-01 delayed 30 minutes/);
  assert.match(summary, /Vehicles: TR-01 -> TR-03/);
  assert.doesNotMatch(summary, /TR-03 was delayed/);
});
