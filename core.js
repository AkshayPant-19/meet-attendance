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
  function collectParticipantNames(doc, students) {
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

    doc.querySelectorAll('[data-participant-id]').forEach(function (tile) {
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
    // several names.
    var drawRows = doc.querySelectorAll('[role="listitem"], [role="list"] > [data-participant-id]');
    for (var d = 0; d < drawRows.length; d++) {
      var row = drawRows[d];
      var rowRaw = cleanName(row.getAttribute('aria-label') || row.textContent);
      if (rowRaw) {
        if (!ACTION_RX.test(rowRaw) && rowRaw.length <= 40) found.add(rowRaw);
        addRosterMatchesWithin(rowRaw);
      }
    }

    // All-element exact scan: catches names rendered in wrappers/rows outside
    // [data-participant-id] tiles. Aggregator containers fail the exact
    // compact-key match on their own, so they can't cause false hits.
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
        if (text && rosterKeys.has(compactKey(text))) found.add(text);
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

  return {
    NAME_SELECTORS: NAME_SELECTORS,
    PRONOUNS: PRONOUNS,
    ACTION_RX: ACTION_RX,
    cleanName: cleanName,
    normalizeName: normalizeName,
    cleanTokens: cleanTokens,
    compactKey: compactKey,
    matchStudent: matchStudent,
    createIndex: createIndex,
    collectParticipantNames: collectParticipantNames,
    categorize: categorize,
  };
});