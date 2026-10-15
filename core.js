/**
 * Google Meet Attendance — shared core logic.
 * Plain UMD module so the same code runs in the Chrome content script
 * (<script> in the manifest) and in Node for automated testing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MeetAttendanceCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NAME_SELECTORS = ['[data-self-name]', '.oIy2qc', '.n8xkHc', '.Z9qxz'];

  // A little harmless generic label sweep (short aria-labels that are not
  // action/tooltip text). Improves detection on platforms we can't special-case.
  var GENERIC_SHORT_LABEL_MAX = 40;

  /**
   * Per-platform extraction configuration. `collectParticipantNames` reads
   * participant tiles and roster rows using these selectors; the broad
   * short-text exact scan runs on every platform, so an app we never
   * special-cased still gets counted when its roster names appear as text.
   *
   * To support a new app, add an entry with its tile/row selectors and add the
   * host to PLATFORM_HOSTS / manifest.json matches.
   */
  var PLATFORMS = {
    meet: {
      id: 'meet',
      label: 'Google Meet',
      tileSelector: '[data-participant-id]',
      rowSelector: '[role="listitem"], [role="list"] > [data-participant-id]',
      peopleWords: ['people', 'participant', 'attendee'],
      ariaPass: false,
    },
    zoom: {
      id: 'zoom',
      label: 'Zoom',
      // Web SDK participant tiles and the in-meeting video/avatar wrappers.
      tileSelector: '[data-participant-id], .participant-item, [class*="video-avatar"], [class*="participant-tile"]',
      rowSelector: '[role="listitem"], .participants-list .participant-item, .participant-item, [class*="participants-list"] [class*="participant"]',
      peopleWords: ['participant', 'people', 'attendee'],
      ariaPass: true,
    },
    teams: {
      id: 'teams',
      label: 'Microsoft Teams',
      tileSelector: '[data-tid="participant"], [data-tid="roster-participant"], [data-tid="video-tile"]',
      rowSelector: '[role="listitem"], [data-tid="roster-participant"], [data-tid="participant-item"], [data-tid="roster"] [role="listitem"]',
      peopleWords: ['participant', 'people', 'roster', 'attendee'],
      ariaPass: true,
    },
    webex: {
      id: 'webex',
      label: 'Cisco Webex',
      tileSelector: '[data-participant-id], [class*="participant"] [class*="name"]',
      rowSelector: '[role="listitem"], [class*="participants"] [class*="item"], [class*="roster"] [class*="item"]',
      peopleWords: ['participant', 'people', 'attendee'],
      ariaPass: true,
    },
    whereby: {
      id: 'whereby',
      label: 'Whereby',
      tileSelector: '[data-participant-id], [class*="videoTile"], [class*="participant"]',
      rowSelector: '[role="listitem"], [class*="participant"]',
      peopleWords: ['participant', 'people'],
      ariaPass: true,
    },
    generic: {
      id: 'generic',
      label: 'Meeting',
      tileSelector: '[data-participant-id]',
      rowSelector: '[role="listitem"], [role="option"], [role="list"] > [data-participant-id]',
      peopleWords: ['participant', 'people', 'attendee', 'roster'],
      ariaPass: true,
    },
  };

  // Host suffix -> platform id. Order matters only for overlap; suffixes are
  // matched with endsWith-style checks.
  var PLATFORM_HOSTS = [
    { suffix: 'meet.google.com', id: 'meet' },
    { suffix: 'zoom.us', id: 'zoom' },
    { suffix: 'zoom.com', id: 'zoom' },
    { suffix: 'teams.microsoft.com', id: 'teams' },
    { suffix: 'teams.live.com', id: 'teams' },
    { suffix: 'webex.com', id: 'webex' },
    { suffix: 'whereby.com', id: 'whereby' },
  ];

  function detectPlatform(loc) {
    var host = String((loc && loc.hostname) || (typeof location !== 'undefined' ? location.hostname : '') || '').toLowerCase();
    for (var i = 0; i < PLATFORM_HOSTS.length; i++) {
      var s = PLATFORM_HOSTS[i].suffix;
      if (host === s || host.slice(-(s.length + 1)) === '.' + s) return PLATFORM_HOSTS[i].id;
    }
    return 'generic';
  }

  function resolvePlatform(platform) {
    if (!platform) return PLATFORMS.meet;
    if (typeof platform === 'object') {
      if (platform.id && PLATFORMS[platform.id]) return PLATFORMS[platform.id];
      return platform;
    }
    return PLATFORMS[platform] || PLATFORMS.generic;
  }

  // Tokens that carry no identity (pronouns, status words). Stripped before matching.
  var PRONOUNS = new Set([
    'you', 'me', 'he', 'him', 'she', 'her', 'they', 'them', 'it',
    'yours', 'mine', 'presenting', 'sharing', 'screen',
  ]);

  // NodeFilter constants (numeric so they work with mocked DOMs in Node too).
  var FILTER_SHOW_ELEMENT = 1;
  var FILTER_ACCEPT = 1;
  var FILTER_SKIP = 3;

  // Tooltips/actions inside a tile ("Pin X to your main screen", "Reframe",
  // "Your microphone is off.") must never be treated as participant names.
  var ACTION_RX = /pin|reframe|microphone|unmute|mute|watch|camera|remove|react|reaction|rename|move|screen|leave|raise|stage|share|search|fullscreen|record|message/i;

  function cleanName(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Name tokens with pronouns/status words removed.
  function cleanTokens(name) {
    return normalizeName(name).split(' ').filter(function (t) {
      return t && !PRONOUNS.has(t);
    });
  }

  // Space-insensitive signature, e.g. "SHAURYA SINGH" and "Sh Aurya Singh" both
  // become "shauryasingh".
  function compactKey(name) {
    return cleanTokens(name).join('');
  }

  /**
   * Precompute a compact-key -> student lookup for fast repeated matching.
   * The runtime builds this once per roster change instead of re-deriving
   * every student's key on each scan.
   */
  function createIndex(students) {
    var m = new Map();
    for (var i = 0; i < students.length; i++) {
      var k = compactKey(students[i]);
      if (k && !m.has(k)) m.set(k, students[i]);
    }
    return m;
  }

  /**
   * Return the best student match for a participant name, or null.
   * Matching tiers:
   *   1. Full-name exact match (case/space/pronoun-insensitive).
   *   2. First-name match — the surname is NOT required, so long as the first
   *      name is unique on the roster. Ambiguous first names (e.g. two
   *      Shauryas) never match on first name alone, preventing false marks.
   * Pass a precomputed index (from createIndex) for performance.
   */
  function matchStudent(participantName, students, index) {
    var tokens = cleanTokens(participantName);
    if (!tokens.length) return null;
    var pc = tokens.join('');

    if (index) {
      if (index.has(pc)) return index.get(pc);
    } else {
      for (var i0 = 0; i0 < students.length; i0++) {
        if (compactKey(students[i0]) === pc) return students[i0];
      }
    }

    // First-name tier (surname not required).
    var first = tokens[0];
    var match = null;
    var ambiguous = false;
    for (var i = 0; i < students.length; i++) {
      var sTokens = cleanTokens(students[i]);
      if (!sTokens.length) continue;
      if (sTokens[0] === first) {
        if (match) {
          ambiguous = true;
          break;
        }
        match = students[i];
      }
    }
    return ambiguous ? null : match;
  }

  /**
   * Extract participant names from a Meet-like DOM (injectable for tests).
   * Uses [data-participant-id] tiles first, then an all-element exact scan.
   * Tooltip/action labels are filtered out, and a roster name is also accepted
   * when it appears intact inside a tile's text (e.g. "Pin Akshay Pant to your
   * main screen"). Returns a Set of raw participant strings.
   */
  function collectParticipantNames(doc, students, platform) {
    var plate = resolvePlatform(platform);
    var found = new Set();

    // Multi-word roster names, pre-normalized once for containment matching.
    var substrings = [];
    if (students && students.length) {
      for (var i = 0; i < students.length; i++) {
        if (cleanTokens(students[i]).length >= 2) {
          substrings.push({ norm: normalizeName(students[i]), name: students[i] });
        }
      }
    }
    function addRosterMatchesWithin(raw) {
      if (!substrings.length) return;
      var norm = normalizeName(raw);
      for (var j = 0; j < substrings.length; j++) {
        if (norm.indexOf(substrings[j].norm) !== -1) found.add(substrings[j].name);
      }
    }

    doc.querySelectorAll(plate.tileSelector).forEach(function (tile) {
      var raws = [];

      for (var s = 0; s < NAME_SELECTORS.length; s++) {
        var selEl = tile.querySelector(NAME_SELECTORS[s]);
        if (selEl && cleanName(selEl.textContent)) raws.push(selEl.textContent);
      }
      var ariaEls = tile.querySelectorAll('[aria-label]');
      for (var a = 0; a < ariaEls.length; a++) {
        var label = ariaEls[a].getAttribute('aria-label');
        if (label && cleanName(label)) raws.push(label);
      }
      raws.push(tile.textContent);

      var seen = new Set();
      raws.forEach(function (raw) {
        var cleaned = cleanName(raw);
        if (!cleaned) return;
        var low = cleaned.toLowerCase();
        if (seen.has(low)) return;
        seen.add(low);

        // Never add tooltip/action text as a participant name.
        if (low !== 'you' && !ACTION_RX.test(cleaned) && cleaned.length <= 60) {
          found.add(cleaned);
        }
        // Tooltips like "Pin Akshay Pant to your main screen" still carry the
        // person's name — find it inside the text.
        addRosterMatchesWithin(cleaned);
      });
    });

    // People-panel drawer rows. Each row element is exactly ONE person, so a
    // roster name found inside its text (e.g. "Tanuja Tripathi(You)" or a row
    // with a trailing mic-state label) is a real participant — never a list of
    // several names. Row selectors differ per platform; the broad scan below
    // still catches platforms whose rows use different markup.
    var drawRows = doc.querySelectorAll(plate.rowSelector);
    for (var d = 0; d < drawRows.length; d++) {
      var row = drawRows[d];
      var rowRaw = cleanName(row.getAttribute('aria-label') || row.textContent);
      if (rowRaw && rowRaw.toLowerCase() !== 'you') {
        if (!ACTION_RX.test(rowRaw) && rowRaw.length <= 40) found.add(rowRaw);
        addRosterMatchesWithin(rowRaw);
      }
    }

    // Generic short aria-label sweep for non-Meet platforms: participant names
    // are often only in tile/button labels. Action/tooltip text is filtered out
    // and only short labels are considered.
    if (plate.ariaPass) {
      var labelEls = doc.querySelectorAll('[aria-label], [data-tooltip], [title]');
      for (var l = 0; l < labelEls.length; l++) {
        var el = labelEls[l];
        var raw = cleanName(
          el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.getAttribute('title') || '',
        );
        if (!raw || raw.length > GENERIC_SHORT_LABEL_MAX) continue;
        if (raw.toLowerCase() === 'you' || ACTION_RX.test(raw)) continue;
        found.add(raw);
        addRosterMatchesWithin(raw);
      }
    }

    // All-element exact scan: catches names rendered in wrappers/rows outside
    // [data-participant-id] tiles. Only short text can be a bare name — this
    // skips on-screen chrome (long labels, transcript lines) for both speed and
    // correctness, and aggregator containers still can't pass the compact-key
    // equality test.
    if (students && students.length) {
      var rosterKeys = new Set(students.map(compactKey));
      var walker = doc.createTreeWalker(doc.body, FILTER_SHOW_ELEMENT, {
        acceptNode: function () {
          return FILTER_ACCEPT;
        },
      });
      var node;
      while ((node = walker.nextNode())) {
        var text = cleanName(node.textContent);
        if (text && text.length <= 60 && rosterKeys.has(compactKey(text))) found.add(text);
      }
    }

    return found;
  }

  /**
   * Split roster into present / absent / unknown for the UI.
   * present is a Set of student names already marked Present.
   * observed is the raw list of detected participant names.
   */
  function categorize(students, present, observed, index) {
    var presentList = students.filter(function (s) { return present.has(s); });
    var presentKeySet = new Set(presentList.map(compactKey));
    var absent = students.filter(function (s) { return !presentKeySet.has(compactKey(s)); });

    var knownKeys = new Set(students.map(compactKey));
    var mappedKeys = new Set();
    observed.forEach(function (n) {
      var m = matchStudent(n, students, index);
      if (m) mappedKeys.add(compactKey(m));
    });
    var unknown = observed.filter(function (n) {
      return !knownKeys.has(compactKey(n)) && !mappedKeys.has(compactKey(n));
    });

    return { present: presentList, absent: absent, unknown: unknown };
  }

  /**
   * Build the JSON body posted to POST /api/sync (matches lib/types.ts
   * SyncPayload on the website). Pure + side-effect free so it is unit-tested.
   * `present` may be an Array or a Set; `records[name]` uses epoch-ms
   * { join, leave }. Every roster student becomes a record; those not in
   * `present` are marked absent. startedAt/endedAt are derived from the
   * earliest join and latest leave.
   */
  function buildSyncPayload(opts) {
    opts = opts || {};
    var students = opts.students || [];
    var presentSet = opts.present instanceof Set ? opts.present : new Set(opts.present || []);
    var records = opts.records || {};
    var recs = {};
    var startedAt = null;
    var endedAt = null;

    for (var i = 0; i < students.length; i++) {
      var s = students[i];
      var r = records[s] || {};
      var join = typeof r.join === 'number' && isFinite(r.join) ? r.join : null;
      var leave = typeof r.leave === 'number' && isFinite(r.leave) ? r.leave : null;
      if (join !== null && (startedAt === null || join < startedAt)) startedAt = join;
      if (leave !== null && (endedAt === null || leave > endedAt)) endedAt = leave;
      recs[s] = {
        join: join,
        leave: leave,
        status: presentSet.has(s) ? 'present' : 'absent',
      };
    }

    var payload = {
      title: opts.title || 'Untitled session',
      platform: opts.platform || null,
      students: students.slice(),
      records: recs,
    };
    if (opts.meetingCode) payload.meetingCode = opts.meetingCode;
    if (opts.clientKey) payload.clientKey = opts.clientKey;
    if (opts.sessionId) payload.sessionId = opts.sessionId;
    if (startedAt !== null) payload.startedAt = startedAt;
    if (endedAt !== null) payload.endedAt = endedAt;
    return payload;
  }

  return {
    NAME_SELECTORS: NAME_SELECTORS,
    PRONOUNS: PRONOUNS,
    ACTION_RX: ACTION_RX,
    PLATFORMS: PLATFORMS,
    PLATFORM_HOSTS: PLATFORM_HOSTS,
    detectPlatform: detectPlatform,
    resolvePlatform: resolvePlatform,
    cleanName: cleanName,
    normalizeName: normalizeName,
    cleanTokens: cleanTokens,
    compactKey: compactKey,
    matchStudent: matchStudent,
    createIndex: createIndex,
    collectParticipantNames: collectParticipantNames,
    categorize: categorize,
    buildSyncPayload: buildSyncPayload,
  };
});