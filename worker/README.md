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

## What the Worker does

The pages on GitHub Pages are static; everything that needs an account is this
Worker. It is the only thing that talks to D1.

**Accounts and sign-in.** Google OAuth. The Worker sends the browser to Google,
and on the way back it trades the code for an ID token, verifies that token's
signature against Google's published keys, and only then writes anything. An
account is keyed on `google_sub`, so a changed name or email never changes who
you are. The browser gets a session cookie whose value is a random token; only
its SHA-256 hash is stored, so the database cannot be replayed as a login. The
cookie is `HttpOnly`, `SameSite=None` and `Secure`, because the pages and the
API are different origins.

**Profiles.** Every account has a public, human-readable `profile_id`
(`brave-heron-4821`), unique in the database and safe to show to anyone. The
email address is the opposite: it is never shown to another student, and it is
not how anyone is found. `is_public` only makes a profile discoverable in the
directory; it does not give anyone access to the courses.

**Sharing.** A grant is what lets one account read another's schedule. A grant
is created when the owner accepts a request, or immediately if the owner is
public *and* has turned auto-grant on — both off is the default for a new
account, so a request normally waits for the owner. Grants are revocable by the
owner, and a grant is required to read a schedule whether the owner is public
or private. The `code_hash` column holds a hash of a per-grant code that is
never returned by any endpoint and is not part of authorization; access is
decided by the grant row alone.

**Notices.** Accepting, declining, revoking and deleting an account all write a
notice for the other person. There is no email or push, so a student learns on
their next signed-in load.

### Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/auth/login` | Redirect to Google |
| GET | `/api/auth/callback` | Google returns here; sets the session cookie |
| POST | `/api/auth/logout` | Clears the session |
| GET | `/api/me` | The signed-in account |
| PATCH | `/api/me` | Display name, visibility, auto-grant, courses, schedule settings |
| DELETE | `/api/me` | Delete the account and everything it touched |
| POST | `/api/me/email` | Start an email change; returns the Google URL that proves the new address |
| GET | `/api/directory` | Search public profiles by handle or name |
| POST | `/api/requests` | Ask for a schedule by profile ID |
| GET | `/api/requests` | Incoming and outgoing requests |
| POST | `/api/requests/:id` | Accept or decline an incoming request |
| GET | `/api/grants` | Who can see my schedule, and whose I can see |
| DELETE | `/api/grants/:id` | Revoke someone's access |
| GET | `/api/notices` | My notices |
| POST | `/api/notices/seen` | Mark notices as read |
| DELETE | `/api/notices/:id` | Dismiss one notice |
| GET | `/api/schedule/:profileId` | The courses of a profile I have access to |

Everything except the three `/api/auth/*` routes needs a session, and returns
`401` without one. Privilege-sensitive values come from the session row, never
from the request body.

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

Six suites, all plain `node`:

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
- `worker/test/resize.test.mjs` — the Topping height protocol, including the
  content-height reports the extension accepts and the messages it ignores.
- `worker/test/privacy.test.mjs` — `privacy.html`. The contact address is
  deliberately not in the page source, so this is what fails if someone later
  writes it in as a literal address or a `mailto:` link.
- `worker/test/assets.test.mjs` — every page declares a favicon and an Apple
  touch icon, every declared file exists and is a real image, and the stylesheet
  cache-busting version moved with the change.

`worker/test/harness.mjs` holds the shared Worker wiring: the in-memory
database, the fake Google token/JWKS endpoints and the cookie jar. Both page
suites run against it, so they cannot drift apart.

