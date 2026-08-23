import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatGraph, createChatWorkflow } from './chat-graph';

test('production chat workflow routes text and callbacks through LangGraph', async () => {
  const calls: string[] = [];
  const extraction = { intent: 'QUERY', queryKind: null, query: { dataset: 'storage', operation: 'COUNT', metric: null, operator: null, threshold: null, status: null }, entityType: null, entityCode: null, entityName: null, planRef: null, delayMinutes: null, status: null, instruction: null, missingFields: [] } as const;
  const handler = {
    prepareText: async () => { calls.push('extract'); return { kind: 'READY' as const, turn: { userId: 7n, input: 'count storage', receivedAt: new Date(), conversation: { pending: null, messages: [] }, extraction, inbound: { role: 'user' as const, text: 'count storage', timestamp: new Date().toISOString() } } }; },
    executePrepared: async () => { calls.push('query'); return { text: '<b>OK</b>', format: 'HTML' as const, buttons: [[{ text: 'Confirm', callback_data: 'confirm' }]] }; },
    handleCallback: async () => { calls.push('callback'); return { text: 'confirmed' }; },
  };
  const workflow = createChatWorkflow(createChatGraph(handler as never));
  const receivedAt = new Date('2026-08-23T10:00:00.000Z');

  const textReply = await workflow({ userId: 7n, text: 'count storage', callback: null, receivedAt });
  await workflow({ userId: 7n, text: null, callback: 'confirm', receivedAt });

  assert.deepEqual(calls, ['extract', 'query', 'callback']);
  assert.equal(textReply.format, 'HTML');
  assert.equal(textReply.buttons?.[0]?.[0]?.callback_data, 'confirm');
});

test('chat graph rejects ambiguous input', async () => {
  const graph = createChatGraph({} as never);
  await assert.rejects(graph.invoke({ userId: '7', text: 'message', callback: 'confirm', receivedAt: new Date().toISOString() }));
});

test('chat graph exposes intent-specific nodes', async () => {
  const graph = createChatGraph({} as never);
  const nodes = new Set(Object.keys((await graph.getGraphAsync()).nodes));
  for (const intent of ['extract_intent', 'query', 'report', 'replan', 'proposal_edit', 'confirm', 'cancel', 'unknown', 'handle_callback']) assert.ok(nodes.has(intent), `${intent} node is missing`);
});
