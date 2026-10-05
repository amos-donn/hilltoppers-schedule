/**
 * First-run onboarding tour for the settings page.
 *
 * The whole thing is one dimming layer with a hole cut around whatever the
 * current step points at, plus a small card anchored to the edge of that hole.
 * No dependencies and no build step, like the rest of this site.
 *
 * Two rules shape the implementation:
 *
 *   - A step never gets in the way. Every step names a target by id, and a
 *     target that is missing or hidden (an account section while signed out,
 *     say) makes that step disappear rather than point at nothing. A student
 *     who signs out mid-tour should not get a card about a friends list they
 *     cannot see.
 *   - It is remembered, but it can be replayed. The first run is stored in
 *     localStorage so it never nags, and Account carries a button to bring it
 *     back, because the tour is also how someone finds that button.
 */
(function () {
  'use strict';

  var SEEN_KEY = 'settingsTourSeen';
  // Bumped when the steps change materially, so an edited tour plays once
  // more for people who already finished the old one.
  var TOUR_VERSION = 1;

  /**
   * The steps, in order. `tab` is switched to before the step is measured, so
   * a step can point into a panel that is currently hidden.
   */
  var STEPS = [
    {
      id: 'welcome',
      title: 'Welcome',
      // No step count here: it varies with what is on the page, and a number
      // that is wrong on the first screen is worse than none.
      body: 'This tour takes about a minute and points out each section in turn. You can stop at any time.',
      placement: 'center'
    },
    {
      id: 'profile-id',
      tab: 'account',
      target: 'profile-id',
      signedInOnly: true,
      title: 'Your profile ID',
      body: 'This is how other students reach you. Give it to anyone, or search for theirs. It is not your email, so it is safe to hand out.',
      placement: 'bottom'
    },
    {
      id: 'visibility',
      tab: 'account',
      target: 'visibility',
      signedInOnly: true,
      title: 'Who can find you',
      body: 'Public means anyone can search your name and find your ID. Private means only people you give your ID to can reach you. Either way you stay in charge.',
      placement: 'top'
    },
    {
      id: 'auto-grant',
      tab: 'account',
      target: 'auto-grant',
      signedInOnly: true,
      title: 'Requests wait for you',
      body: 'When someone asks for your schedule it lands here as a request. Approving one by one is the default. Turning this on approves them straight away, and it only applies while your profile is public.',
      placement: 'top'
    },
    {
      id: 'friends-tab',
      tab: 'friends',
      target: 'tab-friends-btn',
      title: 'Friends',
      body: 'Everyone you can see the schedule of lives here, in the order they show on the card. Drag the grip to reorder.',
      placement: 'right'
    },
    {
      id: 'add-friend',
      tab: 'friends',
      target: 'directory-search',
      title: 'Adding someone',
      body: 'Search public profiles by name, or paste a profile ID someone gave you. Ask for their schedule, then add them once they accept.',
      placement: 'top'
    },
    {
      id: 'requests',
      tab: 'friends',
      target: 'requests-panel',
      signedInOnly: true,
      title: 'Requests, and access',
      body: 'People waiting on you are listed here, and anyone who can see your schedule is under "Who can see your schedule". Revoking one takes their access away immediately and tells them.',
      placement: 'top'
    },
    {
      id: 'notices',
      tab: 'notices',
      target: 'notices-panel',
      signedInOnly: true,
      title: 'Notices',
      body: 'Anything that changes your access shows up here: someone asking, someone accepting, someone being revoked. Open one to act on it.',
      placement: 'top'
    },
    {
      id: 'social-web',
      tab: 'social-web',
      target: 'social-web-canvas',
      signedInOnly: true,
      title: 'The Social web',
      body: 'Your school, connected. An arrow runs from the person sharing their schedule to the person who can see it. Connected circles gather together. Public profiles show a name; private ones show Anonymous.',
      placement: 'top'
    },
    {
      id: 'done',
      title: 'That is everything',
      body: 'You can reopen this tour any time from Account. Nothing here is required -- the app works whether or not you ever add a friend.',
      placement: 'center'
    }
  ];

  var CARD_ID = 'tour';
  var current = 0;
  var running = false;
  var activeSteps = [];
  var lastFocus = null;
  var built = false;
  var els = {};

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === String(TOUR_VERSION); }
    catch (e) { return false; }
  }

  function remember() {
    try { localStorage.setItem(SEEN_KEY, String(TOUR_VERSION)); } catch (e) { /* private mode */ }
  }

  function forget() {
    try { localStorage.removeItem(SEEN_KEY); } catch (e) { /* private mode */ }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  /**
   * Build the overlay once and keep it. Re-creating it per run would lose the
   * open/close animation and re-run the ARIA wiring on every replay.
   */
  function build() {
    if (built) return;
    var root = el('div', 'tour');
    root.id = CARD_ID;
    root.hidden = true;
    // The welcome and closing cards have nothing to point at, so those steps
    // dim the whole page instead of cutting a hole.
    var centered = el('div', 'tour__scrim-full');
    centered.hidden = true;
    centered.addEventListener('click', function () { stop(); });
    root.appendChild(centered);

    // Catches clicks on the dimmed page so a stray click cannot reach the
    // thing the tour is pointing at.
    var scrim = el('div', 'tour__scrim');
    scrim.addEventListener('click', function () { stop(); });
    root.appendChild(scrim);

    // The hole. Its box-shadow is what dims the rest of the page, so it does
    // not need to know anything about the viewport.
    var hole = el('div', 'tour__hole');
    hole.setAttribute('aria-hidden', 'true');
    root.appendChild(hole);

    var card = el('div', 'tour__card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tour-title');
    card.setAttribute('aria-describedby', 'tour-body');

    var head = el('div', 'tour__head');
    var step = el('p', 'tour__count', '1 of 1');
    step.id = 'tour-count';
    head.appendChild(step);
    card.appendChild(head);

    var title = el('h2', 'tour__title', '');
    title.id = 'tour-title';
    card.appendChild(title);

    var body = el('p', 'tour__body', '');
    body.id = 'tour-body';
    card.appendChild(body);

    var foot = el('div', 'tour__foot');

    var skip = el('button', 'tour__skip', 'Skip tour');
    skip.type = 'button';
    skip.id = 'tour-skip';
    skip.addEventListener('click', function () { stop(); });
    foot.appendChild(skip);

    var nav = el('div', 'tour__nav');

    var back = el('button', 'tour__back', 'Back');
    back.type = 'button';
    back.id = 'tour-back';
    back.addEventListener('click', function () { go(current - 1); });
    nav.appendChild(back);

    var next = el('button', 'tour__next', 'Next');
    next.type = 'button';
    next.id = 'tour-next';
    next.addEventListener('click', function () {
      if (current >= activeSteps.length - 1) stop(true);
      else go(current + 1);
    });
    nav.appendChild(next);

    foot.appendChild(nav);
    card.appendChild(foot);

    root.appendChild(card);
    document.body.appendChild(root);

    els = {
      root: root, hole: hole, card: card, count: step, title: title, body: body,
      back: back, next: next, skip: skip, centered: centered,
    };

    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', position);

    built = true;
  }

  /**
   * Keyboard handling. Escape leaves the tour rather than stepping backwards,
   * because a tour the visitor cannot leave with the keyboard is a trap, and
   * Tab is kept inside the card so the dimmed page cannot be tabbed into.
   */
  function onKeydown(event) {
    if (!running) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stop();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (current < activeSteps.length - 1) go(current + 1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (current > 0) go(current - 1);
      return;
    }
    if (event.key !== 'Tab') return;

    // Only two focusable things: the three buttons. Keep Tab cycling among
    // whichever of them are currently shown.
    var focusable = [els.back, els.next, els.skip].filter(function (node) {
      return isShown(node, null);
    });
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * A target is usable if it exists and nothing above it hides it.
   *
   * Two kinds of hidden ancestor must not disqualify a step:
   *
   *   - The panel the step's own `tab` switches to. The tour clicks that tab
   *     before measuring, so the panel is open by the time anyone sees it.
   *   - A container marked `data-tour-defer`, which means "this fills in later,
   *     do not treat it as missing". The Social web canvas is one: it stays
   *     hidden until the graph has loaded, which has nothing to do with whether
   *     the step exists.
   */
  function isShown(node, tabPanel) {
    if (!node) return false;
    for (var cur = node; cur && cur !== document.body; cur = cur.parentElement) {
      if (cur === tabPanel) return true;
      if (cur.hasAttribute && cur.hasAttribute('data-tour-defer')) return true;
      if (cur.hidden) return false;
    }
    return true;
  }

  /** The panel a step's tab shows, used to stop the walk at the right place. */
  function tabPanelFor(step) {
    return step.tab ? document.getElementById('panel-' + step.tab) : null;
  }

  /**
   * Switch to a step's tab, then measure it. A panel that is hidden by the tab
   * switch has no usable geometry, so the switch has to happen first.
   */
  function showTabFor(step) {
    if (!step.tab) return;
    var button = document.getElementById('tab-' + step.tab + '-btn');
    if (button && button.getAttribute('aria-selected') !== 'true') button.click();
  }

  /** Steps whose target is actually on the page, in order. */
  function resolveSteps() {
    return STEPS.filter(function (step) {
      if (step.placement === 'center' || !step.target) return true;
      // Signed-in-only sections disappear for a signed-out visitor.
      if (step.signedInOnly && document.getElementById('account-signed-in').hidden) return false;
      return isShown(document.getElementById(step.target), tabPanelFor(step));
    });
  }

  function place(hole, card, step, rect) {
    // Padding so the highlight frames the thing instead of cropping it.
    var pad = 10;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var gap = 18;
    var left = Math.max(0, rect.left - pad);
    var top = Math.max(0, rect.top - pad);
    var width = Math.min(vw - left, rect.width + pad * 2);
    var height = Math.min(vh - top, rect.height + pad * 2);

    hole.style.left = left + 'px';
    hole.style.top = top + 'px';
    hole.style.width = width + 'px';
    hole.style.height = height + 'px';
    hole.hidden = false;

    // Measure the card before placing it, because the placement depends on its
    // own size. A card wider than the viewport would otherwise push itself
    // off-screen.
    card.style.maxWidth = Math.max(240, Math.min(340, vw - 32)) + 'px';
    card.style.left = '0px';
    card.style.top = '0px';
    card.style.right = 'auto';
    card.style.bottom = 'auto';

    var cw = card.offsetWidth || 300;
    var ch = card.offsetHeight || 180;

    els.centered.hidden = step.placement !== 'center';

    if (step.placement === 'center') {
      hole.hidden = true;
      card.classList.add('tour__card--center');
      card.style.left = Math.round((vw - cw) / 2) + 'px';
      card.style.top = Math.round((vh - ch) / 2) + 'px';
      return;
    }

    card.classList.remove('tour__card--center');

    // Preferred side first, then the opposite one, then whichever side has the
    // most room. Placing off the far edge of a highlighted element is how a
    // tooltip ends up half off-screen.
    var options = step.placement === 'right'
      ? ['right', 'left', 'bottom', 'top']
      : step.placement === 'left'
        ? ['left', 'right', 'bottom', 'top']
        : step.placement === 'top'
          ? ['top', 'bottom', 'right', 'left']
          : ['bottom', 'top', 'right', 'left'];

    for (var i = 0; i < options.length; i++) {
      var side = options[i];
      var x = null;
      var y = null;
      if (side === 'right') { x = left + width + gap; y = top + height / 2 - ch / 2; }
      else if (side === 'left') { x = left - gap - cw; y = top + height / 2 - ch / 2; }
      else if (side === 'top') { x = left + width / 2 - cw / 2; y = top - gap - ch; }
      else { x = left + width / 2 - cw / 2; y = top + height + gap; }

      if (x >= 8 && x + cw <= vw - 8 && y >= 8 && y + ch <= vh - 8) break;
      // Nothing fit; keep the last candidate and clamp it below.
      x = Math.max(8, Math.min(x, vw - cw - 8));
      y = Math.max(8, Math.min(y, vh - ch - 8));
    }

    card.style.left = Math.round(Math.max(8, Math.min(x, vw - cw - 8))) + 'px';
    card.style.top = Math.round(Math.max(8, Math.min(y, vh - ch - 8))) + 'px';
  }

  function position() {
    if (!running) return;
    var step = activeSteps[current];
    if (!step) return;
    showTabFor(step);
    var target = step.target ? document.getElementById(step.target) : null;
    // scrollIntoView is a no-op in jsdom and can be absent on older engines, so
    // a step must not depend on it existing.
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
    var rect = target ? target.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    place(els.hole, els.card, step, rect);
  }

  function render() {
    var step = activeSteps[current];
    if (!step) return stop();

    els.count.textContent = 'Step ' + (current + 1) + ' of ' + activeSteps.length;
    els.title.textContent = step.title;
    els.body.textContent = step.body;
    // The last step's button is the one the tour ends on, so it is labelled
    // for what it does rather than what comes next.
    els.next.textContent = current >= activeSteps.length - 1 ? 'Done with tour' : 'Next';
    els.back.hidden = current === 0;
    position();
  }

  function go(index) {
    if (!activeSteps.length) return;
    current = Math.max(0, Math.min(index, activeSteps.length - 1));
    render();
  }

  /** Show the tour. `completed` marks it as done for next time. */
  function start() {
    build();
    activeSteps = resolveSteps();
    if (!activeSteps.length) return;

    if (!running) lastFocus = document.activeElement;
    running = true;
    current = 0;
    els.root.hidden = false;
    els.root.classList.add('tour--on');
    document.documentElement.classList.add('tour-open');
    render();
    // The card itself takes focus so the arrow keys work immediately, rather
    // than making the visitor click Next first.
    els.next.focus();
  }

  /** Hide the tour. Only a completed run is remembered. */
  function stop(completed) {
    if (!running) return;
    running = false;
    if (els.root) {
      els.root.classList.remove('tour--on');
      els.root.hidden = true;
      els.hole.hidden = true;
      els.centered.hidden = true;
    }
    document.documentElement.classList.remove('tour-open');
    if (completed) remember();
    // Hand focus back so a keyboard user is not dropped at the top of the page.
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  /** Forget that the tour was seen, so the next load plays it again. */
  function replay() {
    forget();
    start();
  }

  /** Start on the first run only. Safe to call more than once. */
  function autoStart() {
    if (seen() || running) return;
    start();
  }

  // The Replay button lives in the Account panel. It is wired here rather than
  // in the page script so the tour stays self-contained.
  function wireReplay() {
    var button = document.getElementById('tour-replay');
    if (!button) return;
    button.addEventListener('click', function () { start(); });
  }

  function boot() {
    wireReplay();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.HTTour = {
    start: start,
    stop: stop,
    replay: replay,
    autoStart: autoStart,
    isRunning: function () { return running; },
    steps: function () { return STEPS; }
  };
})();
