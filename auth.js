/**
 * Hilltoppers Auth for the settings page.
 *
 * Sign-in is the account students already have for Hilltoppers, which is a
 * Firebase Auth project using the email/password provider. This file is the
 * only place that talks to Firebase; everything else on the page talks to
 * HTAccount, which talks to our Worker.
 *
 * Two things worth knowing before changing this:
 *
 * - The Firebase SDK is loaded from a CDN at run time, with a dynamic import,
 *   rather than a <script> tag. A static tag cannot be intercepted in tests, so
 *   a CDN that is slow, blocked, or moved would take the whole page down with no
 *   way to prove otherwise. A dynamic import can be stubbed, and a failure is
 *   catchable, so the page still renders and can say sign-in is unavailable.
 *
 * - The config below is not a secret. A Firebase web config is designed to be
 *   public: it names the project, it does not authorize anything. The security
 *   boundary is the ID token, which only Google can sign, and our Worker
 *   verifies it. The apiKey is restricted by Firebase to this project's own
 *   endpoints.
 */
(function () {
  'use strict';

  var VERSION = '12.1.0';
  var MODULES = [
    'https://www.gstatic.com/firebasejs/' + VERSION + '/firebase-app.js',
    'https://www.gstatic.com/firebasejs/' + VERSION + '/firebase-auth.js',
  ];

  // The :web: appId. The project's iOS plist carries a different :ios: appId,
  // and signing in with that one against the web SDK fails.
  var CONFIG = {
    apiKey: 'AIzaSyCPDKZHahJOA2WIJaOaYDYDcxFNAW2oUK0',
    authDomain: 'schedule-59d28.firebaseapp.com',
    projectId: 'schedule-59d28',
    storageBucket: 'schedule-59d28.firebasestorage.app',
    messagingSenderId: '11216800424',
    appId: '1:11216800424:web:6b56559c636eb27432509d',
  };

  // Hilltoppers' own mail worker. It sends the reset and verification mail,
  // because they deliberately do not use Firebase's default delivery. It sets
  // Access-Control-Allow-Origin, so the browser can call it directly and no
  // secret of ours is involved.
  var MAIL = 'https://hilltoppers-account-email.danielzhang089.workers.dev/api/account-email';

  var sdk = null;

  /** Load the SDK once. Concurrent callers share the same in-flight promise. */
  function load() {
    if (sdk) return sdk;
    sdk = (async function () {
      var mods = await Promise.all(MODULES.map(function (url) { return import(url); }));
      var app = mods[0];
      var auth = mods[1];
      var instance = app.getApps().length ? app.getApp() : app.initializeApp(CONFIG);
      return { app: app, auth: auth, instance: instance };
    })().catch(function (error) {
      sdk = null; // A failed load must not be cached as success.
      throw error;
    });
    return sdk;
  }

  async function firebaseAuth() {
    return (await load()).auth.getAuth((await load()).instance);
  }

  /** The signed-in Firebase user, or null. Does not wait for the network. */
  async function currentUser() {
    var auth = await firebaseAuth();
    return auth.currentUser || null;
  }

  /**
   * Sign in with email and password. The ID token is what our Worker accepts,
   * so it is fetched fresh here rather than cached.
   *
   * There is deliberately no create-account or Firebase-mailed-reset call here.
   * Hilltoppers owns the account: it sets accounts up and sends its own mail
   * through its mail worker, which the code step below uses.
   */
  async function signIn(email, password) {
    var loaded = await load();
    var auth = loaded.auth.getAuth(loaded.instance);
    var credential = await loaded.auth.signInWithEmailAndPassword(auth, email, password);
    return credential.user;
  }

  /** A fresh ID token for the current user, or null when signed out. */
  async function idToken(forceRefresh) {
    var user = await currentUser();
    if (!user) return null;
    return user.getIdToken(Boolean(forceRefresh));
  }

  async function signOut() {
    var loaded = await load();
    await loaded.auth.signOut(loaded.auth.getAuth(loaded.instance));
  }

  /** Re-read the account, so a verification that happened in another tab shows. */
  async function reload() {
    var user = await currentUser();
    if (!user) return null;
    await user.reload();
    return user;
  }

  /**
   * Ask Hilltoppers' mail worker for a six-digit code that proves control of the
   * address. Returns the challenge id the code is redeemed against.
   *
   * The token is sent because the worker verifies it; for a reset it is optional,
   * and for a verification it is required.
   */
  async function requestCode(purpose, email) {
    var headers = { 'Content-Type': 'application/json' };
    var token = await idToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    var response = await fetch(MAIL + '/send', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(purpose === 'verify' ? { purpose: purpose } : { purpose: purpose, email: email }),
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || 'Could not send the email.');
    return data.challengeId;
  }

  /** Trade a six-digit code for the Firebase action code it stands for. */
  async function redeemCode(challengeId, code) {
    var headers = { 'Content-Type': 'application/json' };
    var token = await idToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    var response = await fetch(MAIL + '/redeem', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ challengeId: challengeId, code: code }),
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || 'That code was not accepted.');
    return data.actionCode;
  }

  /** Apply a reset action code and set the new password. */
  async function completeReset(actionCode, newPassword) {
    var loaded = await load();
    await loaded.auth.confirmPasswordReset(loaded.auth.getAuth(loaded.instance), actionCode, newPassword);
  }

  /** Apply a verification action code. */
  async function completeVerification(actionCode) {
    var loaded = await load();
    await loaded.auth.applyActionCode(loaded.auth.getAuth(loaded.instance), actionCode);
  }

  window.HTAuth = {
    CONFIG: CONFIG,
    currentUser: currentUser,
    signIn: signIn,
    idToken: idToken,
    signOut: signOut,
    reload: reload,
    requestCode: requestCode,
    redeemCode: redeemCode,
    completeReset: completeReset,
    completeVerification: completeVerification,
  };
})();
