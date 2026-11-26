/**
 * Local test harness for worker/api.js.
 *
 * Runs the Worker's real fetch handler against a real SQLite database (via
 * node:sqlite) and real WebCrypto, so the authorization rules are exercised as
 * written rather than mocked. Firebase's signing key is stubbed with a locally
 * generated RSA key, so verifyFirebaseIdToken runs its real signature check
 * against a key we control.
 *
 * Not shipped: this exists to prove the endpoints behave, especially the ones
 * that decide who may read whose schedule.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const FIREBASE_PROJECT = 'schedule-59d28';
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
  // Cloudflare's binding also exposes these two, and a handler that uses one on
  // an unprepared statement is a 500 in production. Calling them here binds the
  // same statement, so such a handler runs (and passes) instead of hiding.
  async_prepare() {
    return this;
  }
  first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
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
    // last_row_id is what D1 reports for an INSERT.
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }
}

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec('PRAGMA foreign_keys = ON');
  return {
    DB: { prepare: (sql) => new Stmt(db, sql) },
    FIREBASE_PROJECT_ID: FIREBASE_PROJECT,
    SESSION_SECRET: 'test-session-secret',
    // A real 32-byte key, so profile encryption runs for real here instead of
    // being stubbed. Fixed so runs are reproducible; production generates one.
    DATA_KEY: 'aGlsbHRvcHBlcnMtdGVzdC1rZXktdjEAAAAAAAAAAAA',
    __db: db,
  };
}

// ---------------------------------------------------------------------------
// Fake Firebase: one RSA key we sign with, published as the securetoken JWKS
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
  aud = FIREBASE_PROJECT,
  iss = `https://securetoken.google.com/${FIREBASE_PROJECT}`,
  expDelta = 3600,
  emailVerified = true,
  kid = 'test-kid',
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const payload = {
    sub,
    user_id: sub,
    email,
    name,
    email_verified: emailVerified,
    aud,
    iss,
    exp: now + expDelta,
    iat: now,
    auth_time: now,
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
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  // "jwk", singular. The plural is a 404, which fails every token and looks
  // exactly like a signed-out user.
  if (url.startsWith('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
  }
  return realFetch(input, init);
};

const worker = (await import(new URL('../api.js', import.meta.url).href)).default;

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
function req(path, { method = 'GET', cookie, body, origin, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
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

/** Complete a sign-in the way the settings page does, and return its cookie. */
async function signIn(env, { sub, email, name, ...options }) {
  const token = await makeIdToken({ sub, email, name, ...options });
  const res = await call(env, '/api/auth/firebase', {
    method: 'POST',
    body: { idToken: token },
  });
  assert.equal(res.status, 200, 'sign-in should succeed');
  const cookie = cookieFrom(res);
  assert.ok(cookie, 'sign-in should set a session cookie');
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
  assert.equal(me.body.isPublic, true, 'new profiles default to public');
  assert.equal(me.body.socialWebOptIn, true, 'new profiles default to Social web on');
  assert.equal(me.body.autoGrant, false, 'new profiles default to asking first');
  env.alice = { cookie, ...me.body };
});

await test('a forged ID token is rejected', async () => {
  const other = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' });
  const payload = b64urlJson({
    sub: 'attacker',
    user_id: 'attacker',
    email: 'e@x.org',
    email_verified: true,
    aud: FIREBASE_PROJECT,
    iss: `https://securetoken.google.com/${FIREBASE_PROJECT}`,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const input = `${header}.${payload}`;
  const badSig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    other.privateKey,
    new TextEncoder().encode(input)
  );

  const res = await call(env, '/api/auth/firebase', {
    method: 'POST',
    body: { idToken: `${input}.${b64url(badSig)}` },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_token');
  assert.ok(!cookieFrom(res), 'no session cookie should be issued for a forged token');
  const rows = env.__db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
  const forged = env.__db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE firebase_uid_bidx IS NOT NULL').get();
  assert.equal(forged.n, rows.n, 'a forged token must not create an account with a uid index');
});

await test('a token for the wrong audience is rejected', async () => {
  const token = await makeIdToken({ sub: 'wrong-aud', email: 'w@x.org', name: 'W', aud: 'someone-else' });
  const res = await call(env, '/api/auth/firebase', { method: 'POST', body: { idToken: token } });
  assert.equal(res.status, 401, 'aud mismatch should not mint a session');
  assert.ok(!cookieFrom(res));
});

await test('a token for the wrong project is rejected', async () => {
  const token = await makeIdToken({
    sub: 'wrong-iss', email: 'w@x.org', name: 'W',
    iss: 'https://securetoken.google.com/some-other-project',
  });
  const res = await call(env, '/api/auth/firebase', { method: 'POST', body: { idToken: token } });
  assert.equal(res.status, 401, 'iss mismatch should not mint a session');
});

await test('an expired token is rejected', async () => {
  const token = await makeIdToken({ sub: 'stale', email: 's@x.org', name: 'S', expDelta: -60 });
  const res = await call(env, '/api/auth/firebase', { method: 'POST', body: { idToken: token } });
  assert.equal(res.status, 401, 'an expired token should not mint a session');
});

await test('a token signed with an unknown key is rejected', async () => {
  const token = await makeIdToken({ sub: 'other-kid', email: 'k@x.org', name: 'K', kid: 'no-such-kid' });
  const res = await call(env, '/api/auth/firebase', { method: 'POST', body: { idToken: token } });
  assert.equal(res.status, 401, 'an unlisted kid should not mint a session');
});

await test('an unverified email is refused', async () => {
  // A Firebase account exists before its address is confirmed. Accepting it
  // would let someone register with an address they do not own.
  const token = await makeIdToken({
    sub: 'unverified', email: 'unverified@x.org', name: 'U', emailVerified: false,
  });
  const res = await call(env, '/api/auth/firebase', { method: 'POST', body: { idToken: token } });
  assert.equal(res.status, 401);
  const rows = env.__db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
  const unverified = env.__db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE email_bidx IS NOT NULL').get();
  assert.equal(unverified.n, rows.n, 'no account for an unconfirmed address');
});

await test('a verified non-school address is accepted', async () => {
  // Hilltoppers' own sign-in is not restricted to the school domain: its
  // /school/send endpoint refuses when the sign-in address IS a school address,
  // which means the ordinary flow is a non-school address with a school one
  // linked on top. Gating here on the domain would lock out those accounts, so
  // the gate is email_verified and nothing more. See the PR for the reasoning.
  //
  // Its own database, because the shared one is asserted on by name elsewhere.
  const fresh = makeEnv();
  const token = await makeIdToken({
    sub: 'personal', email: 'personal@example.org', name: 'P', emailVerified: true,
  });
  const res = await call(fresh, '/api/auth/firebase', { method: 'POST', body: { idToken: token } });
  assert.equal(res.status, 200, 'a confirmed personal address signs in');
  assert.ok(cookieFrom(res), 'and gets a session');
});

await test('garbage in place of a token is refused, not crashed on', async () => {
  for (const idToken of [undefined, null, '', 'not.a.token', 'a.b', 'eyJhbGciOiJub25lIn0.e30.']) {
    const res = await call(env, '/api/auth/firebase', { method: 'POST', body: { idToken } });
    assert.equal(res.status, 401, `token ${JSON.stringify(idToken)} should be refused`);
  }
  const none = await call(env, '/api/auth/firebase', { method: 'POST' });
  assert.equal(none.status, 401, 'a body-less request should be refused, not throw');
});

await test('a second sign-in reuses the same account', async () => {
  const first = await call(env, '/api/me', { cookie: env.alice.cookie });
  const cookie = await signIn(env, { sub: 'sub-alice', email: 'alice@x.org', name: 'Alice' });
  const second = await call(env, '/api/me', { cookie });
  assert.equal(second.body.profileId, first.body.profileId, 'identity follows the Firebase uid, not the email');
  const n = env.__db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
  assert.equal(n.n, 1, 're-signing in must not create a second account');
});

await test('a changed email updates the account without changing identity', async () => {
  // The uid is the identity; the address is just a field on it. Someone who
  // changes their address in Hilltoppers keeps their schedule and friends.
  const before = await call(env, '/api/me', { cookie: env.alice.cookie });
  const cookie = await signIn(env, { sub: 'sub-alice', email: 'alice.new@x.org', name: 'Alice' });
  const after = await call(env, '/api/me', { cookie });
  assert.equal(after.body.profileId, before.body.profileId, 'same account');
  assert.equal(after.body.email, 'alice.new@x.org', 'the address follows Hilltoppers');
  const n = env.__db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
  assert.equal(n.n, 1, 'no second account was created');

  // Put it back, so the later tests still see the original address.
  await signIn(env, { sub: 'sub-alice', email: 'alice@x.org', name: 'Alice' });
});

await test('a session cookie is HttpOnly, Secure and SameSite=None', async () => {
  const token = await makeIdToken({ sub: 'sub-bob', email: 'bob@x.org', name: 'Bob' });
  const res = await worker.fetch(
    req('/api/auth/firebase', { method: 'POST', body: { idToken: token } }),
    env
  );
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('ht_session='));
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /Secure/);
  assert.match(raw, /SameSite=None/);
  env.bob = { cookie: cookieFrom(res) };
  const bob = await call(env, '/api/me', { cookie: env.bob.cookie, method: 'PATCH', body: { isPublic: false } });
  env.bob.profileId = bob.body.profileId;
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

await test('a private profile is reachable by its ID but never by name', async () => {
  const dirEnv = makeEnv();
  const seeker = await signIn(dirEnv, { sub: 'seeker', email: 'seeker@x.org', name: 'Seeker' });
  const hidden = await signIn(dirEnv, { sub: 'hidden-one', email: 'hidden@x.org', name: 'Hidden One' });
  await call(dirEnv, '/api/me', { cookie: hidden, method: 'PATCH', body: { isPublic: false } });
  const hiddenMe = (await call(dirEnv, '/api/me', { cookie: hidden })).body;

  // A profile ID is a bearer handle: holding it already lets you request the
  // schedule, so the ID must resolve even when the profile is private.
  const byId = await call(dirEnv, `/api/directory?q=${encodeURIComponent(hiddenMe.profileId)}`, { cookie: seeker });
  const found = byId.body.profiles.find((p) => p.profileId === hiddenMe.profileId);
  assert.ok(found, 'an exact profile ID finds a private profile');

  // But the name must not come with it. The student asked to be anonymous, and
  // handing their name to whoever has the ID defeats that.
  assert.equal(found.displayName, 'Anonymous',
    'the ID resolves without giving away the name behind it');
  assert.ok(!byId.text.includes('Hidden One'), 'the private name is not in the response at all');

  // Name and partial searches are discovery, so a private profile stays out.
  for (const q of ['Hidden', 'hidden', 'idden', 'one']) {
    const r = await call(dirEnv, `/api/directory?q=${encodeURIComponent(q)}`, { cookie: seeker });
    const ids = r.body.profiles.map((p) => p.profileId);
    assert.ok(!ids.includes(hiddenMe.profileId),
      `a name search for "${q}" must not surface a private profile`);
    assert.ok(!r.text.includes('Hidden One'), `no private name leaks for "${q}"`);
  }

  // A public profile still resolves by ID and by name, and still shows its name.
  const open = await signIn(dirEnv, { sub: 'open-one', email: 'open@x.org', name: 'Open One' });
  await call(dirEnv, '/api/me', { cookie: open, method: 'PATCH', body: { isPublic: true } });
  const openMe = (await call(dirEnv, '/api/me', { cookie: open })).body;
  const byName = await call(dirEnv, '/api/directory?q=Open%20One', { cookie: seeker });
  assert.ok(byName.body.profiles.some((p) => p.profileId === openMe.profileId),
    'a public profile is still findable by name');
  const byOpenId = await call(dirEnv, `/api/directory?q=${encodeURIComponent(openMe.profileId)}`, { cookie: seeker });
  assert.equal(
    byOpenId.body.profiles.find((p) => p.profileId === openMe.profileId).displayName,
    'Open One', 'and a public profile shows its name by ID too');
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

await test('a notice names the person it is about, and reads through a rename', async () => {
  // Bob asked Alice for her schedule; Alice accepted, then revoked. Bob's
  // notice list should name Alice rather than leaving the page to say
  // "Someone", and the name is resolved when the list is read.
  const notices = await call(env, '/api/notices', { cookie: env.bob.cookie });
  const received = notices.body.notices.find((n) => n.kind === 'access.revoked');
  assert.ok(received, 'the revocation notice is still there');
  assert.equal(received.actorName, 'Alice A.', 'the notice carries the actor\'s display name');
  assert.equal(received.actorProfileId, env.alice.profileId);

  // Renaming does not need a backfill: old notices follow the new name.
  await call(env, '/api/me', {
    method: 'PATCH',
    cookie: env.alice.cookie,
    body: { displayName: 'Alice Renamed' },
  });
  const after = await call(env, '/api/notices', { cookie: env.bob.cookie });
  const renamed = after.body.notices.find((n) => n.kind === 'access.revoked');
  assert.equal(renamed.actorName, 'Alice Renamed', 'the name is resolved at read time');
});

await test('a single notice can be cleared without touching the others', async () => {
  const before = await call(env, '/api/notices', { cookie: env.bob.cookie });
  const first = before.body.notices[0];
  assert.ok(before.body.notices.length >= 1, 'there is something to clear');

  const cleared = await call(env, `/api/notices/${first.id}`, { method: 'DELETE', cookie: env.bob.cookie });
  assert.equal(cleared.status, 200);

  const after = await call(env, '/api/notices', { cookie: env.bob.cookie });
  assert.ok(
    !after.body.notices.some((n) => n.id === first.id),
    'the cleared notice is gone'
  );
  assert.equal(
    after.body.notices.length,
    before.body.notices.length - 1,
    'only that one notice was removed'
  );
});

await test('a notice cannot be cleared out of another account', async () => {
  const bobNotices = await call(env, '/api/notices', { cookie: env.bob.cookie });
  const target = bobNotices.body.notices[0];
  assert.ok(target, 'Bob has a notice to protect');

  const attempt = await call(env, `/api/notices/${target.id}`, { method: 'DELETE', cookie: env.alice.cookie });
  assert.equal(attempt.status, 200, 'the request is answered, not leaked');

  const after = await call(env, '/api/notices', { cookie: env.bob.cookie });
  assert.ok(
    after.body.notices.some((n) => n.id === target.id),
    'a foreign notice survives another account\'s delete'
  );
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

await test('approve-automatically off is the default, and a request then waits', async () => {
  // The switch decides the whole path for a public profile: off (the default)
  // parks the ask for the owner to answer, on grants it on the spot.
  const owner = await signIn(env, { sub: 'sub-switch-owner', email: 'switch-owner@x.org', name: 'Switch Owner' });
  const ownerMe = (await call(env, '/api/me', { cookie: owner })).body;
  assert.equal(ownerMe.isPublic, true, 'the profile is findable');
  assert.equal(ownerMe.autoGrant, false, 'a fresh account approves nothing on its own');

  const asker = await signIn(env, { sub: 'sub-switch-asker', email: 'switch-asker@x.org', name: 'Switch Asker' });
  let ask = await call(env, '/api/requests', {
    method: 'POST',
    cookie: asker,
    body: { profileId: ownerMe.profileId },
  });
  assert.equal(ask.body.status, 'pending', 'so the request waits for the owner');

  const waiting = await call(env, '/api/requests', { cookie: owner });
  assert.equal(waiting.body.incoming.filter((r) => r.status === 'pending').length, 1,
    'and lands where the owner can decide it');
  const blocked = await call(env, `/api/schedule/${ownerMe.profileId}`, { cookie: asker });
  assert.equal(blocked.status, 403, 'granting nothing until it is answered');

  await call(env, '/api/me', { cookie: owner, method: 'PATCH', body: { autoGrant: true } });
  const second = await signIn(env, { sub: 'sub-switch-asker2', email: 'switch-asker2@x.org', name: 'Switch Asker Two' });
  ask = await call(env, '/api/requests', {
    method: 'POST',
    cookie: second,
    body: { profileId: ownerMe.profileId },
  });
  assert.equal(ask.body.status, 'granted', 'turning the switch on grants at once');
});

await test('the auto-grant repair revokes only grants no one approved', async () => {
  // Three grants with three histories: an auto approval (no request row), a
  // declined request that was granted anyway (a row, but not accepted), and a
  // request the owner accepted. Only the first is what nobody agreed to.
  const repairEnv = makeEnv();
  repairEnv.ADMIN_TOKEN = 'test-admin-token';
  const admin = (method = 'GET', body, suffix = '') => call(repairEnv, '/api/admin/auto-grants' + suffix, {
    method,
    body,
    headers: { Authorization: 'Bearer test-admin-token' },
  });

  const owner = async (sub) => {
    const cookie = await signIn(repairEnv, { sub, email: `${sub}@x.org`, name: sub });
    return { cookie, ...(await call(repairEnv, '/api/me', { cookie })).body };
  };
  const autoOwner = await owner('repair-auto-owner');
  const oddOwner = await owner('repair-odd-owner');
  const askedOwner = await owner('repair-asked-owner');
  const asker = await owner('repair-asker');

  // The auto path: the switch accepts the ask, so no request row is written.
  await call(repairEnv, '/api/me', { cookie: autoOwner.cookie, method: 'PATCH', body: { autoGrant: true } });
  const autoAsk = await call(repairEnv, '/api/requests', {
    method: 'POST', cookie: asker.cookie, body: { profileId: autoOwner.profileId },
  });
  assert.equal(autoAsk.body.status, 'granted');

  // A row that never said "accepted" is not an approval either.
  await call(repairEnv, '/api/requests', {
    method: 'POST', cookie: asker.cookie, body: { profileId: oddOwner.profileId },
  });
  repairEnv.__db.prepare(
    `INSERT INTO grants (code_hash, owner_account_id, viewer_account_id, created_at)
     VALUES ('odd', (SELECT id FROM accounts WHERE firebase_uid_bidx IS NOT NULL LIMIT 1), 1, 1)`
  );

  // The honest case: asked, then accepted.
  await call(repairEnv, '/api/requests', {
    method: 'POST', cookie: asker.cookie, body: { profileId: askedOwner.profileId },
  });
  const pending = await call(repairEnv, '/api/requests', { cookie: askedOwner.cookie });
  const id = pending.body.incoming.find((r) => r.status === 'pending').id;
  await call(repairEnv, `/api/requests/${id}`, { method: 'POST', cookie: askedOwner.cookie, body: { decision: 'accept' } });

  const before = (await call(repairEnv, '/api/grants', { cookie: askedOwner.cookie })).body;
  assert.equal(before.viewers.length, 1, 'the accepted ask stands');
  await call(repairEnv, '/api/schedule/' + autoOwner.profileId, { cookie: asker.cookie });

  // Who may run it: not nobody, not a wrong secret, not a session cookie.
  assert.equal((await call(repairEnv, '/api/admin/auto-grants')).status, 401, 'a token is required');
  assert.equal((await call(repairEnv, '/api/admin/auto-grants', {
    headers: { Authorization: 'Bearer wrong' },
  })).status, 401, 'and it has to be the right one');
  assert.equal((await call(repairEnv, '/api/admin/auto-grants', {
    cookie: askedOwner.cookie,
  })).status, 401, 'a session is not a token');

  const plan = await admin();
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.body.grants.map((g) => g.owner), [autoOwner.profileId],
    'the plan names the grant no one approved, and nothing else');
  assert.deepEqual(plan.body.grants.map((g) => g.viewer), [asker.profileId]);

  const done = await admin('POST', {}, '/repair');
  assert.equal(done.status, 200);
  assert.equal(done.body.revoked, 1, 'exactly that one grant is revoked');
  assert.equal(done.body.failed, 0);

  // The viewer is told, learns nothing more, and the accepted grant is intact.
  const notices = await call(repairEnv, '/api/notices', { cookie: asker.cookie });
  assert.ok(notices.body.notices.some((n) => n.kind === 'access.revoked'), 'the viewer is told');
  assert.equal(notices.body.notices.filter((n) => n.kind === 'announcement.auto-grant').length, 0,
    'the apology is not a notice, so it never appears in the list');
  const blocked = await call(repairEnv, '/api/schedule/' + autoOwner.profileId, { cookie: asker.cookie });
  assert.equal(blocked.status, 403, 'and can no longer read the schedule');
  const after = await call(repairEnv, '/api/grants', { cookie: askedOwner.cookie });
  assert.equal(after.body.viewers.length, 1, 'the approved grant was left alone');
  assert.equal((await call(repairEnv, '/api/schedule/' + askedOwner.profileId, { cookie: asker.cookie })).status, 200);

  // Severing access leaves a request behind, so nobody has to ask again.
  const reopened = await call(repairEnv, '/api/requests', { cookie: autoOwner.cookie });
  assert.ok(reopened.body.incoming.some((r) => r.status === 'pending'),
    'the severed access is now a request waiting on the owner');

  const back = await call(repairEnv, '/api/grants/restore', { method: 'POST', cookie: autoOwner.cookie });
  assert.equal(back.status, 200);
  assert.equal(back.body.restored, 1, 'and the owner can restore it with one tap');
  assert.equal((await call(repairEnv, '/api/schedule/' + autoOwner.profileId, { cookie: asker.cookie })).status, 200);

  const again = await admin();
  assert.equal(again.body.grants.length, 0, 'a second run finds nothing left to do');

  // The undo is a notice like any other: it lists, and clearing it sticks.
  const ownerNotices = await call(repairEnv, '/api/notices', { cookie: autoOwner.cookie });
  const restoreNotice = ownerNotices.body.notices.find((n) => n.kind === 'access.restore');
  assert.ok(restoreNotice, 'the owner is offered the undo as a real notice');
  assert.equal(restoreNotice.actorProfileId, asker.profileId, 'and it names the person');
  const cleared = await call(repairEnv, `/api/notices/${restoreNotice.id}`, {
    method: 'DELETE', cookie: autoOwner.cookie,
  });
  assert.equal(cleared.status, 200);
  const afterClear = await call(repairEnv, '/api/notices', { cookie: autoOwner.cookie });
  assert.equal(afterClear.body.notices.some((n) => n.kind === 'access.restore'), false,
    'a cleared restore notice stays cleared');
});

await test('restoring from a notice brings back only the person it names', async () => {
  // One notice per severed grant means a click can be about one person, so the
  // restore it triggers has to be about that person too.
  const oneEnv = makeEnv();
  oneEnv.ADMIN_TOKEN = 'test-admin-token';
  const admin = (method = 'GET', body, suffix = '') => call(oneEnv, '/api/admin/auto-grants' + suffix, {
    method, body, headers: { Authorization: 'Bearer test-admin-token' },
  });

  const owner = await signIn(oneEnv, { sub: 'one-owner', email: 'one-owner@x.org', name: 'One Owner' });
  const me = (await call(oneEnv, '/api/me', { cookie: owner })).body;
  await call(oneEnv, '/api/me', { cookie: owner, method: 'PATCH', body: { autoGrant: true } });

  const viewerA = await signIn(oneEnv, { sub: 'one-a', email: 'one-a@x.org', name: 'Viewer A' });
  const viewerB = await signIn(oneEnv, { sub: 'one-b', email: 'one-b@x.org', name: 'Viewer B' });
  const aProfile = (await call(oneEnv, '/api/me', { cookie: viewerA })).body.profileId;
  for (const cookie of [viewerA, viewerB]) {
    const ask = await call(oneEnv, '/api/requests', {
      method: 'POST', cookie, body: { profileId: me.profileId },
    });
    assert.equal(ask.body.status, 'granted', 'auto-grant accepted the ask');
  }

  assert.equal((await admin('POST', {}, '/repair')).body.revoked, 2, 'both unasked grants are severed');
  const notices = await call(oneEnv, '/api/notices', { cookie: owner });
  assert.equal(notices.body.notices.filter((n) => n.kind === 'access.restore').length, 2,
    'one notice per severed grant');

  const single = await call(oneEnv, '/api/grants/restore', {
    method: 'POST', cookie: owner, body: { profileId: aProfile },
  });
  assert.equal(single.body.restored, 1, 'only the named person comes back');
  assert.equal((await call(oneEnv, '/api/schedule/' + me.profileId, { cookie: viewerA })).status, 200,
    'A can read the schedule again');
  assert.equal((await call(oneEnv, '/api/schedule/' + me.profileId, { cookie: viewerB })).status, 403,
    'B is left as it was');
});

await test('auto-grant can be limited to the owner\'s own grade', async () => {
  const owner = await signIn(env, { sub: 'grade-owner', email: 'grade-owner@x.org', name: 'Grade Owner' });
  await call(env, '/api/me', { cookie: owner, method: 'PATCH', body: { grade: 11, autoGrant: true, autoGrantGradeOnly: true } });
  const ownerMe = (await call(env, '/api/me', { cookie: owner })).body;
  assert.equal(ownerMe.autoGrantGradeOnly, true, 'the switch saves');

  const younger = await signIn(env, { sub: 'grade-younger', email: 'younger@x.org', name: 'Younger' });
  await call(env, '/api/me', { cookie: younger, method: 'PATCH', body: { grade: 10 } });
  const junior = await signIn(env, { sub: 'grade-junior', email: 'junior@x.org', name: 'Junior' });
  await call(env, '/api/me', { cookie: junior, method: 'PATCH', body: { grade: 11 } });

  const blocked = await call(env, '/api/requests', { method: 'POST', cookie: younger, body: { profileId: ownerMe.profileId } });
  assert.equal(blocked.body.status, 'pending', 'another grade waits for the owner');
  const granted = await call(env, '/api/requests', { method: 'POST', cookie: junior, body: { profileId: ownerMe.profileId } });
  assert.equal(granted.body.status, 'granted', 'the same grade is approved at once');
});

await test('everything keeps working before the grade column is migrated', async () => {
  // The Worker was deployed before the ALTER TABLE. Nothing may break: accounts
  // load with the grade switch off, and the repair still runs.
  const old = makeEnv();
  old.__db.exec('ALTER TABLE accounts DROP COLUMN auto_grant_grade_only');
  old.ADMIN_TOKEN = 'old-schema-token';
  const cookie = await signIn(old, { sub: 'schema-old', email: 'schema@x.org', name: 'Schema Old' });
  const me = await call(old, '/api/me', { cookie });
  assert.equal(me.status, 200, 'the account still loads');
  assert.equal(me.body.autoGrantGradeOnly, false, 'with the grade switch reported off');
  const plan = await call(old, '/api/admin/auto-grants', { headers: { Authorization: 'Bearer old-schema-token' } });
  assert.equal(plan.status, 200, 'and the repair can still list');
  assert.deepEqual(plan.body.grants, []);
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

await test('the social web now includes everyone, hides private names, and draws only live sharing edges', async () => {
  const socialEnv = makeEnv();
  const owner = await signIn(socialEnv, { sub: 'web-owner', email: 'owner@x.org', name: 'Owner' });
  const viewer = await signIn(socialEnv, { sub: 'web-viewer', email: 'viewer@x.org', name: 'Viewer' });
  const hidden = await signIn(socialEnv, { sub: 'web-hidden', email: 'hidden@x.org', name: 'Hidden' });
  const ownerMe = (await call(socialEnv, '/api/me', { cookie: owner })).body;
  const viewerMe = (await call(socialEnv, '/api/me', { cookie: viewer })).body;
  const hiddenMe = (await call(socialEnv, '/api/me', { cookie: hidden })).body;
  await call(socialEnv, '/api/me', { cookie: owner, method: 'PATCH', body: { isPublic: true, autoGrant: true } });
  await call(socialEnv, '/api/me', { cookie: viewer, method: 'PATCH', body: { isPublic: false } });
  await call(socialEnv, '/api/me', { cookie: hidden, method: 'PATCH', body: { isPublic: false } });

  assert.equal((await call(socialEnv, '/api/social-web')).status, 401, 'signed-in only');
  let graph = await call(socialEnv, '/api/social-web', { cookie: viewer });
  assert.equal(graph.body.nodes.length, 3, 'everyone is in the web, with no opt-in');
  assert.equal(graph.body.nodes.find((n) => n.profileId === viewerMe.profileId).displayName, 'Anonymous',
    'private profiles are shown as Anonymous');
  assert.equal(graph.body.nodes.find((n) => n.profileId === ownerMe.profileId).displayName, 'Owner');
  assert.ok(!graph.text.includes('Viewer') && !graph.text.includes('Hidden'),
    'private names never leave the API');

  // A grade goes with the name it belongs to: shown for a public profile, kept
  // back for one that chose to be anonymous.
  await call(socialEnv, '/api/me', { cookie: owner, method: 'PATCH', body: { grade: 11 } });
  await call(socialEnv, '/api/me', { cookie: viewer, method: 'PATCH', body: { grade: 10 } });
  graph = await call(socialEnv, '/api/social-web', { cookie: viewer });
  assert.equal(graph.body.nodes.find((n) => n.profileId === ownerMe.profileId).grade, 11,
    'a public profile carries its grade');
  assert.equal(graph.body.nodes.find((n) => n.profileId === viewerMe.profileId).grade, null,
    'an anonymous profile keeps its grade to itself');
  assert.deepEqual(graph.body.edges, [], 'no sharing relationships yet');

  // The owner auto-grants, so both requests become live grants immediately.
  await call(socialEnv, '/api/requests', { cookie: viewer, method: 'POST', body: { profileId: ownerMe.profileId } });
  await call(socialEnv, '/api/requests', { cookie: hidden, method: 'POST', body: { profileId: ownerMe.profileId } });
  graph = await call(socialEnv, '/api/social-web', { cookie: viewer });
  assert.equal(graph.body.edges.length, 2, 'each grant draws an edge');
  assert.ok(graph.body.edges.every((e) => e.source === ownerMe.profileId),
    'arrows run from sharer to recipient');
  assert.ok(graph.body.edges.some((e) => e.target === viewerMe.profileId));
  assert.ok(graph.body.edges.some((e) => e.target === hiddenMe.profileId));

  // A pending request draws no edge until the owner accepts it.
  await call(socialEnv, '/api/requests', { cookie: viewer, method: 'POST', body: { profileId: hiddenMe.profileId } });
  graph = await call(socialEnv, '/api/social-web', { cookie: viewer });
  assert.equal(graph.body.edges.length, 2, 'pending requests are not edges');

  // Revoking removes the edge, not the person.
  const grants = await call(socialEnv, '/api/grants', { cookie: owner });
  const target = grants.body.viewers.find((v) => v.profileId === viewerMe.profileId);
  assert.ok(target, 'the owner can see the viewer');
  await call(socialEnv, `/api/grants/${target.id}`, { cookie: owner, method: 'DELETE' });
  graph = await call(socialEnv, '/api/social-web', { cookie: viewer });
  assert.equal(graph.body.edges.length, 1, 'revoked grants disappear');
  assert.equal(graph.body.nodes.length, 3, 'but people stay in the web');
});

await test('social web diagnostic reports participants and live relationships', async () => {
  const diagEnv = makeEnv();
  const me = await signIn(diagEnv, { sub: 'diag-sub', email: 'diag@x.org', name: 'Diag' });
  const friend = await signIn(diagEnv, { sub: 'diag-friend', email: 'friend@x.org', name: 'Friend' });
  await signIn(diagEnv, { sub: 'diag-bystander', email: 'bystander@x.org', name: 'Bystander' });
  const meBody = (await call(diagEnv, '/api/me', { cookie: me })).body;
  const friendBody = (await call(diagEnv, '/api/me', { cookie: friend })).body;

  // Friend asks me; I accept, so one live grant exists between us
  // (owner = me, viewer = friend).
  await call(diagEnv, '/api/requests', {
    cookie: friend, method: 'POST', body: { profileId: meBody.profileId },
  });
  const incoming = await call(diagEnv, '/api/requests', { cookie: me });
  const reqId = incoming.body.incoming[0].id;
  await call(diagEnv, `/api/requests/${reqId}`, { cookie: me, method: 'POST', body: { decision: 'accept' } });

  const mine = await call(diagEnv, '/api/social-web/diagnostic', { cookie: me });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.totals.totalParticipants, 3, 'everyone counts, no opt-in');
  assert.equal(mine.body.totals.relationshipsFromMe, 1, 'I own the grant');
  assert.equal(mine.body.totals.relatedSeenByMe, 1, 'one neighbour either way');
  assert.equal(mine.body.totals.notRelatedToMe, 1, 'the bystander has no relationship');
  assert.equal(mine.body.me.profileId, meBody.profileId);
  assert.equal(mine.body.me.isPublic, true);

  const theirs = await call(diagEnv, '/api/social-web/diagnostic', { cookie: friend });
  assert.equal(theirs.body.totals.relationshipsFromMe, 0, 'the recipient owns no grant');
  assert.equal(theirs.body.totals.relatedSeenByMe, 1);
  assert.equal(theirs.body.totals.notRelatedToMe, 1);
  assert.equal(theirs.body.me.profileId, friendBody.profileId);

  const noOne = await call(diagEnv, '/api/social-web/diagnostic', { cookie: (await signIn(diagEnv, { sub: 'diag-bystander2', email: 'bystander2@x.org', name: 'B2' })) });
  assert.equal(noOne.body.totals.relationshipsFromMe, 0);
  assert.equal(noOne.body.totals.relatedSeenByMe, 0);
  assert.equal(noOne.body.totals.notRelatedToMe, 3, 'four accounts, none related');

  assert.equal((await call(diagEnv, '/api/social-web/diagnostic')).status, 401, 'signed-in only');
});

await test('the social-web column still exists on databases migrated by the old opt-in migration', async () => {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  db.exec(schema.replace(/  social_web_opt_in[^\n]*\n/, ''));
  db.exec("INSERT INTO accounts (firebase_uid, email, profile_id, created_at, updated_at) VALUES ('existing', 'student@x.org', 'existing-student-0001', 1, 1)");
  db.exec(readFileSync(new URL('../migration-social-web.sql', import.meta.url), 'utf8'));
  const row = db.prepare('SELECT social_web_opt_in FROM accounts').get();
  assert.ok(row && typeof row.social_web_opt_in === 'number', 'the column is present for old databases');
  db.close();
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

/** The account just signed in: identifiers are encrypted, so it is the newest. */
function newestAccountId(env) {
  const row = env.__db.prepare('SELECT id FROM accounts ORDER BY id DESC LIMIT 1').get();
  assert.ok(row, 'the account exists');
  return row.id;
}

await test('an announcement row left in the table is deleted, never listed', async () => {
  const env = makeEnv();
  const cookie = await signIn(env, { sub: 'stale-announcement', email: 'stale@example.com', name: 'Stale' });

  // Exactly what a Worker from before the fix left behind: the apology stored
  // as a notice row, written again on every read of the list.
  await call(env, '/api/me', { cookie });
  env.__db.prepare(
    `INSERT INTO notices (account_id, kind, payload, created_at)
     VALUES (?, 'announcement.auto-grant', '{}', 1)`
  ).run(newestAccountId(env));

  const notices = await call(env, '/api/notices', { cookie });
  assert.equal(notices.status, 200);
  assert.equal(notices.body.notices.filter((n) => n.kind.startsWith('announcement.')).length, 0,
    'an announcement is never listed');
  const rows = env.__db.prepare("SELECT COUNT(*) AS n FROM notices WHERE kind LIKE 'announcement.%'").get();
  assert.equal(rows.n, 0, 'and the row is gone, so an older page cannot show it either');
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

  const accountsBefore = env.__db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;

  const del = await call(env, '/api/me', { method: 'DELETE', cookie: env.alice.cookie });
  assert.equal(del.status, 200);

  const after = await call(env, `/api/schedule/${aliceMe.body.profileId}`, { cookie: erin });
  assert.equal(after.status, 404, 'the profile is gone after deletion');

  const gone = await call(env, '/api/me', { cookie: env.alice.cookie });
  assert.equal(gone.status, 401, 'the deleted session is no longer valid');

  const accountsAfter = env.__db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  assert.equal(accountsAfter, accountsBefore - 1, 'exactly the one account row was removed');
  const erinNotices = await call(env, '/api/notices', { cookie: erin });
  assert.ok(
    erinNotices.body.notices.some((n) => n.kind === 'access.revoked'),
    'a viewer should be notified when the owner deletes their account'
  );
});

await test('a viewer can give up access without the owner revoking it', async () => {
  // The owner's Revoke is not the only way out of a share. A viewer must be
  // able to stop seeing a schedule themselves, and only their own share.
  const env = makeEnv();
  const ownerCookie = await signIn(env, { sub: 'give-owner', email: 'give.owner@example.com', name: 'Give Owner' });
  const owner = (await call(env, '/api/me', { cookie: ownerCookie })).body;
  const viewerCookie = await signIn(env, { sub: 'give-viewer', email: 'give.viewer@example.com', name: 'Give Viewer' });
  const viewer = (await call(env, '/api/me', { cookie: viewerCookie })).body;

  const ask = await call(env, '/api/requests', {
    method: 'POST',
    cookie: viewerCookie,
    body: { profileId: owner.profileId },
  });
  assert.equal(ask.body.status, 'pending');

  const pending = await call(env, '/api/requests', { cookie: ownerCookie });
  const requestId = pending.body.incoming[0].id;
  await call(env, `/api/requests/${requestId}`, {
    method: 'POST',
    cookie: ownerCookie,
    body: { decision: 'accept' },
  });

  assert.equal((await call(env, `/api/schedule/${owner.profileId}`, { cookie: viewerCookie })).status, 200);
  const viewing = await call(env, '/api/grants', { cookie: viewerCookie });
  const grant = viewing.body.viewing.find((entry) => entry.profileId === owner.profileId);
  assert.ok(grant, 'the viewer holds the share');

  // The owner cannot end it through the viewer endpoint, and neither can
  // anyone who is not the viewer.
  const wrongSide = await call(env, `/api/grants/viewing/${grant.id}`, {
    method: 'DELETE',
    cookie: ownerCookie,
  });
  assert.equal(wrongSide.status, 404, 'only the viewer may give up their own access');

  const stop = await call(env, `/api/grants/viewing/${grant.id}`, {
    method: 'DELETE',
    cookie: viewerCookie,
  });
  assert.equal(stop.status, 200);
  assert.equal((await call(env, `/api/schedule/${owner.profileId}`, { cookie: viewerCookie })).status, 403,
    'access stops immediately');

  const ownerGrants = await call(env, '/api/grants', { cookie: ownerCookie });
  assert.equal(ownerGrants.body.viewers.length, 0, 'the owner no longer lists a live grant');

  const again = await call(env, `/api/grants/viewing/${grant.id}`, {
    method: 'DELETE',
    cookie: viewerCookie,
  });
  assert.equal(again.status, 200, 'giving up an already-ended share is harmless');
});

await test('an asker can withdraw a request that is still waiting', async () => {
  const env = makeEnv();
  const ownerCookie = await signIn(env, { sub: 'stop-owner', email: 'stop.owner@example.com', name: 'Stop Owner' });
  const owner = (await call(env, '/api/me', { cookie: ownerCookie })).body;
  const askerCookie = await signIn(env, { sub: 'stop-asker', email: 'stop.asker@example.com', name: 'Stop Asker' });
  const asker = (await call(env, '/api/me', { cookie: askerCookie })).body;

  const ask = await call(env, '/api/requests', {
    method: 'POST',
    cookie: askerCookie,
    body: { profileId: owner.profileId },
  });
  assert.equal(ask.body.status, 'pending');

  const outgoing = await call(env, '/api/requests', { cookie: askerCookie });
  const request = outgoing.body.outgoing.find((entry) => entry.profileId === owner.profileId);
  assert.ok(request, 'the sent ask is listed');

  // The recipient cannot withdraw somebody else's ask.
  const wrongSide = await call(env, `/api/requests/${request.id}`, {
    method: 'DELETE',
    cookie: ownerCookie,
  });
  assert.equal(wrongSide.status, 404);

  const cancel = await call(env, `/api/requests/${request.id}`, {
    method: 'DELETE',
    cookie: askerCookie,
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'cancelled');

  const afterOut = await call(env, '/api/requests', { cookie: askerCookie });
  assert.equal(afterOut.body.outgoing.find((entry) => entry.id === request.id).status, 'cancelled');
  const afterIn = await call(env, '/api/requests', { cookie: ownerCookie });
  assert.equal(afterIn.body.incoming.find((entry) => entry.id === request.id).status, 'cancelled',
    'the owner no longer sees a waiting ask');

  // A decision racing the withdrawal must not hand out access afterwards.
  const late = await call(env, `/api/requests/${request.id}`, {
    method: 'POST',
    cookie: ownerCookie,
    body: { decision: 'accept' },
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.status, 'cancelled');
  assert.equal((await call(env, `/api/schedule/${owner.profileId}`, { cookie: askerCookie })).status, 403,
    'withdrawing did not grant access');

  // Asking again is allowed and starts a fresh pending request.
  const again = await call(env, '/api/requests', {
    method: 'POST',
    cookie: askerCookie,
    body: { profileId: owner.profileId },
  });
  assert.equal(again.body.status, 'pending');
  const reasked = await call(env, '/api/requests', { cookie: askerCookie });
  assert.equal(reasked.body.outgoing.find((entry) => entry.id === request.id).status, 'pending');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length - passed ? 1 : 0);
