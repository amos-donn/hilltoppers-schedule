/**
 * The one description of a notice.
 *
 * Two surfaces show the same rows: the Notices tab on the settings page, and
 * the bell on the card. Their markup has to differ -- a 268px popup and a
 * full-width tab are different rooms -- but what a row says, which rows exist
 * and in what order were written twice, and drifted: the bell could list a kind
 * the tab dropped, and only one of them offered the undo. Those decisions live
 * here, and each surface only draws what this hands it.
 *
 * No build step: this is a plain script that puts one object on window, loaded
 * before schedule-card.js on the card and before the settings page's inline
 * script.
 */
(function () {
  'use strict';

  /**
   * Each kind, said twice: with the person when we know them, and on its own
   * when we do not. Membership is also the filter -- a row written by an older
   * build, or by a newer Worker, is not something either surface can say in a
   * sentence, so it never reaches a list.
   */
  var TEXT = {
    'access.revoked': { with: '%s revoked your access.', alone: 'Your access was revoked.' },
    'access.granted': { with: '%s can now see your schedule.', alone: 'Someone can now see your schedule.' },
    'access.restore': {
      with: '%s had your schedule from auto-grant. Restore it?',
      alone: 'Access shared by auto-grant was revoked. Restore it?'
    },
    'request.received': { with: '%s asked for your schedule.', alone: 'Someone asked for your schedule.' },
    'request.accepted': { with: '%s accepted your request for their schedule.', alone: 'Someone accepted your request for a schedule.' },
    'request.declined': { with: '%s declined your request for their schedule.', alone: 'Someone declined your request for a schedule.' }
  };

  /** The person a notice is about, when we know them. */
  function who(notice) {
    return notice.actorName
      || (notice.payload && notice.payload.displayName)
      || notice.actorProfileId
      || (notice.payload && notice.payload.profileId)
      || '';
  }

  /** True for the kinds this app can say in a sentence. */
  function known(kind) {
    return Object.prototype.hasOwnProperty.call(TEXT, kind);
  }

  /** What a row says. Empty for a kind nothing can render. */
  function text(notice) {
    var pattern = TEXT[notice.kind];
    if (!pattern) return '';
    var name = who(notice);
    return name ? pattern.with.replace('%s', name) : pattern.alone;
  }

  /** Only the rows a surface can render, newest first preserved by the caller. */
  function renderable(notices) {
    return (notices || []).filter(function (notice) { return known(notice.kind); });
  }

  /**
   * The request a request.* or access.restore notice points at. A notice names
   * the person by profile ID, and so does a request, so the pair is the match.
   */
  function requestFor(notice, requests) {
    var profileId = notice.actorProfileId || (notice.payload && notice.payload.profileId);
    if (!profileId) return null;
    var incoming = (requests && requests.incoming) || [];
    var outgoing = (requests && requests.outgoing) || [];
    return incoming.concat(outgoing).filter(function (request) {
      return request.profileId === profileId;
    })[0] || null;
  }

  /** Requests still waiting, whether on this student or on someone else. */
  function pending(requests) {
    var incoming = (requests && requests.incoming) || [];
    var outgoing = (requests && requests.outgoing) || [];
    return incoming.concat(outgoing).filter(function (request) {
      return request.status === 'pending';
    });
  }

  /**
   * The pill a row carries, if any. It follows the request behind it, so an ask
   * that has been answered stops saying Pending and says what it became.
   */
  function status(notice, requests) {
    var request = requestFor(notice, requests);
    if (!request) return null;
    if (request.status === 'pending') return { text: 'Pending', modifier: 'pending' };
    if (request.status === 'accepted') return { text: 'Granted', modifier: 'granted' };
    if (request.status === 'declined') return { text: 'Declined', modifier: 'declined' };
    return null;
  }

  /**
   * Notices and the requests this account sent share one list, newest first. A
   * sent request makes no notice for the sender, so without its own row it
   * would appear nowhere.
   */
  function entries(notices, requests) {
    var list = renderable(notices).map(function (notice) {
      return { at: notice.createdAt || 0, notice: notice };
    });
    ((requests && requests.outgoing) || []).forEach(function (request) {
      if (request.status !== 'pending') return;
      list.push({ at: request.createdAt || 0, outgoing: request });
    });
    list.sort(function (a, b) { return b.at - a.at; });
    return list;
  }

  /**
   * Unread notices. One measure only: a request waiting on someone else is not
   * something to read, so it never marks a surface as having something new.
   */
  function unread(notices) {
    return renderable(notices).filter(function (notice) { return !notice.seen; }).length;
  }

  window.HTNotices = {
    TEXT: TEXT,
    known: known,
    who: who,
    text: text,
    renderable: renderable,
    requestFor: requestFor,
    pending: pending,
    status: status,
    entries: entries,
    unread: unread
  };
})();
