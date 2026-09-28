/**
 * Shared harness for the page-level tests.
 *
 * Both worker/test/page.test.mjs and worker/test/card.test.mjs drive the real
 * pages against the real Worker running on a real (in-memory) database. Keeping
 * the Worker wiring, the fake Google endpoints and the cookie jar here means the
 * two suites exercise the same backend and cannot drift apart.
 *
 * Only two things are faked:
 *
 *   - Google's token/JWKS endpoints, with a locally generated RSA key.
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

export const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
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
export const env = {
  DB: { prepare: (sql) => new Stmt(db, sql) },
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-secret',
  SESSION_SECRET: 'test-session-secret',
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

let tokenFor = null;
export async function idToken(sub, email, name) {
  const h = { alg: 'RS256', typ: 'JWT', kid: 'test-kid' };
  const p = { sub, email, name, aud: CLIENT_ID, iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 3600 };
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

  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ id_token: tokenFor }), { status: 200 });
  }
  if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
  }

  if (url.startsWith(API_ORIGIN)) {
    // A real browser holds several cookies at once and sends them together, so
    // merge rather than overwrite: the OAuth state cookie and the session
    // cookie must coexist, or the second sign-in fails its state check.
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

const worker = (await import(repoPath('worker/api.js'))).default;

export function sessionFrom(res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const c = all.find((x) => x.startsWith('ht_session='));
  assert.ok(c, 'the callback should set a session cookie');
  return c.split(';')[0];
}

/**
 * Sign in as an account and return its session cookie. Also leaves the jar set
 * to that account, which is what a browser window would do.
 */
export async function signInAs(sub, email, name) {
  tokenFor = await idToken(sub, email, name);
  const login = await routerFetch(`${API_ORIGIN}/api/auth/login`);
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const cb = await routerFetch(`${API_ORIGIN}/api/auth/callback?code=c&state=${state}`, {
    headers: { Cookie: `ht_oauth_${state.slice(0, 8)}=1` },
  });
  const cookie = sessionFrom(cb);
  cookieJar = cookie;
  return cookie;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
