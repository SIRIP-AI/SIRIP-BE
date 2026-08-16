ALTER TABLE "fishing_trips" ADD COLUMN "deleted_at" TIMESTAMPTZ;
ALTER TABLE "batches" ADD COLUMN "deleted_at" TIMESTAMPTZ;
