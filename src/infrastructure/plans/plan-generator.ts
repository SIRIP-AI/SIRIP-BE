import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';

import { RequestError } from '../../domain/errors';
import type { PlanningContext } from '../../domain/plans/plans';

const timeoutMilliseconds = 20_000;
const maximumPlanResponseBytes = 100_000;
export const maximumPlanResponseCharacters = 100_000;
const oversizedResponseMarker = 'SIRIP_PLAN_RESPONSE_TOO_LARGE';
const systemPrompt = 'You are SIRIP cold-chain operations planner. Return only one JSON object with exactly reason and steps. reason is a concise non-empty string up to 1000 characters. steps is an ordered array of 1 to 100 future actions. Every scoped batch must have at least one future step. Each step has actionType, positive string batchId, ISO scheduledAt, and only applicable optional coldStorageId, vehicleId, destinationId, notes. Action types: STORE uses coldStorageId only; LOAD uses vehicleId only; DISPATCH and HANDOVER use destinationId only; INSPECT and OTHER use no resource IDs. Use only IDs in context. Respect quality, aggregate capacity, availability, delays, travel time, and UTC daily receiving/availability windows. The current plan is authoritative context: completed steps are immutable and must not be returned; regenerate future steps only. Restrictions and notes are operational context; account for them conservatively.';

export type PlanningModel = Pick<BaseChatModel, 'invoke'>;

function configuration() {
  const apiUrl = process.env.AI_API_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!apiUrl || !apiKey || !model) throw new RequestError('AI planning is not configured', 503);
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new RequestError('AI planning is not configured', 503);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || apiKey.length > 10_000 || model.length > 200) throw new RequestError('AI planning is not configured', 503);
  return { endpoint: url.toString(), apiKey, model };
}

function boundedProviderFetch(endpoint: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const response = await fetch(new Request(new Request(endpoint, request), { redirect: 'error' }));
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maximumPlanResponseBytes) {
      await response.body?.cancel();
      throw new Error(oversizedResponseMarker);
    }
    if (!response.body) return response;
    let size = 0;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        size += value.byteLength;
        if (size > maximumPlanResponseBytes) {
          await reader.cancel();
          controller.error(new Error(oversizedResponseMarker));
          return;
        }
        controller.enqueue(value);
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export function createPlanningModel(): PlanningModel {
  const { endpoint, apiKey, model } = configuration();
  return new ChatOpenAI({
    apiKey,
    model,
    temperature: 0,
    maxRetries: 0,
    timeout: timeoutMilliseconds,
    useResponsesApi: false,
    modelKwargs: { response_format: { type: 'json_object' } },
    configuration: { fetch: boundedProviderFetch(endpoint) },
  });
}

function errorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  let current = error;
  while (current && !values.includes(current)) {
    values.push(current);
    current = typeof current === 'object' && 'cause' in current ? current.cause : null;
  }
  return values;
}

export function planningProviderError(error: unknown) {
  const chain = errorChain(error);
  if (chain.some((value) => value instanceof Error && value.message.includes(oversizedResponseMarker))) return new RequestError('AI provider returned an invalid response', 502);
  if (chain.some((value) => value instanceof SyntaxError)) return new RequestError('AI provider returned an invalid response', 502);
  if (chain.some((value) => value && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'number')) return new RequestError('AI provider request failed', 502);
  if (chain.some((value) => value instanceof Error && /timeout|connection|abort|fetch failed/i.test(`${value.name} ${value.message}`))) return new RequestError('AI provider is unavailable', 502);
  return new RequestError('AI provider request failed', 502);
}

export function planningMessages(context: PlanningContext, instruction?: string, parserError?: string, validationErrors: string[] = []) {
  const repair = parserError
    ? `Your previous answer violated the strict JSON contract. Return corrected strict JSON. Parser error: ${parserError.slice(0, 300)}`
    : validationErrors.length
      ? `Repair the plan using these deterministic validation errors: ${JSON.stringify(validationErrors.slice(0, 20).map((error) => error.slice(0, 300)))}`
      : null;
  const task = instruction
    ? `Revise future operations according to this operator instruction: ${JSON.stringify(instruction)}${repair ? `\n${repair}` : ''}`
    : repair ?? 'Generate a feasible plan for future operations.';
  return [new SystemMessage(systemPrompt), new HumanMessage(`${task}\nCurrent plan and operational context:\n${JSON.stringify(context)}`)];
}

export function messageText(message: BaseMessage) {
  if (typeof message.content !== 'string' || !message.content || message.content.length > maximumPlanResponseCharacters) throw new RequestError('AI provider returned an invalid response', 502);
  return message.content;
}
