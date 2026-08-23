import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { RequestError } from '../../domain/errors';
import { Prisma } from '../../generated/prisma/client';
import type { Database } from '../persistence/database';
import type { TelegramOperations, TelegramReply } from './telegram-operations';
import type { ChatWorkflow } from './chat-graph';
import type { MonitoringAlert } from '../telemetry/monitoring-processor';

const linkLifetimeMs = 10 * 60_000;

type TelegramUpdate = {
  update_id?: unknown;
  message?: { message_id?: unknown; text?: unknown; chat?: { id?: unknown; first_name?: unknown; username?: unknown } };
  callback_query?: { id?: unknown; data?: unknown; message?: { chat?: { id?: unknown } } };
};

export type ExcursionAlert = {
  userId: bigint;
  sensorCode: string;
  batchCode: string;
  averageTemperatureC: number;
  latestTemperatureC: number;
  thresholdC: number;
};

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export class TelegramService {
  private botUsername: string | null = null;

  constructor(private readonly database: Database, private readonly operations: Pick<TelegramOperations, 'recordAssistant' | 'monitoringImpact'>, private readonly workflow: ChatWorkflow) {}

  private token() {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) throw new RequestError('Telegram is not configured', 503);
    return token;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok || !value || typeof value !== 'object' || !('ok' in value) || value.ok !== true || !('result' in value)) throw new Error(`Telegram ${method} request failed`);
    return value.result as T;
  }

  async initialize() {
    const base = process.env.PUBLIC_BASE_URL?.trim();
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim() || !base || !secret) return false;
    const bot = await this.call<{ username?: string }>('getMe', {});
    if (!bot.username) throw new Error('Telegram bot has no username');
    this.botUsername = bot.username;
    const url = new URL('/api/integrations/telegram/webhook', base);
    if (url.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS');
    await this.call('setWebhook', { url: url.toString(), secret_token: secret, allowed_updates: ['message', 'callback_query'] });
    return true;
  }

  async status(userId: bigint) {
    const connection = await this.database.messagingConnection.findUnique({ where: { userId_channel: { userId, channel: 'TELEGRAM' } } });
    return { connected: !!connection, connectedAt: connection?.connectedAt.toISOString() ?? null, botUrl: this.botUsername ? `https://t.me/${this.botUsername}` : null };
  }

  async createLink(userId: bigint) {
    if (!this.botUsername) await this.initialize();
    if (!this.botUsername) throw new RequestError('Telegram is not configured', 503);
    const token = randomBytes(24).toString('base64url');
    await this.database.$transaction([
      this.database.messagingLinkToken.deleteMany({ where: { userId, channel: 'TELEGRAM' } }),
      this.database.messagingLinkToken.create({ data: { tokenHash: hash(token), userId, channel: 'TELEGRAM', expiresAt: new Date(Date.now() + linkLifetimeMs) } }),
    ]);
    return { url: `https://t.me/${this.botUsername}?start=${token}`, expiresAt: new Date(Date.now() + linkLifetimeMs).toISOString() };
  }

  async disconnect(userId: bigint) {
    await this.database.$transaction([
      this.database.messagingConversation.deleteMany({ where: { userId, channel: 'TELEGRAM' } }),
      this.database.messagingConnection.deleteMany({ where: { userId, channel: 'TELEGRAM' } }),
    ]);
  }

  verifySecret(provided: string | undefined) {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!expected || !provided) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async receive(update: TelegramUpdate) {
    if (typeof update.update_id !== 'number' || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return;
    const externalUpdateId = String(update.update_id);
    try {
      await this.database.messagingUpdate.create({ data: { channel: 'TELEGRAM', externalUpdateId } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
    try {
      await this.processUpdate(update);
    } catch (error) {
      await this.database.messagingUpdate.deleteMany({ where: { channel: 'TELEGRAM', externalUpdateId } });
      throw error;
    }
  }

  private async processUpdate(update: TelegramUpdate) {
    const callbackQuery = update.callback_query;
    const callbackChatId = callbackQuery?.message?.chat?.id;
    const callbackData = callbackQuery?.data;
    if ((typeof callbackChatId === 'number' || typeof callbackChatId === 'string') && typeof callbackData === 'string' && callbackData.length <= 64) {
      if (typeof callbackQuery?.id === 'string') await this.call('answerCallbackQuery', { callback_query_id: callbackQuery.id });
      await this.receiveConnected(String(callbackChatId), null, callbackData);
      return;
    }
    const message = update.message;
    const chatId = message?.chat?.id;
    const text = message?.text;
    if ((typeof chatId !== 'number' && typeof chatId !== 'string') || typeof text !== 'string' || text.length > 2000) return;
    const externalChatId = String(chatId);
    const chat = message?.chat;
    const startToken = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)$/.exec(text.trim())?.[1];
    if (startToken) {
      const linked = await this.consumeLink(startToken, externalChatId, typeof chat?.username === 'string' ? `@${chat.username}` : typeof chat?.first_name === 'string' ? chat.first_name : null);
      await this.send(externalChatId, linked ? 'Telegram is connected to SIRIP. You will receive operational alerts here.' : 'This connection link is invalid or has expired. Generate a new link from the SIRIP Overview page.');
      return;
    }
    const connection = await this.database.messagingConnection.findUnique({ where: { channel_externalChatId: { channel: 'TELEGRAM', externalChatId } } });
    if (!connection) {
      await this.send(externalChatId, 'Connect this chat from the SIRIP Overview page first.');
      return;
    }
    await this.sendReply(externalChatId, await this.workflow({ userId: connection.userId, text, callback: null }));
  }

  private async receiveConnected(externalChatId: string, text: string | null, callback: string | null) {
    const connection = await this.database.messagingConnection.findUnique({ where: { channel_externalChatId: { channel: 'TELEGRAM', externalChatId } } });
    if (!connection) { await this.send(externalChatId, 'Connect this chat from the SIRIP Overview page first.'); return; }
    await this.sendReply(externalChatId, await this.workflow({ userId: connection.userId, text, callback }));
  }

  private async consumeLink(token: string, externalChatId: string, displayName: string | null) {
    return this.database.$transaction(async (transaction) => {
      const link = await transaction.messagingLinkToken.findUnique({ where: { tokenHash: hash(token) } });
      if (!link || link.channel !== 'TELEGRAM' || link.expiresAt <= new Date()) return false;
      const occupied = await transaction.messagingConnection.findUnique({ where: { channel_externalChatId: { channel: 'TELEGRAM', externalChatId } } });
      if (occupied && occupied.userId !== link.userId) return false;
      await transaction.messagingConnection.upsert({
        where: { userId_channel: { userId: link.userId, channel: 'TELEGRAM' } },
        create: { userId: link.userId, channel: 'TELEGRAM', externalChatId, displayName },
        update: { externalChatId, displayName, connectedAt: new Date() },
      });
      await transaction.messagingLinkToken.delete({ where: { tokenHash: link.tokenHash } });
      return true;
    });
  }

  async sendMonitoringAlert(alert: MonitoringAlert) {
    const connection = await this.database.messagingConnection.findUnique({ where: { userId_channel: { userId: alert.userId, channel: 'TELEGRAM' } } });
    if (!connection) return;
    const reply = await this.operations.monitoringImpact(alert);
    await this.sendReply(connection.externalChatId, reply);
    await this.operations.recordAssistant(alert.userId, reply.text);
  }

  private send(chatId: string, text: string) {
    return this.call('sendMessage', { chat_id: chatId, text });
  }

  private async sendReply(chatId: string, reply: TelegramReply) {
    const chunks = reply.text.split('\n\n').reduce<string[]>((result, section) => {
      const addition = `${result.length ? '\n\n' : ''}${section}`;
      if (!result.length || result[result.length - 1]!.length + addition.length > 4000) result.push(section);
      else result[result.length - 1] += addition;
      return result;
    }, []);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.call('sendMessage', { chat_id: chatId, text: chunks[index], ...(reply.format ? { parse_mode: reply.format } : {}), ...(index === chunks.length - 1 && reply.buttons ? { reply_markup: { inline_keyboard: reply.buttons } } : {}) });
    }
  }
}
