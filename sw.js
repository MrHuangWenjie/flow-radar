// App shell only. Never cache or intercept external market data or API keys.
const CACHE='flow-radar-shell-v3';
const ASSETS=['./','./index.html','./intraday.js','./fusion.js','./icon.svg','./manifest.webmanifest'];
self.addEventListener('install', event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate', event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin||!ASSETS.some(a=>url.pathname.endsWith(a.replace('./','/'))))return;
  // Network-first to ensure UI patches deploy quickly on mobile. Offline fallback shell.
  event.respondWith(fetch(req).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put(req,copy));}return response;}).catch(()=>caches.match(req)));
});
