ALTER TABLE "plans" ADD COLUMN "completed_at" TIMESTAMPTZ;
ALTER TABLE "vehicles" ADD COLUMN "delay_persistent" BOOLEAN NOT NULL DEFAULT false;

UPDATE "plans" p
SET "status" = 'COMPLETED',
    "completed_at" = COALESCE((
      SELECT MAX(ps."completed_at")
      FROM "plan_steps" ps
      WHERE ps."plan_id" = p."id" AND ps."status" = 'COMPLETED'
    ), CURRENT_TIMESTAMP)
WHERE p."status" = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1 FROM "plan_steps" ps
    WHERE ps."plan_id" = p."id" AND ps."status" = 'UPCOMING'
  );

CREATE INDEX "plans_user_id_status_created_at_idx" ON "plans"("user_id", "status", "created_at");
CREATE INDEX "plans_previous_plan_id_status_idx" ON "plans"("previous_plan_id", "status");
CREATE INDEX "plan_steps_plan_id_status_idx" ON "plan_steps"("plan_id", "status");
CREATE INDEX "plan_steps_vehicle_id_status_idx" ON "plan_steps"("vehicle_id", "status");
