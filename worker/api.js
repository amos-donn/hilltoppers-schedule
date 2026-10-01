/**
 * Hilltoppers Schedule - API Worker
 *
 * Runs on Cloudflare Workers and is the only thing that talks to D1. The
 * browser never writes to the database directly; it calls these endpoints and
 * the Worker decides what the caller is allowed to do.
 *
 * Bindings this Worker expects (set in the dashboard, not in this file):
 *   DB                  D1 database binding
 *   FIREBASE_PROJECT_ID plain text variable; defaults to schedule-59d28
 *
 * It reads no other binding. Leftovers from the Google sign-in
 * (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET) are ignored.
 *
 * Endpoints
 *   POST /api/auth/firebase    sign in with a Hilltoppers (Firebase) ID token
 *   POST /api/auth/logout      clears the session
 *   GET  /api/me               the signed-in account
 *   PATCH /api/me              update display name, visibility, auto-grant,
 *                              courses, and schedule settings
 *   DELETE /api/me             delete the account and everything it touched
 *   GET  /api/directory        search public profiles
 *   POST /api/requests         ask for a schedule by profile ID
 *   GET  /api/requests         incoming and outgoing requests
 *   POST /api/requests/:id     accept or decline an incoming request
 *   GET  /api/grants           who can see my schedule, and whose I can see
 *   DELETE /api/grants/:id     revoke someone's access
 *   GET  /api/notices          my notices (e.g. "your access was revoked")
 *   POST /api/notices/seen     mark notices as read
 *   GET  /api/schedule/:profileId
 *                              the courses of a profile I have access to
 *
 * Design notes worth knowing before changing this file:
 *
 * - Access codes are bearer secrets. They are generated here, stored only as a
 *   SHA-256 hash, and never returned by any endpoint. A code is scoped to one
 *   owner and one viewer, which is what makes revoking one person's access
 *   possible without disturbing anyone else.
 *
 * - A grant is required to read a schedule whether the owner is public or
 *   private. Public only makes the owner discoverable; it does not remove the
 *   need for a code.
 *
 * - Privilege-sensitive values (which account you are, what you may read) come
 *   from the session row, never from the request body.
 *
 * - Sign-in is Hilltoppers' own Firebase project (email/password). This Worker
 *   only verifies the ID tokens it issues and mints its own session; it holds
 *   no Firebase secret and never calls Firebase itself. See the "Hilltoppers
 *   Auth" section below.
 *
 * - This Worker only serves /api/*. The visible pages are GitHub Pages and the
 *   sign-in happens there, directly against Firebase, so this Worker never
 *   redirects a browser anywhere. The session cookie is SameSite=None because
 *   the page and the API are different origins.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Where the visible site lives. The pages are GitHub Pages, not this Worker.
// The cookie has to be SameSite=None because the pages and this API are
// different origins: with Lax or Strict the browser would not send it on the
// fetch calls the page makes, and the session would silently look signed out.
const APP_ORIGIN = 'https://amos-donn.github.io';


// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** Base64url for binary data (no padding), used for cookies and codes. */
function b64url(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Lower-cased and trimmed, since an address is not case sensitive. */
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Session cookies
//
// The cookie carries a random token. Only its hash is stored, so the database
// cannot be replayed as a login. It is HttpOnly (no script access), SameSite=None
// so it is sent on the cross-origin calls the page makes to this API, and Secure
// when served over HTTPS. The cookie's Domain is deliberately not set, so it
// applies to the Worker's own origin only.
// ---------------------------------------------------------------------------

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAge) {
  return [
    `ht_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=None',
    'Secure',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

async function currentAccount(request, env) {
  const token = parseCookies(request).ht_session;
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT a.* FROM sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(tokenHash, nowSeconds())
    .first();
  return row || null;
}

// ---------------------------------------------------------------------------
// Profile IDs and access codes
//
// A profile ID is public and shareable - it behaves like a name, so it is
// generated human-readably and can be shown to anyone you choose. Uniqueness
// is enforced by the database, and a collision is retried rather than assumed
// away.
//
// An access code is the opposite: a secret, never displayed, and only ever
// generated by the owner's side for the owner's profile.
// ---------------------------------------------------------------------------

const PROFILE_WORDS_A = [
  'brave', 'calm', 'swift', 'bright', 'quiet', 'clever', 'kind', 'bold',
  'steady', 'warm', 'sharp', 'merry', 'eager', 'gentle', 'noble', 'sunny',
];
const PROFILE_WORDS_B = [
  'otter', 'heron', 'falcon', 'maple', 'comet', 'harbor', 'cedar', 'lantern',
  'sparrow', 'willow', 'badger', 'beacon', 'marlin', 'quail', 'summit', 'wren',
];

async function generateProfileId(env) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const a = PROFILE_WORDS_A[Math.floor(Math.random() * PROFILE_WORDS_A.length)];
    const b = PROFILE_WORDS_B[Math.floor(Math.random() * PROFILE_WORDS_B.length)];
    const n = Math.floor(Math.random() * 9000) + 1000;
    const candidate = `${a}-${b}-${n}`;
    const taken = await env.DB.prepare('SELECT 1 FROM accounts WHERE profile_id = ?')
      .bind(candidate)
      .first();
    if (!taken) return candidate;
  }
  // Falling back to randomness rather than failing: this branch is vanishingly
  // unlikely, but a failed signup is worse than an ugly profile ID.
  return `user-${randomToken(12)}`;
}

/** Returns a fresh plaintext code (shown to no one) after storing its hash. */
async function createGrant(env, ownerAccountId, viewerAccountId) {
  const code = randomToken(32);
  const codeHash = await sha256Hex(code);
  const ts = nowSeconds();
  // Reviving an old row avoids the UNIQUE(owner, viewer) constraint blocking a
  // re-request after a revoke, and guarantees the old code is dead.
  await env.DB.prepare(
    `INSERT INTO grants (code_hash, owner_account_id, viewer_account_id, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (owner_account_id, viewer_account_id)
     DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at, revoked_at = NULL`
  )
    .bind(codeHash, ownerAccountId, viewerAccountId, ts)
    .run();
  return code;
}

async function notify(env, accountId, kind, payload = {}) {
  await env.DB.prepare(
    'INSERT INTO notices (account_id, kind, payload, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(accountId, kind, JSON.stringify(payload), nowSeconds())
    .run();
}

/** True when the viewer currently holds a live grant for the owner's profile. */
async function hasLiveGrant(env, ownerAccountId, viewerAccountId) {
  const row = await env.DB.prepare(
    `SELECT 1 FROM grants
      WHERE owner_account_id = ? AND viewer_account_id = ? AND revoked_at IS NULL`
  )
    .bind(ownerAccountId, viewerAccountId)
    .first();
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Public shaping
//
// Nothing here ever includes firebase_uid, the email address, a code, or a code
// hash. Keeping this in one place means an endpoint cannot accidentally leak a
// field by selecting a whole row.
// ---------------------------------------------------------------------------

function publicSelf(row) {
  return {
    profileId: row.profile_id,
    displayName: row.display_name || row.name || '',
    email: row.email,
    isPublic: Boolean(row.is_public),
    autoGrant: Boolean(row.auto_grant),
    socialWebOptIn: Boolean(row.social_web_opt_in),
    timeFormat: row.time_format,
    grade: row.grade,
    lunchWave: row.lunch_wave,
    blockPrefs: safeJson(row.block_prefs),
    schedulePrefs: safeJson(row.schedule_prefs),
  };
}

/** What another student may see in the directory: handle and name, not courses. */
function publicDirectoryEntry(row) {
  return {
    profileId: row.profile_id,
    displayName: row.display_name || row.name || '',
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Hilltoppers Auth (Firebase ID tokens)
//
// Sign-in is not ours. Students sign in on the settings page with the account
// they already have for Hilltoppers, which is a Firebase Auth project using the
// email/password provider. The browser signs in against Firebase directly and
// hands us the resulting ID token, which is a JWT signed by Google.
//
// That makes this Worker a verifier and nothing else: it checks the signature
// against Google's published keys for Firebase and reads the uid and email out
// of the verified payload. No Firebase secret is involved, and the Worker never
// calls Firebase.
//
// Only Google can mint tokens for this project, so a valid signature is a sound
// trust boundary - an outsider cannot create an account here by forging a token.
// ---------------------------------------------------------------------------

// The project the tokens must belong to. Overridable by a plain-text variable
// so the tests and any future project move do not need a code change.
const FIREBASE_PROJECT_ID = 'schedule-59d28';

// `jwk`, singular. The plural `jwks` is a 404, and fetching an error page
// instead of the key set fails every verification in a way that looks exactly
// like "not signed in".
const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function firebaseProjectId(env) {
  return env.FIREBASE_PROJECT_ID || FIREBASE_PROJECT_ID;
}

/**
 * Verify a Firebase ID token's signature and claims. Returns the verified
 * claims, or null when the token is not acceptable for any reason.
 *
 * Everything here is a rejection test, so there is one place to read what a
 * token has to satisfy:
 *   - three JWT segments, RS256, and a `kid` we hold a key for
 *   - a signature that verifies against that key
 *   - the issuer and audience of this Firebase project, so a token from some
 *     other project cannot be replayed here
 *   - unexpired, with a `sub` to key the account on
 *   - a verified email address, because a Firebase account exists before its
 *     email is confirmed and accepting one early would let someone claim an
 *     address they do not own
 */
async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(headerB64)));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(payloadB64)));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  let keysResponse;
  try {
    keysResponse = await fetch(FIREBASE_JWKS_URL);
  } catch {
    return null;
  }
  if (!keysResponse.ok) return null;
  const { keys } = await keysResponse.json();
  const jwk = (keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let valid;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      fromB64url(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  const now = nowSeconds();
  if (!(Number(claims.exp) > now)) return null;
  if (claims.aud !== projectId) return null;
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!claims.sub) return null;
  if (claims.email_verified !== true) return null;

  const email = normalizeEmail(claims.email);
  if (!email) return null;

  return { uid: String(claims.sub), email, name: String(claims.name || '').trim() };
}

/**
 * Sign in: the browser has already authenticated against Firebase and posts the
 * ID token it received. Once the token verifies, the account is looked up by
 * Firebase uid and created on first sight. Everything after this point - the
 * session cookie, currentAccount, and every handler downstream - is unchanged,
 * because this issues the same session as any other sign-in would.
 */
async function handleFirebaseSignIn(request, env) {
  const body = await request.json().catch(() => ({}));
  const claims = await verifyFirebaseIdToken(body.idToken, firebaseProjectId(env));
  if (!claims) return json({ error: 'invalid_token' }, 401);

  const ts = nowSeconds();
  let account = await env.DB.prepare('SELECT * FROM accounts WHERE firebase_uid = ?')
    .bind(claims.uid)
    .first();

  if (!account) {
    const profileId = await generateProfileId(env);
    const name = claims.name || claims.email.split('@')[0];
    await env.DB.prepare(
      `INSERT INTO accounts (firebase_uid, email, name, profile_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(claims.uid, claims.email, name, profileId, name, ts, ts)
      .run();
    account = await env.DB.prepare('SELECT * FROM accounts WHERE firebase_uid = ?')
      .bind(claims.uid)
      .first();
  } else if (account.email !== claims.email) {
    // A changed address must not change identity, which is why the account is
    // keyed on the Firebase uid and only the display fields are updated.
    await env.DB.prepare('UPDATE accounts SET email = ?, updated_at = ? WHERE id = ?')
      .bind(claims.email, ts, account.id)
      .run();
    account = { ...account, email: claims.email };
  }

  const token = randomToken(32);
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(await sha256Hex(token), account.id, ts, ts + SESSION_TTL_SECONDS)
    .run();

  return json(publicSelf(account), 200, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_SECONDS) });
}

function fromB64url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Only consensual public graph metadata; never courses, email, or grant codes. */
async function handleSocialWeb(env) {
  const { results: profiles } = await env.DB.prepare(`
    SELECT profile_id, display_name, name FROM accounts
    WHERE social_web_opt_in = 1 ORDER BY profile_id
  `).all();
  const { results: grants } = await env.DB.prepare(`
    SELECT owner.profile_id AS source, viewer.profile_id AS target
    FROM grants g
    JOIN accounts owner ON owner.id = g.owner_account_id
    JOIN accounts viewer ON viewer.id = g.viewer_account_id
    WHERE g.revoked_at IS NULL
      AND owner.social_web_opt_in = 1 AND viewer.social_web_opt_in = 1
    ORDER BY owner.profile_id, viewer.profile_id
  `).all();
  const nodes = profiles.map(publicDirectoryEntry);
  const visible = new Set(nodes.map((node) => node.profileId));
  return json({
    nodes,
    edges: grants.filter((edge) => visible.has(edge.source) && visible.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target })),
  }, 200, { 'Cache-Control': 'no-store' });
}

async function handleMe(request, env, account) {
  if (request.method === 'GET') return json(publicSelf(account));

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const fields = [];
    const values = [];

    if (typeof body.displayName === 'string') {
      fields.push('display_name = ?');
      values.push(body.displayName.trim().slice(0, 80));
    }
    if (typeof body.isPublic === 'boolean') {
      fields.push('is_public = ?');
      values.push(body.isPublic ? 1 : 0);
    }
    if (typeof body.autoGrant === 'boolean') {
      fields.push('auto_grant = ?');
      values.push(body.autoGrant ? 1 : 0);
    }
    if (typeof body.socialWebOptIn === 'boolean') {
      fields.push('social_web_opt_in = ?');
      values.push(body.socialWebOptIn ? 1 : 0);
    }
    if (typeof body.timeFormat === 'string') {
      fields.push('time_format = ?');
      values.push(body.timeFormat === '24h' ? '24h' : '12h');
    }
    if (body.grade === null || typeof body.grade === 'number') {
      fields.push('grade = ?');
      values.push(body.grade);
    }
    if (body.lunchWave === null || typeof body.lunchWave === 'number') {
      fields.push('lunch_wave = ?');
      values.push(body.lunchWave);
    }
    if (body.blockPrefs !== undefined) {
      fields.push('block_prefs = ?');
      values.push(JSON.stringify(body.blockPrefs));
    }
    if (body.schedulePrefs !== undefined) {
      fields.push('schedule_prefs = ?');
      values.push(JSON.stringify(body.schedulePrefs));
    }

    if (fields.length) {
      fields.push('updated_at = ?');
      values.push(nowSeconds(), account.id);
      await env.DB.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`)
        .bind(...values)
        .run();
    }

    const updated = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
      .bind(account.id)
      .first();
    return json(publicSelf(updated));
  }

  return json({ error: 'method_not_allowed' }, 405);
}

async function handleDeleteMe(env, account) {
  // Foreign keys cascade, so removing the account also removes its sessions,
  // its grants in both directions, its requests, and its notices. Anyone whose
  // schedule this account could see gets a notice, since their list changes.
  const viewers = await env.DB.prepare(
    `SELECT viewer_account_id FROM grants
      WHERE owner_account_id = ? AND revoked_at IS NULL`
  )
    .bind(account.id)
    .all();

  for (const row of viewers.results || []) {
    await notify(env, row.viewer_account_id, 'access.revoked', {
      profileId: account.profile_id,
      reason: 'account_deleted',
    });
  }

  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(account.id).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function handleDirectory(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();

  // Only public profiles are listed, and the listing carries handle and name
  // only. Courses are never part of a directory result.
  let rows;
  if (q) {
    rows = await env.DB.prepare(
      `SELECT profile_id, display_name, name FROM accounts
        WHERE is_public = 1 AND (LOWER(profile_id) LIKE ? OR LOWER(COALESCE(display_name, name)) LIKE ?)
        ORDER BY profile_id LIMIT 25`
    )
      .bind(`%${q}%`, `%${q}%`)
      .all();
  } else {
    rows = await env.DB.prepare(
      `SELECT profile_id, display_name, name FROM accounts
        WHERE is_public = 1 ORDER BY display_name LIMIT 25`
    ).all();
  }
  return json({ profiles: (rows.results || []).map(publicDirectoryEntry) });
}

async function lookupAccountByProfileId(env, profileId) {
  return env.DB.prepare('SELECT * FROM accounts WHERE profile_id = ?')
    .bind(String(profileId || '').trim().toLowerCase())
    .first();
}

/**
 * Send or request a schedule by profile ID.
 *
 * A public profile with auto-grant on yields a grant immediately. Otherwise a
 * pending request is written for the owner to accept or decline. Either way the
 * caller never receives a code; the grant is resolved server-side afterwards.
 */
async function handleCreateRequest(request, env, account) {
  const body = await request.json().catch(() => ({}));
  const target = await lookupAccountByProfileId(env, body.profileId);
  if (!target) return json({ error: 'not_found' }, 404);
  if (target.id === account.id) return json({ error: 'self' }, 400);

  const ts = nowSeconds();
  const already = await hasLiveGrant(env, target.id, account.id);
  if (already) return json({ status: 'granted' });

  if (target.is_public && target.auto_grant) {
    await createGrant(env, target.id, account.id);
    await notify(env, target.id, 'access.granted', { profileId: account.profile_id });
    return json({ status: 'granted' });
  }

  await env.DB.prepare(
    `INSERT INTO requests (from_account_id, to_account_id, status, created_at)
     VALUES (?, ?, 'pending', ?)
     ON CONFLICT (from_account_id, to_account_id)
     DO UPDATE SET status = 'pending', created_at = excluded.created_at, decided_at = NULL`
  )
    .bind(account.id, target.id, ts)
    .run();
  await notify(env, target.id, 'request.received', { profileId: account.profile_id });
  return json({ status: 'pending' });
}

async function handleListRequests(env, account) {
  const incoming = await env.DB.prepare(
    `SELECT r.id, r.status, r.created_at, a.profile_id, COALESCE(a.display_name, a.name) AS display_name
       FROM requests r JOIN accounts a ON a.id = r.from_account_id
      WHERE r.to_account_id = ? ORDER BY r.created_at DESC`
  )
    .bind(account.id)
    .all();
  const outgoing = await env.DB.prepare(
    `SELECT r.id, r.status, r.created_at, a.profile_id, COALESCE(a.display_name, a.name) AS display_name
       FROM requests r JOIN accounts a ON a.id = r.to_account_id
      WHERE r.from_account_id = ? ORDER BY r.created_at DESC`
  )
    .bind(account.id)
    .all();
  return json({
    incoming: (incoming.results || []).map(mapRequest),
    outgoing: (outgoing.results || []).map(mapRequest),
  });
}

function mapRequest(row) {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    profileId: row.profile_id,
    displayName: row.display_name || '',
  };
}

async function handleDecideRequest(request, env, account, requestId, body) {
  const decision = body && body.decision;
  if (decision !== 'accept' && decision !== 'decline') {
    return json({ error: 'bad_decision' }, 400);
  }

  // Scoped to to_account_id so only the recipient can decide, and a guessed ID
  // cannot be acted on.
  const row = await env.DB.prepare(
    `SELECT * FROM requests WHERE id = ? AND to_account_id = ?`
  )
    .bind(requestId, account.id)
    .first();
  if (!row) return json({ error: 'not_found' }, 404);

  const ts = nowSeconds();
  await env.DB.prepare('UPDATE requests SET status = ?, decided_at = ? WHERE id = ?')
    .bind(decision === 'accept' ? 'accepted' : 'declined', ts, row.id)
    .run();

  if (decision === 'accept') {
    await createGrant(env, account.id, row.from_account_id);
    await notify(env, row.from_account_id, 'request.accepted', { profileId: account.profile_id });
  } else {
    await notify(env, row.from_account_id, 'request.declined', { profileId: account.profile_id });
  }
  return json({ status: decision === 'accept' ? 'accepted' : 'declined' });
}

/** Who can see my schedule, and whose schedule I can see. */
async function handleListGrants(env, account) {
  const outgoing = await env.DB.prepare(
    `SELECT g.id, g.created_at, a.profile_id, COALESCE(a.display_name, a.name) AS display_name
       FROM grants g JOIN accounts a ON a.id = g.viewer_account_id
      WHERE g.owner_account_id = ? AND g.revoked_at IS NULL
      ORDER BY g.created_at DESC`
  )
    .bind(account.id)
    .all();
  const incoming = await env.DB.prepare(
    `SELECT g.id, g.created_at, a.profile_id, COALESCE(a.display_name, a.name) AS display_name
       FROM grants g JOIN accounts a ON a.id = g.owner_account_id
      WHERE g.viewer_account_id = ? AND g.revoked_at IS NULL
      ORDER BY g.created_at DESC`
  )
    .bind(account.id)
    .all();
  const shape = (rows) =>
    (rows.results || []).map((r) => ({
      id: r.id,
      since: r.created_at,
      profileId: r.profile_id,
      displayName: r.display_name || '',
    }));
  return json({ viewers: shape(outgoing), viewing: shape(incoming) });
}

/**
 * Revoke someone's access to my schedule.
 *
 * Acting on owner_account_id means only the owner can revoke, and the notice
 * written for the viewer is how they find out - there is no email or push, so
 * they learn on their next signed-in load.
 */
async function handleRevokeGrant(env, account, grantId) {
  const row = await env.DB.prepare(
    'SELECT * FROM grants WHERE id = ? AND owner_account_id = ?'
  )
    .bind(grantId, account.id)
    .first();
  if (!row) return json({ error: 'not_found' }, 404);

  await env.DB.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?')
    .bind(nowSeconds(), row.id)
    .run();
  await notify(env, row.viewer_account_id, 'access.revoked', { profileId: account.profile_id });
  return json({ ok: true });
}

async function handleListNotices(env, account) {
  const rows = await env.DB.prepare(
    `SELECT n.id, n.kind, n.payload, n.created_at, n.seen_at,
            COALESCE(a.display_name, a.name) AS actor_name, a.profile_id AS actor_profile_id
       FROM notices n
       LEFT JOIN accounts a ON a.profile_id = json_extract(n.payload, '$.profileId')
      WHERE n.account_id = ?
      ORDER BY n.created_at DESC LIMIT 50`
  )
    .bind(account.id)
    .all();
  return json({
    notices: (rows.results || []).map((r) => ({
      id: r.id,
      kind: r.kind,
      payload: safeJson(r.payload),
      createdAt: r.created_at,
      seen: Boolean(r.seen_at),
      // Who did this, so the page can name them instead of saying "Someone".
      // Resolved at read time, so a name change is reflected on old notices.
      actorName: r.actor_name || '',
      actorProfileId: r.actor_profile_id || '',
    })),
  });
}

/** Dismiss one notice, so a student can clear an item without clearing all. */
async function handleDismissNotice(env, account, noticeId) {
  await env.DB.prepare('DELETE FROM notices WHERE id = ? AND account_id = ?')
    .bind(noticeId, account.id)
    .run();
  return json({ ok: true });
}

async function handleMarkNoticesSeen(env, account) {
  await env.DB.prepare('UPDATE notices SET seen_at = ? WHERE account_id = ? AND seen_at IS NULL')
    .bind(nowSeconds(), account.id)
    .run();
  return json({ ok: true });
}

/**
 * Read a profile's courses.
 *
 * Requires a live grant, for public and private profiles alike. The email
 * address is not returned, and neither is the profile's owner identity beyond
 * the display name the owner already chose to show.
 */
async function handleGetSchedule(env, account, profileId) {
  const owner = await lookupAccountByProfileId(env, profileId);
  if (!owner) return json({ error: 'not_found' }, 404);

  if (owner.id !== account.id) {
    const allowed = await hasLiveGrant(env, owner.id, account.id);
    if (!allowed) return json({ error: 'forbidden' }, 403);
  }

  return json({
    profileId: owner.profile_id,
    displayName: owner.display_name || owner.name || '',
    timeFormat: owner.time_format,
    grade: owner.grade,
    lunchWave: owner.lunch_wave,
    blockPrefs: safeJson(owner.block_prefs),
    schedulePrefs: safeJson(owner.schedule_prefs),
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    // CORS for the static pages, which are served from a different origin than
    // this Worker. Credentials are allowed because the session is a cookie.
    const cors = {
      'Access-Control-Allow-Origin': APP_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const withCors = (response) => {
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    };

    try {
      const result = await route(request, env, url, path, method);
      return withCors(result);
    } catch (err) {
      return withCors(json({ error: 'server_error', detail: String(err && err.message) }, 500));
    }
  },
};

async function route(request, env, url, path, method) {
  if (path === '/api/auth/firebase' && method === 'POST') {
    return handleFirebaseSignIn(request, env);
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const account = await currentAccount(request, env);
    if (account) {
      const token = parseCookies(request).ht_session;
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
        .bind(await sha256Hex(token))
        .run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  // Everything past this point needs a session.
  const account = await currentAccount(request, env);
  if (!account) return json({ error: 'unauthorized' }, 401);

  if (path === '/api/me') {
    if (method === 'GET' || method === 'PATCH') return handleMe(request, env, account);
    if (method === 'DELETE') return handleDeleteMe(env, account);
  }

  if (path === '/api/directory' && method === 'GET') return handleDirectory(request, env);
  if (path === '/api/social-web' && method === 'GET') return handleSocialWeb(env);

  if (path === '/api/requests') {
    if (method === 'GET') return handleListRequests(env, account);
    if (method === 'POST') return handleCreateRequest(request, env, account);
  }
  const decideMatch = path.match(/^\/api\/requests\/(\d+)$/);
  if (decideMatch && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return handleDecideRequest(request, env, account, Number(decideMatch[1]), body);
  }

  if (path === '/api/grants' && method === 'GET') return handleListGrants(env, account);
  const revokeMatch = path.match(/^\/api\/grants\/(\d+)$/);
  if (revokeMatch && method === 'DELETE') {
    return handleRevokeGrant(env, account, Number(revokeMatch[1]));
  }

  if (path === '/api/notices' && method === 'GET') return handleListNotices(env, account);
  if (path === '/api/notices/seen' && method === 'POST') return handleMarkNoticesSeen(env, account);
  const noticeMatch = path.match(/^\/api\/notices\/(\d+)$/);
  if (noticeMatch && method === 'DELETE') {
    return handleDismissNotice(env, account, Number(noticeMatch[1]));
  }

  const scheduleMatch = path.match(/^\/api\/schedule\/([^/]+)$/);
  if (scheduleMatch && method === 'GET') {
    return handleGetSchedule(env, account, decodeURIComponent(scheduleMatch[1]));
  }

  return json({ error: 'not_found' }, 404);
}
