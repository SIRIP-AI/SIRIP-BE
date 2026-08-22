ALTER TABLE "plans" RENAME COLUMN "reason" TO "summary";
ALTER TABLE "plan_steps" RENAME COLUMN "notes" TO "rationale";

ALTER TABLE "plans" ADD COLUMN "destination_id" BIGINT;

UPDATE "plans" AS p
SET "destination_id" = candidate."destination_id"
FROM (
  SELECT "plan_id", MIN("destination_id") AS "destination_id"
  FROM "plan_steps"
  WHERE "action_type" = 'DISPATCH' AND "destination_id" IS NOT NULL
  GROUP BY "plan_id"
  HAVING COUNT(DISTINCT "destination_id") = 1
) AS candidate
WHERE p."id" = candidate."plan_id";

CREATE INDEX "plans_destination_id_idx" ON "plans"("destination_id");
ALTER TABLE "plans" ADD CONSTRAINT "plans_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
