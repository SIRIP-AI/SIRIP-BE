ALTER TABLE "fishing_trips" ADD COLUMN "user_id" BIGINT;

WITH owners AS (
    SELECT "fishing_trip_id" AS "trip_id", MIN("user_id") AS "user_id"
    FROM "batches"
    WHERE "fishing_trip_id" IS NOT NULL AND "user_id" IS NOT NULL
    GROUP BY "fishing_trip_id"
    HAVING COUNT(DISTINCT "user_id") = 1
)
UPDATE "fishing_trips" trip SET "user_id" = owners."user_id" FROM owners WHERE trip."id" = owners."trip_id";

UPDATE "batches" batch
SET "fishing_trip_id" = NULL
FROM "fishing_trips" trip
WHERE batch."fishing_trip_id" = trip."id"
  AND batch."user_id" IS NOT NULL
  AND trip."user_id" IS DISTINCT FROM batch."user_id";

DROP INDEX "fishing_trips_code_key";
DROP INDEX "batches_code_key";

CREATE UNIQUE INDEX "fishing_trips_user_id_code_key" ON "fishing_trips"("user_id", "code");
CREATE UNIQUE INDEX "fishing_trips_legacy_code_key" ON "fishing_trips"("code") WHERE "user_id" IS NULL;
CREATE UNIQUE INDEX "batches_user_id_code_key" ON "batches"("user_id", "code");
CREATE UNIQUE INDEX "batches_legacy_code_key" ON "batches"("code") WHERE "user_id" IS NULL;

ALTER TABLE "fishing_trips" ADD CONSTRAINT "fishing_trips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION enforce_batch_fishing_trip_ownership() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."fishing_trip_id" IS NOT NULL AND NEW."user_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "fishing_trips"
    WHERE "id" = NEW."fishing_trip_id" AND "user_id" = NEW."user_id" AND "deleted_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'batch and fishing trip must have the same owner';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "batches_require_owned_fishing_trip"
BEFORE INSERT OR UPDATE OF "user_id", "fishing_trip_id" ON "batches"
FOR EACH ROW EXECUTE FUNCTION enforce_batch_fishing_trip_ownership();
