# How to Use — Meet Attendance

A step-by-step guide for **Google Meet, Zoom (web), Microsoft Teams, Cisco Webex
and Whereby**. Read the **Important** box first — the extension will mis-count
if you skip it.

> **IMPORTANT: You MUST open the meeting app's Participants/People panel yourself.**
> The scanner reads participant names from the app's participant list panel.
> Participants who don't fit on the video grid are **only** listed there, so if
> that panel is closed, the extension cannot see them and they will be wrongly
> marked **Absent**.
>
> - **Google Meet:** click the **People** icon, or **More options (⋮) → People**.
> - **Zoom:** click **Participants** in the meeting controls.
> - **Microsoft Teams:** click **People** / **Participants** in the call toolbar.
> - **Webex:** click **Participants** in the meeting controls.
>
> Keep it open for the whole class.

---

## 1. Install the extension (once)

1. Open `chrome://extensions` in Google Chrome (or Edge / Brave).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the folder that contains `manifest.json`
   (the `meet attendance` folder).
4. The extension card **Meet Attendance** appears. Pin it if you like
   (puzzle-piece icon → pin).

> After editing any file, click the **reload** (circular arrow) button on the
> extension card, then refresh your meeting tab.

---

## 2. Set your student list (once, or per class)

You can set the roster in three ways:

- Edit `default-students.js` and put one name per line:
  ```js
  window.MEET_ATTENDANCE_DEFAULT_STUDENTS = [
    "SHAURYA SINGH",
    "TANISHK BHATT",
    // ...
  ];
  ```
- Click the extension's toolbar icon (popup) and edit the list there.
- Edit it directly in the in-meeting panel (see step 4) and click **Save list**.

Names are matched **case-insensitively**, punctuation and spaces are ignored, and
the **surname is not required** as long as the first name is unique on the
roster.

---

## 3. Join your meeting

Open the meeting as usual (link, calendar, or a new tab) and **wait until you
have joined** the call.

---

## 4. Open the panel and confirm the list

1. Press **Ctrl+M** to show the **Attendance** panel (bottom-left by
   default). Press **Ctrl+M** again to hide it. Drag it by its title bar to move it.
2. Use the **Dark / Light** button in the panel header to switch theme — your
   choice is remembered next time.
3. Check the student list is filled in (pre-filled from `default-students.js`).
   Fix anything missing and click **Save list**.

---

## 5. **Open the app's Participants/People panel** (do this before/while monitoring)

- **Google Meet:** the **People** icon, or **More options (⋮) → People**.
- **Zoom:** **Participants** in the meeting controls.
- **Microsoft Teams:** **People** / **Participants** in the call toolbar.
- **Webex:** **Participants** in the meeting controls.
- **Leave it open** for the duration of the class.

The extension re-checks every 5 seconds and will try to re-open the panel if it
closes, but **opening it yourself is the most reliable way** to guarantee
off-grid participants are counted.

---

## 6. Start monitoring

Click **Start monitoring** in the panel. The extension will:

- verify the Participants/People panel is open;
- scroll the panel step-by-step, scanning after each step so **every row is
  read** (including participants beyond the video grid);
- update **Present / Absent** counts live;
- record each student's **join time** on first detection.

---

## 7. During class

- Attendance updates automatically as people join and leave.
- Every **5 minutes** the extension takes a snapshot and logs who joined, who
  left, and whether the present list was consistent with the previous snapshot
  (see the panel's **Session log**).
- Press **Stop** to pause scanning and finalize each student's **leave time**.

---

## 8. After class

1. Click **Export CSV** to download `meeting_attendance.csv`
   (roster with **Join / Leave / Duration** columns, then the 5-minute log).
2. Click **Reset session** before the next meeting to clear the previous
   record (attendance + timestamps + log).

---

## 9. Sync to the web dashboard (optional)

Instead of (or as well as) exporting CSV, you can push the session to your own
dashboard.

1. In the dashboard, open the **Sync API** page and click **Create token**. Copy
   the `ma_…` token (shown once).
2. Click the extension's toolbar icon (popup). Under **Server sync**, paste the
   **Server URL** (e.g. `https://your-app.vercel.app`) and the **API token**,
   then click **Save settings**.
3. In the meeting, press **Ctrl+M**, then click **Sync to server**. The panel
   shows the result (and the new session appears under **Sessions** in the
   dashboard).

> The popup shows a **Connected** hint once the URL + token are set. Sync only
> sends your roster, join/leave times and status — to your own server.

---

## Controls

| Control | Action |
| --- | --- |
| `Ctrl+M` | Show / hide the panel |
| Dark / Light | Switch the panel theme (remembered) |
| Save list | Store the current roster for future meetings |
| Start monitoring | Verify the Participants/People panel is open and begin scanning |
| Stop | Pause scanning and record leave times |
| Export CSV | Download `meeting_attendance.csv` |
| Sync to server | Push the session to your dashboard (needs server URL + token) |
| Reset session | Clear attendance + timestamps for a new meeting |
| Debug | Copy a diagnostic report to the clipboard / console |

---

## Quick checklist

- [ ] Extension loaded in Chrome
- [ ] Student list saved
- [ ] Joined the meeting (Meet / Zoom / Teams / Webex)
- [ ] **The app's Participants/People panel is OPEN and stays open**
- [ ] Pressed **Start monitoring**
- [ ] Pressed **Stop** and **Export CSV** at the end

---

## Troubleshooting

**The panel doesn't appear when I press Ctrl+M**
1. Reload the extension card on `chrome://extensions`.
2. Refresh the meeting tab — content scripts don't inject into tabs opened before
   the extension loaded.
3. Press F12 → Console and confirm `[Meet Attendance] content script loaded on ...`.

**Some participants aren't detected**
- The most common cause is a **closed Participants/People panel**. Open it
  yourself and keep it open.
- Click **Debug** in the panel to see what the scanner currently sees (it shows
  the detected platform and the participant selectors in use).

**Times look wrong**
- Join/leave times are only as accurate as detection. Press **Stop** at the end
  of class so leave times are finalized.
