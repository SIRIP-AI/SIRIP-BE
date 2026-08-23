import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

import type { TelegramOperations, TelegramReply } from './telegram-operations';

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
  reply: Annotation<TelegramReply>(),
});

export function createChatGraph(operations: Pick<TelegramOperations, 'handle'>) {
  const operate = async (state: typeof ChatState.State) => {
    if ((state.text === null) === (state.callback === null)) throw new Error('Exactly one of text or callback is required');
    return { reply: await operations.handle(BigInt(state.userId), state.text, state.callback, new Date(state.receivedAt)) };
  };
  return new StateGraph(ChatState, { input, output })
    .addNode('route_telegram_conversation', operate)
    .addEdge(START, 'route_telegram_conversation')
    .addEdge('route_telegram_conversation', END)
    .compile();
}

export type ChatWorkflow = (input: { userId: bigint; text: string | null; callback: string | null; receivedAt?: Date }) => Promise<TelegramReply>;

export function createChatWorkflow(graph: ReturnType<typeof createChatGraph>): ChatWorkflow {
  return async ({ userId, text, callback, receivedAt = new Date() }) => (await graph.invoke({ userId: userId.toString(), text, callback, receivedAt: receivedAt.toISOString() })).reply;
}
