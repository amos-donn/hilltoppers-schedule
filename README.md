# Hilltoppers Schedule

The schedule card from the Hilltoppers Chrome extension, hosted as a standalone
page for GitHub Pages. It is meant to be added to the extension as a Topping:
the page is what the extension's iframe loads.

## Live

**GitHub Pages:** https://amos-donn.github.io/hilltoppers-schedule/

Two pages:

- **`index.html` — the schedule card.** This is what the Topping iframe shows.
  At a narrow width the card fills the frame edge to edge, matching the
  extension's card at the same width (see *Sizing* below).
- **`settings.html` — Class & Schedule Settings.** A dashboard, laid out like
  the Hilltoppers extension's own settings: a sidebar of three tabs — Account,
  Friends, and Notices — with one section shown at a time instead of one long
  scroll. Each tab is in the URL (`settings.html#friends`), so a refresh returns
  to it and Back steps between them. **Account** holds everything about you and
  your own schedule: signing in, your display name, profile ID and visibility,
  then time format, grade level, lunch, and your A–E courses with their
  alternating / free options, and finally the option to delete your account.
  **Friends** lists the schedules shown on the card and who can see yours. Open
  it from the gear on the card, or directly. Changes save to this browser and
  the card picks them up; friends who share their schedule through the account
  appear on the card even inside the extension's iframe (see *Where the card's
  friends come from*).

## Sharing your schedule

The card shows a friend's schedule, not your own. To put yourself on someone
else's card, send them your link:

1. On `settings.html`, enter your email (and an optional name) under **Send
   Schedule**. The link is built as you type.
2. **Copy link** copies it to your clipboard, and you send it however you like
   (email, message, whatever).
3. When they open the link, your schedule is added to their card and saved under
   your email. It appears in their **Friends** list, where they can reorder or
   remove it.

The card's **Friends' Schedules** section shows every friend in the order set in
Settings, each as its own card with the class they are in right now (for example
`C Block · AP US History`). Tapping a friend's card expands their whole day as an
accordion.

How it works, and its limits:

- The link carries your display preferences in the URL **fragment** (`#share=…`),
  so they never reach GitHub's servers or its logs. The fragment is cleared from
  the address bar once it has been imported.
- The recipient recomputes the live schedule from the same public data sources,
  so the schedule stays current rather than freezing a snapshot.
- The link is the credential: anyone who has it can add that schedule. Do not
  post it publicly.
- This is a static site with **no backend and no accounts**, so there is no
  server-side email and no sync. Sharing is a link you copy and send yourself,
  and friends are stored in each browser's `localStorage`. A friend added on one
  device or browser will not appear on another.


### Deploying a change

GitHub Pages serves every file with `Cache-Control: max-age=600` under an
unversioned name, so `index.html` and the scripts it loads can come from
different deploys for up to ten minutes after a push. New HTML running against a
script from before the change is how the page once came up blank: the page called
an export the older script did not have, and the throw happened before the card
mounted.

Two things keep that from recurring:

- `index.html` loads its scripts and stylesheet with a `?v=YYYYMMDD` query
  (**bump it when you change any of them**). The query is part of the cache key,
  so a fresh HTML pulls fresh scripts instead of a cached older copy.
- The page never depends on a new cross-file export without a fallback. Calls
  into `schedule-friends.js` are guarded, and a window `error` handler paints a
  "refresh the page" message if startup ever throws with an empty card, so a
  mismatch degrades instead of showing nothing.

## How it works

There is no build step. The card itself needs no backend: it loads the JSON the
project already publishes and renders in the browser. The optional account
features (friends' schedules, the settings page) use the Cloudflare Worker in
`worker/`.

```
index.html          the card (iframe target)
settings.html       Class & Schedule Settings
schedule-core.js    shared: time zone, data loading, block display, preferences
schedule-card.js    renders the card, ported from the extension's Popup.tsx
schedule-friends.js how the embedded card gets an account's friends
account.js          talks to the Worker; loaded by both pages
popup.css           the extension's popup.css, copied unchanged
classSettings.css   the extension's classSettings.css, copied unchanged
dashboard.css       the settings page's Hilltoppers shell: sidebar tabs, the
                    sage palette, custom dropdowns, and the Google button
toppings-resize.js  the Topping spec's content-height helper, copied unchanged
schedule/           the bell schedules, bundled (see below)
icons/              the site's logo, favicons, and Apple touch icon
```

### The card's shape

Two sections, both built from the same day's blocks:

- **Your schedule** — the primary card. Collapsed it is the live status card: the
  period badge, the subject, the period's time span and the time left, with the
  progress bar underneath. Tapping anywhere on it expands the whole day as an
  accordion. Who this is depends on how the page is running: opened directly and
  signed in, it is your account's own courses; opened directly and signed out, it
  falls back to the selected friend; embedded, it is the signed-in account (the
  frame cannot read the local settings).
- **Friends' Schedules** — one card per friend, each showing their name and the
  class they are in right now. Tapping a card expands their whole day as an
  accordion of its own.

Both countdowns tick in place; only the text nodes and progress fills are
written each second, and a full render happens at a block boundary (see the
commit history for why that matters).

### Where the card's friends come from

The card shows a friend's schedule, and which friends appear depends on where
the card is running — this is the one place the two pages differ.

- **Opened directly** (`index.html` on its own, or from the gear) it shares
  localStorage with `settings.html`, so it reads the friends saved there.
- **Embedded as a Topping** the card is in a cross-site iframe. Browsers
  partition localStorage and third-party cookies by top-level site, so inside
  the extension's frame the card cannot see anything the settings page saved. It
  would show "No friends yet" for a signed-in account. Instead the card asks the
  Worker for the account's grants — one per friend who has shared their schedule
  with you — and renders each grant's schedule as that friend. The Worker
  returns exactly the courses, lunch, grade and time format the card draws.
- **No account, or the cookie was withheld**: the empty card offers *Sign in to
  view friends!* rather than looking broken. It opens the sign-in in a tab, since
  Google will not render its consent screen inside an iframe.

A share link still works in either mode, and a friend who arrives both ways (a
link and a grant) is shown once, with the account's fresher data.

### Data sources

The extension fetches its schedule data from
`https://hilltoppers.pages.dev` (Cloudflare Pages, served with
`Access-Control-Allow-Origin: *`), so this page reads the same files:

| File | What it is |
| --- | --- |
| `special_days.json` | per-day overrides: `no_school`, `custom` schedules, a `color` |
| `special_periods.json` | breaks and holidays |
| `day_type.json` | the Green / White colour per day, already computed by the project |

The bell schedules (`schedule_mon_thu`, `schedule_wed`, `schedule_fri`,
`late_start`, `abdec`) are **not** published on `hilltoppers.pages.dev`, so they
are bundled in `schedule/` here, copied from
`chrome-extension/public/schedule/` in the main repository.

### One deliberate difference from the extension

The extension determines the day colour by scraping the school's Daily Bulletin
page and, when the bulletin is a day behind, predicting the next colour itself.
A page on `github.io` gets no CORS from `stjacademy.org`, so scraping the
bulletin is not possible here. Instead this page reads `day_type.json`, which
the project already computes once and publishes for exactly this reason. The
result is the same Green / White / No School label, with one fewer moving part.

Everything else — the layout, the classes, the block-display rules (custom
course names, alternating Green/White names, free blocks, grade-specific
blocks, the lunch highlight) — is ported to behave the same.

## Sizing

The extension's popup and this page look like the same card but are sized by
different rules, and that is where discrepancies come from.

- In the extension the popup is a `min-width: 320px; padding: 16px` window, so
  the card is a 320px content box inside a 352px window.
- Here the host picks the iframe width, and the frame is the edge, so the card
  runs to it. `index.html` overrides the copied `popup.css` gutter with
  `.popup { padding: 0 0 12px }` and squares the card's outer corners, so the
  card reaches the frame's top and both sides with only the page's own padding
  below it. The 12px inset the old gutter used to supply now sits on the card
  (`.primary-card > .status`), which keeps the text off the frame edge while the
  card's surface covers the full width.

That inset is 12px against the extension's 16px, so the two do not line up
pixel-for-pixel at the same width; the card's own content is what matches, not
its distance from the frame.

Measure, don't eyeball: render both at the same width and compare
`getBoundingClientRect()` on `.popup` / `.status` / `.schedule-list ul`.

### Building for the Topping frame

From the main repository's `AGENTS.md` and `worker/README.md`:

- The extension's popup has a **320px minimum content width** plus 16px padding,
  so its window is 352px. The Topping card is 320px wide including its 1px
  borders, leaving about **318px for the iframe viewport**.
- Build for the frame's actual width, not a hard-coded 320px. No fixed widths or
  minimum widths that would overflow; let text wrap and keep images and controls
  inside their container.
- Height is the host's choice: `heightMode: "fixed"` (the default, a scrolling
  frame) or `heightMode: "content"`, where the frame grows and shrinks with the
  content. Content mode needs the Topping to load the spec's `resize.js` and wrap
  its content in `[data-topping-content]`; this page copies `resize.js` to
  `toppings-resize.js` and puts the attribute on `#root`. The wrapper must be a
  natural-height element (no `100vh`, no fixed scrolling height) or shrinking
  will not work. The accordions are exactly the case content mode is for.

Verify at 318px, 360px and wider. `index.html` carries the responsive resets the
spec asks for (`box-sizing`, `max-width: 100%`, `overflow-wrap`) and drops the
friend's email below 320px so the live-status row never forces a horizontal
scrollbar.

## Embedding

```html
<iframe
  src="https://amos-donn.github.io/hilltoppers-schedule/"
  sandbox="allow-scripts allow-same-origin allow-popups"
  style="width: 360px; height: 600px; border: none; border-radius: 8px;"
  title="Schedule"
></iframe>
```

- `allow-scripts` — renders and ticks the countdown
- `allow-same-origin` — reads the published JSON
- `allow-popups` — opens the Daily Bulletin, the settings page, and sign-in in a
  new tab (sign-in must be a tab: Google will not render its consent screen in
  an iframe)

For **Fit content** height mode, the host should send the context message the
spec defines. `toppings-resize.js` reports the height only once it has seen a
`{channel: 'hilltoppers-topping-v1', type: 'context', heightMode: 'content'}`
message, so a fixed-height host needs no reply and the page simply never
resizes.

Note `allow-same-origin` together with `allow-scripts` means the frame is *not*
treated as a unique opaque origin, so it can still reach the Worker. The card
does not rely on sharing localStorage with `settings.html`; inside a frame it
asks the Worker for friends instead (see *Where the card's friends come from*).

## Preferences

The card and the settings page share one store, `localStorage` in this browser.
The schedule preferences use the same keys and shapes the extension uses in
`chrome.storage.sync` (`blockPreferences`, `schedulePreferences`); sharing adds
`friends`, `selectedFriend`, and `identity`. A hosted page has only its own
browser, so there is no account sync here; the extension's account/Firestore
sync is not reproduced.

## Development

Open `index.html` over HTTP (not `file://`, which blocks the fetches), for
example:

```bash
python3 -m http.server 8080
```

Then visit http://localhost:8080/index.html and http://localhost:8080/settings.html.
