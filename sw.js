// Service worker Tabi : appli disponible hors ligne, fond de carte mis en cache au fil de l'usage.
const SHELL = 'tabi-shell-v15';
const TILES = 'tabi-tiles-v1';
const MAPMETA = 'tabi-mapmeta-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'routes.js', 'drive.js', 'store.js', 'config.js', 'manifest.webmanifest',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png'];

// Installation tolérante : un fichier indisponible ne doit pas empêcher l'installation de l'appli.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => Promise.allSettled(FILES.map(f => c.add(new Request(f, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => ![SHELL, TILES, MAPMETA].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function cacheFirst(req, name){
  const c = await caches.open(name); const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r;
}
async function networkFirst(req, name){
  const c = await caches.open(name);
  try { const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }
  catch (e){ const hit = await c.match(req); if (hit) return hit; throw e; }
}
async function staleWhileRevalidate(req, name){
  const c = await caches.open(name); const hit = await c.match(req);
  const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  // Données Google (Drive, connexion) et recherche de lieux : jamais en cache.
  if (/googleapis\.com$|accounts\.google\.com$|nominatim\.openstreetmap\.org$/.test(u.hostname)) return;
  if (u.hostname.endsWith('openfreemap.org')){
    if (/\.(pbf|mvt|png|webp|jpg)$/.test(u.pathname)) e.respondWith(cacheFirst(req, TILES));
    else e.respondWith(networkFirst(req, MAPMETA)); // style, tilejson, polices, sprites
    return;
  }
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com'){ e.respondWith(staleWhileRevalidate(req, SHELL)); return; }
  // Appli : réseau d'abord (dernière version), cache si hors ligne.
  if (u.origin === self.location.origin) e.respondWith(networkFirst(req, SHELL));
});
