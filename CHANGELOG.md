# Changelog

All notable changes to **Google Meet Attendance** are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [1.1.0] — 2026-10-15

Cross-app support, a theme switch, and a leaner panel.

### Added

- **Multi-platform support** — the extension now runs on **Google Meet, Zoom
  (web), Microsoft Teams, Cisco Webex and Whereby**, with a **generic fallback**
  for other in-browser meeting tools. Adds a platform registry in `core.js`
  (`detectPlatform`, `PLATFORMS`), platform-specific tile/row selectors, a
  generic short aria-label sweep, and expanded `host_permissions` /
  `content_scripts` matches in `manifest.json`.
- **Dark / light theme switch** — a **Dark / Light** button in the panel header
  toggles the theme; the choice is persisted in `chrome.storage.local`.
- **New docs** — [USAGE.md](USAGE.md) step-by-step guide and this
  [CHANGELOG.md](CHANGELOG.md).
- **Tests** — added a multi-platform suite (platform detection, per-platform
  extraction, aria-label sweep, action-text filtering). Now **35 checks / 0 failures**.

### Changed

- Panel title now reflects the detected app (e.g. "Zoom Attendance").
- Debug report shows the detected platform and the participant selectors in use.

### Removed

- The **"Not in list"** stat and the **"Detected but not in list"** list were
  removed to keep the panel focused on Present / Absent.

## [1.0.0] — 2026-08-15

Initial documented release of the Chrome extension (Manifest V3). Runs inside a
Google Meet tab, reads the live participant list, and marks each student on the
roster as **Present** or **Absent**.

### Added

- **Core extension** — Manifest V3 Chrome extension that injects into
  `meet.google.com` (`manifest.json`, `content.js`, `popup.html`, `popup.js`).
- **In-meeting panel** — floating widget summoned with **Ctrl+M**, draggable and
  pinned bottom-left so it never covers Meet's toolbar.
- **Custom roster** — paste/edit the student list from the popup, the in-meeting
  panel (**Save list**), or `default-students.js`; edits persist in
  `chrome.storage.local`.
- **Fuzzy matching** — case-, space-, and punctuation-insensitive matching;
  pronouns/status words stripped; **unique first-name** matching so the surname
  is not required, with an ambiguity guard for duplicate first names.
- **People-panel reading** — participant names read from Meet's People drawer
  rows (`role="listitem"`) so off-grid participants are counted, plus a broad
  short-text exact scan for names outside tiles.
- **Scanner automation** — verifies the People panel is open (toolbar button,
  **More options → People**, or the **"+N" chip**), re-checks every 5s, and
  scrolls the panel step-by-step while scanning after each step.
- **Live counts** — Present / Absent / Not-in-list update automatically as people
  join and leave, shown as vertical lists with status dots.
- **Timestamps** — records each student's **join** and **leave** time and
  **Duration**.
- **Session log** — attendance snapshot every **5 minutes**, naming who joined,
  who left, and whether the present list was consistent with the previous
  snapshot.
- **CSV export** — downloads `meeting_attendance.csv` with Join/Leave/Duration
  columns followed by the 5-minute log.
- **Session reset** — clear attendance, timestamps, and log for a new meeting.
- **Debug report** — one-click diagnostic (panel open?, tiles found, what the
  scanner sees) copied to clipboard/console; plus a **restore default list** button.
- **One-click installer** — `install.ps1` downloads and extracts the extension
  (plus a Download-All-Files button in the README).
- **Automated tests** — dependency-free Node test suite (`node tests/run.js`)
  covering format tolerance, false-positive protection, present/absent/unknown
  categorization, simulated Meet DOM extraction (tiles, People-panel rows,
  tooltip garbage), a short-text aggregator guard, and performance at high
  saturation. Current: **27 checks / 0 failures** (at 1.0.0).

### Changed

- Filtered `MutationObserver` to rescan only when participant rows or the drawer
  change, avoiding full-page scans on chat/transcript churn.
- Renamed roster entry `MOHMMAD SUBHAN` → `SUBHAN`.
- Dropped the present-students column from the CSV log.
- Panel UI modernized with present/absent chip series and a live indicator, then
  upgraded to vertical lists with status dots and join times.
- README updated to instruct users to open the People panel manually and to
  document the 5-minute log.

### Fixed

- Null host reference in the drag handler; guarded panel-open state.
- Robust People-panel open detection with an 8s cooldown so a detection miss
  doesn't toggle the panel closed.
- Tooltip/action text (e.g. "Pin X to your main screen") filtered out while
  still extracting the name inside it.

### Notes

- Everything runs locally in the browser; the roster and attendance are stored
  in `chrome.storage.local`. No participant data leaves the machine and the
  extension makes no network requests.
- **Users must open Meet's People panel** for off-grid participants to be
  counted reliably. See [USAGE.md](USAGE.md).
