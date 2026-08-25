import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPlanExplanation, messageText, normalizePlanResponse, planningMessages, planningProviderError } from './plan-generator';

const plan = '{"status":"NO_VALID_PROPOSAL_FOUND","reason":"No route"}';

test('normalizes raw and singly fenced plan responses', () => {
  assert.equal(normalizePlanResponse(`  ${plan}\n`), plan);
  assert.equal(normalizePlanResponse(`\`\`\`json\n${plan}\n\`\`\`\nskipped: commentary`), plan);
});

test('leaves ambiguous or malformed fenced responses for strict parsing to reject', () => {
  const multiple = `\`\`\`json\n${plan}\n\`\`\`\n\`\`\`json\n${plan}\n\`\`\``;
  const malformed = `\`\`\`json\n${plan}`;
  assert.equal(normalizePlanResponse(multiple), multiple);
  assert.equal(normalizePlanResponse(malformed), malformed);
});

test('includes compact active resource commitments in selector context', () => {
  const context = { currentPlan: null, resourceOccupancies: [{ resourceType: 'VEHICLE', resourceId: '2', batchId: 'private-batch', weightKg: 50, start: '2026-08-20T12:00:00Z', end: '2026-08-20T14:00:00Z', destinationId: '3', dispatchAt: '2026-08-20T12:15:00Z' }] };
  const messages = planningMessages(context as never, { batches: [], selectedDestination: null }, []);
  const content = messageText(messages[1]!);
  assert.match(content, /Active resource commitments/);
  assert.match(content, /"resourceId":"2"/);
  assert.doesNotMatch(content, /private-batch|weightKg/);
});

test('logs sanitized Gemini provider errors while returning a safe request error', () => {
  const previousUrl = process.env.AI_API_URL;
  const previousModel = process.env.AI_MODEL;
  process.env.AI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=secret';
  process.env.AI_MODEL = 'gemini-test';
  const entries: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => entries.push(values);
  try {
    const result = planningProviderError({
      status: 400,
      error: { code: 'INVALID_ARGUMENT', type: 'invalid_request_error', message: 'Bad request at ?key=secret' },
    });
    assert.equal(result.message, 'Permintaan ke penyedia AI gagal');
    assert.deepEqual(entries, [[
      '[AI provider request failed]',
      {
        provider: 'generativelanguage.googleapis.com',
        model: 'gemini-test',
        status: 400,
        code: 'INVALID_ARGUMENT',
        type: 'invalid_request_error',
        message: 'Bad request at ?key=[REDACTED]',
      },
    ]]);
  } finally {
    console.error = originalError;
    if (previousUrl === undefined) delete process.env.AI_API_URL;
    else process.env.AI_API_URL = previousUrl;
    if (previousModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previousModel;
  }
});

test('AI explanation replaces only bounded narrative fields', () => {
  const proposal = {
    summary: 'Deterministic fallback',
    steps: [{ actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T12:00:00.000Z', rationale: 'Fallback action.', timingRationale: 'Fixed timing.', latestSafeAt: '2026-08-20T12:15:00.000Z' }],
    timing: { status: 'ON_TIME', delayedBySeconds: 0, reasons: [] },
  } as const;
  const explained = applyPlanExplanation(JSON.stringify({ summary: 'Gunakan truk yang tersedia agar batch segera bergerak.', stepExplanations: [{ stepKey: 'step-1', rationale: 'Pemuatan menyiapkan batch untuk pengiriman langsung.' }] }), proposal as never);

  assert.equal(explained.summary, 'Gunakan truk yang tersedia agar batch segera bergerak.');
  assert.equal(explained.steps[0]?.rationale, 'Pemuatan menyiapkan batch untuk pengiriman langsung.');
  assert.equal(explained.steps[0]?.scheduledAt, proposal.steps[0].scheduledAt);
  assert.equal(explained.steps[0]?.timingRationale, proposal.steps[0].timingRationale);
  assert.equal(explained.steps[0]?.latestSafeAt, proposal.steps[0].latestSafeAt);
  assert.deepEqual(explained.timing, proposal.timing);
});

test('AI explanation rejects incomplete or unexpected step coverage', () => {
  const proposal = { summary: 'Fallback', steps: [{ actionType: 'LOAD', batchId: '7', vehicleId: '2', scheduledAt: '2026-08-20T12:00:00.000Z', rationale: 'Fallback.' }] };
  assert.throws(() => applyPlanExplanation(JSON.stringify({ summary: 'Insight', stepExplanations: [] }), proposal as never));
  assert.throws(() => applyPlanExplanation(JSON.stringify({ summary: 'Insight', stepExplanations: [{ stepKey: 'other', rationale: 'Wrong step.' }] }), proposal as never));
});
