import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestError } from '../../domain/errors';
import type { PlanningContext } from '../../domain/plans';
import { generateAiPlan } from './plan-generator';

const context: PlanningContext = {
  now: '2026-08-17T08:00:00.000Z',
  batches: [],
  coldStorages: [],
  vehicles: [],
  destinations: [],
  activePlan: null,
};

const proposal = {
  reason: 'Inspect the active batch.',
  steps: [{ actionType: 'INSPECT', batchId: '1', scheduledAt: '2026-08-17T09:00:00.000Z' }],
};

test('retries one structural failure without retrying HTTP failures', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.AI_API_URL;
  const originalKey = process.env.AI_API_KEY;
  const originalModel = process.env.AI_MODEL;
  process.env.AI_API_URL = 'https://ai.example.test/v1/chat/completions';
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'test-model';
  try {
    const requests: Array<{ stream: boolean; messages: Array<{ role: string; content: string }> }> = [];
    const outputs = ['PRIVATE_PROVIDER_OUTPUT', JSON.stringify(proposal)];
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as { stream: boolean; messages: Array<{ role: string; content: string }> });
      return new Response(JSON.stringify({ choices: [{ message: { content: outputs.shift() } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    assert.deepEqual(await generateAiPlan(context), proposal);
    assert.equal(requests.length, 2);
    assert.equal(requests.every((request) => request.stream === false), true);
    const repairPrompt = requests[1]?.messages[1]?.content ?? '';
    assert.match(repairPrompt, /corrected strict JSON/);
    assert.doesNotMatch(repairPrompt, /PRIVATE_PROVIDER_OUTPUT/);

    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('private failure', { status: 500 });
    };
    await assert.rejects(generateAiPlan(context), (error) => error instanceof RequestError && error.status === 502 && error.message === 'AI provider request failed');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.AI_API_URL; else process.env.AI_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = originalModel;
  }
});
