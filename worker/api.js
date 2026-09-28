/**
 * Hilltoppers Schedule - API Worker
 *
 * Runs on Cloudflare Workers and is the only thing that talks to D1. The
 * browser never writes to the database directly; it calls these endpoints and
 * the Worker decides what the caller is allowed to do.
 *
 * Bindings this Worker expects (set in the dashboard, not in this file):
 *   DB                 D1 database binding
 *   GOOGLE_CLIENT_ID   plain text variable
 *   GOOGLE_CLIENT_SECRET  secret
 *   SESSION_SECRET     secret
 *
 * Endpoints
 *   GET  /api/auth/login       redirect to Google
 *   GET  /api/auth/callback    Google returns here; sets the session cookie
 *   POST /api/auth/logout      clears the session
 *   GET  /api/me               the signed-in account
 *   PATCH /api/me              update display name, visibility, auto-grant,
 *                              courses, and schedule settings
 *   POST /api/me/email         start changing the account's email; returns the
 *                              Google URL that proves the new address
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
 * - This Worker only serves /api/*. The visible pages are GitHub Pages, so
 *   after sign-in the browser is redirected to APP_URL, not back here, and the
 *   session cookie is SameSite=None because the page and the API are different
 *   origins.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// How long an in-progress email change stays valid. Short, because the whole
// thing is one round trip through Google: ask, then come back.
const EMAIL_CHANGE_TTL_SECONDS = 60 * 15;

// Where the visible site lives. The pages are GitHub Pages, not this Worker,
// so a redirect back to this origin after sign-in would land on nothing. The
// cookie has to be SameSite=None because the pages and this API are different
// origins: with Lax or Strict the browser would not send it on the fetch calls
// the page makes, and the session would silently look signed out.
const APP_URL = 'https://amos-donn.github.io/hilltoppers-schedule';
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

function utf8B64url(text) {
  return b64url(new TextEncoder().encode(text));
}

function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
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
// cannot be replayed as a login. It is HttpOnly (no script access), SameSite=Lax
// (survives the redirect back from Google while still blocking cross-site POSTs)
// and Secure when served over HTTPS. The cookie's Domain is deliberately not set,
// so it applies to the Worker's own origin only.
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
// Nothing here ever includes google_sub, the email address, a code, or a code
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
// Google OAuth
// ---------------------------------------------------------------------------

function googleCookieName(state) {
  return `ht_oauth_${state.slice(0, 8)}`;
}

/** Compare two strings without leaking where they first differ. */
function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/**
 * An email change is a two-step flow: the page asks for a Google sign-in
 * against the address the student typed, then Google sends the browser back
 * here. Nothing about the change may be trusted from the callback's query
 * string, so the account it belongs to and the address being claimed are
 * signed into a state token that only this Worker can mint.
 */
async function issueEmailChangeState(env, accountId, newEmail) {
  const payload = utf8B64url(JSON.stringify({
    a: accountId,
    e: newEmail,
    exp: nowSeconds() + EMAIL_CHANGE_TTL_SECONDS,
    n: randomToken(8),
  }));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** Verify the signature and expiry; returns {a, e} or null. */
async function readEmailChangeState(env, state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  let expected;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    expected = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, sig)) return null;

  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  } catch {
    return null;
  }
  if (!data || typeof data.a !== 'number' || typeof data.e !== 'string') return null;
  if (Number(data.exp) <= nowSeconds()) return null;
  return data;
}

/** Lower-cased and trimmed, since an address is not case sensitive. */
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * A deliberately loose shape check. Google is the authority on whether an
 * address exists; this only rejects obvious nonsense before a redirect.
 */
function isPlausibleEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function authLogin(request, env) {
  const url = new URL(request.url);
  const state = randomToken(16);
  const redirectUri = `${url.origin}/api/auth/callback`;

  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorize.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid email profile');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('prompt', 'select_account');

  // The state is compared on return to reject a forged callback.
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Set-Cookie': `${googleCookieName(state)}=1; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
    },
  });
}

async function authCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const failRedirect = new Response(null, {
    status: 302,
    headers: { Location: `${APP_URL}/settings.html?auth=error` },
  });

  if (error || !code || !state) return failRedirect;

  // An email change rides the same callback. Its state is signed rather than a
  // random cookie value, so it is recognised by verifying the signature. A
  // plain sign-in state is a bare random token and will not verify, so the two
  // cannot be confused for one another.
  const emailChange = await readEmailChangeState(env, state);
  if (emailChange) return completeEmailChange(request, env, url, code, emailChange);

  const cookies = parseCookies(request);
  if (!cookies[googleCookieName(state)]) return failRedirect;

  // Exchange the code for tokens. The client secret stays on the server.
  const claims = await googleClaimsFromCode(url, env, code);
  if (!claims) return failRedirect;

  const googleSub = String(claims.sub);
  const email = String(claims.email || '').toLowerCase();
  const name = String(claims.name || '').trim();
  const ts = nowSeconds();

  let account = await env.DB.prepare('SELECT * FROM accounts WHERE google_sub = ?')
    .bind(googleSub)
    .first();

  if (!account) {
    const profileId = await generateProfileId(env);
    await env.DB.prepare(
      `INSERT INTO accounts (google_sub, email, name, profile_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(googleSub, email, name, profileId, name, ts, ts)
      .run();
    account = await env.DB.prepare('SELECT * FROM accounts WHERE google_sub = ?')
      .bind(googleSub)
      .first();
  } else if (account.email !== email || account.name !== name) {
    // A changed name or email must not change identity, which is why the
    // account is keyed on google_sub and only these display fields are updated.
    await env.DB.prepare('UPDATE accounts SET email = ?, name = ?, updated_at = ? WHERE id = ?')
      .bind(email, name, ts, account.id)
      .run();
    account = { ...account, email, name };
  }

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(tokenHash, account.id, ts, ts + SESSION_TTL_SECONDS)
    .run();

  const headers = new Headers({
    Location: `${APP_URL}/settings.html?auth=ok`,
  });
  headers.append('Set-Cookie', sessionCookie(token, SESSION_TTL_SECONDS));
  headers.append('Set-Cookie', `${googleCookieName(state)}=; Path=/; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}

/**
 * Trade the authorization code for an ID token and verify it. Shared by the
 * sign-in callback and the email-change callback, which differ only in what
 * they do with the verified claims.
 */
async function googleClaimsFromCode(url, env, code) {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/api/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenResponse.ok) return null;
  const tokens = await tokenResponse.json();
  if (!tokens.id_token) return null;

  // The ID token is a JWT signed by Google. Verify the signature against
  // Google's published keys and check the claims that matter, rather than
  // trusting the payload, so a forged token cannot mint a session.
  return verifyGoogleIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID);
}

/**
 * Finish an email change: the student signed in with Google and the address
 * Google reports must be the one they typed, or someone could point an
 * account at an address they do not control.
 *
 * The account is identified by the signed state, never by the email, so
 * proving control of the address is what moves the account, and a Google
 * account that already owns a row here is refused rather than merged.
 */
async function completeEmailChange(request, env, url, code, change) {
  const fail = (reason) => new Response(null, {
    status: 302,
    headers: { Location: `${APP_URL}/settings.html?email=${reason}` },
  });

  const claims = await googleClaimsFromCode(url, env, code);
  if (!claims) return fail('error');

  const googleEmail = normalizeEmail(claims.email);
  const googleSub = String(claims.sub || '');

  // Google must confirm the exact address that was asked for.
  if (!googleEmail || googleEmail !== change.e) return fail('mismatch');

  const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
    .bind(change.a)
    .first();
  if (!account) return fail('error');

  // Someone else already signed in with this Google account. Their row owns
  // this google_sub, so the address is not free to take.
  const subTaken = await env.DB.prepare('SELECT id FROM accounts WHERE google_sub = ? AND id != ?')
    .bind(googleSub, account.id)
    .first();
  if (subTaken) return fail('taken');

  // The same address may already be attached to another row (for example the
  // other account was created before this one), and accounts.email is not
  // UNIQUE, so this check is what enforces the rule.
  const emailTaken = await env.DB.prepare(
    'SELECT id FROM accounts WHERE LOWER(email) = ? AND id != ?'
  )
    .bind(googleEmail, account.id)
    .first();
  if (emailTaken) return fail('taken');

  const name = String(claims.name || '').trim() || account.name;
  await env.DB.prepare(
    'UPDATE accounts SET google_sub = ?, email = ?, name = ?, updated_at = ? WHERE id = ?'
  )
    .bind(googleSub, googleEmail, name, nowSeconds(), account.id)
    .run();

  // The student proved control of the new address, so the browser that comes
  // back from Google is theirs. Handing it a fresh session keeps them signed
  // in as the same account, now under the new address.
  const token = randomToken(32);
  const ts = nowSeconds();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(await sha256Hex(token), account.id, ts, ts + SESSION_TTL_SECONDS)
    .run();

  const headers = new Headers({
    Location: `${APP_URL}/settings.html?email=ok#account`,
  });
  headers.append('Set-Cookie', sessionCookie(token, SESSION_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

/** Verify a Google ID token's signature and claims. Returns claims or null. */
async function verifyGoogleIdToken(idToken, clientId) {
  const parts = idToken.split('.');
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

  const keysResponse = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!keysResponse.ok) return null;
  const { keys } = await keysResponse.json();
  const jwk = (keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    fromB64url(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) return null;

  const now = nowSeconds();
  if (Number(claims.exp) <= now) return null;
  if (claims.aud !== clientId) return null;
  if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') return null;
  if (!claims.sub) return null;

  return claims;
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

/**
 * Start an email change. The address is checked here so the student finds out
 * about a collision before being sent through Google, and again on the way
 * back, because the two checks can disagree if someone else moves first.
 *
 * Nothing is written yet: the change only happens once Google has confirmed
 * the address, which is what completeEmailChange is for.
 */
async function handleStartEmailChange(request, env, account) {
  const body = await request.json().catch(() => ({}));
  const newEmail = normalizeEmail(body.email);

  if (!isPlausibleEmail(newEmail)) {
    return json({ error: 'invalid_email' }, 400);
  }

  if (newEmail === normalizeEmail(account.email)) {
    return json({ error: 'same_email' }, 400);
  }

  const taken = await env.DB.prepare('SELECT id FROM accounts WHERE LOWER(email) = ? AND id != ?')
    .bind(newEmail, account.id)
    .first();
  if (taken) return json({ error: 'email_taken' }, 409);

  const state = await issueEmailChangeState(env, account.id, newEmail);
  const url = new URL(request.url);
  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorize.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${url.origin}/api/auth/callback`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid email profile');
  authorize.searchParams.set('state', state);
  // select_account is not enough here: a browser already signed into one Google
  // account would otherwise silently reuse it, and the address it reports would
  // not be the one being claimed.
  authorize.searchParams.set('prompt', 'select_account');
  authorize.searchParams.set('login_hint', newEmail);

  return json({ authorizeUrl: authorize.toString() });
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
  if (path === '/api/auth/login' && method === 'GET') return authLogin(request, env);
  if (path === '/api/auth/callback' && method === 'GET') return authCallback(request, env);

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

  if (path === '/api/me/email' && method === 'POST') {
    return handleStartEmailChange(request, env, account);
  }

  if (path === '/api/me') {
    if (method === 'GET' || method === 'PATCH') return handleMe(request, env, account);
    if (method === 'DELETE') return handleDeleteMe(env, account);
  }

  if (path === '/api/directory' && method === 'GET') return handleDirectory(request, env);

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
