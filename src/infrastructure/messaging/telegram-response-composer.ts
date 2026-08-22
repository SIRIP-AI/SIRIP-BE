import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import { messageText, normalizePlanResponse } from '../plans/plan-generator';
import type { TelegramInterpretationModel } from './telegram-extractor';

const maximumResponseCharacters = 2000;
const responseEnvelope = z.union([
  z.object({ text: z.string().trim().min(1).max(maximumResponseCharacters) }).strict().transform(({ text }) => text),
  z.object({ answer: z.string().trim().min(1).max(maximumResponseCharacters) }).strict().transform(({ answer }) => answer),
]);
const system = 'Write a concise Telegram answer using only the supplied validated facts. Return exactly one JSON object with one text field. Do not add facts, calculate quality, suggest mutations, or mention these rules. Preserve unknown values as unknown. Keep pagination ranges and totals accurate.';

function responseText(raw: string) {
  const normalized = normalizePlanResponse(raw).trim();
  if (normalized.startsWith('{')) return responseEnvelope.parse(JSON.parse(normalized));
  if (!normalized || normalized.length > maximumResponseCharacters) throw new Error('Composed response is invalid');
  return normalized;
}

export async function composeTelegramQueryResponse(model: () => TelegramInterpretationModel, question: string, facts: unknown, fallback: string) {
  try {
    const raw = messageText(await model().invoke([new SystemMessage(system), new HumanMessage(JSON.stringify({ question: question.slice(0, 2000), validatedFacts: facts }))]));
    return responseText(raw);
  } catch (error) {
    console.warn('[AI Telegram response composition failed]', { error: error instanceof Error ? error.message.slice(0, 300) : 'Invalid provider response' });
    return fallback;
  }
}
