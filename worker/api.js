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
 *   DATA_KEY            secret: 32 random bytes, base64 or base64url. Encrypts
 *                       every profile field at rest. Optional DATA_KEY_PREV
 *                       holds the previous key during a rotation.
 *
 * DATA_KEY has no safe default and no fallback: without it this Worker refuses
 * to start rather than fall back to storing profiles in the clear. Back it up
 * somewhere safe - without it every profile field already written is
 * unrecoverable. See the Field encryption section below and worker/README.md.
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
 *   GET  /api/social-web       the sharing graph; everyone is in it, private
 *                              profiles show as "Anonymous"
 *   GET  /api/social-web/diagnostic
 *                              read-only counts: participants, relationships
 *                              from the caller, neighbours, strangers
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
 * - Every profile field is encrypted with AES-256-GCM before it reaches D1, and
 *   a blind index makes exact-match lookups work without the database ever
 *   seeing a plaintext value. Handlers still work with plain objects; only this
 *   Worker knows how they were stored. Read the Field encryption section before
 *   touching any query on accounts, because most of them can no longer filter or
 *   join on a profile column.
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
// Field encryption
//
// D1 has no column-level encryption, and Cloudflare's own encryption at rest
// does not help with the case this section exists for: reading the database.
// Someone with the D1 console, a Time Travel snapshot, a stolen read-only
// token, or a SQL injection bug could otherwise read every profile in the
// table. Encrypting here moves that boundary up into this Worker, so the
// stored bytes are useless on their own.
//
// It lives inline rather than in a separate module on purpose: this file is
// deployed by pasting it into the Cloudflare dashboard's editor, which accepts
// exactly one file. An import would break that deployment.
//
// HOW A VALUE IS STORED
//
//   v1.a.<iv>.<ciphertext>    base64url, 12-byte random IV, AES-256-GCM
//
// "v1" is the format tag and "a" is the writing slot. The tag records the
// format, not which key encrypted the value: a rotation moves a key from
// "active" to "previous" without rewriting a single row, so decryption tries
// each configured key in turn rather than trusting the tag. Anything that does
// not match that shape is a legacy plaintext value.
//
// Every ciphertext is bound to its row and column with AES-GCM additional
// authenticated data, so a value cannot be moved to another row or another
// column and still decrypt:
//
//   accounts:<profile_id>:<field>
//
// profile_id cannot name itself, so its own AAD is "accounts:self:profile_id".
// That one field is not row-bound, which is acceptable because its uniqueness
// is enforced by its blind index, so a copied value cannot resolve to a second
// account. profile_id is immutable once issued, which is what keeps the AAD
// stable over the row's life.
//
// WHY THERE IS A BLIND INDEX
//
// You cannot run LIKE, or any comparison, over AES-GCM ciphertext: every
// encryption produces different bytes. So a field that has to be found by an
// exact match also gets a blind index - an HMAC-SHA256 of the normalised value
// under a separately derived key:
//
//   accounts.profile_id_bidx = HMAC("profile_id" + " " + "brave-otter-4821")
//
// Lookups become WHERE profile_id_bidx = ?, and the database never sees the
// plaintext. The field name is part of the HMAC message, not just the key:
// without it an email and a profile ID that normalise alike would collide and
// a lookup on one could match a row on the other.
//
// Directory search is the one query that needs LIKE and cannot move into SQL,
// so it filters and sorts in JS after decrypting the public rows it already had
// to decrypt. At the scale of one school that is not worth optimising, and it
// is the reason this section exists rather than a per-column key in SQL.
//
// MIGRATION
//
// Existing rows hold plaintext in the original columns, and SQL cannot encrypt.
// repairAccount migrates a row the first time it is read: it encrypts each
// legacy value, fills in the blind index, and overwrites the original column
// with an opaque placeholder. Every read path calls it, so the console clears
// progressively as people use the site, with no separate backfill job and no
// window where a row is readable but unmigrated.
//
// WHAT THIS DOES NOT DO
//
// The key lives in this Worker's environment, which is readable by anyone with
// access to the Cloudflare account. This protects the stored data, not the
// account. It also cannot hide the shape of the social graph: grants and
// requests still join on integer account ids, because access control depends on
// them. Only client-side encryption would hide that, and it would break search.
// ---------------------------------------------------------------------------

const CIPHER_PREFIX = 'v1';
const REDACTED_PREFIX = 'enc:';
const IV_BYTES = 12;

// Fixed, non-secret HKDF salt. Its job is to domain-separate this derivation
// from any other use of the same master secret.
const HKDF_SALT = new TextEncoder().encode('hilltoppers-schedule/field-encryption/v1');
const HKDF_INFO_ENC = new TextEncoder().encode('field-encryption');
const HKDF_INFO_BIDX = new TextEncoder().encode('blind-index');

// Tight enough that no realistic profile field can be mistaken for ciphertext.
// A profile ID cannot contain dots in this pattern, and an address cannot match
// at all because there is no "@".
const CIPHER_RE = /^v1\.[ab]\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/;

/**
 * Every encrypted field on accounts, and how each one is looked up.
 *
 * `indexed` means the field also gets a `<field>_bidx` blind index, which is
 * what makes an exact-match query on it possible at all.
 */
const ACCOUNT_FIELDS = {
  firebase_uid: { indexed: true, normalize: (v) => String(v ?? '') },
  email: { indexed: true, normalize: (v) => String(v ?? '').trim().toLowerCase() },
  name: { indexed: false },
  profile_id: { indexed: true, normalize: (v) => String(v ?? '').trim().toLowerCase() },
  display_name: { indexed: false },
  time_format: { indexed: false },
  grade: { indexed: false },
  lunch_wave: { indexed: false },
  block_prefs: { indexed: false },
  schedule_prefs: { indexed: false },
};

const ACCOUNT_FIELD_NAMES = Object.keys(ACCOUNT_FIELDS);
const ACCOUNT_INDEXED_FIELDS = ACCOUNT_FIELD_NAMES.filter((f) => ACCOUNT_FIELDS[f].indexed);

/**
 * Original columns that are NOT NULL and so still need a value after their
 * contents move into the ciphertext column. Nullable ones are simply nulled,
 * which also keeps a ciphertext string from ever being written into the
 * INTEGER-affinity grade and lunch_wave columns.
 */
const LEGACY_MUST_FILL = new Set([
  'firebase_uid', 'email', 'profile_id', 'time_format', 'block_prefs', 'schedule_prefs',
]);

/** True only for a value this Worker wrote. Anything else is legacy plaintext. */
function isEncrypted(value) {
  return typeof value === 'string' && CIPHER_RE.test(value);
}

/** True for the opaque placeholder left behind in a legacy column. */
function isRedacted(value) {
  return typeof value === 'string' && value.startsWith(REDACTED_PREFIX);
}

/** A value to park in a legacy NOT NULL column once its contents are encrypted. */
function redactedPlaceholder() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return REDACTED_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a legacy column should hold for `field` once it has been migrated. */
function legacyPlaceholderFor(field) {
  return LEGACY_MUST_FILL.has(field) ? redactedPlaceholder() : null;
}

/** AAD for an accounts field. Pass null profileId only for profile_id itself. */
function accountAad(profileId, field) {
  return `accounts:${profileId == null ? 'self' : profileId}:${field}`;
}

/** AAD for a notices payload, bound to the account the notice belongs to. */
function noticeAad(accountId) {
  return `notices:${accountId}:payload`;
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Accept a 32-byte key as base64 or base64url. Anything else is a configuration
 * mistake worth naming loudly, because silently using a weak key would be worse
 * than not encrypting at all.
 */
function decodeKeyMaterial(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  let bytes;
  try {
    bytes = fromB64url(trimmed);
  } catch {
    return null;
  }
  return bytes.length === 32 ? bytes : null;
}

/** Expand one master secret into the two purpose-separated keys actually used. */
async function deriveSlot(masterBytes) {
  const base = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveKey']);
  const [enc, bidx] = await Promise.all([
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO_ENC },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    ),
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO_BIDX },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign']
    ),
  ]);
  return { enc, bidx };
}

// Deriving keys takes a few hundred microseconds and every request decrypts
// several fields, so the keyring is cached per isolate. The cache key is the
// secrets themselves, which also makes it correct the moment a rotation deploys.
let cachedKeyring = null;
let cachedKeySignature = '';

async function fieldKeyring(env) {
  const signature = `${env.DATA_KEY || ''}|${env.DATA_KEY_PREV || ''}`;
  if (cachedKeyring && cachedKeySignature === signature) return cachedKeyring;

  const activeBytes = decodeKeyMaterial(env.DATA_KEY);
  if (!activeBytes) {
    throw new Error(
      'DATA_KEY is missing or is not 32 bytes of base64. Set it with ' +
      '"wrangler secret put DATA_KEY" before deploying, and keep a backup: ' +
      'without it every encrypted profile field is unreadable.'
    );
  }
  const previousBytes = env.DATA_KEY_PREV ? decodeKeyMaterial(env.DATA_KEY_PREV) : null;

  cachedKeyring = {
    active: await deriveSlot(activeBytes),
    previous: previousBytes ? await deriveSlot(previousBytes) : null,
  };
  cachedKeySignature = signature;
  return cachedKeyring;
}

/**
 * Encrypt one field value.
 *
 * The value is JSON-encoded first so that null, 0 and "" survive the round trip
 * distinctly, which matters because display_name, grade and lunch_wave all use
 * those. A fresh random IV per value means the same input never produces the
 * same ciphertext twice, so a dump of the table leaks no equality information.
 */
async function encryptField(env, value, aad) {
  const keys = await fieldKeyring(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value === undefined ? null : value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
    keys.active.enc,
    plaintext
  );
  return `${CIPHER_PREFIX}.a.${b64url(iv)}.${b64url(ciphertext)}`;
}

/**
 * Decrypt one field value.
 *
 * A value this Worker did not write is returned unchanged. That is the
 * migration path, not a hole: such a row is one the database was already
 * storing in the clear, and repairAccount re-encrypts it on the way out. What
 * must never happen is returning something plausible for a value that claims
 * to be ciphertext but does not authenticate, so that case throws.
 */
async function decryptField(env, value, aad) {
  if (!isEncrypted(value)) return value;
  const keys = await fieldKeyring(env);
  const parts = value.split('.');
  const params = {
    name: 'AES-GCM',
    iv: fromB64url(parts[2]),
    additionalData: new TextEncoder().encode(aad),
    tagLength: 128,
  };

  // Every configured key is tried, newest first, because a stored slot tag
  // cannot identify the key on its own across a rotation. Trying each key is
  // safe: AES-GCM authenticates, so the wrong key fails to decrypt rather than
  // returning something plausible.
  const slots = [keys.active];
  if (keys.previous) slots.push(keys.previous);
  const ciphertext = fromB64url(parts[3]);

  for (const slot of slots) {
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt(params, slot.enc, ciphertext);
    } catch {
      continue;
    }
    return JSON.parse(new TextDecoder().decode(plaintext));
  }
  throw new Error('encrypted field failed authentication: wrong row, wrong column, or tampered');
}

/** Blind-index normalisation, including the per-field domain separator. */
function bidxMessage(field, value) {
  const spec = ACCOUNT_FIELDS[field];
  const normalized = spec && spec.normalize ? spec.normalize(value) : String(value ?? '');
  return `${field} ${normalized}`;
}

/** Blind index for `field` under the current key. */
async function blindIndexFor(env, field, value) {
  const keys = await fieldKeyring(env);
  const signature = await crypto.subtle.sign(
    'HMAC',
    keys.active.bidx,
    new TextEncoder().encode(bidxMessage(field, value))
  );
  return toHex(signature);
}

/**
 * Every index a value could have under a configured key.
 *
 * During a rotation both keys must be tried or rows written before the swap
 * become unreachable. Read-repair re-signs them onto the current key the first
 * time they are found.
 */
async function blindIndexCandidates(env, field, value) {
  const keys = await fieldKeyring(env);
  const message = new TextEncoder().encode(bidxMessage(field, value));
  const out = [toHex(await crypto.subtle.sign('HMAC', keys.active.bidx, message))];
  if (keys.previous) {
    out.push(toHex(await crypto.subtle.sign('HMAC', keys.previous.bidx, message)));
  }
  return out;
}

/** "?" for one bind parameter, "? , ?" for several. */
function placeholders(count) {
  return new Array(count).fill('?').join(', ');
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
  // The joined row carries every encrypted column, so it goes through the same
  // decrypt-and-migrate path as any other single-row read. Every authenticated
  // request lands here, which is why one sign-in migrates an account.
  return readAccount(env, row);
}

// ---------------------------------------------------------------------------
// Reading and writing encrypted accounts
//
// decryptAccount turns a raw row back into the plain shape the handlers below
// already use, so no endpoint has to know any of this. readAccount adds the
// lazy migration. Both take a raw row rather than running their own query,
// because each call site needs a different WHERE clause.
// ---------------------------------------------------------------------------

/** Fail with the fix, rather than with a confusing null, if the columns are absent. */
function assertEncryptedSchema(row) {
  if (!row || !('profile_id_enc' in row)) {
    throw new Error(
      'accounts is missing its encrypted columns. Run ' +
      'worker/migration-encrypt-fields.sql against this database before deploying ' +
      'this Worker.'
    );
  }
}

/** Ciphertext plus blind index for every encrypted field of an account. */
async function encryptedAccountValues(env, account) {
  const out = {};
  for (const field of ACCOUNT_FIELD_NAMES) {
    const aad = accountAad(field === 'profile_id' ? null : account.profile_id, field);
    out[`${field}_enc`] = await encryptField(env, account[field], aad);
  }
  for (const field of ACCOUNT_INDEXED_FIELDS) {
    out[`${field}_bidx`] = await blindIndexFor(env, field, account[field]);
  }
  return out;
}

/**
 * The stored value for a field: the ciphertext column when it has one, and the
 * original column when the row has not been migrated yet.
 *
 * This fallback is what makes the lazy migration safe. A row that predates
 * encryption has an empty _enc column and a real value in the original one, so
 * reading it here is what keeps an unmigrated row correct until repairAccount
 * rewrites it. A redacted placeholder means "migrated", so it is never treated
 * as a value.
 */
function storedField(row, field) {
  const encrypted = row[`${field}_enc`];
  if (encrypted !== null && encrypted !== undefined && encrypted !== '') return encrypted;
  const legacy = row[field];
  if (legacy === null || legacy === undefined || legacy === '') return null;
  return isRedacted(legacy) || isEncrypted(legacy) ? null : legacy;
}

/** Decrypt a raw accounts row into the shape the handlers expect. */
async function decryptAccount(env, row) {
  assertEncryptedSchema(row);
  const profileId = await decryptField(env, storedField(row, 'profile_id'), accountAad(null, 'profile_id'));
  const out = {
    id: row.id,
    is_public: row.is_public,
    auto_grant: row.auto_grant,
    social_web_opt_in: row.social_web_opt_in,
    created_at: row.created_at,
    updated_at: row.updated_at,
    profile_id: profileId,
  };
  for (const field of ACCOUNT_FIELD_NAMES) {
    if (field === 'profile_id') continue;
    out[field] = await decryptField(env, storedField(row, field), accountAad(profileId, field));
  }
  return out;
}

/**
 * Migrate one row in place, if it still needs it.
 *
 * For each field: encrypt a legacy plaintext value if the ciphertext column is
 * empty, re-sign a blind index that does not match the current key, and
 * overwrite any legacy column that still holds the real value with a
 * placeholder. That last step is the point of the whole exercise - without it
 * the plaintext would simply sit there next to the ciphertext.
 *
 * Only the caller decides whether a row is worth a write; this returns whether
 * it did one, so a converged row costs nothing beyond three HMACs.
 *
 * updated_at is deliberately not touched: migrating a row is not the student
 * changing their profile, and there is nothing else in this Worker that reads
 * it.
 */
async function repairAccount(env, row, account) {
  const sets = [];
  const values = [];

  for (const field of ACCOUNT_FIELD_NAMES) {
    const legacy = row[field];
    const holdsPlaintext = legacy !== null && legacy !== undefined && legacy !== ''
      && !isRedacted(legacy) && !isEncrypted(legacy);
    const aad = accountAad(field === 'profile_id' ? null : account.profile_id, field);

    if (holdsPlaintext && !isEncrypted(row[`${field}_enc`])) {
      sets.push(`${field}_enc = ?`);
      values.push(await encryptField(env, legacy, aad));
    }

    if (ACCOUNT_FIELDS[field].indexed) {
      // Recomputing rather than only filling a NULL is what makes a rotation
      // converge: a stale index is rewritten once and then matches forever.
      const current = await blindIndexFor(env, field, account[field]);
      if (row[`${field}_bidx`] !== current) {
        sets.push(`${field}_bidx = ?`);
        values.push(current);
      }
    }

    if (holdsPlaintext) {
      sets.push(`${field} = ?`);
      values.push(legacyPlaceholderFor(field));
    }
  }

  if (!sets.length) return false;
  await env.DB.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values, row.id)
    .run();
  return true;
}

/**
 * Decrypt a single-row read and migrate the row on the way out.
 *
 * List reads deliberately do not call this: migrating every row a directory
 * search touches would turn one request into a burst of writes. Single-row
 * reads are enough to migrate everyone, because currentAccount runs on every
 * authenticated request, so any real user migrates the first time they load the
 * site.
 */
async function readAccount(env, row) {
  if (!row) return null;
  const account = await decryptAccount(env, row);
  await repairAccount(env, row, account);
  return account;
}

/** Look accounts up by profile ID, for callers that need several at once. */
async function accountsByProfileId(env, profileIds) {
  const wanted = [...new Set(profileIds.filter(Boolean))];
  if (!wanted.length) return new Map();
  const candidates = [];
  for (const id of wanted) candidates.push(...await blindIndexCandidates(env, 'profile_id', id));

  // The blind index finds migrated rows; the profile_id comparison catches
  // rows that have not been migrated yet and so have no index at all.
  const rows = await env.DB.prepare(
    `SELECT * FROM accounts
      WHERE profile_id_bidx IN (${placeholders(candidates.length)})
         OR profile_id IN (${placeholders(wanted.length)})`
  )
    .bind(...candidates, ...wanted)
    .all();

  const out = new Map();
  for (const row of rows.results || []) {
    const account = await decryptAccount(env, row);
    out.set(account.profile_id, account);
  }
  return out;
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
    // Collisions are checked through the blind index, plus the original column
    // so that rows which have not been migrated yet still count as taken.
    const candidates = await blindIndexCandidates(env, 'profile_id', candidate);
    const taken = await env.DB.prepare(
      `SELECT 1 FROM accounts
        WHERE profile_id_bidx IN (${placeholders(candidates.length)}) OR profile_id = ?`
    )
      .bind(...candidates, candidate)
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
  // The payload carries the acting profile ID, so it is encrypted like every
  // other profile field. The original column keeps a structurally valid
  // placeholder because the schema declares it NOT NULL.
  const payloadEnc = await encryptField(env, payload, noticeAad(accountId));
  await env.DB.prepare(
    `INSERT INTO notices (account_id, kind, payload, payload_enc, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(accountId, kind, '{}', payloadEnc, nowSeconds())
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
    socialWebOptIn: true, // Everyone participates; kept for older clients.
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

/** Find the account for a Firebase uid, through its blind index. */
async function findAccountByFirebaseUid(env, uid) {
  const candidates = await blindIndexCandidates(env, 'firebase_uid', uid);
  const row = await env.DB.prepare(
    `SELECT * FROM accounts
      WHERE firebase_uid_bidx IN (${placeholders(candidates.length)}) OR firebase_uid = ?`
  )
    .bind(...candidates, uid)
    .first();
  return readAccount(env, row);
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
  let account = await findAccountByFirebaseUid(env, claims.uid);

  if (!account) {
    const profileId = await generateProfileId(env);
    const name = claims.name || claims.email.split('@')[0];
    // block_prefs and schedule_prefs are stored as the JSON strings the schema
    // declares, so safeJson keeps working on the decrypted value unchanged.
    const encrypted = await encryptedAccountValues(env, {
      firebase_uid: claims.uid,
      email: claims.email,
      name,
      profile_id: profileId,
      display_name: name,
      time_format: '12h',
      grade: null,
      lunch_wave: null,
      block_prefs: '{}',
      schedule_prefs: '{}',
    });

    // Every original column is written with a placeholder rather than left to a
    // default: the real values go in the _enc columns, and the originals are
    // NOT NULL in the schema.
    const encryptedColumns = ACCOUNT_FIELD_NAMES.map((f) => `${f}_enc`);
    const indexColumns = ACCOUNT_INDEXED_FIELDS.map((f) => `${f}_bidx`);
    const columns = [
      ...encryptedColumns,
      ...indexColumns,
      ...ACCOUNT_FIELD_NAMES.map((f) => f),
      'is_public',
      'social_web_opt_in',
      'created_at',
      'updated_at',
    ];
    await env.DB.prepare(
      `INSERT INTO accounts (${columns.join(', ')})
       VALUES (${placeholders(columns.length)})`
    )
      .bind(
        ...encryptedColumns.map((c) => encrypted[c]),
        ...indexColumns.map((c) => encrypted[c]),
        ...ACCOUNT_FIELD_NAMES.map((f) => legacyPlaceholderFor(f)),
        1, // Public by default, including on databases with the old defaults.
        1, // Everyone is in the Social web now; opt-in is removed.
        ts,
        ts,
      )
      .run();

    account = await findAccountByFirebaseUid(env, claims.uid);
  } else if (account.email !== claims.email) {
    // A changed address must not change identity, which is why the account is
    // keyed on the Firebase uid and only the display fields are updated.
    const encrypted = await encryptedAccountValues(env, { ...account, email: claims.email });
    await env.DB.prepare(
      `UPDATE accounts SET email_enc = ?, email_bidx = ?, email = ?, updated_at = ?
        WHERE id = ?`
    )
      .bind(
        encrypted.email_enc,
        encrypted.email_bidx,
        legacyPlaceholderFor('email'),
        ts,
        account.id,
      )
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

/** Public graph metadata for every account; never courses, email, or codes. */
async function handleSocialWeb(env) {
  // Everyone participates now; opt-in was simplified away. The profile IDs
  // still cannot be joined on, so this decrypts every account and then
  // resolves edges through account ids.
  const { results: rows } = await env.DB.prepare(
    'SELECT * FROM accounts'
  ).all();

  const accounts = [];
  for (const row of rows || []) accounts.push(await decryptAccount(env, row));

  const participating = new Map(accounts.map((account) => [account.id, account.profile_id]));
  const { results: grants } = await env.DB.prepare(
    'SELECT owner_account_id, viewer_account_id FROM grants WHERE revoked_at IS NULL'
  ).all();

  const edges = [];
  for (const grant of grants || []) {
    const source = participating.get(grant.owner_account_id);
    const target = participating.get(grant.viewer_account_id);
    if (source && target && source !== target) edges.push({ source, target });
  }

  accounts.sort((a, b) => a.profile_id.localeCompare(b.profile_id));
  edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  return json({
    nodes: accounts.map((account) => ({
      profileId: account.profile_id,
      displayName: account.is_public ? (account.display_name || account.name || '') : 'Anonymous',
    })),
    edges,
  }, 200, { 'Cache-Control': 'no-store' });
}

/**
 * Read-only, signed-in diagnostic for the Social web. It is deliberately not
 * on /api/social-web itself, because the graph response should stay stable for
 * UI caching and debugging: this is a separate path used only to answer
 * "why do I see only N people here?" questions.
 *
 * It does not expose emails, courses, code hashes, or firebase UIDs. It only
 * returns plaintext counts and the kind of relationship relevant to the caller's
 * own perspective.
 */
async function handleSocialWebDiagnostic(request, env, account) {
  // Every account is in the Social web now, so "total" is simply the table.
  const { results: rows } = await env.DB.prepare('SELECT id FROM accounts').all();
  const total = (rows || []).length;

  const { results: edges } = await env.DB.prepare(
    `SELECT owner_account_id, viewer_account_id FROM grants WHERE revoked_at IS NULL`
  ).all();

  // Relationships are directional (owner -> viewer); from this account's point
  // of view only adjacency matters, so count distinct neighbours either way.
  const outgoing = Number((await env.DB.prepare(
    'SELECT count(*) AS c FROM grants WHERE owner_account_id = ? AND revoked_at IS NULL'
  ).bind(account.id).first())?.c ?? 0);

  const neighbours = new Set();
  for (const edge of edges || []) {
    if (edge.owner_account_id === account.id) neighbours.add(edge.viewer_account_id);
    if (edge.viewer_account_id === account.id) neighbours.add(edge.owner_account_id);
  }
  const relatedSeenByMe = neighbours.size;

  return json({
    totals: {
      totalParticipants: total,
      relationshipsFromMe: outgoing,
      relatedSeenByMe,
      notRelatedToMe: Math.max(0, total - 1 - relatedSeenByMe),
    },
    me: {
      profileId: account.profile_id,
      isPublic: Boolean(account.is_public),
    },
  }, 200, { 'Cache-Control': 'no-store' });
}

async function handleMe(request, env, account) {
  if (request.method === 'GET') return json(publicSelf(account));

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const fields = [];
    const values = [];

    // These three stay plaintext: they are privacy switches rather than
    // profile data, and the directory and social web both filter on them in
    // SQL, which is not possible over ciphertext.
    if (typeof body.isPublic === 'boolean') {
      fields.push('is_public = ?');
      values.push(body.isPublic ? 1 : 0);
    }
    if (typeof body.autoGrant === 'boolean') {
      fields.push('auto_grant = ?');
      values.push(body.autoGrant ? 1 : 0);
    }
    // Everyone is in the Social web now; this switch no longer exists.

    // Encrypted fields are gathered first so each can be written with the row's
    // profile_id as its additional authenticated data. The original columns are
    // not rewritten: this account arrived through currentAccount, so
    // repairAccount has already replaced them with placeholders.
    const next = {};
    if (typeof body.displayName === 'string') {
      next.display_name = body.displayName.trim().slice(0, 80);
    }
    if (typeof body.timeFormat === 'string') {
      next.time_format = body.timeFormat === '24h' ? '24h' : '12h';
    }
    if (body.grade === null || typeof body.grade === 'number') {
      next.grade = body.grade;
    }
    if (body.lunchWave === null || typeof body.lunchWave === 'number') {
      next.lunch_wave = body.lunchWave;
    }
    if (body.blockPrefs !== undefined) {
      next.block_prefs = JSON.stringify(body.blockPrefs);
    }
    if (body.schedulePrefs !== undefined) {
      next.schedule_prefs = JSON.stringify(body.schedulePrefs);
    }

    for (const [field, value] of Object.entries(next)) {
      fields.push(`${field}_enc = ?`);
      values.push(await encryptField(env, value, accountAad(account.profile_id, field)));
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
    return json(publicSelf(await decryptAccount(env, updated)));
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
  //
  // is_public stays plaintext so this stays a SQL WHERE clause, but the match
  // cannot be: LIKE over AES-GCM ciphertext is meaningless, and a blind index
  // only answers exact matches. So the public rows are decrypted here and
  // matched in JS, which is what keeps the search box working. At the scale of
  // one school the whole public table is small.
  const { results: rows } = await env.DB.prepare(
    'SELECT * FROM accounts WHERE is_public = 1'
  ).all();

  const matches = [];
  for (const row of rows || []) {
    const account = await decryptAccount(env, row);
    const displayName = account.display_name || account.name || '';
    const haystack = `${account.profile_id} ${displayName}`.toLowerCase();
    if (q && !haystack.includes(q)) continue;
    matches.push({ profileId: account.profile_id, displayName, sortKey: displayName.toLowerCase() });
  }

  matches.sort((a, b) => (q
    ? a.profileId.localeCompare(b.profileId)
    : a.sortKey.localeCompare(b.sortKey) || a.profileId.localeCompare(b.profileId)));

  return json({
    profiles: matches
      .slice(0, 25)
      .map(({ profileId, displayName }) => ({ profileId, displayName })),
  });
}

async function lookupAccountByProfileId(env, profileId) {
  const wanted = String(profileId || '').trim().toLowerCase();
  if (!wanted) return null;
  const candidates = await blindIndexCandidates(env, 'profile_id', wanted);
  const row = await env.DB.prepare(
    `SELECT * FROM accounts
      WHERE profile_id_bidx IN (${placeholders(candidates.length)}) OR profile_id = ?`
  )
    .bind(...candidates, wanted)
    .first();
  return readAccount(env, row);
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
  // The join key is a numeric account id, which stays plaintext, so both joins
  // remain in SQL. Only the profile ID and name they used to select have to be
  // decrypted afterwards. a.* carries every encrypted column; the request id is
  // aliased so it cannot collide with the account id in the same row.
  const incoming = await env.DB.prepare(
    `SELECT r.id AS request_id, r.status, r.created_at, a.*
       FROM requests r JOIN accounts a ON a.id = r.from_account_id
      WHERE r.to_account_id = ? ORDER BY r.created_at DESC`
  )
    .bind(account.id)
    .all();
  const outgoing = await env.DB.prepare(
    `SELECT r.id AS request_id, r.status, r.created_at, a.*
       FROM requests r JOIN accounts a ON a.id = r.to_account_id
      WHERE r.from_account_id = ? ORDER BY r.created_at DESC`
  )
    .bind(account.id)
    .all();
  return json({
    incoming: await mapRequests(env, incoming.results),
    outgoing: await mapRequests(env, outgoing.results),
  });
}

async function mapRequests(env, rows) {
  const out = [];
  for (const row of rows || []) {
    out.push(mapRequest(row.request_id, row.status, row.created_at, await decryptAccount(env, row)));
  }
  return out;
}

function mapRequest(id, status, createdAt, account) {
  return {
    id,
    status,
    createdAt,
    profileId: account.profile_id,
    displayName: account.display_name || account.name || '',
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
    `SELECT g.id AS grant_id, g.created_at, a.*
       FROM grants g JOIN accounts a ON a.id = g.viewer_account_id
      WHERE g.owner_account_id = ? AND g.revoked_at IS NULL
      ORDER BY g.created_at DESC`
  )
    .bind(account.id)
    .all();
  const incoming = await env.DB.prepare(
    `SELECT g.id AS grant_id, g.created_at, a.*
       FROM grants g JOIN accounts a ON a.id = g.owner_account_id
      WHERE g.viewer_account_id = ? AND g.revoked_at IS NULL
      ORDER BY g.created_at DESC`
  )
    .bind(account.id)
    .all();
  const shape = async (rows) => {
    const out = [];
    for (const row of rows.results || []) {
      const other = await decryptAccount(env, row);
      out.push({
        id: row.grant_id,
        since: row.created_at,
        profileId: other.profile_id,
        displayName: other.display_name || other.name || '',
      });
    }
    return out;
  };
  return json({ viewers: await shape(outgoing), viewing: await shape(incoming) });
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
  // This used to join accounts on json_extract(payload, '$.profileId'), which
  // stops being possible the moment the payload becomes ciphertext. So the
  // payloads are decrypted first and the profiles they name are then resolved in
  // one query through their blind indexes.
  const { results: rows } = await env.DB.prepare(
    `SELECT id, kind, payload, payload_enc, created_at, seen_at
       FROM notices WHERE account_id = ? ORDER BY created_at DESC LIMIT 50`
  )
    .bind(account.id)
    .all();

  const notices = [];
  const stale = [];
  for (const row of rows || []) {
    let payload = await decryptField(env, row.payload_enc || row.payload, noticeAad(account.id));
    // A payload written before this change is still a JSON string.
    if (typeof payload === 'string') payload = safeJson(payload);
    if (!payload || typeof payload !== 'object') payload = {};

    // Migrate notices written before payloads were encrypted. One CASE
    // statement covers the whole page, so this stays a single round trip.
    if (!isEncrypted(row.payload_enc)) {
      stale.push({ id: row.id, enc: await encryptField(env, payload, noticeAad(account.id)) });
    }
    notices.push({ row, payload });
  }

  if (stale.length) {
    const when = stale.map(() => 'WHEN ? THEN ?').join(' ');
    const ids = stale.map(() => '?').join(', ');
    await env.DB.prepare(
      `UPDATE notices SET payload = '{}', payload_enc = CASE id ${when} ELSE payload_enc END
        WHERE id IN (${ids})`
    )
      .bind(...stale.flatMap((s) => [s.id, s.enc]), ...stale.map((s) => s.id))
      .run();
  }

  const actors = await accountsByProfileId(env, notices.map((n) => n.payload.profileId));

  return json({
    notices: notices.map(({ row, payload }) => {
      const actor = actors.get(payload.profileId);
      return {
        id: row.id,
        kind: row.kind,
        payload,
        createdAt: row.created_at,
        seen: Boolean(row.seen_at),
        // Who did this, so the page can name them instead of saying "Someone".
        // Resolved at read time, so a name change is reflected on old notices.
        actorName: actor ? actor.display_name || actor.name || '' : '',
        actorProfileId: payload.profileId || '',
      };
    }),
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
  if (path === '/api/social-web/diagnostic' && method === 'GET') return handleSocialWebDiagnostic(request, env, account);

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

// Exported for the test suite. The Worker itself only uses the default export;
// these are here so worker/test can read a stored row the way the Worker reads
// it, instead of asserting against ciphertext it cannot interpret. They are
// inert in production, and deleting them would not change a single response.
export {
  ACCOUNT_FIELD_NAMES,
  accountAad,
  blindIndexFor,
  decryptAccount,
  decryptField,
  encryptField,
  isEncrypted,
  isRedacted,
};

// Diagnostic helper for the new read-only Social web status page. It is
// deliberately not part of the public response; it exists so the page can
// show "why do I only see N people here?" without leaking anything else.
