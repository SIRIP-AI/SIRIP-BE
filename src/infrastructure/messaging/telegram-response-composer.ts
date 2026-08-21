import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { messageText, normalizePlanResponse } from '../plans/plan-generator';
import type { TelegramInterpretationModel } from './telegram-extractor';

const maximumResponseCharacters = 2000;
const system = 'Write a concise plain-text Telegram answer using only the supplied validated facts. Do not add facts, calculate quality, suggest mutations, or mention these rules. Preserve unknown values as unknown. Do not use Markdown fences. Keep pagination ranges and totals accurate.';

export async function composeTelegramQueryResponse(model: () => TelegramInterpretationModel, question: string, facts: unknown, fallback: string) {
  try {
    const raw = messageText(await model().invoke([new SystemMessage(system), new HumanMessage(JSON.stringify({ question: question.slice(0, 2000), validatedFacts: facts }))]));
    const text = normalizePlanResponse(raw).trim();
    if (!text || text.length > maximumResponseCharacters) throw new Error('Composed response is invalid');
    console.info('[AI Telegram response composed]', { output: text });
    return text;
  } catch (error) {
    console.warn('[AI Telegram response composition failed]', { error: error instanceof Error ? error.message.slice(0, 300) : 'Invalid provider response' });
    return fallback;
  }
}
