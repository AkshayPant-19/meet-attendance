const STUDENTS_KEY = 'meet_attendance_students';
const SYNC_URL_KEY = 'meet_attendance_sync_url';
const SYNC_TOKEN_KEY = 'meet_attendance_sync_token';
const SYNC_AUTO_KEY = 'meet_attendance_sync_auto';

const box = document.getElementById('students');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');
const serverInput = document.getElementById('server');
const tokenInput = document.getElementById('token');
const autoInput = document.getElementById('auto');
const saveSettingsBtn = document.getElementById('save-settings');

async function load() {
  const data = await chrome.storage.local.get([STUDENTS_KEY, SYNC_URL_KEY, SYNC_TOKEN_KEY, SYNC_AUTO_KEY]);
  const stored = (data[STUDENTS_KEY] || []).map((s) => String(s).trim()).filter(Boolean);
  const defaults = (window.MEET_ATTENDANCE_DEFAULT_STUDENTS || []).slice();
  box.value = (stored.length ? stored : defaults).join('\n');
  serverInput.value = data[SYNC_URL_KEY] || '';
  tokenInput.value = data[SYNC_TOKEN_KEY] || '';
  autoInput.checked = data[SYNC_AUTO_KEY] !== false;
  status.textContent = box.value.split('\n').filter((s) => s.trim()).length + ' students loaded';
}

saveBtn.addEventListener('click', async () => {
  const list = box.value.split('\n').map((s) => s.trim()).filter(Boolean);
  await chrome.storage.local.set({ [STUDENTS_KEY]: list });
  status.textContent = 'Saved ' + list.length + ' students';
});

saveSettingsBtn.addEventListener('click', async () => {
  const url = serverInput.value.trim().replace(/\/+$/, '');
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({
    [SYNC_URL_KEY]: url,
    [SYNC_TOKEN_KEY]: token,
    [SYNC_AUTO_KEY]: autoInput.checked,
  });
  serverInput.value = url;
  status.textContent = url && token ? 'Sync settings saved' : 'Sync disabled (URL or token empty)';
});

load();
