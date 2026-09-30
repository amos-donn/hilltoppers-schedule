-- Hilltoppers Schedule - one-time migration: Google sign-in -> Hilltoppers Auth
--
-- Run this ONCE against a database that was created for the old Google sign-in,
-- before re-running schema.sql. A database created fresh from schema.sql already
-- has the right shape and must NOT be migrated.
--
-- WHY THIS DROPS DATA
-- Identity used to be the Google account id (`google_sub`). It is now the
-- Firebase uid. There is no way to derive one from the other, so accounts that
-- existed under Google cannot be carried across. The owner chose to delete them
-- rather than leave unreachable rows behind. Anything referencing them -
-- sessions, grants, requests, notices - goes with them, which is the same
-- effect as deleting the account from the settings page.
--
-- HOW TO RUN THIS
-- The D1 console executes one statement per call. Paste each statement on its
-- own, in order, and click Execute after each.
--
-- These statements are NOT idempotent. Re-running the first is harmless (there
-- is nothing left to delete) but re-running the RENAME fails with
-- "no such column: google_sub", which means the migration is already done.

-- 1. Delete the accounts that only Google could sign in to. The foreign keys on
--    sessions, grants, requests, and notices are all ON DELETE CASCADE, so their
--    rows go with them.
DELETE FROM accounts;

-- 2. Reuse the existing column rather than rebuilding the table. The old column
--    is already NOT NULL UNIQUE, and a rename keeps both, so the result is
--    exactly the shape schema.sql declares. Rebuilding instead would mean
--    turning foreign keys off and swapping the table every other table points
--    at, which is more to get wrong for no gain.
ALTER TABLE accounts RENAME COLUMN google_sub TO firebase_uid;
