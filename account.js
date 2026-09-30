/**
 * Account client for the settings page.
 *
 * The Worker is the only thing that talks to D1; this file is the only thing on
 * the page that talks to the Worker. It keeps a single cached copy of the
 * signed-in account so the UI can render synchronously, and refetches it after
 * anything that changes it.
 *
 * Signing in is a two-step the page owns: auth.js signs in against Hilltoppers
 * (Firebase) and this hands the resulting ID token to the Worker, which
 * verifies it and sets the session cookie. Every request after that sends
 * credentials, because the session is a cross-origin cookie (the page is on
 * github.io, the API on workers.dev). Without that flag the browser would omit
 * the cookie and every call would look signed out.
 */
(function () {
  'use strict';

  var API = 'https://hilltoppers-schedule-friends.amos-donn.workers.dev';

  var cachedMe = null;
  var listeners = [];

  function onAuthChange(fn) {
    listeners.push(fn);
  }

  function emit() {
    listeners.forEach(function (fn) {
      try {
        fn(cachedMe);
      } catch (e) {
        /* a broken listener must not break the others */
      }
    });
  }

  /**
   * One place where the response contract is handled. A 401 means "not signed
   * in" rather than an error, so it resolves to { unauthorized: true } and the
   * UI can show the sign-in state without a stack of try/catch.
   */
  async function api(path, options) {
    var opts = options || {};
    var response;
    try {
      response = await fetch(API + path, {
        method: opts.method || 'GET',
        credentials: 'include',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      return { ok: false, networkError: true, status: 0 };
    }

    if (response.status === 401) return { ok: false, unauthorized: true, status: 401 };

    var data = null;
    try {
      data = await response.json();
    } catch (e) {
      /* a redirect or empty body, handled below */
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: data && data.error };
    }
    return { ok: true, status: response.status, data: data };
  }

  async function refresh() {
    var result = await api('/api/me');
    cachedMe = result.ok ? result.data : null;
    emit();
    return cachedMe;
  }

  function current() {
    return cachedMe;
  }

  function isSignedIn() {
    return cachedMe !== null;
  }

  /**
   * Sign in with an ID token from Hilltoppers Auth (Firebase).
   *
   * The browser signs in against Firebase directly - see auth.js - and hands
   * the token here. This Worker verifies it and issues its own session cookie,
   * so everything downstream is unchanged. The cookie is what carries the
   * session from here on; the ID token is not kept.
   */
  async function signInWithIdToken(idToken) {
    var result = await api('/api/auth/firebase', { method: 'POST', body: { idToken: idToken } });
    if (result.ok) {
      cachedMe = result.data;
      emit();
    }
    return result;
  }

  async function signOut() {
    // Clear the Firebase session too, or a reload would silently sign back in.
    if (window.HTAuth) {
      try {
        await window.HTAuth.signOut();
      } catch (e) {
        /* signing out locally is what matters; the Worker session is next */
      }
    }
    await api('/api/auth/logout', { method: 'POST' });
    cachedMe = null;
    emit();
  }

  async function updateProfile(patch) {
    var result = await api('/api/me', { method: 'PATCH', body: patch });
    if (result.ok) {
      cachedMe = result.data;
      emit();
    }
    return result;
  }

  async function deleteAccount() {
    var result = await api('/api/me', { method: 'DELETE' });
    cachedMe = null;
    emit();
    return result;
  }

  function searchDirectory(query) {
    return api('/api/directory?q=' + encodeURIComponent(query || ''));
  }

  function askForSchedule(profileId) {
    return api('/api/requests', { method: 'POST', body: { profileId: profileId } });
  }

  function listRequests() {
    return api('/api/requests');
  }

  function decideRequest(id, decision) {
    return api('/api/requests/' + encodeURIComponent(id), { method: 'POST', body: { decision: decision } });
  }

  function listGrants() {
    return api('/api/grants');
  }

  function revokeGrant(id) {
    return api('/api/grants/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  function listNotices() {
    return api('/api/notices');
  }

  function markNoticesSeen() {
    return api('/api/notices/seen', { method: 'POST' });
  }

  function dismissNotice(id) {
    return api('/api/notices/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  function getSchedule(profileId) {
    return api('/api/schedule/' + encodeURIComponent(profileId));
  }

  /**
   * Push the account's own profile and courses to D1. The caller builds the
   * patch, because it is the page that knows how the local display settings map
   * onto the account's columns.
   */
  function syncPrefs(patch) {
    if (!isSignedIn()) return Promise.resolve({ ok: false, unauthorized: true });
    return updateProfile(patch);
  }

  window.HTAccount = {
    API: API,
    current: current,
    isSignedIn: isSignedIn,
    refresh: refresh,
    signInWithIdToken: signInWithIdToken,
    signOut: signOut,
    updateProfile: updateProfile,
    deleteAccount: deleteAccount,
    searchDirectory: searchDirectory,
    askForSchedule: askForSchedule,
    listRequests: listRequests,
    decideRequest: decideRequest,
    listGrants: listGrants,
    revokeGrant: revokeGrant,
    listNotices: listNotices,
    markNoticesSeen: markNoticesSeen,
    dismissNotice: dismissNotice,
    getSchedule: getSchedule,
    syncPrefs: syncPrefs,
    onAuthChange: onAuthChange,
  };
})();
