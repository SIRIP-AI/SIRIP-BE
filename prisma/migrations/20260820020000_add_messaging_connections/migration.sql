CREATE TYPE "MessagingChannel" AS ENUM ('TELEGRAM', 'WHATSAPP');

CREATE TABLE "messaging_connections" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "channel" "MessagingChannel" NOT NULL,
    "external_chat_id" TEXT NOT NULL,
    "display_name" TEXT,
    "connected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messaging_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messaging_link_tokens" (
    "token_hash" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "channel" "MessagingChannel" NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messaging_link_tokens_pkey" PRIMARY KEY ("token_hash")
);

CREATE UNIQUE INDEX "messaging_connections_user_id_channel_key" ON "messaging_connections"("user_id", "channel");
CREATE UNIQUE INDEX "messaging_connections_channel_external_chat_id_key" ON "messaging_connections"("channel", "external_chat_id");
CREATE INDEX "messaging_link_tokens_expires_at_idx" ON "messaging_link_tokens"("expires_at");
ALTER TABLE "messaging_connections" ADD CONSTRAINT "messaging_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messaging_link_tokens" ADD CONSTRAINT "messaging_link_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
