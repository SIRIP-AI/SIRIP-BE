import assert from 'node:assert/strict';
import test from 'node:test';

import { PlanService, type PlanRepositoryPort } from './plan-service';
import type { AiPlanProposal, PlanningContext, PlanView } from '../../domain/plans/plans';
import { RequestError } from '../../domain/errors';

const step = { actionType: 'INSPECT' as const, batchId: '7', scheduledAt: '2026-08-21T10:00:00.000Z', rationale: 'Inspection hold requires review.' };
const deadline = '2026-08-25T12:00:00.000Z';
const currentPlan = { id: '10', version: 1, summary: 'Current', destinationId: '3', deadline, steps: [{ sequence: 1, ...step, status: 'COMPLETED' as const, completedAt: '2026-08-20T10:00:00.000Z', coldStorageId: null, vehicleId: null, destinationId: null }] };
const context: PlanningContext = {
  now: '2026-08-20T12:00:00.000Z',
  selectedDestinationId: '3',
  deadline,
  batches: [{ id: '7', code: 'B-7', weightKg: 10, grade: 'A', status: 'ACTIVE', quality: { equivalentQualityAgeDays: 1, remainingQualityWindowDays: 5, qualityEstimateStartedAt: '2026-08-20T00:00:00.000Z', currentTemperatureC: 2 }, telemetry: [] }],
  coldStorages: [{ id: '1', name: 'Cold', capacityKg: 100, availableCapacityKg: 100, operationalStatus: 'AVAILABLE' }],
  vehicles: [{ id: '2', code: 'Truck', capacityKg: 100, operationalStatus: 'AVAILABLE', delayMinutes: 0, delayPersistent: false, restriction: null, availabilityIntervals: null }],
  destinations: [{ id: '3', name: 'Port', address: 'A', travelMinutes: 10, receivingIntervals: [{ start: '2026-08-20T00:00:00.000Z', end: '2026-08-26T00:00:00.000Z' }], status: 'AVAILABLE', notes: null }],
  currentPlan,
};

function view(status: PlanView['status']): PlanView {
  return { id: '10', version: 1, status, previousPlanId: '9', summary: 'Current', destinationId: '3', deadline, createdAt: context.now, approvedAt: null, completedAt: null, batches: [{ id: '7', code: 'B-7' }], trigger: null, steps: [] };
}

test('revising a proposal keeps its scope and requests transactional replacement', async () => {
  let saved: Parameters<PlanRepositoryPort['saveProposal']> | undefined;
  let generationInstruction: string | undefined;
  let generationDeadline: string | null | undefined;
  const repository: PlanRepositoryPort = {
    list: async () => ({ updatedAt: context.now, activePlans: [], proposedPlans: [], history: [] }),
    get: async () => view('PROPOSED'),
    loadContext: async (_userId, batchIds, planId) => {
      assert.deepEqual(batchIds, [7n]);
      assert.equal(planId, 10n);
      return context;
    },
    saveProposal: async (...parameters) => { saved = parameters; return view('PROPOSED'); },
    activateProposal: async () => view('ACTIVE'),
    dismissProposal: async () => view('DISMISSED'),
    completeStep: async () => view('ACTIVE'),
  };
  const proposal: AiPlanProposal = { summary: 'Revised', steps: [step] };
  const service = new PlanService(repository, async (request) => {
    generationInstruction = request.instruction;
    generationDeadline = request.deadline;
    return { result: { status: 'PROPOSAL', ...proposal }, context };
  }, () => []);

  await service.revise(1n, 10n, 'Use another truck');

  assert.equal(generationInstruction, 'Use another truck');
  assert.equal(generationDeadline, deadline);
  assert.deepEqual(saved?.[2], [7n]);
  assert.equal(saved?.[3], 3n);
  assert.equal(saved?.[4], deadline);
  assert.equal(saved?.[5], currentPlan);
  assert.deepEqual(saved?.[6], { replaceProposalId: 10n });
});

test('does not persist a workflow result that fails deterministic validation', async () => {
  let saved = false;
  const repository = {
    get: async () => view('ACTIVE'),
    saveProposal: async () => { saved = true; return view('PROPOSED'); },
  } as unknown as PlanRepositoryPort;
  const service = new PlanService(repository, async () => ({ result: { status: 'PROPOSAL', summary: 'Invalid', steps: [step] }, context }), () => ['Invalid']);

  await assert.rejects(() => service.generateProposal(1n, [7n], 3n, deadline), (error) => error instanceof RequestError && error.status === 502);
  assert.equal(saved, false);
});

test('does not persist a no-valid-proposal workflow result', async () => {
  let saved = false;
  const repository = { saveProposal: async () => { saved = true; return view('PROPOSED'); } } as unknown as PlanRepositoryPort;
  const service = new PlanService(repository, async () => ({ result: { status: 'NO_VALID_PROPOSAL_FOUND', reason: 'No route reaches the destination in time.' }, context }), () => []);

  const result = await service.generateProposal(1n, [7n], 3n, deadline);

  assert.deepEqual(result, { status: 'NO_VALID_PROPOSAL_FOUND', reason: 'No route reaches the destination in time.' });
  assert.equal(saved, false);
});

test('attaches a reporting event to a generated revision', async () => {
  let options: Parameters<PlanRepositoryPort['saveProposal']>[6];
  const repository = {
    get: async () => view('ACTIVE'),
    saveProposal: async (...parameters: Parameters<PlanRepositoryPort['saveProposal']>) => { options = parameters[6]; return view('PROPOSED'); },
  } as unknown as PlanRepositoryPort;
  const service = new PlanService(repository, async () => ({ result: { status: 'PROPOSAL', summary: 'Revised', steps: [step] }, context }), () => []);

  await service.revise(1n, 10n, 'Account for the report', 44n);

  assert.deepEqual(options!, { triggerEventId: 44n });
});
