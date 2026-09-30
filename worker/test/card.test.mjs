/**
 * Integration test for the schedule card (index.html).
 *
 * Two things are proved here.
 *
 * 1. The card consumes the friend shape the settings page writes -- courses,
 *    lunch wave, grade, time format. Rendering block names depends on the time
 *    of day (outside school hours the card correctly shows "School ended"), so
 *    rather than assert on visible text the card's own display resolver is
 *    driven with a saved friend entry. That resolver is what turns a friend's
 *    blockPrefs into a label, so testing it directly proves the integration
 *    without depending on the clock.
 *
 * 2. Embedded as a Topping, the card can still find the account's friends.
 *    A cross-site iframe does not share localStorage with the settings page and
 *    the browser withholds third-party cookies, so the card asks the Worker for
 *    the account's grants instead. The embedded card is mounted with an empty
 *    localStorage, so any friend that appears can only have come from the Worker.
 *
 * jsdom cannot express a frame: window.top is non-configurable and always self.
 * The page asks schedule-friends.js whether it is embedded, so that decision is
 * injected for the embedded case and left alone otherwise. The Worker, the fake
 * Firebase endpoints and the cookie jar come from ./harness.mjs, so this suite
 * and page.test.mjs share one backend.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import {
  API_ORIGIN, repoPath, routerFetch, wait, signInAs, setCookieJar, getCookieJar,
} from './harness.mjs';

// jsdom does not fetch, so the shared router serves both the Worker and the
// published schedule JSON.
const rawHtml = readFileSync(repoPath('index.html'), 'utf8');
const EST = 'America/New_York';

// A real school day for any weekday this might run on.
const specialDays = {};
for (let offset = -2; offset <= 14; offset++) {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: EST }).format(new Date(Date.now() + offset * 86400000));
  specialDays[key] = { type: 'abdec', color: 'Green Day' };
}
const abdec = readFileSync(repoPath('schedule/abdec.json'), 'utf8');

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.endsWith('.json')) {
    if (url.endsWith('special_days.json')) return new Response(JSON.stringify(specialDays), { status: 200 });
    if (url.endsWith('special_periods.json')) return new Response('[]', { status: 200 });
    if (url.endsWith('day_type.json')) return new Response('{}', { status: 200 });
    if (url.endsWith('abdec.json')) return new Response(abdec, { status: 200 });
    return new Response('null', { status: 200 });
  }
  return routerFetch(input, init);
};

// jsdom runs the page's own inline script during parse, before the externals can
// be supplied, so strip every script and inject them in order.
const inline = rawHtml.split('<script>').pop().split('</script>')[0];
const html = rawHtml.replace(/<script[\s\S]*?<\/script>/g, '');

/** Mount a fresh card. `frame` forces the embedded decision the page makes. */
function mountPage({ frame = false, seed = null, friendsSource = null } = {}) {
  const errors = [];
  const opens = [];
  const d = new JSDOM(html, {
    url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input, init) => globalThis.fetch(input, init);
      window.open = (url) => { opens.push(url); return null; };
    },
  });
  const w = d.window;
  w.addEventListener('error', (e) => errors.push(String(e.error || e.message)));

  for (const f of ['schedule-core.js', 'account.js', 'schedule-friends.js']) {
    const s = w.document.createElement('script');
    s.textContent = friendsSource && f === 'schedule-friends.js' ? friendsSource : readFileSync(repoPath(f), 'utf8');
    w.document.head.appendChild(s);
  }
  // The one seam: reading window.top is the only thing that decides framing,
  // and jsdom cannot be made to answer "framed".
  if (frame) w.HTFriends.isEmbedded = () => true;

  // Seeded before the page script runs, the way a returning visitor's browser
  // already holds it when the page loads.
  if (seed) {
    w.localStorage.setItem('friends', JSON.stringify(seed.friends));
    w.localStorage.setItem('selectedFriend', seed.selectedFriend);
  }

  const cardScript = w.document.createElement('script');
  cardScript.textContent = readFileSync(repoPath('schedule-card.js'), 'utf8');
  w.document.head.appendChild(cardScript);

  const pageScript = w.document.createElement('script');
  pageScript.textContent = inline;
  w.document.body.appendChild(pageScript);

  return {
    window: w,
    errors,
    opens,
    settle: async (times = 30) => { for (let i = 0; i < times; i++) await wait(25); },
    text: () => w.document.getElementById('root').textContent,
    // The page refreshes on visibilitychange, which is how a test re-runs the
    // load path after changing who is signed in.
    pokeRefresh: () => w.document.dispatchEvent(new w.Event('visibilitychange')),
  };
}

const patchProfile = (body) => routerFetch(`${API_ORIGIN}/api/me`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const myProfile = async () => (await routerFetch(`${API_ORIGIN}/api/me`)).json();

// Exactly what the settings page saves for a friend added from the directory.
const seeded = {
  email: 'brave-heron-4821',
  name: 'Erin',
  grade: 11,
  lunchWave: 1,
  timeFormat: '24h',
  blockPrefs: {
    A: { name: 'Chemistry', alternating: false },
    B: { name: 'English', alternating: false },
    C: { name: 'Physics', alternating: false },
    D: { name: 'History', alternating: false },
    E: { name: 'Free Block', alternating: false, free: true },
  },
};

const results = [];
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n        ${e && e.message}`); }
}

// ---------------------------------------------------------------------------
// Opened directly: friends come from localStorage, as before.
// ---------------------------------------------------------------------------
const local = mountPage({ frame: false, seed: { friends: [seeded], selectedFriend: seeded.email } });

await test('the card mounts without error', async () => {
  await local.settle();
  assert.equal(local.errors.length, 0, local.errors.join(' | '));
  assert.ok(local.window.document.getElementById('root').children.length > 0, 'something rendered');
});

await test('the seeded friend appears as the selected friend', async () => {
  assert.match(local.text(), /Erin/, 'the friend name is shown');
  assert.match(local.text(), /brave-heron-4821/, 'and their profile ID');
});

await test('the saved friend entry resolves to their custom course names', async () => {
  const H = local.window.HT;
  const display = H.resolveBlockDisplay('A Block', 'Green Day', seeded.blockPrefs);
  assert.equal(display.label, 'Chemistry', "the friend's own course name is used");
  assert.equal(display.isFree, false);
  const free = H.resolveBlockDisplay('E Block', 'Green Day', seeded.blockPrefs);
  assert.equal(free.isFree, true, 'a free block stays free');
});

await test('a friend with no courses still resolves to the real block name', async () => {
  const H = local.window.HT;
  const display = H.resolveBlockDisplay('A Block', 'Green Day', H.createEmptyPreferences());
  assert.equal(display.label, 'A Block', 'the default label is used rather than a blank');
});

await test('the card can load a real school day of blocks', async () => {
  const schedule = await local.window.HT.loadBlocksForDate(new Date());
  assert.notEqual(schedule.networkFailed, true, 'the schedule data loaded');
  assert.ok(schedule.blocks.length > 0, 'blocks are available to render');
});

await test('not embedded, the card does not ask the Worker for friends', async () => {
  // Same origin as settings.html, so localStorage already has the friends. This
  // also keeps the direct page working for a visitor with no account.
  const page = mountPage({ frame: false });
  let asked = false;
  page.window.HTAccount.listGrants = async () => { asked = true; return { ok: false }; };
  await page.settle();
  page.pokeRefresh();
  await page.settle();
  assert.equal(asked, false, 'the Worker was not asked for friends');
  assert.equal(page.errors.length, 0, page.errors.join(' | '));
});

// ---------------------------------------------------------------------------
// Embedded as a Topping: friends must come from the Worker.
// ---------------------------------------------------------------------------
await test('embedded with no session, the card offers sign-in', async () => {
  setCookieJar('');
  const page = mountPage({ frame: true });
  await page.settle();
  page.pokeRefresh();
  await page.settle();
  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  assert.match(page.text(), /Sign in to view friends!/, 'the empty card explains how to get friends');
  assert.ok(page.window.document.querySelector('.empty-action .empty-action__logo'),
    'and carries the Hilltoppers mark');

  // Clicking it must open a tab. The frame has no room for a sign-in form, and
  // the session belongs to the settings page, so the click hands off to it.
  const button = page.window.document.querySelector('.empty-action button');
  assert.ok(button, 'the sign-in button rendered');
  button.dispatchEvent(new page.window.Event('click', { bubbles: true }));
  assert.equal(page.opens.length, 1, 'sign-in opened exactly one tab');
  assert.match(page.opens[0], /settings\.html$/, 'pointing at the settings page, where signing in happens');
});

await test('embedded, the card shows the friends the account was granted', async () => {
  // Erin publishes her profile with auto-grant and saves real course data, the
  // way the settings page does.
  await signInAs('sub-card-erin', 'erin@example.org', 'Erin');
  await patchProfile({
    isPublic: true, autoGrant: true, displayName: 'Erin',
    grade: seeded.grade, lunchWave: seeded.lunchWave, timeFormat: seeded.timeFormat,
    blockPrefs: seeded.blockPrefs,
  });
  const erinProfile = (await myProfile()).profileId;

  // Alex signs in and asks for Erin's schedule. Public + auto-grant means the
  // grant is created immediately, which is the case the card has to render.
  await signInAs('sub-card-alex', 'alex@example.org', 'Alex');
  const alexCookie = getCookieJar();
  const ask = await routerFetch(`${API_ORIGIN}/api/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: erinProfile }),
  });
  assert.equal((await ask.json()).status, 'granted', 'the public profile granted access at once');

  // Mount as the Topping iframe would: Alex's session, empty localStorage.
  setCookieJar(alexCookie);
  const page = mountPage({ frame: true });
  await page.settle(60);

  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  assert.doesNotMatch(page.text(), /Get a life/, 'the empty state is not shown');
  assert.match(page.text(), /Erin/, 'the granted friend reaches the card');
  assert.match(page.text(), new RegExp(erinProfile), 'identified by profile id');

  // And the entry carries the real schedule data, not just a name.
  const outcome = await page.window.HTFriends.loadAccountFriends(page.window.HTAccount);
  const friend = outcome.friends.find((f) => f.email === erinProfile);
  assert.ok(friend, 'the grant became a friend entry');
  assert.equal(friend.grade, seeded.grade);
  assert.equal(friend.lunchWave, seeded.lunchWave);
  assert.equal(friend.timeFormat, seeded.timeFormat);
  const display = page.window.HT.resolveBlockDisplay('A Block', 'Green Day', friend.blockPrefs);
  assert.equal(display.label, 'Chemistry', 'the course the account saved reaches the card');
});

// ---------------------------------------------------------------------------
// The once-a-second countdown patches the card in place rather than rebuilding
// it. A full rebuild every tick is what made the card look like it was
// refreshing every few seconds, and it tore down and recreated every node --
// losing focus, hover and scroll -- on a clock tick that only moves a countdown.
// ---------------------------------------------------------------------------
await test('a clock tick updates the countdown in place instead of rebuilding the card', async () => {
  const d = new JSDOM('<div id="root"></div>', {
    url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
    runScripts: 'dangerously',
  });
  const w = d.window;
  for (const f of ['schedule-core.js', 'schedule-card.js']) {
    const s = w.document.createElement('script');
    s.textContent = readFileSync(repoPath(f), 'utf8');
    w.document.head.appendChild(s);
  }

  const H = w.HT;
  const dateKey = H.todayKey();
  const baseDate = H.parseDateKey(dateKey);
  const schedule = {
    dateKey,
    dayType: null,
    details: null,
    blocks: [
      { id: 'b1', name: 'A Block', start: '08:00', end: '09:00' },
      { id: 'b2', name: 'B Block', start: '09:00', end: '10:00' },
    ],
  };
  const friend = H.normalizeFriend({ email: 'erin@example.com', name: 'Erin', grade: 11 });
  const now = H.parseBlockTime('08:30', baseDate);

  const root = w.document.getElementById('root');
  const card = w.ScheduleCard.mount(root, {
    schedule, friends: [friend], selectedFriend: friend.email, now,
  });

  const statusBefore = root.querySelector('.status');
  const countdownBefore = root.querySelector('.time-value');
  assert.ok(countdownBefore, 'the countdown rendered');
  assert.equal(countdownBefore.textContent, '30:00', 'it starts at the real remaining time');
  assert.equal(root.querySelector('.progress-bar-fill').style.width, '50%', 'the bar is half way');

  // One second later: the same nodes, updated.
  card.tick(new Date(now.getTime() + 1000));
  assert.equal(root.querySelector('.status'), statusBefore, 'the status card was not rebuilt');
  assert.equal(root.querySelector('.time-value'), countdownBefore, 'the countdown node is the same node');
  assert.equal(countdownBefore.textContent, '29:59', 'and it advanced by a second');
  assert.match(root.querySelector('.progress-bar-fill').style.width, /^50\.0/, 'the bar advanced too');

  // Crossing a block boundary is a real transition, so the card does rebuild
  // and recomputes the status from the new time.
  card.tick(new Date(now.getTime() + 31 * 60 * 1000));
  assert.notEqual(root.querySelector('.status'), statusBefore, 'the boundary re-rendered');
  assert.match(root.textContent, /B Block/, 'the next block is now the current one');
  assert.equal(root.querySelector('.time-value').textContent, '59:00', 'counting down the new block');
});


// ---------------------------------------------------------------------------
// The primary card: collapsed it is the live status card (period, subject and
// remaining time); tapping it expands the whole day. The friends section below
// is one card per friend, each expanding to their own day.
// ---------------------------------------------------------------------------
await test('the collapsed primary card shows the period, subject and remaining time', async () => {
  const d = new JSDOM('<div id="root"></div>', {
    url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
    runScripts: 'dangerously',
  });
  const w = d.window;
  for (const f of ['schedule-core.js', 'schedule-card.js']) {
    const s = w.document.createElement('script');
    s.textContent = readFileSync(repoPath(f), 'utf8');
    w.document.head.appendChild(s);
  }
  const H = w.HT;
  const baseDate = H.parseDateKey(H.todayKey());
  const schedule = {
    dateKey: H.todayKey(), dayType: null, details: null,
    blocks: [
      { id: 'b1', name: 'A Block', start: '08:00', end: '09:00' },
      { id: 'b2', name: 'B Block', start: '09:00', end: '10:00' },
    ],
  };
  const self = H.normalizeFriend({
    email: 'me@example.com', name: 'Sam', grade: 11,
    blockPrefs: { A: { name: 'Chemistry', alternating: false } },
  });
  const now = H.parseBlockTime('08:30', baseDate);
  const root = w.document.getElementById('root');
  w.ScheduleCard.mount(root, { schedule, self, now });

  // Collapsed: the day's list is not rendered, only the status card.
  assert.equal(root.querySelector('.schedule-list.collapsed') !== null, true, 'the day starts collapsed');
  assert.match(root.querySelector('.current-period').textContent, /8:00/, 'the block time span is named');
  assert.equal(root.querySelector('.time-value').textContent, '30:00', 'and the remaining time');
  assert.match(root.querySelector('.friend-heading').textContent, /Sam/, "the card is headed with the viewer's name");
  // The period badge sits on the name row next to the name, not stacked above
  // the subject, so the top of the card stays compact.
  const badge = root.querySelector('.status-heading-row .current-block-badge');
  assert.ok(badge, 'the period badge lives on the name row');
  assert.match(badge.textContent, /A Block/, 'and names the period');
  assert.equal(root.querySelector('.current-details .current-block-badge'), null, 'the badge is not repeated above the subject');
  assert.match(root.querySelector('.current-name').textContent, /Chemistry/, 'the subject is named on its own line');
});

await test('tapping the collapsed primary card expands the whole day', async () => {
  const d = new JSDOM('<div id="root"></div>', {
    url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
    runScripts: 'dangerously',
  });
  const w = d.window;
  for (const f of ['schedule-core.js', 'schedule-card.js']) {
    const s = w.document.createElement('script');
    s.textContent = readFileSync(repoPath(f), 'utf8');
    w.document.head.appendChild(s);
  }
  const H = w.HT;
  const baseDate = H.parseDateKey(H.todayKey());
  const schedule = {
    dateKey: H.todayKey(), dayType: null, details: null,
    blocks: [
      { id: 'b1', name: 'A Block', start: '08:00', end: '09:00' },
      { id: 'b2', name: 'B Block', start: '09:00', end: '10:00' },
    ],
  };
  const self = H.normalizeFriend({ email: 'me@example.com', name: 'Sam', grade: 11 });
  const root = w.document.getElementById('root');
  w.ScheduleCard.mount(root, { schedule, self, now: H.parseBlockTime('08:30', baseDate) });

  const status = root.querySelector('.status');
  assert.ok(status.classList.contains('is-tappable'), 'the card body reads as tappable');
  assert.equal(status.querySelector('.schedule-toggle'), null, 'there is no separate Schedule button to aim at');
  assert.equal(status.getAttribute('aria-expanded'), 'false', 'and the card announces it is folded');
  // The gear is not inside the tap target: a button nested in a button is not
  // operable, and it would toggle the day as well as open settings.
  assert.equal(status.querySelector('.settings-button'), null, 'the gear sits outside the tap target');
  assert.ok(root.querySelector('.primary-card > .settings-button-wrapper .settings-button'), 'and is still on the card');
  status.dispatchEvent(new w.Event('click', { bubbles: true }));

  assert.equal(root.querySelector('.schedule-list.collapsed'), null, 'the day is no longer collapsed');
  const blocks = root.querySelectorAll('.schedule-list .block-name');
  assert.equal(blocks.length, 2, 'the whole timetable is revealed');
  assert.equal(blocks[0].textContent, 'A Block');
  assert.equal(blocks[1].textContent, 'B Block');

  // The same card folds it back up: one control, both directions. The list
  // stays in the DOM (collapsed to zero height), so the class is the signal.
  const opened = root.querySelector('.status');
  assert.equal(opened.getAttribute('aria-expanded'), 'true', 'the open card says so');
  opened.dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.ok(root.querySelector('.schedule-list.collapsed'), 'tapping the card again folds the day away');
  assert.equal(root.querySelector('.schedule-list .module-collapse').style.height, '0px', 'and it is collapsed to nothing');
});

await test('tapping the settings gear does not fold the primary card', async () => {
  const d = new JSDOM('<div id="root"></div>', {
    url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
    runScripts: 'dangerously',
  });
  const w = d.window;
  for (const f of ['schedule-core.js', 'schedule-card.js']) {
    const s = w.document.createElement('script');
    s.textContent = readFileSync(repoPath(f), 'utf8');
    w.document.head.appendChild(s);
  }
  const H = w.HT;
  const baseDate = H.parseDateKey(H.todayKey());
  const schedule = {
    dateKey: H.todayKey(), dayType: null, details: null,
    blocks: [{ id: 'b1', name: 'A Block', start: '08:00', end: '09:00' }],
  };
  const self = H.normalizeFriend({ email: 'me@example.com', name: 'Sam', grade: 11 });
  const root = w.document.getElementById('root');
  w.ScheduleCard.mount(root, { schedule, self, now: H.parseBlockTime('08:30', baseDate) });

  root.querySelector('.status').dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.ok(root.querySelector('.schedule-list:not(.collapsed)'), 'the day is open');

  // The gear is a sibling of the tap target, so its own click cannot also fold
  // the day. Fire it and check the day is untouched.
  const gear = root.querySelector('.primary-card > .settings-button-wrapper .settings-button');
  assert.ok(gear, 'the gear is outside the tap target');
  gear.dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.ok(root.querySelector('.schedule-list:not(.collapsed)'), 'the day stays open behind the gear');
});

await test('tapping a lunch-wave block row opens it without folding the day', async () => {
  const d = new JSDOM('<div id="root"></div>', {
    url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
    runScripts: 'dangerously',
  });
  const w = d.window;
  for (const f of ['schedule-core.js', 'schedule-card.js']) {
    const s = w.document.createElement('script');
    s.textContent = readFileSync(repoPath(f), 'utf8');
    w.document.head.appendChild(s);
  }
  const H = w.HT;
  const baseDate = H.parseDateKey(H.todayKey());
  const schedule = {
    dateKey: H.todayKey(), dayType: null, details: null,
    blocks: [{
      id: 'b1', name: 'C Block', start: '11:20', end: '12:50',
      subBlocks: [
        { name: '1st Lunch', start: '11:20', end: '11:50' },
        { name: '2nd Lunch', start: '11:35', end: '12:05' },
      ],
    }],
  };
  const self = H.normalizeFriend({ email: 'me@example.com', name: 'Sam', grade: 11, lunchWave: 1 });
  const root = w.document.getElementById('root');
  w.ScheduleCard.mount(root, { schedule, self, now: H.parseBlockTime('11:30', baseDate) });

  root.querySelector('.status').dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.ok(root.querySelector('.schedule-list:not(.collapsed)'), 'the day is open');

  // The row's own handler opens the lunch waves; the card must stay open too.
  const row = root.querySelector('.block-row.expandable');
  assert.ok(row, 'the lunch block row is expandable');
  row.dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.ok(root.querySelector('.schedule-list:not(.collapsed)'), 'the day stays open behind the row');
  assert.ok(root.querySelector('.subblock-list'), 'and the lunch waves are revealed');
});

await test("the friends section is one card per friend, expanding to their day", async () => {
  const d = new JSDOM('<div id="root"></div>', {
    url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
    runScripts: 'dangerously',
  });
  const w = d.window;
  for (const f of ['schedule-core.js', 'schedule-card.js']) {
    const s = w.document.createElement('script');
    s.textContent = readFileSync(repoPath(f), 'utf8');
    w.document.head.appendChild(s);
  }
  const H = w.HT;
  const baseDate = H.parseDateKey(H.todayKey());
  const schedule = {
    dateKey: H.todayKey(), dayType: null, details: null,
    blocks: [
      { id: 'b1', name: 'A Block', start: '08:00', end: '09:00' },
      { id: 'b2', name: 'B Block', start: '09:00', end: '10:00' },
    ],
  };
  const self = H.normalizeFriend({ email: 'me@example.com', name: 'Sam', grade: 11 });
  const friend = H.normalizeFriend({
    email: 'erin@example.com', name: 'Erin', grade: 11,
    blockPrefs: { A: { name: 'Physics', alternating: false } },
  });
  const root = w.document.getElementById('root');
  w.ScheduleCard.mount(root, { schedule, self, friends: [friend], now: H.parseBlockTime('08:30', baseDate) });

  const section = root.querySelector('.friends-list');
  assert.ok(section, "the Friends' Schedules section rendered");
  assert.match(section.querySelector('.friends-heading').textContent, /Friends' Schedules/);

  const card = root.querySelector('.friend-card');
  assert.ok(card, 'one card per friend');
  assert.match(card.querySelector('.friend-name').textContent, /Erin/, 'the friend is named');
  assert.match(card.querySelector('.friend-course').textContent, /Physics/, 'with their live class');
  assert.match(card.querySelector('.friend-time').textContent, /30:00/, 'and the time left in it');
  assert.ok(card.querySelector('.schedule-list.collapsed'), 'their day starts collapsed');

  // Clicking the card expands their full day as an accordion.
  card.querySelector('.friend-card-head').dispatchEvent(new w.Event('click', { bubbles: true }));
  const open = root.querySelector('.friend-card');
  assert.equal(open.querySelector('.schedule-list.collapsed'), null, 'their day is expanded');
  assert.equal(open.querySelectorAll('.block-name').length, 2, 'showing every period');
});

await test('a clock tick advances every countdown in place, self and friends alike', async () => {
  const d = new JSDOM('<div id="root"></div>', {
    url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
    runScripts: 'dangerously',
  });
  const w = d.window;
  for (const f of ['schedule-core.js', 'schedule-card.js']) {
    const s = w.document.createElement('script');
    s.textContent = readFileSync(repoPath(f), 'utf8');
    w.document.head.appendChild(s);
  }
  const H = w.HT;
  const baseDate = H.parseDateKey(H.todayKey());
  const schedule = {
    dateKey: H.todayKey(), dayType: null, details: null,
    blocks: [{ id: 'b1', name: 'A Block', start: '08:00', end: '09:00' }],
  };
  const self = H.normalizeFriend({ email: 'me@example.com', name: 'Sam', grade: 11 });
  const friend = H.normalizeFriend({ email: 'erin@example.com', name: 'Erin', grade: 11 });
  const now = H.parseBlockTime('08:30', baseDate);
  const root = w.document.getElementById('root');
  const card = w.ScheduleCard.mount(root, { schedule, self, friends: [friend], now });

  const primaryBefore = root.querySelector('.time-value');
  const friendBefore = root.querySelector('.friend-time');
  assert.equal(primaryBefore.textContent, '30:00');
  assert.equal(friendBefore.textContent, '30:00');

  card.tick(new Date(now.getTime() + 1000));
  assert.equal(root.querySelector('.time-value'), primaryBefore, 'the primary countdown node is unchanged');
  assert.equal(root.querySelector('.friend-time'), friendBefore, 'the friend countdown node is unchanged');
  assert.equal(primaryBefore.textContent, '29:59', 'the primary countdown advanced');
  assert.equal(friendBefore.textContent, '29:59', 'the friend countdown advanced');
});

await test('your own schedule is read from this browser when the page is opened directly', async () => {
  const d = new JSDOM('<div id="root"></div>', {
    url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
    runScripts: 'dangerously',
  });
  const w = d.window;
  for (const f of ['schedule-core.js', 'schedule-friends.js']) {
    const s = w.document.createElement('script');
    s.textContent = readFileSync(repoPath(f), 'utf8');
    w.document.head.appendChild(s);
  }
  // Nothing saved yet: there is no self to show.
  assert.equal(w.HTFriends.selfFromLocal(), null, 'an unconfigured browser has no self');

  w.HT.saveIdentity({ name: 'Sam', email: 'sam@example.com' });
  w.HT.saveSchedulePrefs({ lunchPeriod: 1, timeFormat: '24h', lunchWave: 2, graduationYear: w.HT.graduationYearFromGrade(11) });
  const self = w.HTFriends.selfFromLocal();
  assert.ok(self, 'a configured browser has a self');
  assert.equal(self.name, 'Sam');
  assert.equal(self.timeFormat, '24h', 'the saved time format is carried');
  assert.equal(self.grade, 11, 'the saved grade is carried');
  assert.equal(self.lunchWave, 2, 'and the lunch wave');
});


await test('signed in, the primary card is your own schedule even opened directly', async () => {
  // Alex is still signed in from the embedded test above. Give the account its
  // own courses, then mount the page the way a signed-in visitor opening it
  // directly would -- no frame, and nothing saved in localStorage.
  await patchProfile({
    displayName: 'Alex', grade: 12, lunchWave: 2, timeFormat: '24h',
    blockPrefs: { A: { name: 'Calculus', alternating: false } },
  });
  const page = mountPage({ frame: false });
  await page.settle(60);
  page.pokeRefresh();
  await page.settle(60);

  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  assert.match(page.window.document.querySelector('.friend-heading').textContent, /Alex/,
    'the primary card is headed with the account name');
  // Their own courses reach the card, not a friend's.
  const H = page.window.HT;
  const me = page.window.HTAccount.current();
  assert.equal(me.displayName, 'Alex', 'the account is the source of the primary card');
  const display = H.resolveBlockDisplay('A Block', 'Green Day', me.blockPrefs);
  assert.equal(display.label, 'Calculus', 'the account courses are used');
});



// GitHub Pages caches every file for ten minutes under an unversioned name, so
// a just-deployed index.html can briefly run against a schedule-friends.js from
// before that deploy. PR #22 made the page call two exports that file did not
// have, and a missing one threw before the card mounted -- the page came up
// blank. The page now degrades to "no self schedule" instead, so the card still
// renders. This runs the real index.html with the pre-#22 friend module.
await test('a stale cached schedule-friends.js does not blank the page', async () => {
  const staleFriends = readFileSync(repoPath('schedule-friends.js'), 'utf8')
    // Strip the two exports the page gained, leaving the older module behind.
    .replace(/selfFromAccount: selfFromAccount,?\n/, '')
    .replace(/selfFromLocal: selfFromLocal,?\n/, '');

  const page = mountPage({ friendsSource: staleFriends });
  await page.settle(40);

  assert.equal(page.errors.length, 0, 'no uncaught error escapes: ' + page.errors.join(' | '));
  assert.ok(page.text().length > 0, 'the card renders rather than coming up blank');
  assert.match(page.text(), /Settings/, 'the card still shows its settings affordance');
});

await test('the narrow-frame inset is the same on all four sides', async () => {
  // A frame narrower than the extension window swaps the card's 16px gutter
  // for a small inset. That inset was once horizontal-only, so the card sat
  // flush against the frame's top edge while being gapped on the sides -- a
  // visibly lopsided frame. The padding is a single shorthand value, so the
  // sides cannot drift from the top and bottom again.
  const match = rawHtml.match(/@media \(max-width: 480px\)\s*\{[\s\S]*?\.popup\s*\{([^}]*)\}/);
  assert.ok(match, 'the narrow-frame rule for .popup is present');
  const padding = match[1].match(/padding:\s*([^;]+);/);
  assert.ok(padding, '.popup sets a padding');
  const parts = padding[1].trim().split(/\s+/);
  assert.equal(parts.length, 1, 'padding is one value, so every side matches: ' + padding[1]);
  assert.equal(parts[0], '12px', 'and it is the intended inset');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length - passed ? 1 : 0);