import assert from 'node:assert/strict';
import test from 'node:test';

import { PlanService, type PlanRepositoryPort } from './plan-service';
import type { AiPlanProposal, PlanningContext, PlanView } from '../../domain/plans/plans';

const step = { actionType: 'INSPECT' as const, batchId: '7', scheduledAt: '2026-08-21T10:00:00.000Z' };
const currentPlan = { id: '10', version: 1, reason: 'Current', steps: [{ sequence: 1, ...step, status: 'COMPLETED' as const, completedAt: '2026-08-20T10:00:00.000Z', coldStorageId: null, vehicleId: null, destinationId: null, notes: null }] };
const context: PlanningContext = {
  now: '2026-08-20T12:00:00.000Z',
  batches: [{ id: '7', code: 'B-7', weightKg: 10, grade: 'A', status: 'ACTIVE', quality: { equivalentQualityAgeDays: 1, remainingQualityWindowDays: 5, qualityEstimateStartedAt: '2026-08-20T00:00:00.000Z', currentTemperatureC: 2 }, telemetry: [] }],
  coldStorages: [{ id: '1', name: 'Cold', capacityKg: 100, availableCapacityKg: 100, operationalStatus: 'AVAILABLE' }],
  vehicles: [{ id: '2', code: 'Truck', capacityKg: 100, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: null, availabilityStart: null, availabilityEnd: null }],
  destinations: [{ id: '3', name: 'Port', address: 'A', travelMinutes: 10, receivingStart: '00:00', receivingEnd: '23:59', status: 'AVAILABLE', notes: null }],
  currentPlan,
};

function view(status: PlanView['status']): PlanView {
  return { id: '10', version: 1, status, previousPlanId: '9', reason: 'Current', createdAt: context.now, approvedAt: null, batches: [{ id: '7', code: 'B-7' }], trigger: null, steps: [] };
}

test('revising a proposal keeps its scope and requests transactional replacement', async () => {
  let saved: Parameters<PlanRepositoryPort['saveProposal']> | undefined;
  let generationInstruction: string | undefined;
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
  const proposal: AiPlanProposal = { reason: 'Revised', steps: [step] };
  const service = new PlanService(repository, async (_context, request) => {
    generationInstruction = request?.instruction;
    return proposal;
  }, () => []);

  await service.revise(1n, 10n, 'Use another truck');

  assert.equal(generationInstruction, 'Use another truck');
  assert.deepEqual(saved?.[2], [7n]);
  assert.equal(saved?.[3], currentPlan);
  assert.deepEqual(saved?.[4], { replaceProposalId: 10n });
});
