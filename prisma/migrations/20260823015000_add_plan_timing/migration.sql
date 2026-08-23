CREATE TYPE "PlanTimingStatus" AS ENUM ('ON_TIME', 'DELAYED');

ALTER TABLE "plans"
ADD COLUMN "timing_status" "PlanTimingStatus" NOT NULL DEFAULT 'ON_TIME',
ADD COLUMN "delayed_by_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "timing_reasons" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "plans"
ADD CONSTRAINT "plans_timing_consistency" CHECK (
  ("timing_status" = 'ON_TIME' AND "delayed_by_seconds" = 0)
  OR ("timing_status" = 'DELAYED' AND "delayed_by_seconds" > 0)
);
