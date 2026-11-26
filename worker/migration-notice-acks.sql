-- Run once against the existing database before deploying the Worker that
-- reads it. Safe to run again: CREATE TABLE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS notice_acks (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  answered_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, kind)
);
