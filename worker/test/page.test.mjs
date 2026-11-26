/**
 * End-to-end test of the settings page.
 *
 * Loads the real settings.html in jsdom, with the real schedule-core.js and
 * account.js, and lets it talk to the real Worker running against a real
 * database backed by node:sqlite. The Worker wiring, the fake Firebase
 * endpoints and the cookie jar live in ./harness.mjs, shared with
 * card.test.mjs.
 *
 * This is the only way to catch the bugs that matter here: a missing element
 * id, a class that the stylesheet does not define, a button that never wires
 * up, or a render path that throws. Those are invisible to a unit test.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import {
  API_ORIGIN, PAGE_ORIGIN, repoPath, routerFetch, wait, idToken,
  signInAs as signInAsShared, setCookieJar, getCookieJar, db,
  accountOf, accountIdOf, plainFieldOf, setEncryptedFieldOf,
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
function mountPage(options = {}) {
  const errors = [];
  const d = new JSDOM(html, {
    url: `${PAGE_ORIGIN}/hilltoppers-schedule/settings.html`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input, init) => routerFetch(input, init);
      window.confirm = () => true;
      window.alert = () => {};
      // auth.js loads the Firebase SDK from a CDN with a dynamic import, which
      // jsdom cannot do. Stand in for it at its own boundary - the ID token -
      // so the page's own code still runs for real. A test overrides whichever
      // method it needs.
      window.HTAuth = options.auth || {
        CONFIG: {},
        load: async () => { throw new Error('the Firebase SDK is not available in jsdom'); },
        currentUser: async () => null,
        signIn: async () => { throw new Error('signIn is not stubbed'); },
        idToken: async () => null,
        signOut: async () => {},
      };
      // Seed storage before the page scripts run, the way a returning browser
      // would already have it on a cold load.
      for (const [key, value] of Object.entries(options.storage || {})) {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    },
  });
  const w = d.window;
  w.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  const sources = {
    'schedule-core.js': readFileSync(repoPath('schedule-core.js'), 'utf8'),
    'notices-core.js': readFileSync(repoPath('notices-core.js'), 'utf8'),
    'social-web.js': readFileSync(repoPath('social-web.js'), 'utf8'),
    'tour.js': readFileSync(repoPath('tour.js'), 'utf8'),
    // A stale deploy can pair fresh HTML with the account.js from before it,
    // so a test can substitute that older module.
    'account.js': options.accountSource || readFileSync(repoPath('account.js'), 'utf8'),
  };
  for (const [file, source] of Object.entries(sources)) {
    const s = w.document.createElement('script');
    s.textContent = source;
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

// The shared page marks the tour as already seen. Otherwise the first sign-in
// below would throw the tour overlay over the page, and its scrim would eat the
// clicks every later test depends on. The tour gets its own pages further down.
const page = mountPage({ storage: { settingsTourSeen: 1 } });
const { window, errors } = page;
const $ = page.$;
const settle = page.settle;

// The map's camera is written once per animation frame rather than once per
// pointer event, so anything that moves it has to let a frame pass before the
// transform can be read back.
const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

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
  assert.equal(window.document.body.classList.contains('is-booting'), false,
    'the loading state is over once the session has answered');
});

await test('the page never claims you are signed out before it has asked', async () => {
  // This is the markup a browser paints first, one round trip before /api/me
  // answers. It may not already say "not signed in", and it may not already
  // offer to sign out, or a signed-in visitor watches both be taken back.
  assert.match(html, /<body class="is-booting">/, 'the page starts in its loading state');
  assert.match(html, /id="topbar-auth" hidden>Sign out/, 'the sign-out button waits for the answer');
  assert.match(html, /<p class="dashboard__account-note" id="topbar-text"><\/p>/,
    'the sidebar account line is empty until it is known');
  assert.match(html, /<p id="social-web-status"[^>]*><\/p>/,
    'the map does not guess "sign in" at a signed-in visitor either');
  assert.doesNotMatch(html, /Sign in to explore the Social web/, 'that sentence is no longer markup');
  assert.match(html, /class="skeleton skeleton--line/, 'skeleton bars stand in for the account card');
  assert.match(html, /<span class="visually-hidden">Checking sign-in<\/span>/,
    'the loading state still says what it is doing, for a screen reader');
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
  assert.match($('signin-open').textContent, /Sign in with Hilltoppers/,
    'the green button names who handles the account');
  // The form lives in the popup, which is closed until the button is pressed.
  assert.ok($('signin-form'), 'the popup holds a sign-in form');
  assert.equal($('signin-dialog').hasAttribute('open'), false, 'the popup starts closed');
  assert.ok($('signin-email'), 'with an email field');
  assert.ok($('signin-password'), 'and a password field');
  assert.equal($('notices-panel').hidden, true);
  assert.equal($('danger-panel').hidden, true);
});

await test('the sign-in popup opens, and points at the extension for reset and sign-up', async () => {
  assert.equal($('signin-note').hidden, true, 'the extension note starts out of the way');

  $('signin-open').click();
  assert.equal($('signin-dialog').hasAttribute('open'), true, 'the button opens the popup');

  // Reset and account creation are Hilltoppers'. We do not send codes or mail.
  $('signin-forgot').click();
  assert.equal($('signin-note').hidden, false, 'forgot-password reveals the extension address');
  assert.match($('signin-note-url').textContent, /^chrome-extension:\/\/[a-z]+\/login\.html\?returnTo=class-settings\.html$/,
    'and it is the extension account screen, returning here');
  assert.match($('signin-note-text').textContent, /reset/i);

  $('signin-create').click();
  assert.match($('signin-note-text').textContent, /creates the account/i);

  // There is no code step left: we do not run verification or reset ourselves.
  assert.equal($('code-form'), null, 'the six-digit code step is gone');
  assert.equal($('verify-actions'), null, 'and so is the send-verification button');
});

await test('the class table renders all five blocks with working controls', async () => {
  const rows = $('block-rows').querySelectorAll('.class-settings__table-row');
  assert.equal(rows.length, 5, 'one row per A-E block');
  const first = rows[0];
  assert.ok(first.querySelector('input[type=text]'), 'a course name input');
  assert.ok(first.querySelector('input[type=checkbox]'), 'the alternating toggle');
});

await test('signing in reveals every account section', async () => {
  // Drive a real sign-in against the real Worker, the way the page does.
  await signInAs('sub-page-alice', 'alice@example.org', 'Alice');
  await window.HTAccount.refresh();
  await settle();

  assert.equal($('account-signed-in').hidden, false, 'the signed-in card shows');
  assert.equal($('account-signed-out').hidden, true);
  assert.equal($('topbar-auth').hidden, false, 'the sidebar now offers sign-out');
  assert.equal($('notices-panel').hidden, false);
  assert.equal($('danger-panel').hidden, false);
  assert.match($('profile-id').value, /^[a-z]+-[a-z]+-\d{4}$/, 'a profile ID is shown');
  assert.equal($('account-email').value, 'alice@example.org', 'the email is shown');
  assert.equal($('account-email').readOnly, true, 'but is not editable here: it belongs to Hilltoppers');
  assert.equal($('visibility').value, 'public', 'new accounts default to public');
  assert.equal($('auto-grant').checked, false, 'auto-grant defaults off');
});

await test('the sign-in form hands an ID token to the Worker and starts a session', async () => {
  // The page cannot really talk to Firebase in jsdom, so stand in for auth.js
  // at its boundary: the ID token. Everything after that is the page's own code
  // against the real Worker, which is where the bugs would be.
  const token = await idToken('sub-form-signin', 'form@example.org', 'Form');
  let asked = null;
  window.HTAuth.signIn = async (email, password) => {
    asked = { email, password };
    return { email };
  };
  window.HTAuth.idToken = async () => token;
  await window.HTAccount.signOut();
  await window.HTAccount.refresh();
  await settle();

  $('signin-email').value = 'form@example.org';
  $('signin-password').value = 'correct horse battery';
  $('signin-form').dispatchEvent(new window.Event('submit'));
  await settle();

  assert.deepEqual(asked, { email: 'form@example.org', password: 'correct horse battery' },
    'the password goes to Firebase, not to our Worker');
  // jsdom refuses to navigate, so the reload is recorded rather than performed.
  const me = await window.HTAccount.refresh();
  assert.ok(me, 'the session is live');
  assert.equal(me.email, 'form@example.org');

  await signInAs('sub-page-alice', 'alice@example.org', 'Alice');
  await window.HTAccount.refresh();
  await settle();
});

await test('auth.js exposes every method the page and account.js call', async () => {
  // auth.js is loaded by a <script> tag, which jsdom does not fetch, so nothing
  // else in the suite would notice if it stopped exporting something its
  // callers use - the page would just throw at the moment a student clicked.
  // Run it for real (its only import is inside load(), which is never reached
  // here) and compare its surface against the source of both callers.
  const w = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'dangerously',
  }).window;
  const s = w.document.createElement('script');
  s.textContent = readFileSync(repoPath('auth.js'), 'utf8');
  w.document.head.appendChild(s);

  assert.ok(w.HTAuth, 'auth.js defines window.HTAuth');
  const callers = html + readFileSync(repoPath('account.js'), 'utf8');
  const used = new Set(
    [...callers.matchAll(/window\.HTAuth\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  );
  assert.ok(used.size >= 3, 'the callers use the module in several places');
  for (const name of used) {
    assert.equal(typeof w.HTAuth[name], 'function', `auth.js exports ${name}()`);
  }

  // Nothing else is exported. A method no caller reaches is a liability: it is
  // untested, and one here would mean we were serving a reset or a verification
  // code ourselves, which is Hilltoppers' job. Their extension does both.
  for (const name of Object.keys(w.HTAuth)) {
    if (name === 'CONFIG') continue;
    assert.ok(used.has(name), `auth.js exports ${name}(), which nothing calls`);
  }
  for (const gone of ['requestCode', 'redeemCode', 'completeReset', 'completeVerification']) {
    assert.equal(w.HTAuth[gone], undefined, `auth.js no longer offers ${gone}(): we do not send mail`);
  }

  // The config must name the :web: appId. The project's iOS plist carries a
  // different :ios: one, and signing in with that fails against the web SDK.
  assert.equal(w.HTAuth.CONFIG.projectId, 'schedule-59d28');
  assert.match(w.HTAuth.CONFIG.appId, /:web:/, 'the web appId, not the iOS one');
});

await test('the visibility toggle writes through to the account', async () => {
  $('visibility').value = 'public';
  $('visibility').dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(await plainFieldOf('sub-page-alice', 'is_public'), 1);
});

await test('the auto-grant toggle writes through to the account, both ways', async () => {
  // The checkbox shows the account rather than the markup, and a new account
  // approves nothing on its own.
  assert.equal($('auto-grant').checked, false, 'a new account starts with it off');
  $('auto-grant').checked = true;
  $('auto-grant').dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(await plainFieldOf('sub-page-alice', 'auto_grant'), 1, 'on is saved');
  $('auto-grant').checked = false;
  $('auto-grant').dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(await plainFieldOf('sub-page-alice', 'auto_grant'), 0, 'off is saved');
});

await test('editing a course name saves locally and to the account', async () => {
  const input = $('block-rows').querySelector('input[type=text]');
  input.value = 'AP Biology';
  input.dispatchEvent(new window.Event('input'));
  await settle();
  const stored = JSON.parse((await accountOf('sub-page-alice')).block_prefs);
  const firstKey = Object.keys(stored)[0];
  assert.equal(stored[firstKey].name, 'AP Biology', 'the course reached D1');
  const local = JSON.parse(window.localStorage.getItem('blockPreferences') || '{}');
  assert.ok(Object.keys(local).length, 'and is still cached locally');
});

await test('course changes made in another browser load on sign-in', async () => {
  // The account's courses change underneath this browser, then the page is
  // loaded cold, as on a second device. It must adopt the account's version.
  const other = JSON.parse(JSON.stringify(JSON.parse(
    (await accountOf('sub-page-alice')).block_prefs
  )));
  const key = Object.keys(other)[0];
  other[key].name = 'From Another Device';
  await setEncryptedFieldOf('sub-page-alice', 'block_prefs', JSON.stringify(other));

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
  bob.profileId = (await accountOf('sub-page-bob')).profile_id;
});

await test('asking for a schedule either grants access or records a request', async () => {
  // Bob is public, but a new account asks first, so this lands as a pending
  // request rather than a grant. Both outcomes are valid product behaviour;
  // what matters is that the click reaches the server and one of them happens.
  const row = $('directory-results').querySelector('.class-settings__friend-row');
  row.querySelector('button').dispatchEvent(new window.Event('click'));
  await settle();
  const status = $('directory-status').textContent;
  assert.match(status, /Request sent|Access granted/, 'the click produced a real result');

  const aliceId = await accountIdOf('sub-page-alice');
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
  } else {
    // A request the student sent produces no notice for them, so Notices has
    // to carry it, with the unanswered state and a count on the tab.
    const waited = [...$('notice-list').querySelectorAll('.class-settings__notice')]
      .find((row) => /You asked Bob/.test(row.textContent));
    assert.ok(waited, 'the request the student sent shows up under Notices');
    assert.match(waited.textContent, /Pending/, 'and says it is still pending');
    assert.equal($('notices-pending-badge').hidden, false,
      'the Notices tab shows a pending count');
    assert.match($('notices-pending-badge').textContent, /^Pending \d+$/);
  }
});

await test('a request from someone else can be accepted in the UI', async () => {
  // Bob asks Alice. Alice has auto-grant off, so it lands as pending for her.
  const pageCookie = getCookieJar();
  const aliceProfileId = (await accountOf('sub-page-alice')).profile_id;
  await asOther(bob.cookie, () => window.HTAccount.askForSchedule(aliceProfileId));
  setCookieJar(pageCookie);
  await window.HTAccount.refresh();
  await settle();

  // Requests are answered from Notices now; open the row to reach its buttons.
  const noticeRow = [...$('notice-list').querySelectorAll('.class-settings__notice')]
    .find((row) => /asked for your schedule/i.test(row.textContent) && /Bob/.test(row.textContent));
  assert.ok(noticeRow, 'the request appears as a notice');
  assert.match(noticeRow.textContent, /Pending/,
    'an unanswered request is flagged on its notice');
  noticeRow.dispatchEvent(new window.Event('click'));
  await settle();
  const buttons = [...$('notice-list').querySelectorAll('.class-settings__notice-actions button')]
    .map((b) => b.textContent);
  const accept = [...$('notice-list').querySelectorAll('button')].find((b) => b.textContent === 'Accept');
  assert.ok(accept, 'an Accept button is offered');
  assert.equal(buttons.includes('Clear'), false,
    'a waiting request has no Clear: clearing it would orphan the ask');
  accept.dispatchEvent(new window.Event('click'));
  await settle();

  const grant = db.prepare(
    'SELECT revoked_at FROM grants WHERE owner_account_id = ?'
  ).get(await accountIdOf('sub-page-alice'));
  assert.ok(grant, 'accepting created a grant');
  assert.equal(grant.revoked_at, null);

  const answered = [...$('notice-list').querySelectorAll('.class-settings__notice')]
    .find((row) => /asked for your schedule/i.test(row.textContent) && /Bob/.test(row.textContent));
  assert.ok(answered, 'the notice stays after it is answered');
  assert.doesNotMatch(answered.textContent, /Pending/,
    'and stops saying pending once accepted');

  // The row was opened to accept, and stays open through the re-render.
  assert.equal(answered.getAttribute('aria-expanded'), 'true', 'the answered row stays open');
  assert.ok([...$('notice-list').querySelectorAll('.class-settings__notice-actions button')]
    .some((b) => b.textContent === 'Clear'), 'a decided ask can be cleared');
});

await test('a friend card says who can see whose schedule and can revoke', async () => {
  const bobRow = [...$('friend-rows').querySelectorAll('.class-settings__friend-row')]
    .find((row) => /Bob/.test(row.textContent) && /They can see yours/.test(row.textContent));
  assert.ok(bobRow, 'the viewer has a card that says he can see Alice\'s schedule');
  assert.ok(bobRow.querySelector('.class-settings__pill--share svg'),
    'the share icon marks the access Alice gives');
  bobRow.querySelector('.class-settings__overflow').click();
  await settle(2);
  const bobRowOpen = [...$('friend-rows').querySelectorAll('.class-settings__friend-row')]
    .find((row) => /Bob/.test(row.textContent) && /They can see yours/.test(row.textContent));
  const revoke = [...bobRowOpen.querySelectorAll('.class-settings__menu-item')]
    .find((item) => item.textContent === 'Revoke access');
  assert.ok(revoke, 'the row menu offers Revoke access');
  revoke.click();
  await settle();
  const grant = db.prepare(
    'SELECT revoked_at FROM grants WHERE owner_account_id = ?'
  ).get(await accountIdOf('sub-page-alice'));
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

await test('a notice names its sender and opens to reveal its actions', async () => {
  // The row should say who acted, not "Someone", and the whole row is the
  // control that opens it.
  const findRevoked = () => [...$('notice-list').querySelectorAll('.class-settings__notice')]
    .find((r) => /revoked your access/i.test(r.textContent));
  const row = findRevoked();
  assert.ok(row, 'the revocation notice renders as an openable row');
  assert.match(row.textContent, /Alice revoked your access/i, 'the sender is named');
  assert.equal(row.getAttribute('aria-expanded'), 'false', 'closed to start');

  row.dispatchEvent(new window.Event('click'));
  await settle(2);

  const open = findRevoked();
  assert.equal(open.getAttribute('aria-expanded'), 'true', 'clicking opens it');
  const buttons = [...$('notice-list').querySelectorAll('.class-settings__notice-actions button')]
    .map((b) => b.textContent);
  assert.ok(buttons.includes('Clear'), 'a Clear action is offered');
  assert.ok(buttons.includes('Ask for their schedule'), 'and a way to ask for their schedule');

  // Clicking again closes it, so the row is a toggle rather than a one-way door.
  open.dispatchEvent(new window.Event('click'));
  await settle(2);
  assert.equal(findRevoked().getAttribute('aria-expanded'), 'false', 'clicking an open notice closes it');
});

await test('a request notice offers Accept, and accepting grants access', async () => {
  // A private owner with auto-grant off produces a pending request, which the
  // notice should let them answer there rather than only under Friends.
  await signInAs('sub-page-owner-notice', 'owner.notice@example.org', 'Owner Notice');
  await window.HTAccount.updateProfile({ isPublic: false, autoGrant: false, displayName: 'Owner Notice' });
  await window.HTAccount.refresh();
  const ownerProfileId = (await accountOf('sub-page-owner-notice')).profile_id;

  const daveCookie = await signInAs('sub-page-dave-notice', 'dave.notice@example.org', 'Dave Notice');
  await asOther(daveCookie, async () => {
    await window.HTAccount.updateProfile({ displayName: 'Dave Notice' });
    const ask = await window.HTAccount.askForSchedule(ownerProfileId);
    assert.equal(ask.data.status, 'pending', 'the private owner is asked, not granted');
  });

  await signInAs('sub-page-owner-notice', 'owner.notice@example.org', 'Owner Notice');
  await window.HTAccount.refresh();
  await settle();

  const rows = [...$('notice-list').querySelectorAll('.class-settings__notice')];
  const requestRow = rows.find((r) => /asked for your schedule/i.test(r.textContent));
  assert.ok(requestRow, 'the request notice is listed: ' + rows.map((r) => r.textContent).join(' || '));
  assert.match(requestRow.textContent, /Dave Notice/, 'and names who asked');

  requestRow.dispatchEvent(new window.Event('click'));
  await settle(2);
  const accept = [...$('notice-list').querySelectorAll('.class-settings__notice-actions button')]
    .find((b) => b.textContent === 'Accept');
  assert.ok(accept, 'the open notice offers Accept');
  accept.dispatchEvent(new window.Event('click'));
  await settle();

  assert.ok(db.prepare(
    'SELECT 1 FROM grants WHERE viewer_account_id = ? AND revoked_at IS NULL'
  ).get(await accountIdOf('sub-page-dave-notice')), 'accepting from the notice created a live grant');

  // The row reports the request, so once it is answered it stops saying
  // Pending and says what the answer was.
  const answered = [...$('notice-list').querySelectorAll('.class-settings__notice')]
    .find((r) => /asked for your schedule/i.test(r.textContent));
  assert.ok(answered, 'the answered notice is still listed');
  assert.match(answered.textContent, /Granted/, 'and now says Granted');
  assert.doesNotMatch(answered.textContent, /Pending/, 'the pending pill is gone');
});

await test('a pending request stays answerable after its notice is cleared', async () => {
  // The notice used to be the request's only row. Clearing it left the request
  // pending with no Accept or Decline anywhere, which is the orphan this test
  // rules out: the request itself still produces a row.
  await signInAs('sub-page-sue-notice', 'sue.notice@example.org', 'Sue Notice');
  await window.HTAccount.updateProfile({ isPublic: false, autoGrant: false, displayName: 'Sue Notice' });
  await window.HTAccount.refresh();
  const ownerProfileId = (await accountOf('sub-page-sue-notice')).profile_id;

  const timCookie = await signInAs('sub-page-tim-notice', 'tim.notice@example.org', 'Tim Notice');
  await asOther(timCookie, async () => {
    await window.HTAccount.updateProfile({ displayName: 'Tim Notice' });
    await window.HTAccount.askForSchedule(ownerProfileId);
  });

  // Exactly what Clear would have done to the notice, leaving the ask behind.
  db.prepare('DELETE FROM notices WHERE account_id = ? AND kind = ?')
    .run(await accountIdOf('sub-page-sue-notice'), 'request.received');

  await signInAs('sub-page-sue-notice', 'sue.notice@example.org', 'Sue Notice');
  await window.HTAccount.refresh();
  await settle();

  const row = [...$('notice-list').querySelectorAll('.class-settings__notice')]
    .find((r) => /asked for your schedule/i.test(r.textContent) && /Tim Notice/.test(r.textContent));
  assert.ok(row, 'the request still has a row without its notice');
  assert.match(row.textContent, /Pending/, 'and still reports that it is waiting');
  row.dispatchEvent(new window.Event('click'));
  await settle(2);
  const actions = [...$('notice-list').querySelectorAll('.class-settings__notice-actions button')]
    .map((b) => b.textContent);
  assert.ok(actions.includes('Accept'), 'the request offers Accept');
  assert.ok(actions.includes('Decline'), 'and Decline');
  assert.equal(actions.includes('Clear'), false, 'but not Clear, which would orphan it again');
});

await test('clearing a notice removes just that row', async () => {
  await signInAs('sub-page-bob', 'bob@example.org', 'Bob');
  await window.HTAccount.refresh();
  await settle();
  const before = $('notice-list').querySelectorAll('.class-settings__notice').length;
  assert.ok(before >= 1, 'there is a notice to clear');

  const row = $('notice-list').querySelector('.class-settings__notice');
  row.dispatchEvent(new window.Event('click'));
  await settle(2);
  const clear = [...$('notice-list').querySelectorAll('.class-settings__notice-actions button')]
    .find((b) => b.textContent === 'Clear');
  assert.ok(clear, 'the open notice offers Clear');
  clear.dispatchEvent(new window.Event('click'));
  await settle();

  const after = $('notice-list').querySelectorAll('.class-settings__notice').length;
  assert.equal(after, before - 1, 'only the cleared notice is gone');
});

await test('a sent request can be stopped from the Notices tab', async () => {
  // The sender's row only had a Pending pill and no way out. Open it and stop
  // asking: the request is withdrawn, so it is no longer pending for either
  // side and the row leaves the list.
  await signInAs('sub-page-stop-owner', 'stop.owner@example.org', 'Stop Owner');
  await window.HTAccount.updateProfile({ isPublic: false, autoGrant: false, displayName: 'Stop Owner' });
  await window.HTAccount.refresh();
  const owner = await accountOf('sub-page-stop-owner');

  await signInAs('sub-page-stop-asker', 'stop.asker@example.org', 'Stop Asker');
  await window.HTAccount.askForSchedule(owner.profile_id);
  await window.HTAccount.refresh();
  await settle();

  let row = [...$('notice-list').querySelectorAll('.class-settings__notice')]
    .find((entry) => /You asked Stop Owner/.test(entry.textContent));
  assert.ok(row, 'the sent ask is listed');
  assert.match(row.textContent, /Pending/, 'and says it is waiting');

  row.dispatchEvent(new window.Event('click'));
  await settle(2);
  row = [...$('notice-list').querySelectorAll('.class-settings__notice')]
    .find((entry) => /You asked Stop Owner/.test(entry.textContent));
  assert.equal(row.getAttribute('aria-expanded'), 'true', 'the request row opens');
  const stop = [...$('notice-list').querySelectorAll('.class-settings__notice-actions button')]
    .find((button) => button.textContent === 'Stop asking');
  assert.ok(stop, 'Stop asking is offered below the request');
  stop.dispatchEvent(new window.Event('click'));
  await settle();

  row = [...$('notice-list').querySelectorAll('.class-settings__notice')]
    .find((entry) => /You asked Stop Owner/.test(entry.textContent));
  assert.equal(row, undefined, 'the withdrawn request leaves the list');
  assert.equal($('notices-pending-badge').hidden, true, 'nothing still claims to be pending');
  const asker = await accountOf('sub-page-stop-asker');
  const stored = db.prepare(
    'SELECT status FROM requests WHERE from_account_id = ? AND to_account_id = ?'
  ).get(asker.id, owner.id);
  assert.equal(stored.status, 'cancelled', 'the request is withdrawn, not declined by the owner');
});

await test('a stale cached account.js does not leave Clear a silent no-op', async () => {
  // GitHub Pages caches account.js for ten minutes under an unversioned name,
  // and PR #32 added dismissNotice to it without bumping the ?v= query, so a
  // freshly deployed settings.html briefly ran against the older module. The
  // Clear handler called the missing export, threw, and the notice stayed put.
  // Bumping the query is the real fix; the button should not fail silently if
  // the mismatch happens again.
  const staleAccount = readFileSync(repoPath('account.js'), 'utf8')
    .replace(/    dismissNotice: dismissNotice,\n/, '');

  await signInAs('sub-stale-owner-page', 'stale.owner@example.org', 'Stale Owner');
  await window.HTAccount.refresh();
  await settle();
  await window.HTAccount.updateProfile({ isPublic: false, autoGrant: false, displayName: 'Stale Owner' });
  await window.HTAccount.refresh();
  const ownerProfileId = (await accountOf('sub-stale-owner-page')).profile_id;

  const daveCookie = await signInAs('sub-stale-dave-page', 'stale.dave@example.org', 'Stale Dave');
  await asOther(daveCookie, async () => {
    await window.HTAccount.updateProfile({ displayName: 'Stale Dave' });
    await window.HTAccount.askForSchedule(ownerProfileId);
  });

  // Answer the ask first. A waiting request no longer offers Clear (that is
  // what would orphan it), so this test needs a decided notice to exercise the
  // stale account.js Clear path it is about.
  await signInAs('sub-stale-owner-page', 'stale.owner@example.org', 'Stale Owner');
  await window.HTAccount.refresh();
  const incoming = await window.HTAccount.listRequests();
  const pending = incoming.data.incoming.find((request) => request.status === 'pending');
  await window.HTAccount.decideRequest(pending.id, 'accept');

  const stale = mountPage({ accountSource: staleAccount });
  await signInAs('sub-stale-owner-page', 'stale.owner@example.org', 'Stale Owner');
  await stale.window.HTAccount.refresh();
  await stale.settle();

  const staleRow = stale.$('notice-list').querySelector('.class-settings__notice');
  assert.ok(staleRow, 'the owner has a notice to clear');
  staleRow.dispatchEvent(new stale.window.Event('click'));
  await stale.settle(2);
  const staleClear = [...stale.$('notice-list').querySelectorAll('.class-settings__notice-actions button')]
    .find((b) => b.textContent === 'Clear');
  assert.ok(staleClear, 'the open notice offers Clear');
  staleClear.dispatchEvent(new stale.window.Event('click'));
  await stale.settle(2);

  assert.equal(stale.errors.length, 0, 'no uncaught error escapes: ' + stale.errors.join(' | '));
});

await test('the account page is built from cards, like every other tab', async () => {
  // Account used to be one oversized card with subsections separated by rules,
  // while Friends and Notices were lists of cards. Every tab now uses the same
  // card: one .class-settings__panel per topic.
  const accountPanel = $('panel-account');
  const cards = [...accountPanel.querySelectorAll('.class-settings__panel')];
  assert.ok(cards.length >= 3, 'Account is several cards, not one long scroll');

  // The blocks that used to be subsections are now their own cards.
  for (const id of ['schedule-panel', 'classes-panel', 'danger-panel']) {
    assert.ok($(id).classList.contains('class-settings__panel'), `${id} is its own card`);
  }

  // The page-wide notification banner is gone; the sign-in outcome now reports
  // inline on the Account card.
  assert.equal($('auth-notice'), null, 'the notification card was removed');
  assert.ok($('auth-status'), 'and the account card carries its own status line');
});

await test('account labels sit above their fields, not beside them', async () => {
  // The identity fields were laid out in two columns (label | control), which
  // read as one row of boxes. They are now a single stacked column.
  const stacked = $('account-signed-in').querySelector('.class-settings__fields--stacked');
  assert.ok(stacked, 'the identity fields use the stacked layout');
  const labels = [...stacked.querySelectorAll('label')].map((l) => l.textContent.trim());
  assert.deepEqual(labels, ['Display name', 'Your profile ID', 'Visibility']);
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

await test('signing in does not reveal a tab that is not selected', async () => {
  // The tabpanels are siblings in the content column, and the wrapper has no
  // gap of its own -- the space between cards comes from the panel grid. A
  // second visible wrapper therefore renders its card flush against the first,
  // at 0px instead of the 20px every other pair of cards uses.
  //
  // renderAccount used to unhide the Notices tabpanel itself on sign-in, so a
  // signed-in refresh left Notices stacked under whichever tab was open. Only
  // showTab may decide which panel is visible.
  const click = (name) => $(`tab-${name}-btn`).dispatchEvent(new window.Event('click'));

  click('account');
  await settle(2);
  // A refresh re-emits the account, re-running renderAccount.
  await window.HTAccount.refresh();
  await settle(2);

  const visible = ['account', 'friends', 'notices', 'social-web']
    .filter((name) => !$(`panel-${name}`).hidden);
  assert.deepEqual(visible, ['account'], 'only the selected tab is showing');
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
  const carol = await accountOf('sub-page-carol');

  const daveCookie = await signInAs('sub-page-dave', 'dave@example.org', 'Dave');
  const dave = await accountOf('sub-page-dave');
  await asOther(daveCookie, () => window.HTAccount.askForSchedule(carol.profile_id));

  // Carol accepts, in her own session.
  setCookieJar(carolCookie);
  await window.HTAccount.refresh();
  await settle();
  const noticeRow = [...$('notice-list').querySelectorAll('.class-settings__notice')]
    .find((row) => /asked for your schedule/i.test(row.textContent) && /Dave/.test(row.textContent));
  assert.ok(noticeRow, 'Carol sees the request as a notice');
  noticeRow.dispatchEvent(new window.Event('click'));
  await settle();
  const accept = [...$('notice-list').querySelectorAll('button')].find((b) => b.textContent === 'Accept');
  assert.ok(accept, 'Carol sees an Accept button');
  accept.dispatchEvent(new window.Event('click'));
  await settle();

  assert.ok(db.prepare(
    'SELECT 1 FROM grants WHERE viewer_account_id = ? AND owner_account_id = ? AND revoked_at IS NULL'
  ).get(dave.id, carol.id), 'a live grant exists for Dave');

  // Dave signs in and should find Carol already on his card.
  await signInAs('sub-page-dave', 'dave@example.org', 'Dave');
  await window.HTAccount.refresh();
  await settle();
  const friends = JSON.parse(window.localStorage.getItem('friends') || '[]');
  assert.ok(friends.some((f) => f.email === carol.profile_id), 'Carol is on Dave\'s card automatically');
});

await test('marking notices read clears the new badge', async () => {
  $('notices-seen').dispatchEvent(new window.Event('click'));
  await settle();
  // Only the read marker goes. A pill saying Pending or Granted is the state of
  // the request, not whether the row has been read, so it stays.
  const badges = [...$('notice-list').querySelectorAll('.class-settings__badge')];
  assert.equal(badges.filter((badge) => badge.textContent === 'New').length, 0,
    'no row still says New');
  assert.equal($('notices-tab-badge').hidden, true, 'the Notices tab marker clears too');
});

await test('the sidebar sign-out returns the page to the signed-out state and takes local data with it', async () => {
  // Dave's card was filled from Carol's grant. None of it may stay behind in a
  // shared browser for the next student, who would inherit courses they never
  // chose.
  const before = JSON.parse(window.localStorage.getItem('friends') || '[]');
  assert.ok(before.length > 0, 'the account has local card data to clear');

  $('topbar-auth').dispatchEvent(new window.Event('click'));
  await settle();
  assert.equal($('account-signed-out').hidden, false);
  assert.equal($('account-signed-in').hidden, true);
  assert.equal(window.HTAccount.isSignedIn(), false);
  assert.equal($('notices-seen').hidden, true, 'with no notices there is nothing to mark read');

  assert.deepEqual(JSON.parse(window.localStorage.getItem('friends')), [],
    'the previous account\'s card is gone');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('identity')), { name: '', email: '' },
    'and so is the remembered identity');
  assert.equal(window.localStorage.getItem('selectedFriend'), '',
    'no friend selection survives the sign-out');
  const prefs = JSON.parse(window.localStorage.getItem('blockPreferences'));
  assert.deepEqual(Object.keys(prefs).map((block) => prefs[block].name), ['', '', '', '', ''],
    'the previous account\'s courses are gone');
});

await test('a new account does not inherit another account\'s local courses', async () => {
  // FN-16: with no account-owned courses yet, the page used to upload whatever
  // was in localStorage. On a shared browser that was the previous student's
  // timetable. The owner key makes the local copy account-scoped instead.
  const previous = await accountOf('sub-page-alice');
  const t = mountPage({ storage: { settingsTourSeen: 1 } });
  const stolen = t.window.HT.createEmptyPreferences();
  stolen.A.name = 'Inherited Course';
  t.window.localStorage.setItem('blockPreferences', JSON.stringify(stolen));
  t.window.localStorage.setItem('localAccountProfileId', previous.profile_id);

  await signInAs('sub-page-new-student', 'new.student@example.org', 'New Student');
  await t.window.HTAccount.refresh();
  await t.settle();

  const newStudent = await accountOf('sub-page-new-student');
  assert.equal(String(newStudent.block_prefs || '').includes('Inherited Course'), false,
    'the previous account\'s course was not copied into the new account');
  assert.equal(t.window.localStorage.getItem('localAccountProfileId'), newStudent.profile_id,
    'the local copy now belongs to the new account');
  const local = JSON.parse(t.window.localStorage.getItem('blockPreferences'));
  assert.equal(local.A.name, '', 'and the inherited local course is gone');
  t.dom.window.close();
});

await test('a friend added from the directory carries real course data for the card', async () => {
  // Erin sets a course and a lunch, then is granted to Frank. The friend entry
  // Frank gets must include the courses, or the card would render an empty
  // schedule even though the grant is valid.
  const erinCookie = await signInAs('sub-page-erin', 'erin@example.org', 'Erin');
  const erin = await accountOf('sub-page-erin');
  await window.HTAccount.updateProfile({
    isPublic: true,
    autoGrant: true,
    lunchWave: 1,
    grade: 11,
    blockPrefs: { A: { name: 'Chemistry', alternating: false }, B: { name: 'English', alternating: false } },
    schedulePrefs: { timeFormat: '24h', lunchPeriod: 1 },
  });

  const frankCookie = await signInAs('sub-page-frank', 'frank@example.org', 'Frank');
  setCookieJar(frankCookie);
  await window.HTAccount.refresh();
  await settle();

  $('directory-search').value = erin.profile_id;
  $('directory-go').dispatchEvent(new window.Event('click'));
  await settle();
  const row = $('directory-results').querySelector('.class-settings__friend-row');
  assert.ok(row, 'Erin is found in the directory');
  row.querySelector('button').dispatchEvent(new window.Event('click'));
  await settle();

  const friends = JSON.parse(window.localStorage.getItem('friends') || '[]');
  const erinEntry = friends.find((f) => f.email === erin.profile_id);
  assert.ok(erin, 'Erin is on Frank\'s card');
  assert.equal(erinEntry.blockPrefs.A.name, 'Chemistry', 'her course reached the card entry');
  assert.equal(erinEntry.lunchWave, 1, 'her lunch wave reached the card entry');
  assert.equal(erinEntry.grade, 11, 'her grade reached the card entry');
});

await test('a friend card shows the access it holds and keeps it across reloads', async () => {
  const erinProfileId = (await accountOf('sub-page-erin')).profile_id;
  const erinRow = (p) => [...p.$('friend-rows').querySelectorAll('.class-settings__friend-row')]
    .find((row) => row.textContent.includes(erinProfileId));
  const assertAccess = (p) => {
    const row = erinRow(p);
    assert.ok(row, 'Erin has a friend card');
    assert.match(row.textContent, /You can see theirs/, 'the card says her schedule is available');
    assert.ok(row.querySelector('.class-settings__pill--see svg'),
      'the eye icon marks the access Frank holds');
    assert.doesNotMatch(row.textContent, /No access/, 'and not the empty state');
  };

  await window.HTAccount.refresh();
  await settle();
  assertAccess(page);

  const friends = JSON.parse(window.localStorage.getItem('friends'));
  const reloaded = mountPage({ storage: { friends } });
  try {
    await reloaded.settle();
    assertAccess(reloaded);
    assert.deepEqual(reloaded.errors, [], 'reload has no runtime errors');
  } finally {
    reloaded.dom.window.close();
  }

  const fresh = mountPage();
  try {
    await fresh.settle();
    assertAccess(fresh);
    assert.ok(JSON.parse(fresh.window.localStorage.getItem('friends'))
      .some((friend) => friend.email === erinProfileId), 'granted people are still adopted onto the card');
    assert.deepEqual(fresh.errors, [], 'cold load has no runtime errors');
  } finally {
    fresh.dom.window.close();
  }
});

await test('a card can be quietly removed without changing access, and access can be given up', async () => {
  // The quiet menu is a card action, not a revocation: removing Erin must
  // delete the cached courses but leave the access row (and its access) alone.
  const erinProfileId = (await accountOf('sub-page-erin')).profile_id;
  const rowFor = () => [...$('friend-rows').querySelectorAll('.class-settings__friend-row')]
    .find((row) => row.textContent.includes(erinProfileId));

  let row = rowFor();
  assert.ok(row, 'Erin is on Frank\'s card');
  row.querySelector('.class-settings__overflow').click();
  await settle(2);
  row = rowFor();
  const remove = [...row.querySelectorAll('.class-settings__menu-item')]
    .find((item) => item.textContent === 'Remove from card');
  assert.ok(remove, 'the card offers a quiet Remove from card');
  remove.click();
  await settle();

  const friends = JSON.parse(window.localStorage.getItem('friends') || '[]');
  assert.equal(friends.some((friend) => friend.email === erinProfileId), false,
    'the card entry and its cached courses are gone');
  assert.match($('friends-status').textContent, /removed from your card/i,
    'the result is stated where the action happened');

  // Access is separate and still manageable: the row remains, and it can be
  // added back to the card or given up from here.
  row = rowFor();
  assert.ok(row, 'the access row stays after the card entry is removed');
  row.querySelector('.class-settings__overflow').click();
  await settle(2);
  row = rowFor();
  assert.ok([...row.querySelectorAll('.class-settings__menu-item')]
    .some((item) => item.textContent === 'Add to card'), 'the card entry can be restored');

  const stop = [...row.querySelectorAll('.class-settings__menu-item')]
    .find((item) => item.textContent === 'Stop seeing');
  assert.ok(stop, 'the viewer has their own way to give up access');
  stop.click();
  await settle();

  const grant = db.prepare(
    'SELECT revoked_at FROM grants WHERE owner_account_id = ? AND viewer_account_id = ?'
  ).get(await accountIdOf('sub-page-erin'), await accountIdOf('sub-page-frank'));
  assert.ok(grant && grant.revoked_at, 'the grant is revoked from the viewer\'s side');
  assert.equal(rowFor(), undefined, 'and the access row is gone');
  assert.match($('friends-status').textContent, /no longer see/i,
    'the page says the access ended');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('removedFriends')), [],
    'a tombstone is forgotten once the access it guarded is gone');

  // Later tests use this share as one half of a mutual connection. This test
  // ended it on purpose, so put the same share back for them. The schema keeps
  // one grant per pair, so it is the revoked row that is restored.
  db.prepare('UPDATE grants SET revoked_at = NULL WHERE owner_account_id = ? AND viewer_account_id = ?')
    .run(await accountIdOf('sub-page-erin'), await accountIdOf('sub-page-frank'));
});

await test('a private profile in the Social web shows neither name nor ID', async () => {
  // A profile ID is a bearer handle, so printing one beside "Anonymous" hands
  // over exactly what the student was hiding: anyone could go request their
  // schedule with it.
  await signInAsShared('sub-page-anon', 'anon@example.org', 'Secret Person');
  await window.HTAccount.updateProfile({ isPublic: false });
  const anonProfile = (await window.HTAccount.refresh()).profileId;

  // Read the graph back as somebody else.
  const viewerCookie = await signInAsShared('sub-page-viewer', 'viewer@example.org', 'Viewer');
  await window.HTAccount.refresh();
  $('tab-social-web-btn').click();
  await settle();

  const data = await window.HTAccount.getSocialWeb();
  assert.equal(data.ok, true, 'the graph loaded');
  const node = data.data.nodes.find((n) => n.profileId === anonProfile);
  assert.ok(node, 'the private profile is still in the graph');
  assert.equal(node.displayName, 'Anonymous', 'and shown as Anonymous');

  const group = $('social-web-scene').querySelector('[data-profile-id="' + anonProfile + '"]');
  assert.ok(group, 'their circle is drawn');
  assert.equal(group.getAttribute('aria-label').includes(anonProfile), false,
    'the accessible name must not carry the ID');
  assert.equal(group.querySelector('title').textContent.includes(anonProfile), false,
    'nor may the hover tooltip');

  group.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  const shown = $('social-web-details').textContent;
  assert.equal(shown.includes(anonProfile), false,
    'clicking an Anonymous profile must not reveal their ID: ' + shown);
  assert.match(shown, /Anonymous/, 'it says Anonymous instead');

  // A public profile still shows its ID, because that is what the student
  // chose to publish.
  await signInAsShared('sub-page-open', 'open@example.org', 'Open Person');
  await window.HTAccount.refresh();
  const openProfile = (await window.HTAccount.refresh()).profileId;
  await signInAsShared('sub-page-viewer', 'viewer@example.org', 'Viewer');
  await window.HTAccount.refresh();
  $('social-web-refresh').click();
  await settle();

  const openGroup = $('social-web-scene').querySelector('[data-profile-id="' + openProfile + '"]');
  assert.ok(openGroup, 'the public profile is drawn');
  // An ID fetches that person's schedule, so being public is no longer enough
  // to print it: only an actual share is.
  assert.equal(openGroup.getAttribute('aria-label').includes(openProfile), false,
    'a profile that has not shared with you does not publish its ID');

  db.prepare(`INSERT INTO grants (code_hash, owner_account_id, viewer_account_id, created_at)
    VALUES (?, ?, ?, ?)`).run('id-visibility', await accountIdOf('sub-page-open'),
    await accountIdOf('sub-page-viewer'), Math.floor(Date.now() / 1000));
  $('social-web-refresh').click();
  await settle();
  const sharing = $('social-web-scene').querySelector('[data-profile-id="' + openProfile + '"]');
  assert.ok(sharing.getAttribute('aria-label').includes(openProfile),
    'someone who shares with you does publish their ID');
});

await test('the Social web includes everyone by default and supports selection, pan and zoom', async () => {
  const erinCookie = await signInAsShared('sub-page-erin', 'erin@example.org', 'Erin');
  void erinCookie;
  // Restore Frank, as the helper above signed the shared jar into Erin.
  await signInAsShared('sub-page-frank', 'frank@example.org', 'Frank');
  await window.HTAccount.refresh();
  // Frank shares with Erin as well, so the pair is mutual. That has to be one
  // line with an arrowhead at each end, not two curves on top of each other.
  // (The requests endpoint short-circuits when the other person already shares
  // with you, so the reverse grant is written directly.)
  db.prepare(`INSERT INTO grants (code_hash, owner_account_id, viewer_account_id, created_at)
    VALUES (?, ?, ?, ?)`).run('mutual-test', await accountIdOf('sub-page-frank'),
    await accountIdOf('sub-page-erin'), Math.floor(Date.now() / 1000));
  $('tab-social-web-btn').click();
  await settle();
  assert.equal($('panel-social-web').hidden, false);
  assert.equal($('panel-account').hidden, true);
  assert.equal($('page-title').textContent, 'Social web');
  assert.match($('page-header').className, /is-hidden/,
    'the page title and its divider are given up to the full-tab map');
  assert.equal($('panel-social-web').querySelector('h2'), null, 'the map carries no heading of its own');
  assert.equal($('social-web-workspace').hidden, false);
  assert.ok($('social-web-scene').querySelectorAll('.social-web__node').length >= 2,
    'everyone with an account is in the web, no opt-in');
  const reciprocal = [...$('social-web-scene').querySelectorAll('.social-web__edge')]
    .filter((e) => /Erin/.test(e.textContent) && /Frank/.test(e.textContent));
  assert.equal(reciprocal.length, 1, 'a reciprocal pair is drawn once, not twice');
  assert.equal(reciprocal[0].getAttribute('marker-end'), 'url(#social-web-arrow)');
  assert.equal(reciprocal[0].getAttribute('marker-start'), 'url(#social-web-arrow)',
    'the far end of a mutual connection has an arrowhead too');
  assert.match(reciprocal[0].getAttribute('class'), /is-mutual/);
  assert.match(reciprocal[0].textContent, /share their schedules with each other/,
    'the hover text says the connection runs both ways');
  const me = $('social-web-scene').querySelector('.is-you');
  assert.ok(me, 'the signed-in account is in the graph');
  me.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(me.getAttribute('aria-pressed'), 'true');
  assert.equal($('social-web-details').hidden, false, 'selecting a person brings the info pill up');
  assert.match($('social-web-details').textContent, /Can see\s+Erin/,
    'the list of who they can see follows its heading, with no colon');
  const pills = [...$('social-web-details').querySelectorAll('.social-web__pill')]
    .map((pill) => pill.textContent);
  assert.deepEqual(pills, ['Shares with', 'Can see'], 'each list is headed by its own pill');
  const blocks = [...$('social-web-details').querySelectorAll('.social-web__details-block')];
  assert.equal(blocks.length, 2, 'the pill has two sections');
  assert.match(blocks[0].querySelector('.social-web__pill').textContent, /^Shares with$/,
    'the Shares with pill heads the section it belongs to');
  const people = [...blocks[0].querySelectorAll('.social-web__person')].map((chip) => chip.textContent);
  assert.ok(people.includes('Erin'), 'the people are pills inside the section they belong to');
  assert.equal(blocks[0].textContent.includes(':'), false, 'no colon is left in the text');
  me.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal($('social-web-details').hidden, true, 'deselecting takes the pill away again');
  // The card keeps its grip and the markup around it, so compare the text.
  assert.equal($('social-web-details').textContent.trim(), '', 'and it leaves nothing behind');

  // Everyone in those lists is a pill you can click through, so the web can be
  // walked from the card instead of hunting for a circle on the map.
  me.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const erinChip = [...$('social-web-details').querySelectorAll('.social-web__person')]
    .find((chip) => chip.textContent === 'Erin');
  assert.ok(erinChip, 'a person in the list is a pill');
  erinChip.click();
  assert.match($('social-web-details').querySelector('strong').textContent, /Erin/,
    'clicking one opens their card');
  const picked = $('social-web-scene').querySelector('.social-web__node.is-selected');
  assert.ok(picked.getAttribute('aria-label').includes('Erin'), 'and selects them on the map');
  const original = $('social-web-scene').getAttribute('transform');
  $('social-web-zoom-in').click();
  await nextFrame();
  assert.notEqual($('social-web-scene').getAttribute('transform'), original);
  $('social-web-fit').click();
  await nextFrame();
  assert.equal($('social-web-scene').getAttribute('transform'), original);
  $('social-web-canvas').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await nextFrame();
  assert.notEqual($('social-web-scene').getAttribute('transform'), original, 'keyboard pans');
  $('social-web-fit').click();
  await nextFrame();
  const pointer = (type, x, y, id = 1) => {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    $('social-web-canvas').dispatchEvent(event);
  };
  pointer('pointerdown', 0, 0); pointer('pointermove', 70, 30); pointer('pointerup', 70, 30);
  await nextFrame();
  assert.notEqual($('social-web-scene').getAttribute('transform'), original, 'drag pans');
  $('social-web-fit').click();
  await nextFrame();
  pointer('pointerdown', 100, 100, 1); pointer('pointerdown', 200, 100, 2);
  pointer('pointermove', 300, 100, 2);
  await nextFrame();
  assert.notEqual($('social-web-zoom').textContent, '100%', 'pinch zooms');
  pointer('pointerup', 100, 100, 1); pointer('pointerup', 300, 100, 2);
  const reloaded = mountPage();
  try {
    await reloaded.settle();
    assert.equal(reloaded.errors.length, 0);
  } finally { reloaded.dom.window.close(); }
  $('tab-account-btn').click();
  await settle(2);
  assert.equal($('panel-account').hidden, false, 'the Account tab still works');
  assert.doesNotMatch($('page-header').className, /is-hidden/, 'other tabs keep their page title');
});

await test('the friends search is a card at the top of the page', async () => {
  $('tab-friends-btn').click();
  await settle(2);
  const panel = $('panel-friends').querySelector('.class-settings__panel');
  assert.equal(panel.firstElementChild.id, 'friends-search-card',
    'the search sits above the list it searches');
  assert.equal(panel.querySelector('h3'), null, 'the "Add a friend" heading it replaced is gone');
  assert.ok(panel.querySelector('#directory-results'), 'the results list came with it');

  const toggle = $('friends-search-toggle');
  assert.equal(toggle.textContent.trim(), 'Find friends', 'the closed card offers to find friends');
  // Start from the closed state so the toggle is what opens it.
  if ($('friends-search-card').classList.contains('is-open')) toggle.click();
  assert.equal($('friends-search-panel').hidden, true);
  toggle.click();
  assert.equal($('friends-search-panel').hidden, false, 'clicking opens the card');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  $('directory-search').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('friends-search-panel').hidden, true, 'Escape puts it away');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

await test('the Social web finds a person through its own search card', async () => {
  // The toolbar used to carry a <select> that listed everyone and named the
  // current pick. It is a search now: a pill that says only "Search" and opens
  // a card with the same people under a field.
  $('tab-social-web-btn').click();
  await settle(2);
  assert.equal($('social-web-person'), null, 'the select is gone');
  const toggle = $('social-web-find-toggle');
  assert.equal(toggle.textContent.trim(), 'Search', 'the pill does not name the pick');
  assert.equal($('social-web-find-panel').hidden, true);

  toggle.click();
  assert.equal($('social-web-find-panel').hidden, false, 'the pill opens the card');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const rows = () => [...$('social-web-people-list').querySelectorAll('.search-card__option')];
  assert.ok(rows().length >= 2, 'the card lists everyone in the web');
  assert.equal(rows().some((row) => /everyone/i.test(row.textContent)), false, 'without an "Everyone" row');

  const input = $('social-web-find-input');
  const type = (value) => {
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  type('eri');
  assert.deepEqual(rows().filter((row) => !row.hidden).map((row) => row.textContent),
    ['Erin'], 'typing narrows the list to the match');
  type('nobody');
  assert.equal(rows().every((row) => row.hidden), true);
  assert.equal($('social-web-find-empty').hidden, false, 'and says so when nobody matches');
  type('erin');
  assert.equal($('social-web-find-empty').hidden, true);
  // Picking a row toggles, so pick someone who is not already selected.
  type('');
  const pick = rows().find((row) => row.getAttribute('aria-selected') !== 'true');
  assert.ok(pick, 'someone is left to pick');
  const who = pick.textContent.replace(/\s*\(you\)$/, '');
  pick.click();
  assert.equal($('social-web-find-panel').hidden, true, 'picking a person closes the card');
  assert.match($('social-web-details').querySelector('strong').textContent, new RegExp(who),
    'and opens their card on the map');
});

await test('picking a name from the search fits that person\'s group', async () => {
  const transform = () => $('social-web-scene').getAttribute('transform');
  $('social-web-fit').click();
  await nextFrame();
  await nextFrame();
  const wholeWeb = transform();

  $('social-web-find-toggle').click();
  const pick = [...$('social-web-people-list').querySelectorAll('.search-card__option')]
    .find((row) => row.getAttribute('aria-selected') !== 'true');
  assert.ok(pick, 'someone is left to pick');
  const picked = pick.getAttribute('data-profile-id');
  pick.click();
  // The camera glides to the group rather than jumping, so give the tween time.
  await new Promise((resolve) => setTimeout(resolve, 420));
  await nextFrame();
  const fitted = transform();
  assert.notEqual(fitted, wholeWeb, 'the view moves to the group it was asked for');

  // Where that person ends up on the map: the node's own place in the scene,
  // through the camera. The whole point is that they are on screen afterwards.
  const [ , tx, ty, scale ] = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(fitted) || [];
  const node = $('social-web-scene').querySelector('.social-web__node[data-profile-id="' + picked + '"]');
  const [ , nx, ny ] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(node.getAttribute('transform')) || [];
  const screenX = Number(nx) * Number(scale) + Number(tx);
  const screenY = Number(ny) * Number(scale) + Number(ty);
  assert.ok(screenX > 0 && screenX < 1000, 'the person fit into the view across');
  assert.ok(screenY > 0 && screenY < 640, 'and down');
});

await test('the info card is dragged by its grip and stays where it is put', async () => {
  const details = $('social-web-details');
  const grip = details.querySelector('.social-web__grip');
  assert.ok(grip, 'the card carries a grip');
  assert.equal(grip.querySelectorAll('circle').length, 6, 'with six dots');
  assert.ok($('social-web-details-body'), 'and its contents sit below the strip');

  const send = (target, type, x, y) => {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    target.dispatchEvent(event);
  };
  send(grip, 'pointerdown', 100, 100);
  send(window, 'pointermove', 160, 70);
  send(window, 'pointerup', 160, 70);
  assert.equal(details.style.getPropertyValue('--details-x'), '60px');
  assert.equal(details.style.getPropertyValue('--details-y'), '-30px');

  // A new person rebuilds the card's contents, not its place.
  $('social-web-find-toggle').click();
  const other = [...$('social-web-people-list').querySelectorAll('.search-card__option')]
    .filter((row) => row.getAttribute('aria-selected') !== 'true')[0];
  if (other) other.click();
  assert.equal(details.style.getPropertyValue('--details-x'), '60px',
    'the place holds from one person to the next');
  assert.equal(details.style.getPropertyValue('--details-y'), '-30px');
});

await test('the person card says which grade they are in', async () => {
  // A grade is part of who someone is, so the card that names and numbers them
  // says it too: Frank opens Erin's card and reads "Erin · Sophomore".
  const erinCookie = await signInAs('sub-page-erin', 'erin@example.org', 'Erin');
  const erin = await accountOf('sub-page-erin');
  await asOther(erinCookie, () => window.HTAccount.updateProfile({ grade: 10 }));
  await signInAs('sub-page-frank', 'frank@example.org', 'Frank');
  await settle();

  $('tab-social-web-btn').click();
  await settle(2);
  $('social-web-refresh').click();
  await settle(3);

  const node = $('social-web-scene').querySelector(`.social-web__node[data-profile-id="${erin.profile_id}"]`);
  assert.ok(node, 'Erin is on the map');
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const heading = $('social-web-details').querySelector('strong').textContent;
  assert.match(heading, /Erin/, 'the card names her');
  assert.match(heading, /Sophomore/, 'and says which grade she is in');
});

await test('a request waiting on an answer is a dashed edge on the map', async () => {
  // Pat asks Frank and Frank has not answered. That is part of the story the map
  // tells: the same two people as a dashed line, the arrow pointing the way the
  // question went, and the count saying it is waiting rather than a connection.
  const patCookie = await signInAs('sub-page-pat', 'pat@example.org', 'Pat');
  const frank = await accountOf('sub-page-frank');
  const frankCookie = await signInAs('sub-page-frank', 'frank@example.org', 'Frank');
  await asOther(frankCookie, () => window.HTAccount.updateProfile({ autoGrant: false }));
  await asOther(patCookie, () => window.HTAccount.askForSchedule(frank.profile_id));
  await window.HTAccount.refresh();
  await settle();

  $('tab-social-web-btn').click();
  await settle(2);
  $('social-web-refresh').click();
  await settle(3);

  const waiting = [...$('social-web-scene').querySelectorAll('.social-web__edge.is-pending')];
  const askedMe = waiting.find((edge) => /Pat asked you for your schedule/.test(edge.textContent));
  assert.ok(askedMe, 'the waiting request is drawn, dashed, naming who asked');
  assert.ok(waiting.length >= 1);

  const settled = $('social-web-scene').querySelectorAll('.social-web__edge:not(.is-pending)').length;
  assert.match($('social-web-count').textContent,
    new RegExp('\\d+ people · ' + settled + ' connections · ' + waiting.length + ' waiting'),
    'waiting requests are counted apart from the connections');
});

await test('hovering a search row lights that person and their lines', async () => {
  const frank = await accountOf('sub-page-frank');
  $('tab-social-web-btn').click();
  await settle(2);
  const row = [...$('social-web-people-list').querySelectorAll('.search-card__option')]
    .find((option) => option.getAttribute('data-profile-id') === frank.profile_id);
  assert.ok(row, 'the signed-in account is in the list');
  const node = $('social-web-scene').querySelector(`.social-web__node[data-profile-id="${frank.profile_id}"]`);

  row.dispatchEvent(new window.MouseEvent('pointerenter'));
  assert.match(node.getAttribute('class'), /is-lit/, 'the node lights up');
  assert.ok($('social-web-scene').querySelector('.social-web__edge.is-lit'),
    'and so do the lines that touch them');

  row.dispatchEvent(new window.MouseEvent('pointerleave'));
  assert.doesNotMatch(node.getAttribute('class'), /is-lit/, 'the light goes out again');
  assert.equal($('social-web-scene').querySelector('.social-web__edge.is-lit'), null, 'lines too');
});

await test('a reciprocal share is one connection, and a one-way share stays one arrow', async () => {
  const L = window.HTSocialWeb.links;
  // JSON, because the array comes from the page's realm and deepEqual here is
  // strict about prototypes.
  assert.equal(JSON.stringify(L([{ source: 'a', target: 'b' }]).map((l) => [l.source, l.target, l.mutual])),
    JSON.stringify([['a', 'b', false]]), 'one grant is one one-way line');
  const both = L([{ source: 'b', target: 'a' }, { source: 'a', target: 'b' }]);
  assert.equal(both.length, 1, 'a reciprocal pair is a single connection');
  assert.equal(both[0].mutual, true, 'and it is marked for an arrowhead at each end');
  assert.equal(L([{ source: 'a', target: 'a' }]).length, 0, 'a self-grant is not drawn');
});

await test('force layout gathers connected groups and is deterministic', async () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((profileId) => ({ profileId, displayName: profileId }));
  const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' },
    { source: 'd', target: 'e' }, { source: 'e', target: 'f' }, { source: 'f', target: 'd' }];
  const positions = window.HTSocialWeb.layout(nodes, edges);
  assert.deepEqual(positions, window.HTSocialWeb.layout(nodes, edges));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(distance(positions[0], positions[1]) < distance(positions[0], positions[3]), 'linked people are closer than separate groups');
  assert.ok(positions.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
});

await test('the invisible group barrier keeps one-friend people outside the cluster', async () => {
  // A friend group (a, b and c all mutually linked), one person hanging off it
  // by a single connection (d), and one more hanging off that person (e), who
  // has no friend in the group at all.
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((profileId) => ({ profileId, displayName: profileId }));
  const edges = [
    { source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' },
    { source: 'a', target: 'd' }, { source: 'd', target: 'e' },
  ];
  const positions = window.HTSocialWeb.layout(nodes, edges);
  const by = (id) => positions.find((p) => p.profileId === id);
  const core = ['a', 'b', 'c'].map(by);
  const cx = core.reduce((sum, node) => sum + node.x, 0) / core.length;
  const cy = core.reduce((sum, node) => sum + node.y, 0) / core.length;
  const coreRadius = Math.max.apply(null, core.map((node) => Math.hypot(node.x - cx, node.y - cy)));
  const leaf = Math.hypot(by('d').x - cx, by('d').y - cy);
  const chained = Math.hypot(by('e').x - cx, by('e').y - cy);
  assert.ok(leaf > coreRadius + 60, 'a one-friend person sits outside the group, not inside it');
  assert.ok(chained > leaf + 80, 'and a friend of that person sits a further ring out');
  assert.deepEqual(window.HTSocialWeb.layout(nodes, edges), positions, 'the layout stays deterministic');
});

await test('edges flow around the icons between them instead of under them', async () => {
  const a = { x: 0, y: 0 };
  const b = { x: 240, y: 0 };
  const blocker = { x: 120, y: 6 };

  // Coordinates alternate x, y, starting with the tip at the source.
  const straight = window.HTSocialWeb.edgePath(a, b, [a, b], false)
    .match(/-?\d+(?:\.\d+)?/g).map(Number);
  for (let i = 1; i < straight.length; i += 2) {
    assert.equal(straight[i], 0, 'an unobstructed edge stays on the line between them');
  }

  // 70 out is past both the icon and the name under it, so it is not in the way.
  const near = { x: 120, y: -70 };
  const passing = window.HTSocialWeb.edgePath(a, b, [a, b, near], false)
    .match(/-?\d+(?:\.\d+)?/g).map(Number);
  for (let i = 1; i < passing.length; i += 2) {
    assert.equal(passing[i], 0, 'a person the edge merely passes near does not bend it');
  }

  // M tip, L end of the start stub, two cubics, L end of the end stub.
  const n = window.HTSocialWeb.edgePath(a, b, [a, b, blocker], false)
    .match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.equal(n.length, 18, 'start stub, two curves, end stub');
  const point = (i) => ({ x: n[i], y: n[i + 1] });
  const at = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    };
  };
  let closest = Infinity;
  for (let t = 0; t <= 1; t += 0.05) {
    for (const s of [
      at(point(2), point(4), point(6), point(8), t),
      at(point(8), point(10), point(12), point(14), t)
    ]) {
      closest = Math.min(closest, Math.hypot(s.x - blocker.x, s.y - blocker.y));
    }
  }
  assert.ok(Math.abs(point(8).y) > 24,
    'the middle of the line bends out of the icon it would have crossed');
  assert.ok(closest > 24, 'the drawn line keeps outside the icon along its whole length');

  // A name lying across the line bends it exactly as an icon does.
  const onName = { x: 120, y: -40, nameWidth: 96 };
  const named = window.HTSocialWeb.edgePath(a, b, [a, b, onName], false)
    .match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.ok(Math.abs(named[9]) > 20, 'a name across the line bends it too');
});

await test('an edge stops the same distance from every person and aims at them', async () => {
  // The tip is a fixed 29 from the centre and the last leg is radial, so a bend
  // in the middle cannot leave the arrowhead pointing past its person.
  const a = { x: 0, y: 0 };
  const b = { x: 300, y: 120 };
  const n = window.HTSocialWeb.edgePath(a, b, [a, b], false)
    .match(/-?\d+(?:\.\d+)?/g).map(Number);
  const start = { x: n[0], y: n[1] };
  const beforeEnd = { x: n[14], y: n[15] };
  const end = { x: n[16], y: n[17] };
  assert.ok(Math.abs(Math.hypot(start.x - a.x, start.y - a.y) - 29) < 1e-9,
    'the tip starts 29 from the first person');
  assert.ok(Math.abs(Math.hypot(end.x - b.x, end.y - b.y) - 29) < 1e-9,
    'and ends 29 from the second, whatever the distance between them');
  const cross = (end.x - beforeEnd.x) * (b.y - end.y) - (end.y - beforeEnd.y) * (b.x - end.x);
  assert.ok(Math.abs(cross) < 1e-9, 'the leg into the circle is aimed at its centre');
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
  const stored = JSON.parse((await accountOf('sub-page-frank')).block_prefs);
  const names = Object.values(stored).map((b) => b.name);
  assert.ok(names.some((n) => n.length), 'the account still holds courses: ' + JSON.stringify(names));
});

await test('friends are reordered by dragging a row onto another', async () => {
  // The Friends list is the card's running order, so reordering it is a drag
  // from the grip onto the row it should take the place of. A cold page with
  // the list already stored is how a returning student sees it.
  const dragPage = mountPage({ storage: { friends: [
    { email: 'a@example.org', name: 'Ana' },
    { email: 'b@example.org', name: 'Ben' },
    { email: 'c@example.org', name: 'Cleo' },
  ] } });
  await dragPage.settle();

  const rows = () => [...dragPage.$('friend-rows').querySelectorAll('.class-settings__friend-row')];
  const SEEDED = ['a@example.org', 'b@example.org', 'c@example.org'];
  // The page also adopts friends it has been granted, so only the three seeded
  // rows are asserted on; their relative order is what the drag changes.
  const seededNames = () => rows()
    .map((r) => r.querySelector('strong').textContent)
    .filter((label) => SEEDED.some((email) => label.includes(email)))
    .map((label) => label.replace(/\s*\(.*\)$/, ''));
  const order = () => JSON.parse(dragPage.window.localStorage.getItem('friends') || '[]')
    .filter((f) => SEEDED.includes(f.email))
    .map((f) => f.name);

  assert.deepEqual(seededNames(), ['Ana', 'Ben', 'Cleo'], 'the list renders in the stored order');

  // Each row carries a grip that says what it does and draws its dots.
  const grip = rows()[0].querySelector('.class-settings__grip');
  assert.ok(grip, 'the row has a drag grip');
  assert.match(grip.getAttribute('aria-label'), /Reorder Ana/, 'the grip names the friend');
  assert.ok(grip.querySelector('circle'), 'the grip draws its dots');

  // A drag: dragstart on Cleo, dragover/drop on Ana, so Cleo takes Ana's place.
  const dataTransfer = { effectAllowed: '', dropEffect: '', setData() {}, getData: () => '' };
  const dragEvent = (type) => {
    const e = new dragPage.window.Event(type, { bubbles: true, cancelable: true });
    e.dataTransfer = dataTransfer;
    return e;
  };
  const rowFor = (name) => rows().find((r) => r.querySelector('strong').textContent.startsWith(name));
  rowFor('Cleo').dispatchEvent(dragEvent('dragstart'));
  rowFor('Ana').dispatchEvent(dragEvent('dragover'));
  assert.ok(rowFor('Ana').classList.contains('is-drop-target'), 'the target row is marked');
  rowFor('Ana').dispatchEvent(dragEvent('drop'));
  await dragPage.settle();

  assert.deepEqual(order(), ['Cleo', 'Ana', 'Ben'], 'Cleo moved to the front');
  assert.deepEqual(seededNames(), ['Cleo', 'Ana', 'Ben'], 'and the list re-rendered in the new order');
  assert.equal(dragPage.$('friend-rows').querySelector('.is-drop-target'), null, 'the drop mark is cleared');

  // The grip is also a keyboard control, for anyone who cannot drag.
  rowFor('Ben').querySelector('.class-settings__grip').dispatchEvent(
    new dragPage.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
  );
  await dragPage.settle();
  assert.deepEqual(order(), ['Cleo', 'Ben', 'Ana'], 'ArrowUp moves the focused friend up');

  // And it is clickable, for touch: pick a row up, then click where it lands.
  rowFor('Ana').querySelector('.class-settings__grip').dispatchEvent(new dragPage.window.Event('click'));
  await dragPage.settle();
  assert.ok(rowFor('Ana').classList.contains('is-picked'), 'the picked row is marked');
  rowFor('Cleo').querySelector('.class-settings__grip').dispatchEvent(new dragPage.window.Event('click'));
  await dragPage.settle();
  assert.deepEqual(order(), ['Ana', 'Cleo', 'Ben'], 'the picked friend took the clicked row\'s place');
  assert.equal(dragPage.$('friend-rows').querySelector('.is-picked'), null, 'the pick is cleared after the move');

  // The order survives a reload, which is the whole point of reordering.
  const reloaded = mountPage({ storage: { friends: JSON.parse(dragPage.window.localStorage.getItem('friends')) } });
  await reloaded.settle();
  assert.deepEqual(
    [...reloaded.$('friend-rows').querySelectorAll('strong')].map((n) => n.textContent)
      .filter((label) => SEEDED.some((email) => label.includes(email)))
      .map((label) => label.replace(/\s*\(.*\)$/, '')),
    ['Ana', 'Cleo', 'Ben'],
    'the new order is what the card will show'
  );
  assert.equal(dragPage.errors.length + reloaded.errors.length, 0, 'no errors in either page');
});


await test('a step centres its target and does not scroll-lock the page', async () => {
  // Arriving at a step while scrolled down used to leave the spotlight
  // framing stale coordinates, because `block: 'nearest'` is a no-op when the
  // element is already partly visible. Centring is what fixes it, and it only
  // works because the page is not scroll-locked.
  const t = mountPage({ storage: { settingsTourSeen: 1 } });
  await signInAs('sub-tour-scroll', 'scroll@example.org', 'Scroll');
  await t.window.HTAccount.refresh();
  await t.settle();

  const target = t.$('profile-id');
  const centred = [];
  target.scrollIntoView = function (options) { centred.push(options); };

  t.window.HTTour.start();
  t.$('tour-next').click(); // onto the profile-id step

  assert.equal(centred.length, 1, 'the step asked the page to scroll');
  assert.equal(centred[0].block, 'center',
    'and asked to centre, not to scroll the minimum (which does nothing)');
  assert.equal(centred[0].behavior, 'instant',
    'a smooth scroll would be measured mid-flight and land in the wrong place');

  // Locking the root scroller is what stopped scrollIntoView working and made
  // the sticky sidebar jump, so assert it is not locked.
  const rootOverflow = t.window.getComputedStyle(t.window.document.documentElement).overflow;
  assert.notEqual(rootOverflow, 'hidden', 'the page is not scroll-locked while the tour runs');

  t.window.HTTour.stop();
});

await test('no step card covers the control it is pointing at', async () => {
  // jsdom reports every rect as zero, so an overlap assertion against real
  // numbers would pass no matter what. Give the elements honest geometry --
  // including a narrow window, which is when the placement fallback actually
  // misbehaves -- and then check the card is clear of the spotlight.
  const t = mountPage({ storage: { settingsTourSeen: 1 } });

  const VIEWPORT = { w: 1280, h: 900 }; // desktop: sides fit, so clamping is not the path
  Object.defineProperty(t.window, 'innerWidth', { value: VIEWPORT.w, configurable: true });
  Object.defineProperty(t.window, 'innerHeight', { value: VIEWPORT.h, configurable: true });

  const card = () => t.$('tour').querySelector('.tour__card');
  Object.defineProperty(t.window.HTMLElement.prototype, 'offsetWidth', {
    get() { return this.classList.contains('tour__card') ? 300 : 0; }, configurable: true,
  });
  Object.defineProperty(t.window.HTMLElement.prototype, 'offsetHeight', {
    get() { return this.classList.contains('tour__card') ? 170 : 0; }, configurable: true,
  });

  // The sidebar sits hard against the left edge, 232px wide, so its tabs are
  // the one target with no room on either side.
  const sidebar = t.$('tablist').getBoundingClientRect.bind(t.$('tablist'));
  t.$('tablist').getBoundingClientRect = () => ({ left: 0, top: 120, width: 232, height: 400, right: 232, bottom: 520 });
  t.$('tab-friends-btn').getBoundingClientRect = () => {
    const base = sidebar();
    return { left: 14, top: base.top, width: 204, height: 44, right: 218, bottom: base.top + 44 };
  };
  t.$('friends-search-card').getBoundingClientRect = () => ({ left: 20, top: 300, width: 200, height: 40, right: 220, bottom: 340 });

  await signInAs('sub-tour-overlap', 'overlap@example.org', 'Overlap');
  await t.window.HTAccount.refresh();
  await t.settle();
  t.window.HTTour.start();

  const rectOf = (node) => ({
    left: Number.parseFloat(node.style.left),
    top: Number.parseFloat(node.style.top),
    width: Number.parseFloat(node.style.width),
    height: Number.parseFloat(node.style.height),
  });
  const cardRect = () => {
    const c = card();
    return {
      left: Number.parseFloat(c.style.left), top: Number.parseFloat(c.style.top),
      width: 300, height: 170,
    };
  };
  const overlaps = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left
    && a.top < b.top + b.height && a.top + a.height > b.top;

  const total = t.window.HTTour.steps().length;
  for (let i = 0; i < total; i++) {
    const title = t.$('tour-title').textContent;
    const hole = t.$('tour').querySelector('.tour__hole');
    if (!hole.hidden) {
      assert.ok(!overlaps(cardRect(), rectOf(hole)),
        'step "' + title + '" must not cover the control it points at');
    }
    // The card must also stay on screen.
    const c = cardRect();
    assert.ok(c.left >= 0 && c.top >= 0
      && c.left + c.width <= VIEWPORT.w && c.top + c.height <= VIEWPORT.h,
      'step "' + title + '" keeps its card fully on screen');
    t.$('tour-next').click();
  }
  t.window.HTTour.stop();
});

await test('no uncaught errors occurred across the whole run', async () => {
  assert.equal(errors.length, 0, errors.join(' | '));
});

// ---------------------------------------------------------------------------
// Onboarding tour
//
// Each test gets its own page so the overlay cannot leak into the next one,
// and so a tour that auto-starts on sign-in is exercised the way a new student
// would meet it.
// ---------------------------------------------------------------------------

await test('signing in for the first time starts the tour', async () => {
  const fresh = mountPage();
  await signInAs('sub-tour-new', 'newbie@example.org', 'Newbie');
  await fresh.window.HTAccount.refresh();
  await fresh.settle();

  assert.ok(fresh.window.HTTour, 'the tour module loaded');
  assert.equal(fresh.window.HTTour.isRunning(), true, 'the tour opened itself');
  assert.equal(fresh.$('tour').hidden, false, 'the overlay is up');

  const count = fresh.$('tour-count').textContent;
  assert.equal(count, 'Step 1 of ' + fresh.window.HTTour.steps().length,
    'it opens on the first step and knows how many there are');
  assert.ok(fresh.$('tour-title').textContent.length > 0, 'the step has a title');
  assert.ok(fresh.$('tour-back').hidden, 'there is no Back on the first step');
  // The step count varies with sign-in state, so the copy must not quote one.
  assert.doesNotMatch(fresh.$('tour-body').textContent, /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i,
    'the opening copy does not promise a number of steps it cannot keep');

  fresh.window.HTTour.stop();
});

await test('a finished tour does not open again on the next visit', async () => {
  const first = mountPage();
  await signInAs('sub-tour-once', 'once@example.org', 'Once');
  await first.window.HTAccount.refresh();
  await first.settle();
  assert.equal(first.window.HTTour.isRunning(), true, 'it ran the first time');

  // Walk it out through the Done button, the way a visitor finishes it.
  for (let i = 0; i < 20; i++) first.$('tour-next').click();
  assert.equal(first.window.HTTour.isRunning(), false, 'Done closes the tour');
  assert.equal(first.$('tour').hidden, true, 'the overlay is gone');
  assert.equal(first.window.localStorage.getItem('settingsTourSeen'), '1',
    'it is remembered so it never nags');

  // A returning browser already has the flag in storage.
  const second = mountPage({ storage: { settingsTourSeen: 1 } });
  await signInAs('sub-tour-once', 'once@example.org', 'Once');
  await second.window.HTAccount.refresh();
  await second.settle();
  assert.equal(second.window.HTTour.isRunning(), false,
    'a second visit does not reopen it');
});

await test('Next and Back walk the steps and the last one says Done', async () => {
  const t = mountPage({ storage: { settingsTourSeen: 1 } });
  // Signed in, so every step applies and the tour runs its full length.
  await signInAs('sub-tour-steps', 'steps@example.org', 'Steps');
  await t.window.HTAccount.refresh();
  await t.settle();
  t.window.HTTour.start();
  const total = t.window.HTTour.steps().length;
  assert.equal(t.$('tour-count').textContent, 'Step 1 of ' + total,
    'a signed-in visitor gets every step');
  const titles = t.window.HTTour.steps().map((s) => s.title);

  assert.equal(t.$('tour-title').textContent, titles[0], 'it opens on step one');
  assert.equal(t.$('tour-next').textContent, 'Next');

  t.$('tour-next').click();
  assert.equal(t.$('tour-title').textContent, titles[1], 'Next advances');
  assert.equal(t.$('tour-back').hidden, false, 'Back appears once there is somewhere to go');

  t.$('tour-back').click();
  assert.equal(t.$('tour-title').textContent, titles[0], 'Back goes back');
  assert.equal(t.$('tour-back').hidden, true, 'and hides itself at the start again');

  // total-1 clicks from step one lands on step total.
  for (let i = 0; i < total - 1; i++) t.$('tour-next').click();
  assert.equal(t.$('tour-title').textContent, titles[total - 1], 'reaches the last step');
  assert.equal(t.$('tour-next').textContent, 'Done with tour',
    'the last button is labelled for what it does');

  t.window.HTTour.stop();
});

await test('the tour dims the page and spotlights the thing it points at', async () => {
  const t = mountPage({ storage: { settingsTourSeen: 1 } });
  t.window.HTTour.start();

  const hole = t.$('tour').querySelector('.tour__hole');
  const full = t.$('tour').querySelector('.tour__scrim-full');

  // The opening card has nothing to point at, so it dims evenly.
  assert.equal(full.hidden, false, 'the welcome step dims the whole page');
  assert.equal(hole.hidden, true, 'and cuts no hole');

  // The second step points at something, so it spotlights instead.
  t.$('tour-next').click();
  assert.equal(hole.hidden, false, 'a pointed-at step shows the spotlight');
  assert.equal(full.hidden, true, 'and drops the full-page dim');
  // The dimming is that hole's box-shadow spread, so the hole has to be
  // positioned over the target.
  assert.ok(Number.parseFloat(hole.style.width) > 0, 'it has a width');
  assert.ok(Number.parseFloat(hole.style.left) >= 0, 'it has a left edge');
  assert.equal(t.$('tour').classList.contains('tour--on'), true, 'the overlay is marked on');
  // The page behind the tour is deliberately not scroll-locked; see the
  // centring test for why locking it broke both scrolling and the sidebar.
  assert.notEqual(
    t.window.getComputedStyle(t.window.document.documentElement).overflow,
    'hidden',
    'the page behind the tour can still scroll, so a step can centre its target');

  t.window.HTTour.stop();
  assert.equal(hole.hidden, true, 'the spotlight goes away with the tour');
  assert.equal(t.$('tour').classList.contains('tour--on'), false,
    'and the overlay is marked off');
});

await test('a step that switches tab moves the page to it first', async () => {
  const t = mountPage({ storage: { settingsTourSeen: 1 } });
  await signInAs('sub-tour-tab', 'tab@example.org', 'Tab');
  await t.window.HTAccount.refresh();
  await t.settle();
  t.window.HTTour.start();

  // Step 6 points at the search card, which lives in the Friends panel.
  const step = t.window.HTTour.steps().find((s) => s.target === 'friends-search-card');
  const index = t.window.HTTour.steps().indexOf(step);
  for (let i = 0; i < index; i++) t.$('tour-next').click();

  assert.equal(t.$('tab-friends-btn').getAttribute('aria-selected'), 'true',
    'the tour opened the tab the step lives in');
  assert.equal(t.$('panel-friends').hidden, false, 'and revealed its panel');
  assert.equal(t.$('tour-title').textContent, step.title);

  t.window.HTTour.stop();
});

await test('Escape and Skip both leave, and only a completed run is remembered', async () => {
  // Start from a visitor who has never seen the tour, so "not remembered yet"
  // is the honest starting state.
  const t = mountPage({ storage: { settingsTourSeen: 1 } });
  t.window.localStorage.removeItem('settingsTourSeen');
  t.window.HTTour.start();

  t.window.document.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(t.window.HTTour.isRunning(), false, 'Escape leaves the tour');
  assert.equal(t.window.localStorage.getItem('settingsTourSeen'), null,
    'leaving early does not mark it seen, so it can be replayed');

  t.window.HTTour.start();
  t.$('tour-skip').click();
  assert.equal(t.window.HTTour.isRunning(), false, 'Skip leaves too');
  assert.equal(t.window.localStorage.getItem('settingsTourSeen'), null,
    'skipping is not finishing');
});

await test('the Replay button in Account brings the tour back', async () => {
  const t = mountPage({ storage: { settingsTourSeen: 1 } });
  await signInAs('sub-tour-replay', 'replay@example.org', 'Replay');
  await t.window.HTAccount.refresh();
  await t.settle();

  assert.equal(t.$('tour-replay').hidden, false, 'the button shows to a signed-in student');
  assert.equal(t.window.HTTour.isRunning(), false, 'and the tour did not open by itself');

  t.$('tour-replay').click();
  assert.equal(t.window.HTTour.isRunning(), true, 'clicking it starts the tour');
  assert.equal(t.$('tour-count').textContent, 'Step 1 of ' + t.window.HTTour.steps().length,
    'from the beginning');

  t.window.HTTour.stop();
});

await test('a step with no visible target drops out of the tour', async () => {
  // Signed out, the account sections are hidden. Their steps must disappear
  // rather than point at something the visitor cannot see, so the tour is
  // shorter for a signed-out visitor than the full step list.
  const t = mountPage();
  // The shared cookie jar is still signed in as whoever ran last, so sign out
  // before asserting this page starts signed out.
  await t.window.HTAccount.signOut();
  await t.window.HTAccount.refresh();
  await t.settle();

  assert.equal(t.$('account-signed-in').hidden, true, 'signed out to start with');
  const gated = t.window.HTTour.steps().filter((s) => s.signedInOnly);
  assert.ok(gated.length > 0, 'the tour does have signed-in steps');

  t.window.HTTour.start();
  const shown = Number.parseInt(t.$('tour-count').textContent.split(' ')[3], 10);
  assert.ok(shown < t.window.HTTour.steps().length,
    'a signed-out visitor sees fewer steps than there are, not the full list');
  assert.equal(shown, t.window.HTTour.steps().filter((s) => !s.signedInOnly).length,
    'exactly the steps that do not need an account');

  // Every step it does run must point at something it can actually see.
  const total = t.window.HTTour.steps().length;
  for (let i = 0; i < total; i++) {
    const title = t.$('tour-title').textContent;
    const step = t.window.HTTour.steps().find((s) => s.title === title);
    assert.ok(step, 'every step the tour shows is one of the real steps');
    assert.ok(!step.signedInOnly,
      'no signed-in-only step (' + step.id + ') is shown to a signed-out visitor');
    t.$('tour-next').click();
  }
  t.window.HTTour.stop();
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length - passed ? 1 : 0);
