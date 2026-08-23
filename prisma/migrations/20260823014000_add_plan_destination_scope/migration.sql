CREATE TABLE "plan_destinations" (
  "plan_id" BIGINT NOT NULL,
  "destination_id" BIGINT NOT NULL,
  CONSTRAINT "plan_destinations_pkey" PRIMARY KEY ("plan_id", "destination_id"),
  CONSTRAINT "plan_destinations_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE,
  CONSTRAINT "plan_destinations_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE RESTRICT
);
CREATE INDEX "plan_destinations_destination_id_idx" ON "plan_destinations"("destination_id");
INSERT INTO "plan_destinations" ("plan_id", "destination_id") SELECT "id", "destination_id" FROM "plans" WHERE "destination_id" IS NOT NULL;
