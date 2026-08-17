ALTER TABLE "batches" ADD COLUMN "user_id" BIGINT;
ALTER TABLE "operational_events" ADD COLUMN "user_id" BIGINT;
ALTER TABLE "plans" ADD COLUMN "user_id" BIGINT;

DROP INDEX "plans_version_key";
DROP INDEX "one_active_plan";

CREATE INDEX "batches_user_id_status_idx" ON "batches"("user_id", "status");
CREATE INDEX "operational_events_user_id_occurred_at_idx" ON "operational_events"("user_id", "occurred_at");
CREATE UNIQUE INDEX "plans_user_id_version_key" ON "plans"("user_id", "version");
CREATE UNIQUE INDEX "plans_legacy_version_key" ON "plans"("version") WHERE "user_id" IS NULL;
CREATE UNIQUE INDEX "one_active_plan_per_user" ON "plans"("user_id") WHERE "status" = 'ACTIVE' AND "user_id" IS NOT NULL;
CREATE UNIQUE INDEX "one_active_legacy_plan" ON "plans"("status") WHERE "status" = 'ACTIVE' AND "user_id" IS NULL;

ALTER TABLE "batches" ADD CONSTRAINT "batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
