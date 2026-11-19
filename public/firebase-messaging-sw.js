const CACHE_NAME = 'mychat-shell-v84';
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(['/manifest.json','/','/browser.js','/firebase-config.js','/icon-192.png','/icon-512.png'])).catch(()=>{}));
});
self.addEventListener('activate', event => { event.waitUntil((async()=>{ const keys=await caches.keys(); const keep=new Set([CACHE_NAME,'mychat-auth-v1','mychat-media-v1']); await Promise.all(keys.filter(k=>!keep.has(k)).map(k=>caches.delete(k))); await self.clients.claim(); })()); });
importScripts('/firebase-config.js?v=79.0');
importScripts('https://www.gstatic.com/firebasejs/12.17.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.17.1/firebase-messaging-compat.js');
const firebaseSetup = self.__MYCHAT_FIREBASE__;
let messaging = null;
try { if (firebaseSetup?.firebaseConfig?.apiKey && firebaseSetup?.firebaseConfig?.appId) { firebase.initializeApp(firebaseSetup.firebaseConfig); messaging = firebase.messaging(); } } catch(e) { messaging = null; }
async function getAuthToken(){try{const c=await caches.open('mychat-auth-v1'),r=await c.match('/__mychat_auth_token');return r?await r.text():''}catch{return ''}}
async function getBackendBase(){
  const urls = ['https://raw.githubusercontent.com/RaunakPratap/chat.app/main/backend-url.txt?ts='+Date.now(), '/runtime-config.json?ts='+Date.now(), '/api/backend-url?ts='+Date.now()];
  for (const u of urls) {
    try{const r=await fetch(u,{cache:'no-store'});if(!r.ok)continue;const t=(await r.text()).trim();if(/^https?:\/\/\S+$/i.test(t))return t.replace(/\/+$/,'');const j=JSON.parse(t);if(j.backend_url||j.url)return String(j.backend_url||j.url).replace(/\/+$/,'');}catch{}
  }
  return '';
}
async function acknowledgeDelivery(messageId,overrideBase=''){if(!messageId)return;try{const base=String(overrideBase||await getBackendBase()).replace(/\/+$/,''),token=await getAuthToken();if(!base||!token)return;await fetch(base+'/__realtime/receipt',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({message_id:Number(messageId)})});}catch{}}
if (messaging) messaging.onBackgroundMessage(async payload => {
  const d=payload.data||{}; if(d.type!=='chat_message') return;
  await acknowledgeDelivery(d.message_id,d.backend_url||'');
  const preview=d.preview!=='0';
  await self.registration.showNotification(d.title||'MyChat',{body:preview?(d.body||'New message'):'New message',icon:'/icon-192.png',badge:'/icon-192.png',tag:'message-'+(d.message_id||d.chat_id||'message'),renotify:true,silent:false,vibrate:d.vibrate==='0'?undefined:[120,70,120],data:d});
});
self.addEventListener('notificationclick',event=>{const d=event.notification.data||{},sender=d.sender_id||d.chat_id||'';event.notification.close();event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async cs=>{const url='/?chat='+encodeURIComponent(sender);for(const c of cs){if('focus' in c){await c.focus();if('navigate' in c)await c.navigate(url);return c;}}return clients.openWindow(url);}));});
self.addEventListener('fetch',event=>{const u=new URL(event.request.url);if(u.origin!==self.location.origin||event.request.method!=='GET')return;if(u.pathname==='/browser.js'||u.pathname==='/firebase-config.js'||u.pathname==='/runtime-config.json'||u.pathname==='/backend-url.txt'){event.respondWith(fetch(event.request).then(res=>{if(res.ok){const clone=res.clone();caches.open(CACHE_NAME).then(c=>c.put(event.request,clone));}return res;}).catch(()=>caches.match(event.request)));}else if(['/manifest.json','/icon-192.png','/icon-512.png'].includes(u.pathname)){event.respondWith(caches.match(event.request).then(c=>c||fetch(event.request)));}else if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match('/')));}});
