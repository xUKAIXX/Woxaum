/* Woxaum — visual chat (no AI yet) */
const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const DEFAULT_UI_SCALE = 1.3;
const TOKEN_KEY = 'woxaum-token';
let token = localStorage.getItem(TOKEN_KEY) || '';
let currentUser = null;

const blankState = () => ({
  characters: [],
  activeId: null,
  messages: {},
  profile: { name: '', avatar: null, gender: '', uiScale: DEFAULT_UI_SCALE },
  ai: { provider: 'gemini', key: '', model: '', base: '' },
});
let state = blankState();

/* ─────────── API ─────────── */
function withToken(path) {
  if (!token) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

let appMode = 'server'; // 'server' — python3 server.py, 'local' — static hosting (GitHub Pages)

async function api(path, { method = 'GET', body } = {}) {
  if (appMode === 'local') return localApi(path, { method, body });
  const res = await fetch(withToken(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      // the token also travels as a query param: preview proxies may strip headers
      ...(token ? { Authorization: `Bearer ${token}`, 'X-Woxaum-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function adoptState(raw) {
  const base = blankState();
  const loaded = raw && typeof raw === 'object' ? raw : {};
  state = {
    characters: Array.isArray(loaded.characters) ? loaded.characters : base.characters,
    activeId: loaded.activeId ?? null,
    messages: loaded.messages && typeof loaded.messages === 'object' ? loaded.messages : {},
    profile: { ...base.profile, ...(loaded.profile || {}) },
    ai: { ...base.ai, ...(loaded.ai || {}) },
  };
  // a reply interrupted by a reload must not stick around as an empty bubble
  Object.values(state.messages).forEach((arr) => {
    if (Array.isArray(arr)) for (let i = arr.length - 1; i >= 0; i--) if (arr[i].pending) arr.splice(i, 1);
  });
}

let saveTimer = null;
let savedFailing = false;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushState, 450);
}
async function pushState() {
  if (!token) return;
  try {
    await api('/api/state', { method: 'PUT', body: { state } });
    savedFailing = false;
  } catch (e) {
    if (!savedFailing) { savedFailing = true; toast('Could not save — check the server'); }
  }
}
window.addEventListener('beforeunload', () => {
  if (!token || appMode === 'local') return;
  try {
    fetch(withToken('/api/state'), {
      method: 'PUT',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Woxaum-Token': token },
      body: JSON.stringify({ state }),
    });
  } catch (e) { /* leaving anyway */ }
});

const activeChar = () => state.characters.find((c) => c.id === state.activeId) || null;

function hueFor(name) {
  let h = 0;
  for (const ch of name || '?') h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function avatarStyle(char) {
  const h = hueFor(char.name);
  return `background: linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${(h + 45) % 360} 70% 34%))`;
}
function avatarInner(char) {
  return char.avatar
    ? `<img src="${char.avatar}" alt="" />`
    : `<span>${(char.name || '?').trim().charAt(0).toUpperCase()}</span>`;
}

/* ─────────── Sidebar ─────────── */
function renderSidebar() {
  const list = $('#charList');
  list.innerHTML = '';
  state.characters.forEach((char) => {
    const btn = document.createElement('button');
    btn.className = 'char-btn' + (char.id === state.activeId ? ' active' : '');
    btn.style.cssText = avatarStyle(char);
    btn.innerHTML = avatarInner(char) + `<span class="tip">${escapeHtml(char.name)}</span>`;
    btn.title = char.name;
    btn.addEventListener('click', () => selectChar(char.id));
    list.appendChild(btn);
  });
  $('#addCharBtn').classList.toggle('pulse', state.characters.length === 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ─────────── Header ─────────── */
function renderHeader() {
  const char = activeChar();
  const av = $('#headerAvatar');
  if (char) {
    av.style.cssText = avatarStyle(char);
    av.innerHTML = avatarInner(char);
    $('#headerName').textContent = char.name;
    $('#headerStatus').textContent = 'last seen a long time ago';
    $('#composer').classList.remove('disabled');
    $('#msgInput').disabled = false;
    $('#sendBtn').disabled = false;
    $('#chatHeader').classList.remove('is-hidden');
    $('#composer').classList.remove('is-hidden');
  } else {
    av.style.cssText = 'background: linear-gradient(135deg,#37d67a,#1d8f52)';
    av.textContent = 'W';
    $('#headerName').textContent = 'Woxaum';
    $('#headerStatus').textContent = 'No chats yet';
    $('#composer').classList.add('disabled', 'is-hidden');
    $('#msgInput').disabled = true;
    $('#sendBtn').disabled = true;
    $('#chatHeader').classList.add('is-hidden');
  }
}

/* ─────────── Messages / empty states ─────────── */
function renderMessages() {
  const char = activeChar();
  const msgs = char ? state.messages[char.id] || [] : [];
  const wrap = $('#emptyWrap');
  const list = $('#msgList');

  if (!char) {
    wrap.classList.remove('hidden');
    list.innerHTML = '';
  } else if (msgs.length === 0) {
    // fresh chat — pure background, the character never speaks first
    wrap.classList.add('hidden');
    list.innerHTML = '';
  } else {
    wrap.classList.add('hidden');
    list.innerHTML = msgs.map((m) => {
      const body = m.pending
        ? (m.text ? escapeHtml(m.text) + '<span class="caret"></span>' : '<span class="typing"><i></i><i></i><i></i></span>')
        : escapeHtml(m.text);
      const stamp = m.pending ? '' : `<span class="time">${m.time}</span>`;
      const bubble = `<div class="bubble ${m.role === 'out' ? 'out' : 'in'}${m.pending ? ' pending' : ''}">${body}${stamp}</div>`;
      const retry = m.failed
        ? `<button class="retry-btn" data-retry="1" title="${escapeHtml(m.error || 'Retry')}">↻ Retry</button>`
        : '';
      const err = m.failed && m.error ? `<div class="row-error">${escapeHtml(m.error)}</div>` : '';
      return `<div class="row-wrap"><div class="row ${m.role === 'out' ? 'out' : 'in'}">${bubble}</div>${retry}${err}</div>`;
    }).join('');
    requestAnimationFrame(() => { $('#messages').scrollTop = $('#messages').scrollHeight; });
  }
}

function renderAll() { renderSidebar(); renderHeader(); renderMessages(); }

function selectChar(id) {
  state.activeId = id;
  save();
  renderAll();
  $('#msgInput').focus();
}

function pushMessage(role, text) {
  const char = activeChar();
  if (!char) return;
  (state.messages[char.id] = state.messages[char.id] || []).push({ role, text, time: nowTime() });
  save();
  renderMessages();
}

/* ─────────── Composer ─────────── */
const input = $('#msgInput');
function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}
function toggleSendIcon() {
  const hasText = input.value.trim().length > 0;
  $('.ic-mic').style.display = hasText ? 'none' : '';
  $('.ic-send').style.display = hasText ? '' : 'none';
  $('#sendBtn').title = hasText ? 'Send' : 'Voice message';
}
input.addEventListener('input', () => { autoResize(); toggleSendIcon(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const char = activeChar();
  if (!char) { openCreateModal(); return; }
  if (!text) { toast('Voice messages are visual only for now'); return; }
  if (aiBusy) return;
  pushMessage('out', text);
  input.value = '';
  autoResize(); toggleSendIcon();
  askAI(char);
});

/* ─────────── Create character modal ─────────── */
let tempAvatar = null;
let tempFileName = '';
let tempFileText = '';
let editingId = null;

function openModal(char = null) {
  resetModal();
  if (char) {
    editingId = char.id;
    tempAvatar = char.avatar || null;
    tempFileName = char.fileName || '';
    tempFileText = char.fileText || '';
    $('#modalTitle').textContent = 'Edit character';
    $('#createBtn').textContent = 'Save changes';
    $('#charName').value = char.name || '';
    $('#charDesc').value = char.desc || '';
    $('#charGreeting').value = char.greeting || '';
    const prev = $('#avatarPreview');
    if (tempAvatar) {
      prev.innerHTML = `<img src="${tempAvatar}" alt="" />`;
      prev.style.cssText = '';
      $('#avatarRemoveBtn').style.display = '';
    } else {
      prev.style.cssText = `background: linear-gradient(135deg, hsl(${hueFor(char.name)} 70% 45%), hsl(${(hueFor(char.name) + 45) % 360} 70% 34%))`;
      prev.textContent = (char.name || '?').trim().charAt(0).toUpperCase() || '?';
      $('#avatarRemoveBtn').style.display = 'none';
    }
    if (tempFileName) {
      $('#fileDrop').classList.add('has-file');
      $('#fileDropText').textContent = '📄 ' + tempFileName;
    }
  }
  $('#overlay').classList.add('open');
  setTimeout(() => $('#charName').focus(), 60);
}
function openCreateModal() { editingId = null; openModal(null); }
function closeModal() { $('#overlay').classList.remove('open'); }
function resetModal() {
  editingId = null;
  tempAvatar = null; tempFileName = ''; tempFileText = '';
  $('#charName').value = ''; $('#charDesc').value = ''; $('#charGreeting').value = '';
  $('#avatarInput').value = ''; $('#charFileInput').value = '';
  $('#avatarPreview').style.cssText = 'background: linear-gradient(135deg,#37d67a,#1d8f52)';
  $('#avatarPreview').textContent = '?';
  $('#avatarRemoveBtn').style.display = 'none';
  $('#fileDrop').classList.remove('has-file');
  $('#fileDropText').textContent = 'Tap to choose a file, or drop it here';
  $('#modalTitle').textContent = 'New character';
  $('#createBtn').textContent = 'Create character';
}

$('#addCharBtn').addEventListener('click', () => openCreateModal());
$('#emptyAddBtn').addEventListener('click', () => openCreateModal());
$('#closeModalBtn').addEventListener('click', closeModal);
$('#cancelBtn').addEventListener('click', closeModal);
$('#overlay').addEventListener('click', (e) => { if (e.target === $('#overlay')) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); closeProfile(); closeAiModal(); closeAdmin(); $('#moreMenu').classList.remove('open'); }
});

$('#charName').addEventListener('input', (e) => {
  const name = e.target.value.trim();
  if (!tempAvatar) $('#avatarPreview').textContent = name ? name.charAt(0).toUpperCase() : '?';
});

$('#avatarUploadBtn').addEventListener('click', () => $('#avatarInput').click());
$('#avatarInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    tempAvatar = reader.result;
    $('#avatarPreview').innerHTML = `<img src="${tempAvatar}" alt="" />`;
    $('#avatarPreview').style.cssText = '';
    $('#avatarRemoveBtn').style.display = '';
  };
  reader.readAsDataURL(file);
});
$('#avatarRemoveBtn').addEventListener('click', () => {
  tempAvatar = null;
  $('#avatarInput').value = '';
  $('#avatarPreview').innerHTML = '';
  $('#avatarPreview').style.cssText = 'background: linear-gradient(135deg,#37d67a,#1d8f52)';
  $('#avatarPreview').textContent = ($('#charName').value.trim().charAt(0) || '?').toUpperCase();
  $('#avatarRemoveBtn').style.display = 'none';
});

const fileDrop = $('#fileDrop');
fileDrop.addEventListener('click', (e) => { e.preventDefault(); $('#charFileInput').click(); });
$('#charFileInput').addEventListener('change', (e) => setFile(e.target.files[0]));
['dragover', 'dragenter'].forEach((ev) => fileDrop.addEventListener(ev, (e) => { e.preventDefault(); fileDrop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => fileDrop.addEventListener(ev, (e) => { e.preventDefault(); fileDrop.classList.remove('drag'); }));
fileDrop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
function setFile(file) {
  if (!file) return;
  tempFileName = file.name;
  tempFileText = '';
  fileDrop.classList.add('has-file');
  $('#fileDropText').textContent = '📄 ' + file.name;
  // keep the text itself so the AI can actually read the character file
  if (file.size <= 400 * 1024 && /\.(txt|md|json|ya?ml)$/i.test(file.name)) {
    const reader = new FileReader();
    reader.onload = () => {
      tempFileText = String(reader.result || '').slice(0, 20000);
      $('#fileDropText').textContent = '📄 ' + file.name + ` (${Math.round(String(reader.result).length / 1000)}k chars)`;
    };
    reader.readAsText(file);
  }
}

$('#createBtn').addEventListener('click', () => {
  const name = $('#charName').value.trim();
  if (!name) { toast('Enter a character name first'); $('#charName').focus(); return; }
  const data = {
    name,
    avatar: tempAvatar,
    desc: $('#charDesc').value.trim(),
    fileName: tempFileName,
    fileText: tempFileText,
    greeting: $('#charGreeting').value.trim(),
  };

  if (editingId) {
    const char = state.characters.find((c) => c.id === editingId);
    if (char) Object.assign(char, data);
    save();
    resetModal();
    closeModal();
    renderAll();
    toast(`"${name}" updated`);
    return;
  }

  const char = { id: uid(), createdAt: new Date().toISOString(), ...data };
  state.characters.push(char);
  state.activeId = char.id;
  save();
  resetModal();
  closeModal();
  renderAll();
  toast(`"${name}" created — say hello!`);
});

/* ─────────── Header actions ─────────── */
// calls: hidden for now, will be built later
const callBtn = $('#callBtn');
if (callBtn) callBtn.addEventListener('click', () => toast('Calls are visual only for now'));
$('#attachBtn').addEventListener('click', () => toast('Attachments are visual only for now'));
$('#emojiBtn').addEventListener('click', () => toast('Emoji picker is visual only for now'));

$('#moreBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!activeChar()) { toast('No character selected'); return; }
  $('#moreMenu').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap')) $('#moreMenu').classList.remove('open');
});
$('#editCharBtn').addEventListener('click', () => {
  const char = activeChar();
  if (!char) return;
  $('#moreMenu').classList.remove('open');
  openModal(char);
});
$('#deleteCharBtn').addEventListener('click', () => {
  const char = activeChar();
  if (!char) return;
  state.characters = state.characters.filter((c) => c.id !== char.id);
  delete state.messages[char.id];
  state.activeId = state.characters[0]?.id || null;
  $('#moreMenu').classList.remove('open');
  save();
  renderAll();
  toast(`"${char.name}" deleted`);
});

/* ─────────── Your profile ─────────── */
let tempProfileAvatar = null;
let tempGender = '';
let tempScale = DEFAULT_UI_SCALE;
let tempScalePreview = null;

function uiScale() {
  const value = Number(state.profile && state.profile.uiScale);
  return value >= 1 && value <= 2 ? value : DEFAULT_UI_SCALE;
}

function applyUiScale() {
  const root = document.documentElement;
  if (window.innerWidth <= 640) {
    // phones keep their own compact sizing
    root.style.removeProperty('--u');
    return;
  }
  root.style.setProperty('--u', String(tempScalePreview ?? uiScale()));
}

window.addEventListener('resize', () => {
  if (tempScalePreview === null) applyUiScale();
});

function paintScaleChips() {
  document.querySelectorAll('#uiScaleChips .chip').forEach((chip) => {
    chip.classList.toggle('active', Math.abs(Number(chip.dataset.scale) - tempScale) < 0.001);
  });
}

function profileInitial() {
  const n = (state.profile.name || '').trim();
  return n ? n.charAt(0).toUpperCase() : 'Y';
}

function renderProfile() {
  const btn = $('#meAvatarBtn');
  if (state.profile.avatar) {
    btn.innerHTML = `<img src="${state.profile.avatar}" alt="" />`;
  } else {
    btn.textContent = profileInitial();
  }
  btn.title = state.profile.name ? `${state.profile.name} — profile` : 'Your profile';
}

function paintProfilePreview() {
  const prev = $('#profileAvatarPreview');
  if (tempProfileAvatar) {
    prev.innerHTML = `<img src="${tempProfileAvatar}" alt="" />`;
    prev.style.cssText = '';
    $('#profileAvatarRemoveBtn').style.display = '';
  } else {
    prev.innerHTML = '';
    prev.style.cssText = '';
    prev.textContent = ($('#profileName').value.trim().charAt(0) || 'Y').toUpperCase();
    $('#profileAvatarRemoveBtn').style.display = 'none';
  }
}

function paintGenderChips() {
  document.querySelectorAll('#genderChips .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.gender === tempGender);
  });
}

function openProfile() {
  tempProfileAvatar = state.profile.avatar || null;
  tempGender = state.profile.gender || '';
  $('#profileName').value = state.profile.name || '';
  tempScale = uiScale();
  tempScalePreview = null;
  paintScaleChips();
  applyUiScale();
  paintProfilePreview();
  paintGenderChips();
  $('#profileOverlay').classList.add('open');
  setTimeout(() => $('#profileName').focus(), 60);
}
function closeProfile() {
  $('#profileOverlay').classList.remove('open');
  tempScalePreview = null;
  applyUiScale();
}

$('#meAvatarBtn').addEventListener('click', openProfile);
$('#closeProfileBtn').addEventListener('click', closeProfile);
$('#profileCancelBtn').addEventListener('click', closeProfile);
$('#profileOverlay').addEventListener('click', (e) => { if (e.target === $('#profileOverlay')) closeProfile(); });

$('#profileName').addEventListener('input', () => { if (!tempProfileAvatar) paintProfilePreview(); });
$('#profileAvatarBtn').addEventListener('click', () => $('#profileAvatarInput').click());
$('#profileAvatarInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { tempProfileAvatar = reader.result; paintProfilePreview(); };
  reader.readAsDataURL(file);
});
$('#profileAvatarRemoveBtn').addEventListener('click', () => {
  tempProfileAvatar = null;
  $('#profileAvatarInput').value = '';
  paintProfilePreview();
});

$('#genderChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  tempGender = tempGender === chip.dataset.gender ? '' : chip.dataset.gender;
  paintGenderChips();
});

$('#uiScaleChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  tempScale = Number(chip.dataset.scale) || DEFAULT_UI_SCALE;
  tempScalePreview = tempScale;
  paintScaleChips();
  applyUiScale();
});

$('#profileSaveBtn').addEventListener('click', () => {
  state.profile = {
    name: $('#profileName').value.trim(),
    avatar: tempProfileAvatar,
    gender: tempGender,
    uiScale: tempScale,
  };
  tempScalePreview = null;
  applyUiScale();
  save();
  renderProfile();
  closeProfile();
  toast('Profile saved');
});


/* ─────────── AI: settings ─────────── */
const PROVIDERS = {
  gemini:     { kind: 'gemini', label: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey', placeholder: 'AIza…' },
  openrouter: { kind: 'openai', label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', placeholder: 'sk-or-v1-…' },
  groq:       { kind: 'openai', label: 'Groq', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', placeholder: 'gsk_…' },
  custom:     { kind: 'openai', label: 'Custom', base: '', keyUrl: '', placeholder: 'API key' },
};
const providerOf = (id) => PROVIDERS[id] || PROVIDERS.gemini;

function openAiModal() {
  const ai = state.ai;
  $('#aiProvider').value = ai.provider || 'gemini';
  $('#aiKey').value = ai.key || '';
  $('#aiKey').type = 'password';
  $('#aiModel').value = ai.model || '';
  $('#aiBase').value = ai.base || '';
  syncAiFields();
  $('#aiOverlay').classList.add('open');
}
function closeAiModal() { $('#aiOverlay').classList.remove('open'); }

function syncAiFields() {
  const id = $('#aiProvider').value;
  const p = providerOf(id);
  $('#aiBaseField').style.display = id === 'custom' ? '' : 'none';
  $('#aiKey').placeholder = p.placeholder;
  const link = $('#aiKeyLink');
  if (p.keyUrl) { link.href = p.keyUrl; link.style.display = ''; }
  else { link.style.display = 'none'; }
  setAiHint(id === 'openrouter'
    ? 'Free keys see the ":free" models (Gemma, Nemotron, Qwen…). Tap “Load list”.'
    : 'Tap “Load list” to see the models your key can use.', false);
}

$('#aiBtn').addEventListener('click', openAiModal);
$('#menuAiBtn').addEventListener('click', () => { $('#moreMenu').classList.remove('open'); openAiModal(); });
$('#closeAiBtn').addEventListener('click', closeAiModal);
$('#aiCancelBtn').addEventListener('click', closeAiModal);
$('#aiOverlay').addEventListener('click', (e) => { if (e.target === $('#aiOverlay')) closeAiModal(); });
$('#aiProvider').addEventListener('change', syncAiFields);
$('#aiKeyToggle').addEventListener('click', () => {
  const el = $('#aiKey');
  el.type = el.type === 'password' ? 'text' : 'password';
});

function aiBaseUrl() {
  const id = $('#aiProvider').value;
  const p = providerOf(id);
  const raw = id === 'custom' ? $('#aiBase').value : p.base;
  return String(raw || '').trim().replace(/\/+$/, '');
}

function shorten(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function setAiHint(text, isError) {
  const el = $('#aiModelHint');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

/** Pick a sane default: real chat models first, retired previews and media models last. */
function pickModel(ids, providerId) {
  const score = (id) => {
    if (/image|tts|embedding|transcribe|robotics|lyria|computer-use|deep-research|antigravity|omni/i.test(id)) return -1000;
    let n;
    if (/flash-lite/i.test(id)) n = 60;
    else if (/flash/i.test(id)) n = 80;
    else if (/pro/i.test(id)) n = 70;
    else if (/gemma/i.test(id)) n = 55;
    else if (/nemotron|qwen|glm|llama|mistral|deepseek/i.test(id)) n = 50;
    else n = 20;
    const version = id.match(/(\d+(?:\.\d+)?)/);
    if (version) n += Math.min(parseFloat(version[1]), 9) / 10;
    if (/preview|exp/i.test(id)) n -= 1;
    if (/latest/i.test(id)) n -= 2;
    return n;
  };
  return [...ids].sort((a, b) => score(b) - score(a))[0] || ids[0];
}

async function fetchModelList(providerId, key, base) {
  const p = providerOf(providerId);
  if (p.kind === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
    if (!res.ok) throw new Error(await errText(res));
    const data = await res.json();
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(await errText(res));
  const data = await res.json();
  let ids = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
  if (providerId === 'openrouter') {
    const free = ids.filter((id) => id.endsWith(':free'));
    if (free.length) ids = free;
  }
  return ids.sort();
}

$('#aiLoadModels').addEventListener('click', async () => {
  const key = $('#aiKey').value.trim();
  const providerId = $('#aiProvider').value;
  const base = aiBaseUrl();
  if (!key) { toast('Paste your API key first'); $('#aiKey').focus(); return; }
  if (providerId === 'custom' && !base) { toast('Enter the base URL first'); $('#aiBase').focus(); return; }
  const btn = $('#aiLoadModels');
  btn.disabled = true; btn.textContent = '…';
  setAiHint('Loading models…', false);
  try {
    const ids = await fetchModelList(providerId, key, base);
    if (!ids.length) throw new Error('No models returned — check the key');
    $('#aiModels').innerHTML = ids.map((id) => `<option value="${escapeHtml(id)}"></option>`).join('');
    const cur = $('#aiModel').value.trim();
    if (!cur || !ids.includes(cur)) $('#aiModel').value = pickModel(ids, providerId);
    setAiHint(`${ids.length} models available — pick one from the list.`, false);
  } catch (err) {
    const msg = String(err.message || err);
    setAiHint('Could not load models: ' + msg, true);
    toast('Could not load models: ' + shorten(msg, 200), 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Load list';
  }
});

function updateAiIndicator() {
  $('#aiBtn').classList.toggle('configured', !!(state.ai.key && state.ai.model));
}

function saveAiSettings(silent) {
  state.ai = {
    provider: $('#aiProvider').value,
    key: $('#aiKey').value.trim(),
    model: $('#aiModel').value.trim(),
    base: $('#aiBase').value.trim(),
  };
  save();
  updateAiIndicator();
  if (!silent) toast(state.ai.key && state.ai.model ? 'AI connected' : 'Saved — add a key and a model');
}
$('#aiSaveBtn').addEventListener('click', () => { saveAiSettings(false); closeAiModal(); });

/* ─────────── AI: talking to the model ─────────── */
function buildSystemPrompt(char) {
  const me = state.profile || {};
  const out = [
    `You are roleplaying as "${char.name}" in a private text chat. Stay in character at all times. Never mention being an AI, a model or an assistant.`,
    '',
    'HOW TO WRITE:',
    '- Write like a real person texting: natural, 1–3 short paragraphs max unless the user asks for more.',
    '- Reply ONLY as your character. Never write the user’s lines, thoughts or actions.',
    '- No markdown headings, no bullet lists, no stage directions in asterisks unless it fits the character.',
    '- Stay consistent with your character’s voice, memory and mood across the whole conversation.',
    '',
    `WHO YOU ARE — ${char.name}:`,
    char.desc || '(no description given — invent a coherent personality and keep it consistent)',
  ];
  if (char.fileText) out.push('', 'CHARACTER FILE (source of truth, follow it):', char.fileText);
  else if (char.fileName) out.push('', `(The user attached a character file named ${char.fileName}, but its text was not loaded.)`);
  if (char.greeting) out.push('', `A line that sounds like you: "${char.greeting}"`);
  out.push('', `You are talking to ${me.name || 'the user'}${me.gender ? ` (${me.gender})` : ''}.`);
  out.push('', 'Answer the last user message in character, in the language they use.');
  return out.join('\n');
}

function httpError(res, text) {
  const err = new Error(text);
  err.status = res.status;
  return err;
}

async function errText(res) {
  let raw = '';
  try { raw = await res.text(); } catch (e) { /* ignore */ }
  try {
    const j = JSON.parse(raw);
    raw = j.error?.message || j.message || raw;
  } catch (e) { /* plain text */ }
  return `${res.status} ${res.statusText}${raw ? ' — ' + String(raw).slice(0, 200) : ''}`;
}

async function readSSE(res, onObject) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onObject(JSON.parse(payload)); } catch (e) { /* partial json */ }
    }
  }
}

async function streamOpenAI(ai, system, history, onDelta) {
  const p = providerOf(ai.provider);
  const base = (ai.provider === 'custom' ? ai.base : p.base).replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.key}` };
  if (ai.provider === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Woxaum';
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: ai.model,
      stream: true,
      temperature: 0.9,
      messages: [{ role: 'system', content: system }, ...history],
    }),
  });
  if (!res.ok) throw httpError(res, await errText(res));
  await readSSE(res, (obj) => {
    const d = obj.choices?.[0]?.delta?.content;
    if (d) onDelta(d);
  });
}

async function streamGemini(ai, system, history, onDelta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(ai.key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature: 0.9, maxOutputTokens: 1024 },
    }),
  });
  if (!res.ok) throw httpError(res, await errText(res));
  await readSSE(res, (obj) => {
    const t = (obj.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (t) onDelta(t);
  });
}

let aiBusy = false;
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderMessages(); });
}

const RETRIABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetriable(err) {
  if (!err) return false;
  if (err.status && RETRIABLE.has(err.status)) return true;
  return /high demand|overload|temporar|rate limit|quota|failed to fetch|network/i.test(String(err.message || ''));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function askAI(char) {
  if (aiBusy) return;
  const ai = state.ai;
  if (!ai.key || !ai.model) {
    toast('Connect an AI first — gear icon at the bottom left', 5000);
    openAiModal();
    return;
  }

  const list = (state.messages[char.id] = state.messages[char.id] || []);
  const lastOut = [...list].reverse().find((m) => m.role === 'out');
  if (lastOut) { delete lastOut.failed; delete lastOut.error; }

  const reply = { role: 'in', text: '', time: nowTime(), pending: true };
  list.push(reply);
  aiBusy = true;
  $('#sendBtn').disabled = true;
  $('#headerStatus').textContent = 'typing…';
  renderMessages();

  try {
    const history = list
      .filter((m) => m !== reply && m.text)
      .slice(-30)
      .map((m) => ({ role: m.role === 'out' ? 'user' : 'assistant', content: m.text }));
    const system = buildSystemPrompt(char);

    const attempt = async () => {
      reply.text = '';
      scheduleRender();
      if (providerOf(ai.provider).kind === 'gemini') {
        await streamGemini(ai, system, history, (d) => { reply.text += d; scheduleRender(); });
      } else {
        await streamOpenAI(ai, system, history, (d) => { reply.text += d; scheduleRender(); });
      }
    };

    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        await attempt();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isRetriable(err) || i === 2) break;
        $('#headerStatus').textContent = `retrying… (${i + 2}/3)`;
        toast(`${shorten(err.message || err, 140)} — retrying…`, 4000);
        await wait(i === 0 ? 1800 : 4500);
      }
    }
    if (lastErr) throw lastErr;

    reply.text = reply.text.trim();
    if (!reply.text) throw new Error('The model returned an empty reply');
    delete reply.pending;

    // 503/429 usually means "this model is busy" — offer the way out once
    if (lastOut) { delete lastOut.failed; delete lastOut.error; }
  } catch (err) {
    const i = list.indexOf(reply);
    if (i > -1) list.splice(i, 1);
    const msg = String(err.message || err);
    if (lastOut) {
      lastOut.failed = true;
      lastOut.error = shorten(msg, 220);
    }
    const busy = err.status === 429 || err.status === 503 || isRetriable(err);
    toast('AI error: ' + shorten(msg, 260) + (busy ? '  ·  try another model in ⚙' : ''), 9000);
  } finally {
    aiBusy = false;
    $('#sendBtn').disabled = false;
    $('#headerStatus').textContent = activeChar() ? 'last seen a long time ago' : 'No chats yet';
    save();
    renderMessages();
  }
}

/* Retry from the failed message */
$('#msgList').addEventListener('click', (e) => {
  const btn = e.target.closest('.retry-btn');
  if (!btn) return;
  const char = activeChar();
  if (!char) return;
  btn.disabled = true;
  askAI(char);
});

$('#aiTestBtn').addEventListener('click', async () => {
  const key = $('#aiKey').value.trim();
  const model = $('#aiModel').value.trim();
  if (!key || !model) { toast('Enter a key and a model first'); return; }
  const btn = $('#aiTestBtn');
  btn.disabled = true; btn.textContent = 'Testing…';
  try {
    const draft = { provider: $('#aiProvider').value, key, model, base: aiBaseUrl() };
    let got = '';
    const onDelta = (d) => { got += d; };
    if (providerOf(draft.provider).kind === 'gemini') {
      await streamGemini(draft, 'You are a test. Answer with the single word: ok', [{ role: 'user', content: 'ping' }], onDelta);
    } else {
      await streamOpenAI(draft, 'You are a test. Answer with the single word: ok', [{ role: 'user', content: 'ping' }], onDelta);
    }
    toast(got.trim() ? 'Works — model replied' : 'Connected, but the reply was empty');
  } catch (err) {
    setAiHint('Test failed: ' + shorten(err.message || err, 260), true);
    toast('Failed: ' + shorten(err.message || err, 220), 9000);
  } finally {
    btn.disabled = false; btn.textContent = 'Test';
  }
});


/* ─────────── Export .txt ─────────── */
function safeFileName(name) {
  return String(name || 'character').replace(/[\\/:*?"<>|\n\r]+/g, '_').trim().slice(0, 60) || 'character';
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function characterToText(char) {
  const lines = [];
  lines.push(`CHARACTER — ${char.name}`);
  if (char.createdAt) lines.push(`created: ${new Date(char.createdAt).toLocaleString()}`);
  lines.push('', 'DESCRIPTION', '-----------', char.desc || '(empty)', '');
  if (char.fileText) lines.push('CHARACTER FILE', '--------------', char.fileText, '');
  else if (char.fileName) lines.push(`ATTACHED FILE: ${char.fileName} (text was not read)`, '');
  lines.push('GREETING', '--------', char.greeting || '(empty)', '', '— exported from Woxaum');
  return lines.join('\n');
}

function chatToText(char) {
  const msgs = state.messages[char.id] || [];
  const me = (state.profile && state.profile.name) || 'Me';
  const lines = [
    `CHAT — ${char.name}`,
    `exported: ${new Date().toLocaleString()}`,
    ''.padEnd(40, '-'),
    '',
  ];
  msgs.filter((m) => !m.pending).forEach((m) => {
    lines.push(`[${m.time}] ${m.role === 'out' ? me : char.name}: ${m.text}`);
  });
  return lines.join('\n');
}

function exportCharacter() {
  const char = activeChar();
  if (!char) { toast('No character selected'); return; }
  downloadText(`${safeFileName(char.name)}.txt`, characterToText(char));
  toast(`${char.name}.txt downloaded`, 3000);
}

function exportChat() {
  const char = activeChar();
  if (!char) { toast('No character selected'); return; }
  const msgs = (state.messages[char.id] || []).filter((m) => !m.pending);
  if (!msgs.length) { toast('No messages to export yet'); return; }
  downloadText(`${safeFileName(char.name)}-chat.txt`, chatToText(char));
  toast('Chat exported as .txt', 3000);
}

$('#exportCharBtn').addEventListener('click', exportCharacter);
$('#exportChatBtn').addEventListener('click', () => {
  $('#moreMenu').classList.remove('open');
  exportChat();
});

/* ─────────── Toast ─────────── */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}



/* ─────────── Local mode (static hosting, no backend) ───────────
   GitHub Pages cannot run Python, so when /api/health is missing the app
   keeps accounts in this browser instead: same endpoints, same screens. */
const LOCAL_KEY = 'woxaum-local-v1';

function localDb() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || null; } catch (e) { return null; }
}
function localPersist(db) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(db)); } catch (e) { /* full */ }
}
function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}
function localUserPublic(u) {
  return { id: u.id, login: u.login, isAdmin: !!u.isAdmin, createdAt: u.createdAt };
}
function localUserByToken(db, tk) {
  const sid = db.session && db.session.token === tk ? db.session.userId : null;
  return sid ? db.users.find((u) => u.id === sid) || null : null;
}

async function localHash(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function localAddUser(db, login, password, isAdmin) {
  const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const user = {
    id: db.seq++,
    login,
    salt,
    hash: await localHash(password, salt),
    isAdmin: !!isAdmin,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  return user;
}

async function localInit() {
  const db = localDb() || { seq: 1, users: [], data: {}, session: null };
  if (typeof db.seq !== 'number') db.seq = 1;
  if (!Array.isArray(db.users)) db.users = [];
  if (!db.data) db.data = {};
  if (!db.users.length) await localAddUser(db, 'admin', 'admin', true);
  localPersist(db);
}

async function localApi(path, { method = 'GET', body } = {}) {
  await localInit();
  const db = localDb();
  const route = path.split('?')[0];
  const me = localUserByToken(db, token);

  const needUser = () => {
    if (!me) throw fail('Not signed in', 401);
    return me;
  };
  const needAdmin = () => {
    const user = needUser();
    if (!user.isAdmin) throw fail('Admins only', 403);
    return user;
  };

  if (route === '/api/health') return { ok: true, mode: 'local' };

  if (route === '/api/me') return { user: localUserPublic(needUser()) };

  if (route === '/api/register') {
    const login = (body.login || '').trim();
    if (!/^[\w.-]{3,24}$/.test(login)) throw fail('Login: 3–24 chars, letters, digits, _ . -', 400);
    if ((body.password || '').length < 4) throw fail('Password must be at least 4 characters', 400);
    if (db.users.some((u) => u.login.toLowerCase() === login.toLowerCase())) throw fail('That login is taken', 409);
    const user = await localAddUser(db, login, body.password, false);
    db.session = { token: 'local-' + Math.random().toString(36).slice(2), userId: user.id };
    localPersist(db);
    return { token: db.session.token, user: localUserPublic(user) };
  }

  if (route === '/api/login') {
    const login = (body.login || '').trim().toLowerCase();
    const user = db.users.find((u) => u.login.toLowerCase() === login);
    if (!user) throw fail('Wrong login or password', 401);
    const hash = await localHash(body.password || '', user.salt);
    if (hash !== user.hash) throw fail('Wrong login or password', 401);
    db.session = { token: 'local-' + Math.random().toString(36).slice(2), userId: user.id };
    localPersist(db);
    return { token: db.session.token, user: localUserPublic(user) };
  }

  if (route === '/api/logout') {
    db.session = null;
    localPersist(db);
    return { ok: true };
  }

  if (route === '/api/state') {
    const user = needUser();
    if (method === 'PUT') {
      db.data[user.id] = body.state;
      localPersist(db);
      return { ok: true };
    }
    return { state: db.data[user.id] ?? null };
  }

  if (route === '/api/admin/users') {
    needAdmin();
    return { users: db.users.map(localUserPublic) };
  }

  if (route === '/api/admin/create') {
    needAdmin();
    const login = (body.login || '').trim();
    if (!/^[\w.-]{3,24}$/.test(login) || (body.password || '').length < 4) throw fail('Check the login and password', 400);
    if (db.users.some((u) => u.login.toLowerCase() === login.toLowerCase())) throw fail('That login is taken', 409);
    const user = await localAddUser(db, login, body.password, !!body.isAdmin);
    localPersist(db);
    return { user: localUserPublic(user) };
  }

  if (route === '/api/admin/delete') {
    const user = needAdmin();
    if (body.id === user.id) throw fail('You cannot delete your own account', 400);
    const target = db.users.find((u) => u.id === body.id);
    if (!target) throw fail('No such user', 404);
    if (target.isAdmin && db.users.filter((u) => u.isAdmin).length <= 1) throw fail('Keep at least one admin', 400);
    db.users = db.users.filter((u) => u.id !== body.id);
    delete db.data[body.id];
    if (db.session && db.session.userId === body.id) db.session = null;
    localPersist(db);
    return { ok: true };
  }

  if (route === '/api/admin/password') {
    const user = needUser();
    if (!user.isAdmin && body.id !== user.id) throw fail('Admins only', 403);
    if ((body.password || '').length < 4) throw fail('Password must be at least 4 characters', 400);
    const target = db.users.find((u) => u.id === body.id);
    if (!target) throw fail('No such user', 404);
    target.salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
    target.hash = await localHash(body.password, target.salt);
    localPersist(db);
    return { ok: true };
  }

  throw fail('Not found', 404);
}

/* ─────────── Accounts ─────────── */
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  const reg = mode === 'register';
  $('#authTitle').textContent = reg ? 'Create account' : 'Sign in';
  const local = appMode === 'local';
  $('#authSub').textContent = reg
    ? (local ? 'Web version: the account is stored in this browser.' : 'One account per person — characters, chats and settings stay inside it.')
    : (local ? 'Web version (static hosting): accounts live in this browser. Try admin / admin.' : 'Characters and chats live in your account, on this server.');
  $('#authSubmit').textContent = reg ? 'Create account' : 'Sign in';
  $('#authPassword2Field').hidden = !reg;
  $('#authPassword').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  $('#authSwitch').innerHTML = reg
    ? 'Already have an account? <button class="linkbtn" id="authToggle" type="button">Sign in</button>'
    : 'No account yet? <button class="linkbtn" id="authToggle" type="button">Create one</button>';
  $('#authToggle').addEventListener('click', () => setAuthMode(reg ? 'login' : 'register'));
  $('#authError').textContent = '';
}

function showAuthError(msg) { $('#authError').textContent = msg || ''; }

function showAuth() {
  $('#appRoot').hidden = true;
  $('#authScreen').hidden = false;
  setAuthMode('login');
  setTimeout(() => $('#authLogin').focus(), 60);
}

async function enterApp(user) {
  currentUser = user;
  const res = await api('/api/state');
  let seed = res.state;
  if (!seed) {
    // one-time import of data created before accounts existed
    try {
      const legacy = JSON.parse(localStorage.getItem('woxaum-v1'));
      if (legacy && Array.isArray(legacy.characters) && legacy.characters.length) seed = legacy;
    } catch (e) { /* nothing to import */ }
  }
  adoptState(seed);
  if (!res.state && seed) await pushState();
  localStorage.removeItem('woxaum-v1');

  $('#authScreen').hidden = true;
  $('#appRoot').hidden = false;
  $('#menuAdminBtn').hidden = !user.isAdmin;
  $('#aiBtn').hidden = false;
  renderAll();
  renderProfile();
  updateAiIndicator();
  applyUiScale();
  toggleSendIcon();
  $('#accountLabel').textContent = `Signed in as ${user.login}${user.isAdmin ? ' · admin' : ''}`;
}

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const login = $('#authLogin').value.trim();
  const password = $('#authPassword').value;
  if (login.length < 3) { showAuthError('Login must be at least 3 characters'); return; }
  if (password.length < 4) { showAuthError('Password must be at least 4 characters'); return; }
  if (authMode === 'register' && password !== $('#authPassword2').value) {
    showAuthError('Passwords do not match');
    return;
  }
  const btn = $('#authSubmit');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '…';
  showAuthError('');
  try {
    const data = await api(authMode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      body: { login, password },
    });
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    $('#authForm').reset();
    await enterApp(data.user);
    toast(authMode === 'login' ? `Welcome back, ${data.user.login}` : `Account ${data.user.login} created`);
  } catch (err) {
    showAuthError(err.message || 'Something went wrong');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#signOutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  token = '';
  currentUser = null;
  localStorage.removeItem(TOKEN_KEY);
  state = blankState();
  closeProfile();
  showAuth();
});

$('#changePassBtn').addEventListener('click', async () => {
  if (!currentUser) return;
  const pass = prompt(`New password for ${currentUser.login} (at least 4 characters):`);
  if (!pass) return;
  if (pass.length < 4) { toast('Password must be at least 4 characters'); return; }
  try {
    await api('/api/admin/password', { method: 'POST', body: { id: currentUser.id, password: pass } });
    toast('Password changed');
  } catch (err) {
    toast('Failed: ' + err.message);
  }
});

/* ─────────── Admin panel ─────────── */
async function refreshAdmin() {
  const box = $('#adminUsers');
  box.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const { users } = await api('/api/admin/users');
    box.innerHTML = users.map((u) => `
      <div class="admin-row">
        <div class="admin-who">
          <div class="admin-login">${escapeHtml(u.login)}${
            u.isAdmin ? '<span class="badge">admin</span>' : ''
          }${u.id === currentUser.id ? '<span class="badge you">you</span>' : ''}</div>
          <div class="admin-date">joined ${escapeHtml(String(u.createdAt || '').slice(0, 10))}</div>
        </div>
        <div class="admin-row-actions">
          <button class="btn btn-text" data-act="pass" data-id="${u.id}" data-login="${escapeHtml(u.login)}">Reset password</button>
          <button class="btn btn-text danger" data-act="del" data-id="${u.id}"${u.id === currentUser.id ? ' disabled' : ''}>Delete</button>
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
  }
}

async function openAdmin() {
  if (!currentUser || !currentUser.isAdmin) return;
  $('#moreMenu').classList.remove('open');
  $('#adminOverlay').classList.add('open');
  await refreshAdmin();
}
function closeAdmin() { $('#adminOverlay').classList.remove('open'); }

$('#menuAdminBtn').addEventListener('click', openAdmin);
$('#closeAdminBtn').addEventListener('click', closeAdmin);
$('#adminOverlay').addEventListener('click', (e) => { if (e.target === $('#adminOverlay')) closeAdmin(); });

$('#adminUsers').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const login = btn.dataset.login;
  if (btn.dataset.act === 'pass') {
    const pass = prompt(`New password for ${login}:`);
    if (!pass) return;
    try {
      await api('/api/admin/password', { method: 'POST', body: { id, password: pass } });
      toast(`Password for ${login} updated`);
    } catch (err) { toast('Failed: ' + err.message); }
    return;
  }
  if (!confirm(`Delete account "${login}" with all its characters and messages?`)) return;
  try {
    await api('/api/admin/delete', { method: 'POST', body: { id } });
    toast(`Account ${login} deleted`);
    await refreshAdmin();
  } catch (err) { toast('Failed: ' + err.message); }
});

$('#adminCreateBtn').addEventListener('click', async () => {
  const login = $('#adminNewLogin').value.trim();
  const password = $('#adminNewPass').value;
  if (!login || password.length < 4) { toast('Login + password (4+ chars) needed'); return; }
  try {
    await api('/api/admin/create', { method: 'POST', body: { login, password, isAdmin: $('#adminNewIsAdmin').checked } });
    $('#adminNewLogin').value = ''; $('#adminNewPass').value = ''; $('#adminNewIsAdmin').checked = false;
    toast(`Account ${login} created`);
    await refreshAdmin();
  } catch (err) { toast('Failed: ' + err.message); }
});

/* ─────────── Init ─────────── */

async function detectMode() {
  const host = location.hostname;
  const staticHost = /(^|\.)github\.io$/i.test(host) || /(^|\.)githubusercontent\.com$/i.test(host) || location.protocol === 'file:';
  if (staticHost) return 'local';
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const type = res.headers.get('content-type') || '';
    if (res.ok && type.includes('json')) {
      const data = await res.json();
      if (data && data.ok) return 'server';
    }
  } catch (e) { /* static hosting */ }
  return 'local';
}

async function boot() {
  appMode = await detectMode();
  if (appMode === 'local') await localInit();
  if (token && appMode === 'local' && !token.startsWith('local-')) {
    token = '';
    localStorage.removeItem(TOKEN_KEY);
  }
  if (token) {
    try {
      const { user } = await api('/api/me');
      await enterApp(user);
      return;
    } catch (err) {
      if (err.status === 401) {
        token = '';
        localStorage.removeItem(TOKEN_KEY);
      } else {
        showAuth();
        showAuthError('Server unreachable: ' + err.message + ' — start it with “python3 server.py”');
        return;
      }
    }
  }
  showAuth();
}

boot();
