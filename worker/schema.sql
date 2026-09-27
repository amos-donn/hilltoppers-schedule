-- Hilltoppers Schedule - D1 schema
--
-- Run this once, in the D1 console: Cloudflare dashboard -> Storage &
-- Databases -> D1 -> (the hilltoppers-schedule database) -> Console, paste the
-- whole file, Execute. It creates tables only; it does not delete anything.
-- Re-running it is safe: every statement is CREATE ... IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- Accounts. One row per signed-in student.
--
-- `google_sub` is the stable Google account identifier (the "sub" claim). It is
-- the login key and never changes, even if the student's email or name does.
-- `profile_id` is the public handle other students use to reach this account;
-- it is separate from the login and from the email on purpose, so a profile can
-- be found and shared without exposing or depending on the email.
--
-- `block_prefs` and `schedule_prefs` hold the student's courses and display
-- settings as JSON, matching the shape the existing card already reads
-- (blockPrefs: per-block course name plus alternating/free flags;
-- schedulePrefs: time format, graduation year, lunch wave). Storing them as
-- JSON keeps the data identical to what the card expects, with no translation
-- step that could drift.
--
-- `auto_grant` is 1 (on) by default: someone who requests a public profile's
-- schedule is given access immediately. Set it to 0 and the owner must approve
-- each request by hand.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub     TEXT    NOT NULL UNIQUE,
  email          TEXT    NOT NULL,
  name           TEXT,                       -- name as Google reports it
  profile_id     TEXT    NOT NULL UNIQUE,    -- public handle, e.g. "quiet-otter-4821"
  display_name   TEXT,                       -- name shown to other students
  is_public      INTEGER NOT NULL DEFAULT 0, -- 0 private, 1 discoverable
  auto_grant     INTEGER NOT NULL DEFAULT 1, -- 1 approve requests automatically
  time_format    TEXT    NOT NULL DEFAULT '12h',
  grade          INTEGER,
  lunch_wave     INTEGER,
  block_prefs    TEXT    NOT NULL DEFAULT '{}',
  schedule_prefs TEXT    NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_public ON accounts (is_public);

-- ---------------------------------------------------------------------------
-- Sessions. One row per active sign-in.
--
-- The browser's cookie holds a long random token; we store only its SHA-256
-- hash, so a copy of this table cannot be used to impersonate anyone. Deleting
-- a row signs that browser out immediately.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);

-- ---------------------------------------------------------------------------
-- Grants. This is an access code: permission for one viewer to see one owner's
-- schedule.
--
-- The code is a secret the app checks but never displays, to either side, so we
-- store only its hash. Revoking stamps `revoked_at`; the viewer stops seeing the
-- schedule on their next load and gets a notice (see `notices`), and they must
-- request access again.
--
-- The UNIQUE constraint is what makes "revoke, then they re-request" clean: one
-- viewer holds at most one grant per owner, so there is never a stale second
-- code quietly still working.
--
-- A grant is required whether the owner's profile is public or private. Public
-- only makes the owner findable; it does not remove the need for a code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash         TEXT    NOT NULL UNIQUE,
  owner_account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  viewer_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  revoked_at        INTEGER,
  UNIQUE (owner_account_id, viewer_account_id)
);

CREATE INDEX IF NOT EXISTS idx_grants_viewer ON grants (viewer_account_id);
CREATE INDEX IF NOT EXISTS idx_grants_owner  ON grants (owner_account_id);

-- ---------------------------------------------------------------------------
-- Requests. Asking someone for their schedule, before any grant exists.
--
-- Only reached when the owner has approval turned on (or always, for a private
-- profile whose ID was shared directly). `status` is one of:
--   pending   waiting on the owner
--   accepted  a grant was created
--   declined  the owner said no
-- Nothing expires on its own.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  from_account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status           TEXT    NOT NULL DEFAULT 'pending',
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  UNIQUE (from_account_id, to_account_id)
);

CREATE INDEX IF NOT EXISTS idx_requests_to ON requests (to_account_id, status);

-- ---------------------------------------------------------------------------
-- Notices. What a student sees about their own profile.
--
-- This is how a revocation reaches the person it affects: the Worker writes a
-- row here, and the student reads it the next time they are signed in. A
-- student who is not signed in sees nothing, which is the intended behaviour -
-- there is no email and no push notification anywhere in this app.
--
-- `seen_at` is null until the student has read it, so the UI can show a count.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,   -- e.g. 'access.revoked', 'request.received'
  payload    TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  seen_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notices_account ON notices (account_id, seen_at);
