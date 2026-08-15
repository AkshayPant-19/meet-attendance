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
   * Tiles first ([data-participant-id]), then a broad leaf scan that flags any
   * page element whose text exactly equals a roster name.
   * Returns a Set of raw participant strings.
   */
  function collectParticipantNames(doc, students) {
    var found = new Set();

    // Precompute multi-word student names once per scan for the containment
    // fallback, so we never re-normalize the whole roster inside each tile.
    var substrings = [];
    if (students && students.length) {
      for (var i = 0; i < students.length; i++) {
        if (cleanTokens(students[i]).length >= 2) {
          substrings.push({ norm: normalizeName(students[i]), name: students[i] });
        }
      }
    }

    doc.querySelectorAll('[data-participant-id]').forEach(function (tile) {
      var raw = null;
      for (var i = 0; i < NAME_SELECTORS.length; i++) {
        var el = tile.querySelector(NAME_SELECTORS[i]);
        if (el && cleanName(el.textContent)) {
          raw = el.textContent;
          break;
        }
      }
      if (!raw) {
        var aria = tile.querySelector('[aria-label]');
        raw = aria ? aria.getAttribute('aria-label') : tile.getAttribute('aria-label');
      }
      if (!raw) raw = tile.textContent;
      var cleaned = cleanName(raw);
      if (cleaned && cleaned.toLowerCase() !== 'you') found.add(cleaned);

      // TextContent fallback often pulls in extra words ("PARAS BHATT muted").
      // If a multi-word student name appears intact inside it, record the
      // canonical roster spelling so conservative matching still succeeds.
      // Single-word students (e.g. "SAKSHI") are kept strict to avoid
      // first-name/contained-name false positives.
      if (substrings.length) {
        var rawNorm = normalizeName(raw);
        for (var j = 0; j < substrings.length; j++) {
          if (rawNorm.indexOf(substrings[j].norm) !== -1) found.add(substrings[j].name);
        }
      }
    });

    if (students && students.length) {
      var rosterKeys = new Set(students.map(compactKey));
      // Scan every element, not just leaf nodes: Meet often renders a name in
      // a wrapper that also contains icon/empty children, which previously
      // slipped past the leaf-only check. Aggregator containers fail the exact
      // compact-key match on their own, so they can't cause false hits.
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