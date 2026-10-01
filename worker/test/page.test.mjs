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
  assert.match($('signin-open').textContent, /Sign in with Hilltoppers/,
    'the green button names who handles the account');
  // The form lives in the popup, which is closed until the button is pressed.
  assert.ok($('signin-form'), 'the popup holds a sign-in form');
  assert.equal($('signin-dialog').hasAttribute('open'), false, 'the popup starts closed');
  assert.ok($('signin-email'), 'with an email field');
  assert.ok($('signin-password'), 'and a password field');
  assert.equal($('requests-panel').hidden, true);
  assert.equal($('access-panel').hidden, true);
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
  assert.equal($('requests-panel').hidden, false);
  assert.equal($('access-panel').hidden, false);
  assert.equal($('notices-panel').hidden, false);
  assert.equal($('danger-panel').hidden, false);
  assert.match($('profile-id').value, /^[a-z]+-[a-z]+-\d{4}$/, 'a profile ID is shown');
  assert.equal($('account-email').value, 'alice@example.org', 'the email is shown');
  assert.equal($('account-email').readOnly, true, 'but is not editable here: it belongs to Hilltoppers');
  assert.equal($('visibility').value, 'private', 'new accounts default to private');
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
  assert.equal(db.prepare('SELECT is_public FROM accounts WHERE firebase_uid = ?').get('sub-page-alice').is_public, 1);
});

await test('the auto-grant toggle writes through to the account', async () => {
  $('auto-grant').checked = false;
  $('auto-grant').dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(db.prepare('SELECT auto_grant FROM accounts WHERE firebase_uid = ?').get('sub-page-alice').auto_grant, 0);
});

await test('editing a course name saves locally and to the account', async () => {
  const input = $('block-rows').querySelector('input[type=text]');
  input.value = 'AP Biology';
  input.dispatchEvent(new window.Event('input'));
  await settle();
  const stored = JSON.parse(db.prepare('SELECT block_prefs FROM accounts WHERE firebase_uid = ?').get('sub-page-alice').block_prefs);
  const firstKey = Object.keys(stored)[0];
  assert.equal(stored[firstKey].name, 'AP Biology', 'the course reached D1');
  const local = JSON.parse(window.localStorage.getItem('blockPreferences') || '{}');
  assert.ok(Object.keys(local).length, 'and is still cached locally');
});

await test('course changes made in another browser load on sign-in', async () => {
  // The account's courses change underneath this browser, then the page is
  // loaded cold, as on a second device. It must adopt the account's version.
  const other = JSON.parse(JSON.stringify(JSON.parse(
    db.prepare('SELECT block_prefs FROM accounts WHERE firebase_uid = ?').get('sub-page-alice').block_prefs
  )));
  const key = Object.keys(other)[0];
  other[key].name = 'From Another Device';
  db.prepare('UPDATE accounts SET block_prefs = ? WHERE firebase_uid = ?')
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
  bob.profileId = db.prepare("SELECT profile_id FROM accounts WHERE firebase_uid = 'sub-page-bob'").get().profile_id;
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

  const aliceId = db.prepare("SELECT id FROM accounts WHERE firebase_uid = 'sub-page-alice'").get().id;
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
    "SELECT profile_id FROM accounts WHERE firebase_uid = 'sub-page-alice'"
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
    'SELECT revoked_at FROM grants WHERE owner_account_id = (SELECT id FROM accounts WHERE firebase_uid = ?)'
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
    'SELECT revoked_at FROM grants WHERE owner_account_id = (SELECT id FROM accounts WHERE firebase_uid = ?)'
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
  const ownerId = db.prepare("SELECT profile_id FROM accounts WHERE firebase_uid = 'sub-page-owner-notice'").get();

  const daveCookie = await signInAs('sub-page-dave-notice', 'dave.notice@example.org', 'Dave Notice');
  await asOther(daveCookie, async () => {
    await window.HTAccount.updateProfile({ displayName: 'Dave Notice' });
    const ask = await window.HTAccount.askForSchedule(ownerId.profile_id);
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
    `SELECT 1 FROM grants WHERE viewer_account_id =
       (SELECT id FROM accounts WHERE firebase_uid = 'sub-page-dave-notice') AND revoked_at IS NULL`
  ).get(), 'accepting from the notice created a live grant');
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
  const ownerId = db.prepare("SELECT profile_id FROM accounts WHERE firebase_uid = 'sub-stale-owner-page'").get();

  const daveCookie = await signInAs('sub-stale-dave-page', 'stale.dave@example.org', 'Stale Dave');
  await asOther(daveCookie, async () => {
    await window.HTAccount.updateProfile({ displayName: 'Stale Dave' });
    await window.HTAccount.askForSchedule(ownerId.profile_id);
  });

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
  assert.deepEqual(labels, ['Display name', 'Your profile ID', 'Who can find you']);
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

  const visible = ['account', 'friends', 'notices']
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
  const carolId = db.prepare("SELECT id, profile_id FROM accounts WHERE firebase_uid = 'sub-page-carol'").get();

  const daveCookie = await signInAs('sub-page-dave', 'dave@example.org', 'Dave');
  const daveId = db.prepare("SELECT id, profile_id FROM accounts WHERE firebase_uid = 'sub-page-dave'").get();
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
  const erinId = db.prepare("SELECT id, profile_id FROM accounts WHERE firebase_uid = 'sub-page-erin'").get();
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

await test('schedule access buttons stay in sync with friends after removal, re-addition and reload', async () => {
  const erinId = db.prepare("SELECT profile_id FROM accounts WHERE firebase_uid = 'sub-page-erin'").get().profile_id;
  const addButton = (p) => [...p.$('grant-viewing').querySelectorAll('[data-add-friend]')]
    .find((button) => button.getAttribute('data-add-friend') === erinId);
  const assertAdded = (p) => {
    const button = addButton(p);
    assert.ok(button, 'Erin has a schedule access card');
    assert.equal(button.disabled, true, 'an existing friend cannot be added again');
    assert.equal(button.textContent, 'Added');
  };

  await window.HTAccount.refresh();
  await settle();
  assertAdded(page);
  const friendRow = [...$('friend-rows').querySelectorAll('.class-settings__friend-row')]
    .find((row) => row.textContent.includes(erinId));
  friendRow.querySelector('.class-settings__icon-button').click();
  assert.equal(addButton(page).disabled, false, 'removing the friend enables adding them again');
  assert.equal(addButton(page).textContent, 'Add to friends');
  addButton(page).click();
  assertAdded(page);
  await settle();
  assertAdded(page);
  const friends = JSON.parse(window.localStorage.getItem('friends'));
  assert.equal(friends.filter((friend) => friend.email === erinId).length, 1, 'only one friend entry is saved');

  const reloaded = mountPage({ storage: { friends } });
  try {
    await reloaded.settle();
    assertAdded(reloaded);
    assert.deepEqual(reloaded.errors, [], 'reload has no runtime errors');
  } finally {
    reloaded.dom.window.close();
  }

  const fresh = mountPage();
  try {
    await fresh.settle();
    assertAdded(fresh);
    assert.ok(JSON.parse(fresh.window.localStorage.getItem('friends'))
      .some((friend) => friend.email === erinId), 'automatically adopted friends also disable the button');
    assert.deepEqual(fresh.errors, [], 'cold load has no runtime errors');
  } finally {
    fresh.dom.window.close();
  }
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
    "SELECT block_prefs FROM accounts WHERE firebase_uid = 'sub-page-frank'"
  ).get().block_prefs);
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

await test('no uncaught errors occurred across the whole run', async () => {
  assert.equal(errors.length, 0, errors.join(' | '));
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length - passed ? 1 : 0);
