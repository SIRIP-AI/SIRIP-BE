CREATE TABLE "plan_batches" (
    "plan_id" BIGINT NOT NULL,
    "batch_id" BIGINT NOT NULL,
    CONSTRAINT "plan_batches_pkey" PRIMARY KEY ("plan_id", "batch_id")
);

INSERT INTO "plan_batches" ("plan_id", "batch_id")
SELECT DISTINCT "plan_id", "batch_id" FROM "plan_steps";

CREATE INDEX "plan_batches_batch_id_idx" ON "plan_batches"("batch_id");

ALTER TABLE "plan_batches" ADD CONSTRAINT "plan_batches_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_batches" ADD CONSTRAINT "plan_batches_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "one_active_plan_per_user";
DROP INDEX "one_active_legacy_plan";
