ALTER TABLE "cold_storages" ADD COLUMN "user_id" BIGINT;
ALTER TABLE "vehicles" ADD COLUMN "user_id" BIGINT;
ALTER TABLE "destinations" ADD COLUMN "user_id" BIGINT;
ALTER TABLE "sensors" ADD COLUMN "user_id" BIGINT;

WITH owners AS (
    SELECT ss."sensor_id" AS "resource_id", MIN(b."user_id") AS "user_id"
    FROM "sensor_sessions" ss
    JOIN "batches" b ON b."id" = ss."batch_id"
    WHERE b."user_id" IS NOT NULL
    GROUP BY ss."sensor_id"
    HAVING COUNT(DISTINCT b."user_id") = 1
)
UPDATE "sensors" resource SET "user_id" = owners."user_id" FROM owners WHERE resource."id" = owners."resource_id";

WITH ownership_refs AS (
    SELECT "cold_storage_id" AS "resource_id", "user_id" FROM "operational_events" WHERE "cold_storage_id" IS NOT NULL AND "user_id" IS NOT NULL
    UNION ALL
    SELECT ps."cold_storage_id", p."user_id" FROM "plan_steps" ps JOIN "plans" p ON p."id" = ps."plan_id" WHERE ps."cold_storage_id" IS NOT NULL AND p."user_id" IS NOT NULL
), owners AS (
    SELECT "resource_id", MIN("user_id") AS "user_id" FROM ownership_refs GROUP BY "resource_id" HAVING COUNT(DISTINCT "user_id") = 1
)
UPDATE "cold_storages" resource SET "user_id" = owners."user_id" FROM owners WHERE resource."id" = owners."resource_id";

WITH ownership_refs AS (
    SELECT "vehicle_id" AS "resource_id", "user_id" FROM "operational_events" WHERE "vehicle_id" IS NOT NULL AND "user_id" IS NOT NULL
    UNION ALL
    SELECT ps."vehicle_id", p."user_id" FROM "plan_steps" ps JOIN "plans" p ON p."id" = ps."plan_id" WHERE ps."vehicle_id" IS NOT NULL AND p."user_id" IS NOT NULL
), owners AS (
    SELECT "resource_id", MIN("user_id") AS "user_id" FROM ownership_refs GROUP BY "resource_id" HAVING COUNT(DISTINCT "user_id") = 1
)
UPDATE "vehicles" resource SET "user_id" = owners."user_id" FROM owners WHERE resource."id" = owners."resource_id";

WITH ownership_refs AS (
    SELECT "destination_id" AS "resource_id", "user_id" FROM "operational_events" WHERE "destination_id" IS NOT NULL AND "user_id" IS NOT NULL
    UNION ALL
    SELECT ps."destination_id", p."user_id" FROM "plan_steps" ps JOIN "plans" p ON p."id" = ps."plan_id" WHERE ps."destination_id" IS NOT NULL AND p."user_id" IS NOT NULL
), owners AS (
    SELECT "resource_id", MIN("user_id") AS "user_id" FROM ownership_refs GROUP BY "resource_id" HAVING COUNT(DISTINCT "user_id") = 1
)
UPDATE "destinations" resource SET "user_id" = owners."user_id" FROM owners WHERE resource."id" = owners."resource_id";

DROP INDEX "cold_storages_name_key";
DROP INDEX "vehicles_code_key";
DROP INDEX "destinations_name_key";
DROP INDEX "sensors_code_key";

CREATE UNIQUE INDEX "cold_storages_user_id_name_key" ON "cold_storages"("user_id", "name");
CREATE UNIQUE INDEX "vehicles_user_id_code_key" ON "vehicles"("user_id", "code");
CREATE UNIQUE INDEX "destinations_user_id_name_key" ON "destinations"("user_id", "name");
CREATE UNIQUE INDEX "sensors_user_id_code_key" ON "sensors"("user_id", "code");

ALTER TABLE "cold_storages" ADD CONSTRAINT "cold_storages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sensors" ADD CONSTRAINT "sensors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "operational_events" DROP CONSTRAINT "operational_events_vehicle_id_fkey";
ALTER TABLE "operational_events" DROP CONSTRAINT "operational_events_cold_storage_id_fkey";
ALTER TABLE "operational_events" DROP CONSTRAINT "operational_events_destination_id_fkey";
ALTER TABLE "plan_steps" DROP CONSTRAINT "plan_steps_vehicle_id_fkey";
ALTER TABLE "plan_steps" DROP CONSTRAINT "plan_steps_cold_storage_id_fkey";
ALTER TABLE "plan_steps" DROP CONSTRAINT "plan_steps_destination_id_fkey";

ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_cold_storage_id_fkey" FOREIGN KEY ("cold_storage_id") REFERENCES "cold_storages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_cold_storage_id_fkey" FOREIGN KEY ("cold_storage_id") REFERENCES "cold_storages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
