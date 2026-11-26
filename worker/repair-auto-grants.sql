-- Sever every grant that auto approval made, and leave the same access behind
-- as a request the owner can approve. For the D1 console: no "?" placeholders,
-- because the console runs the text as-is with nothing bound to them.
--
-- The rule: an automatic approval wrote the grant and no request row at all, so
-- a live grant with NO request between the same two accounts is one whose owner
-- was never asked. Run 1, read it, then run 2, then 3.

-- 1. LOOK.
SELECT g.id AS grant_id, g.owner_account_id AS owner_account,
       g.viewer_account_id AS viewer_account,
       datetime(g.created_at, 'unixepoch') AS granted_at
  FROM grants g
 WHERE g.revoked_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM requests r
      WHERE r.from_account_id = g.viewer_account_id
        AND r.to_account_id  = g.owner_account_id
   )
 ORDER BY g.created_at;


-- 2. LEAVE A REQUEST. This is the list from step 1, as pending requests, so
--    the two people keep their history and the owner approves with one tap
--    instead of being asked all over again. created_at is the grant's own time.
INSERT INTO requests (from_account_id, to_account_id, status, created_at, decided_at)
SELECT g.viewer_account_id, g.owner_account_id, 'pending', g.created_at, NULL
  FROM grants g
 WHERE g.revoked_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM requests r
      WHERE r.from_account_id = g.viewer_account_id
        AND r.to_account_id  = g.owner_account_id
   )
ON CONFLICT (from_account_id, to_account_id)
DO UPDATE SET status = 'pending', created_at = excluded.created_at, decided_at = NULL;


-- 3. SEVER. Only now does the access go.
UPDATE grants
   SET revoked_at = unixepoch()
 WHERE revoked_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM requests r
      WHERE r.from_account_id = grants.viewer_account_id
        AND r.to_account_id  = grants.owner_account_id
         AND r.status = 'accepted'
   );


-- 4. CHECK. Both should be 0.
SELECT
  (SELECT COUNT(*) FROM grants g
    WHERE g.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM requests r
        WHERE r.from_account_id = g.viewer_account_id
          AND r.to_account_id  = g.owner_account_id
          AND r.status = 'accepted')) AS still_live_without_approval,
  (SELECT COUNT(*) FROM notices) * 0 AS always_zero;
