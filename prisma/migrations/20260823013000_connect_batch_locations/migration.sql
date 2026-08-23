CREATE TYPE "BatchLocationType" AS ENUM ('INTAKE', 'COLD_STORAGE', 'VEHICLE', 'DESTINATION');

ALTER TABLE "batches"
  ADD COLUMN "location_type" "BatchLocationType" NOT NULL DEFAULT 'INTAKE',
  ADD COLUMN "current_cold_storage_id" BIGINT,
  ADD COLUMN "current_vehicle_id" BIGINT,
  ADD COLUMN "current_destination_id" BIGINT,
  ADD COLUMN "location_updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "batches_current_cold_storage_id_fkey" FOREIGN KEY ("current_cold_storage_id") REFERENCES "cold_storages"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "batches_current_vehicle_id_fkey" FOREIGN KEY ("current_vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "batches_current_destination_id_fkey" FOREIGN KEY ("current_destination_id") REFERENCES "destinations"("id") ON DELETE RESTRICT;

WITH latest_movement AS (
  SELECT DISTINCT ON (ps.batch_id) ps.batch_id, ps.action_type, ps.cold_storage_id, ps.vehicle_id, ps.destination_id, p.status AS plan_status
  FROM plan_steps ps JOIN plans p ON p.id = ps.plan_id
  WHERE ps.status = 'COMPLETED' AND ps.batch_id IS NOT NULL AND ps.action_type IN ('STORE', 'LOAD', 'DISPATCH', 'HANDOVER')
  ORDER BY ps.batch_id, COALESCE(ps.completed_at, ps.scheduled_at) DESC, ps.sequence DESC
)
UPDATE batches b SET
  location_type = CASE WHEN lm.action_type = 'STORE' THEN 'COLD_STORAGE'::"BatchLocationType" WHEN lm.action_type = 'LOAD' OR (lm.action_type = 'DISPATCH' AND lm.plan_status <> 'COMPLETED') THEN 'VEHICLE'::"BatchLocationType" WHEN lm.action_type = 'HANDOVER' OR (lm.action_type = 'DISPATCH' AND lm.plan_status = 'COMPLETED') THEN 'DESTINATION'::"BatchLocationType" ELSE 'INTAKE'::"BatchLocationType" END,
  current_cold_storage_id = CASE WHEN lm.action_type = 'STORE' THEN lm.cold_storage_id END,
  current_vehicle_id = CASE WHEN lm.action_type = 'LOAD' OR (lm.action_type = 'DISPATCH' AND lm.plan_status <> 'COMPLETED') THEN lm.vehicle_id END,
  current_destination_id = CASE WHEN lm.action_type = 'HANDOVER' OR (lm.action_type = 'DISPATCH' AND lm.plan_status = 'COMPLETED') THEN lm.destination_id END,
  location_updated_at = CURRENT_TIMESTAMP
FROM latest_movement lm WHERE b.id = lm.batch_id;

ALTER TABLE "batches" ADD CONSTRAINT "batches_location_check" CHECK (
    ("location_type" = 'INTAKE' AND "current_cold_storage_id" IS NULL AND "current_vehicle_id" IS NULL AND "current_destination_id" IS NULL)
    OR ("location_type" = 'COLD_STORAGE' AND "current_cold_storage_id" IS NOT NULL AND "current_vehicle_id" IS NULL AND "current_destination_id" IS NULL)
    OR ("location_type" = 'VEHICLE' AND "current_cold_storage_id" IS NULL AND "current_vehicle_id" IS NOT NULL AND "current_destination_id" IS NULL)
    OR ("location_type" = 'DESTINATION' AND "current_cold_storage_id" IS NULL AND "current_vehicle_id" IS NULL AND "current_destination_id" IS NOT NULL)
  );

CREATE INDEX "batches_current_cold_storage_id_idx" ON "batches"("current_cold_storage_id");
CREATE INDEX "batches_current_vehicle_id_idx" ON "batches"("current_vehicle_id");
