/**
 * Field encryption tests for worker/api.js.
 *
 * The point of these is the raw database, not the API. Everything else in the
 * suite checks that a response is right; these check that what is actually
 * written to D1 is unreadable without the key, that the lazy migration clears
 * the plaintext an existing database already holds, and that the behaviour the
 * encryption cost something - substring search, notice names, key rotation -
 * still works.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import {
  API_ORIGIN, db, env, worker, routerFetch, signInAs, rawRowOfUid, blindIndexFor,
  TEST_DATA_KEY, TEST_DATA_KEY_PREV,
} from './harness.mjs';

// Firebase's signing key is served by the harness's fake JWKS, so the Worker's
// real verification path runs without reaching the network.
globalThis.fetch = routerFetch;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`  ok  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err && err.message}`);
  }
}

const now = () => Math.floor(Date.now() / 1000);
const sha256hex = (text) => createHash('sha256').update(text).digest('hex');

/** A D1-shaped wrapper, for the separate databases the migration tests open. */
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
    this.db.prepare(this.sql).run(...this.params);
    return { success: true };
  }
}

/** Call the Worker directly with a chosen env, for rotation and key tests. */
async function callWith(targetEnv, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // signInAs hands back a full "ht_session=..." pair; mintSession returns a bare token.
  if (cookie) headers.Cookie = cookie.startsWith('ht_session=') ? cookie : `ht_session=${cookie}`;
  const request = new Request(`${API_ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await worker.fetch(request, targetEnv);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

/** Mint a session straight in the database, the way sign-in would. */
function mintSession(uid, accountId) {
  const token = `test-token-${uid}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(sha256hex(token), accountId, now(), now() + 3600);
  return token;
}

const rowFor = (uid) => rawRowOfUid(uid);

/** Everything stored for every account, as one searchable string. */
function dumpAccounts() {
  return JSON.stringify(db.prepare('SELECT * FROM accounts').all());
}

await test('a new account writes no readable profile field to D1', async () => {
  const cookie = await signInAs('enc-alice', 'alice.enc@example.org', 'Alice Encrypted');
  const me = await callWith(env, '/api/me', { cookie });
  assert.equal(me.status, 200);

  const row = await rowFor('enc-alice');
  for (const field of ['firebase_uid', 'email', 'name', 'profile_id', 'display_name',
    'time_format', 'block_prefs', 'schedule_prefs']) {
    assert.match(row[`${field}_enc`], /^v1\.a\./, `${field} is stored as ciphertext`);
  }
  // grade and lunch_wave are null here, but still encrypted rather than absent.
  assert.match(row.grade_enc, /^v1\.a\./, 'grade is stored as ciphertext');
  assert.match(row.lunch_wave_enc, /^v1\.a\./, 'lunch_wave is stored as ciphertext');

  const dump = dumpAccounts();
  for (const secret of ['alice.enc@example.org', 'Alice Encrypted', 'enc-alice', me.body.profileId]) {
    assert.ok(!dump.includes(secret), `the row dump must not contain ${secret}`);
  }
});

await test('the original columns hold placeholders, not the profile', async () => {
  await signInAs('enc-bob', 'bob.enc@example.org', 'Bob Encrypted');
  const row = await rowFor('enc-bob');
  // NOT NULL columns keep a value, and it must be an obvious non-value.
  for (const field of ['firebase_uid', 'email', 'profile_id', 'time_format',
    'block_prefs', 'schedule_prefs']) {
    assert.ok(row[field].startsWith('enc:'), `${field} holds a placeholder, got ${row[field]}`);
  }
  assert.equal(row.name, null);
  assert.equal(row.display_name, null);
  assert.ok(!dumpAccounts().includes('bob.enc@example.org'));
});

await test('profile updates are written as ciphertext too', async () => {
  const cookie = await signInAs('enc-carol', 'carol.enc@example.org', 'Carol Encrypted');
  await callWith(env, '/api/me', {
    cookie,
    method: 'PATCH',
    body: {
      displayName: 'Carol Renamed', grade: 11, lunchWave: 2,
      blockPrefs: { A: { name: 'AP Biology' } }, isPublic: true,
    },
  });
  const row = await rowFor('enc-carol');
  assert.ok(!dumpAccounts().includes('Carol Renamed'));
  assert.ok(!dumpAccounts().includes('AP Biology'));
  // grade and lunch_wave are nullable, so the old columns are simply cleared
  // rather than filled with a placeholder: no integer column ever sees a
  // ciphertext string.
  assert.equal(row.grade, null);
  assert.equal(row.lunch_wave, null);
  assert.match(row.grade_enc, /^v1\.a\./, 'grade lives in the ciphertext column');
  assert.match(row.lunch_wave_enc, /^v1\.a\./, 'lunch_wave lives in the ciphertext column');
  // is_public is a privacy switch, filtered in SQL, so it stays readable.
  assert.equal(row.is_public, 1);
});

await test('a ciphertext moved to another row refuses to open', async () => {
  await signInAs('enc-dave', 'dave.enc@example.org', 'Dave');
  const alice = await rowFor('enc-alice');
  const dave = await rowFor('enc-dave');
  const cookie = mintSession('enc-dave', dave.id);

  // Move Alice's display-name ciphertext onto Dave's row. The row binding in
  // the AES-GCM additional data should make this fail loudly, not quietly hand
  // Dave Alice's name.
  db.prepare('UPDATE accounts SET display_name_enc = ? WHERE id = ?')
    .run(alice.display_name_enc, dave.id);
  const res = await callWith(env, '/api/me', { cookie });
  assert.equal(res.status, 500, 'a relocated ciphertext must not resolve');
  assert.match(res.text, /authentication/, 'and must say why');
  // Restore the deliberately corrupted fixture before later public-list reads.
  db.prepare('UPDATE accounts SET display_name_enc = ? WHERE id = ?').run(dave.display_name_enc, dave.id);
});


// ---------------------------------------------------------------------------
// The lazy migration
// ---------------------------------------------------------------------------

/** Insert a row in the shape a pre-encryption database would have. */
function insertLegacyAccount(uid, email, name, profileId) {
  const ts = now();
  db.prepare(
    `INSERT INTO accounts (firebase_uid, email, name, profile_id, display_name,
        time_format, grade, lunch_wave, block_prefs, schedule_prefs, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '12h', 11, 2, '{"A":{"name":"Chem"}}', '{}', ?, ?)`
  ).run(uid, email, name, profileId, name, ts, ts);
  return db.prepare('SELECT id FROM accounts WHERE profile_id = ?').get(profileId).id;
}

await test('a row written before encryption is migrated the first time it is read', async () => {
  const id = insertLegacyAccount('old-erin', 'erin.old@example.org', 'Erin Old', 'calm-willow-9001');
  assert.ok(!db.prepare('SELECT profile_id_enc FROM accounts WHERE id = ?').get(id).profile_id_enc,
    'the legacy row starts with no ciphertext at all');

  const cookie = mintSession('old-erin', id);
  const me = await callWith(env, '/api/me', { cookie });
  assert.equal(me.status, 200, 'the migrated row reads normally');
  assert.equal(me.body.profileId, 'calm-willow-9001', 'and returns the right profile');
  assert.equal(me.body.email, 'erin.old@example.org');
  assert.equal(me.body.grade, 11, 'including an integer field');
  assert.equal(me.body.blockPrefs.A.name, 'Chem', 'and a JSON field');

  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  assert.match(row.profile_id_enc, /^v1\.a\./, 'the profile ID is now ciphertext');
  assert.match(row.email_enc, /^v1\.a\./);
  assert.match(row.block_prefs_enc, /^v1\.a\./);
  assert.ok(row.profile_id_bidx, 'and it has a blind index');
  assert.ok(row.firebase_uid_bidx, 'so it is findable by uid');
  for (const field of ['firebase_uid', 'email', 'profile_id']) {
    assert.ok(row[field].startsWith('enc:'), `${field} plaintext is gone`);
    assert.ok(!row[field].includes('erin'), `${field} no longer hints at the address`);
  }
  assert.equal(row.name, null);
  assert.equal(row.grade, null, 'the nullable integer column is cleared, not overwritten');
  assert.ok(!dumpAccounts().includes('erin.old@example.org'));
});

await test('a migrated row signs in again by uid', async () => {
  // The blind index has to be right, or the account would look brand new and a
  // second account would be created for the same person.
  const cookie = await signInAs('old-erin', 'erin.old@example.org', 'Erin Old');
  const count = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const me = await callWith(env, '/api/me', { cookie });
  assert.equal(me.body.profileId, 'calm-willow-9001', 'the same account came back');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, count,
    'and no second account was created');
});

await test('a legacy notice payload is migrated and still names its actor', async () => {
  const ownerId = (await rowFor('old-erin')).id;
  const daveId = insertLegacyAccount('legacy-dave', 'dave.old@example.org', 'Dave Old', 'swift-cedar-4242');
  // A notice in the old shape: plaintext JSON in the payload column.
  db.prepare(
    `INSERT INTO notices (account_id, kind, payload, created_at) VALUES (?, 'request.received', ?, ?)`
  ).run(ownerId, JSON.stringify({ profileId: 'swift-cedar-4242' }), now());
  // Give Dave a session and let him send a real request so the actor lookup has
  // an unmigrated counterparty to resolve.
  mintSession('legacy-dave', daveId);

  const notices = await callWith(env, '/api/notices', { cookie: mintSession('old-erin', ownerId) });
  assert.equal(notices.status, 200);
  const row = notices.body.notices.find((n) => n.kind === 'request.received');
  assert.ok(row, 'the notice is still returned');
  assert.equal(row.actorProfileId, 'swift-cedar-4242', 'the acting profile is resolved');
  assert.equal(row.actorName, 'Dave Old', 'and is named, from an encrypted accounts row');

  const stored = db.prepare('SELECT payload, payload_enc FROM notices WHERE account_id = ?').get(ownerId);
  assert.equal(stored.payload, '{}', 'the plaintext payload is gone');
  assert.match(stored.payload_enc, /^v1\.a\./, 'and the payload is ciphertext');
});

// ---------------------------------------------------------------------------
// What the encryption cost, and must not cost
// ---------------------------------------------------------------------------

await test('directory substring search still works on encrypted fields', async () => {
  const cookie = await signInAs('enc-searcher', 'searcher@example.org', 'Searcher');
  await callWith(env, '/api/me', {
    cookie, method: 'PATCH', body: { isPublic: true, displayName: 'Wilhelmina Testperson' },
  });
  db.prepare('UPDATE accounts SET is_public = 1 WHERE id = ?').run((await rowFor('old-erin')).id);

  // A partial handle, not a whole one: the case LIKE used to handle and that a
  // blind index cannot.
  const byHandle = await callWith(env, '/api/directory?q=willow', { cookie });
  assert.ok(byHandle.body.profiles.some((p) => p.profileId === 'calm-willow-9001'),
    'a partial profile ID still matches');

  const byName = await callWith(env, '/api/directory?q=wilhelmina', { cookie });
  assert.ok(byName.body.profiles.some((p) => p.displayName === 'Wilhelmina Testperson'),
    'a partial display name still matches');

  const exact = await callWith(env, '/api/directory?q=calm-willow-9001', { cookie });
  assert.equal(exact.body.profiles.length, 1, 'and an exact handle finds exactly one');
});

await test('a schedule still reads back through an encrypted owner row', async () => {
  const ownerId = (await rowFor('old-erin')).id;
  const viewerId = insertLegacyAccount('enc-viewer', 'viewer@example.org', 'Viewer', 'nimble-quail-3003');
  const cookie = mintSession('enc-viewer', viewerId);

  assert.equal((await callWith(env, '/api/schedule/calm-willow-9001', { cookie })).status, 403,
    'no grant, no schedule');

  db.prepare(
    `INSERT INTO grants (code_hash, owner_account_id, viewer_account_id, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(`hash-${ownerId}`, ownerId, viewerId, now());

  const schedule = await callWith(env, '/api/schedule/calm-willow-9001', { cookie });
  assert.equal(schedule.status, 200);
  assert.equal(schedule.body.displayName, 'Erin Old');
  assert.equal(schedule.body.grade, 11);
  assert.equal(schedule.body.lunchWave, 2);
  assert.equal(schedule.body.blockPrefs.A.name, 'Chem');
});

await test('the social web graph survives encrypted endpoints', async () => {
  const owner = await signInAs('enc-web-owner', 'web.owner@example.org', 'Web Owner');
  const viewer = await signInAs('enc-web-viewer', 'web.viewer@example.org', 'Web Viewer');
  // Public with auto-grant, so the request becomes a grant immediately: the
  // graph shows sharing edges, not pending requests.
  await callWith(env, '/api/me', {
    cookie: owner, method: 'PATCH', body: { isPublic: true, autoGrant: true },
  });
  const ownerMe = await callWith(env, '/api/me', { cookie: owner });
  const viewerMe = await callWith(env, '/api/me', { cookie: viewer });
  await callWith(env, '/api/requests', {
    cookie: viewer, method: 'POST', body: { profileId: ownerMe.body.profileId },
  });

  const graph = await callWith(env, '/api/social-web', { cookie: viewer });
  assert.equal(graph.status, 200);
  assert.ok(graph.body.nodes.some((n) => n.profileId === ownerMe.body.profileId),
    'every account appears, opt-in or not');
  assert.ok(graph.body.nodes.some((n) => n.profileId === viewerMe.body.profileId));
  assert.ok(graph.body.edges.some((e) =>
    e.source === ownerMe.body.profileId && e.target === viewerMe.body.profileId),
  'the live grant draws its edge');
  assert.ok(graph.body.nodes.every((n) => !/^v1\./.test(n.profileId)),
    'nodes carry real profile IDs, not ciphertext');
  assert.equal(
    graph.body.nodes.find((n) => n.profileId === ownerMe.body.profileId).displayName,
    'Web Owner',
    'public names decrypt'
  );
});

// ---------------------------------------------------------------------------
// Key rotation and misconfiguration
// ---------------------------------------------------------------------------

await test('a rotated key still reads rows written under the old one', async () => {
  const cookie = await signInAs('rot-sub', 'rotate@example.org', 'Rotate Me');
  const before = await callWith(env, '/api/me', { cookie });
  const row = await rowFor('rot-sub');
  const indexBefore = row.profile_id_bidx;

  const rotated = { ...env, DATA_KEY: TEST_DATA_KEY_PREV, DATA_KEY_PREV: TEST_DATA_KEY };
  const after = await callWith(rotated, '/api/me', { cookie });
  assert.equal(after.status, 200, 'the old ciphertext decrypts with the previous key');
  assert.equal(after.body.profileId, before.body.profileId);

  // The blind index has to span both keys too, or a lookup by profile ID would
  // miss the row and sign-in would create a duplicate account.
  const found = await callWith(rotated, '/api/schedule/' + before.body.profileId, { cookie });
  assert.equal(found.status, 200, 'the profile is still findable through the previous index');

  // Reading the row is also what re-signs its index onto the new key.
  const migrated = db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.id);
  assert.notEqual(migrated.profile_id_bidx, indexBefore, 'the index was re-signed onto the new key');
  const current = await blindIndexFor(rotated, 'profile_id', before.body.profileId);
  assert.equal(migrated.profile_id_bidx, current, 'and matches what the new key produces');
});

await test('dropping the previous key fails loudly instead of returning garbage', async () => {
  const cookie = await signInAs('rot2-sub', 'rotate2@example.org', 'Rotate Two');
  const broken = { ...env, DATA_KEY: TEST_DATA_KEY_PREV };
  const res = await callWith(broken, '/api/me', { cookie });
  assert.equal(res.status, 500);
  assert.match(res.text, /authentication/, 'it says the value would not authenticate');
});

await test('a missing or malformed DATA_KEY refuses to serve rather than storing plaintext', async () => {
  const cookie = await signInAs('key-sub', 'key@example.org', 'Key Holder');
  for (const bad of ['', 'too-short', 'not base64 at all !!!']) {
    const res = await callWith({ ...env, DATA_KEY: bad }, '/api/me', { cookie });
    assert.equal(res.status, 500, `DATA_KEY=${JSON.stringify(bad)} must not be tolerated`);
    assert.match(res.text, /DATA_KEY/, 'the error names the missing secret');
  }
});

// ---------------------------------------------------------------------------
// The migration file, run against a database shaped like the old one
//
// This is the order the deployment actually happens in - migrate the existing
// database, then deploy the Worker - so the file is executed here for real
// rather than trusted.
// ---------------------------------------------------------------------------

/** Rebuild schema.sql as it looked before this change. */
function preEncryptionSchema() {
  return readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
    .replace(/^\s*\w+_(?:enc|bidx)\s+TEXT,?\n/gm, '')
    .replace(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS idx_accounts_\w+_bidx[^;]*;\n/gm, '')
    // The new columns were appended last, so removing them leaves a dangling
    // comma on whatever is now the final column.
    .replace(/,(\s*)\)/g, '$1)');
}

/** Split a migration file into statements the way the D1 console runs them. */
function statements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

await test('the migration applies to a pre-encryption database without losing rows', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const legacyDb = new DatabaseSync(':memory:');
  legacyDb.exec(preEncryptionSchema());
  legacyDb.exec('PRAGMA foreign_keys = ON');

  const columns = () => legacyDb.prepare('PRAGMA table_info(accounts)').all().map((r) => r.name);
  assert.ok(!columns().includes('profile_id_enc'), 'the old schema really has no encrypted columns');

  const ts = now();
  legacyDb.prepare(
    `INSERT INTO accounts (firebase_uid, email, name, profile_id, display_name,
        time_format, grade, lunch_wave, block_prefs, schedule_prefs, created_at, updated_at)
     VALUES ('mig-1','mig@example.org','Mig Student','brave-sparrow-5150','Mig Student',
             '12h', 12, 1, '{"A":{"name":"Physics"}}', '{}', ?, ?)`
  ).run(ts, ts);
  legacyDb.prepare(
    `INSERT INTO notices (account_id, kind, payload, created_at) VALUES (1, 'request.received', '{"profileId":"brave-sparrow-5150"}', ?)`
  ).run(ts);

  const migration = readFileSync(new URL('../migration-encrypt-fields.sql', import.meta.url), 'utf8');
  for (const sql of statements(migration)) legacyDb.exec(sql);

  const after = columns();
  for (const field of ['firebase_uid', 'email', 'name', 'profile_id', 'display_name',
    'time_format', 'grade', 'lunch_wave', 'block_prefs', 'schedule_prefs']) {
    assert.ok(after.includes(`${field}_enc`), `${field}_enc was added`);
  }
  assert.ok(after.includes('profile_id_bidx') && after.includes('firebase_uid_bidx'), 'blind indexes added');

  // The important one: the migration must not have touched the existing rows.
  const row = legacyDb.prepare('SELECT * FROM accounts WHERE id = 1').get();
  assert.equal(row.profile_id, 'brave-sparrow-5150', 'the profile ID survived');
  assert.equal(row.grade, 12, 'an integer column kept its type');
  assert.equal(row.profile_id_enc, null, 'and nothing was invented for the new columns');
  assert.equal(legacyDb.prepare('SELECT COUNT(*) AS n FROM notices').get().n, 1,
    'and the notices table is intact, so its foreign key still resolves');
  legacyDb.close();
});

await test('the Worker migrates a real pre-encryption database on first use', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const legacyDb = new DatabaseSync(':memory:');
  legacyDb.exec(preEncryptionSchema());
  legacyDb.exec('PRAGMA foreign_keys = ON');
  const ts = now();
  legacyDb.prepare(
    `INSERT INTO accounts (firebase_uid, email, name, profile_id, display_name,
        time_format, grade, lunch_wave, block_prefs, schedule_prefs, created_at, updated_at)
     VALUES ('mig-2','real@example.org','Real Student','swift-badger-2020','Real Student',
             '24h', 10, 3, '{"B":{"name":"Chem"}}', '{}', ?, ?)`
  ).run(ts, ts);
  // is_public is a privacy switch and stays plaintext, so a public listing
  // still works on this old row.
  legacyDb.prepare('UPDATE accounts SET is_public = 1 WHERE id = 1').run();

  for (const sql of statements(readFileSync(new URL('../migration-encrypt-fields.sql', import.meta.url), 'utf8'))) {
    legacyDb.exec(sql);
  }

  // A session minted directly, since this database has no Firebase history.
  const token = 'migrated-db-token';
  legacyDb.prepare(
    'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, 1, ?, ?)'
  ).run(sha256hex(token), ts, ts + 3600);

  const legacyEnv = {
    ...env,
    DB: { prepare: (sql) => new Stmt(legacyDb, sql) },
  };
  const me = await callWith(legacyEnv, '/api/me', { cookie: token });
  assert.equal(me.status, 200, 'the migrated database serves a request');
  assert.equal(me.body.profileId, 'swift-badger-2020', 'with the right profile');
  assert.equal(me.body.email, 'real@example.org');
  assert.equal(me.body.grade, 10);
  assert.equal(me.body.lunchWave, 3);
  assert.equal(me.body.blockPrefs.B.name, 'Chem');

  const stored = JSON.stringify(legacyDb.prepare('SELECT * FROM accounts').all());
  assert.ok(!stored.includes('real@example.org'), 'the address is no longer readable in the table');
  assert.ok(!stored.includes('Real Student'), 'nor the name');
  assert.ok(!stored.includes('swift-badger-2020'), 'nor the profile ID');
  assert.ok(!stored.includes('Chem'), 'nor the courses');

  // And the account is still reachable by its profile ID afterwards.
  const dir = await callWith(legacyEnv, '/api/directory?q=badger', { cookie: token });
  assert.ok(dir.body.profiles.some((p) => p.profileId === 'swift-badger-2020'),
    'search finds it after migration');
  legacyDb.close();
});

console.log(results.join('\n'));
const failed = results.length - results.filter((r) => r.startsWith('  ok')).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
