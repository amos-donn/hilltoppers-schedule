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
- **`settings.html` — Class & Schedule Settings.** The schedule-affecting part
  of the extension's Class settings page. **My Profile** holds the display
  settings (time format, grade level, lunch) and your A–E courses with their
  alternating / free options; **Send Schedule** builds your share link; and
  **Friends** lists the schedules shown on the card. Open it from the gear on
  the card, or directly. Changes save to this browser and the card picks them
  up.

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

The card's **Friends** list shows every friend in the order set in Settings, each
with the class they are in right now (for example `C Block · AP US History`).
Tapping a row shows that person's schedule in the card above it.

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

## How it works

There is no build step and no backend. `index.html` loads the JSON the project
already publishes and renders the card in the browser.

```
index.html        the card (iframe target)
settings.html     Class & Schedule Settings
schedule-core.js  shared: time zone, data loading, block display, preferences
schedule-card.js  renders the card, ported from the extension's Popup.tsx
popup.css         the extension's popup.css, copied unchanged
classSettings.css the extension's classSettings.css, copied unchanged
schedule/         the bell schedules, bundled (see below)
```

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
- Here the host picks the iframe width. `popup.css` is copied unchanged, so its
  16px gutter would make a 320px frame render a 304px card. `index.html` drops
  the gutter below 480px (`@media (max-width: 480px) { .popup { padding: 0 } }`)
  so the card reaches the frame edges and lines up with the extension's card at
  the same width.

Measure, don't eyeball: render both at the same width and compare
`getBoundingClientRect()` on `.popup` / `.status` / `.schedule-list ul`.

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
- `allow-popups` — opens the Daily Bulletin and the settings page in a new tab

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
