ALTER TABLE "sensors"
ADD COLUMN "pending_reading_count" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "sensors_pending_reading_count_check" CHECK ("pending_reading_count" >= 0);

UPDATE "temperature_readings" AS reading
SET "reading_uid" = sensor."device_uid" || ':' || reading."sequence_number"
FROM "sensor_sessions" AS session
JOIN "sensors" AS sensor ON sensor."id" = session."sensor_id"
WHERE reading."sensor_session_id" = session."id";
