-- Hilltoppers Schedule - field encryption migration
--
-- Adds the ciphertext and blind-index columns that worker/api.js writes to.
-- Every profile field on `accounts` moves from its original column into a
-- matching `<field>_enc` column, and every field that is looked up by an exact
-- match also gets a `<field>_bidx` blind index.
--
-- HOW TO RUN THIS
--
-- Run this file BEFORE deploying the updated Worker. The new Worker reads and
-- writes the columns added here, so deploying it first makes every request
-- fail until the migration has been applied.
--
-- The D1 console executes one statement per call, so run each statement below
-- on its own, in order, clicking Execute after each.
--
-- This is deliberately ADDITIVE. It adds columns and indexes and never
-- rebuilds, renames, or drops a table, because `sessions`, `grants`, `requests`
-- and `notices` all carry foreign keys into `accounts`, and dropping the parent
-- table with foreign keys enabled would cascade those rows away. There is no
-- data conversion here either: SQL cannot encrypt, so existing rows are
-- migrated lazily by the Worker the first time each one is read (and the
-- original columns are overwritten with a placeholder at that moment).
--
-- The statements are NOT idempotent - SQLite has no "ADD COLUMN IF NOT
-- EXISTS". Run each statement once. Re-running one fails with "duplicate
-- column name", which is how you tell it is already applied; skip it and carry
-- on. `CREATE INDEX IF NOT EXISTS` is safe to re-run.

ALTER TABLE accounts ADD COLUMN firebase_uid_enc TEXT;
ALTER TABLE accounts ADD COLUMN firebase_uid_bidx TEXT;
ALTER TABLE accounts ADD COLUMN email_enc TEXT;
ALTER TABLE accounts ADD COLUMN email_bidx TEXT;
ALTER TABLE accounts ADD COLUMN name_enc TEXT;
ALTER TABLE accounts ADD COLUMN profile_id_enc TEXT;
ALTER TABLE accounts ADD COLUMN profile_id_bidx TEXT;
ALTER TABLE accounts ADD COLUMN display_name_enc TEXT;
ALTER TABLE accounts ADD COLUMN time_format_enc TEXT;
ALTER TABLE accounts ADD COLUMN grade_enc TEXT;
ALTER TABLE accounts ADD COLUMN lunch_wave_enc TEXT;
ALTER TABLE accounts ADD COLUMN block_prefs_enc TEXT;
ALTER TABLE accounts ADD COLUMN schedule_prefs_enc TEXT;

-- notices.payload holds the profile ID of whoever caused the notice, so it is
-- encrypted too; otherwise the console would still show a handle per notice.
ALTER TABLE notices ADD COLUMN payload_enc TEXT;

-- Unique so that resolving a profile ID cannot match two accounts. Both are
-- NULL for rows that have not been migrated yet, and SQLite allows any number
-- of NULLs in a unique index, so this is safe to create before the lazy
-- migration has run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_firebase_uid_bidx ON accounts (firebase_uid_bidx);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_profile_id_bidx ON accounts (profile_id_bidx);

-- Not unique: two students can legitimately share an address, and nothing in
-- the API looks an account up by email.
CREATE INDEX IF NOT EXISTS idx_accounts_email_bidx ON accounts (email_bidx);

-- VERIFYING
--
-- PRAGMA table_info(accounts);   -- 13 added columns, each showing "1|...|1"
-- PRAGMA index_list(accounts);   -- the four indexes above
--
-- If a column statement failed with "duplicate column name" it is already
-- there. If any statement fails with something else, stop and fix that before
-- deploying the Worker.
--
-- NEXT
--
--   1. wrangler secret put DATA_KEY    (32 random bytes, see worker/README.md)
--   2. deploy the Worker
--
-- Existing rows keep their plaintext in the original columns until each one is
-- next read; the Worker re-encrypts it and overwrites the original on the way
-- out, so the console clears progressively as people use the site.
