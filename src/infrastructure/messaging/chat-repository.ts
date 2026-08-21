import type { ChatRepositoryPort } from '../../application/messaging/chat-service';
import type { Database } from '../persistence/database';

export class ChatRepository implements ChatRepositoryPort {
  constructor(private readonly database: Database) {}

  async activeAlertSummary(userId: bigint) {
    const events = await this.database.operationalEvent.findMany({
      where: { userId },
      orderBy: { occurredAt: 'desc' },
      select: { structuredData: true },
    });
    const titles = events.flatMap(({ structuredData }) => {
      if (!structuredData || typeof structuredData !== 'object' || Array.isArray(structuredData)) return [];
      const alert = structuredData.alert;
      return alert && typeof alert === 'object' && !Array.isArray(alert) && alert.active === true && typeof alert.title === 'string' ? [alert.title] : [];
    });
    return { count: titles.length, titles: titles.slice(0, 3) };
  }
}
