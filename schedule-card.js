/*
 * Renders the schedule card. The markup and class names mirror the extension's
 * popup schedule section so the extension's popup.css styles it identically;
 * this file is the vanilla-JS equivalent of Popup.tsx's schedule logic.
 *
 * Two shapes share this renderer:
 *
 * - The primary card is your own day. Collapsed it is just the status card:
 *   the block you are in (period badge, course, time range) and how long is
 *   left. Tapping anywhere on it expands the whole day as an accordion.
 * - The friends list below is one card per friend, each with their name and
 *   what they are in right now. Tapping a friend expands their whole day the
 *   same way, as an accordion of its own.
 *
 * Both are built from the same block list, so `renderBlock()` is shared and the
 * owner (self or a friend) supplies the display preferences.
 */
(function () {
  'use strict';

  var H = window.HT;

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k === 'html') node.innerHTML = props[k];
        else if (k === 'style') Object.assign(node.style, props[k]);
        else if (props[k] !== null && props[k] !== undefined) node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  // Collapse animation matching the extension's AnimatedCollapse: the wrapper is
  // driven to the content's measured height so nested blocks settle together.
  function animatedCollapse(isOpen, children) {
    var inner = el('div', { class: 'module-collapse-inner' }, children);
    var outer = el('div', { class: 'module-collapse' + (isOpen ? ' is-open' : '') }, [inner]);
    if (isOpen) outer.setAttribute('aria-hidden', 'false');
    function resize() {
      var height = isOpen ? inner.getBoundingClientRect().height : 0;
      outer.getBoundingClientRect();
      outer.style.height = height + 'px';
    }
    resize();
    if (typeof ResizeObserver !== 'undefined') {
      var observer = new ResizeObserver(resize);
      observer.observe(inner);
    }
    return outer;
  }

  // Icons are Phosphor (Regular weight) -- the set the extension's sidebar
  // uses -- inlined as paths so the card keeps working with no build step.
  var CARET_DOWN_PATH = 'M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z';

  var GEAR_SVG = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 256 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"/></svg>';

  var CALENDAR_SVG = '<svg class="toggle-title-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">' +
    '<path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Z"/></svg>';

  // The accordion affordance, shared by the primary card and each friend card.
  var CHEVRON_SVG = '<svg class="accordion-chevron" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">' +
    '<path d="' + CARET_DOWN_PATH + '"/></svg>';

  function mount(root, opts) {
    opts = opts || {};
    var state = {
      schedule: opts.schedule || { dateKey: '', blocks: [], dayType: null, details: null },
      friends: opts.friends || [],
      // Your own schedule as a friend-shaped record: name, grade, lunchWave,
      // timeFormat and blockPrefs. Absent when there is nothing to show for you,
      // in which case the primary card falls back to the selected friend.
      self: opts.self || null,
      selectedFriend: opts.selectedFriend || '',
      now: opts.now || new Date(),
      scheduleExpanded: Boolean(opts.scheduleExpanded),
      expandedBlockId: null,
      expandedFriends: {}
    };
    // Drawn on the empty state only, so an embedded card with no reachable
    // account can offer sign-in instead of looking broken.
    var emptyActionHtml = opts.emptyActionHtml || null;
    var onEmptyAction = opts.onEmptyAction || null;
    var onOpenSettings = opts.onOpenSettings || null;
    var baseDate = state.schedule.dateKey ? H.parseDateKey(state.schedule.dateKey) : H.parseDateKey(H.todayKey());

    // The live elements a clock tick writes to without a full render: the
    // countdown texts and the progress fills. `boundary` is the earliest time
    // any of them runs out, which is when the card is due a real transition.
    var live = { items: [], boundary: Infinity };

    function trackCountdown(node, targetMs) {
      live.items.push({ kind: 'countdown', node: node, targetMs: targetMs });
      if (targetMs < live.boundary) live.boundary = targetMs;
    }
    function trackProgress(fill, startMs, endMs) {
      live.items.push({ kind: 'progress', fill: fill, startMs: startMs, endMs: endMs });
      if (endMs < live.boundary) live.boundary = endMs;
    }

    function ownerBlocks(owner) {
      return H.gradeFilteredBlocks(state.schedule.blocks, owner ? owner.grade : null);
    }
    function friendLabel(friend) {
      return friend.name ? friend.name + ' (' + friend.email + ')' : friend.email;
    }
    // The person the primary card belongs to: you, or the selected friend when
    // your own schedule is not available.
    function primaryOwner() {
      if (state.self) return state.self;
      var list = state.friends || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].email === state.selectedFriend) return list[i];
      }
      return list.length > 0 ? list[0] : null;
    }

    // The gear lives inside the status card (top-right) rather than above it.
    function settingsButton() {
      var wrapper = el('div', { class: 'settings-button-wrapper' }, [
        el('button', { class: 'settings-button', type: 'button', 'aria-label': 'Open settings', html: GEAR_SVG }),
        el('span', { class: 'hover-float-label settings-float-label', text: 'Settings' })
      ]);
      wrapper.querySelector('button').addEventListener('click', function () {
        if (onOpenSettings) onOpenSettings();
      });
      return wrapper;
    }

    function friendGapLabel(friend) {
      if (ownerBlocks(friend).length === 0) {
        return state.schedule.networkFailed === true ? 'No connection' : 'No school today';
      }
      return 'Between classes';
    }

    // The interval the progress bar measures, mirroring computeProgressBar: the
    // current block's own span, or the break before the next one. Before the
    // first block there is no break to measure and the bar sits full, so that
    // case carries a fixed percent rather than a span.
    function progressSpan(blocks, currentBlock, nextBlock) {
      if (currentBlock) {
        return { startMs: H.parseBlockTime(currentBlock.start, baseDate).getTime(), endMs: H.parseBlockTime(currentBlock.end, baseDate).getTime() };
      }
      var index = blocks.map(function (b) { return b.id; }).indexOf(nextBlock.id);
      var prev = index > 0 ? blocks[index - 1] : null;
      if (prev) {
        return { startMs: H.parseBlockTime(prev.end, baseDate).getTime(), endMs: H.parseBlockTime(nextBlock.start, baseDate).getTime() };
      }
      return { fixed: 1 };
    }

    function lunchCountdown(owner, currentBlock) {
      if (!currentBlock || owner.lunchWave == null) return null;
      var mine = (currentBlock.subBlocks || []).filter(function (sub) {
        return H.lunchWaveFromName(sub.name) === owner.lunchWave;
      })[0];
      if (!mine) return null;
      var start = H.parseBlockTime(mine.start, baseDate);
      var end = H.parseBlockTime(mine.end, baseDate);
      if (state.now < start) return mine.name + ' in ' + H.formatCountdown(start.getTime() - state.now.getTime());
      if (state.now < end) return mine.name + ' ends in ' + H.formatCountdown(end.getTime() - state.now.getTime());
      return null;
    }

    // One block row, expandable when the block has sub-blocks (lunch waves).
    function renderBlock(owner, block, status) {
      var start = H.parseBlockTime(block.start, baseDate);
      var end = H.parseBlockTime(block.end, baseDate);
      var isCurrent = status.currentBlock && status.currentBlock.id === block.id;
      var isNext = !status.currentBlock && status.nextBlock && status.nextBlock.id === block.id;
      var display = H.resolveBlockDisplay(block.name, state.schedule.dayType, owner.blockPrefs);
      var classes = [];
      if (isCurrent) classes.push('current-block');
      else if (isNext) classes.push('upcoming-block');
      if (display.isFree) classes.push('free-block');
      if (display.emphasizeUnknown) classes.push('unknown-block');
      if (display.useGrayText) classes.push('muted-block');

      var subBlocks = Array.isArray(block.subBlocks) ? block.subBlocks : [];
      var hasSubBlocks = subBlocks.length > 0;
      var isExpanded = state.expandedBlockId === block.id;

      var blockRight = el('div', { class: 'block-right' }, [
        el('span', { class: 'block-time', text: H.toDisplayTime(start, owner.timeFormat) + ' \u2013 ' + H.toDisplayTime(end, owner.timeFormat) })
      ]);
      if (hasSubBlocks) {
        blockRight.appendChild(el('span', { class: 'subblock-inline-toggle', 'aria-hidden': 'true' }, [
          el('span', { class: 'chevron' + (isExpanded ? ' open' : '') })
        ]));
      }

      var row = el('div', { class: 'block-row' + (hasSubBlocks ? ' expandable' : '') }, [
        el('span', { class: 'block-name', text: display.label }),
        blockRight
      ]);
      if (hasSubBlocks) {
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-expanded', String(isExpanded));
        var toggle = function () {
          state.expandedBlockId = state.expandedBlockId === block.id ? null : block.id;
          render();
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
        });
      }

      var children = [row];
      if (hasSubBlocks) {
        var items = subBlocks.map(function (sub) {
          var isMyLunch = owner.lunchWave != null && H.lunchWaveFromName(sub.name) === owner.lunchWave;
          return el('li', { class: isMyLunch ? 'my-lunch' : undefined }, [
            el('span', { class: 'subblock-name', text: sub.name }),
            el('span', { class: 'subblock-time', text: H.toDisplayTime(H.parseBlockTime(sub.start, baseDate), owner.timeFormat) + ' \u2013 ' + H.toDisplayTime(H.parseBlockTime(sub.end, baseDate), owner.timeFormat) })
          ]);
        });
        children.push(animatedCollapse(isExpanded, [el('ul', { class: 'subblock-list' }, items)]));
      }
      return el('li', { class: classes.join(' ') || undefined }, children);
    }

    // The full day as an accordion. Used by the primary card and by each friend
    // card, so both open the same way. When no toggle button is asked for, the
    // caller owns the whole-card tap and the bare list just follows the state.
    function scheduleAccordion(owner, status, expanded, onToggle, note, bare) {
      var filtered = ownerBlocks(owner);
      if (filtered.length === 0) return null;

      var inner = [el('ul', null, filtered.map(function (block) { return renderBlock(owner, block, status); }))];
      var heading = null;

      if (!bare) {
        var toggle = el('button', { type: 'button', class: 'schedule-toggle', 'aria-expanded': String(expanded) }, [
          el('span', { class: 'toggle-title', html: CALENDAR_SVG + '<span>Schedule</span>' })
        ]);
        if (note) toggle.appendChild(el('span', { class: 'toggle-note', text: note }));
        toggle.appendChild(el('span', { class: 'chevron' + (expanded ? ' open' : '') }));
        toggle.addEventListener('click', onToggle);
        heading = el('div', { class: 'schedule-heading' }, [toggle]);
      }

      return el('section', { class: 'schedule-list' + (expanded ? '' : ' collapsed') }, [
        heading,
        animatedCollapse(expanded, inner)
      ]);
    }

    // The big number in the primary card: the block you are in, or the one that
    // starts next. Also tracks the countdown the clock tick drives.
    function statusBody(owner, status) {
      var currentBlock = status.currentBlock;
      var nextBlock = status.nextBlock;
      var filtered = ownerBlocks(owner);
      var dayType = state.schedule.dayType;
      var isNoSchool = filtered.length === 0 &&
        ((state.schedule.details || false) || (dayType ? dayType.toLowerCase().indexOf('no school') >= 0 : false));
      var isNetworkFailed = state.schedule.networkFailed === true && filtered.length === 0;

      if (currentBlock) {
        var display = H.resolveBlockDisplay(currentBlock.name, state.schedule.dayType, owner.blockPrefs);
        var value = el('span', { class: 'time-value', text: H.formatCountdown(status.remainingMs) });
        trackCountdown(value, H.parseBlockTime(currentBlock.end, baseDate).getTime());
        return el('div', { class: 'status-current' }, [
          el('div', { class: 'current-details' }, [
            el('p', { class: 'current-name', text: display.label }),
            el('p', { class: 'current-period', text: H.toDisplayTime(H.parseBlockTime(currentBlock.start, baseDate), owner.timeFormat) + ' \u2013 ' + H.toDisplayTime(H.parseBlockTime(currentBlock.end, baseDate), owner.timeFormat) })
          ]),
          el('span', { class: 'time-remaining' }, [el('span', { class: 'time-label', text: 'ends in' }), value])
        ]);
      }
      if (nextBlock) {
        var nextDisplay = H.resolveBlockDisplay(nextBlock.name, state.schedule.dayType, owner.blockPrefs);
        var nextValue = el('span', { class: 'time-value', text: H.formatCountdown(status.nextStartsInMs) });
        trackCountdown(nextValue, H.parseBlockTime(nextBlock.start, baseDate).getTime());
        return el('div', { class: 'status-current upcoming-status' }, [
          el('div', { class: 'current-details' }, [
            el('span', { class: 'next-label', text: 'Next up' }),
            el('p', { class: 'current-name', text: nextDisplay.label }),
            el('p', { class: 'current-period', text: H.toDisplayTime(H.parseBlockTime(nextBlock.start, baseDate), owner.timeFormat) + ' \u2013 ' + H.toDisplayTime(H.parseBlockTime(nextBlock.end, baseDate), owner.timeFormat) })
          ]),
          el('span', { class: 'time-remaining' }, [el('span', { class: 'time-label', text: 'starts in' }), nextValue])
        ]);
      }
      var h2, p;
      if (isNetworkFailed) { h2 = 'No internet connection'; p = 'Please check your internet.'; }
      else if (isNoSchool) { h2 = state.schedule.details || 'No school today'; p = 'Have a good day!'; }
      else { h2 = 'School ended'; p = 'Have a good day!'; }
      return el('div', { class: 'status-ended' }, [el('h2', { text: h2 }), el('p', { text: p })]);
    }

    // Your own day, collapsed to the live status card and expandable to the
    // whole timetable. The name row carries the block period and the gear.
    function renderPrimary(owner, headingText) {
      var filtered = ownerBlocks(owner);
      var status = H.computeStatus(filtered, baseDate, state.now);
      var progressBar = H.computeProgressBar(filtered, status.currentBlock, status.nextBlock, baseDate, state.now, owner.timeFormat);

      // The block the status below is about, named on the name row so the card
      // reads in one line instead of stacking a badge above the subject.
      var statusBlock = status.currentBlock || status.nextBlock;
      var blockKey = statusBlock ? H.getBlockKey(statusBlock.name) : '';

      var section = el('section', { class: 'status' }, [
        el('div', { class: 'status-heading-row' }, [
          el('p', { class: 'friend-heading', text: headingText }),
          blockKey ? el('span', { class: 'current-block-badge', text: blockKey + ' Block' }) : null
        ]),
        statusBody(owner, status)
      ]);

      // The lunch-wave countdown used to live on the "Schedule" button. The day
      // list now appears under a whole-card tap, so the note moves onto the
      // card body where it stays visible whether the day is open or folded.
      var note = lunchCountdown(owner, status.currentBlock);
      if (note) section.appendChild(el('p', { class: 'schedule-note', text: note }));

      if (progressBar) {
        var fill = el('div', { class: 'progress-bar-fill', style: { width: (progressBar.percent * 100) + '%' } });
        var span = progressSpan(filtered, status.currentBlock, status.nextBlock);
        if (span.fixed === undefined) trackProgress(fill, span.startMs, span.endMs);
        section.appendChild(el('div', { class: 'progress-bar-container' + (progressBar.isBreak ? ' progress-break' : '') }, [
          el('div', { class: 'progress-bar-labels' }, [el('span', { text: progressBar.startLabel }), el('span', { text: progressBar.endLabel })]),
          el('div', { class: 'progress-bar-track' }, [fill])
        ]));
      }

      // The card body carries the whole tap target: tapping anywhere on the
      // status area toggles the day either way, so the separate "Schedule"
      // button is gone. The gear is pulled out to sit beside the card rather
      // than inside the tap target, which keeps it reachable on its own (a
      // button inside a button is not) and stops it toggling the day. The
      // lunch-wave row is a tap target of its own and lives in the day list
      // below, out of this handler's reach.
      var card = el('div', { class: 'primary-card' }, [settingsButton(), section]);
      section.classList.add('is-tappable');
      section.setAttribute('role', 'button');
      section.setAttribute('tabindex', '0');
      section.setAttribute('aria-expanded', String(state.scheduleExpanded));
      function toggleDay() {
        state.scheduleExpanded = !state.scheduleExpanded;
        render();
      }
      section.addEventListener('click', function () { toggleDay(); });
      section.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleDay(); }
      });

      var accordion = scheduleAccordion(owner, status, state.scheduleExpanded, null, null, true);
      if (accordion) card.appendChild(accordion);
      return card;
    }

    // One card per friend: name plus what they are in right now, expanding to
    // their whole day.
    function renderFriends() {
      var list = state.friends || [];
      if (list.length === 0) return null;

      var cards = list.map(function (friend) {
        var filtered = ownerBlocks(friend);
        var status = H.computeStatus(filtered, baseDate, state.now);
        var expanded = state.expandedFriends[friend.email] === true;
        var isSelected = friend.email === state.selectedFriend;

        var identity = el('div', { class: 'friend-identity' }, [
          el('span', { class: 'friend-name', text: friend.name || friend.email })
        ]);
        if (friend.name) identity.appendChild(el('span', { class: 'friend-email', text: friend.email }));

        var nowLine;
        if (status.currentBlock) {
          var display = H.resolveBlockDisplay(status.currentBlock.name, state.schedule.dayType, friend.blockPrefs);
          var key = H.getBlockKey(status.currentBlock.name);
          var value = el('span', { class: 'friend-time', text: H.formatCountdown(status.remainingMs) });
          trackCountdown(value, H.parseBlockTime(status.currentBlock.end, baseDate).getTime());
          nowLine = el('div', { class: 'friend-status' + (display.isFree ? ' is-free' : '') }, [
            key ? el('span', { class: 'friend-block-badge', text: key + ' Block' }) : null,
            el('span', { class: 'friend-course', text: display.label }),
            value
          ]);
        } else {
          nowLine = el('div', { class: 'friend-status friend-status--none' }, [
            el('span', { text: friendGapLabel(friend) })
          ]);
        }

        var head = el('div', { class: 'friend-card-head' }, [
          identity,
          nowLine,
          el('span', { class: 'friend-card-chevron' + (expanded ? ' open' : ''), html: CHEVRON_SVG })
        ]);
        head.setAttribute('role', 'button');
        head.setAttribute('tabindex', '0');
        head.setAttribute('aria-expanded', String(expanded));
        head.setAttribute('aria-label', 'Show ' + friendLabel(friend) + "'s schedule");
        var toggle = function () {
          state.expandedFriends[friend.email] = !expanded;
          state.selectedFriend = friend.email;
          H.saveSelectedFriend(state.selectedFriend);
          render();
        };
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
        });

        var card = el('li', { class: 'friend-card' + (isSelected ? ' is-selected' : '') + (expanded ? ' is-open' : '') }, [head]);
        var accordion = scheduleAccordion(friend, status, expanded, function () {
          state.expandedFriends[friend.email] = !expanded;
          render();
        }, null);
        if (accordion) card.appendChild(accordion);
        return card;
      });

      return el('section', { class: 'friends-list' }, [
        el('p', { class: 'friends-heading', text: "Friends' Schedules" }),
        el('ul', { class: 'friend-cards' }, cards)
      ]);
    }

    function renderEmpty() {
      var action = null;
      if (emptyActionHtml) {
        var html = typeof emptyActionHtml === 'function' ? emptyActionHtml() : emptyActionHtml;
        if (html) {
          action = el('div', { class: 'empty-action', html: html });
          if (onEmptyAction) {
            action.addEventListener('click', function (event) {
              if (event.target.closest('button')) onEmptyAction();
            });
          }
        }
      }
      return el('main', { class: 'popup' }, [
        el('section', { class: 'status' }, [
          el('div', { class: 'status-heading-row' }, [
            el('p', { class: 'friend-heading', text: 'No friends yet' }),
            settingsButton()
          ]),
          el('div', { class: 'status-ended' }, [
            el('h2', { text: 'Get a life.' }),
            el('p', { text: 'Open settings to add one.' })
          ]),
          action
        ])
      ]);
    }

    function render() {
      baseDate = state.schedule.dateKey ? H.parseDateKey(state.schedule.dateKey) : H.parseDateKey(H.todayKey());
      live.items = [];
      live.boundary = Infinity;
      root.innerHTML = '';

      var owner = primaryOwner();
      var friends = state.friends || [];
      if (!owner && friends.length === 0) {
        root.appendChild(renderEmpty());
        return;
      }

      var main = el('main', { class: 'popup' });

      if (state.schedule.networkFailed === true && H.gradeFilteredBlocks(state.schedule.blocks, null).length === 0 && !state.schedule.dayType) {
        main.className = 'popup no-network';
        main.appendChild(el('p', { text: 'No internet connection' }));
        root.appendChild(main);
        return;
      }

      if (owner) {
        var heading = state.self ? (state.self.name || 'Your Schedule') : friendLabel(owner);
        main.appendChild(renderPrimary(owner, heading));
      }
      var friendsSection = renderFriends();
      if (friendsSection) main.appendChild(friendsSection);

      root.appendChild(main);
    }

    // Advance the clock without rebuilding the card. Only the countdown texts
    // and the progress fills move between ticks. When anything runs out the card
    // is due a transition -- a block ends, or the next one starts -- and that is
    // a full render, which recomputes every status from scratch.
    function tick(now) {
      state.now = now || new Date();
      if (state.now.getTime() >= live.boundary) {
        render();
        return;
      }
      live.items.forEach(function (item) {
        if (item.kind === 'countdown') {
          item.node.textContent = H.formatCountdown(item.targetMs - state.now.getTime());
        } else {
          var total = item.endMs - item.startMs;
          var elapsed = state.now.getTime() - item.startMs;
          var percent = total > 0 ? Math.min(Math.max(elapsed / total, 0), 1) : 1;
          item.fill.style.width = (percent * 100) + '%';
        }
      });
    }

    render();

    return {
      render: render,
      update: function (patch) {
        Object.assign(state, patch || {});
        render();
      },
      tick: tick,
      getState: function () { return state; }
    };
  }

  window.ScheduleCard = { mount: mount };
})();
