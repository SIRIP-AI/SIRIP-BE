ALTER TYPE "OperationalEventSource" ADD VALUE 'TELEGRAM';
ALTER TABLE "operational_events" ADD COLUMN "sensor_id" BIGINT;
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_sensor_id_fkey" FOREIGN KEY ("sensor_id") REFERENCES "sensors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "messaging_conversations" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "channel" "MessagingChannel" NOT NULL,
  "state" JSONB NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "messaging_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "messaging_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "messaging_conversations_user_id_channel_key" ON "messaging_conversations"("user_id", "channel");
CREATE INDEX "messaging_conversations_expires_at_idx" ON "messaging_conversations"("expires_at");

CREATE TABLE "messaging_updates" (
  "channel" "MessagingChannel" NOT NULL,
  "external_update_id" TEXT NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "messaging_updates_pkey" PRIMARY KEY ("channel", "external_update_id")
);
CREATE INDEX "messaging_updates_received_at_idx" ON "messaging_updates"("received_at");
