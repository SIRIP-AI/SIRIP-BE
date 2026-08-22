import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePlanResponse, planningProviderError } from './plan-generator';

const plan = '{"status":"INFEASIBLE","reason":"No route"}';

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
    assert.equal(result.message, 'AI provider request failed');
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
