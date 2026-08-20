import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { createApp } from './infrastructure/http/app';
import { createDatabase } from './infrastructure/persistence/database';
import { ChatService } from './application/messaging/chat-service';
import { createChatGraph, createChatWorkflow } from './infrastructure/messaging/chat-graph';
import { ChatRepository } from './infrastructure/messaging/chat-repository';
import { TelegramService } from './infrastructure/messaging/telegram-service';

if (existsSync('.env')) loadEnvFile('.env');

const database = createDatabase();
const chat = new ChatService(createChatWorkflow(createChatGraph(new ChatRepository(database))));
const telegram = new TelegramService(database, chat);
const app = createApp(database, telegram);
const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
  void telegram.initialize().then((initialized) => console.log(initialized ? 'Telegram integration initialized' : 'Telegram integration disabled')).catch((error) => console.error('Telegram initialization failed', error instanceof Error ? error.message : 'Unknown error'));
});

async function shutdown() {
  server.close();
  await database.$disconnect();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
