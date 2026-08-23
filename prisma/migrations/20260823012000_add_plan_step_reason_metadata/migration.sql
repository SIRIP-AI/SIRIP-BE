ALTER TABLE "plan_steps"
  ADD COLUMN "timing_rationale" TEXT,
  ADD COLUMN "latest_safe_at" TIMESTAMPTZ;
