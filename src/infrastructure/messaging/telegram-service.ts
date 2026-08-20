import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { RequestError } from '../../domain/errors';
import type { ChatService } from '../../application/messaging/chat-service';
import type { Database } from '../persistence/database';

const linkLifetimeMs = 10 * 60_000;

type TelegramUpdate = {
  update_id?: unknown;
  message?: { message_id?: unknown; text?: unknown; chat?: { id?: unknown; first_name?: unknown; username?: unknown } };
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

  constructor(private readonly database: Database, private readonly chat: ChatService) {}

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
    await this.call('setWebhook', { url: url.toString(), secret_token: secret, allowed_updates: ['message'] });
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
    await this.database.messagingConnection.deleteMany({ where: { userId, channel: 'TELEGRAM' } });
  }

  verifySecret(provided: string | undefined) {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!expected || !provided) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async receive(update: TelegramUpdate) {
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
    await this.send(externalChatId, await this.chat.reply({ userId: connection.userId, text }));
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

  async sendExcursion(alert: ExcursionAlert) {
    const connection = await this.database.messagingConnection.findUnique({ where: { userId_channel: { userId: alert.userId, channel: 'TELEGRAM' } } });
    if (!connection) return;
    await this.send(connection.externalChatId, [
      'SIRIP - TEMPERATURE ALERT',
      '',
      `Sensor: ${alert.sensorCode}`,
      `Batch: ${alert.batchCode}`,
      `Average of latest 5 readings: ${alert.averageTemperatureC.toFixed(1)}°C`,
      `Latest temperature: ${alert.latestTemperatureC.toFixed(1)}°C`,
      `Excursion threshold: ${alert.thresholdC.toFixed(1)}°C`,
      '',
      'Please inspect the batch and cooling system immediately.',
    ].join('\n'));
  }

  private send(chatId: string, text: string) {
    return this.call('sendMessage', { chat_id: chatId, text });
  }
}
