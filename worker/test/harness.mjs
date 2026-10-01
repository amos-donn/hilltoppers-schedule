/**
 * Shared harness for the page-level tests.
 *
 * Both worker/test/page.test.mjs and worker/test/card.test.mjs drive the real
 * pages against the real Worker running on a real (in-memory) database. Keeping
 * the Worker wiring, the fake Firebase endpoints and the cookie jar here means
 * the two suites exercise the same backend and cannot drift apart.
 *
 * Only two things are faked:
 *
 *   - Firebase's ID-token signing key, with a locally generated RSA key. The
 *     tests mint real RS256 tokens and the Worker verifies them for real, so
 *     the whole JWKS -> kid -> importKey -> verify path is exercised. Only the
 *     key's publication is stubbed.
 *   - fetch's cookie jar: jsdom does not store cookies, so this shim keeps the
 *     ht_session cookie on the reducer's behalf, which is exactly what a browser
 *     does automatically.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

// The repository root, so the tests can be run from anywhere.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repoPath = (...parts) => join(ROOT, ...parts);

export const FIREBASE_PROJECT = 'schedule-59d28';
export const API_ORIGIN = 'https://hilltoppers-schedule-friends.amos-donn.workers.dev';
export const PAGE_ORIGIN = 'https://amos-donn.github.io';

// ---------------------------------------------------------------------------
// Real Worker over a real database
// ---------------------------------------------------------------------------
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { this.params = p; return this; }
  async first() { const r = this.db.prepare(this.sql).get(...this.params); return r === undefined ? null : r; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { this.db.prepare(this.sql).run(...this.params); return { success: true }; }
}

export const db = new DatabaseSync(':memory:');
db.exec(readFileSync(repoPath('worker/schema.sql'), 'utf8'));
db.exec('PRAGMA foreign_keys = ON');

// A real 32-byte key so the Worker's encryption runs for real in the tests
// rather than being stubbed. Fixed so runs are reproducible; production uses a
// generated one. Rotations are covered by TEST_DATA_KEY_PREV below.
export const TEST_DATA_KEY = 'aGlsbHRvcHBlcnMtdGVzdC1rZXktdjEAAAAAAAAAAAA';
export const TEST_DATA_KEY_PREV = 'cHJldmlvdXMta2V5LXJvdGF0aW9uLW9sZCEhAAAAAAA';

export const env = {
  DB: { prepare: (sql) => new Stmt(db, sql) },
  FIREBASE_PROJECT_ID: FIREBASE_PROJECT,
  SESSION_SECRET: 'test-session-secret',
  DATA_KEY: TEST_DATA_KEY,
};

const keyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']
);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const b64url = (bytes) => {
  const v = new Uint8Array(bytes); let s = '';
  for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlJson = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/**
 * A Firebase ID token, shaped the way the real one is.
 *
 * `sub` is the uid, which is what the Worker keys the account on. Firebase
 * also repeats the value as `user_id`, so it is set here too, to keep the token
 * shaped like the real one. `email_verified` defaults to true because that is
 * the ordinary case; pass `{emailVerified: false}` to exercise the gate.
 */
export async function idToken(sub, email, name, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: 'RS256', typ: 'JWT', kid: options.kid || 'test-kid' };
  const p = {
    iss: `https://securetoken.google.com/${FIREBASE_PROJECT}`,
    aud: FIREBASE_PROJECT,
    sub,
    user_id: sub,
    email,
    name,
    email_verified: options.emailVerified !== false,
    auth_time: now,
    iat: now,
    exp: now + 3600,
  };
  const input = `${b64urlJson(h)}.${b64urlJson(p)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

// Cookie jar, standing in for the browser.
let cookieJar = '';
const realFetch = globalThis.fetch;

export function setCookieJar(value) { cookieJar = value; }
export function getCookieJar() { return cookieJar; }

export async function routerFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;

  // The path is "jwk", singular. The plural form is a 404, which would look
  // exactly like a token that failed to verify.
  if (url.startsWith('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
  }

  if (url.startsWith(API_ORIGIN)) {
    // A real browser holds several cookies at once and sends them together, so
    // merge rather than overwrite, or a second sign-in can drop a cookie that
    // is still live.
    const passed = (init.headers && init.headers.Cookie) ? init.headers.Cookie : '';
    const jar = cookieJar ? cookieJar : '';
    const merged = [jar, passed].filter(Boolean).join('; ');
    const headers = { ...(init.headers || {}) };
    if (merged) headers.Cookie = merged;
    else delete headers.Cookie;
    const res = await worker.fetch(new Request(url, { ...init, headers, redirect: 'manual' }), env);
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      if (c.startsWith('ht_session=')) cookieJar = c.split(';')[0];
    }
    return res;
  }

  return realFetch(input, init);
}

const workerModule = await import(repoPath('worker/api.js'));
const worker = workerModule.default;
/** The raw fetch handler, for tests that need to run it against a different env. */
export { worker };
// Re-exported so a test can compute a blind index under a rotated keyring.
export { blindIndexFor };
const { accountAad, blindIndexFor, decryptAccount, encryptField } = workerModule;

// ---------------------------------------------------------------------------
// Reading storage from tests
//
// The page tests used to query the plaintext profile columns directly. Those
// columns are encrypted now, so these helpers go through the same blind index
// and decryption the Worker uses. That keeps an assertion like "this student is
// public" a real assertion instead of a check against ciphertext.
// ---------------------------------------------------------------------------

/** The decrypted account row for a Firebase uid. */
export async function accountOf(uid) {
  const index = await blindIndexFor(env, 'firebase_uid', uid);
  const row = db.prepare('SELECT * FROM accounts WHERE firebase_uid_bidx = ?').get(index);
  assert.ok(row, `expected an account for uid ${uid}`);
  return decryptAccount(env, row);
}

export async function accountIdOf(uid) {
  return (await accountOf(uid)).id;
}

/** The raw, still-encrypted accounts row, for assertions about what is stored. */
export async function rawRowOfUid(uid) {
  const index = await blindIndexFor(env, 'firebase_uid', uid);
  const row = db.prepare('SELECT * FROM accounts WHERE firebase_uid_bidx = ?').get(index);
  assert.ok(row, `expected an account for uid ${uid}`);
  return row;
}

/** A column that deliberately stays plaintext, such as is_public. */
export async function plainFieldOf(uid, column) {
  const account = await accountOf(uid);
  const row = db.prepare(`SELECT ${column} AS value FROM accounts WHERE id = ?`).get(account.id);
  return row ? row.value : undefined;
}

/** Write an encrypted field directly, for arranging a test. */
export async function setEncryptedFieldOf(uid, field, value) {
  const account = await accountOf(uid);
  await db.prepare(`UPDATE accounts SET ${field}_enc = ? WHERE id = ?`)
    .run(await encryptField(env, value, accountAad(account.profile_id, field)), account.id);
}

export function sessionFrom(res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const c = all.find((x) => x.startsWith('ht_session='));
  assert.ok(c, 'signing in should set a session cookie');
  return c.split(';')[0];
}

/** Exchange a token for a session, the way the settings page does. */
export async function signInWith(token) {
  return routerFetch(`${API_ORIGIN}/api/auth/firebase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
  });
}

/**
 * Sign in as an account and return its session cookie. Also leaves the jar set
 * to that account, which is what a browser window would do.
 */
export async function signInAs(sub, email, name, options = {}) {
  const token = await idToken(sub, email, name, options);
  const res = await signInWith(token);
  const cookie = sessionFrom(res);
  cookieJar = cookie;
  return cookie;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
