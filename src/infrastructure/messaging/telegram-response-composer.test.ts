import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

import type { TelegramInterpretationModel } from './telegram-extractor';
import { composeTelegramQueryResponse } from './telegram-response-composer';

test('query composer receives only question and validated facts and normalizes a fenced answer', async () => {
  let captured: BaseMessage[] = [];
  const model = () => ({ invoke: async (messages: BaseMessage[]) => { captured = messages; return new AIMessage('```\nTR-01 is available.\n```\nThanks'); } }) as TelegramInterpretationModel;
  const text = await composeTelegramQueryResponse(model, 'Truck status?', { code: 'TR-01', status: 'AVAILABLE' }, 'fallback');
  assert.equal(text, 'TR-01 is available.');
  assert.equal(captured.length, 2);
  assert.deepEqual(JSON.parse(String(captured[1]?.content)), { question: 'Truck status?', validatedFacts: { code: 'TR-01', status: 'AVAILABLE' } });
});

test('query composition failure returns deterministic fallback', async () => {
  const model = () => ({ invoke: async () => { throw new Error('offline'); } }) as TelegramInterpretationModel;
  assert.equal(await composeTelegramQueryResponse(model, 'question', { answer: 1 }, 'safe answer'), 'safe answer');
});
