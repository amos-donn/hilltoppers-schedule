-- Revoke every grant that auto approval made, without the Worker script.
--
-- Paste into the Cloudflare dashboard: Workers & Pages -> D1 -> the database ->
-- Console. Run the three blocks in order; each one is meant to be read before
-- the next is run.
--
-- How a grant is identified: an automatic approval wrote the grant row and no
-- request row at all, so a live grant with NO request between the same two
-- accounts is one whose owner was never asked. A grant somebody actually
-- approved has its 'accepted' request. Nothing here looks at the auto_grant
-- flag or at dates, because both can disagree with how a given grant came about.


-- 1. LOOK. The grants that would be revoked, with the pair of account ids.
--    Names are encrypted in the table, so the console can only show ids; the
--    worker/revoke-auto-grants.mjs script prints the profile IDs instead.
SELECT g.id        AS grant_id,
       g.owner_account_id  AS owner_account,
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


-- 2. REVOKE. Re-run the same WHERE, so nothing outside step 1's list is touched.
--    This is the owner's own Revoke button, applied in bulk: revoked_at is set,
--    rows and codes stay, and a grant that was already revoked is skipped.
UPDATE grants
   SET revoked_at = unixepoch()
 WHERE revoked_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM requests r
      WHERE r.from_account_id = grants.viewer_account_id
        AND r.to_account_id  = grants.owner_account_id
   );


-- 3. CHECK. Should be 0, and step 1 should now return no rows.
SELECT COUNT(*) AS still_live
  FROM grants g
 WHERE g.revoked_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM requests r
      WHERE r.from_account_id = g.viewer_account_id
        AND r.to_account_id  = g.owner_account_id
   );


-- Not done here, on purpose: the "access revoked" notice each viewer would get.
-- It is encrypted with the Worker's DATA_KEY, which SQL cannot reach, so a
-- notice cannot be written by hand without leaving plainly broken rows. Viewers
-- find out when the schedule stops loading (403) and their page shows it as no
-- access rather than as an error. If you want them told in the app, revoke with
-- worker/revoke-auto-grants.mjs instead, which sends the real notice.


-- What this file cannot do: the one-time notice every student sees on their
-- next load. A notice is encrypted with the Worker's DATA_KEY, so it cannot be
-- written from SQL without leaving a row the page cannot read. That notice is
-- written by POST /api/admin/auto-grants/repair, which does steps 2 and the
-- notices together. The code for it lives in worker/api.js only until that
-- deploy, so nothing else in this repository needs to change with it.
