import { createChatGraph } from './chat-graph';
import { ChatRepository } from './chat-repository';
import { createDatabase } from '../persistence/database';

const database = createDatabase();
export const chatWorkflow = createChatGraph(new ChatRepository(database));
