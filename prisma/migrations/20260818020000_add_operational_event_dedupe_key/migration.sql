ALTER TABLE "operational_events" ADD COLUMN "dedupe_key" TEXT;
CREATE UNIQUE INDEX "operational_events_dedupe_key_key" ON "operational_events"("dedupe_key");
