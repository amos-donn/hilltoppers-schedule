/*
 * Shared logic for the Hilltoppers schedule card and its settings page.
 *
 * This is a standalone port of the extension's schedule code. The deployment
 * targets differ — the extension talks to its service worker and chrome.storage,
 * this page talks to Cloudflare Pages and localStorage — so the data layer and
 * the preference store are reimplemented, while the date/time helpers and the
 * block-display rules are ported one-to-one. The visual output is meant to be
 * identical to the extension's popup schedule card.
 */
(function () {
  'use strict';

  var EST_ZONE = 'America/New_York';
  var CLOUDFLARE_BASE_URL = 'https://hilltoppers.pages.dev';

  // --- time zone helpers -------------------------------------------------
  // The extension uses luxon. To keep this page dependency-free, the same
  // conversions are done with Intl, which knows the America/New_York offsets
  // including the daylight-saving transitions.

  var zoneParts = new Intl.DateTimeFormat('en-US', {
    timeZone: EST_ZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  function partsInZone(date) {
    var out = {};
    var parts = zoneParts.formatToParts(date);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type !== 'literal') out[p.type] = Number(p.value);
    }
    if (out.hour === 24) out.hour = 0;
    return out;
  }

  function offsetMinutes(date) {
    var p = partsInZone(date);
    var asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return (asUTC - date.getTime()) / 60000;
  }

  // Wall-clock time in the school zone -> the absolute instant.
  function zonedToUtc(y, m, d, hh, mm) {
    var guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0, 0);
    var off1 = offsetMinutes(new Date(guess));
    var candidate = guess - off1 * 60000;
    var off2 = offsetMinutes(new Date(candidate));
    if (off2 !== off1) candidate = guess - off2 * 60000;
    return new Date(candidate);
  }

  function todayKey() {
    var p = partsInZone(new Date());
    return p.year + '-' + pad(p.month) + '-' + pad(p.day);
  }

  function dateKeyOf(date) {
    var p = partsInZone(date);
    return p.year + '-' + pad(p.month) + '-' + pad(p.day);
  }

  function parseDateKey(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!m) {
      var t = partsInZone(new Date());
      return new Date(zonedToUtc(t.year, t.month, t.day, 0, 0));
    }
    return new Date(zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0));
  }

  // "HH:mm" as wall-clock time on the base date's school-zone day.
  function parseBlockTime(time, baseDate) {
    var p = partsInZone(baseDate);
    var bits = String(time).split(':');
    var hh = Number(bits[0]);
    var mm = Number(bits[1]);
    if (!isFinite(hh) || !isFinite(mm)) return baseDate;
    return new Date(zonedToUtc(p.year, p.month, p.day, hh, mm));
  }

  function toDisplayTime(date, format) {
    var p = partsInZone(date);
    if (format === '24h') return pad(p.hour) + ':' + pad(p.minute);
    var h = p.hour % 12;
    if (h === 0) h = 12;
    return h + ':' + pad(p.minute);
  }

  function weekdayOf(date) {
    var p = partsInZone(date);
    var js = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 Sun..6 Sat
    return ((js + 6) % 7) + 1; // 1 Mon..7 Sun, matching luxon
  }

  function formatCountdown(ms) {
    var totalSeconds = Math.max(0, Math.floor(ms / 1000));
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    var mm = pad(minutes);
    var ss = pad(seconds);
    if (hours === 0) return mm + ':' + ss;
    return pad(hours) + ':' + mm + ':' + ss;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // --- grade / block metadata -------------------------------------------

  var GRADE_LABELS = { 9: 'Freshman', 10: 'Sophomore', 11: 'Junior', 12: 'Senior' };
  var GRADE_LABELS_PLURAL = { 9: 'Freshmen', 10: 'Sophomores', 11: 'Juniors', 12: 'Seniors' };
  var ALL_GRADES = [9, 10, 11, 12];
  var DEFAULT_BLOCK_NAMES = { A: 'A Block', B: 'B Block', C: 'C Block', D: 'D Block', E: 'E Block' };
  var LUNCH_WAVES = [1, 2, 3, 4, 5];
  var LUNCH_WAVE_LABELS = { 1: '1st Lunch', 2: '2nd Lunch', 3: '3rd Lunch', 4: '4th Lunch', 5: '5th Lunch' };

  function getCurrentSchoolYear() {
    var p = partsInZone(new Date());
    return p.month >= 7 ? p.year + 1 : p.year;
  }

  function gradeFromGraduationYear(gradYear) {
    var grade = 12 - (gradYear - getCurrentSchoolYear());
    return Math.max(9, Math.min(12, grade));
  }

  function graduationYearFromGrade(grade) {
    return getCurrentSchoolYear() + (12 - grade);
  }

  function lunchWaveFromName(name) {
    var parsed = parseInt(name, 10);
    return LUNCH_WAVES.indexOf(parsed) >= 0 ? parsed : null;
  }

  // --- block display (ported from storage/blockPreferences.ts) ----------

  function getBlockKey(blockName) {
    var normalized = String(blockName).trim().toLowerCase();
    var entries = Object.keys(DEFAULT_BLOCK_NAMES);
    for (var i = 0; i < entries.length; i++) {
      var key = entries[i];
      if (normalized === DEFAULT_BLOCK_NAMES[key].toLowerCase()) return key;
    }
    var match = normalized.match(/^([a-e])\s*block/);
    return match ? match[1].toUpperCase() : null;
  }

  function normalizeDayType(dayType) {
    if (!dayType) return null;
    var lower = dayType.toLowerCase();
    if (lower.indexOf('green day') >= 0 && lower.indexOf('white') < 0) return 'Green Day';
    if (lower.indexOf('white day') >= 0 && lower.indexOf('green') < 0) return 'White Day';
    return null;
  }

  function resolveBlockDisplay(blockName, dayType, preferences) {
    var key = getBlockKey(blockName);
    if (!key) {
      return { label: blockName, originalName: blockName, isFree: false, emphasizeUnknown: false, useGrayText: true };
    }
    var pref = preferences[key];
    var normalized = normalizeDayType(dayType);
    var isAlternating = pref.alternating === true;

    if (isAlternating) {
      if (!normalized) {
        return { label: blockName, originalName: blockName, isFree: false, emphasizeUnknown: true, useGrayText: false };
      }
      var isGreen = normalized === 'Green Day';
      var isFree = isGreen ? pref.freeGreen === true : pref.freeWhite === true;
      var customName = (isGreen ? (pref.nameGreen || '') : (pref.nameWhite || '')).trim();
      if (isFree) {
        return { label: 'Free Block', originalName: blockName, isFree: true, emphasizeUnknown: false, useGrayText: true };
      }
      return { label: customName || blockName, originalName: blockName, isFree: false, emphasizeUnknown: false, useGrayText: false };
    }

    if (pref.free === true) {
      return { label: 'Free Block', originalName: blockName, isFree: true, emphasizeUnknown: false, useGrayText: true };
    }
    var custom = (pref.name || '').trim();
    return { label: custom || blockName, originalName: blockName, isFree: false, emphasizeUnknown: false, useGrayText: false };
  }

  // --- preferences -------------------------------------------------------
  // Same shape the extension stores, so the ported display rules apply
  // unchanged. The extension keeps these in chrome.storage.sync and mirrors to
  // Firestore; a standalone page has only its own browser, so localStorage is
  // the whole store here.

  var BLOCK_PREF_KEY = 'blockPreferences';
  var SCHEDULE_PREF_KEY = 'schedulePreferences';

  function emptyBlockPreference() {
    return {
      name: '', alternating: false, nameGreen: '', nameWhite: '',
      freeGreen: false, freeWhite: false, free: false,
      nameBackup: '', nameGreenBackup: '', nameWhiteBackup: '', migrated: true
    };
  }

  function createEmptyPreferences() {
    return {
      A: emptyBlockPreference(), B: emptyBlockPreference(), C: emptyBlockPreference(),
      D: emptyBlockPreference(), E: emptyBlockPreference()
    };
  }

  function mergeBlockPrefs(stored) {
    var merged = createEmptyPreferences();
    if (!stored || typeof stored !== 'object') return merged;
    Object.keys(merged).forEach(function (key) {
      var pref = stored[key];
      if (!pref || typeof pref !== 'object') return;
      var base = emptyBlockPreference();
      Object.keys(base).forEach(function (field) {
        if (pref[field] !== undefined) base[field] = pref[field];
      });
      merged[key] = base;
    });
    return merged;
  }

  function loadBlockPrefs() {
    try {
      return mergeBlockPrefs(JSON.parse(localStorage.getItem(BLOCK_PREF_KEY) || 'null'));
    } catch (e) {
      return createEmptyPreferences();
    }
  }

  function saveBlockPrefs(prefs) {
    try { localStorage.setItem(BLOCK_PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  var DEFAULT_SCHEDULE_PREFERENCES = { lunchPeriod: 1, timeFormat: '12h' };

  function loadSchedulePrefs() {
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(SCHEDULE_PREF_KEY) || 'null'); } catch (e) { stored = null; }
    var merged = { lunchPeriod: 1, timeFormat: '12h' };
    if (stored && typeof stored === 'object') {
      Object.keys(stored).forEach(function (k) {
        if (stored[k] !== undefined) merged[k] = stored[k];
      });
    }
    if (merged.timeFormat !== '24h') merged.timeFormat = '12h';
    return merged;
  }

  function saveSchedulePrefs(prefs) {
    try { localStorage.setItem(SCHEDULE_PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  // --- schedule data -----------------------------------------------------

  function makeId(name, index) {
    var safe = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return 'block-' + safe + '-' + index;
  }

  function mapBlocks(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(function (block, index) {
      var subBlocks;
      if (Array.isArray(block.subBlocks)) {
        subBlocks = block.subBlocks.map(function (sub, subIndex) {
          return { id: 'sub-' + String(sub.name).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + subIndex, name: sub.name, start: sub.start, end: sub.end };
        });
      }
      return { id: makeId(block.name, index), name: block.name, start: block.start, end: block.end, subBlocks: subBlocks, grades: block.grades };
    });
  }

  function fetchWithTimeout(url, options) {
    var opts = Object.assign({ cache: 'no-cache' }, options || {});
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(10000);
    return fetch(url, opts);
  }

  function loadSpecialDays() {
    return fetchWithTimeout(CLOUDFLARE_BASE_URL + '/special_days.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function normalizePeriod(s) {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    return m ? m[1] + '-' + pad(Number(m[2])) + '-' + pad(Number(m[3])) : null;
  }

  function loadSpecialPeriodsList() {
    return fetchWithTimeout(CLOUDFLARE_BASE_URL + '/special_periods.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (raw) {
        if (!Array.isArray(raw)) return null;
        return raw.map(function (p) {
          var start = normalizePeriod(p.start);
          var end = normalizePeriod(p.end);
          return start && end ? { start: start, end: end, details: p.details } : null;
        }).filter(Boolean);
      })
      .catch(function () { return null; });
  }

  // The extension scrapes the Daily Bulletin for the day colour (or predicts it)
  // because it runs in an extension page with the site in its host permissions.
  // A page on github.io gets no CORS from stjacademy.org, so it reads the colour
  // the project already computes and publishes: day_type.json.
  var DAY_TYPE_CACHE_KEY = 'dayTypeCache';

  function normalizeDayTypes(value) {
    var days = {};
    if (!value || typeof value !== 'object') return days;
    Object.keys(value).forEach(function (key) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || typeof value[key] !== 'string') return;
      var lower = value[key].toLowerCase();
      if (lower.indexOf('green') >= 0) days[key] = 'Green Day';
      else if (lower.indexOf('white') >= 0) days[key] = 'White Day';
      else if (lower.indexOf('no school') >= 0) days[key] = 'No School';
    });
    return days;
  }

  function loadDayTypes() {
    return fetchWithTimeout(CLOUDFLARE_BASE_URL + '/day_type.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var days = normalizeDayTypes(data && data.days);
        try { localStorage.setItem(DAY_TYPE_CACHE_KEY, JSON.stringify({ days: days, cachedAt: Date.now() })); } catch (e) { /* ignore */ }
        return days;
      })
      .catch(function () {
        try {
          var cached = JSON.parse(localStorage.getItem(DAY_TYPE_CACHE_KEY) || 'null');
          if (cached && cached.days) return normalizeDayTypes(cached.days);
        } catch (e) { /* ignore */ }
        return null;
      });
  }

  function loadJsonSchedule(key) {
    return fetch('schedule/' + key + '.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { return data ? mapBlocks(data) : null; })
      .catch(function () { return null; });
  }

  function deriveDayTypeLabel(rawType, color) {
    if (!color) return null;
    var lower = String(color).trim().toLowerCase();
    if (lower.indexOf('green') >= 0) return 'Green Day';
    if (lower.indexOf('white') >= 0) return 'White Day';
    if (lower.indexOf('no_school') >= 0 || lower.indexOf('no school') >= 0) return 'No School';
    return null;
  }

  function getDefaultScheduleForWeekday(date) {
    switch (weekdayOf(date)) {
      case 1: case 2: case 4: return 'schedule_mon_thu';
      case 3: return 'schedule_wed';
      case 5: return 'schedule_fri';
      default: return null;
    }
  }

  function loadBlocksForDate(date) {
    var dateStr = dateKeyOf(date);
    return Promise.all([loadSpecialDays(), loadSpecialPeriodsList(), loadDayTypes()]).then(function (res) {
      var specialDays = res[0];
      var specialPeriods = res[1];
      var dayTypes = res[2];

      if (specialDays === null && specialPeriods === null) {
        return { blocks: [], dayType: null, details: null, networkFailed: true };
      }

      if (specialPeriods) {
        var period = specialPeriods.filter(function (p) { return dateStr >= p.start && dateStr <= p.end; })[0];
        if (period) return { blocks: [], dayType: 'No School', details: period.details || null };
      }

      var specialDay = (specialDays && specialDays[dateStr]) || null;
      var rawType = specialDay ? specialDay.type : null;
      var details = specialDay ? (specialDay.details || null) : null;
      var color = specialDay ? specialDay.color : null;
      var label = deriveDayTypeLabel(rawType, color);
      if (!label && dayTypes) label = dayTypes[dateStr] || null;

      if (rawType === 'no_school') {
        return { blocks: [], dayType: label || 'No School', details: details };
      }
      if (rawType === 'custom') {
        return { blocks: specialDay && Array.isArray(specialDay.schedule) ? mapBlocks(specialDay.schedule) : [], dayType: label, details: details };
      }
      if (typeof rawType === 'string' && rawType) {
        return loadJsonSchedule(rawType).then(function (typed) {
          if (typed) return { blocks: typed, dayType: label, details: details };
          return fallbackFor(date, rawType, label, details);
        });
      }
      return fallbackFor(date, rawType, label, details);
    });
  }

  function fallbackFor(date, rawType, label, details) {
    var fallbackKey = getDefaultScheduleForWeekday(date);
    if (!fallbackKey) {
      if (!rawType) return { blocks: [], dayType: 'No School', details: 'Weekend' };
      return { blocks: [], dayType: label || null, details: details };
    }
    return loadJsonSchedule(fallbackKey).then(function (blocks) {
      return { blocks: blocks || [], dayType: label, details: details };
    });
  }

  // How long until a block ends / the next one starts, exactly as the popup
  // computes it (including a break bar between blocks).
  function computeStatus(blocks, baseDate, now) {
    var current = null, next = null, remainingMs = 0, nextStartsInMs = 0;
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var start = parseBlockTime(block.start, baseDate);
      var end = parseBlockTime(block.end, baseDate);
      if (now >= start && now < end) {
        current = block;
        if (i + 1 < blocks.length) {
          next = blocks[i + 1];
          nextStartsInMs = Math.max(0, parseBlockTime(blocks[i + 1].start, baseDate).getTime() - now.getTime());
        }
        remainingMs = Math.max(0, end.getTime() - now.getTime());
        break;
      }
      if (now < start) {
        next = block;
        nextStartsInMs = Math.max(0, start.getTime() - now.getTime());
        break;
      }
    }
    return { currentBlock: current, nextBlock: next, remainingMs: remainingMs, nextStartsInMs: nextStartsInMs };
  }

  function computeProgressBar(blocks, currentBlock, nextBlock, baseDate, now, timeFormat) {
    if (currentBlock) {
      var start = parseBlockTime(currentBlock.start, baseDate);
      var end = parseBlockTime(currentBlock.end, baseDate);
      var total = end.getTime() - start.getTime();
      var elapsed = now.getTime() - start.getTime();
      return { startLabel: toDisplayTime(start, timeFormat), endLabel: toDisplayTime(end, timeFormat), percent: Math.min(Math.max(elapsed / total, 0), 1), isBreak: false };
    }
    if (nextBlock) {
      var nextStart = parseBlockTime(nextBlock.start, baseDate);
      var nextEnd = parseBlockTime(nextBlock.end, baseDate);
      var index = blocks.map(function (b) { return b.id; }).indexOf(nextBlock.id);
      var prev = index > 0 ? blocks[index - 1] : null;
      var breakStart = prev ? parseBlockTime(prev.end, baseDate) : null;
      if (breakStart) {
        var btotal = nextStart.getTime() - breakStart.getTime();
        var belapsed = now.getTime() - breakStart.getTime();
        return { startLabel: toDisplayTime(breakStart, timeFormat), endLabel: toDisplayTime(nextStart, timeFormat), percent: btotal > 0 ? Math.min(Math.max(belapsed / btotal, 0), 1) : 1, isBreak: true };
      }
      return { startLabel: toDisplayTime(nextStart, timeFormat), endLabel: toDisplayTime(nextEnd, timeFormat), percent: 1, isBreak: true };
    }
    return null;
  }

  window.HT = {
    EST_ZONE: EST_ZONE,
    GRADE_LABELS: GRADE_LABELS,
    GRADE_LABELS_PLURAL: GRADE_LABELS_PLURAL,
    ALL_GRADES: ALL_GRADES,
    DEFAULT_BLOCK_NAMES: DEFAULT_BLOCK_NAMES,
    LUNCH_WAVES: LUNCH_WAVES,
    LUNCH_WAVE_LABELS: LUNCH_WAVE_LABELS,
    DEFAULT_SCHEDULE_PREFERENCES: DEFAULT_SCHEDULE_PREFERENCES,
    todayKey: todayKey,
    dateKeyOf: dateKeyOf,
    parseDateKey: parseDateKey,
    weekdayOf: weekdayOf,
    parseBlockTime: parseBlockTime,
    toDisplayTime: toDisplayTime,
    formatCountdown: formatCountdown,
    gradeFromGraduationYear: gradeFromGraduationYear,
    graduationYearFromGrade: graduationYearFromGrade,
    lunchWaveFromName: lunchWaveFromName,
    getBlockKey: getBlockKey,
    normalizeDayType: normalizeDayType,
    resolveBlockDisplay: resolveBlockDisplay,
    createEmptyPreferences: createEmptyPreferences,
    mergeBlockPrefs: mergeBlockPrefs,
    loadBlockPrefs: loadBlockPrefs,
    saveBlockPrefs: saveBlockPrefs,
    loadSchedulePrefs: loadSchedulePrefs,
    saveSchedulePrefs: saveSchedulePrefs,
    loadBlocksForDate: loadBlocksForDate,
    computeStatus: computeStatus,
    computeProgressBar: computeProgressBar
  };
})();
