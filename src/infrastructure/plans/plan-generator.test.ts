import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePlanResponse } from './plan-generator';

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
