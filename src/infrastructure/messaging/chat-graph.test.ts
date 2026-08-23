import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatGraph, createChatWorkflow } from './chat-graph';

test('production chat workflow routes text and callbacks through LangGraph', async () => {
  const calls: unknown[][] = [];
  const handler = { handle: async (...args: unknown[]) => { calls.push(args); return { text: '<b>OK</b>', format: 'HTML' as const, buttons: [[{ text: 'Confirm', callback_data: 'confirm' }]] }; } };
  const workflow = createChatWorkflow(createChatGraph(handler as never));
  const receivedAt = new Date('2026-08-23T10:00:00.000Z');

  const textReply = await workflow({ userId: 7n, text: 'report delay', callback: null, receivedAt });
  await workflow({ userId: 7n, text: null, callback: 'confirm', receivedAt });

  assert.deepEqual(calls, [[7n, 'report delay', null, receivedAt], [7n, null, 'confirm', receivedAt]]);
  assert.equal(textReply.format, 'HTML');
  assert.equal(textReply.buttons?.[0]?.[0]?.callback_data, 'confirm');
});

test('chat graph rejects ambiguous input', async () => {
  const graph = createChatGraph({ handle: async () => ({ text: 'unused' }) } as never);
  await assert.rejects(graph.invoke({ userId: '7', text: 'message', callback: 'confirm', receivedAt: new Date().toISOString() }));
});
