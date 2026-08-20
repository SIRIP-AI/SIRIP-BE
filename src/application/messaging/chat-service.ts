export type ChatInput = { userId: bigint; text: string };
export type ChatWorkflow = (input: ChatInput) => Promise<string>;

export type ChatRepositoryPort = {
  activeAlertSummary(userId: bigint): Promise<{ count: number; titles: string[] }>;
};

export class ChatService {
  constructor(private readonly workflow: ChatWorkflow) {}

  reply(input: ChatInput) {
    return this.workflow(input);
  }
}
