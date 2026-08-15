# Google Meet Attendance

A Chrome extension that runs **inside** your Google Meet meeting, reads the live participant list, and automatically marks each student from your roster as **Present** or **Absent**.

![Chrome Extension](https://img.shields.io/badge/chrome-extension-v3-brightgreen)
![Platform](https://img.shields.io/badge/platform-Google%20Meet-blue)
![License](https://img.shields.io/badge/license-MIT-green)

> Works in your browser only. No participant data ever leaves your machine — the roster and attendance are stored in `chrome.storage.local`.

---

## Install

[![Install](https://img.shields.io/badge/Install-Download%20all%20files-blue?style=for-the-badge&logo=github)](https://github.com/AkshayPant-19/meet-attendance/archive/refs/heads/main.zip)
[![PowerShell installer](https://img.shields.io/badge/PowerShell-One%20click%20install-green?style=for-the-badge&logo=powershell)](https://raw.githubusercontent.com/AkshayPant-19/meet-attendance/main/install.ps1)

**Option A — Install button above.** Downloads a ZIP with every file in this repo. Unzip it anywhere, then load it in Chrome (steps below).

**Option B — One-click PowerShell install (Windows).** Downloads the ZIP, extracts a fresh `meet-attendance` folder into your current directory, and tells you where it is. Either:

- Download and run `install.ps1`, **or**
- Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/AkshayPant-19/meet-attendance/main/install.ps1 | iex
```

**Then, in Chrome:**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the folder containing `manifest.json` (e.g. the `meet-attendance` folder the installer created).

> After editing any file, click the **reload** (curved arrow) button on the extension card, then refresh your Meet tab.

## Features

- **In-meeting panel** — a floating widget inside the Meet page; hidden until you summon it with **Ctrl+M**.
- **Live attendance** — present/absent counts update automatically while people join and leave.
- **Custom roster** — paste your own student list, or edit the bundled default list.
- **Fuzzy matching** — case- and punctuation-insensitive, so `SHAURYA SINGH` matches Meet's `Sh Aurya Singh`.
- **CSV export** — download `meeting_attendance.csv` at the end of class.
- **Session reset** — start a clean attendance record for the next meeting.

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [Customizing the student list](#customizing-the-student-list)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [License](#license)

---

## Requirements

- Google Chrome (or a Chromium-based browser such as Edge or Brave)
- No other dependencies — the extension is plain JavaScript with zero libraries

---

## Usage

1. (Optional) Edit the student list in `default-students.js` or via the extension popup.
2. Open a Google Meet meeting — via a link, the calendar, or a fresh tab.
3. Press **Ctrl+M** to open the **Meet Attendance** panel (top-right). Press **Ctrl+M** again to hide it.
4. Check the student list is filled in (it is pre-filled from `default-students.js`). Edit if needed and click **Save list**.
5. Click **Start monitoring**. The extension automatically opens Meet's **People panel** (and re-opens it every 5s if it gets closed) so all participants — including those beyond the main layout — are visible to the scanner. It then incrementally scrolls the panel so long rosters fully render. Present / Absent / Not-in-list counts update live.
6. At the end of the meeting click **Export CSV** to download the attendance file.

### Controls

| Control | Action |
| --- | --- |
| `Ctrl+M` | Show / hide the panel |
| Save list | Store the current roster for future meetings |
| Start monitoring | Begin scanning participants every few seconds |
| Stop | Pause scanning |
| Export CSV | Download `meeting_attendance.csv` |
| Reset session | Clear attendance records for a new meeting |

---

## Customizing the student list

You can set the default roster in `default-students.js` — one name per line:

```js
window.MEET_ATTENDANCE_DEFAULT_STUDENTS = [
  "SHAURYA SINGH",
  "TANISHK BHATT",
  // ...
];
```

Or edit it at runtime from the extension popup (toolbar icon) or the in-meeting panel. The in-meeting panel always shows the saved roster, so you can paste a fresh list for each class and click **Save list**.

### Matching rules

- Names are compared **case-insensitively** and punctuation is ignored.
- Spaces are ignored too (so `Sh Aurya Singh` matches `SHAURYA SINGH`).
- Pronouns/status words are stripped (`(You)`, `(He/Him)`, `presenting`).
- **The surname is not required.** A student counts if their unique **first
  name** is detected — so `Tanishk`, `Tanishk B.` or `Tanishk Bhattcharya`
  all match `TANISHK BHATT`.
- **Ambiguity guard:** if a first name appears on the roster more than once
  (e.g. two Shauryas), first-name-only matching is refused and a full-name
  match is required — so a bare `SHAURYA` never falsely marks either.
- When a tile's text contains a multi-word student name intact, that student
  is recorded (handles `PARAS BHATT muted`-style tiles).

## Automated tests

The matching and extraction logic lives in `core.js` and is covered by a deep
test suite that runs in plain Node (no dependencies):

```bash
node tests/run.js
```

It verifies format tolerance, false-positive protection (shared surnames,
first-name ambiguity, typos), present/absent/unknown categorization,
extraction from simulated Meet DOMs, and performance at high saturation
(200k matches, 60-participant scans). Run it after any change to `core.js`.

---

## How it works

`content.js` injects a hidden panel into the Meet page. While monitoring:

1. A `MutationObserver` reacts to DOM changes (e.g. tiles updating when someone joins).
2. A 3-second poll guarantees re-scans even if the DOM is idle.
3. Participant names are extracted from:
   - participant tiles (`[data-participant-id]`), using known name containers, `aria-label`, or the tile text as fallback;
   - a broad scan that flags any page element whose text exactly equals a roster name.
4. Each detected name is fuzzy-matched against the roster and marked Present.
5. Results render in the panel and are persisted to `chrome.storage.local`.

---

## Project structure

```
meet attendance/
├── manifest.json          # Chrome extension config (Manifest V3)
├── default-students.js    # Default roster (edit this)
├── core.js                # Shared matching/extraction logic (also used by tests)
├── content.js             # Injects into meet.google.com — scans participants, shows panel
├── popup.html             # Toolbar popup UI
├── popup.js               # Popup logic for editing/saving the roster
├── install.ps1            # One-click Windows installer (downloads all files into a folder)
├── tests/run.js           # Automated deep test suite (node tests/run.js)
└── README.md              # This file
```

---

## Troubleshooting

**The panel doesn't appear when I press Ctrl+M**
1. Reload the extension card on `chrome://extensions`.
2. Open the Meet tab **fresh** (or press F5) — content scripts don't inject into tabs that were open before the extension loaded.
3. Press F12 → Console and confirm you see `[Meet Attendance] content script loaded on ...`. If you don't, the extension isn't injected.

**Some participants aren't detected**
- One of the biggest offenders: **off-layout participants**. When a meeting has more people than fit on the video grid, Meet only keeps everyone's names in the page while the **People panel is open**. The extension tries to open it automatically when you click **Start monitoring**; if the toolbar was collapsed, it may not find the button — open the People panel manually and keep it open.
- Google Meet frequently changes its internal DOM. If known participants go missing anyway, update the `NAME_SELECTORS` array at the top of `content.js`.
- Participants who muted/joined late only appear once their tile is rendered — the panel updates every few seconds.

**`Extension context invalidated` in the console**
This appears in a Meet tab that was open while the extension was reloaded. Refresh the Meet tab.

**Attendance list looks wrong for a new meeting**
Click **Reset session** before the next meeting to clear the previous record.

---

## Privacy

- Everything runs locally in your browser.
- The roster and attendance live in `chrome.storage.local` — nothing is uploaded anywhere.
- The extension only reads the Google Meet page; it sends no network requests.

---

## Contributing

Found a bug or have an idea? Open an issue or a pull request. Please update the `NAME_SELECTORS` and matching logic notes if you improve participant extraction — that's the part most likely to break as Meet changes.

---

## License

[MIT](LICENSE)
