-- Run once in the existing D1 database before deploying the Social web Worker.
-- Existing accounts remain opted out. Do not run on a fresh schema.sql database.
ALTER TABLE accounts ADD COLUMN social_web_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (social_web_opt_in IN (0, 1));
