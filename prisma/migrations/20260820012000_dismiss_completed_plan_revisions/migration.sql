UPDATE "plans" revision
SET "status" = 'DISMISSED'
WHERE revision."status" = 'PROPOSED'
  AND revision."previous_plan_id" IN (
    SELECT p."id" FROM "plans" p WHERE p."status" = 'COMPLETED'
  );
