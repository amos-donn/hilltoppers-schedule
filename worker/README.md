# Deploying the API Worker

You need two things before this works: the database tables and the Worker.
There are no sign-in credentials to create, because sign-in is not ours.

Students sign in with the account they already have for Hilltoppers, which is a
Firebase Auth project using the email/password provider. The browser signs in
against Firebase directly and hands the Worker the resulting ID token, which
the Worker verifies against Google's published keys. Only Google can mint a
token for that project, so a valid signature is a sound trust boundary — and
the Worker needs no Firebase secret of its own to check it.

Everything below is done in a browser. There is no build step and nothing to
install.

## What is already done

- D1 database `hilltoppers-schedule`, id `581d4ea8-71dc-4c44-ac7f-53df194cb1c4`
- Worker `hilltoppers-schedule-friends`, at
  `https://hilltoppers-schedule-friends.amos-donn.workers.dev`
- The `DB` binding, pointing at that database. No sign-in secret is needed:
  Firebase is verified from Google's published keys, and Hilltoppers owns the
  accounts.

## 1. Create the tables

The D1 console runs **one statement per call**. Pasting the whole file returns
`Requests without any query are not supported.`, so run each statement on its
own, in order, clicking **Execute** after each.

1. Cloudflare dashboard → **Storage & Databases → D1** → `hilltoppers-schedule`.
2. Open the **Console** tab.
3. Paste and Execute each of the 11 statements in `worker/schema.sql`, one at a
   time. Five create tables, six create indexes.
4. Check it worked:
   `SELECT name FROM sqlite_master WHERE type = 'table';`
   You should see `accounts`, `grants`, `notices`, `requests`, `sessions`.

Safe to re-run. Every statement is `CREATE ... IF NOT EXISTS`, so nothing is
ever dropped.

## Social web upgrade (existing databases)

Run `worker/migration-social-web.sql` once in the D1 console, and
`worker/migration-encrypt-fields.sql` for the encryption upgrade above. Fresh
databases created with the updated `schema.sql` already have both: do not run
the migrations there. Deploy the Worker before publishing the updated pages.

`GET /api/social-web` requires a session and returns only opted-in profile IDs,
display names, and active sharing edges whose two endpoints opted in. Arrows
run from schedule owner to recipient. Directory visibility is independent:
the Account checkbox explicitly explains that even private profiles appear
when they opt in. No emails, classes, grant IDs, or access codes are returned.
Opting out removes graph participation, not schedule access. Graph responses
are not cached; the UI refreshes on tab entry, consent changes, and Refresh.

The graph is rendered locally with SVG and a deterministic spring layout;
no external service receives social graph data.

## Field encryption (all profile fields)

Every profile field is encrypted with AES-256-GCM before it reaches D1, so
reading the database — through the D1 console, a Time Travel snapshot, a stolen
read-only token, or a SQL injection bug — yields ciphertext instead of students'
names, addresses, grades, and courses.

Each encrypted field that has to be found by an exact match also gets a blind
index: an HMAC of the value under a separately derived key. Lookups run against
the index, so the database never sees a plaintext value to search.

Three things deliberately stay readable, because they are not profile data and
because queries depend on them:

- `id` and the `grants` / `requests` foreign keys. **The shape of the social
  graph therefore remains visible** — "account 14 shares with 7, 22" — even
  though the names behind those ids are not. Hiding that needs client-side
  encryption, which would break search.
- `is_public`, `auto_grant`, `social_web_opt_in`, the timestamps, and the
  already-hashed `sessions.token_hash` and `grants.code_hash`.
- `notices.kind`.

### Rotating the key later

Put the current key in `DATA_KEY_PREV` and the new key in `DATA_KEY`, then
deploy. Old rows keep decrypting (each configured key is tried, and AES-GCM
authenticates so the wrong one cannot return something plausible), and every row
that is read is re-signed onto the new key automatically. Once nothing has read
the old value for long enough, remove `DATA_KEY_PREV`.

### Upgrading an existing database

Run these **in this order**. The order matters: the Worker reads the columns the
migration adds, so deploying it first makes every request fail.

1. **Run the migration.** `worker/migration-encrypt-fields.sql` has 14
   `ALTER TABLE ... ADD COLUMN` statements and 3 `CREATE INDEX`. Run each one
   on its own in the D1 console, in order. It only adds columns — it never
   rebuilds or drops a table, because `sessions`, `grants`, `requests`, and
   `notices` all have foreign keys into `accounts` and dropping the parent table
   would cascade those rows away. The statements are not idempotent: one that
   fails with `duplicate column name` is already applied, so skip it.

   Verify with `PRAGMA table_info(accounts);` — you should see 13 new columns
   ending in `_enc` or `_bidx`.

2. **Set the key.** Cloudflare dashboard → the Worker → **Settings → Variables
   and Secrets** → **Add** → type **Secret**, name `DATA_KEY`, value = the
   output of the command below. Encrypt = on.

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

   **Back this value up somewhere safe.** Losing it makes every profile field
   already written unrecoverable, and there is no reset path short of signing
   every student up again.

3. **Deploy the Worker** as in step 3 below.

4. Nothing else. There is no backfill job: the Worker encrypts each legacy row
   the first time it is read, overwrites the original column with a placeholder,
   and fills in the blind index. Every authenticated request goes through that
   path, so accounts migrate as students use the site and the console clears
   progressively. You can watch it happen:

   ```sql
   SELECT COUNT(*) AS still_plaintext FROM accounts
   WHERE profile_id NOT LIKE 'enc:%';
   ```

   It should trend to zero.

### What this does not protect against

The key lives in the Worker's environment, which is readable by anyone with
access to the Cloudflare account. This protects the stored data, not the
account. Enabling 2FA on Cloudflare and not sharing the login is a separate and
still-necessary control.

## 2. Bind the database to the Worker

1. Cloudflare dashboard → **Workers & Pages** → `hilltoppers-schedule-friends`.
2. **Settings → Bindings → Add → D1 database**.
3. Variable name: `DB` (exactly — the code looks for this name).
4. Database: `hilltoppers-schedule`. Save.

## 3. Put the Worker code in place

1. Worker → **Edit code**.
2. Delete whatever is in the editor, paste the entire contents of
   `worker/api.js`, and **Deploy**.

That is the whole deployment. There is no framework and no dependencies, which
is why the browser editor is enough.

## 4. Check it works

Open this in a browser:

```
https://hilltoppers-schedule-friends.amos-donn.workers.dev/api/me
```

- Signed out, this should say `{"error":"unauthorized"}`. That is correct — it
  means the Worker is running and refusing anonymous access.

The sign-in itself cannot be checked from a URL, because it is a POST of an ID
token rather than a redirect. Sign in at
`https://amos-donn.github.io/hilltoppers-schedule/settings.html` with a
Hilltoppers account, then load `/api/me` again. You should get your own profile,
including a `profileId` like `brave-heron-4821`.

If signing in fails, open the browser console. The settings page reports what
Firebase said — a wrong password, an unknown address, or an address that has not
been confirmed yet.

## Notes for later

- **The Firebase project.** The Worker accepts tokens for `schedule-59d28`,
  hard-coded as `FIREBASE_PROJECT_ID` in `worker/api.js` and overridable with a
  plain-text variable of the same name. The project's web config lives in
  `auth.js` and is public on purpose: it names the project, it does not
  authorize anything.
- **Verifying a token by hand.** The keys are at
  `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`.
  Note `jwk`, singular — the plural path is a 404, and fetching an error page
  instead of the key set fails every verification in a way that looks exactly
  like a signed-out user.
- **Adding a field to `accounts`.** D1 has no interactive migration tool in the
  dashboard, so use the Console: `ALTER TABLE accounts ADD COLUMN ...`.
- **Changing the Worker.** Paste the whole file again and Deploy. The bindings
  you set in step 2 survive a code deploy.
- **No sign-in secret.** The Worker never reads `SESSION_SECRET` or the old
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, so any of those left over from the
  Google setup are inert and can be deleted at leisure. A `wrangler deploy` of
  this file drops them; the dashboard editor keeps them.
- **Cost.** Workers Free covers D1 at 5 million rows read and 100,000 rows
  written per day with 5 GB storage. A school's usage is far below this. Free
  limits hard-error for the rest of the day if exceeded, and Workers Paid is
  $5/month if it ever matters.

## Tests

The behaviour that matters here is cross-origin and cookie-driven, so the tests
drive the real pages rather than mocks.

```
npm install   # jsdom, the only dev dependency
npm test
```

Seven suites, all plain `node`:

- `worker/test/api.test.mjs` — the Worker against a real D1 shape via
  `node:sqlite`. Covers sign-in, forged, wrong-audience, wrong-project, expired
  and unverified-email ID tokens, cookie flags, profile edits, directory
  visibility, grants, revoke and account delete.
- `worker/test/encrypt.test.mjs` — the other half: what is actually *stored*.
  Asserts no readable profile field reaches D1, that a row written before
  encryption migrates and loses its plaintext on first read, that a ciphertext
  moved between rows refuses to open, that substring search and notice names
  still work, that a rotated key keeps old rows readable, and that
  `migration-encrypt-fields.sql` applies to a real pre-encryption database
  without losing rows or breaking the foreign keys.
- `worker/test/page.test.mjs` — `settings.html` in jsdom, talking to that same
  Worker and database. Catches the bugs a unit test cannot: a missing element
  id, an unstyled class, a button that never wires up, a render that throws.
- `worker/test/card.test.mjs` — `index.html`, the schedule card the Topping
  embeds. Confirms it consumes the friend entries the settings page writes, and
  that embedded in a frame it finds an account's friends through the Worker
  rather than localStorage.

`worker/test/harness.mjs` holds the shared Worker wiring: the in-memory
database, the fake Firebase signing key and the cookie jar. Both page suites run
against it, so they cannot drift apart. The tests mint real RS256 tokens and the
Worker verifies them for real, so the whole JWKS → `kid` → `importKey` → `verify`
path is exercised; only the key's publication is stubbed.

