CREATE TYPE "ResourceOperationalStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE');

ALTER TABLE "cold_storages" RENAME COLUMN "status" TO "operational_status";
ALTER TABLE "cold_storages"
    ALTER COLUMN "operational_status" TYPE "ResourceOperationalStatus"
    USING (CASE WHEN "operational_status"::text = 'UNAVAILABLE' THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END)::"ResourceOperationalStatus";

ALTER TABLE "vehicles" RENAME COLUMN "status" TO "operational_status";
ALTER TABLE "vehicles"
    ALTER COLUMN "operational_status" TYPE "ResourceOperationalStatus"
    USING (CASE WHEN "operational_status"::text = 'UNAVAILABLE' THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END)::"ResourceOperationalStatus";
ALTER TABLE "vehicles"
    ADD COLUMN "availability_start" TIME,
    ADD COLUMN "availability_end" TIME,
    DROP COLUMN "available_from";
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_availability_window_check"
    CHECK (
        ("availability_start" IS NULL AND "availability_end" IS NULL)
        OR ("availability_start" IS NOT NULL AND "availability_end" IS NOT NULL AND "availability_start" < "availability_end")
    );

DROP TYPE "ColdStorageStatus";
DROP TYPE "VehicleStatus";
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'UNAVAILABLE');
