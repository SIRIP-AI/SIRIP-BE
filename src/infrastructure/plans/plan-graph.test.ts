import assert from 'node:assert/strict';
import test from 'node:test';

import { AIMessage, type BaseMessage } from '@langchain/core/messages';

import type { PlanningContext } from '../../domain/plans/plans';
import { createPlanGraph } from './plan-graph';
import type { PlanningModel } from './plan-generator';

const context: PlanningContext = {
  now: '2026-08-20T12:00:00.000Z',
  selectedDestinationId: null,
  deadline: null,
  batches: [{ id: '7', code: 'B-7', weightKg: 10, grade: 'A', status: 'ACTIVE', quality: { equivalentQualityAgeDays: 1, remainingQualityWindowDays: 5, qualityEstimateStartedAt: '2026-08-20T00:00:00.000Z', currentTemperatureC: 2 }, telemetry: [] }],
  coldStorages: [{ id: '1', name: 'Cold', capacityKg: 100, availableCapacityKg: 100, operationalStatus: 'AVAILABLE' }],
  vehicles: [{ id: '2', code: 'Truck', capacityKg: 100, operationalStatus: 'AVAILABLE', delayMinutes: 0, delayPersistent: false, restriction: null, availabilityStart: null, availabilityEnd: null }],
  destinations: [{ id: '3', name: 'Port', address: 'A', travelMinutes: 10, receivingStart: '00:00', receivingEnd: '23:59', status: 'AVAILABLE', notes: null }],
  currentPlan: { id: '10', version: 1, reason: 'Current', deadline: '2026-08-25T12:00:00.000Z', steps: [] },
};

function text(messages: BaseMessage[]) {
  return messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n');
}

test('LangGraph repairs parser and validation failures without dropping the revision instruction', async () => {
  const outputs = [
    'not json',
    JSON.stringify({ status: 'FEASIBLE', reason: 'Infeasible', steps: [{ actionType: 'INSPECT', batchId: '7', scheduledAt: '2026-08-21T10:00:00.000Z' }] }),
    JSON.stringify({ status: 'FEASIBLE', reason: 'Repaired', steps: [{ actionType: 'INSPECT', batchId: '7', scheduledAt: '2026-08-21T11:00:00.000Z' }] }),
  ];
  const prompts: string[] = [];
  const model = { invoke: async (messages: BaseMessage[]) => {
    prompts.push(text(messages));
    return new AIMessage(outputs.shift()!);
  } } as PlanningModel;
  const graph = createPlanGraph({
    repository: { loadContext: async () => context },
    model: () => model,
    validate: (proposal) => proposal.reason === 'Infeasible' ? ['Use a feasible schedule'] : [],
  });

  const result = await graph.invoke({ userId: '1', batchIds: ['7'], destinationId: null, deadline: '2026-08-25T12:00:00.000Z', planId: '10', instruction: 'Move dispatch later' });

  assert.equal(result.result?.reason, 'Repaired');
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every((prompt) => prompt.includes('Move dispatch later')));
  assert.ok(prompts.every((prompt) => prompt.includes('2026-08-25T12:00:00.000Z')));
  assert.match(prompts[1]!, /strict JSON contract/);
  assert.match(prompts[2]!, /Use a feasible schedule/);
});

test('LangGraph returns a valid infeasible result without persisting a partial proposal', async () => {
  const model = { invoke: async () => new AIMessage(JSON.stringify({ status: 'INFEASIBLE', reason: 'No receiving window is reachable.' })) } as unknown as PlanningModel;
  const graph = createPlanGraph({ repository: { loadContext: async () => context }, model: () => model, validate: () => { throw new Error('Infeasible results are not proposals'); } });

  const result = await graph.invoke({ userId: '1', batchIds: ['7'], destinationId: '3', deadline: '2026-08-25T12:00:00.000Z', planId: null, instruction: null });

  assert.deepEqual(result.result, { status: 'INFEASIBLE', reason: 'No receiving window is reachable.' });
});
