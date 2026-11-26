-- Approve automatically, but only for people in your own grade.
--
-- Run once against the deployed database, as a single statement:
--
--   ALTER TABLE accounts ADD COLUMN auto_grant_grade_only INTEGER NOT NULL DEFAULT 0;
--
-- Until this runs, a Worker that knows about the column will fail every account
-- read, so run it before deploying the Worker that uses it.
ALTER TABLE accounts ADD COLUMN auto_grant_grade_only INTEGER NOT NULL DEFAULT 0;
