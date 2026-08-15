(() => {
  const STUDENTS_KEY = 'meet_attendance_students';
  const PRESENT_KEY = 'meet_attendance_present';

  if (window.__meetAttendanceLoaded) return;
  window.__meetAttendanceLoaded = true;

  let students = [];
  let present = new Set();
  let monitoring = false;
  let observer = null;
  let scanTimer = null;
  let pollTimer = null;
  let lastSeen = [];
  let host = null;

  const els = {};

  // ---------- storage helpers ----------
  async function loadStudents() {
    const data = await chromeGet(STUDENTS_KEY);
    const stored = (data[STUDENTS_KEY] || []).map((s) => String(s).trim()).filter(Boolean);
    const defaults = (window.MEET_ATTENDANCE_DEFAULT_STUDENTS || []).slice();
    if (stored.length) {
      students = stored;
    } else if (defaults.length) {
      students = defaults;
      saveStudents();
    } else {
      students = [];
    }
  }

  async function loadPresent() {
    const data = await chromeGet(PRESENT_KEY);
    present = new Set(data[PRESENT_KEY] || []);
  }

  function savePresent() {
    try { chrome.storage.local.set({ [PRESENT_KEY]: [...present] }); } catch (e) {}
  }

  function saveStudents() {
    try { chrome.storage.local.set({ [STUDENTS_KEY]: students }); } catch (e) {}
  }

  function chromeGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, resolve);
      } catch (e) {
        resolve({});
      }
    });
  }

  // ---------- participant extraction ----------
  // Google Meet obfuscates class names; these are known heuristics.
  const NAME_SELECTORS = ['[data-self-name]', '.oIy2qc', '.n8xkHc', '.Z9qxz'];

  function cleanName(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim();
  }

  function collectParticipantNames() {
    const found = new Set();

    document.querySelectorAll('[data-participant-id]').forEach((tile) => {
      let raw = null;
      for (const sel of NAME_SELECTORS) {
        const el = tile.querySelector(sel);
        if (el && cleanName(el.textContent)) {
          raw = el.textContent;
          break;
        }
      }
      if (!raw) {
        const aria = tile.querySelector('[aria-label]');
        raw = aria ? aria.getAttribute('aria-label') : tile.getAttribute('aria-label');
      }
      if (!raw) raw = tile.textContent;
      const cleaned = cleanName(raw);
      if (cleaned && cleaned.toLowerCase() !== 'you') found.add(cleaned);
    });

    // Broad fallback: find any leaf element whose text equals a student name.
    // This catches names Meet renders in containers we don't know about.
    if (students.length) {
      const names = new Set(students.map((s) => normalize(s)));
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (el) =>
          el.children.length === 0 && cleanName(el.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
      });
      let node;
      while ((node = walker.nextNode())) {
        const text = cleanName(node.textContent);
        if (text && names.has(normalize(text))) found.add(text);
      }
    }

    return found;
  }

  function normalize(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchStudent(participantName) {
    const p = normalize(participantName);
    return students.find((s) => {
      const sn = normalize(s);
      return p && sn && (p === sn || p.includes(sn) || sn.includes(p));
    });
  }

  // ---------- scan logic ----------
  function scan() {
    if (!monitoring) return;
    const names = collectParticipantNames();
    lastSeen = [...names];

    names.forEach((n) => {
      const student = matchStudent(n);
      if (student && !present.has(student)) {
        present.add(student);
        savePresent();
      }
    });
    render();
    scrollParticipantsPanel();
  }

  // Scroll Meet's People panel so lazy-rendered/virtualized participant
  // rows lower down the list still get created (and thus counted).
  let scrollTick = 0;
  function scrollParticipantsPanel() {
    const row = document.querySelector('[data-participant-id]');
    if (!row) return;
    let el = row.parentElement;
    while (el && el !== document.body) {
      const st = getComputedStyle(el);
      if (
        (st.overflowY === 'auto' || st.overflowY === 'scroll' || st.overflowY === 'overlay') &&
        el.scrollHeight > el.clientHeight + 5
      ) {
        scrollTick++;
        el.scrollTop = scrollTick % 2 ? el.scrollHeight : 0;
        break;
      }
      el = el.parentElement;
    }
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 800);
  }

  // ---------- participants panel ----------
  // Off-grid participants are only rendered once Meet's People panel is
  // open. Best-effort: open it automatically so everyone can be counted.
  const labelMatch = (el, words) => {
    const text =
      ((el.getAttribute('aria-label') || '') + ' ' +
       (el.getAttribute('data-tooltip') || '') + ' ' +
       (el.getAttribute('title') || '') + ' ' +
       (el.textContent || '')).toLowerCase();
    return words.some((w) => text.includes(w));
  };

  async function openParticipantsPanel() {
    const btn = Array.from(document.querySelectorAll('[role="button"], button, [role="tab"]')).find((el) =>
      labelMatch(el, ['people', 'participants']),
    );
    if (btn) {
      btn.click();
      return true;
    }
    // Toolbar may be collapsed — open the overflow menu and pick People there.
    const more = Array.from(document.querySelectorAll('[role="button"], button')).find((el) =>
      labelMatch(el, ['more options']),
    );
    if (more) {
      more.click();
      await new Promise((r) => setTimeout(r, 300));
      const item = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')).find((el) =>
        labelMatch(el, ['people', 'participants']),
      );
      if (item) {
        item.click();
        return true;
      }
    }
    return false;
  }

  function start() {
    monitoring = true;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    pollTimer = setInterval(scan, 3000);
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.status.textContent = 'Monitoring...';
    scan();
    scheduleScan();
    openParticipantsPanel().then((opened) => {
      if (opened) els.status.textContent = 'Monitoring... People panel opened.';
    });
  }

  function stop() {
    monitoring = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    els.status.textContent = 'Stopped';
  }

  function resetSession() {
    stop();
    present.clear();
    lastSeen = [];
    savePresent();
    render();
    els.status.textContent = 'Session reset — press Start to monitor again';
  }

  // ---------- matching vs student list ----------
  function activeStudentsText() {
    return students.join('\n');
  }

  function applyStudents() {
    students = els.studentsBox.value.split('\n').map((s) => s.trim()).filter(Boolean);
    saveStudents();
    render();
  }

  function presentNames() {
    return students.filter((s) => present.has(s));
  }

  function absentNames() {
    const matchedPresent = new Set(students.filter((s) => present.has(s)));
    return students.filter((s) => !matchedPresent.has(s));
  }

  function unknownNames() {
    const known = new Set(students.map((s) => normalize(s)));
    const mapped = new Set();
    lastSeen.forEach((n) => {
      const m = matchStudent(n);
      if (m) mapped.add(normalize(m));
    });
    return lastSeen.filter((n) => !known.has(normalize(n)) && !mapped.has(normalize(n)));
  }

  // ---------- export ----------
  function exportCsv() {
    const rows = [
      ['Student Name', 'Status'],
      ...students.map((s) => [s, present.has(s) ? 'Present' : 'Absent']),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'meeting_attendance.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- UI ----------
  function render() {
    const presentList = presentNames();
    const absentList = absentNames();
    const unknown = unknownNames();

    els.presentCount.textContent = presentList.length;
    els.absentCount.textContent = absentList.length;
    els.unknownCount.textContent = unknown.length;
    els.detectedCount.textContent = lastSeen.length;

    els.presentList.textContent = presentList.length ? presentList.join(', ') : '—';
    els.absentList.textContent = absentList.length ? absentList.join(', ') : '—';
    els.unknownList.textContent = unknown.length ? unknown.join(', ') : '—';
  }

  function buildWidget() {
    const host = document.createElement('div');
    host.id = 'meet-attendance-widget';
    host.innerHTML = `
      <style>
        #meet-attendance-widget {
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 999999;
          width: 320px;
          max-height: 85vh;
          background: #fff;
          border: 1px solid #d5dbe1;
          border-radius: 10px;
          box-shadow: 0 4px 20px rgba(0,0,0,.2);
          font-family: Roboto, Arial, sans-serif;
          font-size: 13px;
          color: #202124;
          display: flex;
          flex-direction: column;
          box-sizing: border-box;
        }
        #meet-attendance-widget * { box-sizing: border-box; }
        #meet-attendance-widget .ma-header {
          padding: 10px 12px;
          border-bottom: 1px solid #e8eaed;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 500;
          color: #1a73e8;
        }
        #meet-attendance-widget .ma-toggle {
          background: #1a73e8;
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 5px 10px;
          cursor: pointer;
          font-size: 12px;
        }
        #meet-attendance-widget .ma-toggle:disabled { background: #bdc1c6; cursor: default; }
        #meet-attendance-widget .ma-toggle.ma-ghost { background: transparent; color: #1a73e8; border: 1px solid #1a73e8; }
        #meet-attendance-widget .ma-body { padding: 10px 12px; overflow-y: auto; }
        #meet-attendance-widget .ma-label { font-weight: 500; margin: 8px 0 4px; }
        #meet-attendance-widget textarea {
          width: 100%;
          height: 70px;
          border: 1px solid #dadce0;
          border-radius: 6px;
          padding: 6px;
          font-size: 12px;
          resize: vertical;
        }
        #meet-attendance-widget .ma-stats { display: flex; gap: 12px; margin: 8px 0; }
        #meet-attendance-widget .ma-stat { flex: 1; background: #f8f9fa; border-radius: 6px; padding: 6px; text-align: center; }
        #meet-attendance-widget .ma-stat b { display: block; font-size: 18px; }
        #meet-attendance-widget .ma-section { border-top: 1px solid #e8eaed; padding-top: 6px; margin-top: 8px; }
        #meet-attendance-widget .ma-list { word-break: break-word; white-space: pre-wrap; }
        #meet-attendance-widget .ma-list.ma-empty { color: #80868b; }
        #meet-attendance-widget .ma-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
        #meet-attendance-widget .ma-row button {
          border: 1px solid #dadce0;
          background: #fff;
          border-radius: 6px;
          padding: 5px 10px;
          cursor: pointer;
          font-size: 12px;
        }
        #meet-attendance-widget .ma-row button:hover { background: #f1f3f4; }
        #meet-attendance-widget .ma-status { margin-top: 8px; font-size: 12px; color: #5f6368; }
      </style>
      <div class="ma-header">
        <span>Meet Attendance</span>
        <button class="ma-toggle" id="ma-toggle">+ Open</button>
      </div>
      <div class="ma-body" id="ma-body">
        <div class="ma-label">Student list (one per line)</div>
        <textarea id="ma-students" placeholder="John Doe&#10;Jane Smith&#10;..."></textarea>
        <div class="ma-row">
          <button id="ma-save">Save list</button>
          <button id="ma-start">Start monitoring</button>
          <button id="ma-stop" disabled>Stop</button>
        </div>
        <div class="ma-stats">
          <div class="ma-stat"><b id="ma-present">0</b>Present</div>
          <div class="ma-stat"><b id="ma-absent">0</b>Absent</div>
          <div class="ma-stat"><b id="ma-unknown">0</b>Not in list</div>
        </div>
        <div class="ma-section">
          <div class="ma-label">Detected participants (<span id="ma-detected">0</span>)</div>
          <div class="ma-list" id="ma-detected-list"></div>
          <div class="ma-label">Present</div>
          <div class="ma-list" id="ma-present-list"></div>
          <div class="ma-label">Absent</div>
          <div class="ma-list" id="ma-absent-list"></div>
          <div class="ma-label">Detected but not in list</div>
          <div class="ma-list" id="ma-unknown-list"></div>
        </div>
        <div class="ma-row">
          <button id="ma-export">Export CSV</button>
          <button id="ma-reset">Reset session</button>
        </div>
        <div class="ma-status" id="ma-status">Hidden — press Ctrl+M to show.</div>
      </div>
    `;

    document.documentElement.appendChild(host);
    host.style.display = 'none';
    els.host = host;

    els.studentsBox = host.querySelector('#ma-students');
    els.startBtn = host.querySelector('#ma-start');
    els.stopBtn = host.querySelector('#ma-stop');
    els.exportBtn = host.querySelector('#ma-export');
    els.resetBtn = host.querySelector('#ma-reset');
    els.saveBtn = host.querySelector('#ma-save');
    els.toggleBtn = host.querySelector('#ma-toggle');
    els.body = host.querySelector('#ma-body');
    els.presentCount = host.querySelector('#ma-present');
    els.absentCount = host.querySelector('#ma-absent');
    els.unknownCount = host.querySelector('#ma-unknown');
    els.detectedCount = host.querySelector('#ma-detected');
    els.detectedList = host.querySelector('#ma-detected-list');
    els.presentList = host.querySelector('#ma-present-list');
    els.absentList = host.querySelector('#ma-absent-list');
    els.unknownList = host.querySelector('#ma-unknown-list');
    els.status = host.querySelector('#ma-status');

    els.saveBtn.addEventListener('click', applyStudents);
    els.startBtn.addEventListener('click', start);
    els.stopBtn.addEventListener('click', stop);
    els.exportBtn.addEventListener('click', exportCsv);
    els.resetBtn.addEventListener('click', resetSession);

    let open = true;
    const toggle = () => {
      open = !open;
      els.body.style.display = open ? '' : 'none';
      els.toggleBtn.textContent = open ? '+ Close' : '+ Open';
    };
    els.toggleBtn.addEventListener('click', toggle);
    toggle();

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        e.stopPropagation();
        const visible = host.style.display !== 'none';
        host.style.display = visible ? 'none' : '';
        console.log('[Meet Attendance] Ctrl+M pressed, panel now', host.style.display === 'none' ? 'hidden' : 'visible');
        if (!visible) {
          if (monitoring) scan();
          render();
        }
      }
    }, true);
  }

  // ---------- detected list ----------
  (function patchRenderDetected() {
    const origRender = render;
    render = function () {
      els.detectedList.textContent = lastSeen.length ? lastSeen.join(', ') : '—';
      els.detectedCount.textContent = lastSeen.length;
      origRender();
    };
  })();

  async function boot() {
    console.log('[Meet Attendance] content script loaded on', location.href);
    buildWidget();
    await Promise.all([loadStudents(), loadPresent()]);
    els.studentsBox.value = activeStudentsText();
    render();
    console.log('[Meet Attendance] widget built, press Ctrl+M to show it');
  }

  boot();
})();