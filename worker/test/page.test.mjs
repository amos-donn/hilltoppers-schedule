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

await test('the auto-grant toggle writes through to the account', async () => {
  $('auto-grant').checked = false;
  $('auto-grant').dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(await plainFieldOf('sub-page-alice', 'auto_grant'), 0);
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

  const incoming = $('requests-incoming').querySelectorAll('.class-settings__friend-row');
  assert.ok(incoming.length >= 1, 'the request appears under "Waiting on you"');
  const accept = [...$('requests-incoming').querySelectorAll('button')].find((b) => b.textContent === 'Accept');
  assert.ok(accept, 'an Accept button is offered');
  accept.dispatchEvent(new window.Event('click'));
  await settle();

  const grant = db.prepare(
    'SELECT revoked_at FROM grants WHERE owner_account_id = ?'
  ).get(await accountIdOf('sub-page-alice'));
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
  const ownerProfileId = (await accountOf('sub-stale-owner-page')).profile_id;

  const daveCookie = await signInAs('sub-stale-dave-page', 'stale.dave@example.org', 'Stale Dave');
  await asOther(daveCookie, async () => {
    await window.HTAccount.updateProfile({ displayName: 'Stale Dave' });
    await window.HTAccount.askForSchedule(ownerProfileId);
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
  const accept = [...$('requests-incoming').querySelectorAll('button')].find((b) => b.textContent === 'Accept');
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

await test('schedule access buttons stay in sync with friends after removal, re-addition and reload', async () => {
  const erinProfileId = (await accountOf('sub-page-erin')).profile_id;
  const addButton = (p) => [...p.$('grant-viewing').querySelectorAll('[data-add-friend]')]
    .find((button) => button.getAttribute('data-add-friend') === erinProfileId);
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
    .find((row) => row.textContent.includes(erinProfileId));
  friendRow.querySelector('.class-settings__icon-button').click();
  assert.equal(addButton(page).disabled, false, 'removing the friend enables adding them again');
  assert.equal(addButton(page).textContent, 'Add to friends');
  addButton(page).click();
  assertAdded(page);
  await settle();
  assertAdded(page);
  const friends = JSON.parse(window.localStorage.getItem('friends'));
  assert.equal(friends.filter((friend) => friend.email === erinProfileId).length, 1, 'only one friend entry is saved');

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
      .some((friend) => friend.email === erinProfileId), 'automatically adopted friends also disable the button');
    assert.deepEqual(fresh.errors, [], 'cold load has no runtime errors');
  } finally {
    fresh.dom.window.close();
  }
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
  assert.ok(openGroup.getAttribute('aria-label').includes(openProfile),
    'a public profile still publishes its ID');
});

await test('the Social web includes everyone by default and supports selection, pan and zoom', async () => {
  const erinCookie = await signInAsShared('sub-page-erin', 'erin@example.org', 'Erin');
  void erinCookie;
  // Restore Frank, as the helper above signed the shared jar into Erin.
  await signInAsShared('sub-page-frank', 'frank@example.org', 'Frank');
  await window.HTAccount.refresh();
  $('tab-social-web-btn').click();
  await settle();
  assert.equal($('panel-social-web').hidden, false);
  assert.equal($('panel-account').hidden, true);
  assert.equal($('page-title').textContent, 'Social web');
  assert.equal($('social-web-workspace').hidden, false);
  assert.ok($('social-web-scene').querySelectorAll('.social-web__node').length >= 2,
    'everyone with an account is in the web, no opt-in');
  const edge = [...$('social-web-scene').querySelectorAll('.social-web__edge')]
    .find((e) => /Erin shares their schedule with Frank/.test(e.textContent));
  assert.ok(edge, 'the Erin-to-Frank sharing edge is drawn');
  assert.equal(edge.getAttribute('marker-end'), 'url(#social-web-arrow)');
  const me = $('social-web-scene').querySelector('.is-you');
  assert.ok(me, 'the signed-in account is in the graph');
  me.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(me.getAttribute('aria-pressed'), 'true');
  assert.match($('social-web-details').textContent, /Can see: Erin/);
  const original = $('social-web-scene').getAttribute('transform');
  $('social-web-zoom-in').click();
  assert.notEqual($('social-web-scene').getAttribute('transform'), original);
  $('social-web-fit').click();
  assert.equal($('social-web-scene').getAttribute('transform'), original);
  $('social-web-canvas').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.notEqual($('social-web-scene').getAttribute('transform'), original, 'keyboard pans');
  $('social-web-fit').click();
  const pointer = (type, x, y, id = 1) => {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    $('social-web-canvas').dispatchEvent(event);
  };
  pointer('pointerdown', 0, 0); pointer('pointermove', 70, 30); pointer('pointerup', 70, 30);
  assert.notEqual($('social-web-scene').getAttribute('transform'), original, 'drag pans');
  $('social-web-fit').click();
  pointer('pointerdown', 100, 100, 1); pointer('pointerdown', 200, 100, 2);
  pointer('pointermove', 300, 100, 2);
  assert.notEqual($('social-web-zoom').textContent, '100%', 'pinch zooms');
  pointer('pointerup', 100, 100, 1); pointer('pointerup', 300, 100, 2);
  const reloaded = mountPage();
  try {
    await reloaded.settle();
    assert.equal(reloaded.errors.length, 0);
  } finally { reloaded.dom.window.close(); }
  $('social-web-account-link').click();
  await settle(2);
  assert.equal($('panel-account').hidden, false, 'profile link navigates to Account');
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
  assert.match(window.HTSocialWeb.edgePath(a, b, [a, b], false), /Q120,0 /,
    'an unobstructed edge is a straight line');

  const bent = window.HTSocialWeb.edgePath(a, b, [a, b, blocker], false);
  const numbers = bent.match(/M([-\d.]+),([-\d.]+) Q([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)/).slice(1).map(Number);
  const [ax, ay, qx, qy, bx, by] = numbers;
  assert.ok(Math.abs(qy) > 40, 'the control point bends clear of the blocking icon');

  let closest = Infinity;
  for (let t = 0.15; t <= 0.85; t += 0.05) {
    const x = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * qx + t * t * bx;
    const y = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * qy + t * t * by;
    closest = Math.min(closest, Math.hypot(x - blocker.x, y - blocker.y));
  }
  assert.ok(closest > 40, 'the drawn line keeps clear of the icon along its whole length');
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
  t.$('directory-search').getBoundingClientRect = () => ({ left: 20, top: 300, width: 200, height: 40, right: 220, bottom: 340 });

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

  // Step 6 points at the directory search, which lives in the Friends panel.
  const step = t.window.HTTour.steps().find((s) => s.target === 'directory-search');
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
