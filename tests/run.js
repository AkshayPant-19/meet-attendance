/**
 * Deep test suite for Google Meet Attendance core logic.
 * Run with:  node tests/run.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const core = require('../core.js');

// ---- load the real roster from default-students.js ----
const rosterSrc = fs.readFileSync(path.join(__dirname, '..', 'default-students.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(rosterSrc, sandbox);
const ROSTER = sandbox.window.MEET_ATTENDANCE_DEFAULT_STUDENTS;

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log('  FAIL  ' + name + '  -> ' + e.message);
  }
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}

console.log('Roster loaded: ' + ROSTER.length + ' students\n');

// ============================================================
console.log('1. Basic matching — every roster name must match itself');
test('all 38 roster names match their own exact form', () => {
  ROSTER.forEach((s) => {
    assert.strictEqual(core.matchStudent(s, ROSTER), s, s + ' should match exactly');
  });
});

console.log('\n2. Format tolerance');
test('lower/upper/mixed case still matches', () => {
  ROSTER.forEach((s) => {
    assert.strictEqual(core.matchStudent(s.toLowerCase(), ROSTER), s);
    assert.strictEqual(core.matchStudent(s.toUpperCase(), ROSTER), s);
  });
});

test('mis-spaced names still match (compact comparison)', () => {
  ROSTER.forEach((s) => {
    const clean = core.normalizeName(s);
    const words = clean.split(' ');
    if (words.length < 2) return;
    // e.g. "shaurya singh" -> "sh aurya singh"
    const weird = words[0].slice(0, 1) + ' ' + words[0].slice(1) + ' ' + words.slice(1).join(' ');
    assert.strictEqual(core.matchStudent(weird, ROSTER), s, weird + ' should match ' + s);
  });
});

test('pronoun/status suffixes are stripped (You, He/Him, presenting)', () => {
  ROSTER.forEach((s) => {
    assert.strictEqual(core.matchStudent(s + ' (You)', ROSTER), s);
    assert.strictEqual(core.matchStudent(s + ' (He/Him)', ROSTER), s);
    assert.strictEqual(core.matchStudent(s + ' (She/Her)', ROSTER), s);
    assert.strictEqual(core.matchStudent(s + ' presenting', ROSTER), s);
  });
});

test('extra whitespace and punctuation are ignored', () => {
  ROSTER.forEach((s) => {
    assert.strictEqual(core.matchStudent('   ' + s + '   !!!', ROSTER), s);
  });
});

console.log('\n3. False-positive protection (critical for big classes)');
test('unique first-name-only matches (surname not required)', () => {
  assert.strictEqual(core.matchStudent('TANISHK', ROSTER), 'TANISHK BHATT');
  assert.strictEqual(core.matchStudent('KUNAL', ROSTER), 'KUNAL BHATT');
  assert.strictEqual(core.matchStudent('JATIN', ROSTER), 'JATIN JOSHI');
  assert.strictEqual(core.matchStudent('sakshi', ROSTER), 'SAKSHI');
});

test('surname typos / extra words still count when first name is unique', () => {
  assert.strictEqual(core.matchStudent('MOHMMAD SUBHAR', ROSTER), 'MOHMMAD SUBHAN');
  assert.strictEqual(core.matchStudent('AKSHAY PANT X', ROSTER), 'AKSHAY PANT');
  assert.strictEqual(core.matchStudent('DARSHIL MOUNY K', ROSTER), 'DARSHIL MOUNY');
});

test('ambiguous first names (two Shauryas) never match first-name-only', () => {
  const names = ROSTER.filter((s) => /^SHAURYA\b/.test(s));
  assert.ok(names.length >= 2, 'expected at least two Shauryas');
  // A bare "SHAURYA" is ambiguous against the real roster -> must not resolve.
  assert.strictEqual(core.matchStudent('SHAURYA', ROSTER), null, 'SHAURYA must be ambiguous in the full roster');
  // Same for a bare first name of either Shaurya.
  names.forEach((s) => {
    assert.strictEqual(core.matchStudent('SHAURYA', ROSTER), null);
  });
  // But full names always resolve uniquely.
  assert.strictEqual(core.matchStudent('SHAURYA SAUN', ROSTER), 'SHAURYA SAUN');
  assert.strictEqual(core.matchStudent('SHAURYA SINGH', ROSTER), 'SHAURYA SINGH');
});

test('shared surnames never cross-match (different first names)', () => {
  const pairs = [
    ['TANISHK BHATT', 'TANUJ BHATT'],
    ['PARAS BHATT', 'PARTH KAPRI'],
    ['MANAS JOSHI', 'YASHRAJ JOSHI'],
    ['BHAVESH SINGH BORA', 'SAHIL SINGH DHAMI'],
    ['JIGYASHA BHATT', 'KUNAL BHATT'],
    ['PRACHI BISHT', 'PURVI BISHT'],
  ];
  pairs.forEach(([a, b]) => {
    assert.notStrictEqual(core.matchStudent(a, [b]), b, a + ' must not resolve to ' + b);
    assert.notStrictEqual(core.matchStudent(b, [a]), a, b + ' must not resolve to ' + a);
  });
});

test('totally different / unknown first names never match', () => {
  assert.strictEqual(core.matchStudent('BAVESH SINGH BORA', ROSTER), null);
  assert.strictEqual(core.matchStudent('RAHUL KUMAR', ROSTER), null);
  assert.strictEqual(core.matchStudent('A BOT ACCOUNT', ROSTER), null);
});

test('no two roster names share the same compact key (no ambiguity)', () => {
  const keys = ROSTER.map(core.compactKey);
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate compact keys found: ' + JSON.stringify(keys.filter((k, i) => keys.indexOf(k) !== i)));
});

test('every student matches as themselves against the full roster', () => {
  ROSTER.forEach((s) => {
    assert.strictEqual(core.matchStudent(s, ROSTER), s, s);
  });
});

console.log('\n4. categorize (present / absent / unknown)');
test('full attendance: all present, none absent', () => {
  const present = new Set(ROSTER);
  const res = core.categorize(ROSTER, present, ROSTER);
  assert.strictEqual(res.present.length, ROSTER.length);
  assert.strictEqual(res.absent.length, 0);
  assert.strictEqual(res.unknown.length, 0);
});

test('partial attendance counts correctly', () => {
  const present = new Set(ROSTER.slice(0, 10));
  const res = core.categorize(ROSTER, present, ROSTER.slice(0, 10));
  assert.strictEqual(res.present.length, 10);
  assert.strictEqual(res.absent.length, ROSTER.length - 10);
});

test('off-list participants show as unknown', () => {
  const observed = ['TANISHK BHATT', 'RANDOM PERSON', 'A BOT ACCOUNT'];
  const res = core.categorize(ROSTER, new Set(), observed);
  assert.ok(res.unknown.includes('RANDOM PERSON'));
  assert.ok(res.unknown.includes('A BOT ACCOUNT'));
  assert.ok(!res.unknown.includes('TANISHK BHATT'));
  assert.strictEqual(res.present.length, 0);
});

console.log('\n5. Extraction (simulated Meet DOM)');
// ---- minimal DOM mock ----
function el(kind, text, attrs, children) {
  return {
    kind,
    _text: text || '',
    _attrs: attrs || {},
    children: children || [],
    textContent: text || (children || []).map((c) => c.textContent || '').join(' '),
    querySelector: function (sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll: function (sel) {
      if (sel === '[aria-label]') {
        const hits = [];
        const walk = (n) => {
          if (n._attrs['aria-label']) hits.push(n);
          (n.children || []).forEach(walk);
        };
        walk(this);
        return hits;
      }
      if (sel === '.oIy2qc' || sel === '.n8xkHc' || sel === '.Z9qxz' || sel === '[data-self-name]') {
        const hits = [];
        const walk = (n) => {
          if (n.kind === 'name') hits.push(n);
          (n.children || []).forEach(walk);
        };
        walk(this);
        return hits;
      }
      return [];
    },
    getAttribute: function (a) {
      return this._attrs[a];
    },
  };
}

function leafText(t) {
  return { kind: 'leaf', _text: t, children: [], textContent: t, querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null };
}

function makeDoc({ tiles, leaves }) {
  const tileEls = tiles.map((t) =>
    el('tile', null, { 'data-participant-id': '1' }, [el('name', t, {})]),
  );
  const leafEls = (leaves || []).map(leafText);
  const body = { children: [...tileEls, ...leafEls] };
  return {
    body,
    querySelectorAll: function (sel) {
      if (sel === '[data-participant-id]') return tileEls;
      return [];
    },
    createTreeWalker: function (_root, _what, filter) {
      const accepted = leafEls.filter((n) => filter.acceptNode(n) === 1);
      let i = 0;
      return { nextNode: () => accepted[i++] || null };
    },
  };
}

test('tiles with known name elements are extracted', () => {
  const doc = makeDoc({ tiles: ['TANISHK BHATT', 'SHAURYA SINGH', 'You'] });
  const found = core.collectParticipantNames(doc, ROSTER);
  assert.ok(found.has('TANISHK BHATT'));
  assert.ok(found.has('SHAURYA SINGH'));
  assert.ok(!found.has('You'), 'self tile must be excluded');
});

test('tile with only textContent fallback is extracted', () => {
  const tile = el('tile', null, { 'data-participant-id': '1' }, [
    el('span', 'PARAS BHATT', {}),
    el('span', 'muted', {}),
  ]);
  const doc = {
    body: { children: [tile] },
    querySelectorAll: (sel) => (sel === '[data-participant-id]' ? [tile] : []),
    createTreeWalker: () => ({ nextNode: () => null }),
  };
  const found = core.collectParticipantNames(doc, ROSTER);
  // textContent contains the name; matching is conservative, tile raw text is
  // the whole tile text. Core returns raw strings; ensure it was captured.
  assert.ok([...found].some((n) => core.compactKey(n) === core.compactKey('PARAS BHATT')));
});

test('off-grid names in a leaf element are found by broad scan', () => {
  const doc = makeDoc({ tiles: [], leaves: ['LAVANYA SINGH KARKI', 'ARADHYA PANDEY', 'You'] });
  const found = core.collectParticipantNames(doc, ROSTER);
  assert.ok(found.has('LAVANYA SINGH KARKI'));
  assert.ok(found.has('ARADHYA PANDEY'));
});

test('names wrapped in non-leaf elements (with icon children) are found', () => {
  const wrapped = (text) =>
    el('wrapper', null, {}, [
      leafText(text),
      leafText(''),  // empty icon-like node
    ]);
  const doc = {
    body: { children: [wrapped('SHAURYA SINGH'), wrapped('NIMISHA MEENA')] },
    querySelectorAll: (sel) => (sel === '[data-participant-id]' ? [] : []),
    createTreeWalker: function (root, what, filter) {
      const acceptAll = this.body.children.filter((n) => filter.acceptNode(n) === 1);
      let i = 0;
      return { nextNode: () => acceptAll[i++] || null };
    },
  };
  const found = core.collectParticipantNames(doc, ROSTER);
  assert.ok(found.has('SHAURYA SINGH'));
  assert.ok(found.has('NIMISHA MEENA'));
});

test('tooltip garbage is filtered out and roster names inside it are found (real Meet case)', () => {
  const tileWithTooltips = (id, tooltipWords) => {
    const kids = tooltipWords.map((w, idx) => el('span', w, { 'aria-label': w }));
    return el('tile', null, { 'data-participant-id': id }, kids);
  };
  const tiles = [
    tileWithTooltips('p1', [
      'Pin Akshay Pant to your main screen',
      'Reframe',
      'Your microphone is off.',
      "You can't unmute someone else",
      "Don't watch Akshay Pant",
      'AKSHAY PANT',
    ]),
    tileWithTooltips('p2', ['TANISHK BHATT', 'Mute', 'Camera', 'Remove']),
  ];
  const doc = {
    body: { children: tiles },
    querySelectorAll: (sel) => (sel === '[data-participant-id]' ? tiles : []),
    createTreeWalker: () => ({ nextNode: () => null }),
  };
  const testRoster = ['AKSHAY PANT', 'TANISHK BHATT'];
  const found = core.collectParticipantNames(doc, testRoster);

  // Garbage tooltips must NOT be reported as names...
  const junk = ['Reframe', 'Your microphone is off.', "You can't unmute someone else"];
  junk.forEach((j) => assert.ok(!found.has(j), 'junk leaked: ' + j));
  // ...but the real names must be found (directly and via tooltip mention).
  assert.ok(found.has('AKSHAY PANT'), 'AKSHAY PANT should be detected');
  assert.ok(found.has('TANISHK BHATT'), 'TANISHK BHATT should be detected');
});

console.log('\n6. Performance (high-saturation scenario: 38 students x many scans)');
test('matchStudent stays fast at high volume (indexed matcher)', () => {
  const index = core.createIndex(ROSTER);
  const matcher = (p) => core.matchStudent(p, ROSTER, index);
  const ITER = 200000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITER; i++) {
    matcher(ROSTER[i % ROSTER.length]);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('     ' + ITER + ' matches in ' + ms.toFixed(1) + 'ms');
  assert.ok(ms < 2000, 'too slow: ' + ms + 'ms');
});

test('unindexed matchStudent is still fast enough', () => {
  const ITER = 10000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITER; i++) {
    core.matchStudent(ROSTER[i % ROSTER.length], ROSTER);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('     ' + ITER + ' matches in ' + ms.toFixed(1) + 'ms');
  assert.ok(ms < 2000, 'too slow: ' + ms + 'ms');
});

test('collectParticipantNames is fast with a large panel', () => {
  const tiles = [];
  for (let i = 0; i < 60; i++) tiles.push('Student ' + i);
  const leaves = ROSTER.slice(0, 20);
  const doc = makeDoc({ tiles, leaves });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) core.collectParticipantNames(doc, ROSTER);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('     200 scans over 60 tiles + leaves in ' + ms.toFixed(1) + 'ms');
  assert.ok(ms < 2000, 'too slow: ' + ms + 'ms');
});

// ============================================================
console.log('\n----------------------------------------');
console.log('Result: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  failures.forEach((f) => console.log('\n--- FAILED: ' + f.name + '\n' + (f.error.stack || f.error.message)));
  process.exit(1);
}
console.log('All deep tests passed.');
