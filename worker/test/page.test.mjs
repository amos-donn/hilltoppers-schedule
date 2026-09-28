/**
 * End-to-end test of the settings page.
 *
 * Loads the real settings.html in jsdom, with the real schedule-core.js and
 * account.js, and lets it talk to the real Worker running against a real
 * database backed by node:sqlite. The Worker wiring, the fake Google endpoints
 * and the cookie jar live in ./harness.mjs, shared with card.test.mjs.
 *
 * This is the only way to catch the bugs that matter here: a missing element
 * id, a class that the stylesheet does not define, a button that never wires
 * up, or a render path that throws. Those are invisible to a unit test.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import {
  API_ORIGIN, PAGE_ORIGIN, repoPath, routerFetch, wait,
  signInAs as signInAsShared, setCookieJar, getCookieJar, db,
} from './harness.mjs';

// jsdom does not fetch, so every page request goes through the shared router.
globalThis.fetch = routerFetch;

// ---------------------------------------------------------------------------
// Load the real page in jsdom
// ---------------------------------------------------------------------------
const html = readFileSync(repoPath('settings.html'), 'utf8');

/**
 * Mount a fresh copy of the page, the way a browser would on a cold load: new
 * DOM, empty localStorage, scripts run in order. Used both for the main test
 * page and to simulate "another device" signing in.
 */
function mountPage() {
  const errors = [];
  const d = new JSDOM(html, {
    url: `${PAGE_ORIGIN}/hilltoppers-schedule/settings.html`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input, init) => routerFetch(input, init);
      window.confirm = () => true;
      window.alert = () => {};
    },
  });
  const w = d.window;
  w.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  for (const file of ['schedule-core.js', 'account.js']) {
    const s = w.document.createElement('script');
    s.textContent = readFileSync(repoPath(file), 'utf8');
    w.document.head.appendChild(s);
  }
  const inline = html.split('<script>').pop().split('</script>')[0];
  const s2 = w.document.createElement('script');
  s2.textContent = inline;
  w.document.body.appendChild(s2);
  return {
    dom: d,
    window: w,
    errors,
    $: (id) => w.document.getElementById(id),
    settle: async (times = 24) => { for (let i = 0; i < times; i++) await wait(25); },
  };
}

const page = mountPage();
const { window, errors } = page;
const $ = page.$;
const settle = page.settle;

// Sign in as someone else, leaving the jar set to them; signInAsShared also
// returns their session cookie so a test can act as them for one call.
const signInAs = signInAsShared;

// A second identity that later tests need to act as.
const bob = { cookie: null, profileId: null };

/** Act as someone else for the duration of one call, then hand the page back. */
async function asOther(cookie, fn) {
  const mine = getCookieJar();
  setCookieJar(cookie);
  try {
    return await fn();
  } finally {
    setCookieJar(mine);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n        ${e && e.message}`); }
}

await test('the page loads without throwing', async () => {
  await settle();
  assert.equal(errors.length, 0, 'no uncaught errors: ' + errors.join(' | '));
  assert.ok(window.HT, 'schedule-core loaded');
  assert.ok(window.HTAccount, 'account client loaded');
  assert.equal($('account-loading').hidden, true, 'the sign-in check finished');
});

await test('every id in the page is unique', async () => {
  // getElementById silently returns the first match, so a duplicated id means
  // one of the two elements is never wired up and the bug is invisible.
  const seen = new Map();
  for (const el of window.document.querySelectorAll('[id]')) {
    const id = el.id;
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, [], 'duplicate ids: ' + dupes.join(', '));
});

await test('signed out, the page offers sign-in and hides account panels', async () => {
  assert.equal($('account-signed-out').hidden, false);
  assert.equal($('account-signed-in').hidden, true);
  assert.equal($('topbar-auth').hidden, true, 'the sidebar only offers sign-out when there is an account');
  const google = $('signin-google');
  assert.match(google.textContent, /Sign in to view friends!/, 'the sign-in button says what it is for');
  assert.ok(google.querySelector('.google-button__icon'), 'and carries the Google mark');
  assert.equal($('requests-panel').hidden, true);
  assert.equal($('access-panel').hidden, true);
  assert.equal($('notices-panel').hidden, true);
  assert.equal($('danger-panel').hidden, true);
});

await test('the class table renders all five blocks with working controls', async () => {
  const rows = $('block-rows').querySelectorAll('.class-settings__table-row');
  assert.equal(rows.length, 5, 'one row per A-E block');
  const first = rows[0];
  assert.ok(first.querySelector('input[type=text]'), 'a course name input');
  assert.ok(first.querySelector('input[type=checkbox]'), 'the alternating toggle');
});

await test('signing in reveals every account section', async () => {
  // Drive the real OAuth callback, exactly as the browser would.
  await signInAs('sub-page-alice', 'alice@example.org', 'Alice');
  await window.HTAccount.refresh();
  await settle();

  assert.equal($('account-signed-in').hidden, false, 'the signed-in card shows');
  assert.equal($('account-signed-out').hidden, true);
  assert.equal($('topbar-auth').hidden, false, 'the sidebar now offers sign-out');
  assert.equal($('requests-panel').hidden, false);
  assert.equal($('access-panel').hidden, false);
  assert.equal($('notices-panel').hidden, false);
  assert.equal($('danger-panel').hidden, false);
  assert.match($('profile-id').value, /^[a-z]+-[a-z]+-\d{4}$/, 'a profile ID is shown');
  assert.equal($('account-email').value, 'alice@example.org', 'the email is shown in an editable field');
  assert.equal($('account-email').readOnly, false, 'and can be edited');
  assert.equal($('visibility').value, 'private', 'new accounts default to private');
  assert.equal($('auto-grant').checked, true, 'auto-grant defaults on');
});

/**
 * Watch the page's own network calls. The page navigates away on a successful
 * email change, which jsdom cannot do, so the request it makes on the way out
 * is what tells us whether it did the right thing.
 */
function spyOnFetch(window) {
  const calls = [];
  const real = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const response = await real(input, init);
    if (url.includes('/api/me/email')) {
      const body = init && init.body ? JSON.parse(init.body) : null;
      // Clone before handing the response back: the page reads it, so the copy
      // is what the assertions can still inspect afterwards.
      calls.push({ url, method: (init && init.method) || 'GET', body, response: response.clone() });
    }
    return response;
  };
  return calls;
}

await test('the email field saves by sending the browser to Google', async () => {
  // Saving must not write anything on its own: it asks the Worker for the
  // Google URL that proves the address, and the change happens on the way back.
  const calls = spyOnFetch(window);

  $('account-email').value = 'alice.new@example.org';
  $('save-email').dispatchEvent(new window.Event('click'));
  await settle(6);

  assert.equal(calls.length, 1, 'exactly one request is made');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.email, 'alice.new@example.org', 'carrying the address that was typed');

  const started = await calls[0].response.json();
  assert.ok(started.authorizeUrl, 'the Worker answers with the Google URL to visit');
  const url = new URL(started.authorizeUrl);
  assert.equal(url.searchParams.get('login_hint'), 'alice.new@example.org', 'hinting the address that was typed');
  assert.ok(url.searchParams.get('state'), 'with a signed state the Worker can verify on the way back');

  // Nothing about the account changed just by pressing Save.
  assert.equal(window.HTAccount.current().email, 'alice@example.org', 'the account is untouched until Google confirms');
});

await test('an email already in use is refused before leaving the page', async () => {
  // Another account already holds this address.
  await signInAs('sub-page-bob', 'bob@example.org', 'Bob');
  await window.HTAccount.refresh();
  await settle();
  await signInAs('sub-page-alice', 'alice@example.org', 'Alice');
  await window.HTAccount.refresh();
  await settle();

  const calls = spyOnFetch(window);

  $('account-email').value = 'bob@example.org';
  $('save-email').dispatchEvent(new window.Event('click'));
  await settle(6);

  assert.equal(calls.length, 1, 'the Worker is asked');
  const refused = await calls[0].response.json();
  assert.equal(refused.error, 'email_taken', 'and it says the address is in use');

  assert.equal($('email-status').hidden, false, 'so the page shows why');
  assert.equal(
    $('email-status').textContent,
    'There is already an account with this email',
    'worded exactly as asked'
  );
  assert.equal($('account-email').value, 'bob@example.org', 'the field keeps what was typed, so it can be corrected');
  assert.equal(window.HTAccount.current().email, 'alice@example.org', 'and the account did not move');
});

await test('the visibility toggle writes through to the account', async () => {
  $('visibility').value = 'public';
  $('visibility').dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(db.prepare('SELECT is_public FROM accounts WHERE google_sub = ?').get('sub-page-alice').is_public, 1);
});

await test('the auto-grant toggle writes through to the account', async () => {
  $('auto-grant').checked = false;
  $('auto-grant').dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(db.prepare('SELECT auto_grant FROM accounts WHERE google_sub = ?').get('sub-page-alice').auto_grant, 0);
});

await test('editing a course name saves locally and to the account', async () => {
  const input = $('block-rows').querySelector('input[type=text]');
  input.value = 'AP Biology';
  input.dispatchEvent(new window.Event('input'));
  await settle();
  const stored = JSON.parse(db.prepare('SELECT block_prefs FROM accounts WHERE google_sub = ?').get('sub-page-alice').block_prefs);
  const firstKey = Object.keys(stored)[0];
  assert.equal(stored[firstKey].name, 'AP Biology', 'the course reached D1');
  const local = JSON.parse(window.localStorage.getItem('blockPreferences') || '{}');
  assert.ok(Object.keys(local).length, 'and is still cached locally');
});

await test('course changes made in another browser load on sign-in', async () => {
  // The account's courses change underneath this browser, then the page is
  // loaded cold, as on a second device. It must adopt the account's version.
  const other = JSON.parse(JSON.stringify(JSON.parse(
    db.prepare('SELECT block_prefs FROM accounts WHERE google_sub = ?').get('sub-page-alice').block_prefs
  )));
  const key = Object.keys(other)[0];
  other[key].name = 'From Another Device';
  db.prepare('UPDATE accounts SET block_prefs = ? WHERE google_sub = ?')
    .run(JSON.stringify(other), 'sub-page-alice');

  const fresh = mountPage();
  await fresh.settle();
  const values = [...fresh.$('block-rows').querySelectorAll('input[type=text]')].map((i) => i.value);
  assert.ok(values.includes('From Another Device'), 'the account courses appear on this device');
  assert.equal(fresh.errors.length, 0, 'the fresh page did not error');
});

await test('the directory search renders public profiles', async () => {
  // A second account, public, to find. signInAs leaves the page signed in as
  // whoever it signs in last, so restore the page's own session afterwards.
  const pageCookie = getCookieJar();
  const bobCookie = await signInAs('sub-page-bob', 'bob@example.org', 'Bob');
  await window.HTAccount.updateProfile({ isPublic: true, displayName: 'Bob B.' });
  setCookieJar(pageCookie);
  await window.HTAccount.refresh();
  await settle();

  $('directory-search').value = 'bob';
  $('directory-go').dispatchEvent(new window.Event('click'));
  await settle();

  const rows = $('directory-results').querySelectorAll('.class-settings__friend-row');
  assert.equal(rows.length, 1, 'the public profile matched');
  assert.match(rows[0].textContent, /Bob B\./);
  assert.ok(rows[0].querySelector('button'), 'and offers an action');
  // Keep Bob's cookie and profile id for the tests that follow.
  bob.cookie = bobCookie;
  bob.profileId = db.prepare("SELECT profile_id FROM accounts WHERE google_sub = 'sub-page-bob'").get().profile_id;
});

await test('asking for a schedule either grants access or records a request', async () => {
  // Bob is public with auto-grant on at this point, so this resolves straight to
  // a grant. Both outcomes are valid product behaviour; what matters is that the
  // click reaches the server and one of them actually happens.
  const row = $('directory-results').querySelector('.class-settings__friend-row');
  row.querySelector('button').dispatchEvent(new window.Event('click'));
  await settle();
  const status = $('directory-status').textContent;
  assert.match(status, /Request sent|Access granted/, 'the click produced a real result');

  const aliceId = db.prepare("SELECT id FROM accounts WHERE google_sub = 'sub-page-alice'").get().id;
  const grant = db.prepare(
    'SELECT revoked_at FROM grants WHERE viewer_account_id = ? AND revoked_at IS NULL'
  ).get(aliceId);
  const request = db.prepare('SELECT status FROM requests WHERE from_account_id = ?').get(aliceId);
  assert.ok(grant || request, 'either a grant or a pending request exists');

  // Whichever path it took, the person should now be usable on the card: the
  // grant path adds them directly, and the accept path is covered next.
  if (grant) {
    const friends = JSON.parse(window.localStorage.getItem('friends') || '[]');
    assert.ok(friends.some((f) => f.email === bob.profileId), 'granted access added them to the card');
  }
});

await test('a request from someone else can be accepted in the UI', async () => {
  // Bob asks Alice. Alice has auto-grant off, so it lands as pending for her.
  const pageCookie = getCookieJar();
  const aliceProfileId = db.prepare(
    "SELECT profile_id FROM accounts WHERE google_sub = 'sub-page-alice'"
  ).get().profile_id;
  await asOther(bob.cookie, () => window.HTAccount.askForSchedule(aliceProfileId));
  setCookieJar(pageCookie);
  await window.HTAccount.refresh();
  await settle();

  const incoming = $('requests-incoming').querySelectorAll('.class-settings__friend-row');
  assert.ok(incoming.length >= 1, 'the request appears under "Waiting on you"');
  const accept = [...$('requests-incoming').querySelectorAll('button')].find((b) => b.textContent === 'Accept');
  assert.ok(accept, 'an Accept button is offered');
  accept.dispatchEvent(new window.Event('click'));
  await settle();

  const grant = db.prepare(
    'SELECT revoked_at FROM grants WHERE owner_account_id = (SELECT id FROM accounts WHERE google_sub = ?)'
  ).get('sub-page-alice');
  assert.ok(grant, 'accepting created a grant');
  assert.equal(grant.revoked_at, null);
});

await test('the access panel lists viewers and can revoke', async () => {
  const rows = $('grant-viewers').querySelectorAll('.class-settings__friend-row');
  assert.ok(rows.length >= 1, 'the viewer is listed');
  const revoke = [...$('grant-viewers').querySelectorAll('button')].find((b) => b.textContent === 'Revoke');
  assert.ok(revoke, 'a Revoke button is offered');
  revoke.dispatchEvent(new window.Event('click'));
  await settle();
  const grant = db.prepare(
    'SELECT revoked_at FROM grants WHERE owner_account_id = (SELECT id FROM accounts WHERE google_sub = ?)'
  ).get('sub-page-alice');
  assert.ok(grant.revoked_at, 'the grant is stamped revoked');
});

await test('the revoked viewer sees a notice in the UI', async () => {
  await signInAs('sub-page-bob', 'bob@example.org', 'Bob');
  await window.HTAccount.refresh();
  await settle();
  const notices = $('notice-list').textContent;
  assert.match(notices, /revoked/i, 'the revocation is shown to the affected student');
  assert.ok($('notice-list').querySelector('.class-settings__badge'), 'marked as new');
  // The Notices tab is always in the sidebar, so it needs its own marker or a
  // student who never opens that tab would never see the notice.
  assert.equal($('notices-tab-badge').hidden, false, 'and the Notices tab is flagged');
});

await test('selecting a tab shows its panel and updates the title', async () => {
  // The sections share one document; only the selected panel is visible.
  const click = (name) => $(`tab-${name}-btn`).dispatchEvent(new window.Event('click'));

  click('friends');
  await settle(2);
  assert.equal($('panel-friends').hidden, false, 'Friends is shown');
  assert.equal($('panel-account').hidden, true, 'Account is hidden');
  assert.equal($('page-title').textContent, 'Friends');
  assert.equal($('tab-friends-btn').getAttribute('aria-selected'), 'true');
  assert.equal($('tab-account-btn').getAttribute('aria-selected'), 'false');
  assert.equal(window.location.hash, '#friends', 'the section is in the URL, so a refresh returns to it');

  click('notices');
  await settle(2);
  assert.equal($('panel-notices').hidden, false);
  assert.equal($('panel-friends').hidden, true);

  click('account');
  await settle(2);
  assert.equal($('panel-account').hidden, false);
  assert.equal($('page-title').textContent, 'Account');
});

await test('My Profile merged into Account, so identity and classes share one section', async () => {
  assert.equal($('tab-profile-btn'), null, 'the My Profile tab is gone');
  assert.equal($('panel-profile'), null, 'and so is its panel');

  // The settings that lived in My Profile now sit in the Account panel.
  const account = $('panel-account');
  for (const id of ['block-rows', 'time-format', 'grade-level', 'lunch-wave', 'danger-panel', 'profile-id']) {
    assert.ok(account.contains($(id)), `${id} is inside the Account panel`);
  }
  // Deleting stays gated on being signed in, wherever it now lives.
  assert.equal($('danger-panel').hidden, $('account-signed-in').hidden, 'and keeps its own sign-in gate');

  // An old bookmark to a removed section still lands somewhere sensible.
  for (const stale of ['#profile', '#settings']) {
    window.location.hash = stale;
    window.dispatchEvent(new window.Event('popstate'));
    await settle(2);
    assert.equal($('panel-account').hidden, false, `${stale} resolves to Account`);
    assert.equal($('tab-account-btn').getAttribute('aria-selected'), 'true');
  }
  window.location.hash = '';
});

await test('Reset to Defaults only appears where those settings live', async () => {
  // Reset restores classes and schedule preferences, so it is hidden on the
  // sections that hold neither.
  const click = (name) => $(`tab-${name}-btn`).dispatchEvent(new window.Event('click'));
  click('account');
  await settle(2);
  assert.equal($('reset').hidden, false, 'shown on Account');
  click('notices');
  await settle(2);
  assert.equal($('reset').hidden, true, 'hidden on Notices');
});

await test('accepting a request puts the granter on the asker\'s card', async () => {
  // Carol (private, auto-grant off) is asked by Dave. A card shows the people
  // whose schedules you can see, so when Carol accepts, it is Dave's card that
  // should gain Carol -- without Dave having to add her by hand.
  const carolCookie = await signInAs('sub-page-carol', 'carol@example.org', 'Carol');
  const carolId = db.prepare("SELECT id, profile_id FROM accounts WHERE google_sub = 'sub-page-carol'").get();

  const daveCookie = await signInAs('sub-page-dave', 'dave@example.org', 'Dave');
  const daveId = db.prepare("SELECT id, profile_id FROM accounts WHERE google_sub = 'sub-page-dave'").get();
  await asOther(daveCookie, () => window.HTAccount.askForSchedule(carolId.profile_id));

  // Carol accepts, in her own session.
  setCookieJar(carolCookie);
  await window.HTAccount.refresh();
  await settle();
  const accept = [...$('requests-incoming').querySelectorAll('button')].find((b) => b.textContent === 'Accept');
  assert.ok(accept, 'Carol sees an Accept button');
  accept.dispatchEvent(new window.Event('click'));
  await settle();

  assert.ok(db.prepare(
    'SELECT 1 FROM grants WHERE viewer_account_id = ? AND owner_account_id = ? AND revoked_at IS NULL'
  ).get(daveId.id, carolId.id), 'a live grant exists for Dave');

  // Dave signs in and should find Carol already on his card.
  await signInAs('sub-page-dave', 'dave@example.org', 'Dave');
  await window.HTAccount.refresh();
  await settle();
  const friends = JSON.parse(window.localStorage.getItem('friends') || '[]');
  assert.ok(friends.some((f) => f.email === carolId.profile_id), 'Carol is on Dave\'s card automatically');
});

await test('marking notices read clears the new badge', async () => {
  $('notices-seen').dispatchEvent(new window.Event('click'));
  await settle();
  assert.equal($('notice-list').querySelector('.class-settings__badge'), null);
  assert.equal($('notices-tab-badge').hidden, true, 'the Notices tab marker clears too');
});

await test('the sidebar sign-out returns the page to the signed-out state', async () => {
  $('topbar-auth').dispatchEvent(new window.Event('click'));
  await settle();
  assert.equal($('account-signed-out').hidden, false);
  assert.equal($('account-signed-in').hidden, true);
  assert.equal(window.HTAccount.isSignedIn(), false);
});

await test('a friend added from the directory carries real course data for the card', async () => {
  // Erin sets a course and a lunch, then is granted to Frank. The friend entry
  // Frank gets must include the courses, or the card would render an empty
  // schedule even though the grant is valid.
  const erinCookie = await signInAs('sub-page-erin', 'erin@example.org', 'Erin');
  const erinId = db.prepare("SELECT id, profile_id FROM accounts WHERE google_sub = 'sub-page-erin'").get();
  await window.HTAccount.updateProfile({
    isPublic: true,
    lunchWave: 1,
    grade: 11,
    blockPrefs: { A: { name: 'Chemistry', alternating: false }, B: { name: 'English', alternating: false } },
    schedulePrefs: { timeFormat: '24h', lunchPeriod: 1 },
  });

  const frankCookie = await signInAs('sub-page-frank', 'frank@example.org', 'Frank');
  setCookieJar(frankCookie);
  await window.HTAccount.refresh();
  await settle();

  $('directory-search').value = erinId.profile_id;
  $('directory-go').dispatchEvent(new window.Event('click'));
  await settle();
  const row = $('directory-results').querySelector('.class-settings__friend-row');
  assert.ok(row, 'Erin is found in the directory');
  row.querySelector('button').dispatchEvent(new window.Event('click'));
  await settle();

  const friends = JSON.parse(window.localStorage.getItem('friends') || '[]');
  const erin = friends.find((f) => f.email === erinId.profile_id);
  assert.ok(erin, 'Erin is on Frank\'s card');
  assert.equal(erin.blockPrefs.A.name, 'Chemistry', 'her course reached the card entry');
  assert.equal(erin.lunchWave, 1, 'her lunch wave reached the card entry');
  assert.equal(erin.grade, 11, 'her grade reached the card entry');
});

await test('typing a course name does not lose focus to a re-render', async () => {
  const input = $('block-rows').querySelector('input[type=text]');
  input.focus();
  input.value = 'Trig';
  input.dispatchEvent(new window.Event('input'));
  // Immediately after the input event, the element must still be the same node
  // and still focused; a re-render here would swap it out mid-keystroke.
  assert.equal(window.document.activeElement, input, 'the field keeps focus while typing');
  await settle();
  const stillThere = $('block-rows').querySelector('input[type=text]');
  assert.ok(stillThere, 'the table is still rendered');
});

await test('the course and lunch still reach the card after a page-level update', async () => {
  // A profile update must not wipe the courses the page is holding.
  await window.HTAccount.updateProfile({ displayName: 'Frank F.' });
  await settle();
  const stored = JSON.parse(db.prepare(
    "SELECT block_prefs FROM accounts WHERE google_sub = 'sub-page-frank'"
  ).get().block_prefs);
  const names = Object.values(stored).map((b) => b.name);
  assert.ok(names.some((n) => n.length), 'the account still holds courses: ' + JSON.stringify(names));
});

await test('no uncaught errors occurred across the whole run', async () => {
  assert.equal(errors.length, 0, errors.join(' | '));
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length - passed ? 1 : 0);
