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
  let ensureTimer = null;
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
    rebuildIndex();
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
  // Delegates to core.js, which is shareable with the automated test suite.
  const C = window.MeetAttendanceCore || null;

  function collectParticipantNames() {
    if (C) return C.collectParticipantNames(document, students);
    return new Set();
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

  // Progressively scroll every participant scroll container (the People panel
  // list in particular, not just grid tiles) so lazy-rendered/virtualized rows
  // get created step-by-step down the whole list. Every other scroll resets to
  // the top to re-trigger rendering.
  let scrollTick = 0;
  function scrollOne(el) {
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    scrollTick++;
    if (scrollTick % 2 === 0) {
      el.scrollTop = 0;
    } else {
      const step = Math.max(150, Math.round(max / 8));
      el.scrollTop = Math.min(el.scrollTop + step, max);
    }
  }

  function scrollParticipantsPanel() {
    const scrollers = [];
    const addScrollers = (startEl) => {
      let cur = startEl && startEl.parentElement;
      while (cur && cur !== document.body) {
        const st = getComputedStyle(cur);
        if (
          (st.overflowY === 'auto' || st.overflowY === 'scroll' || st.overflowY === 'overlay') &&
          cur.scrollHeight > cur.clientHeight + 5
        ) {
          if (scrollers.indexOf(cur) === -1) scrollers.push(cur);
          break;
        }
        cur = cur.parentElement;
      }
    };
    const header = findPanelHeader();
    if (header) addScrollers(header);
    document.querySelectorAll('[data-participant-id]').forEach(addScrollers);
    scrollers.forEach(scrollOne);
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 150);
  }

  // ---------- participants panel ----------
  // Off-grid participants are only rendered once Meet's People panel is open.
  // Open it automatically (and keep it open) so everyone can be counted, and
  // fall back to a manual-open tip if the button can't be found.
  const labelMatch = (el, words) => {
    const text =
      ((el.getAttribute('aria-label') || '') + ' ' +
       (el.getAttribute('data-tooltip') || '') + ' ' +
       (el.getAttribute('title') || '') + ' ' +
       (el.textContent || '')).toLowerCase();
    return words.some((w) => text.includes(w));
  };

  function findPeopleButton() {
    const selectors = [
      '[aria-label*="people" i]',
      '[aria-label*="participant" i]',
      '[data-tooltip*="people" i]',
      '[data-tooltip*="participant" i]',
      '[data-side-toolbar*="participant" i]',
      '[data-side-toolbar*="people" i]',
    ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    return (
      nodes.find(
        (el) =>
          el.tagName === 'BUTTON' ||
          el.getAttribute('role') === 'button' ||
          el.getAttribute('role') === 'tab',
      ) || null
    );
  }

  // The open People panel shows a header like "38 participants" (or "3 people").
  function findPanelHeader() {
    const re = /^\d+\s*(participants?|people)$/i;
    const nodes = Array.from(document.querySelectorAll('[aria-label], div, span'));
    return (
      nodes.find((el) => {
        const a = (el.getAttribute && el.getAttribute('aria-label')) || '';
        if (re.test(a.trim())) return true;
        if (el.children.length === 0 && re.test((el.textContent || '').trim())) return true;
        return false;
      }) || null
    );
  }

  function isPeoplePanelOpen() {
    return !!findPanelHeader();
  }

  async function ensurePeoplePanel() {
    if (isPeoplePanelOpen()) return 'open';
    const btn = findPeopleButton();
    if (btn) {
      const pressed = (btn.getAttribute('aria-pressed') || '').toLowerCase();
      if (pressed !== 'true') {
        btn.click();
        return 'clicked';
      }
      return 'open';
    }
    // Toolbar may be collapsed — open the overflow menu and pick People there.
    const more = Array.from(document.querySelectorAll('[role="button"], button')).find((el) =>
      labelMatch(el, ['more options', 'more actions']),
    );
    if (more) {
      more.click();
      await new Promise((r) => setTimeout(r, 300));
      const item = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')).find((el) =>
        labelMatch(el, ['people', 'participants']),
      );
      if (item) {
        item.click();
        return 'clicked';
      }
    }
    return 'failed';
  }

  function start() {
    monitoring = true;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    ensureTimer = setInterval(ensurePeoplePanel, 5000);
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.status.textContent = 'Opening People panel...';
    scan();
    scheduleScan();
    ensurePeoplePanel().then((r) => {
      if (r === 'failed') els.status.textContent = 'Monitoring... Tip: open the People panel manually.';
      else els.status.textContent = 'Monitoring... People panel open.';
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
    if (ensureTimer) {
      clearInterval(ensureTimer);
      ensureTimer = null;
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
  let index = null;
  function rebuildIndex() {
    index = C ? C.createIndex(students) : null;
  }

  function matchStudent(participantName) {
    return C ? C.matchStudent(participantName, students, index) : null;
  }

  function activeStudentsText() {
    return students.join('\n');
  }

  function applyStudents() {
    students = els.studentsBox.value.split('\n').map((s) => s.trim()).filter(Boolean);
    rebuildIndex();
    saveStudents();
    render();
  }

  function presentNames() {
    return C ? C.categorize(students, present, lastSeen, index).present : [];
  }

  function absentNames() {
    return C ? C.categorize(students, present, lastSeen, index).absent : [];
  }

  function unknownNames() {
    return C ? C.categorize(students, present, lastSeen, index).unknown : [];
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