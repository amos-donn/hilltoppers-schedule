# Deploying the API Worker

You need three things before this works: the database tables, the Worker, and
the Google sign-in credentials. The order matters — the Worker's URL has to
exist before Google will accept it as a redirect, and the Worker needs the
Google keys before sign-in can work.

Everything below is done in a browser. There is no build step and nothing to
install.

## What is already done

- D1 database `hilltoppers-schedule`, id `581d4ea8-71dc-4c44-ac7f-53df194cb1c4`
- Worker `hilltoppers-schedule-friends`, at
  `https://hilltoppers-schedule-friends.amos-donn.workers.dev`
- `SESSION_SECRET` set as a Worker secret

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

## 3. Create the Google sign-in credentials

1. Go to <https://console.cloud.google.com> and create a project (name it
   anything, e.g. `hilltoppers`).
2. **APIs & Services → OAuth consent screen** (in newer layouts, **Google Auth
   Platform → Audience**).
   - User type: **External** is fine. You are not restricting to school
     accounts, so there is no reason to need a Workspace admin.
   - App name: `Hilltoppers Schedule`.
   - Support email and developer email: your address.
   - **Privacy policy URL:**
     `https://amos-donn.github.io/hilltoppers-schedule/privacy.html`
   - **Terms of service URL:**
     `https://amos-donn.github.io/hilltoppers-schedule/terms.html`
   - Scopes: leave the defaults. Sign-in uses `openid`, `email`, `profile`,
     and all three are non-sensitive, so no review is required.
   - You do **not** need to publish for testing: add yourself as a test user
     and it works. Publish only if you want everyone to be able to sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**.
   - **Authorized JavaScript origins:**
     `https://amos-donn.github.io`
   - **Authorized redirect URIs:**
     `https://hilltoppers-schedule-friends.amos-donn.workers.dev/api/auth/callback`
   - The redirect URI must match exactly. No trailing slash, `https`, that path.
4. Copy the **Client ID** and the **Client secret**.

## 4. Give the Worker the Google credentials

Back in the Worker → **Settings → Variables and Secrets**:

| Name | Value | Type |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | from step 3 | Text |
| `GOOGLE_CLIENT_SECRET` | from step 3 | **Secret** |

The client secret must be a Secret, never plain text. Save and deploy.

## 5. Put the Worker code in place

1. Worker → **Edit code**.
2. Delete whatever is in the editor, paste the entire contents of
   `worker/api.js`, and **Deploy**.

That is the whole deployment. There is no framework and no dependencies, which
is why the browser editor is enough.

## 6. Check it works

Open this in a browser:

```
https://hilltoppers-schedule-friends.amos-donn.workers.dev/api/me
```

- Signed out, this should say `{"error":"unauthorized"}`. That is correct — it
  means the Worker is running and refusing anonymous access.
- Now open
  `https://hilltoppers-schedule-friends.amos-donn.workers.dev/api/auth/login`.
  You should land on Google's account picker, and after choosing an account you
  should arrive at
  `https://amos-donn.github.io/hilltoppers-schedule/settings.html?auth=ok` —
  the GitHub Pages site, not the Worker. The Worker serves only `/api/*`, so a
  redirect back to the Worker's own origin would land on a JSON 404.
- Then run the first URL again. You should now get your own profile, including
  a `profileId` like `brave-heron-4821`.

If the Google step fails, check the redirect URI in step 3 first — it is the
cause almost every time.

## Notes for later

- **Adding a field to `accounts`.** D1 has no interactive migration tool in the
  dashboard, so use the Console: `ALTER TABLE accounts ADD COLUMN ...`.
- **Changing the Worker.** Paste the whole file again and Deploy. The bindings
  you set in steps 2 and 4 survive a code deploy.
- **If you ever rotate `SESSION_SECRET`**, everyone is signed out and signs back
  in. Nothing is lost, because sessions are the only thing it protects.
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
  `node:sqlite`. Covers sign-in, forged and wrong-audience ID tokens, cookie
  flags, profile edits, directory visibility, grants, revoke and account delete.
- `worker/test/page.test.mjs` — `settings.html` in jsdom, talking to that same
  Worker and database. Catches the bugs a unit test cannot: a missing element
  id, an unstyled class, a button that never wires up, a render that throws.
- `worker/test/card.test.mjs` — `index.html`, the schedule card the Topping
  embeds. Confirms it consumes the friend entries the settings page writes, and
  that embedded in a frame it finds an account's friends through the Worker
  rather than localStorage.

`worker/test/harness.mjs` holds the shared Worker wiring: the in-memory
database, the fake Google token/JWKS endpoints and the cookie jar. Both page
suites run against it, so they cannot drift apart.

