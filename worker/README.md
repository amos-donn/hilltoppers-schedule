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

Three suites, all plain `node`:

- `worker/test/api.test.mjs` — the Worker against a real D1 shape via
  `node:sqlite`. Covers sign-in, forged, wrong-audience, wrong-project, expired
  and unverified-email ID tokens, cookie flags, profile edits, directory
  visibility, grants, revoke and account delete.
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

