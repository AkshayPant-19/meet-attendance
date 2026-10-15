(() => {
  const STUDENTS_KEY = 'meet_attendance_students';
  const PRESENT_KEY = 'meet_attendance_present';
  const RECORDS_KEY = 'meet_attendance_records';
  const LOG_KEY = 'meet_attendance_log';
  const MEETING_KEY = 'meet_attendance_meeting';
  const THEME_KEY = 'meet_attendance_theme';
  const SYNC_URL_KEY = 'meet_attendance_sync_url';
  const SYNC_TOKEN_KEY = 'meet_attendance_sync_token';
  const SYNC_COUNT_KEY = 'meet_attendance_sync_count';
  const SYNC_AUTO_KEY = 'meet_attendance_sync_auto';
  const SYNC_CURRENT_KEY = 'meet_attendance_sync_current';
  const AUTO_SYNC_MS = 300000;

  if (window.__meetAttendanceLoaded) return;
  window.__meetAttendanceLoaded = true;

  let students = [];
  let present = new Set();
  let records = {};
  let minuteLog = [];
  let monitoring = false;
  let observer = null;
  let scanTimer = null;
  let ensureTimer = null;
  let scrollTimer = null;
  let logTimer = null;
  let leaveTimer = null;
  let lastSeen = [];
  let theme = 'light';
  let autoSyncEnabled = true;
  let autoSyncTimer = null;
  let syncing = false;
  let sessionRef = { clientKey: null, sessionId: null };
  let activeMeetingCode = '';

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

  async function loadRecords() {
    const data = await chromeGet(RECORDS_KEY);
    records = data[RECORDS_KEY] || {};
  }

  async function loadLog() {
    const data = await chromeGet(LOG_KEY);
    minuteLog = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
  }

  async function loadTheme() {
    const data = await chromeGet(THEME_KEY);
    if (data[THEME_KEY] === 'dark' || data[THEME_KEY] === 'light') theme = data[THEME_KEY];
  }

  function meetingCode() {
    return (location.pathname || '').split('/').filter(Boolean)[0] || '';
  }

  function savePresent() {
    try { chrome.storage.local.set({ [PRESENT_KEY]: [...present] }); } catch (e) {}
  }

  function saveRecords() {
    try { chrome.storage.local.set({ [RECORDS_KEY]: records }); } catch (e) {}
  }

  function saveLog() {
    try { chrome.storage.local.set({ [LOG_KEY]: minuteLog }); } catch (e) {}
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

  // Which web-meeting app we're running inside (meet, zoom, teams, webex,
  // whereby or generic). Drives participant selectors and panel detection.
  const PLATFORM_ID = C ? C.detectPlatform(location) : 'meet';
  const PLATFORM = C ? C.resolvePlatform(PLATFORM_ID) : { id: 'meet', label: 'Google Meet', tileSelector: '[data-participant-id]', rowSelector: '[role="listitem"]', peopleWords: ['people', 'participant'] };
  const ROW_SELECTOR = PLATFORM.rowSelector || '[role="listitem"]';
  const TILE_SELECTOR = PLATFORM.tileSelector || '[data-participant-id]';
  const PARTICIPANT_SELECTOR = TILE_SELECTOR + ', ' + ROW_SELECTOR + ', [role="list"]';

  function collectParticipantNames() {
    if (C) return C.collectParticipantNames(document, students, PLATFORM);
    return new Set();
  }

  // ---------- scan logic ----------
  function scan() {
    if (!monitoring) return;
    const names = collectParticipantNames();
    lastSeen = [...names];
    const now = Date.now();

    names.forEach((n) => {
      const student = matchStudent(n);
      if (student) {
        if (!present.has(student)) {
          present.add(student);
          records[student] = { join: now, leave: now };
          savePresent();
          saveRecords();
        } else if (records[student]) {
          records[student].leave = now;
        }
      }
    });
    render();
  }

  function snapshotMinute(force) {
    if (!monitoring && !force) return;
    const names = [...present].sort();
    const prev = minuteLog[minuteLog.length - 1];
    const prevNames = prev ? prev.names : [];
    const left = prevNames.filter((n) => names.indexOf(n) === -1);
    const joined = names.filter((n) => prevNames.indexOf(n) === -1);
    minuteLog.push({ t: Date.now(), names, changed: left.length > 0 || joined.length > 0, left, joined });
    if (minuteLog.length > 300) minuteLog = minuteLog.slice(-300);
    saveLog();
    saveRecords();
  }

  // Progressive scroll + record loop. One step per tick (~650ms) so Meet has
  // time to render each batch of rows before we scan — detection stays in sync
  // with what scrolling reveals. When the list bottom is reached it resets to
  // the top to re-trigger lazy rendering for late arrivals.
  let scrollTick = 0;
  function scrollOne(el) {
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    scrollTick++;
    const step = Math.max(150, Math.round(max / 8));
    if (el.scrollTop >= max - 2) {
      el.scrollTop = 0;
    } else {
      el.scrollTop = Math.min(el.scrollTop + step, max);
    }
  }

  function scrollParticipantsPanel() {
    // Only ever scroll the People drawer — never the video stage. If the panel
    // is closed the scrollers we'd find belong to the grid, which must stay put.
    if (!isPeoplePanelOpen()) return;
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
    document.querySelectorAll(TILE_SELECTOR + ', ' + ROW_SELECTOR + ', [role="list"]').forEach(addScrollers);
    scrollers.forEach(scrollOne);
  }

  function scrollAndRecord() {
    if (!monitoring) return;
    scrollParticipantsPanel();
    scan();
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
    const words = PLATFORM.peopleWords || ['people', 'participant'];
    const generic = [];
    words.forEach((w) => {
      generic.push('[aria-label*="' + w + '" i]');
      generic.push('[data-tooltip*="' + w + '" i]');
      generic.push('[title*="' + w + '" i]');
    });
    const selectors = [
      ...generic,
      '[aria-label*="people" i]',
      '[aria-label*="participant" i]',
      '[data-tooltip*="people" i]',
      '[data-tooltip*="participant" i]',
      '[jsaction*="participants" i]',
      '[jsaction*="people" i]',
      '[data-side-toolbar*="participant" i]',
      '[data-side-toolbar*="people" i]',
    ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    const candidates = nodes.filter((el) => {
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role.indexOf('menu') === 0 || role === 'tooltip' || role === 'dialog') return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      return true;
    });
    const prefer = candidates.find(
      (el) =>
        el.tagName === 'BUTTON' ||
        el.getAttribute('role') === 'button' ||
        el.getAttribute('role') === 'tab' ||
        el.hasAttribute('jsaction') ||
        el.hasAttribute('data-side-toolbar'),
    );
    return prefer || candidates[0] || null;
  }

  // The open People panel shows a header like "38 participants", "People",
// "People (38)", "In this call: 3 people". Meet splits text across child
  // spans, so compare with spaces removed ("38participants", "people38").
  function findPanelHeader() {
    const re = /^(people|participants?|attendees?|roster|members?)(\d+)?$|^\d+(people|participants?|attendees?|members?)$|^(in this (call|meeting|meet):?\s*\d+)/i;
    const compact = (s) => String(s).replace(/[^0-9a-z]/gi, '').toLowerCase();
    const nodes = Array.from(document.querySelectorAll('[aria-label], div, span')).filter((el) => {
      const t = (el.textContent || '').trim();
      const a = (el.getAttribute && el.getAttribute('aria-label')) || '';
      return (t && t.length <= 40) || (a && a.length <= 40);
    });
    return (
      nodes.find((el) => {
        const a = (el.getAttribute && el.getAttribute('aria-label')) || '';
        if (re.test(compact(a))) return true;
        if (re.test(compact(el.textContent || ''))) return true;
        return false;
      }) || null
    );
  }

  function isPeoplePanelOpen() {
    if (document.querySelector('[data-side-toolbar*="participant" i], [data-side-toolbar="people"]')) return true;
    // The participant list renders rows as role="listitem" with a participant
    // id; grid tiles never do, so this reliably means the drawer is open.
    if (document.querySelector('[role="listitem"][data-participant-id], [role="list"] [data-participant-id]')) return true;
    // Non-Meet platforms: any roster row or tile the platform defines counts.
    if (PLATFORM.id !== 'meet' && document.querySelector(ROW_SELECTOR)) return true;
    return !!findPanelHeader();
  }

  // When the meeting has more people than fit the grid, Meet shows a "+N"
  // chip. Clicking it expands the stage so the temporarily hidden participants
  // become real tiles in the DOM (and thus readable), without needing the
  // People panel at all.
  function findOverflowChip() {
    return (
      Array.from(document.querySelectorAll('[aria-label], [role="button"], button, [jsaction]')).find((el) => {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        const t = (el.textContent || '').trim();
        const role = (el.getAttribute('role') || '').toLowerCase();
        if (role.indexOf('menu') === 0 || role === 'tooltip') return false;
        if (/show (more|other) participants|more participants|view all participants/i.test(a)) return true;
        if (/^\+\d+$/.test(t) && /participant|more/i.test(a)) return true;
        return false;
      }) || null
    );
  }

  function tryExpandOverflow() {
    const chip = findOverflowChip();
    if (chip) {
      chip.click();
      return true;
    }
    return false;
  }

  let lastPanelButtonClick = 0;
  async function ensurePeoplePanel() {
    if (isPeoplePanelOpen()) return 'open';

    // Cooldown so a state-detection miss can't toggle the panel open/closed.
    const now = Date.now();
    if (now - lastPanelButtonClick < 8000) return 'cooldown';

    // 1) The toolbar People button, if present.
    let clicked = 0;
    const btn = findPeopleButton();
    if (btn) {
      const pressed = (btn.getAttribute('aria-pressed') || '').toLowerCase();
      if (pressed !== 'true') {
        btn.click();
        lastPanelButtonClick = Date.now();
        clicked++;
        await new Promise((r) => setTimeout(r, 700));
        if (isPeoplePanelOpen()) return 'open';
      } else {
        return 'open';
      }
    }

    // 2) Toolbar often is collapsed now — open the More options menu and pick
    //    People there. Do this even if step 1 looked right but didn't open it.
    const more = Array.from(document.querySelectorAll('[role="button"], button')).find((el) =>
      labelMatch(el, ['more options', 'more actions']),
    );
    if (more) {
      more.click();
      lastPanelButtonClick = Date.now();
      clicked++;
      await new Promise((r) => setTimeout(r, 400));
      const item = Array.from(
        document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'),
      ).find((el) => labelMatch(el, ['people', 'participants']));
      if (item) {
        item.click();
        lastPanelButtonClick = Date.now();
        await new Promise((r) => setTimeout(r, 700));
        if (isPeoplePanelOpen()) return 'open';
      }
    }

    // 3) Last resort that needs no button at all: expand the "+N" chip so
    //    hidden participants become readable tiles.
    if (tryExpandOverflow()) return 'expanded';
    return clicked ? 'unsure' : 'failed';
  }

  function start() {
    monitoring = true;
    activeMeetingCode = meetingCode();
    // If the stored records belong to a different meeting, start clean.
    chromeGet(MEETING_KEY).then((data) => {
      const prev = data[MEETING_KEY];
      if (prev && prev !== meetingCode()) {
        present.clear();
        records = {};
        minuteLog = [];
        savePresent();
        saveRecords();
        saveLog();
      }
      chrome.storage.local.set({ [MEETING_KEY]: meetingCode() });
    });
    observer = new MutationObserver((muts) => {
      // Only rescan when the change actually touches participant rows, the
      // drawer, or the panel list — ignores chat/transcript/animation churn so
      // full-page scans don't fire every 150ms.
      const relevant = muts.some((m) => {
        if (m.type !== 'childList') return false;
        return [].concat(Array.from(m.addedNodes), Array.from(m.removedNodes)).some((n) => {
          if (n.nodeType !== 1) return false;
          if (n.matches && n.matches(PARTICIPANT_SELECTOR)) return true;
          if (n.querySelector && n.querySelector(PARTICIPANT_SELECTOR)) return true;
          return false;
        });
      });
      if (relevant) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    ensureTimer = setInterval(ensurePeoplePanel, 5000);
    scrollTimer = setInterval(scrollAndRecord, 650);
    logTimer = setInterval(snapshotMinute, 300000);
    leaveTimer = setInterval(checkLeftMeeting, 3000);
    snapshotMinute();
    // Resolve the (stable) session id, then start auto-syncing every 5 min.
    ensureSessionRef().then(startAutoSync);
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    if (els.header) els.header.classList.add('ma-live');
    els.status.textContent = 'Opening People panel...';
    scan();
    scheduleScan();
    ensurePeoplePanel().then((r) => {
      if (r === 'failed') els.status.textContent = 'Monitoring... Tip: open the People panel manually.';
      else els.status.textContent = 'Monitoring... People panel open.';
    });
  }

  function stop(skipFinalSync) {
    monitoring = false;
    stopAutoSync();
    const now = Date.now();
    present.forEach((name) => {
      if (records[name]) records[name].leave = now;
    });
    saveRecords();
    snapshotMinute(true);
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
    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
    if (logTimer) {
      clearInterval(logTimer);
      logTimer = null;
    }
    if (leaveTimer) {
      clearInterval(leaveTimer);
      leaveTimer = null;
    }
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    if (els.header) els.header.classList.remove('ma-live');
    els.status.textContent = 'Stopped';
    // Final sync so the dashboard has the complete session (unless resetting).
    if (!skipFinalSync) flushSync();
  }

  function resetSession() {
    stop(true);
    clearSessionRef();
    present.clear();
    records = {};
    minuteLog = [];
    lastSeen = [];
    savePresent();
    saveRecords();
    saveLog();
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

  function useDefaultList() {
    const defaults = (window.MEET_ATTENDANCE_DEFAULT_STUDENTS || []).slice();
    if (!defaults.length) {
      els.status.textContent = 'No default list found.';
      return;
    }
    students = defaults;
    rebuildIndex();
    saveStudents();
    els.studentsBox.value = activeStudentsText();
    render();
    els.status.textContent = 'Loaded default list (' + defaults.length + ' students).';
  }

  function buildDebugReport() {
    const lines = [];
    lines.push('URL: ' + location.href);
    lines.push('Platform: ' + PLATFORM.label + ' (' + PLATFORM_ID + ')');
    lines.push('Students loaded: ' + students.length);
    lines.push('Monitoring: ' + monitoring);
    lines.push('People button found: ' + (findPeopleButton() ? 'yes' : 'no'));
    lines.push('People panel open (header detected): ' + (isPeoplePanelOpen() ? 'yes' : 'no'));
    lines.push('More-options button found: ' + (Array.from(document.querySelectorAll('[role="button"], button')).some((el) => labelMatch(el, ['more options', 'more actions'])) ? 'yes' : 'no'));
    lines.push('Overflow "+N" chip found: ' + (findOverflowChip() ? 'yes' : 'no'));
    lines.push('Participant tiles (' + TILE_SELECTOR + '): ' + document.querySelectorAll(TILE_SELECTOR).length);
    lines.push('Roster rows (' + ROW_SELECTOR + '): ' + document.querySelectorAll(ROW_SELECTOR).length);
    const scrollables = [];
    document.querySelectorAll(TILE_SELECTOR + ', ' + ROW_SELECTOR).forEach((row) => {
      let cur = row.parentElement;
      while (cur && cur !== document.body) {
        const st = getComputedStyle(cur);
        if ((st.overflowY === 'auto' || st.overflowY === 'scroll' || st.overflowY === 'overlay') && cur.scrollHeight > cur.clientHeight + 5) {
          if (scrollables.indexOf(cur) === -1) scrollables.push(cur);
          break;
        }
        cur = cur.parentElement;
      }
    });
    lines.push('Participant scroll containers: ' + scrollables.length);
    const btnInfo = [];
    let btnCount = 0;
    document.querySelectorAll('[role="button"], button, [role="tab"]').forEach((b) => {
      btnCount++;
      if (btnInfo.length < 25) {
        btnInfo.push(
          b.tagName +
            ' [aria=' + (b.getAttribute('aria-label') || '') +
            '] [js=' + (b.getAttribute('jsaction') || '').slice(0, 40) +
            '] [side=' + (b.getAttribute('data-side-toolbar') || '') +
            '] [tip=' + (b.getAttribute('data-tooltip') || '') + ']',
        );
      }
    });
    lines.push('Clickable elements: ' + btnCount + ' (sample 25): ' + JSON.stringify(btnInfo));
    lines.push('Detected (' + lastSeen.length + '): ' + JSON.stringify(lastSeen));
    lines.push('Students with timestamps: ' + Object.keys(records).length);
    lines.push('Minute-log entries: ' + minuteLog.length);
    return lines.join('\n');
  }

  function copyDebugReport() {
    const report = buildDebugReport();
    console.log('[Meet Attendance] DEBUG REPORT\n' + report);
    try {
      navigator.clipboard.writeText(report).then(
        () => { els.status.textContent = 'Debug report copied — paste it back to me.'; },
        () => { els.status.textContent = 'Copy blocked — check console. Open DevTools (F12) for output.'; },
      );
    } catch (e) {
      els.status.textContent = 'Copy failed — check console (F12).';
    }
  }

  function presentNames() {
    return C ? C.categorize(students, present, lastSeen, index).present : [];
  }

  function absentNames() {
    return C ? C.categorize(students, present, lastSeen, index).absent : [];
  }

  // ---------- export ----------
  function pad2(x) {
    return String(x).padStart(2, '0');
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtHM(ms) {
    const d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtDur(ms) {
    if (typeof ms !== 'number') return '';
    const m = Math.max(1, Math.round(ms / 60000));
    const h = Math.floor(m / 60);
    return h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
  }

  function csvCell(v) {
    return '"' + String(v).replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    const header = ['Student Name', 'Status', 'Join Time', 'Leave Time', 'Duration'];
    const rows = students.map((s) => {
      const r = records[s];
      const dur = r && r.join ? r.leave - r.join : null;
      return [
        s,
        present.has(s) ? 'Present' : 'Absent',
        r && r.join ? fmtTime(r.join) : '',
        r && r.leave ? fmtTime(r.leave) : '',
        fmtDur(dur),
      ];
    });
    const rosterCsv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

    const logHeader = ['Time', 'Present Count', 'Consistent', 'Left', 'Joined'];
    const logRows = minuteLog.map((e) => [
      fmtHM(e.t),
      e.names.length,
      e.changed ? 'no' : 'yes',
      (e.left || []).join(', '),
      (e.joined || []).join(', '),
    ]);
    const logCsv = [logHeader, ...logRows].map((r) => r.map(csvCell).join(',')).join('\r\n');

    const csv = rosterCsv + '\r\n\r\n' + logCsv;
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'meeting_attendance.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- sync to the web dashboard ----------
  function newClientKey() {
    try {
      if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) {}
    return 'ma-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function buildPayload() {
    if (!C || !C.buildSyncPayload) return null;
    return C.buildSyncPayload({
      students: students,
      present: present,
      records: records,
      title: document.title || (PLATFORM.label + ' session'),
      platform: PLATFORM_ID,
      meetingCode: meetingCode(),
      clientKey: sessionRef.clientKey || undefined,
      sessionId: sessionRef.sessionId || undefined,
    });
  }

  // A stable id per meeting so every sync updates the SAME server row instead
  // of creating a new session every few minutes.
  async function ensureSessionRef() {
    const code = meetingCode();
    const data = await chromeGet(SYNC_CURRENT_KEY);
    const cur = data[SYNC_CURRENT_KEY];
    if (cur && cur.clientKey && cur.meetingCode === code) {
      sessionRef = { clientKey: cur.clientKey, sessionId: cur.sessionId || null };
    } else {
      sessionRef = { clientKey: newClientKey(), sessionId: null };
      saveSessionRef();
    }
    return sessionRef;
  }

  function saveSessionRef() {
    try {
      chrome.storage.local.set({
        [SYNC_CURRENT_KEY]: {
          meetingCode: meetingCode(),
          clientKey: sessionRef.clientKey,
          sessionId: sessionRef.sessionId,
        },
      });
    } catch (e) {}
  }

  function clearSessionRef() {
    sessionRef = { clientKey: null, sessionId: null };
    try { chrome.storage.local.remove(SYNC_CURRENT_KEY); } catch (e) {}
  }

  async function getSyncSettings() {
    const data = await chromeGet([SYNC_URL_KEY, SYNC_TOKEN_KEY]);
    return {
      url: String(data[SYNC_URL_KEY] || '').trim().replace(/\/+$/, ''),
      token: String(data[SYNC_TOKEN_KEY] || '').trim(),
    };
  }

  async function getSyncCount() {
    const data = await chromeGet(SYNC_COUNT_KEY);
    return data[SYNC_COUNT_KEY] || { synced: 0, lastAt: null, lastSessionId: null };
  }

  async function loadAutoSync() {
    const data = await chromeGet(SYNC_AUTO_KEY);
    autoSyncEnabled = data[SYNC_AUTO_KEY] !== false;
  }

  function setStatus(msg) {
    if (els.status) els.status.textContent = msg;
  }

  async function updateSyncHint() {
    if (!els.syncHint) return;
    const { url, token } = await getSyncSettings();
    if (!url || !token) {
      els.syncHint.textContent = 'Not connected — set the server URL + token in the extension popup.';
      return;
    }
    const c = await getSyncCount();
    els.syncHint.textContent =
      'Connected to ' + url +
      (autoSyncEnabled ? ' · auto-sync every 5 min' : '') +
      (c.synced ? ' · ' + c.synced + ' syncs' : '');
  }

  function startAutoSync() {
    stopAutoSync();
    if (!autoSyncEnabled) return;
    autoSyncTimer = setInterval(() => {
      if (monitoring) syncSession({ auto: true, silent: true });
    }, AUTO_SYNC_MS);
  }

  function stopAutoSync() {
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = null;
    }
  }

  /**
   * Sync the current session.
   *   opts.auto      – periodic/leave sync (updates the same session)
   *   opts.keepalive – allow the request to finish as the page unloads
   *   opts.silent    – don't flash a busy status message
   */
  async function syncSession(opts) {
    opts = opts || {};
    const { url, token } = await getSyncSettings();
    if (!url || !token) {
      if (!opts.silent) setStatus('Set the server URL and API token in the extension popup, then try again.');
      return;
    }
    if (syncing) return;

    await ensureSessionRef();
    const payload = buildPayload();
    if (!payload || !payload.students.length) {
      if (!opts.silent) setStatus('Nothing to sync — add a student list first.');
      return;
    }

    syncing = true;
    if (els.syncBtn) els.syncBtn.disabled = true;
    if (!opts.silent) setStatus('Syncing ' + payload.students.length + ' students…');
    try {
      const res = await fetch(url + '/api/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(payload),
        keepalive: !!opts.keepalive,
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        if (body && body.sessionId) {
          sessionRef.sessionId = body.sessionId;
          saveSessionRef();
        }
        const c = await getSyncCount();
        try {
          chrome.storage.local.set({
            [SYNC_COUNT_KEY]: {
              synced: (c.synced || 0) + 1,
              lastAt: Date.now(),
              lastSessionId: (body && body.sessionId) || null,
            },
          });
        } catch (e) {}
        setStatus(
          (opts.auto ? 'Auto-synced ' : 'Synced ') + payload.students.length + ' students' +
            (body.sessionId ? ' (session ' + String(body.sessionId).slice(0, 8) + ')' : '') + '.',
        );
        updateSyncHint();
      } else if (!opts.auto) {
        setStatus('Sync failed (' + res.status + '): ' + (body.error || 'unknown error'));
      }
    } catch (e) {
      if (!opts.auto) setStatus('Sync failed: ' + (e && e.message ? e.message : e) + ' — check the server URL.');
    } finally {
      syncing = false;
      if (els.syncBtn) els.syncBtn.disabled = false;
    }
  }

  // Final sync when the user leaves / closes the meeting tab.
  function flushSync() {
    if (!records || !Object.keys(records).length) return;
    syncSession({ auto: true, silent: true, keepalive: true });
  }

  // Leaving the meeting changes the URL away from the meeting room id.
  function checkLeftMeeting() {
    if (!monitoring) return;
    if (meetingCode() !== activeMeetingCode) stop();
  }

  // ---------- UI ----------
  function setList(container, items, kind) {
    container.textContent = '';
    if (!items || !items.length) {
      container.textContent = '—';
      return;
    }
    items.forEach((name) => {
      const row = document.createElement('div');
      row.className = 'ma-item ma-item-' + kind;
      const dot = document.createElement('span');
      dot.className = 'ma-item-dot';
      row.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = name;
      row.appendChild(label);
      if (kind === 'present' && records[name] && records[name].join) {
        const t = document.createElement('span');
        t.className = 'ma-item-time';
        t.textContent = fmtTime(records[name].join);
        row.appendChild(t);
      }
      container.appendChild(row);
    });
  }

  function render() {
    const presentList = presentNames();
    const absentList = absentNames();

    els.presentCount.textContent = presentList.length;
    els.absentCount.textContent = absentList.length;
    els.detectedCount.textContent = lastSeen.length;

    setList(els.presentList, presentList, 'present');
    setList(els.absentList, absentList, 'absent');

    const recent = minuteLog.slice(-5);
    els.logList.textContent = recent.length
      ? recent.map((e) => {
          const parts = [fmtHM(e.t) + ' — ' + e.names.length + ' present'];
          if (e.left && e.left.length) parts.push('left: ' + e.left.join(', '));
          if (e.joined && e.joined.length) parts.push('joined: ' + e.joined.join(', '));
          parts.push(e.changed ? 'CHANGED' : 'consistent');
          return parts.join(' — ');
        }).join('\n')
      : '—';
  }

  function buildWidget() {
    const host = document.createElement('div');
    host.id = 'meet-attendance-widget';
    host.innerHTML = `
      <style>
        #meet-attendance-widget {
          --ma-bg: #ffffff;
          --ma-fg: #0f172a;
          --ma-header-bg: #f8fafc;
          --ma-header-fg: #1e293b;
          --ma-border: #e2e8f0;
          --ma-border-soft: #eef2f6;
          --ma-muted: #64748b;
          --ma-input-border: #cbd5e1;
          --ma-hover: #f1f5f9;
          --ma-log-bg: #f8fafc;
          --ma-log-fg: #475569;
          --ma-btn-bg: #ffffff;
          --ma-btn-fg: #334155;
          --ma-primary: #2563eb;
          --ma-primary-hover: #1d4ed8;
          --ma-danger: #dc2626;
          --ma-danger-hover: #b91c1c;
          --ma-present: #16a34a;
          --ma-absent: #dc2626;
          --ma-shadow: rgba(15, 23, 42, .18);
          position: fixed;
          left: 16px;
          bottom: 24px;
          z-index: 999999;
          width: 340px;
          max-height: 86vh;
          background: var(--ma-bg);
          border: 1px solid var(--ma-border);
          border-radius: 16px;
          box-shadow: 0 12px 40px var(--ma-shadow);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
          font-size: 13px;
          color: var(--ma-fg);
          display: flex;
          flex-direction: column;
          box-sizing: border-box;
          overflow: hidden;
        }
        #meet-attendance-widget[data-theme="dark"] {
          --ma-bg: #0f172a;
          --ma-fg: #e2e8f0;
          --ma-header-bg: #1e293b;
          --ma-header-fg: #f1f5f9;
          --ma-border: #334155;
          --ma-border-soft: #1e293b;
          --ma-muted: #94a3b8;
          --ma-input-border: #475569;
          --ma-hover: #1e293b;
          --ma-log-bg: #111c2e;
          --ma-log-fg: #cbd5e1;
          --ma-btn-bg: #1e293b;
          --ma-btn-fg: #e2e8f0;
          --ma-primary: #3b82f6;
          --ma-primary-hover: #2563eb;
          --ma-danger: #ef4444;
          --ma-danger-hover: #dc2626;
          --ma-present: #22c55e;
          --ma-absent: #ef4444;
          --ma-shadow: rgba(0, 0, 0, .5);
        }
        #meet-attendance-widget * { box-sizing: border-box; }
        #meet-attendance-widget .ma-header {
          padding: 12px 14px;
          border-bottom: 1px solid var(--ma-border-soft);
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 600;
          color: var(--ma-header-fg);
          cursor: move;
          user-select: none;
          background: var(--ma-header-bg);
        }
        #meet-attendance-widget .ma-title { display: flex; align-items: center; gap: 8px; }
        #meet-attendance-widget .ma-actions { display: flex; align-items: center; gap: 6px; }
        #meet-attendance-widget .ma-dot {
          width: 8px; height: 8px; border-radius: 50%; background: #94a3b8;
          transition: background .2s ease, box-shadow .2s ease;
        }
        #meet-attendance-widget .ma-header.ma-live .ma-dot {
          background: #22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, .18);
        }
        #meet-attendance-widget .ma-toggle {
          background: var(--ma-fg);
          color: var(--ma-bg);
          border: none;
          border-radius: 8px;
          padding: 6px 12px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
        }
        #meet-attendance-widget .ma-theme {
          background: transparent;
          color: var(--ma-header-fg);
          border: 1px solid var(--ma-border);
          border-radius: 8px;
          padding: 5px 9px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
        }
        #meet-attendance-widget .ma-theme:hover { background: var(--ma-hover); }
        #meet-attendance-widget .ma-body { padding: 12px 14px; overflow-y: auto; }
        #meet-attendance-widget .ma-label {
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: .05em;
          color: var(--ma-muted);
          margin: 14px 0 6px;
        }
        #meet-attendance-widget .ma-label:first-child { margin-top: 2px; }
        #meet-attendance-widget textarea {
          width: 100%;
          height: 70px;
          border: 1px solid var(--ma-input-border);
          border-radius: 10px;
          padding: 8px;
          font-size: 12px;
          font-family: inherit;
          resize: vertical;
          outline: none;
          background: var(--ma-bg);
          color: var(--ma-fg);
        }
        #meet-attendance-widget textarea:focus {
          border-color: var(--ma-primary);
          box-shadow: 0 0 0 3px rgba(37, 99, 235, .12);
        }
        #meet-attendance-widget .ma-stats { display: flex; gap: 8px; margin: 12px 0 2px; }
        #meet-attendance-widget .ma-stat {
          flex: 1;
          background: var(--ma-btn-bg);
          border: 1px solid var(--ma-border);
          border-radius: 12px;
          padding: 8px 4px;
          text-align: center;
          font-size: 11px;
          color: var(--ma-muted);
        }
        #meet-attendance-widget .ma-stat b { display: block; font-size: 20px; font-weight: 700; }
        #meet-attendance-widget .ma-stat.ma-present b { color: var(--ma-present); }
        #meet-attendance-widget .ma-stat.ma-absent b { color: var(--ma-absent); }
        #meet-attendance-widget .ma-section {
          border-top: 1px solid var(--ma-border-soft);
          padding-top: 2px;
          margin-top: 10px;
        }
        #meet-attendance-widget .ma-list {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        #meet-attendance-widget .ma-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 5px 9px;
          border-radius: 8px;
          font-size: 12.5px;
          color: var(--ma-header-fg);
          transition: background .12s ease;
        }
        #meet-attendance-widget .ma-item:hover { background: var(--ma-hover); }
        #meet-attendance-widget .ma-item-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex: none;
        }
        #meet-attendance-widget .ma-item-present .ma-item-dot { background: var(--ma-present); }
        #meet-attendance-widget .ma-item-absent .ma-item-dot { background: var(--ma-absent); }
        #meet-attendance-widget .ma-item-detected .ma-item-dot { background: var(--ma-primary); }
        #meet-attendance-widget .ma-item-present .ma-item-time { color: var(--ma-present); font-weight: 600; margin-left: auto; }
        #meet-attendance-widget .ma-item-time { font-size: 11px; color: var(--ma-muted); margin-left: auto; flex: none; }
        #meet-attendance-widget .ma-log {
          background: var(--ma-log-bg);
          border: 1px solid var(--ma-border-soft);
          border-radius: 10px;
          padding: 8px 10px;
          font-size: 11px;
          color: var(--ma-log-fg);
          line-height: 1.6;
          white-space: pre-wrap;
        }
        #meet-attendance-widget .ma-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        #meet-attendance-widget .ma-row button {
          border: 1px solid var(--ma-input-border);
          background: var(--ma-btn-bg);
          border-radius: 10px;
          padding: 7px 12px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          color: var(--ma-btn-fg);
          transition: background .15s ease, border-color .15s ease;
        }
        #meet-attendance-widget .ma-row button:hover { background: var(--ma-hover); border-color: #94a3b8; }
        #meet-attendance-widget .ma-row button:disabled { opacity: .45; cursor: default; }
        #meet-attendance-widget .ma-row button.ma-primary { background: var(--ma-primary); border-color: var(--ma-primary); color: #fff; }
        #meet-attendance-widget .ma-row button.ma-primary:hover { background: var(--ma-primary-hover); border-color: var(--ma-primary-hover); }
        #meet-attendance-widget .ma-row button.ma-danger { background: var(--ma-danger); border-color: var(--ma-danger); color: #fff; }
        #meet-attendance-widget .ma-row button.ma-danger:hover { background: var(--ma-danger-hover); border-color: var(--ma-danger-hover); }
        #meet-attendance-widget .ma-status { margin-top: 12px; font-size: 12px; color: var(--ma-muted); }
        #meet-attendance-widget .ma-sync-hint { margin-top: 8px; font-size: 11px; color: var(--ma-muted); word-break: break-all; }
        #meet-attendance-widget .ma-check {
          display: flex; align-items: center; gap: 7px;
          margin-top: 8px; font-size: 12px; color: var(--ma-muted); cursor: pointer; user-select: none;
        }
        #meet-attendance-widget .ma-check input { width: auto; margin: 0; accent-color: var(--ma-primary); }
      </style>
      <div class="ma-header" id="ma-header">
        <span class="ma-title"><span class="ma-dot"></span><span id="ma-app-title">Meet Attendance</span></span>
        <span class="ma-actions">
          <button class="ma-theme" id="ma-theme" title="Switch dark / light theme">Dark</button>
          <button class="ma-toggle" id="ma-toggle">+ Open</button>
        </span>
      </div>
      <div class="ma-body" id="ma-body">
        <div class="ma-label">Student list (one per line)</div>
        <textarea id="ma-students" placeholder="John Doe&#10;Jane Smith&#10;..."></textarea>
        <div class="ma-row">
          <button id="ma-save">Save list</button>
          <button class="ma-primary" id="ma-start">Start monitoring</button>
          <button class="ma-danger" id="ma-stop" disabled>Stop</button>
        </div>
        <div class="ma-stats">
          <div class="ma-stat ma-present"><b id="ma-present">0</b>Present</div>
          <div class="ma-stat ma-absent"><b id="ma-absent">0</b>Absent</div>
        </div>
        <div class="ma-section">
          <div class="ma-label">Detected (<span id="ma-detected">0</span>)</div>
          <div class="ma-list" id="ma-detected-list"></div>
          <div class="ma-label">Present</div>
          <div class="ma-list" id="ma-present-list"></div>
          <div class="ma-label">Absent</div>
          <div class="ma-list" id="ma-absent-list"></div>
        </div>
        <div class="ma-section">
          <div class="ma-label">Session log (every 5 min)</div>
          <div class="ma-log" id="ma-log-list"></div>
        </div>
        <div class="ma-row">
          <button id="ma-export">Export CSV</button>
          <button id="ma-reset">Reset session</button>
        </div>
        <div class="ma-row">
          <button class="ma-primary" id="ma-sync">Sync to server</button>
        </div>
        <label class="ma-check"><input type="checkbox" id="ma-autosync" checked /> Auto-sync every 5 minutes</label>
        <div class="ma-sync-hint" id="ma-sync-hint"></div>
        <div class="ma-row">
          <button id="ma-defaults">Use default list</button>
          <button id="ma-debug">Debug</button>
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
    els.detectedCount = host.querySelector('#ma-detected');
    els.detectedList = host.querySelector('#ma-detected-list');
    els.presentList = host.querySelector('#ma-present-list');
    els.absentList = host.querySelector('#ma-absent-list');
    els.logList = host.querySelector('#ma-log-list');
    els.status = host.querySelector('#ma-status');
    els.header = host.querySelector('.ma-header');
    els.themeBtn = host.querySelector('#ma-theme');
    els.appTitle = host.querySelector('#ma-app-title');
    makeDraggable(els.header);

    if (els.appTitle) els.appTitle.textContent = (PLATFORM.label || 'Meeting') + ' Attendance';

    function applyTheme(mode) {
      const dark = mode === 'dark';
      host.setAttribute('data-theme', dark ? 'dark' : 'light');
      if (els.themeBtn) els.themeBtn.textContent = dark ? 'Light' : 'Dark';
    }
    function setTheme(mode) {
      theme = mode === 'dark' ? 'dark' : 'light';
      applyTheme(theme);
      try { chrome.storage.local.set({ [THEME_KEY]: theme }); } catch (e) {}
    }
    els.themeBtn.addEventListener('click', () => setTheme(theme === 'dark' ? 'light' : 'dark'));
    // Initial paint from the already-loaded preference.
    applyTheme(theme);

    els.saveBtn.addEventListener('click', applyStudents);
    els.startBtn.addEventListener('click', start);
    els.stopBtn.addEventListener('click', stop);
    els.exportBtn.addEventListener('click', exportCsv);
    els.resetBtn.addEventListener('click', resetSession);
    els.defaultsBtn = host.querySelector('#ma-defaults');
    els.debugBtn = host.querySelector('#ma-debug');
    els.syncBtn = host.querySelector('#ma-sync');
    els.syncHint = host.querySelector('#ma-sync-hint');
    els.autoChk = host.querySelector('#ma-autosync');
    els.defaultsBtn.addEventListener('click', useDefaultList);
    els.debugBtn.addEventListener('click', copyDebugReport);
    els.syncBtn.addEventListener('click', () => syncSession());

    els.autoChk.checked = autoSyncEnabled;
    els.autoChk.addEventListener('change', () => {
      autoSyncEnabled = els.autoChk.checked;
      try { chrome.storage.local.set({ [SYNC_AUTO_KEY]: autoSyncEnabled }); } catch (e) {}
      if (monitoring) startAutoSync(); else stopAutoSync();
      updateSyncHint();
    });

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
          updateSyncHint();
        }
      }
    }, true);
  }

  // Drag the panel by its header so it never blocks Meet's toolbar/People button.
  function makeDraggable(header) {
    if (!header) return;
    let dragState = null;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, textarea, a')) return;
      if (!els.host) return;
      const rect = els.host.getBoundingClientRect();
      dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragState) return;
      const left = Math.max(0, Math.min(window.innerWidth - els.host.offsetWidth, e.clientX - dragState.dx));
      const top = Math.max(0, Math.min(window.innerHeight - els.host.offsetHeight, e.clientY - dragState.dy));
      els.host.style.left = left + 'px';
      els.host.style.top = top + 'px';
      els.host.style.right = 'auto';
      els.host.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      dragState = null;
    });
  }

  // ---------- detected list ----------
  (function patchRenderDetected() {
    const origRender = render;
    render = function () {
      setList(els.detectedList, lastSeen, 'detected');
      els.detectedCount.textContent = lastSeen.length;
      origRender();
    };
  })();

  async function boot() {
    console.log('[Meet Attendance] content script loaded on', location.href, '— platform:', PLATFORM_ID);
    window.__meetAttendanceDebug = buildDebugReport;
    await Promise.all([loadTheme(), loadAutoSync()]);
    buildWidget();
    await Promise.all([loadStudents(), loadPresent(), loadRecords(), loadLog()]);
    els.studentsBox.value = activeStudentsText();
    render();
    updateSyncHint();
    // Flush any pending session when the user leaves / closes the meeting tab.
    window.addEventListener('pagehide', flushSync);
    window.addEventListener('beforeunload', flushSync);
    console.log('[Meet Attendance] widget built, press Ctrl+M to show it');
  }

  boot();
})();