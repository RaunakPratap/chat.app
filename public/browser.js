import "/firebase-config.js?v=79.0";
import { shouldAutoRequestNotifications } from "/notification-flow.mjs";

const GITHUB_BACKEND_URL_FILE = "https://raw.githubusercontent.com/RaunakPratap/chat.app/main/backend-url.txt";

const firebaseSetup = globalThis.__MYCHAT_FIREBASE__;
const hasFirebaseConfig = !!firebaseSetup?.firebaseConfig?.apiKey && !!firebaseSetup?.firebaseConfig?.appId && !!firebaseSetup?.vapidKey;
const { firebaseConfig, vapidKey } = firebaseSetup || {};
let messaging = null, firebaseApp = null, fcmFns = null, fcmListenerBound = false;

async function initFirebaseMessaging() {
  if (messaging && fcmFns) return true;
  if (!hasFirebaseConfig) return false;
  try {
    const [mod, appMod] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/12.17.1/firebase-messaging.js"),
      import("https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js")
    ]);
    if (typeof mod.isSupported === 'function' && !(await mod.isSupported())) return false;
    if (!firebaseApp) firebaseApp = appMod.initializeApp(firebaseConfig);
    messaging = mod.getMessaging(firebaseApp);
    fcmFns = { getToken: mod.getToken, onMessage: mod.onMessage };
    if (!fcmListenerBound && typeof fcmFns.onMessage === 'function') {
      fcmFns.onMessage(messaging, p => handleForegroundPush(p));
      fcmListenerBound = true;
    }
    return true;
  } catch {
    messaging = null;
    fcmFns = null;
    return false;
  }
}

let me = null, selected = null, lastId = 0, oldestId = 0, hasMoreHistory = false, loadingOlder = false;
let ids = new Set(), ws = null, wsRetry = 0, wsTimer = null, wsReady = false;
let typingTimer = null, typingSentTo = 0, readTimer = null;
let settings = {
  enter_to_send: true,
  typing_indicator: true,
  read_receipts: true,
  notifications: true,
  theme: 'light',
  wallpaper: 'classic',
  animations: true,
  message_density: 'comfortable',
  notification_preview: true,
  notification_vibrate: true,
  online_visibility: 'everyone',
  status_visibility: 'everyone',
  last_seen_visibility: 'everyone',
  dp_visibility: 'everyone'
};
let deferredInstallPrompt = null, notifiedIds = new Set(), pendingHistory = new Map(), pendingMessages = new Map();
let messageCache = new Map(), selectedMessageIds = new Set(), replyTarget = null, editingTarget = null;
let activeCall = null, pendingMedia = null, currentChatFilter = 'all', statusItems = [];
let __errorReportBusy = false, backendBase = '', backendResolvePromise = null;
const initialChatId = Number(new URLSearchParams(location.search).get('chat') || 0);

const EMOJI_CATEGORIES = {
  Smileys: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🤫 🤥 😶 🫠 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐'.split(' '),
  Gestures: '👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤏 💪 🙏 👏 🙌 🫶 🤝'.split(' '),
  Hearts: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝'.split(' '),
  Objects: '🎉 🎊 🎁 🎈 🔥 ⭐ 🌟 ✨ 💫 💥 💯 ✅ ❌ ⚡ 🚀 💎 🔒 🔑 📱 💻 🎵 🎧 📷'.split(' ')
};
const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

const $ = s => document.querySelector(s);
const esc = x => { const d = document.createElement('div'); d.textContent = x ?? ''; return d.innerHTML; };
const fmt = x => { const d = new Date(x); return Number.isNaN(d.getTime()) ? String(x || '') : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }); };
const fmtLastSeen = x => {
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return String(x || '');
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  if (d.toDateString() === now.toDateString()) return 'today at ' + t;
  if (d.toDateString() === y.toDateString()) return 'yesterday at ' + t;
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' + t;
};
const statusRelative = x => {
  const mins = Math.max(1, Math.floor((Date.now() - new Date(x).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
};
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function appToast(message, type = 'info') {
  let box = document.querySelector('.appToastStack');
  if (!box) { box = document.createElement('div'); box.className = 'appToastStack'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'appToast ' + type;
  el.textContent = String(message);
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 220); }, 2600);
}
function appAlert(msg) { appToast(msg, 'error'); }
function appConfirm(message, title = 'Please confirm') {
  return new Promise(resolve => {
    document.querySelector('.appConfirm')?.remove();
    const box = document.createElement('div');
    box.className = 'appConfirm';
    box.innerHTML = `<div class="appConfirmCard"><h3>${esc(title)}</h3><p style="color:var(--muted);font-size:13px">${esc(message)}</p><div class="appConfirmActions"><button data-no>Cancel</button><button class="danger" data-yes>Continue</button></div></div>`;
    document.body.appendChild(box);
    const done = v => { box.remove(); resolve(v); };
    box.onclick = e => {
      if (e.target === box || e.target.closest('[data-no]')) done(false);
      if (e.target.closest('[data-yes]')) done(true);
    };
  });
}

const AUTH_KEY = 'mychat_access_token';
const authToken = () => localStorage.getItem(AUTH_KEY) || '';
async function persistAuthToken(token) {
  if (!token) return;
  localStorage.setItem(AUTH_KEY, String(token));
  try {
    const c = await caches.open('mychat-auth-v1');
    await c.put('/__mychat_auth_token', new Response(String(token), { headers: { 'content-type': 'text/plain' } }));
  } catch {}
}
async function clearAuthToken() {
  localStorage.removeItem(AUTH_KEY);
  try {
    const c = await caches.open('mychat-auth-v1');
    await c.delete('/__mychat_auth_token');
  } catch {}
}
function cacheUser(u) { try { if (u?.id) localStorage.setItem('mychat_user_cache', JSON.stringify({ id: u.id, phone: u.phone, name: u.name, last_seen: u.last_seen || null })); } catch {} }
function cachedUser() { try { return JSON.parse(localStorage.getItem('mychat_user_cache') || 'null'); } catch { return null; } }
function authHeaders() { const t = authToken(); return t ? { Authorization: 'Bearer ' + t } : {}; }

const DP_KEY = id => 'mychat_dp_' + String(id);
function localDp(id) { try { return localStorage.getItem(DP_KEY(id)) || null; } catch { return null; } }
function setLocalDp(id, data) { try { if (data) localStorage.setItem(DP_KEY(id), data); else localStorage.removeItem(DP_KEY(id)); } catch {} }

function normalizeBackendBase(v) { return String(v || '').trim().replace(/\/+$/, ''); }
function backendUrl(path) {
  const p = String(path || '');
  if (/^https?:\/\//i.test(p) || /^wss?:\/\//i.test(p)) return p;
  return normalizeBackendBase(backendBase) + (p.startsWith('/') ? p : '/' + p);
}

async function resolveBackendBase(force = false) {
  if (!force && backendBase) return backendBase;
  if (backendResolvePromise && !force) return backendResolvePromise;
  backendResolvePromise = (async () => {
    let raw = '';
    const sameOrigin = (location.protocol === 'http:' || location.protocol === 'https:') && /^(localhost|127\.0\.0\.1|[\w-]+\.trycloudflare\.com)$/i.test(location.hostname);
    if (sameOrigin) raw = location.origin;

    const sources = [
      GITHUB_BACKEND_URL_FILE + '?ts=' + Date.now(),
      '/runtime-config.json?ts=' + Date.now(),
      '/api/backend-url?ts=' + Date.now()
    ];
    for (const src of sources) {
      if (raw) break;
      try {
        const r = await fetch(src, { cache: 'no-store' });
        if (r.ok) {
          const text = (await r.text()).trim();
          if (/^https?:\/\/\S+$/i.test(text)) {
            raw = text;
          } else {
            const j = JSON.parse(text);
            raw = j.backend_url || j.url || '';
          }
        }
      } catch {}
    }

    if (!raw) throw Error('Backend URL is not ready. Make sure start.bat is running on the server PC.');
    const next = normalizeBackendBase(raw);
    if (!/^https?:\/\//i.test(next)) throw Error('Invalid backend URL');

    let reachable = false;
    for (let probe = 0; probe < 3; probe++) {
      try {
        const hr = await fetch(next + '/healthz?ts=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
        if (hr.ok) {
          const hj = await hr.json().catch(() => ({}));
          if (hj.ok === true) { reachable = true; break; }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 600));
    }
    if (!reachable) throw Error('Backend unreachable. Verify start.bat and Cloudflare Tunnel are active.');
    const changed = backendBase && backendBase !== next;
    backendBase = next;
    if (changed && ws) { try { ws.close(4001, 'Backend changed'); } catch {} }
    return backendBase;
  })().finally(() => { backendResolvePromise = null; });
  return backendResolvePromise;
}

async function reportClientError(kind, message, stack = '', context = {}) {
  if (__errorReportBusy) return;
  __errorReportBusy = true;
  try {
    await resolveBackendBase();
    await fetch(backendUrl('/api/report-client-error'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ kind, message, stack, context })
    });
  } catch {} finally { setTimeout(() => { __errorReportBusy = false; }, 1500); }
}
window.addEventListener('error', e => reportClientError('window.error', e.message || 'Unknown error', e.error?.stack || ''));
window.addEventListener('unhandledrejection', e => reportClientError('unhandledrejection', String(e.reason?.message || e.reason || 'Unhandled rejection')));

async function api(url, data = null) {
  const baseOpts = data == null
    ? { credentials: 'include', cache: 'no-store' }
    : { method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await resolveBackendBase(attempt > 0);
      const r = await fetch(backendUrl(url), { ...baseOpts, headers: { ...(baseOpts.headers || {}), ...authHeaders() } });
      const j = await r.json().catch(() => null);
      if (!j) throw Error('Server returned invalid response.');
      if (!r.ok || j.ok === false) throw Error(j.error || 'Request failed');
      return j;
    } catch (e) {
      lastError = e;
      const msg = String(e?.message || e);
      if (attempt === 0 && /Failed to fetch|NetworkError|Backend|timed out/i.test(msg)) {
        await new Promise(r => setTimeout(r, 900));
        continue;
      }
      throw e;
    }
  }
  throw lastError || Error('Request failed');
}

const appHeartbeat = () => { if (wsReady && document.visibilityState === 'visible') wsSend({ type: 'app:heartbeat', ts: Date.now() }); };
const appVisibility = visible => { if (wsReady) wsSend({ type: 'app:visibility', visible: !!visible, ts: Date.now() }); };
setInterval(appHeartbeat, 10000);
document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible';
  appVisibility(visible);
  if (visible) { setTimeout(() => { connectWS(); markVisibleChatRead(); }, 180); }
  else { cancelScheduledRead(); }
});
window.addEventListener('pageshow', () => { appVisibility(true); setTimeout(() => { connectWS(); markVisibleChatRead(); }, 180); });
window.addEventListener('pagehide', () => appVisibility(false));
window.addEventListener('online', () => { if (document.visibilityState === 'visible') { appVisibility(true); appHeartbeat(); connectWS(); } });
document.addEventListener('click', e => {
  const p = $('#emojiPicker');
  if (p && p.classList.contains('open') && !p.contains(e.target) && e.target.id !== 'emojiBtn') p.classList.remove('open');
});

function showPWAInstall(hint = 'Install MyChat on desktop for faster access.') {
  const box = $('#pwaInstall');
  if (!box || standalone() || !deferredInstallPrompt) return;
  $('#pwaInstallHint').textContent = hint;
  box.classList.add('show');
}
function hidePWAInstall() { $('#pwaInstall')?.classList.remove('show'); }
async function installPWA() {
  if (!deferredInstallPrompt) { appToast('Use your browser menu to install MyChat.'); return; }
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch {}
  deferredInstallPrompt = null;
  hidePWAInstall();
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; if (me) showPWAInstall(); });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; hidePWAInstall(); });

function showNotificationPrompt() {
  const box = $('#notifyInstall');
  if (!box || !('Notification' in window) || Notification.permission === 'granted') return;
  $('#notifyHint').textContent = Notification.permission === 'denied'
    ? 'Notifications are blocked in browser site settings.'
    : 'Allow notifications for incoming messages.';
  box.classList.add('show');
}
function hideNotificationPrompt() { $('#notifyInstall')?.classList.remove('show'); }

async function enableNotifications() {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) throw Error('Browser notifications unsupported.');
    if (Notification.permission === 'default') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { showNotificationPrompt(); return false; }
    }
    if (Notification.permission !== 'granted') { showNotificationPrompt(); return false; }
    const supported = await initFirebaseMessaging();
    if (!supported || !messaging || !fcmFns?.getToken) return false;
    const sw = await navigator.serviceWorker.register('/firebase-messaging-sw.js?v=79.0', { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    const token = await fcmFns.getToken(messaging, { vapidKey, serviceWorkerRegistration: sw });
    if (token) {
      await wsRequest('token:save', { token, device_id: (navigator.userAgent || '').slice(0, 80), user_agent: (navigator.userAgent || '').slice(0, 255) });
    }
    hideNotificationPrompt();
    return true;
  } catch (e) {
    appAlert('Notification setup failed: ' + (e.message || e));
    return false;
  }
}
async function setupFCM() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  if (Notification.permission === 'default' && shouldAutoRequestNotifications({
    permission: Notification.permission, hasNotification: true, hasServiceWorker: true, isSecureContext: window.isSecureContext, userGesture: true
  })) {
    try { await Notification.requestPermission(); } catch {}
  }
  if (Notification.permission === 'granted') await enableNotifications();
}
function handleForegroundPush(payload = {}) {
  const d = payload.data || {};
  if (d.type !== 'chat_message') return;
  const id = String(d.message_id || '');
  if (id) notifiedIds.add(id);
  if (selected && Number(selected.id) === Number(d.sender_id) && document.visibilityState === 'visible') return;
  if (settings.notifications === false || Notification.permission !== 'granted') return;
  try {
    const notifIcon = localDp(me?.id) || '/icon-192.png';
    new Notification(d.title || 'MyChat', {
      body: d.preview === '0' ? 'New message' : (d.body || 'New message'),
      icon: notifIcon,
      tag: id ? 'msg-' + id : 'mychat'
    });
  } catch {}
}

async function setupTrustedDeviceRecovery() {
  try {
    const d = await api('/api/device-recovery', {});
    if (d.device_recovery_token) localStorage.setItem('mychat_device_recovery_' + String(me?.phone || ''), d.device_recovery_token);
  } catch {}
}
async function forgotPassword() {
  const render = (error = '') => {
    $('#root').innerHTML = `<div class="auth"><div class="authBox"><h1>Reset password</h1><p style="color:var(--muted);font-size:13px">Uses trusted-device verification from this browser.</p><input id="resetPhone" placeholder="Registered Phone / User ID"><input id="resetNew" type="password" placeholder="New password (6+ chars)"><input id="resetConfirm" type="password" placeholder="Confirm password"><button id="finishReset" class="primary">Reset password</button>${error ? `<div class="err">${esc(error)}</div>` : ''}<button id="cancelReset" class="secondary">Back to login</button></div></div>`;
    $('#cancelReset').onclick = () => auth('login');
    $('#finishReset').onclick = async () => {
      const phone = $('#resetPhone').value.trim(), a = $('#resetNew').value, b = $('#resetConfirm').value;
      if (!phone || a.length < 6 || a !== b) return render('Enter valid phone and matching 6+ character passwords.');
      const token = localStorage.getItem('mychat_device_recovery_' + phone);
      if (!token) return render('This browser is not registered as a trusted recovery device for this account.');
      try {
        await api('/api/forgot-device', { phone, device_recovery_token: token, new_password: a });
        localStorage.removeItem('mychat_device_recovery_' + phone);
        appToast('Password updated! Please login.');
        auth('login');
      } catch (e) { render(e.message); }
    };
  };
  render();
}

function auth(mode) {
  $('#root').innerHTML = `<div class="auth"><div class="authBox"><div class="logo"><img src="/icon-192.png" alt="MyChat"></div><h1>${mode === 'login' ? 'Welcome back' : 'Create account'}</h1><p style="color:var(--muted);font-size:13px">${mode === 'login' ? 'Sign in to MyChat Web.' : 'Create your MyChat account.'}</p><input id="phone" placeholder="Phone / User ID" autocomplete="username"><input id="name" placeholder="Full Name" ${mode === 'login' ? 'style="display:none"' : ''}><div class="passwordWrap"><input id="pass" type="password" placeholder="Password (6+ chars)" autocomplete="current-password"><button id="passEye" class="eyeBtn" type="button">👁️</button></div><button id="go" class="primary">${mode === 'login' ? 'Login' : 'Create account'}</button><button id="sw" class="secondary">${mode === 'login' ? 'Create new account' : 'Already have an account'}</button>${mode === 'login' ? '<button id="forgot" class="secondary">Forgot password?</button>' : ''}<div id="msg"></div></div></div>`;
  $('#passEye').onclick = () => { const i = $('#pass'); i.type = i.type === 'password' ? 'text' : 'password'; };
  $('#go').onclick = async () => {
    try {
      $('#go').disabled = true;
      const data = { phone: $('#phone').value.trim(), password: $('#pass').value };
      if (!data.phone || data.password.length < 6) throw Error('Enter Phone/ID and a 6+ character password.');
      if (mode === 'register') { data.name = $('#name').value.trim(); if (!data.name) throw Error('Name required.'); }
      const d = await api('/api/' + mode, data);
      await persistAuthToken(d.access_token);
      me = d.user; cacheUser(me);
      // Fetch and cache user DP without requiring a page refresh
      fetch(`/api/dp?id=${me.id}`).then(r => {
        if (!r.ok) return null;
        return r.blob();
      }).then(blob => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          setLocalDp(me.id, dataUrl);
          me.dp = dataUrl; // update in-memory user object
          // Update UI instantly if DP modal is open or avatar displayed
          const avatar = $('#headAv');
          if (avatar) avatar.src = dataUrl;
        };
        reader.readAsDataURL(blob);
      }).catch(() => {});
      await setupTrustedDeviceRecovery();
      await render();
      connectWS();
      await waitForWSReady(15000);
      void setupFCM();
    } catch (e) {
      $('#msg').textContent = e.message;
      $('#msg').className = 'err';
      $('#go').disabled = false;
    }
  };
  $('#sw').onclick = () => auth(mode === 'login' ? 'register' : 'login');
  $('#forgot')?.addEventListener('click', forgotPassword);
}

async function boot() {
  const token = authToken();
  try {
    const d = await api('/api/me');
    if (d.ok) {
      me = d.user; cacheUser(me);
      // Fetch and cache user DP without requiring a page refresh
      fetch(`/api/dp?id=${me.id}`).then(r => {
        if (!r.ok) return null;
        return r.blob();
      }).then(blob => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          setLocalDp(me.id, dataUrl);
          me.dp = dataUrl; // update in-memory user object
          // Update UI instantly if DP modal is open or avatar displayed
          const avatar = $('#headAv');
          if (avatar) avatar.src = dataUrl;
        };
        reader.readAsDataURL(blob);
      }).catch(() => {});
      await setupTrustedDeviceRecovery();
      await render();
      connectWS();
      await waitForWSReady(15000);
      void setupFCM();
      return;
    }
  } catch {
    if (token) {
      const cached = cachedUser();
      if (cached?.id) {
        me = cached; me.dp = localDp(me.id);
        await render();
        setRT(false, '● Offline');
        setTimeout(() => connectWS(true), 1200);
        return;
      }
    }
  }
  auth('login');
}

async function render() {
  me.dp = localDp(me.id);
  const av = me.dp ? `<img src="${esc(me.dp)}">` : esc(me.name?.[0]?.toUpperCase() || 'M');
  $('#root').innerHTML = `
  <div class="app">
    <aside class="side">
      <div class="top">
        <div class="topProfile">${av}</div>
        <div class="topTitle"><div>MyChat</div><small class="topUserName">${esc(me.name || '')}</small></div>
        <div id="rtStatus" class="rtStatus">Connecting…</div>
        <button id="searchBtn" class="topBtn" title="Search users">⌕</button>
      </div>
      <div class="search"><input id="search" placeholder="Search users by name or phone…"></div>
      <div id="searchResults" class="list hidden"></div>
      <div class="chatTabs">
        <button class="chatTab active" data-filter="all">All</button>
        <button class="chatTab" data-filter="unread">Unread</button>
      </div>
      <div id="list" class="list"></div>
      <nav class="bottomNav">
        <button class="bottomNavItem active" data-nav="chats"><span>💬</span><b>Chats</b></button>
        <button class="bottomNavItem" data-nav="status"><span>◉</span><b>Status</b></button>
        <button class="bottomNavItem" data-nav="settings"><span>⚙</span><b>Settings</b></button>
      </nav>
    </aside>
    <section class="chat">
      <div class="head">
        <button id="back" class="back" aria-label="Back">‹</button>
        <div id="headAv" class="avatar">${av}</div>
        <div class="headText">
          <div id="title" class="headName">MyChat Web</div>
          <div id="sub" class="headSub">Select a conversation</div>
        </div>
        <div class="headActions">
          <button id="voiceCallBtn" class="topBtn hidden" title="Voice call">📞</button>
          <button id="videoCallBtn" class="topBtn hidden" title="Video call">📹</button>
          <button id="chatMenu" class="topBtn hidden" title="Chat options">•••</button>
        </div>
      </div>
      <div id="inChatSearch" class="inChatSearch">
        <input id="inChatSearchInput" placeholder="Search messages in this chat…">
        <button id="inChatSearchClose" class="topBtn" type="button">×</button>
      </div>
      <div id="inChatSearchResults" class="inChatSearchResults hidden"></div>
      <div id="messages" class="messages">
        <div class="emptyBrand"><img src="/icon-192.png" alt="MyChat"><h2>MyChat Web</h2><p>Select a conversation on the left or click Search to find someone.</p></div>
      </div>
      <div id="typing" class="typing"></div>
      <div id="uploadProgress" class="uploadProgress"></div>
      <div class="composer">
        <div id="mediaPreview" class="mediaPreview hidden"></div>
        <div class="composerRow">
          <button id="emojiBtn" class="composerTool" title="Emoji">☺</button>
          <button id="attachBtn" class="attachBtn" title="Attach file">＋</button>
          <input id="text" placeholder="Type a message…" autocomplete="off">
          <button id="send" class="send" title="Send">➤</button>
        </div>
      </div>
      <div id="emojiPicker" class="emojiPicker"></div>
      <div id="attachSheet" class="attachSheet">
        <div class="attachCard">
          <h3 style="margin-top:0">Share attachment</h3>
          <div class="attachGrid">
            <button data-attach="gallery"><span>🖼️</span><b>Photo / Video</b></button>
            <button data-attach="document"><span>📄</span><b>Document</b></button>
            <button data-attach="audio"><span>🎵</span><b>Audio</b></button>
            <button data-attach="contact"><span>👤</span><b>Contact</b></button>
          </div>
          <button id="attachClose" class="attachCancel">Cancel</button>
        </div>
      </div>
    </section>
    <section id="statusView" class="statusView"></section>
    <div id="shade" class="shade"></div>
    <aside id="drawer" class="drawer"></aside>
  </div>`;

  $('#chatMenu').onclick = openChatMenu;
  $('#voiceCallBtn').onclick = () => selected && startCall(selected, 'voice');
  $('#videoCallBtn').onclick = () => selected && startCall(selected, 'video');
  $('#shade').onclick = closeSettings;
  $('#back').onclick = goBack;
  document.querySelectorAll('.bottomNavItem').forEach(b => b.onclick = () => switchPrimaryView(b.dataset.nav));
  document.querySelectorAll('.chatTab').forEach(b => b.onclick = () => setChatFilter(b.dataset.filter));
  $('#send').onclick = send;
  $('#emojiBtn').onclick = toggleEmojiPicker;
  $('#attachBtn').onclick = openAttachSheet;
  $('#attachClose').onclick = closeAttachSheet;
  document.querySelectorAll('[data-attach]').forEach(b => b.onclick = () => handleAttachChoice(b.dataset.attach));
  $('#text').oninput = typing;
  $('#text').onkeydown = e => {
    if (e.key === 'Enter' && settings.enter_to_send) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && editingTarget) cancelEditTarget();
  };
  $('#searchBtn').onclick = toggleSearchBar;
  $('#search').oninput = search;
  $('#search').onkeydown = e => { if (e.key === 'Escape') closeSearchBar(); };
  $('#headAv').onclick = () => { if (selected?.dp) showDP(selected.dp); };
  $('#inChatSearchClose').onclick = closeInChatSearch;
  let searchDebounce = null;
  $('#inChatSearchInput').oninput = () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runInChatSearch, 280);
  };
  $('#messages').addEventListener('scroll', () => {
    if ($('#messages').scrollTop < 45 && hasMoreHistory && !loadingOlder && oldestId) loadOlderHistory();
  });
}

function openInChatSearch() {
  if (!selected) return;
  $('#inChatSearch').classList.add('open');
  $('#inChatSearchInput').focus();
}
function closeInChatSearch() {
  $('#inChatSearch').classList.remove('open');
  $('#inChatSearchInput').value = '';
  $('#inChatSearchResults').classList.add('hidden');
  $('#inChatSearchResults').innerHTML = '';
}
async function runInChatSearch() {
  const q = $('#inChatSearchInput')?.value.trim() || '';
  const resBox = $('#inChatSearchResults');
  if (!q || !selected) { resBox.classList.add('hidden'); resBox.innerHTML = ''; return; }
  try {
    const d = await wsRequest('messages:search', { user_id: Number(selected.id), q });
    const hits = d.messages || [];
    resBox.classList.remove('hidden');
    if (!hits.length) { resBox.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px">No matching messages found.</div>'; return; }
    resBox.innerHTML = hits.map(m => `<button class="searchHit" data-mid="${m.id}"><span>${esc(m.body.slice(0, 90))}</span><small>${esc(fmt(m.created_at))}</small></button>`).join('');
    resBox.querySelectorAll('.searchHit').forEach(b => b.onclick = () => {
      const target = document.querySelector(`.messageRow[data-message-id="${b.dataset.mid}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const bub = target.querySelector('.bubble');
        bub?.classList.add('highlightPulse');
        setTimeout(() => bub?.classList.remove('highlightPulse'), 1600);
      } else {
        appToast('Message is older — click "Load older messages" above.');
      }
    });
  } catch (e) { appAlert(e.message); }
}

function openChatMenu() {
  if (!selected) return;
  const blocked = !!selected.blocked;
  const muted = !!selected.muted;
  const menu = document.createElement('div');
  menu.className = 'chatActionMenu';
  menu.innerHTML = `
    <button data-act="info">👤 Contact info</button>
    <button data-act="search">🔎 Search in chat</button>
    <button data-act="mute">${muted ? '🔔 Unmute notifications' : '🔕 Mute notifications (24h)'}</button>
    <button data-act="clear">🧹 Clear chat for both</button>
    <button data-act="block">${blocked ? '🔓 Unblock' : '🚫 Block'} contact</button>`;
  document.body.appendChild(menu);
  const rect = $('#chatMenu').getBoundingClientRect();
  menu.style.top = (rect.bottom + 8) + 'px';
  menu.style.right = Math.max(12, innerWidth - rect.right) + 'px';
  const close = () => { menu.remove(); document.removeEventListener('click', outside, true); };
  const outside = e => { if (!menu.contains(e.target) && e.target !== $('#chatMenu')) close(); };
  setTimeout(() => document.addEventListener('click', outside, true), 0);
  menu.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.act;
    close();
    if (a === 'info') showContactInfo(selected);
    else if (a === 'search') openInChatSearch();
    else if (a === 'mute') {
      try {
        const res = await wsRequest('chat:mute', { user_id: Number(selected.id), duration_hours: muted ? 0 : 24 });
        selected.muted = !!res.muted;
        appToast(res.muted ? 'Chat muted for 24 hours' : 'Chat unmuted');
      } catch (err) { appAlert(err.message); }
    } else if (a === 'clear') {
      if (await appConfirm('Clear this chat for both sides?', 'Clear chat?')) {
        await wsRequest('clear-chat', { user_id: Number(selected.id) });
        requestSelectedHistory();
      }
    } else if (a === 'block') {
      await wsRequest('block', { user_id: Number(selected.id), blocked: !blocked });
      selected.blocked = !blocked;
      $('#text').disabled = !!selected.blocked;
      $('#text').placeholder = selected.blocked ? 'Messaging is blocked' : 'Type a message…';
    }
  };
}

function closeMessageActions() { document.querySelector('.reactionPicker')?.remove(); }
function showReactionPicker(message, anchor) {
  closeMessageActions();
  const isMine = Number(message.sender_id) === Number(me.id);
  const canEdit = isMine && !message.deleted_at && message.body && (Date.now() - new Date(message.created_at).getTime() < 15 * 60 * 1000);
  const sheet = document.createElement('div');
  sheet.className = 'reactionPicker';
  sheet.innerHTML = `
    <div class="reactionQuick">${QUICK_REACTIONS.map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('')}<button type="button" data-more="1">＋</button></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;border-top:1px solid var(--line);margin-top:6px;padding-top:6px">
      <button type="button" data-op="reply" style="font-size:12px;border:0;background:var(--surface-2);padding:6px 9px;border-radius:8px;cursor:pointer">↩ Reply</button>
      ${message.body ? '<button type="button" data-op="copy" style="font-size:12px;border:0;background:var(--surface-2);padding:6px 9px;border-radius:8px;cursor:pointer">📋 Copy</button>' : ''}
      ${canEdit ? '<button type="button" data-op="edit" style="font-size:12px;border:0;background:var(--surface-2);padding:6px 9px;border-radius:8px;cursor:pointer">✏️ Edit</button>' : ''}
      <button type="button" data-op="forward" style="font-size:12px;border:0;background:var(--surface-2);padding:6px 9px;border-radius:8px;cursor:pointer">↪ Forward</button>
    </div>`;
  document.body.appendChild(sheet);
  const r = anchor.getBoundingClientRect();
  sheet.style.left = Math.min(innerWidth - 300, Math.max(10, r.left)) + 'px';
  sheet.style.top = Math.min(innerHeight - 120, Math.max(10, r.bottom + 5)) + 'px';
  sheet.onclick = async e => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.more) { closeMessageActions(); openAllReactions(message); return; }
    if (btn.dataset.emoji) { await wsRequest('reaction:set', { message_id: Number(message.id), emoji: btn.dataset.emoji }); clearMessageSelection(); return; }
    const op = btn.dataset.op;
    closeMessageActions();
    clearMessageSelection();
    if (op === 'reply') setReplyTarget(message);
    else if (op === 'copy') { await navigator.clipboard?.writeText(message.body || ''); appToast('Copied'); }
    else if (op === 'edit') setEditTarget(message);
    else if (op === 'forward') openForwardModal(message);
  };
}

function openAllReactions(message) {
  const box = document.createElement('div');
  box.className = 'emojiModal';
  box.innerHTML = `<div class="emojiCard"><div style="display:flex;justify-content:space-between;margin-bottom:10px"><b>React</b><button type="button" class="emojiClose" style="border:0;background:transparent;font-size:22px;cursor:pointer">×</button></div><div class="emojiCats">${Object.keys(EMOJI_CATEGORIES).map((c, i) => `<button class="emojiCat ${i === 0 ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}</div><div id="reactionGrid" class="emojiGrid"></div></div>`;
  document.body.appendChild(box);
  const grid = box.querySelector('#reactionGrid');
  const renderCat = c => { grid.innerHTML = EMOJI_CATEGORIES[c].map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join(''); };
  renderCat('Smileys');
  box.querySelectorAll('.emojiCat').forEach(x => x.onclick = () => { box.querySelectorAll('.emojiCat').forEach(y => y.classList.remove('active')); x.classList.add('active'); renderCat(x.dataset.cat); });
  box.querySelector('.emojiClose').onclick = () => box.remove();
  box.onclick = e => { if (e.target === box) box.remove(); };
  grid.onclick = async e => {
    const btn = e.target.closest('button'); if (!btn) return;
    await wsRequest('reaction:set', { message_id: Number(message.id), emoji: btn.dataset.emoji });
    box.remove();
  };
}

async function openForwardModal(m) {
  const chats = window.__mychatChats || [];
  if (!chats.length) return appToast('No chats available to forward to.');
  const box = document.createElement('div');
  box.className = 'appConfirm';
  box.innerHTML = `<div class="appConfirmCard"><h3>Forward message</h3><div class="contactPickerList">${chats.map(c => `<button type="button" data-id="${c.id}"><span class="avatar" style="width:36px;height:36px">${esc(c.name?.[0]?.toUpperCase() || '?')}</span><span><b>${esc(c.name)}</b></span></button>`).join('')}</div><div class="appConfirmActions"><button data-no>Cancel</button></div></div>`;
  document.body.appendChild(box);
  box.querySelector('[data-no]').onclick = () => box.remove();
  box.querySelectorAll('.contactPickerList button').forEach(b => b.onclick = async () => {
    box.remove();
    try {
      await wsRequest('message:forward', { message_id: Number(m.id), receiver_id: Number(b.dataset.id) });
      appToast('Message forwarded');
    } catch (e) { appAlert(e.message); }
  });
}

function setEditTarget(m) {
  cancelReplyTarget();
  editingTarget = { id: Number(m.id), original: m.body || '' };
  const composer = document.querySelector('.composer');
  composer.querySelector('.replyPreview')?.remove();
  const box = document.createElement('div');
  box.className = 'replyPreview';
  box.innerHTML = `<div><b>Editing message</b><span>${esc(editingTarget.original.slice(0, 120))}</span></div><button type="button">×</button>`;
  composer.prepend(box);
  box.querySelector('button').onclick = cancelEditTarget;
  $('#text').value = editingTarget.original;
  $('#text').focus();
}
function cancelEditTarget() {
  editingTarget = null;
  document.querySelector('.composer .replyPreview')?.remove();
  if ($('#text')) $('#text').value = '';
}
function setReplyTarget(m) {
  if (editingTarget) cancelEditTarget();
  replyTarget = { id: Number(m.id), body: String(m.body || 'Media'), sender_name: Number(m.sender_id) === Number(me.id) ? 'You' : (selected?.name || 'User') };
  const composer = document.querySelector('.composer');
  composer.querySelector('.replyPreview')?.remove();
  const box = document.createElement('div');
  box.className = 'replyPreview';
  box.innerHTML = `<div><b>Replying to ${esc(replyTarget.sender_name)}</b><span>${esc(replyTarget.body.slice(0, 120))}</span></div><button type="button">×</button>`;
  composer.prepend(box);
  box.querySelector('button').onclick = cancelReplyTarget;
  $('#text')?.focus();
}
function cancelReplyTarget() { replyTarget = null; document.querySelector('.composer .replyPreview')?.remove(); }

function ensureSelectionBar() {
  if ($('#messageSelectionBar')) return;
  const bar = document.createElement('div');
  bar.id = 'messageSelectionBar';
  bar.className = 'messageSelectionBar';
  bar.innerHTML = '<div class="selectionTop"><button type="button" class="selectionClose">‹</button><b class="selectionCount"></b></div><button type="button" class="selectionDeleteMenu">🗑 Delete</button><div class="selectionDeletePopover"><button type="button" data-scope="me">Delete for me</button><button type="button" data-scope="everyone" style="color:#cf3152">Delete for everyone</button></div>';
  document.body.appendChild(bar);
  bar.querySelector('.selectionClose').onclick = clearMessageSelection;
  const pop = bar.querySelector('.selectionDeletePopover');
  bar.querySelector('.selectionDeleteMenu').onclick = () => pop.classList.toggle('open');
  pop.querySelectorAll('button[data-scope]').forEach(b => b.onclick = () => { pop.classList.remove('open'); deleteSelectedMessages(b.dataset.scope); });
}
function clearMessageSelection() {
  closeMessageActions();
  selectedMessageIds.clear();
  document.querySelectorAll('.bubble.selected').forEach(x => x.classList.remove('selected'));
  $('#messageSelectionBar')?.classList.remove('show');
}
function toggleMessageSelection(m, el) {
  const id = Number(m?.id); if (!id) return;
  const bubble = el?.classList?.contains('bubble') ? el : el?.querySelector?.('.bubble');
  if (selectedMessageIds.has(id)) { selectedMessageIds.delete(id); bubble?.classList.remove('selected'); }
  else { selectedMessageIds.add(id); bubble?.classList.add('selected'); }
  const n = selectedMessageIds.size;
  const bar = $('#messageSelectionBar');
  bar?.classList.toggle('show', n > 0);
  if (bar) bar.querySelector('.selectionCount').textContent = n ? `${n} selected` : '';
  if (n === 1 && bubble) showReactionPicker(messageCache.get([...selectedMessageIds][0]), bubble);
  else closeMessageActions();
}
async function deleteSelectedMessages(scope) {
  const list = [...selectedMessageIds];
  for (const id of list) {
    const m = messageCache.get(id);
    if (scope === 'everyone' && (!m || Number(m.sender_id) !== Number(me.id))) continue;
    await wsRequest('message:delete', { message_id: id, scope }).catch(e => appAlert(e.message));
  }
  clearMessageSelection();
}
function bindMessageContext(row, m) {
  row.addEventListener('contextmenu', e => { e.preventDefault(); toggleMessageSelection(m, row); });
  row.addEventListener('click', e => {
    if (e.target.closest('button,a,audio,video')) return;
    if (selectedMessageIds.size) toggleMessageSelection(m, row);
  });
}

function toggleEmojiPicker() {
  const p = $('#emojiPicker');
  if (!p) return;
  if (p.classList.contains('open')) { p.classList.remove('open'); return; }
  renderEmojiPicker('Smileys');
  p.classList.add('open');
}
function renderEmojiPicker(cat) {
  const p = $('#emojiPicker');
  p.innerHTML = `<div class="emojiPickerTabs">${Object.keys(EMOJI_CATEGORIES).map(c => `<button class="emojiTab ${c === cat ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}</div><div class="emojiGrid">${EMOJI_CATEGORIES[cat].map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('')}</div>`;
  p.querySelectorAll('.emojiTab').forEach(b => b.onclick = () => renderEmojiPicker(b.dataset.cat));
  p.querySelectorAll('.emojiGrid button').forEach(b => b.onclick = () => { const i = $('#text'); i.value += b.dataset.emoji; i.focus(); });
}

function goBack() {
  if ($('.drawer.open')) { closeSettings(); return; }
  if ($('.app')?.classList.contains('mobileChat')) { selected = null; $('.app').classList.remove('mobileChat'); }
}
function switchPrimaryView(view) {
  document.querySelectorAll('.bottomNavItem').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  $('#statusView')?.classList.remove('open');
  if (view === 'settings') { openSettings(); return; }
  if (view === 'status') {
    if (wsReady) wsSend({ type: 'status:list' });
    renderStatusView();
    return;
  }
  closeSettings();
}
function setChatFilter(filter) {
  currentChatFilter = filter === 'unread' ? 'unread' : 'all';
  document.querySelectorAll('.chatTab').forEach(b => b.classList.toggle('active', b.dataset.filter === currentChatFilter));
  if (window.__mychatChats) renderChatList(window.__mychatChats);
}

function badge(count) { return count > 0 ? `<span class="unreadBadge">${count > 99 ? '99+' : count}</span>` : ''; }
function rowTick(m) {
  if (!m || Number(m.last_message_sender_id) !== Number(me.id)) return '';
  if (settings.read_receipts && m.last_read_at) return '<span class="rowTick blue">✓✓</span>';
  if (m.last_delivered_at) return '<span class="rowTick">✓✓</span>';
  return '<span class="rowTick">✓</span>';
}
function renderChatList(chats) {
  window.__mychatChats = (Array.isArray(chats) ? chats : []).map(c => ({ ...c, dp: localDp(c.id) || null }));
  const visible = currentChatFilter === 'unread' ? window.__mychatChats.filter(c => Number(c.unread_count || 0) > 0) : window.__mychatChats;
  const list = $('#list'); if (!list) return;
  list.innerHTML = '';
  if (!visible.length) {
    list.innerHTML = currentChatFilter === 'unread'
      ? '<div class="homeEmpty"><h2>No unread chats</h2><p>All caught up.</p></div>'
      : '<div class="homeEmpty"><div class="homeEmptyLogo"><img src="/icon-192.png" alt="MyChat"></div><h2>Welcome to MyChat</h2><p>Search for a user above to start messaging.</p><button type="button" class="homeEmptyAction" id="startChatBtn">＋ Find someone</button></div>';
    $('#startChatBtn')?.addEventListener('click', toggleSearchBar);
    return;
  }
  visible.forEach(u => {
    const b = document.createElement('button');
    b.className = 'row' + (selected && Number(selected.id) === Number(u.id) ? ' active' : '');
    b.dataset.id = u.id;
    const preview = u.typing ? 'typing…' : (u.last_message || '');
    const presenceText = u.online ? 'online' : (u.last_seen ? 'last seen ' + fmtLastSeen(u.last_seen) : 'offline');
    const lastTime = u.last_message_at ? fmt(u.last_message_at) : '';
    const hasNewStatus = statusItems.some(s => Number(s.user_id) === Number(u.id) && !s.viewed);
    b.dataset.preview = preview; b.dataset.tick = rowTick(u); b.dataset.presenceText = presenceText;
    b.innerHTML = `<div class="avatar statusAvatar ${hasNewStatus ? 'hasNewStatus' : ''}"><div class="statusDot"></div>${u.dp ? `<img src="${esc(u.dp)}">` : esc(u.name?.[0]?.toUpperCase() || '?')}</div><div class="info"><div class="rowNameLine"><div class="name">${esc(u.name)} ${u.muted ? '<span class="muteTag">🔕</span>' : ''}</div><span class="rowTimeStack"><time class="rowTime">${esc(lastTime)}</time><span class="rowPresence">${esc(presenceText)}</span></span></div><div class="rowMetaLine">${preview ? `<span class="rowPreview">${rowTick(u)}<span>${esc(preview)}</span></span>` : ''}</div></div>${badge(Number(u.unread_count || 0))}`;
    b.onclick = () => openChat(u, b);
    list.appendChild(b);
  });
}

function requestSelectedHistory() {
  if (!selected || !wsReady) return;
  lastId = 0; oldestId = 0; hasMoreHistory = false; ids.clear();
  $('#messages').innerHTML = '<div class="empty">Loading…</div>';
  wsSend({ type: 'history', user_id: selected.id, limit: 40, request_id: crypto.randomUUID() });
  wsSend({ type: 'presence:subscribe', user_ids: [selected.id] });
}
function loadOlderHistory() {
  if (!selected || !wsReady || !oldestId || loadingOlder) return;
  loadingOlder = true;
  wsSend({ type: 'history', user_id: selected.id, before_id: oldestId, limit: 40, request_id: crypto.randomUUID() });
}

function openChat(u, row = null) {
  switchPrimaryView('chats');
  closeInChatSearch();
  selected = { ...u, dp: localDp(u.id) || u.dp || null, blocked: !!u.blocked };
  document.querySelectorAll('.row').forEach(x => x.classList.remove('active'));
  row?.classList.add('active');
  $('#title').textContent = u.name;
  $('#sub').textContent = u.online ? 'online' : (u.last_seen ? 'last seen ' + fmtLastSeen(u.last_seen) : 'offline');
  $('#headAv').innerHTML = u.dp ? `<img src="${esc(u.dp)}">` : esc(u.name?.[0]?.toUpperCase() || '?');
  $('#chatMenu').classList.remove('hidden');
  $('#voiceCallBtn').classList.remove('hidden');
  $('#videoCallBtn').classList.remove('hidden');
  $('#text').disabled = !!selected.blocked;
  $('#text').placeholder = selected.blocked ? 'Messaging is blocked' : 'Type a message…';
  $('.app').classList.add('mobileChat');
  row?.querySelector('.unreadBadge')?.remove();
  cancelScheduledRead();
  requestSelectedHistory();
  setTimeout(scheduleVisibleChatRead, 600);
}

function tick(m) {
  if (Number(m.sender_id) !== Number(me.id)) return '';
  if (settings.read_receipts && m.read_at) return '<span class="ticks blue">✓✓</span>';
  if (m.delivered_at) return '<span class="ticks">✓✓</span>';
  return '<span class="ticks">✓</span>';
}
function sendReceiptsForMessage(m) {
  if (!m || Number(m.receiver_id) !== Number(me?.id)) return;
  if (!m.delivered_at && !m.read_at) wsSend({ type: 'delivered', message_id: Number(m.id) });
  if (document.visibilityState === 'visible' && selected && Number(selected.id) === Number(m.sender_id)) scheduleVisibleChatRead();
}
function cancelScheduledRead() { if (readTimer) { clearTimeout(readTimer); readTimer = null; } }
function scheduleVisibleChatRead(delay = 1200) {
  cancelScheduledRead();
  if (document.visibilityState !== 'visible' || !selected || !wsReady) return;
  const chatId = Number(selected.id);
  readTimer = setTimeout(() => {
    readTimer = null;
    if (document.visibilityState === 'visible' && selected && Number(selected.id) === chatId && wsReady) {
      wsSend({ type: 'chat:mark-read', user_id: chatId });
    }
  }, delay);
}
function markVisibleChatRead() { if (document.visibilityState === 'visible' && selected && wsReady) scheduleVisibleChatRead(350); }

function renderReactions(m) {
  const rs = Array.isArray(m.reactions) ? m.reactions : [];
  if (!rs.length) return '';
  const groups = new Map();
  rs.forEach(r => { const g = groups.get(r.emoji) || { count: 0, names: [] }; g.count++; if (r.name) g.names.push(r.name); groups.set(r.emoji, g); });
  return `<div class="reactions">${[...groups.entries()].map(([emoji, g]) => `<button type="button" class="reactionChip" data-message-id="${m.id}" data-emoji="${esc(emoji)}" title="${esc(g.names.join(', '))}">${esc(emoji)}<span>${g.count}</span></button>`).join('')}</div>`;
}
function formatBytes(n) {
  n = Number(n || 0);
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function renderMedia(m) {
  const a = m.media; if (!a) return '';
  const url = esc(a.url || backendUrl('/api/media?id=' + encodeURIComponent(a.id || '')));
  const mime = String(a.mime || '');
  const name = esc(a.original_name || 'Attachment');
  const key = esc(String(a.id || ''));
  if (mime.startsWith('image/')) return `<div class="mediaAttach" data-media-wrap="${key}"><img src="${url}" loading="lazy" alt="${name}"></div>`;
  if (mime.startsWith('video/')) return `<div class="mediaAttach" data-media-wrap="${key}"><video src="${url}" controls preload="metadata"></video></div>`;
  if (mime.startsWith('audio/')) return `<div class="mediaAttach" data-media-wrap="${key}"><audio src="${url}" controls preload="metadata"></audio></div>`;
  return `<div class="mediaFile" data-media-wrap="${key}"><a href="${url}" target="_blank" rel="noopener">📄 ${name}<small>${formatBytes(a.size)}</small></a></div>`;
}

function buildMessageElement(m) {
  const row = document.createElement('div');
  row.className = 'messageRow ' + (Number(m.sender_id) === Number(me.id) ? 'mineRow' : '');
  row.dataset.messageId = m.id;
  const e = document.createElement('div');
  e.dataset.messageId = m.id;
  e.className = 'bubble ' + (Number(m.sender_id) === Number(me.id) ? 'mine' : '');
  const replyHtml = m.reply_to_id ? `<div class="replyQuote"><b>${esc(m.reply_sender_name || 'Reply')}</b><span>${esc(m.reply_body || '')}</span></div>` : '';
  const fwdHtml = m.forwarded_from_id ? '<span class="forwardTag">↪ Forwarded</span>' : '';
  const bodyHtml = `${renderMedia(m)}${m.body ? `<div class="bubbleBody">${esc(m.body)}</div>` : ''}`;
  const editedHtml = m.edited_at ? '<span class="editedTag">edited</span>' : '';
  e.innerHTML = `${fwdHtml}${replyHtml}${bodyHtml}${renderReactions(m)}<span class="meta">${editedHtml}<span>${esc(fmt(m.created_at))}</span>${tick(m)}</span>`;
  row.appendChild(e);
  bindMessageContext(row, m);
  return row;
}

function renderMessage(m, prepend = false) {
  const key = String(m.id);
  messageCache.set(Number(m.id), m);
  if (ids.has(key)) return;
  const box = $('#messages');
  box.querySelector('.empty')?.remove();
  ids.add(key);
  lastId = Math.max(lastId, Number(m.id));
  if (!oldestId || Number(m.id) < oldestId) oldestId = Number(m.id);
  const el = buildMessageElement(m);
  if (prepend) {
    const firstMsg = box.querySelector('.messageRow');
    if (firstMsg) box.insertBefore(el, firstMsg);
    else box.appendChild(el);
  } else {
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }
}

function openAttachSheet() { if (selected && !selected.blocked) $('#attachSheet')?.classList.add('open'); }
function closeAttachSheet() { $('#attachSheet')?.classList.remove('open'); }
function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}
async function handleAttachChoice(kind) {
  closeAttachSheet();
  if (!selected || selected.blocked) return;
  if (kind === 'contact') {
    const chats = window.__mychatChats || [];
    if (!chats.length) return appToast('No contacts available.');
    const box = document.createElement('div');
    box.className = 'appConfirm';
    box.innerHTML = `<div class="appConfirmCard"><h3>Share contact</h3><div class="contactPickerList">${chats.map(c => `<button type="button" data-name="${esc(c.name)}" data-phone="${esc(c.phone || '')}"><b>${esc(c.name)}</b> <small style="color:var(--muted)">${esc(c.phone || '')}</small></button>`).join('')}</div><div class="appConfirmActions"><button data-no>Cancel</button></div></div>`;
    document.body.appendChild(box);
    box.querySelector('[data-no]').onclick = () => box.remove();
    box.querySelectorAll('.contactPickerList button').forEach(b => b.onclick = () => {
      $('#text').value = `👤 ${b.dataset.name}${b.dataset.phone ? ' • ' + b.dataset.phone : ''}`;
      box.remove(); send();
    });
    return;
  }
  const accept = kind === 'gallery' ? 'image/*,video/*' : kind === 'document' ? '.pdf,.txt,.zip,.doc,.docx,.xls,.xlsx' : 'audio/*';
  const f = await pickFile(accept);
  if (f) await uploadMediaFile(f);
}
async function uploadMediaFile(f) {
  if (f.size > 64 * 1024 * 1024) return appAlert('Maximum file size is 64 MB.');
  try {
    const progress = $('#uploadProgress');
    progress?.classList.add('show');
    const media = await uploadRawMedia(f, pct => { if (progress) progress.textContent = `Uploading ${pct}%…`; });
    progress?.classList.remove('show');
    pendingMedia = media;
    const box = $('#mediaPreview');
    box.classList.remove('hidden');
    const url = URL.createObjectURL(f);
    let body = `<div style="font-size:13px">📄 ${esc(f.name)} (${formatBytes(f.size)})</div>`;
    if (f.type.startsWith('image/')) body = `<img src="${url}">`;
    else if (f.type.startsWith('video/')) body = `<video src="${url}" controls muted></video>`;
    else if (f.type.startsWith('audio/')) body = `<audio src="${url}" controls></audio>`;
    box.innerHTML = `<div class="mediaPreviewTitle"><b>Ready to send</b><button type="button" id="cancelMediaPreview">×</button></div>${body}`;
    $('#cancelMediaPreview').onclick = () => { pendingMedia = null; box.classList.add('hidden'); box.innerHTML = ''; };
  } catch (e) {
    $('#uploadProgress')?.classList.remove('show');
    appAlert(e.message || 'Upload failed');
  }
}
async function uploadRawMedia(f, onProgress = null) {
  const chunkSize = 768 * 1024, total = Math.ceil(f.size / chunkSize), uploadId = crypto.randomUUID();
  let media = null;
  for (let i = 0; i < total; i++) {
    const fd = new FormData();
    fd.append('upload_id', uploadId); fd.append('index', i); fd.append('total', total);
    fd.append('name', f.name); fd.append('mime', f.type || 'application/octet-stream'); fd.append('size', String(f.size));
    fd.append('chunk', f.slice(i * chunkSize, Math.min(f.size, (i + 1) * chunkSize)), f.name + '.part');
    const r = await fetch(backendUrl('/api/media-chunk'), { method: 'POST', body: fd, credentials: 'include', headers: { ...authHeaders() } });
    const d = await r.json();
    if (!r.ok || !d.ok) throw Error(d.error || 'Media upload failed');
    if (d.complete) media = d.media;
    if (onProgress) onProgress(Math.round(((i + 1) / total) * 100));
  }
  if (!media) throw Error('Upload incomplete');
  return media;
}

async function send() {
  if (!selected) return;
  const input = $('#text'), body = input.value.trim();
  if (editingTarget) {
    if (!body) return;
    try {
      await wsRequest('message:edit', { message_id: editingTarget.id, body });
      cancelEditTarget();
    } catch (e) { appAlert(e.message); }
    return;
  }
  const hadMedia = !!pendingMedia;
  if (!body && !hadMedia) return;
  if (!wsReady) return appAlert('Realtime connection is not ready.');
  const request_id = crypto.randomUUID(), media = hadMedia ? { id: pendingMedia.id } : null;
  pendingMessages.set(request_id, { body, receiver_id: selected.id, media });
  wsSend({ type: 'message', receiver_id: selected.id, body, request_id, reply_to_id: replyTarget?.id || null, media });
  input.value = '';
  cancelReplyTarget();
  pendingMedia = null;
  $('#mediaPreview')?.classList.add('hidden');
  if ($('#mediaPreview')) $('#mediaPreview').innerHTML = '';
  stopTyping();
}

function typing() {
  if (!selected || !settings.typing_indicator || !wsReady) return;
  const to = Number(selected.id);
  if (typingSentTo !== to) { wsSend({ type: 'typing', to, active: true }); typingSentTo = to; }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1400);
}
function stopTyping() {
  clearTimeout(typingTimer);
  if (typingSentTo && wsReady) wsSend({ type: 'typing', to: typingSentTo, active: false });
  typingSentTo = 0;
}
function setRT(ok, text) {
  wsReady = ok;
  const e = $('#rtStatus'); if (!e) return;
  e.textContent = text;
  e.classList.toggle('ok', ok);
  e.classList.toggle('bad', !ok);
}
function wsSend(packet) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet)); }
function waitForWSReady(timeout = 10000) {
  if (wsReady) return Promise.resolve(true);
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (wsReady) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started >= timeout) { clearInterval(timer); resolve(false); }
    }, 100);
  });
}
function wsRequest(type, payload = {}, timeout = 10000) {
  return new Promise(async (resolve, reject) => {
    if (!(await waitForWSReady(timeout))) return reject(Error('Realtime connection is not ready.'));
    const request_id = crypto.randomUUID();
    const timer = setTimeout(() => { pendingHistory.delete(request_id); reject(Error('Realtime request timed out.')); }, timeout);
    pendingHistory.set(request_id, { resolve, reject, timer, type });
    wsSend({ type, request_id, ...payload });
  });
}

async function getIceConfig() {
  try {
    const d = await api('/api/ice-servers');
    if (Array.isArray(d.iceServers) && d.iceServers.length) return { iceServers: d.iceServers };
  } catch {}
  return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
}
function closeCallUI() { document.querySelector('.callOverlay')?.remove(); }
async function endCall(notify = true) {
  const c = activeCall; if (!c) return;
  if (notify && wsReady) wsSend({ type: 'call:end', to: c.peerId, call_id: c.callId });
  try { c.pc?.close(); } catch {}
  try { c.stream?.getTracks().forEach(t => t.stop()); } catch {}
  try { c.remoteStream?.getTracks().forEach(t => t.stop()); } catch {}
  activeCall = null;
  closeCallUI();
}
function showCallOverlay({ incoming = false, name, kind }) {
  closeCallUI();
  const box = document.createElement('div');
  box.className = 'callOverlay';
  box.innerHTML = `<div class="callCard"><div class="avatar" style="margin:0 auto 12px;width:68px;height:68px;font-size:24px">${esc(name?.[0]?.toUpperCase() || '?')}</div><b>${esc(name || 'Contact')}</b><br><small style="color:var(--muted)">${incoming ? 'Incoming' : 'Calling'} · ${kind === 'video' ? 'Video' : 'Voice'} call</small><video id="remoteCallVideo" autoplay playsinline style="width:100%;border-radius:14px;margin-top:12px" ${kind === 'video' ? '' : 'hidden'}></video><div class="callActions">${incoming ? '<button id="rejectCall" class="callReject">Decline</button><button id="acceptCall" class="callAccept">Accept</button>' : '<button id="hangupCall" class="callReject">End call</button>'}</div></div>`;
  document.body.appendChild(box);
  box.querySelector('#hangupCall')?.addEventListener('click', () => endCall());
  box.querySelector('#rejectCall')?.addEventListener('click', () => endCall());
  return box;
}
async function startCall(u, kind = 'voice') {
  if (activeCall) return appToast('A call is already active.');
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return appAlert('Calling unsupported.');
  const callId = crypto.randomUUID();
  const pc = new RTCPeerConnection(await getIceConfig());
  activeCall = { callId, peerId: Number(u.id), name: u.name, kind, direction: 'outgoing', pc, stream: null, remoteStream: new MediaStream(), connected: false, pendingCandidates: [] };
  const box = showCallOverlay({ name: u.name, kind });
  const remote = box.querySelector('#remoteCallVideo');
  if (remote) remote.srcObject = activeCall.remoteStream;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' });
    activeCall.stream = stream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.onicecandidate = e => { if (e.candidate) wsSend({ type: 'call:signal', to: u.id, kind, call_id: callId, signal: { candidate: e.candidate } }); };
    pc.ontrack = e => { e.streams[0]?.getTracks().forEach(t => activeCall?.remoteStream?.addTrack(t)); if (e.streams.length) activeCall.connected = true; };
    pc.onconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && activeCall) endCall(false); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'call:signal', to: u.id, kind, call_id: callId, signal: { description: pc.localDescription } });
    box.querySelector('.callCard small').textContent = 'Ringing…';
  } catch (e) { appAlert(e.message); await endCall(false); }
}
async function acceptIncomingCall(p) {
  if (activeCall) return;
  const name = (window.__mychatChats || []).find(x => Number(x.id) === Number(p.from))?.name || 'Contact';
  const pc = new RTCPeerConnection(await getIceConfig());
  activeCall = { callId: p.call_id, peerId: Number(p.from), name, kind: p.kind === 'video' ? 'video' : 'voice', direction: 'incoming', pc, stream: null, remoteStream: new MediaStream(), connected: false, pendingCandidates: [] };
  const box = showCallOverlay({ incoming: true, name, kind: activeCall.kind });
  const remote = box.querySelector('#remoteCallVideo');
  if (remote) remote.srcObject = activeCall.remoteStream;
  box.querySelector('#acceptCall').onclick = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: activeCall.kind === 'video' });
      activeCall.stream = stream;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      pc.onicecandidate = e => { if (e.candidate) wsSend({ type: 'call:signal', to: activeCall.peerId, kind: activeCall.kind, call_id: activeCall.callId, signal: { candidate: e.candidate } }); };
      pc.ontrack = e => { e.streams[0]?.getTracks().forEach(t => activeCall?.remoteStream?.addTrack(t)); if (e.streams.length) activeCall.connected = true; };
      pc.onconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && activeCall) endCall(false); };
      await pc.setRemoteDescription(p.signal.description);
      for (const c of activeCall.pendingCandidates.splice(0)) try { await pc.addIceCandidate(c); } catch {}
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'call:signal', to: activeCall.peerId, kind: activeCall.kind, call_id: activeCall.callId, signal: { description: pc.localDescription } });
      box.querySelector('.callCard small').textContent = 'Connected';
    } catch (e) { appAlert(e.message); endCall(); }
  };
}
async function handleCallSignal(p) {
  if (!activeCall || String(activeCall.callId) !== String(p.call_id)) return;
  try {
    const sig = p.signal || {};
    if (sig.candidate) {
      if (!activeCall.pc.remoteDescription) { activeCall.pendingCandidates.push(sig.candidate); return; }
      await activeCall.pc.addIceCandidate(sig.candidate);
    } else if (sig.description?.type === 'answer' && activeCall.direction === 'outgoing') {
      await activeCall.pc.setRemoteDescription(sig.description);
      for (const c of activeCall.pendingCandidates.splice(0)) try { await activeCall.pc.addIceCandidate(c); } catch {}
      const sm = document.querySelector('.callCard small');
      if (sm) sm.textContent = 'Connected';
      activeCall.connected = true;
    }
  } catch { endCall(false); }
}

function handleWS(p) {
  if (!p?.type) return;
  if (p.request_id && pendingHistory.has(p.request_id) && p.type !== 'history' && p.type !== 'error') {
    const q = pendingHistory.get(p.request_id);
    pendingHistory.delete(p.request_id);
    clearTimeout(q.timer);
    q.resolve(p.type === 'settings' ? (settings = { ...settings, ...(p.settings || {}) }) : p.type === 'blocked:list' ? (p.users || []) : p.type === 'profile' ? p.user : p);
  }
  if (p.type === 'ready') { wsRetry = 0; setRT(true, '● Realtime'); if (selected) requestSelectedHistory(); return; }
  if (p.type === 'chat:list') {
    let chats = p.chats || [];
    if (selected) chats = chats.map(c => Number(c.id) === Number(selected.id) ? { ...c, unread_count: 0 } : c);
    renderChatList(chats);
    if (initialChatId && !selected) { const u = chats.find(x => Number(x.id) === initialChatId); if (u) openChat(u); }
    return;
  }
  if (p.type === 'status:list' || p.type === 'status:update' || p.type === 'status:done') {
    statusItems = p.statuses || statusItems;
    if (document.querySelector('#statusView.open')) renderStatusView();
    return;
  }
  if (p.type === 'call:signal') { if (!activeCall) acceptIncomingCall(p); else handleCallSignal(p); return; }
  if (p.type === 'call:end') { if (activeCall && String(activeCall.callId) === String(p.call_id)) endCall(false); return; }
  if (p.type === 'settings') { settings = { ...settings, ...(p.settings || {}) }; applySettings(); return; }
  if (p.type === 'reaction:done' || p.type === 'reaction:update') {
    const m = messageCache.get(Number(p.message_id));
    if (m) {
      m.reactions = p.reactions || [];
      const bub = document.querySelector(`.bubble[data-message-id="${Number(p.message_id)}"]`);
      if (bub) {
        bub.querySelector('.reactions')?.remove();
        const rx = renderReactions(m);
        if (rx) bub.querySelector('.meta').insertAdjacentHTML('beforebegin', rx);
      }
    }
    return;
  }
  if (p.type === 'message:edited') {
    const m = messageCache.get(Number(p.message_id));
    if (m) { m.body = p.body; m.edited_at = p.edited_at; }
    const bub = document.querySelector(`.bubble[data-message-id="${Number(p.message_id)}"]`);
    if (bub) {
      let bodyEl = bub.querySelector('.bubbleBody');
      if (bodyEl) bodyEl.textContent = p.body;
      const meta = bub.querySelector('.meta');
      if (meta && !meta.querySelector('.editedTag')) meta.insertAdjacentHTML('afterbegin', '<span class="editedTag">edited</span>');
    }
    return;
  }
  if (p.type === 'message:delete:done' || p.type === 'message:deleted') {
    const mid = Number(p.message_id);
    if (p.scope === 'everyone' || p.type === 'message:deleted' || p.scope === 'me') {
      document.querySelector(`.messageRow[data-message-id="${mid}"]`)?.remove();
      messageCache.delete(mid);
    }
    return;
  }
  if (p.type === 'conversation:cleared') {
    if (selected && Number(p.user_id) === Number(selected.id)) {
      lastId = 0; oldestId = 0; ids.clear(); messageCache.clear();
      $('#messages').innerHTML = '<div class="empty">Conversation cleared.</div>';
    }
    return;
  }
  if (p.type === 'profile:request') { const dp = localDp(me?.id); if (dp && wsReady) wsSend({ type: 'profile:announce', dp, to: Number(p.from || 0) }); return; }
  if (p.type === 'profile:update') {
    const u = p.user;
    if (u && Number(u.id) !== Number(me?.id)) {
      if (u.dp_forbidden) { setLocalDp(u.id, null); u.dp = null; } else if (u.dp) setLocalDp(u.id, u.dp);
      if (selected && Number(selected.id) === Number(u.id)) { selected = { ...selected, ...u, dp: localDp(u.id) }; $('#title').textContent = u.name; }
    }
    return;
  }
  if (p.type === 'history') {
    if (selected && Number(p.user_id) === Number(selected.id)) {
      const list = p.messages || [];
      const box = $('#messages');
      const isOlder = !!p.before_id;
      const prevHeight = box.scrollHeight;
      loadingOlder = false;
      hasMoreHistory = !!p.has_more;
      box.querySelector('.loadOlderBtn')?.remove();
      if (!list.length && lastId === 0) box.innerHTML = '<div class="empty">No messages yet.<br>Say hello 👋</div>';
      if (isOlder) {
        [...list].reverse().forEach(m => renderMessage(m, true));
        box.scrollTop = box.scrollHeight - prevHeight;
      } else {
        list.forEach(m => renderMessage(m, false));
      }
      if (hasMoreHistory) {
        const btn = document.createElement('button');
        btn.className = 'loadOlderBtn';
        btn.textContent = '⬆ Load older messages';
        btn.onclick = loadOlderHistory;
        box.prepend(btn);
      }
      const incoming = list.filter(m => Number(m.receiver_id) === Number(me.id));
      incoming.forEach(sendReceiptsForMessage);
      if (incoming.length) scheduleVisibleChatRead();
    }
    return;
  }
  if (p.type === 'presence') {
    const pid = Number(p.user_id), online = !!p.online, lastSeen = p.last_seen || null;
    const text = online ? 'online' : (lastSeen ? 'last seen ' + fmtLastSeen(lastSeen) : 'offline');
    const row = document.querySelector(`.row[data-id="${pid}"]`);
    if (row) { const el = row.querySelector('.rowPresence'); if (el) el.textContent = text; }
    if (selected && Number(selected.id) === pid) $('#sub').textContent = text;
    return;
  }
  if (p.type === 'typing') {
    if (selected && Number(selected.id) === Number(p.from)) {
      $('#typing').textContent = p.active && settings.typing_indicator ? 'typing…' : '';
      $('#typing').classList.toggle('show', !!p.active);
    }
    return;
  }
  if (p.type === 'message') {
    const m = p.message;
    if (Number(m.sender_id) === Number(me.id)) {
      pendingMessages.delete(p.request_id);
      if (selected && Number(selected.id) === Number(m.receiver_id)) renderMessage(m);
    } else if (selected && Number(selected.id) === Number(m.sender_id)) {
      renderMessage(m);
      sendReceiptsForMessage(m);
    } else if (Notification.permission === 'granted' && settings.notifications !== false) {
      const nid = String(m.id);
      if (!notifiedIds.has(nid)) {
        notifiedIds.add(nid);
        try { new Notification(m.sender_name || 'New message', { body: settings.notification_preview === false ? 'New message' : (m.body || 'New message'), icon: '/icon-192.png' }); } catch {}
      }
    }
    return;
  }
  if (p.type === 'delivered' || p.type === 'read') {
    const el = document.querySelector(`.bubble[data-message-id="${p.message_id}"] .ticks`);
    if (el) el.outerHTML = p.type === 'read' ? '<span class="ticks blue">✓✓</span>' : '<span class="ticks">✓✓</span>';
    return;
  }
  if (p.type === 'error') {
    if (p.request_id && pendingHistory.has(p.request_id)) {
      const q = pendingHistory.get(p.request_id);
      pendingHistory.delete(p.request_id);
      clearTimeout(q.timer);
      q.reject(Error(p.error || 'Realtime error'));
    } else if (p.error) {
      appAlert(p.error);
    }
  }
}

function renderStatusView() {
  const box = $('#statusView'); if (!box) return;
  box.classList.add('open');
  const mine = statusItems.filter(s => Number(s.user_id) === Number(me.id));
  const others = statusItems.filter(s => Number(s.user_id) !== Number(me.id));
  box.innerHTML = `<div class="statusHeader"><div><h2>Status</h2><p>24-hour updates from your contacts.</p></div><button id="statusClose" class="topBtn">×</button></div>
    <div class="statusComposerCard"><div class="avatar">${me.dp ? `<img src="${esc(me.dp)}">` : esc(me.name?.[0]?.toUpperCase() || 'M')}</div><div class="statusComposerCopy"><b>My status</b><span>${mine[0] ? `${esc(mine[0].body?.slice(0, 60) || 'Media')} · 👁 ${mine[0].view_count || 0}` : 'Share a text or photo status'}</span></div>${mine[0] ? '<button id="viewMyStatus" class="topBtn" style="width:auto;padding:0 12px">View</button>' : ''}<button id="statusAdd" class="statusAdd">＋</button></div>
    <div class="statusSectionTitle">Recent updates</div>
    <div>${others.length ? others.map(s => `<button class="statusCard ${s.viewed ? 'viewed' : ''}" data-status-id="${s.id}"><div class="statusRing"><div class="avatar">${esc(s.name?.[0]?.toUpperCase() || '?')}</div></div><div><b>${esc(s.name)}</b><br><small>${esc(s.body?.slice(0, 60) || 'Media')} · ${statusRelative(s.created_at)}</small></div></button>`).join('') : '<div style="padding:24px;text-align:center;color:var(--muted)">No recent updates.</div>'}</div>`;
  $('#statusClose').onclick = () => switchPrimaryView('chats');
  $('#statusAdd').onclick = openStatusComposer;
  $('#viewMyStatus')?.addEventListener('click', () => viewStatus(Number(mine[0].id)));
  box.querySelectorAll('[data-status-id]').forEach(b => b.onclick = () => viewStatus(Number(b.dataset.statusId)));
}
function openStatusComposer() {
  const box = document.createElement('div');
  box.className = 'statusModal';
  box.innerHTML = `<div class="statusModalCard"><div style="display:flex;justify-content:space-between;margin-bottom:10px"><b>New status</b><button type="button" data-close style="border:0;background:transparent;font-size:22px;cursor:pointer">×</button></div><textarea id="statusText" maxlength="700" placeholder="Type a status…" style="width:100%;min-height:110px;padding:10px;border-radius:12px;border:1px solid var(--line)"></textarea><button type="button" class="action" id="statusPickMedia">🖼️ Attach photo/video (optional)</button><span id="statusMediaName" style="font-size:11px;color:var(--muted)"></span><div class="statusModalActions"><button type="button" data-close>Cancel</button><button type="button" class="primary" id="publishStatus">Share status</button></div></div>`;
  document.body.appendChild(box);
  let media = null;
  box.querySelectorAll('[data-close]').forEach(b => b.onclick = () => box.remove());
  box.querySelector('#statusPickMedia').onclick = async () => {
    const f = await pickFile('image/*,video/*');
    if (f) { media = await uploadRawMedia(f); $('#statusMediaName').textContent = f.name; }
  };
  box.querySelector('#publishStatus').onclick = async () => {
    const body = box.querySelector('#statusText').value.trim();
    if (!body && !media) return appAlert('Write something or attach media.');
    await wsRequest('status:create', { body, media_id: media?.id || null });
    box.remove(); appToast('Status shared.');
  };
}
async function viewStatus(id) {
  const s = statusItems.find(x => Number(x.id) === Number(id)); if (!s) return;
  const isMine = Number(s.user_id) === Number(me.id);
  if (!s.viewed && !isMine) wsRequest('status:view', { status_id: id }).catch(() => {});
  const box = document.createElement('div');
  box.className = 'statusViewer';
  box.innerHTML = `<div class="statusViewerCard"><div style="display:flex;justify-content:space-between;margin-bottom:10px"><b>${esc(s.name)}</b><button type="button" data-close style="border:0;background:transparent;font-size:22px;cursor:pointer">×</button></div>${s.media?.mime?.startsWith('video/') ? `<video src="${esc(s.media.url)}" controls autoplay style="width:100%;max-height:360px;border-radius:12px"></video>` : s.media?.mime?.startsWith('image/') ? `<img src="${esc(s.media.url)}" style="width:100%;max-height:360px;object-fit:contain;border-radius:12px">` : ''}<p style="margin:12px 0">${esc(s.body || '')}</p>${!isMine ? `<button id="statusLikeBtn" class="action">${s.liked ? '♥ Liked' : '♡ Like'}</button>` : `<small style="color:var(--muted)">👁 ${s.view_count || 0} views · ♥ ${s.like_count || 0} likes</small>`}</div>`;
  document.body.appendChild(box);
  box.onclick = async e => {
    if (e.target === box || e.target.closest('[data-close]')) return box.remove();
    if (e.target.closest('#statusLikeBtn')) {
      const next = !s.liked;
      await wsRequest('status:like', { status_id: id, liked: next });
      s.liked = next;
      box.querySelector('#statusLikeBtn').textContent = next ? '♥ Liked' : '♡ Like';
    }
  };
}

async function connectWS(forceRefresh = false) {
  clearTimeout(wsTimer);
  if (!me || (ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState))) return;
  try {
    await resolveBackendBase(forceRefresh);
    const proto = backendBase.startsWith('https://') ? 'wss' : 'ws';
    const url = `${proto}://${backendBase.replace(/^https?:\/\//, '')}/ws?access_token=${encodeURIComponent(authToken())}`;
    setRT(false, wsRetry ? 'Reconnecting…' : 'Connecting…');
    ws = new WebSocket(url);
    ws.onopen = () => {
      setRT(true, '● Realtime');
      wsSend({ type: 'sync' });
      const ownDp = localDp(me?.id);
      if (ownDp) wsSend({ type: 'profile:announce', dp: ownDp });
      if (selected) setTimeout(requestSelectedHistory, 100);
    };
    ws.onmessage = e => { try { handleWS(JSON.parse(e.data)); } catch {} };
    ws.onerror = () => setRT(false, 'WS Error');
    ws.onclose = e => {
      wsReady = false;
      setRT(false, `Reconnecting… (${e.code})`);
      wsRetry = Math.min(wsRetry + 1, 6);
      wsTimer = setTimeout(() => connectWS(true), Math.min(15000, 1000 * 2 ** wsRetry));
    };
  } catch {
    wsReady = false;
    setRT(false, 'Offline');
    wsRetry = Math.min(wsRetry + 1, 6);
    wsTimer = setTimeout(() => connectWS(true), Math.min(20000, 1500 * wsRetry));
  }
}

function toggleSearchBar() {
  const box = document.querySelector('.search');
  const open = !box.classList.contains('open');
  box.classList.toggle('open', open);
  if (open) $('#search')?.focus(); else closeSearchBar();
}
function closeSearchBar() {
  document.querySelector('.search')?.classList.remove('open');
  if ($('#search')) $('#search').value = '';
  $('#searchResults')?.classList.add('hidden');
  if ($('#searchResults')) $('#searchResults').innerHTML = '';
}
async function search() {
  const q = $('#search')?.value.trim() || '';
  const results = $('#searchResults');
  if (!results) return;
  if (q.length < 2) { results.classList.add('hidden'); results.innerHTML = ''; return; }
  try {
    const d = await api('/api/search', { q });
    results.classList.remove('hidden');
    results.innerHTML = d.users.map(u => `<div class="row" data-id="${u.id}"><div class="avatar">${esc(u.name?.[0]?.toUpperCase() || '?')}</div><div class="info"><div class="name">${esc(u.name)}</div><div class="sub">${esc(u.phone)}</div></div></div>`).join('') || '<div style="padding:12px;color:var(--muted);font-size:12px">No users found.</div>';
    results.querySelectorAll('.row').forEach(b => b.onclick = () => {
      const u = d.users.find(x => x.id == b.dataset.id);
      closeSearchBar();
      if (u) openChat(u);
    });
  } catch (e) { appAlert(e.message); }
}

async function openSettings(tab = null) {
  await waitForWSReady();
  const av = me.dp ? `<img src="${esc(me.dp)}">` : esc(me.name[0].toUpperCase());
  const items = [
    ['account', '👤', 'Account', 'Profile name, photo & password'],
    ['privacy', '🔒', 'Privacy', 'Last seen, online, DP & blocked users'],
    ['chat', '💬', 'Chats', 'Theme, wallpaper & message density'],
    ['notifications', '🔔', 'Notifications', 'Desktop alerts & previews'],
    ['about', '✨', 'About', 'MyChat Web PC edition']
  ];
  const panels = {
    account: `<div class="settingsPageHead"><button id="settingsPageBack" class="settingsPageBack">‹</button><div><h1>Account</h1><p>Manage your profile and password.</p></div></div>
      <div class="setting"><b>Profile photo</b><button id="changeDP" class="action">Choose photo</button></div>
      <div class="setting"><b>Profile name</b><input id="profileName" type="text" value="${esc(me.name)}"><button id="saveName" class="action">Save name</button></div>
      <div class="setting"><b>Password</b><div class="passwordRow"><input id="currentPass" type="password" placeholder="Current password"><button type="button" class="miniEye" data-for="currentPass">◉</button></div><div class="passwordRow"><input id="newPass" type="password" placeholder="New password (6+ chars)"><button type="button" class="miniEye" data-for="newPass">◉</button></div><button id="changePass" class="action">Change password</button></div>
      <div class="setting"><button id="logoutBtn" class="action danger">Log out</button></div>`,
    privacy: `<div class="settingsPageHead"><button id="settingsPageBack" class="settingsPageBack">‹</button><div><h1>Privacy</h1><p>Manage visibility and blocked users.</p></div></div>
      <div class="setting"><label class="settingSwitch"><span><b>Read receipts</b><small>Show blue ticks when read</small></span><input id="read" type="checkbox" ${settings.read_receipts ? 'checked' : ''}><i></i></label></div>
      <div class="setting"><b>Online visibility</b><select id="onlineVisibility"><option value="everyone">Everyone</option><option value="nobody">Nobody</option></select></div>
      <div class="setting"><b>Last seen</b><select id="lastSeen"><option value="everyone">Everyone</option><option value="nobody">Nobody</option></select></div>
      <div class="setting"><b>Blocked contacts</b><button id="blockedBtn" class="action">View blocked contacts</button><div id="blockedList"></div></div>`,
    chat: `<div class="settingsPageHead"><button id="settingsPageBack" class="settingsPageBack">‹</button><div><h1>Chats</h1><p>Appearance and keyboard behavior.</p></div></div>
      <div class="setting"><label class="settingSwitch"><span><b>Typing indicator</b><small>Show when typing</small></span><input id="typeSet" type="checkbox" ${settings.typing_indicator ? 'checked' : ''}><i></i></label></div>
      <div class="setting"><label class="settingSwitch"><span><b>Enter to send</b><small>Press Enter to send messages</small></span><input id="enterSet" type="checkbox" ${settings.enter_to_send ? 'checked' : ''}><i></i></label></div>
      <div class="setting"><b>Theme</b><select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select></div>
      <div class="setting"><b>Wallpaper</b><select id="wall"><option value="classic">Classic</option><option value="aurora">Aurora</option><option value="ocean">Ocean</option><option value="midnight">Midnight</option><option value="plain">Plain</option></select></div>
      <div class="setting"><b>Message density</b><select id="density"><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option></select></div>`,
    notifications: `<div class="settingsPageHead"><button id="settingsPageBack" class="settingsPageBack">‹</button><div><h1>Notifications</h1><p>Desktop notification preferences.</p></div></div>
      <div class="setting"><label class="settingSwitch"><span><b>Message notifications</b></span><input id="notif" type="checkbox" ${settings.notifications ? 'checked' : ''}><i></i></label></div>
      <div class="setting"><label class="settingSwitch"><span><b>Message preview</b></span><input id="previewNotif" type="checkbox" ${settings.notification_preview !== false ? 'checked' : ''}><i></i></label></div>
      <div class="setting"><button id="enableNotifSettings" class="action">Enable / refresh push notifications</button></div>`,
    about: `<div class="settingsPageHead"><button id="settingsPageBack" class="settingsPageBack">‹</button><div><h1>About MyChat</h1><p>MyChat PC Web Client — connected to your Windows backend.</p></div></div>
      <div class="setting"><b>Backend URL</b><small>${esc(backendBase || 'Connecting…')}</small></div>`
  };

  function showHome() {
    $('#drawer').innerHTML = `<div class="drawerHead"><button id="setBack" style="border:0;background:transparent;font-size:26px;cursor:pointer">‹</button><h2 style="margin:0">Settings</h2></div><div class="profileCard"><div class="avatar">${av}</div><div><b>${esc(me.name)}</b><div class="sub">${esc(me.phone)}</div></div></div><div class="settingsHomeList">${items.map(x => `<button class="settingsHomeItem" data-tab="${x[0]}"><span class="homeItemIcon">${x[1]}</span><span class="homeItemText"><strong>${x[2]}</strong><small>${x[3]}</small></span><span>›</span></button>`).join('')}</div>`;
    $('#setBack').onclick = closeSettings;
    document.querySelectorAll('.settingsHomeItem').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  }
  function showTab(name) {
    $('#drawer').innerHTML = `<div class="drawerHead"><button id="setBack" style="border:0;background:transparent;font-size:26px;cursor:pointer">‹</button><h2 style="margin:0">${items.find(x => x[0] === name)?.[2] || 'Settings'}</h2></div><div id="settingPanel" class="settingPanel">${panels[name] || panels.account}</div>`;
    $('#setBack').onclick = showHome;
    $('#settingsPageBack').onclick = showHome;
    if ($('#lastSeen')) $('#lastSeen').value = settings.last_seen_visibility || 'everyone';
    if ($('#onlineVisibility')) $('#onlineVisibility').value = settings.online_visibility || 'everyone';
    if ($('#theme')) $('#theme').value = settings.theme || 'light';
    if ($('#wall')) $('#wall').value = settings.wallpaper || 'classic';
    if ($('#density')) $('#density').value = settings.message_density || 'comfortable';
    ['notif', 'read', 'typeSet', 'enterSet', 'lastSeen', 'onlineVisibility', 'theme', 'wall', 'density', 'previewNotif'].forEach(id => {
      const el = $('#' + id);
      if (el) el.onchange = saveSettings;
    });
    document.querySelectorAll('.miniEye').forEach(btn => btn.onclick = () => { const i = $('#' + btn.dataset.for); if (i) i.type = i.type === 'password' ? 'text' : 'password'; });
    if ($('#blockedBtn')) $('#blockedBtn').onclick = loadBlockedContacts;
    if ($('#changeDP')) $('#changeDP').onclick = uploadDP;
    if ($('#saveName')) $('#saveName').onclick = async () => { me = await wsRequest('profile:set', { name: $('#profileName').value.trim() }); closeSettings(); appToast('Name updated'); };
    if ($('#enableNotifSettings')) $('#enableNotifSettings').onclick = enableNotifications;
    if ($('#logoutBtn')) $('#logoutBtn').onclick = logout;
    if ($('#changePass')) $('#changePass').onclick = changePassword;
  }
  showHome();
  if (tab) showTab(tab);
  $('#drawer').classList.add('open');
  $('#shade').classList.add('show');
}
function closeSettings() { $('#drawer')?.classList.remove('open'); $('#shade')?.classList.remove('show'); }
async function loadBlockedContacts() {
  const list = await wsRequest('blocked:list', {});
  const box = $('#blockedList'); if (!box) return;
  box.innerHTML = list.length ? list.map(u => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0"><span>${esc(u.name)} (${esc(u.phone)})</span><button class="action" style="width:auto;margin:0" data-id="${u.id}">Unblock</button></div>`).join('') : '<small>No blocked users.</small>';
  box.querySelectorAll('button').forEach(b => b.onclick = async () => { await wsRequest('block', { user_id: Number(b.dataset.id), blocked: false }); loadBlockedContacts(); });
}
async function changePassword() {
  const current_password = $('#currentPass')?.value || '', new_password = $('#newPass')?.value || '';
  if (!current_password || new_password.length < 6) return appAlert('Enter current password and a 6+ char new password.');
  try { await api('/api/change-password', { current_password, new_password }); appToast('Password changed.'); } catch (e) { appAlert(e.message); }
}
async function logout() {
  if (!(await appConfirm('Log out from this device?', 'Log out?'))) return;
  await api('/api/logout', {}).catch(() => {});
  await clearAuthToken();
  location.reload();
}
async function saveSettings() {
  const val = id => document.getElementById(id);
  settings = {
    ...settings,
    notifications: val('notif') ? !!val('notif').checked : !!settings.notifications,
    read_receipts: val('read') ? !!val('read').checked : !!settings.read_receipts,
    typing_indicator: val('typeSet') ? !!val('typeSet').checked : !!settings.typing_indicator,
    enter_to_send: val('enterSet') ? !!val('enterSet').checked : !!settings.enter_to_send,
    last_seen_visibility: val('lastSeen')?.value ?? settings.last_seen_visibility,
    online_visibility: val('onlineVisibility')?.value ?? settings.online_visibility,
    theme: val('theme')?.value ?? settings.theme,
    wallpaper: val('wall')?.value ?? settings.wallpaper,
    message_density: val('density')?.value ?? settings.message_density,
    notification_preview: val('previewNotif') ? !!val('previewNotif').checked : settings.notification_preview !== false
  };
  applySettings();
  localStorage.setItem('mychat_settings_v3', JSON.stringify(settings));
  if (wsReady) settings = await wsRequest('settings:set', { settings }).catch(() => settings);
}
function applySettings() {
  const theme = settings.theme || 'light';
  document.body.classList.toggle('dark', theme === 'dark');
  document.body.classList.toggle('reduce-motion', settings.animations === false);
  document.body.dataset.density = settings.message_density || 'comfortable';
  const m = $('#messages');
  const wallpapers = {
    plain: 'none',
    classic: 'radial-gradient(circle at 12px 12px,rgba(110,100,90,.13) 0 1px,transparent 2px),linear-gradient(135deg,#efe9df,#e5ded3)',
    aurora: 'radial-gradient(circle at 20% 15%,rgba(99,102,241,.22),transparent 35%),linear-gradient(135deg,#f3f7ff,#eefaf7)',
    ocean: 'radial-gradient(circle at 20% 10%,rgba(14,165,233,.22),transparent 38%),linear-gradient(145deg,#eaf7ff,#e8f4f2)',
    midnight: 'linear-gradient(145deg,#172234,#0d1824)'
  };
  if (m && theme !== 'dark') m.style.backgroundImage = wallpapers[settings.wallpaper] || wallpapers.classic;
  else if (m && theme === 'dark') m.style.backgroundImage = 'none';
}
async function uploadDP() {
  const f = await pickFile('image/*'); if (!f) return;
  try {
    const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
    const size = 400, c = document.createElement('canvas'); c.width = c.height = size;
    const sc = Math.max(size / img.width, size / img.height), w = img.width * sc, h = img.height * sc;
    c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    URL.revokeObjectURL(img.src);
    const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.82));
    const fd = new FormData(); fd.append('upload_id', crypto.randomUUID()); fd.append('index', 0); fd.append('total', 1); fd.append('chunk', blob, 'dp.webp');
    const r = await fetch(backendUrl('/api/dp-chunk'), { method: 'POST', body: fd, credentials: 'include', headers: { ...authHeaders() } });
    const d = await r.json();
    if (!r.ok || !d.ok) throw Error(d.error || 'Upload failed');
    const dpUrl = d.dp + '?v=' + Date.now();
    me.dp = dpUrl; setLocalDp(me.id, dpUrl);
    if (wsReady) wsSend({ type: 'profile:announce', dp: dpUrl });
    closeSettings();
    appToast('Profile photo updated');
  } catch (e) { appAlert(e.message); }
}

function showDP(url) {
  const m = $('#dpModal'), img = $('#dpLarge');
  if (!m || !img || !url) return;
  img.src = url; m.classList.add('open');
}
function showContactInfo(u) {
  const box = document.createElement('div');
  box.className = 'contactInfoModal';
  box.innerHTML = `<div class="contactInfoCard"><h2>${esc(u.name)}</h2><p style="color:var(--muted)">${esc(u.phone || '')}</p><p>${u.online ? 'Online' : (u.last_seen ? 'Last seen ' + esc(fmtLastSeen(u.last_seen)) : 'Offline')}</p><button class="primary" data-close>Close</button></div>`;
  document.body.appendChild(box);
  box.onclick = e => { if (e.target === box || e.target.closest('[data-close]')) box.remove(); };
}
document.addEventListener('click', e => { if (e.target.id === 'dpClose' || e.target.id === 'dpModal') $('#dpModal')?.classList.remove('open'); });
$('#pwaInstallBtn')?.addEventListener('click', installPWA);
$('#pwaInstallClose')?.addEventListener('click', hidePWAInstall);
$('#notifyBtn')?.addEventListener('click', enableNotifications);
$('#notifyClose')?.addEventListener('click', hideNotificationPrompt);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/firebase-messaging-sw.js?v=79.0', { scope: '/', updateViaCache: 'none' }).catch(() => {});
ensureSelectionBar();
try { const raw = localStorage.getItem('mychat_settings_v3'); if (raw) settings = { ...settings, ...JSON.parse(raw) }; } catch {}
applySettings();
boot();
