ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_return_batch_check" CHECK (
  ("action_type" = 'RETURN_TO_BASE' AND "batch_id" IS NULL)
  OR ("action_type" <> 'RETURN_TO_BASE' AND "batch_id" IS NOT NULL)
);
