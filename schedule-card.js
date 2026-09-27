/*
 * Renders the schedule card. The markup and class names mirror the extension's
 * popup schedule section so the extension's popup.css styles it identically;
 * this file is the vanilla-JS equivalent of Popup.tsx's schedule logic.
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

  var GEAR_SVG = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0a2.34 2.34 0 0 0 3.319 1.915a2.34 2.34 0 0 1 2.33 4.033a2.34 2.34 0 0 0 0 3.831a2.34 2.34 0 0 1-2.33 4.033a2.34 2.34 0 0 0-3.319 1.915a2.34 2.34 0 0 1-4.659 0a2.34 2.34 0 0 0-3.32-1.915a2.34 2.34 0 0 1-2.33-4.033a2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var CALENDAR_SVG = '<svg class="toggle-title-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M8 3v3M16 3v3M4 9h16M6 6h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function mount(root, opts) {
    opts = opts || {};
    var state = {
      schedule: opts.schedule || { dateKey: '', blocks: [], dayType: null, details: null },
      blockPrefs: opts.blockPrefs || H.createEmptyPreferences(),
      schedulePrefs: opts.schedulePrefs || H.DEFAULT_SCHEDULE_PREFERENCES,
      friends: opts.friends || [],
      selectedFriend: opts.selectedFriend || '',
      now: opts.now || new Date(),
      scheduleExpanded: Boolean(opts.scheduleExpanded),
      expandedBlockId: null
    };
    var baseDate = state.schedule.dateKey ? H.parseDateKey(state.schedule.dateKey) : H.parseDateKey(H.todayKey());

    function selectedFriend() {
      var list = state.friends || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].email === state.selectedFriend) return list[i];
      }
      // Fall back to the first friend so removing or renaming the selected one
      // never leaves the card stranded on the empty state.
      return list.length > 0 ? list[0] : null;
    }
    function friendLabel(friend) {
      return friend.name ? friend.name + ' (' + friend.email + ')' : friend.email;
    }
    // The card shows a friend's schedule only; the viewer's own schedule is
    // never displayed. The viewer's grade is therefore irrelevant here and the
    // friend's own grade is what filters grade-specific blocks.
    function friendBlocks(friend) {
      return H.gradeFilteredBlocks(state.schedule.blocks, friend ? friend.grade : null);
    }

    function renderHeader() {
      var gear = el('div', { class: 'settings-button-wrapper' }, [
        el('button', { class: 'settings-button', type: 'button', 'aria-label': 'Open settings', html: GEAR_SVG }),
        el('span', { class: 'hover-float-label settings-float-label', text: 'Settings' })
      ]);
      gear.querySelector('button').addEventListener('click', function () {
        if (opts.onOpenSettings) opts.onOpenSettings();
      });
      return el('header', null, [
        el('div', { class: 'header-row' }, [
          el('div', { class: 'header-left' }, [el('div', { class: 'header-title-row' }, [gear])]),
          el('div', { class: 'header-right' }, [renderFriendPicker()])
        ])
      ]);
    }

    // The dropdown lists every friend with where they are right now, in the
    // order set on the settings page.
    function renderFriendPicker() {
      var list = state.friends || [];
      if (list.length === 0) return null;
      var select = el('select', { class: 'friend-select', 'aria-label': 'Choose a friend' });
      list.forEach(function (friend) {
        var location = H.friendLocation(friend, state.schedule, baseDate, state.now);
        var text = friendLabel(friend) + (location ? ' \u2014 ' + location : '');
        select.appendChild(el('option', { value: friend.email, text: text }));
      });
      select.value = state.selectedFriend;
      select.addEventListener('change', function () {
        state.selectedFriend = select.value;
        state.expandedBlockId = null;
        H.saveSelectedFriend(state.selectedFriend);
        render();
      });
      return el('div', { class: 'friend-picker' }, [select]);
    }

    function renderStatus(friend, status, progressBar) {
      var currentBlock = status.currentBlock;
      var nextBlock = status.nextBlock;
      var filtered = friendBlocks(friend);
      var dayType = state.schedule.dayType;
      var isNoSchool = filtered.length === 0 &&
        ((state.schedule.details || false) || (dayType ? dayType.toLowerCase().indexOf('no school') >= 0 : false));
      var isNetworkFailed = state.schedule.networkFailed === true && filtered.length === 0;

      var body;
      if (currentBlock) {
        var currentDisplay = H.resolveBlockDisplay(currentBlock.name, state.schedule.dayType, friend.blockPrefs);
        body = el('div', { class: 'status-current' }, [
          el('div', { class: 'current-details' }, [el('p', { class: 'current-name', text: currentDisplay.label })]),
          el('span', { class: 'time-remaining' }, [
            el('span', { class: 'time-label', text: 'ends in' }),
            el('span', { class: 'time-value', text: H.formatCountdown(status.remainingMs) })
          ])
        ]);
      } else if (nextBlock) {
        var nextDisplay = H.resolveBlockDisplay(nextBlock.name, state.schedule.dayType, friend.blockPrefs);
        body = el('div', { class: 'status-current upcoming-status' }, [
          el('div', { class: 'current-details' }, [
            el('span', { class: 'next-label', text: 'Next up' }),
            el('p', { class: 'current-name', text: nextDisplay.label })
          ]),
          el('span', { class: 'time-remaining' }, [
            el('span', { class: 'time-label', text: 'starts in' }),
            el('span', { class: 'time-value', text: H.formatCountdown(status.nextStartsInMs) })
          ])
        ]);
      } else {
        var h2, p;
        if (isNetworkFailed) { h2 = 'No internet connection'; p = 'Please check your internet.'; }
        else if (isNoSchool) { h2 = state.schedule.details || 'No school today'; p = 'Have a good day!'; }
        else { h2 = 'School ended'; p = 'Have a good day!'; }
        body = el('div', { class: 'status-ended' }, [el('h2', { text: h2 }), el('p', { text: p })]);
      }

      var heading = el('p', { class: 'friend-heading', text: friendLabel(friend) });
      var section = el('section', { class: 'status' }, [heading, body]);
      if (progressBar) {
        var container = el('div', { class: 'progress-bar-container' + (progressBar.isBreak ? ' progress-break' : '') }, [
          el('div', { class: 'progress-bar-labels' }, [el('span', { text: progressBar.startLabel }), el('span', { text: progressBar.endLabel })]),
          el('div', { class: 'progress-bar-track' }, [
            el('div', { class: 'progress-bar-fill', style: { width: (progressBar.percent * 100) + '%' } })
          ])
        ]);
        section.appendChild(container);
      }
      return section;
    }

    function lunchCountdown(friend, currentBlock) {
      if (!currentBlock || friend.lunchWave == null) return null;
      var mine = (currentBlock.subBlocks || []).filter(function (sub) {
        return H.lunchWaveFromName(sub.name) === friend.lunchWave;
      })[0];
      if (!mine) return null;
      var start = H.parseBlockTime(mine.start, baseDate);
      var end = H.parseBlockTime(mine.end, baseDate);
      if (state.now < start) return mine.name + ' in ' + H.formatCountdown(start.getTime() - state.now.getTime());
      if (state.now < end) return mine.name + ' ends in ' + H.formatCountdown(end.getTime() - state.now.getTime());
      return null;
    }

    function renderBlock(friend, block, status) {
      var start = H.parseBlockTime(block.start, baseDate);
      var end = H.parseBlockTime(block.end, baseDate);
      var isCurrent = status.currentBlock && status.currentBlock.id === block.id;
      var isNext = !status.currentBlock && status.nextBlock && status.nextBlock.id === block.id;
      var display = H.resolveBlockDisplay(block.name, state.schedule.dayType, friend.blockPrefs);
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
        el('span', { class: 'block-time', text: H.toDisplayTime(start, friend.timeFormat) + ' \u2013 ' + H.toDisplayTime(end, friend.timeFormat) })
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
          var isMyLunch = friend.lunchWave != null && H.lunchWaveFromName(sub.name) === friend.lunchWave;
          return el('li', { class: isMyLunch ? 'my-lunch' : undefined }, [
            el('span', { class: 'subblock-name', text: sub.name }),
            el('span', { class: 'subblock-time', text: H.toDisplayTime(H.parseBlockTime(sub.start, baseDate), friend.timeFormat) + ' \u2013 ' + H.toDisplayTime(H.parseBlockTime(sub.end, baseDate), friend.timeFormat) })
          ]);
        });
        children.push(animatedCollapse(isExpanded, [el('ul', { class: 'subblock-list' }, items)]));
      }
      return el('li', { class: classes.join(' ') || undefined }, children);
    }

    function renderScheduleSection(friend, status) {
      var filtered = friendBlocks(friend);
      if (filtered.length === 0) return null;

      var note = lunchCountdown(friend, status.currentBlock);
      var toggle = el('button', { type: 'button', class: 'schedule-toggle', 'aria-expanded': String(state.scheduleExpanded) }, [
        el('span', { class: 'toggle-title', html: CALENDAR_SVG + '<span>Schedule</span>' })
      ]);
      if (note) toggle.appendChild(el('span', { class: 'toggle-note', text: note }));
      toggle.appendChild(el('span', { class: 'chevron' + (state.scheduleExpanded ? ' open' : '') }));
      toggle.addEventListener('click', function () {
        state.scheduleExpanded = !state.scheduleExpanded;
        render();
      });

      var inner = [el('ul', null, filtered.map(function (block) { return renderBlock(friend, block, status); }))];

      return el('section', { class: 'schedule-list' + (state.scheduleExpanded ? '' : ' collapsed') }, [
        el('div', { class: 'schedule-heading' }, [toggle]),
        animatedCollapse(state.scheduleExpanded, inner)
      ]);
    }

    function renderEmpty() {
      var main = el('main', { class: 'popup' }, [
        el('section', { class: 'status' }, [
          el('div', { class: 'status-ended' }, [
            el('h2', { text: 'No friends yet' }),
            el('p', { text: 'Get a life.' })
          ])
        ])
      ]);
      var gear = el('div', { class: 'settings-button-wrapper' }, [
        el('button', { class: 'settings-button', type: 'button', 'aria-label': 'Open settings', html: GEAR_SVG }),
        el('span', { class: 'hover-float-label settings-float-label', text: 'Settings' })
      ]);
      gear.querySelector('button').addEventListener('click', function () {
        if (opts.onOpenSettings) opts.onOpenSettings();
      });
      main.insertBefore(el('header', null, [
        el('div', { class: 'header-row' }, [
          el('div', { class: 'header-left' }, [el('div', { class: 'header-title-row' }, [gear])])
        ])
      ]), main.firstChild);
      return main;
    }

    function render() {
      baseDate = state.schedule.dateKey ? H.parseDateKey(state.schedule.dateKey) : H.parseDateKey(H.todayKey());
      root.innerHTML = '';

      var friend = selectedFriend();
      if (!friend) {
        root.appendChild(renderEmpty());
        return;
      }

      var main = el('main', { class: 'popup' });
      var filtered = friendBlocks(friend);
      var status = H.computeStatus(filtered, baseDate, state.now);
      var progressBar = H.computeProgressBar(filtered, status.currentBlock, status.nextBlock, baseDate, state.now, friend.timeFormat);

      if (state.schedule.networkFailed === true && filtered.length === 0 && !state.schedule.dayType) {
        main.className = 'popup no-network';
        main.appendChild(el('p', { text: 'No internet connection' }));
        root.appendChild(main);
        return;
      }

      main.appendChild(renderHeader());
      main.appendChild(renderStatus(friend, status, progressBar));
      var section = renderScheduleSection(friend, status);
      if (section) main.appendChild(section);

      root.appendChild(main);
    }

    render();

    return {
      render: render,
      update: function (patch) {
        Object.assign(state, patch || {});
        render();
      },
      getState: function () { return state; }
    };
  }

  window.ScheduleCard = { mount: mount };
})();
