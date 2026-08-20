import type { PlanGenerationFeedback, PlanGenerationRequest } from '../../application/plans/plan-service';
import { RequestError } from '../../domain/errors';
import { InvalidPlanProposalError, parseAiPlanProposal, type PlanningContext } from '../../domain/plans/plans';

const timeoutMilliseconds = 20_000;
const maximumResponseBytes = 100_000;
const systemPrompt = 'You are SIRIP cold-chain operations planner. Return only one JSON object with exactly reason and steps. reason is a concise non-empty string up to 1000 characters. steps is an ordered array of 1 to 100 future actions. Every scoped batch must have at least one future step. Each step has actionType, positive string batchId, ISO scheduledAt, and only applicable optional coldStorageId, vehicleId, destinationId, notes. Action types: STORE uses coldStorageId only; LOAD uses vehicleId only; DISPATCH and HANDOVER use destinationId only; INSPECT and OTHER use no resource IDs. Use only IDs in context. Respect quality, aggregate capacity, availability, delays, travel time, and UTC daily receiving/availability windows. The current plan is authoritative context: completed steps are immutable and must not be returned; regenerate future steps only. Restrictions and notes are operational context; account for them conservatively.';

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
  return { apiUrl: url.toString(), apiKey, model };
}

async function responseText(response: Response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) throw new RequestError('AI provider returned an invalid response', 502);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw new RequestError('AI provider returned an invalid response', 502);
    }
    chunks.push(value);
  }
  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(content);
}

function content(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('AI provider returned an invalid response', 502);
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) throw new RequestError('AI provider returned an invalid response', 502);
  const choice = choices[0];
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new RequestError('AI provider returned an invalid response', 502);
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new RequestError('AI provider returned an invalid response', 502);
  const value = (message as Record<string, unknown>).content;
  if (typeof value !== 'string' || !value || value.length > maximumResponseBytes) throw new RequestError('AI provider returned an invalid response', 502);
  return value;
}

function userPrompt(context: PlanningContext, request?: PlanGenerationRequest, feedback?: PlanGenerationFeedback, parserError?: string) {
  const repair = parserError
    ? `Your previous answer violated the strict JSON contract. Return corrected strict JSON. Parser error: ${parserError.slice(0, 300)}`
    : feedback
      ? `Repair the plan using these deterministic validation errors: ${JSON.stringify(feedback.validationErrors.slice(0, 20).map((error) => error.slice(0, 300)))}`
      : null;
  const task = request?.instruction
    ? `Revise future operations according to this operator instruction: ${JSON.stringify(request.instruction)}${repair ? `\n${repair}` : ''}`
    : repair ?? 'Generate a feasible plan for future operations.';
  return `${task}\nCurrent plan and operational context:\n${JSON.stringify(context)}`;
}

async function requestPlan(configurationValue: ReturnType<typeof configuration>, context: PlanningContext, request?: PlanGenerationRequest, feedback?: PlanGenerationFeedback, parserError?: string) {
  let response: Response;
  try {
    response = await fetch(configurationValue.apiUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${configurationValue.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: configurationValue.model,
        stream: false,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt(context, request, feedback, parserError) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    throw new RequestError('AI provider is unavailable', 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new RequestError('AI provider request failed', 502);
  }
  let body: unknown;
  try {
    body = JSON.parse(await responseText(response)) as unknown;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('AI provider returned an invalid response', 502);
  }
  return content(body);
}

export async function generateAiPlan(context: PlanningContext, request?: PlanGenerationRequest, feedback?: PlanGenerationFeedback) {
  const configurationValue = configuration();
  let parserError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await requestPlan(configurationValue, context, request, feedback, parserError);
    try {
      return parseAiPlanProposal(output);
    } catch (error) {
      if (!(error instanceof InvalidPlanProposalError)) throw new RequestError('AI provider returned an invalid response', 502);
      if (attempt === 1) throw new RequestError('AI provider returned an invalid plan', 502);
      parserError = error.message;
    }
  }
  throw new RequestError('AI provider returned an invalid plan', 502);
}
