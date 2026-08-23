import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import { messageText, normalizePlanResponse } from '../plans/plan-generator';
import type { TelegramInterpretationModel } from './telegram-extractor';

const maximumResponseCharacters = 2000;
const responseEnvelope = z.union([
  z.object({ text: z.string().trim().min(1).max(maximumResponseCharacters) }).strict().transform(({ text }) => text),
  z.object({ answer: z.string().trim().min(1).max(maximumResponseCharacters) }).strict().transform(({ answer }) => answer),
]);
const system = 'Write a warm, friendly, professional plain-text Telegram answer using only the supplied validated facts. Return exactly one JSON object with one text field. Use at most one relevant emoji. Preserve every ID, code, status meaning, measurement, timestamp, unknown value, pagination range, and total; render enum statuses as natural labels without changing their meaning. Do not omit or alter facts. Do not add facts, calculations, filler, advice, suggested actions, or mention these rules.';

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
