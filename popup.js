const STUDENTS_KEY = 'meet_attendance_students';

const box = document.getElementById('students');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');

async function load() {
  const data = await chrome.storage.local.get(STUDENTS_KEY);
  const stored = (data[STUDENTS_KEY] || []).map((s) => String(s).trim()).filter(Boolean);
  const defaults = (window.MEET_ATTENDANCE_DEFAULT_STUDENTS || []).slice();
  box.value = (stored.length ? stored : defaults).join('\n');
  status.textContent = box.value.split('\n').filter((s) => s.trim()).length + ' students loaded';
}

saveBtn.addEventListener('click', async () => {
  const list = box.value.split('\n').map((s) => s.trim()).filter(Boolean);
  await chrome.storage.local.set({ [STUDENTS_KEY]: list });
  status.textContent = 'Saved ' + list.length + ' students';
});

load();