import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';

import type { ChatRepositoryPort, ChatWorkflow } from '../../application/messaging/chat-service';

const ChatState = Annotation.Root({
  userId: Annotation<string>(),
  text: Annotation<string>(),
  intent: Annotation<'STATUS' | 'HELP'>(),
  reply: Annotation<string>(),
});

const input = z.object({ userId: z.string().regex(/^[1-9]\d*$/), text: z.string().trim().min(1).max(2000) });
const output = z.object({ reply: z.string() });

export function createChatGraph(repository: ChatRepositoryPort) {
  const classify = (state: typeof ChatState.State) => ({ intent: /alert|status|temperature|sensor/i.test(state.text) ? 'STATUS' as const : 'HELP' as const });
  const route = (state: typeof ChatState.State) => state.intent === 'STATUS' ? 'status' : 'help';
  const status = async (state: typeof ChatState.State) => {
    const summary = await repository.activeAlertSummary(BigInt(state.userId));
    if (!summary.count) return { reply: 'SIRIP currently has no active alerts for your operation.' };
    return { reply: `SIRIP has ${summary.count} active alert${summary.count === 1 ? '' : 's'}: ${summary.titles.join(', ')}.` };
  };
  const help = () => ({ reply: 'Hello from SIRIP. Ask me about your current alerts, temperature, or sensor status.' });

  return new StateGraph(ChatState, { input, output })
    .addNode('classify_intent', classify)
    .addNode('load_alert_status', status)
    .addNode('help', help)
    .addEdge(START, 'classify_intent')
    .addConditionalEdges('classify_intent', route, ['load_alert_status', 'help'])
    .addEdge('load_alert_status', END)
    .addEdge('help', END)
    .compile();
}

export function createChatWorkflow(graph: ReturnType<typeof createChatGraph>): ChatWorkflow {
  return async ({ userId, text }) => (await graph.invoke({ userId: userId.toString(), text })).reply;
}
