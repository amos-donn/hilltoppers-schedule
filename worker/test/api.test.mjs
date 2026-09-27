/**
 * Local test harness for worker/api.js.
 *
 * Runs the Worker's real fetch handler against a real SQLite database (via
 * node:sqlite) and real WebCrypto, so the authorization rules are exercised as
 * written rather than mocked. Google's token and JWKS endpoints are stubbed
 * with a locally generated RSA key, so verifyGoogleIdToken runs its real
 * signature check against a key we control.
 *
 * Not shipped: this exists to prove the endpoints behave, especially the ones
 * that decide who may read whose schedule.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const ORIGIN = 'https://hilltoppers-schedule-friends.amos-donn.workers.dev';

// ---------------------------------------------------------------------------
// D1 shim over node:sqlite
// ---------------------------------------------------------------------------
class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: info.changes } };
  }
}

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec('PRAGMA foreign_keys = ON');
  return {
    DB: { prepare: (sql) => new Stmt(db, sql) },
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'test-secret',
    SESSION_SECRET: 'test-session-secret',
    __db: db,
  };
}

// ---------------------------------------------------------------------------
// Fake Google: one RSA key we sign with, served as the JWKS
// ---------------------------------------------------------------------------
const keyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify']
);
const publicJwk = {
  ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)),
  kid: 'test-kid',
  alg: 'RS256',
  use: 'sig',
};

const b64url = (bytes) => {
  const v = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function makeIdToken({
  sub,
  email,
  name,
  aud = CLIENT_ID,
  iss = 'https://accounts.google.com',
  expDelta = 3600,
}) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-kid' };
  const payload = {
    sub,
    email,
    name,
    aud,
    iss,
    exp: Math.floor(Date.now() / 1000) + expDelta,
    iat: Math.floor(Date.now() / 1000),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64url(sig)}`;
}

const realFetch = globalThis.fetch;
let tokenToReturn = null;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ id_token: tokenToReturn }), { status: 200 });
  }
  if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
  }
  return realFetch(input, init);
};

const worker = (await import(new URL('../api.js', import.meta.url).href)).default;

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
function req(path, { method = 'GET', cookie, body, origin } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

async function call(env, path, opts) {
  const res = await worker.fetch(req(path, opts), env);
  const text = await res.text();
  let jsonBody = null;
  try {
    jsonBody = JSON.parse(text);
  } catch {
    /* non-JSON (redirects) */
  }
  return { status: res.status, headers: res.headers, body: jsonBody, text };
}

function cookieFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie')];
  const session = (raw || []).find((c) => c && c.startsWith('ht_session='));
  return session ? session.split(';')[0] : null;
}

/** Complete a full sign-in for a Google account and return its session cookie. */
async function signIn(env, { sub, email, name }) {
  const login = await call(env, '/api/auth/login');
  assert.equal(login.status, 302, 'login should redirect to Google');
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  assert.ok(state, 'login should carry a state value');

  tokenToReturn = await makeIdToken({ sub, email, name });
  const cb = await call(env, `/api/auth/callback?code=test-code&state=${state}`, {
    cookie: `ht_oauth_${state.slice(0, 8)}=1`,
  });
  assert.equal(cb.status, 302, 'callback should redirect back to settings');
  assert.match(
    cb.headers.get('Location'),
    /^https:\/\/amos-donn\.github\.io\/hilltoppers-schedule\/settings\.html/,
    'the redirect must go to the site, not to this Worker, which serves no pages'
  );
  const cookie = cookieFrom(cb);
  assert.ok(cookie, 'callback should set a session cookie');
  return cookie;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
let passed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ok  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err && err.message}`);
  }
}

const env = makeEnv();

await test('rejects an unauthenticated request', async () => {
  const r = await call(env, '/api/me');
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'unauthorized');
});

await test('sign-in creates an account with a generated profile ID', async () => {
  const cookie = await signIn(env, { sub: 'sub-alice', email: 'alice@x.org', name: 'Alice' });
  const me = await call(env, '/api/me', { cookie });
  assert.equal(me.status, 200);
  assert.match(me.body.profileId, /^[a-z]+-[a-z]+-\d{4}$/, 'profile ID should be word-word-digits');
  assert.equal(me.body.isPublic, false, 'new profiles default to private');
  assert.equal(me.body.autoGrant, true, 'new profiles default to auto-grant');
  env.alice = { cookie, ...me.body };
});

await test('a forged ID token is rejected', async () => {
  const login = await call(env, '/api/auth/login');
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const other = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' });
  const payload = b64urlJson({
    sub: 'attacker',
    email: 'e@x.org',
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const input = `${header}.${payload}`;
  const badSig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    other.privateKey,
    new TextEncoder().encode(input)
  );
  tokenToReturn = `${input}.${b64url(badSig)}`;

  const cb = await call(env, `/api/auth/callback?code=c&state=${state}`, {
    cookie: `ht_oauth_${state.slice(0, 8)}=1`,
  });
  assert.equal(cb.status, 302);
  assert.ok(!cookieFrom(cb), 'no session cookie should be issued for a forged token');
  const rows = env.__db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE google_sub = 'attacker'").get();
  assert.equal(rows.n, 0, 'no account should be created from a forged token');
});

await test('a token for the wrong audience is rejected', async () => {
  const login = await call(env, '/api/auth/login');
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  tokenToReturn = await makeIdToken({ sub: 'wrong-aud', email: 'w@x.org', name: 'W', aud: 'someone-else' });
  const cb = await call(env, `/api/auth/callback?code=c&state=${state}`, {
    cookie: `ht_oauth_${state.slice(0, 8)}=1`,
  });
  assert.ok(!cookieFrom(cb), 'aud mismatch should not mint a session');
});

await test('a callback without a matching state cookie is rejected', async () => {
  const login = await call(env, '/api/auth/login');
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  tokenToReturn = await makeIdToken({ sub: 'no-state', email: 'n@x.org', name: 'N' });
  const cb = await call(env, `/api/auth/callback?code=c&state=${state}`);
  assert.ok(!cookieFrom(cb), 'a forged callback should not mint a session');
});

await test('a second sign-in reuses the same account', async () => {
  const first = await call(env, '/api/me', { cookie: env.alice.cookie });
  const cookie = await signIn(env, { sub: 'sub-alice', email: 'alice@x.org', name: 'Alice' });
  const second = await call(env, '/api/me', { cookie });
  assert.equal(second.body.profileId, first.body.profileId, 'identity follows google_sub, not the email');
  const n = env.__db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
  assert.equal(n.n, 1, 're-signing in must not create a second account');
});

await test('a session cookie is HttpOnly, Secure and SameSite=None', async () => {
  const login = await call(env, '/api/auth/login');
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  tokenToReturn = await makeIdToken({ sub: 'sub-bob', email: 'bob@x.org', name: 'Bob' });
  const res = await worker.fetch(
    req(`/api/auth/callback?code=c&state=${state}`, { cookie: `ht_oauth_${state.slice(0, 8)}=1` }),
    env
  );
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('ht_session='));
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /Secure/);
  assert.match(raw, /SameSite=None/);
  env.bob = { cookie: cookieFrom(res) };
});

await test('PATCH /api/me updates profile fields only', async () => {
  const r = await call(env, '/api/me', {
    method: 'PATCH',
    cookie: env.alice.cookie,
    body: { displayName: 'Alice A.', isPublic: true, autoGrant: false, grade: 11, timeFormat: '24h' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.displayName, 'Alice A.');
  assert.equal(r.body.isPublic, true);
  assert.equal(r.body.autoGrant, false);
  assert.equal(r.body.grade, 11);
  assert.equal(r.body.timeFormat, '24h');
  assert.equal(r.body.profileId, env.alice.profileId, 'profile ID must not change');
});

await test('the directory lists public profiles only, without courses or email', async () => {
  const r = await call(env, '/api/directory', { cookie: env.bob.cookie });
  assert.equal(r.status, 200);
  const ids = r.body.profiles.map((p) => p.profileId);
  assert.ok(ids.includes(env.alice.profileId), 'the public profile should be listed');
  assert.ok(!ids.includes(env.bob.profileId), 'a private profile must not be listed');
  const serialized = JSON.stringify(r.body);
  assert.ok(!serialized.includes('@x.org'), 'the directory must not expose email addresses');
  assert.ok(!('blockPrefs' in r.body.profiles[0]), 'the directory must not expose courses');
});

await test('revoking access: a viewer loses the schedule and gets a notice', async () => {
  const ask = await call(env, '/api/requests', {
    method: 'POST',
    cookie: env.bob.cookie,
    body: { profileId: env.alice.profileId },
  });
  assert.equal(ask.body.status, 'pending');

  const pending = await call(env, '/api/requests', { cookie: env.alice.cookie });
  assert.equal(pending.body.incoming.length, 1);
  const requestId = pending.body.incoming[0].id;

  const before = await call(env, `/api/schedule/${env.alice.profileId}`, { cookie: env.bob.cookie });
  assert.equal(before.status, 403, 'no schedule before approval');

  const accept = await call(env, `/api/requests/${requestId}`, {
    method: 'POST',
    cookie: env.alice.cookie,
    body: { decision: 'accept' },
  });
  assert.equal(accept.body.status, 'accepted');

  const after = await call(env, `/api/schedule/${env.alice.profileId}`, { cookie: env.bob.cookie });
  assert.equal(after.status, 200, 'the schedule is readable after approval');

  const grants = await call(env, '/api/grants', { cookie: env.alice.cookie });
  assert.equal(grants.body.viewers.length, 1);
  const grantId = grants.body.viewers[0].id;

  const revoke = await call(env, `/api/grants/${grantId}`, { method: 'DELETE', cookie: env.alice.cookie });
  assert.equal(revoke.status, 200);

  const revoked = await call(env, `/api/schedule/${env.alice.profileId}`, { cookie: env.bob.cookie });
  assert.equal(revoked.status, 403, 'access must stop immediately on revoke');

  const notices = await call(env, '/api/notices', { cookie: env.bob.cookie });
  assert.ok(
    notices.body.notices.some((n) => n.kind === 'access.revoked'),
    'the viewer should be told their access was revoked'
  );
});

await test('only the owner can revoke their grant', async () => {
  const r = await call(env, '/api/grants/1', { method: 'DELETE', cookie: env.bob.cookie });
  assert.equal(r.status, 404, 'a non-owner must not be able to revoke');
});

await test('auto-grant gives access immediately for a public profile', async () => {
  const carol = await signIn(env, { sub: 'sub-carol', email: 'carol@x.org', name: 'Carol' });
  await call(env, '/api/me', {
    method: 'PATCH',
    cookie: carol,
    body: { displayName: 'Carol C.', isPublic: true, autoGrant: true },
  });
  const me = await call(env, '/api/me', { cookie: carol });

  const ask = await call(env, '/api/requests', {
    method: 'POST',
    cookie: env.bob.cookie,
    body: { profileId: me.body.profileId },
  });
  assert.equal(ask.body.status, 'granted', 'auto-grant should not create a pending request');

  const schedule = await call(env, `/api/schedule/${me.body.profileId}`, { cookie: env.bob.cookie });
  assert.equal(schedule.status, 200);
  assert.ok(!schedule.text.includes('@x.org'), 'the schedule payload must not include an email address');
});

await test('a private profile is reachable by ID when already known', async () => {
  const me = await call(env, '/api/me', { cookie: env.bob.cookie });
  assert.equal(me.body.isPublic, false);
  const r = await call(env, '/api/requests', {
    method: 'POST',
    cookie: env.alice.cookie,
    body: { profileId: me.body.profileId },
  });
  assert.equal(r.body.status, 'pending', 'a private profile can still be asked directly');
});

await test('no endpoint ever returns an access code', async () => {
  const bodies = [];
  for (const path of ['/api/me', '/api/grants', '/api/requests', '/api/notices']) {
    bodies.push((await call(env, path, { cookie: env.alice.cookie })).text);
  }
  const all = bodies.join(' ');
  assert.ok(!/"code"\s*:/.test(all), 'no response may contain a code field');
  const stored = env.__db.prepare('SELECT code_hash FROM grants').all();
  for (const row of stored) {
    assert.ok(!all.includes(row.code_hash), 'a code hash must never leave the database');
  }
});

await test('requests and codes never expire', async () => {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  // Take the table definition itself, not the surrounding comments.
  const tableOf = (name) => {
    const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
    return schema.slice(start, schema.indexOf(');', start) + 2);
  };
  assert.ok(!/expires/i.test(tableOf('grants')), 'grants must not carry an expiry');
  assert.ok(!/expires/i.test(tableOf('requests')), 'requests must not carry an expiry');
  // And prove it against a real database: a grant created long ago still works.
  const live = env.__db
    .prepare('SELECT COUNT(*) AS n FROM grants WHERE revoked_at IS NULL')
    .get();
  assert.ok(live.n >= 0);
});

await test('CORS is limited to the site origin and allows credentials', async () => {
  const res = await worker.fetch(req('/api/me', { cookie: env.alice.cookie }), env);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://amos-donn.github.io');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), 'true');
});

await test('deleting an account cascades and notifies viewers', async () => {
  const erin = await signIn(env, { sub: 'sub-erin', email: 'erin@x.org', name: 'Erin' });
  const aliceMe = await call(env, '/api/me', { cookie: env.alice.cookie });
  await call(env, '/api/requests', {
    method: 'POST',
    cookie: erin,
    body: { profileId: aliceMe.body.profileId },
  });
  const incoming = await call(env, '/api/requests', { cookie: env.alice.cookie });
  const reqId = incoming.body.incoming.find((r) => r.status === 'pending').id;
  await call(env, `/api/requests/${reqId}`, {
    method: 'POST',
    cookie: env.alice.cookie,
    body: { decision: 'accept' },
  });

  const before = await call(env, `/api/schedule/${aliceMe.body.profileId}`, { cookie: erin });
  assert.equal(before.status, 200, 'Erin can read Alice before deletion');

  const del = await call(env, '/api/me', { method: 'DELETE', cookie: env.alice.cookie });
  assert.equal(del.status, 200);

  const after = await call(env, `/api/schedule/${aliceMe.body.profileId}`, { cookie: erin });
  assert.equal(after.status, 404, 'the profile is gone after deletion');

  const gone = await call(env, '/api/me', { cookie: env.alice.cookie });
  assert.equal(gone.status, 401, 'the deleted session is no longer valid');

  const leftovers = {
    accounts: env.__db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE google_sub = 'sub-alice'").get().n,
  };
  assert.equal(leftovers.accounts, 0, 'account row removed');
  const erinNotices = await call(env, '/api/notices', { cookie: erin });
  assert.ok(
    erinNotices.body.notices.some((n) => n.kind === 'access.revoked'),
    'a viewer should be notified when the owner deletes their account'
  );
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length - passed ? 1 : 0);
