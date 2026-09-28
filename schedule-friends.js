/*
 * Where the card's friends come from when it is embedded as a Topping.
 *
 * Opened directly, index.html and settings.html are the same origin, so they
 * share localStorage and the friends the settings page saved are already there.
 *
 * Embedded as a Topping the page is in a cross-site iframe, and browsers
 * partition localStorage and third-party cookies by top-level site. Inside the
 * extension's frame the card therefore cannot see what settings.html saved, and
 * would show "No friends yet" even for a signed-in account.
 *
 * So when embedded the card asks the Worker for the account's own grants. Each
 * grant means the viewer may read that profile's schedule, and the schedule the
 * Worker returns already carries the courses, lunch wave, grade and time format
 * the card renders -- the same fields a locally saved friend has. A grant is
 * treated as a friend.
 */
(function () {
  'use strict';

  var H = window.HT;

  /** A cross-site frame is what makes localStorage and cookies unavailable. */
  function isEmbedded(win) {
    return win.top !== win.self;
  }

  /**
   * Turn one profile's schedule into a friend entry.
   *
   * The card keys a friend on `email`, so a profile id occupies that slot: it is
   * stable, unique, and the only identity the Worker exposes for another
   * account. A profile with no id is not a friend.
   */
  function friendFromSchedule(schedule) {
    if (!schedule || !schedule.profileId) return null;
    return H.normalizeFriend({
      email: schedule.profileId,
      name: schedule.displayName || '',
      grade: schedule.grade,
      lunchWave: schedule.lunchWave,
      timeFormat: schedule.timeFormat,
      blockPrefs: schedule.blockPrefs,
    });
  }

  /**
   * The signed-in account as a friend-shaped record, for the primary card.
   *
   * `account.refresh()` returns the account's own profile, including the courses
   * and schedule settings it saved, so the primary card can render the viewer's
   * own day even inside the frame where localStorage is unreachable. The profile
   * has no email in the card's sense, so the account's profile id fills that
   * slot; it is only used for identity here, never shown as a friend.
   */
  function selfFromAccount(me) {
    if (!me) return null;
    var name = me.displayName || me.name || '';
    var self = H.normalizeFriend({
      email: me.profileId || 'me',
      name: name,
      grade: me.grade,
      lunchWave: me.lunchWave,
      timeFormat: me.timeFormat,
      blockPrefs: me.blockPrefs,
    });
    // Keep the account's calendar settings: lunch wave and time format also live
    // in schedulePrefs for a locally configured page, and `normalizeFriend` only
    // understands the friend fields.
    var prefs = me.schedulePrefs || {};
    if (self.lunchWave == null && prefs.lunchWave != null) self.lunchWave = Number(prefs.lunchWave);
    if (prefs.timeFormat === '24h') self.timeFormat = '24h';
    return self;
  }

  /**
   * Your own schedule as the card sees it, read from this browser's settings.
   *
   * Opened directly, index.html and settings.html share localStorage, so the
   * name, courses and schedule settings the settings page saved are already
   * there. Returns null until there is a name to show, so an unconfigured page
   * falls back to the old "show the selected friend" behaviour instead of
   * drawing an empty card for someone who never set themselves up.
   */
  function selfFromLocal() {
    var identity = H.loadIdentity();
    var name = (identity && identity.name) || '';
    if (!name && !(identity && identity.email)) return null;
    var prefs = H.loadSchedulePrefs();
    var grade = prefs.graduationYear != null ? H.gradeFromGraduationYear(prefs.graduationYear) : null;
    return H.normalizeFriend({
      email: identity.email || 'me',
      name: name || identity.email,
      grade: grade,
      lunchWave: prefs.lunchWave != null ? prefs.lunchWave : null,
      timeFormat: prefs.timeFormat,
      blockPrefs: H.loadBlockPrefs(),
    });
  }


  /**
   * Merge account friends into the local list. The same person can arrive both
   * ways -- a share link and a grant -- so entries are matched by identity and
   * the account's data wins, since it is the fresher of the two.
   */
  function mergeFriends(local, account) {
    var list = (local || []).slice();
    (account || []).forEach(function (friend) {
      if (friend) list = H.upsertFriend(list, friend);
    });
    return list;
  }

  /**
   * Fetch the signed-in account's friends. Resolves with an outcome rather than
   * throwing, so the card can distinguish "signed out" from "the request failed"
   * and only offer sign-in when signing in would actually help.
   *
   * `me` may be passed in when the caller already refreshed the account, so this
   * does not fetch it twice; without it the account is refreshed here.
   */
  async function loadAccountFriends(account, me) {
    if (me === undefined) me = await account.refresh();
    if (!me) return { friends: [], signedOut: true };

    var grants = await account.listGrants();
    if (!grants.ok) return { friends: [], failed: true, me: me };

    var schedules = await Promise.all(
      (grants.data.viewing || []).map(function (grant) {
        return account.getSchedule(grant.profileId);
      })
    );

    return {
      me: me,
      friends: schedules
        .filter(function (r) { return r.ok; })
        .map(function (r) { return friendFromSchedule(r.data); })
        .filter(Boolean),
    };
  }

  window.HTFriends = {
    isEmbedded: isEmbedded,
    friendFromSchedule: friendFromSchedule,
    selfFromAccount: selfFromAccount,
    selfFromLocal: selfFromLocal,
    mergeFriends: mergeFriends,
    loadAccountFriends: loadAccountFriends,
  };
})();
