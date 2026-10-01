-- Hilltoppers Schedule - D1 schema
--
-- HOW TO RUN THIS
-- The D1 console executes one statement per call, so run each statement below
-- on its own, in order, clicking Execute after each. If you paste the whole
-- file at once the console rejects it with "Requests without any query are not
-- supported." The statements are pure CREATEs, so re-running any of them is
-- safe and nothing is ever dropped.
--
-- Upgrading a database created for the old Google sign-in? Run
-- migration-firebase.sql first, then this file.
--
-- Profile data is encrypted by the Worker, so the original `email`, `name`,
-- `profile_id`, `display_name`, `time_format`, `grade`, `lunch_wave`,
-- `block_prefs` and `schedule_prefs` columns are legacy: on a migrated
-- database they hold a placeholder. The real values live in the `_enc`
-- columns (AES-256-GCM) and, where a field has to be found by an exact match,
-- in the `_bidx` blind index. `firebase_uid` is legacy for the same reason.
-- See worker/crypto.js and worker/migration-encrypt-fields.sql. An existing
-- database gets these columns from that migration, not from this file.

CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  firebase_uid   TEXT    NOT NULL UNIQUE,
  email          TEXT    NOT NULL,
  name           TEXT,
  profile_id     TEXT    NOT NULL UNIQUE,
  display_name   TEXT,
  is_public      INTEGER NOT NULL DEFAULT 0,
  auto_grant     INTEGER NOT NULL DEFAULT 0,
  social_web_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (social_web_opt_in IN (0, 1)),
  time_format    TEXT    NOT NULL DEFAULT '12h',
  grade          INTEGER,
  lunch_wave     INTEGER,
  block_prefs    TEXT    NOT NULL DEFAULT '{}',
  schedule_prefs TEXT    NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  firebase_uid_enc  TEXT,
  firebase_uid_bidx TEXT,
  email_enc         TEXT,
  email_bidx        TEXT,
  name_enc          TEXT,
  profile_id_enc    TEXT,
  profile_id_bidx   TEXT,
  display_name_enc  TEXT,
  time_format_enc   TEXT,
  grade_enc         TEXT,
  lunch_wave_enc    TEXT,
  block_prefs_enc   TEXT,
  schedule_prefs_enc TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash         TEXT    NOT NULL UNIQUE,
  owner_account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  viewer_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  revoked_at        INTEGER,
  UNIQUE (owner_account_id, viewer_account_id)
);

CREATE TABLE IF NOT EXISTS requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  from_account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status           TEXT    NOT NULL DEFAULT 'pending',
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  UNIQUE (from_account_id, to_account_id)
);

CREATE TABLE IF NOT EXISTS notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  payload     TEXT    NOT NULL DEFAULT '{}',
  payload_enc TEXT,
  created_at INTEGER NOT NULL,
  seen_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_accounts_public ON accounts (is_public);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);

CREATE INDEX IF NOT EXISTS idx_grants_viewer ON grants (viewer_account_id);

CREATE INDEX IF NOT EXISTS idx_grants_owner ON grants (owner_account_id);

CREATE INDEX IF NOT EXISTS idx_requests_to ON requests (to_account_id, status);

CREATE INDEX IF NOT EXISTS idx_notices_account ON notices (account_id, seen_at);

-- Blind indexes. Unique on the two fields that identify an account, so a
-- lookup can never resolve to two rows. NULL-heavy until every row has been
-- migrated, which a unique index allows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_firebase_uid_bidx ON accounts (firebase_uid_bidx);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_profile_id_bidx ON accounts (profile_id_bidx);

CREATE INDEX IF NOT EXISTS idx_accounts_email_bidx ON accounts (email_bidx);
