import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

import type { PreparedTelegramTurn, TelegramOperations, TelegramReply } from './telegram-operations';

const button = z.object({ text: z.string(), callback_data: z.string().max(64) });
const input = z.object({
  userId: z.string().regex(/^[1-9]\d*$/),
  text: z.string().trim().min(1).max(2000).nullable(),
  callback: z.string().max(64).nullable(),
  receivedAt: z.string().datetime({ offset: true }),
});
const output = z.object({ reply: z.object({ text: z.string(), format: z.literal('HTML').optional(), buttons: z.array(z.array(button)).optional() }) });

const ChatState = Annotation.Root({
  userId: Annotation<string>(),
  text: Annotation<string | null>(),
  callback: Annotation<string | null>(),
  receivedAt: Annotation<string>(),
  prepared: Annotation<PreparedTelegramTurn | null>(),
  reply: Annotation<TelegramReply>(),
});

type ChatOperations = Pick<TelegramOperations, 'prepareText' | 'executePrepared' | 'handleCallback'>;

export function createChatGraph(operations: ChatOperations) {
  const validateInput = (state: typeof ChatState.State) => {
    if ((state.text === null) === (state.callback === null)) throw new Error('Exactly one of text or callback is required');
    return { prepared: null };
  };
  const handleCallback = async (state: typeof ChatState.State) => ({ reply: await operations.handleCallback(BigInt(state.userId), state.callback!, new Date(state.receivedAt)) });
  const extractIntent = async (state: typeof ChatState.State) => {
    const prepared = await operations.prepareText(BigInt(state.userId), state.text, new Date(state.receivedAt));
    return prepared.kind === 'READY' ? { prepared: prepared.turn } : { reply: prepared.reply, prepared: null };
  };
  const executeIntent = async (state: typeof ChatState.State) => {
    if (!state.prepared) throw new Error('Prepared Telegram turn is unavailable');
    return { reply: await operations.executePrepared(state.prepared) };
  };
  const routeInput = (state: typeof ChatState.State) => state.callback ? 'callback' : 'text';
  const routeIntent = (state: typeof ChatState.State) => state.prepared ? state.prepared.extraction.intent.toLowerCase() : 'direct_reply';

  return new StateGraph(ChatState, { input, output })
    .addNode('validate_input', validateInput)
    .addNode('handle_callback', handleCallback)
    .addNode('extract_intent', extractIntent)
    .addNode('query', executeIntent)
    .addNode('report', executeIntent)
    .addNode('replan', executeIntent)
    .addNode('proposal_edit', executeIntent)
    .addNode('confirm', executeIntent)
    .addNode('cancel', executeIntent)
    .addNode('unknown', executeIntent)
    .addNode('direct_reply', () => ({}))
    .addEdge(START, 'validate_input')
    .addConditionalEdges('validate_input', routeInput, { callback: 'handle_callback', text: 'extract_intent' })
    .addConditionalEdges('extract_intent', routeIntent, { query: 'query', report: 'report', replan: 'replan', proposal_edit: 'proposal_edit', confirm: 'confirm', cancel: 'cancel', unknown: 'unknown', direct_reply: 'direct_reply' })
    .addEdge('handle_callback', END)
    .addEdge('query', END)
    .addEdge('report', END)
    .addEdge('replan', END)
    .addEdge('proposal_edit', END)
    .addEdge('confirm', END)
    .addEdge('cancel', END)
    .addEdge('unknown', END)
    .addEdge('direct_reply', END)
    .compile();
}

export type ChatWorkflow = (input: { userId: bigint; text: string | null; callback: string | null; receivedAt?: Date }) => Promise<TelegramReply>;

export function createChatWorkflow(graph: ReturnType<typeof createChatGraph>): ChatWorkflow {
  return async ({ userId, text, callback, receivedAt = new Date() }) => (await graph.invoke({ userId: userId.toString(), text, callback, receivedAt: receivedAt.toISOString() })).reply;
}
