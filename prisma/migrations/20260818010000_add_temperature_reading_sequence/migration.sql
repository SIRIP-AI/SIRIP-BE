ALTER TABLE "temperature_readings" ADD COLUMN "sequence_number" BIGINT;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "sensor_session_id" ORDER BY "measured_at", "id") - 1 AS "sequence_number"
  FROM "temperature_readings"
)
UPDATE "temperature_readings" AS readings
SET "sequence_number" = ranked."sequence_number"
FROM ranked
WHERE readings."id" = ranked."id";

ALTER TABLE "temperature_readings" ALTER COLUMN "sequence_number" SET NOT NULL;
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_sequence_number_check" CHECK ("sequence_number" >= 0);
CREATE UNIQUE INDEX "temperature_readings_sensor_session_id_sequence_number_key" ON "temperature_readings"("sensor_session_id", "sequence_number");
