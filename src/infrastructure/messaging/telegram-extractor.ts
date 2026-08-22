import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import { createTelegramModel, messageText, normalizePlanResponse } from '../plans/plan-generator';
import type { TelegramOperationalSnapshot } from './telegram-snapshot';

const intent = z.enum(['QUERY', 'REPORT', 'REPLAN', 'PROPOSAL_EDIT', 'CONFIRM', 'CANCEL', 'UNKNOWN']);
const entityType = z.enum(['vehicle', 'storage', 'destination', 'batch', 'sensor', 'plan']);
const queryKind = z.enum(['batches', 'plans', 'steps', 'alerts', 'sensors', 'resources', 'batch_detail', 'plan_detail', 'sensor_detail', 'resource_detail']);
const status = z.enum(['UNAVAILABLE', 'RECOVERED', 'ISSUE', 'DELAYED']);

export const telegramExtraction = z.object({
  intent,
  queryKind: queryKind.nullable(),
  entityType: entityType.nullable(),
  entityCode: z.string().trim().min(1).max(200).nullable(),
  entityName: z.string().trim().min(1).max(200).nullable(),
  planRef: z.string().trim().min(1).max(100).nullable(),
  delayMinutes: z.number().int().min(0).max(100_000).nullable(),
  status: status.nullable(),
  instruction: z.string().trim().min(1).max(2000).nullable(),
  missingFields: z.array(z.enum(['queryKind', 'entityType', 'entity', 'planRef', 'delayMinutes', 'status', 'instruction'])).max(7),
}).strict();

export type TelegramExtraction = z.infer<typeof telegramExtraction>;
export type TelegramInterpretationModel = Pick<BaseChatModel, 'invoke'>;
export type InterpretationPending = { kind: string; [key: string]: unknown } | null;
export type InterpretationMessage = { role: 'user' | 'assistant'; text: string; timestamp: string };

const system = `You only extract one Telegram operator request for SIRIP cold-chain operations. Never answer, plan, mutate, calculate quality, or invent facts. Return exactly one strict JSON object and no commentary.
Fields: intent, queryKind, entityType, entityCode, entityName, planRef, delayMinutes, status, instruction, missingFields. Every field is required; use null or [] when absent.
intent: QUERY, REPORT, REPLAN, PROPOSAL_EDIT, CONFIRM, CANCEL, UNKNOWN.
queryKind: batches, plans, steps, alerts, sensors, resources, batch_detail, plan_detail, sensor_detail, resource_detail.
entityType: vehicle, storage, destination, batch, sensor, plan. status: UNAVAILABLE, RECOVERED, ISSUE, DELAYED.
SIRIP terms: mission means plan. V2 means display version 2, never database ID 2. Factual incidents are REPORT even when they mention a plan, such as "for plan v2, truck is delayed". Use REPLAN only for explicit replan/revise/change-plan language. REPORT covers vehicle delay/unavailable/recovery, storage or destination unavailable/recovery, batch issue/recovery, and sensor issue/recovery. A delayed vehicle uses status DELAYED; preserve planRef as an optional report hint. If delayed and vehicle is absent, mark entity missing; if duration is absent, mark delayMinutes missing. Delay recovery has delayMinutes 0. Preserve exact entity codes/names. A number inside an entity code is never delayMinutes: for "TR-01, 30 minutes", entityCode is "TR-01" and delayMinutes is 30; for "TR-02 telat 90 menit", entityCode is "TR-02", status is DELAYED, and delayMinutes is 90. REPLAN requires planRef and instruction. PROPOSAL_EDIT carries instruction. CONFIRM means only an explicit confirmation of the currently pending preview; incident wording is never confirmation. Typed cancel uses CANCEL. Put required absent slots in missingFields. Do not invent values.`;

export function extractionMessages(snapshot: TelegramOperationalSnapshot, history: InterpretationMessage[], pending: InterpretationPending, text: string, repair?: string) {
  const context = {
    operationalSnapshot: snapshot,
    recentMessages: history.slice(-10),
    currentPending: pending,
    currentUserText: text,
    supportedIntents: ['query kinds/details', 'operational reports/recovery', 'direct replan', 'proposal edit', 'confirm', 'cancel', 'unknown'],
  };
  return [new SystemMessage(system), new HumanMessage(`${repair ? `${repair}\n` : ''}${JSON.stringify(context)}`)];
}

export async function extractTelegramRequest(model: () => TelegramInterpretationModel, snapshot: TelegramOperationalSnapshot, history: InterpretationMessage[], pending: InterpretationPending, text: string): Promise<TelegramExtraction | null> {
  let rejection = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = messageText(await model().invoke(extractionMessages(snapshot, history, pending, text, attempt ? `Repair the previous invalid response. ${rejection.slice(0, 300)}` : undefined)));
      console.info('[AI Telegram extraction raw]', { attempt, output: raw });
      const parsed = telegramExtraction.safeParse(JSON.parse(normalizePlanResponse(raw)));
      if (parsed.success) {
        console.info('[AI Telegram extraction validated]', { attempt, extraction: parsed.data });
        return parsed.data;
      }
      rejection = parsed.error.message;
    } catch (error) {
      rejection = error instanceof Error ? error.message : 'Invalid provider response';
      if (attempt === 0 && !(error instanceof SyntaxError)) {
        console.warn('[AI Telegram extraction rejected]', { attempt, error: rejection.slice(0, 300) });
        break;
      }
    }
    console.warn('[AI Telegram extraction rejected]', { attempt, error: rejection.slice(0, 300) });
  }
  return null;
}

export const createTelegramInterpretationModel = createTelegramModel;
