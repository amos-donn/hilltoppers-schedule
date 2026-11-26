/**
 * Revoke every grant that was made by auto approval.
 *
 * While `auto_grant` was on for an account, asking for its schedule wrote the
 * grant and never created a request row: the owner was never asked, so there is
 * no `accepted` request behind that grant. Every grant that *was* a real
 * decision has one. That difference is the whole test:
 *
 *     live grant, no request row between the same pair  ->  auto approved
 *
 * This script lists those grants, and (with --apply) revokes them the way the
 * owner's own Revoke button does: `revoked_at` is set, and the viewer gets an
 * "access revoked" notice on their next load. Nothing is deleted, so a mistake
 * is one UPDATE away from being undone.
 *
 * It runs as the Worker, not against the database directly, so it needs no
 * credentials here: deploy `worker/api.js` first, then
 *
 *     # look at what would happen (the default)
 *     node worker/revoke-auto-grants.mjs --token <the ADMIN_TOKEN secret>
 *
 *     # do it
 *     node worker/revoke-auto-grants.mjs --token <the ADMIN_TOKEN secret> --apply
 *
 * `--url` overrides the Worker (a local `wrangler dev`, for instance).
 */
const API = process.env.WORKER_URL || 'https://hilltoppers-schedule-friends.amos-donn.workers.dev';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const token = arg('token', process.env.ADMIN_TOKEN);
const apply = process.argv.includes('--apply');
const url = arg('url', API);

if (!token) {
  console.error('Missing --token (or ADMIN_TOKEN). It is the Worker\'s ADMIN_TOKEN secret.');
  process.exit(1);
}

async function call(path, method = 'GET', body) {
  const response = await fetch(url + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

const plan = await call('/api/admin/auto-grants');
console.log(`${plan.grants.length} auto-approved grant(s) are still live.`);
for (const grant of plan.grants) {
  console.log(`  grant ${grant.grantId}: ${grant.viewer} can see ${grant.owner} (since ${new Date(grant.createdAt * 1000).toISOString()})`);
}

if (!plan.grants.length) process.exit(0);
if (!apply) {
  console.log('\nDry run: nothing was changed. Add --apply to revoke these.');
  process.exit(0);
}

const result = await call('/api/admin/auto-grants/revoke', 'POST', {});
console.log(`\nRevoked ${result.revoked} grant(s).`);
if (result.failed) console.error(`Could not revoke ${result.failed} grant(s); run again to retry.`);
process.exit(result.failed ? 1 : 0);
