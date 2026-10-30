// Tabi — application principale. Données : un fichier JSON par élément dans le dossier Drive « data »,
// cache local IndexedDB, envois différés hors ligne. Voir README.md pour le format.
import { CONFIG } from './config.js';
import { drive, signIn, hasToken, clearToken } from './drive.js';
import { idb } from './store.js';
import { walkRoute, transitNear, poisAlong, shapeCoords } from './routes.js';

/* ================= utilitaires ================= */
const $ = s => document.querySelector(s);
function h(tag, attrs, ...kids){
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})){
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)){ if (c == null || c === false) continue; el.append(c instanceof Node ? c : document.createTextNode(String(c))); }
  return el;
}
const LS = { get(k){ try { return localStorage.getItem(k); } catch { return null; } }, set(k, v){ try { localStorage.setItem(k, v); } catch {} } };
function toast(msg){ const r = $('#toastRoot'); r.replaceChildren(h('div', { class: 'toast', role: 'status' }, msg)); clearTimeout(toast.t); toast.t = setTimeout(() => r.replaceChildren(), 3400); }
const pad2 = n => String(n).padStart(2, '0');
const isoDay = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDay = (s, o) => parseDay(s).toLocaleDateString('fr-FR', o || { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = iso => { const d = new Date(iso); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const todayIso = () => isoDay(new Date());
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); };
function daysBetween(a, b){ const out = []; if (!a || !b) return out; let d = parseDay(a); const e = parseDay(b); let g = 0; while (d <= e && g < 120){ out.push(isoDay(d)); d.setDate(d.getDate() + 1); g++; } return out; }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const num = v => typeof v === 'number' && isFinite(v) ? v : null;
async function pool(list, n, fn){ const q = [...list]; await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); })); }

const KINDS = { visite: 'Visite', resto: 'Restaurant', hotel: 'Hôtel', activite: 'Activité', transport: 'Transport', autre: 'Autre' };
const kindChip = k => h('span', { class: 'chip k-' + (KINDS[k] ? k : 'autre') }, KINDS[k] || 'Autre');

/* ================= état ================= */
const S = {
  items: new Map(), account: null, folders: null,
  online: navigator.onLine, sync: 'idle', syncErr: null, lastSync: null, pendingCount: 0,
  view: LS.get('tabi.view') || 'jour', day: null, sheet: null, deferred: false,
};
const all = t => [...S.items.values()].filter(x => x.type === t);
const trip = () => S.items.get('trip') || null;
const meName = () => S.account ? (S.account.displayName || S.account.emailAddress || '').split(' ')[0] : '';

/* ================= données locales + file d'envoi ================= */
async function loadLocal(){
  for (const [, v] of await idb.all('items')) S.items.set(v.id, v);
  S.account = await idb.get('meta', 'account') || null;
  S.folders = await idb.get('meta', 'folders') || null;
  S.lastSync = await idb.get('meta', 'lastSync') || null;
  await countPending();
}
async function countPending(){ S.pendingCount = (await idb.all('outbox')).length; }
async function save(patch, msg){
  const prev = S.items.get(patch.id) || {};
  const it = { ...prev, ...patch, updatedAt: new Date().toISOString(), updatedBy: meName(), _pending: true };
  S.items.set(it.id, it); await idb.put('items', it.id, it);
  await idb.put('outbox', it.id, { kind: 'put', id: it.id, ts: Date.now() + Math.random() });
  await countPending(); if (msg) toast(msg); schedule(); kick();
  return it;
}
async function removeItem(id){
  const it = S.items.get(id); if (!it) return;
  S.items.delete(id); await idb.del('items', id);
  await idb.put('outbox', id, { kind: 'del', id, fileId: it._fileId || null, ts: Date.now() });
  if (it.type === 'media' && it._localBlob){ await idb.del('blobs', id); await idb.del('outbox', 'u:' + id); }
  await countPending(); schedule(); kick();
}
function clean(it){ const o = {}; for (const [k, v] of Object.entries(it)) if (!k.startsWith('_')) o[k] = v; return o; }

/* ================= synchronisation Drive ================= */
const canNet = () => S.online && hasToken() && CONFIG.clientId;
let kickT = null;
function kick(delay = 1200){ clearTimeout(kickT); kickT = setTimeout(() => syncNow(), delay); }

async function ensureFolders(){
  if (S.folders && S.folders.root === CONFIG.rootFolderId) return S.folders;
  const root = CONFIG.rootFolderId;
  try { await drive.get(root, 'id,name'); }
  catch (e){ if (e.code === 'access') throw Object.assign(new Error('Le dossier « Tabi - Japon » n’est pas partagé avec ce compte Google.'), { code: 'noaccess' }); throw e; }
  const F = 'application/vnd.google-apps.folder';
  const f = { root };
  for (const name of ['data', 'photos', 'billets']){
    const c = await drive.child(root, name, F);
    f[name] = c ? c.id : (await drive.createFolder(root, name)).id;
  }
  S.folders = f; await idb.put('meta', 'folders', f); return f;
}
let flushing = false;
async function flush(){
  if (flushing) return; flushing = true;
  try {
    const ops = (await idb.all('outbox')).map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => (a.key.startsWith('u:') ? 0 : 1) - (b.key.startsWith('u:') ? 0 : 1) || a.ts - b.ts);
    for (const op of ops){
      if (op.kind === 'upload'){
        const rec = await idb.get('blobs', op.id); const it = S.items.get(op.id);
        if (!rec || !it){ await idb.del('outbox', op.key); continue; }
        const folder = rec.folder === 'billets' ? S.folders.billets : S.folders.photos;
        const r = await drive.upload(folder, rec.name, rec.blob, rec.mime, { tabiId: op.id });
        await idb.del('outbox', op.key); await idb.del('blobs', op.id);
        const cur = S.items.get(op.id);
        if (cur){ await save({ id: op.id, fileId: r.id, webViewLink: r.webViewLink || null, _localBlob: false }); }
        else await drive.trash(r.id).catch(() => {});
      } else if (op.kind === 'put'){
        const it = S.items.get(op.id);
        if (!it){ await idb.del('outbox', op.key); continue; }
        const body = clean(it);
        const r = it._fileId ? await drive.updateJson(it._fileId, body) : await drive.createJson(S.folders.data, `${it.type}_${it.id}.json`, body);
        const cur = S.items.get(op.id); const latest = await idb.get('outbox', op.key);
        const same = latest && latest.ts === op.ts;
        if (!cur){ if (!latest || latest.kind === 'del') await drive.trash(r.id).catch(() => {}); if (latest && latest.kind === 'del') await idb.del('outbox', op.key); continue; }
        cur._fileId = r.id; cur._version = String(r.version); cur._by = meName(); if (same) cur._pending = false;
        await idb.put('items', cur.id, cur);
        if (same) await idb.del('outbox', op.key);
      } else if (op.kind === 'del'){
        if (op.fileId) await drive.trash(op.fileId).catch(e => { if (e.status !== 404) throw e; });
        await idb.del('outbox', op.key);
      }
    }
  } finally { flushing = false; await countPending(); }
}
async function pull(){
  const files = await drive.list(S.folders.data);
  const seen = new Set();
  const byFile = new Map([...S.items.values()].filter(x => x._fileId).map(x => [x._fileId, x]));
  const todo = [];
  for (const f of files){
    if (!/\.json$/i.test(f.name)) continue;
    seen.add(f.id);
    const loc = byFile.get(f.id);
    if (!loc || loc._version !== String(f.version)) todo.push(f);
  }
  let changed = todo.length > 0;
  await pool(todo, 6, async f => {
    try {
      const obj = await drive.readJson(f.id);
      if (!obj || typeof obj.id !== 'string' || typeof obj.type !== 'string') return;
      const loc = S.items.get(obj.id);
      if (loc && loc._pending) return; // modification locale pas encore envoyée : elle gagne
      const it = { ...obj, _fileId: f.id, _version: String(f.version), _by: (f.lastModifyingUser && f.lastModifyingUser.displayName) || '' };
      S.items.set(it.id, it); await idb.put('items', it.id, it);
    } catch (e){ if (e.code === 'auth' || e.code === 'network') throw e; console.warn('Tabi: fichier illisible', f.name, e); }
  });
  for (const it of [...S.items.values()]){
    if (it._fileId && !seen.has(it._fileId) && !it._pending){ S.items.delete(it.id); await idb.del('items', it.id); changed = true; }
  }
  return changed;
}
let syncing = false;
async function syncNow(){
  if (syncing) return;
  if (!canNet()){ renderSync(); return; }
  syncing = true; S.sync = 'busy'; S.syncErr = null; renderSync();
  try {
    await ensureFolders();
    await flush();
    const changed = await pull();
    S.sync = 'ok'; S.lastSync = new Date().toISOString(); await idb.put('meta', 'lastSync', S.lastSync);
    if (changed) schedule();
  } catch (e){
    S.sync = 'error'; S.syncErr = e.code === 'noaccess' ? e.message : e.code === 'auth' ? null : e.code === 'network' ? 'Réseau indisponible.' : ('Synchronisation interrompue : ' + (e.message || e.code));
    if (e.code === 'network') S.online = false;
    console.warn('Tabi sync', e);
  } finally { syncing = false; renderSync(); }
}
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, CONFIG.syncEveryMs);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(300); });
window.addEventListener('online', () => { S.online = true; kick(300); renderSync(); });
window.addEventListener('offline', () => { S.online = false; renderSync(); });

/* ================= connexion ================= */
async function connect(silent){
  try {
    await signIn({ hint: S.account && S.account.emailAddress, silent });
    const me = await drive.me();
    if (S.account && S.account.emailAddress && me.emailAddress !== S.account.emailAddress){
      // autre compte : on repart d'un cache propre
      for (const s of ['items', 'outbox', 'blobs']) await idb.clear(s);
      S.items.clear(); S.folders = null; await idb.del('meta', 'folders');
    }
    S.account = me; await idb.put('meta', 'account', me);
    S.online = true; await syncNow(); renderAll();
  } catch (e){
    if (e.code === 'closed') return;
    toast(e.code === 'config' ? 'Configuration Google en attente.' : e.code === 'denied' ? 'Accès Google refusé.' : 'Connexion Google impossible : ' + (e.message || e.code));
  }
}
// Le jeton Google dure une heure ; le premier toucher qui suit son expiration le renouvelle (le navigateur exige un geste).
document.addEventListener('click', () => { if (S.account && CONFIG.clientId && S.online && !hasToken()) connect(true); }, true);

function renderSync(){
  const b = $('#sync'); let cls = '', label = '';
  if (!CONFIG.clientId){ cls = 'warn'; label = 'Config'; }
  else if (!S.account){ cls = 'need'; label = 'Se connecter'; }
  else if (!S.online){ cls = 'off'; label = 'Hors ligne' + (S.pendingCount ? ' · ' + S.pendingCount : ''); }
  else if (!hasToken()){ cls = 'need'; label = 'Synchroniser'; }
  else if (S.sync === 'busy'){ cls = 'busy'; label = 'Synchro…'; }
  else if (S.sync === 'error' && S.syncErr){ cls = 'warn'; label = 'Erreur'; }
  else { label = S.pendingCount ? S.pendingCount + ' en attente' : 'À jour'; }
  b.className = 'sync ' + cls; b.textContent = label;
  b.onclick = () => { if (!S.account || !hasToken()) connect(!!S.account); else if (S.syncErr) toast(S.syncErr); else syncNow(); };
}

/* ================= rendu ================= */
let raf = false;
function schedule(){ if (raf) return; raf = true; requestAnimationFrame(() => { raf = false; renderAll(); }); }
const typingIn = root => { const a = document.activeElement; return a && root && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
document.addEventListener('focusout', () => setTimeout(() => { if (S.deferred){ S.deferred = false; renderAll(); } }, 0));
function renderAll(){
  renderSync(); renderHeader(); renderTabs();
  const main = $('#main');
  if (typingIn(main) || typingIn($('#sheetRoot'))){ S.deferred = true; return; }
  const y = window.scrollY;
  main.replaceChildren(...renderMain());
  if (S.view === 'jour') updateMap();
  if (S.sheet) S.sheet.render();
  window.scrollTo(0, y);
}

/* ---- dérivés ---- */
const tripDays = () => { const t = trip(); return t ? daysBetween(t.start, t.end) : []; };
function currentDay(){ const ds = tripDays(); if (!ds.length) return null; if (S.day && ds.includes(S.day)) return S.day; const t = todayIso(); return ds.includes(t) ? t : ds[0]; }
const places = () => all('place').filter(p => p.status !== 'suggested');
const placesOf = day => places().filter(p => (p.day || null) === day).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.time || '').localeCompare(b.time || ''));
const bookings = () => all('booking');
const bookingsOf = day => bookings().filter(b => b.date === day).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
const notesOf = (f, id) => all('note').filter(n => n[f] === id).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
const mediaOf = (f, id, role) => all('media').filter(m => m[f] === id && (!role || m.role === role)).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
const nextOrder = day => { const l = placesOf(day); return (l.length ? Math.max(...l.map(p => p.order ?? 0)) : 0) + 1; };
const duringTrip = day => { const t = trip(); const td = todayIso(); return !!(day && t && td >= t.start && td <= t.end && day <= td); };

function hotelStays(){
  return bookings().filter(b => b.kind === 'hotel' && b.date && !b.cancelled)
    .map(b => ({ b, from: b.date, to: b.endDate && b.endDate > b.date ? b.endDate : addDays(b.date, 1), guessed: !(b.endDate && b.endDate > b.date) }));
}
function hotelAnchor(st){
  const b = st.b, p = b.placeId && S.items.get(b.placeId);
  return { anchor: true, id: p ? p.id : null, bookingId: b.id, name: b.title, kind: 'hotel', guessed: st.guessed,
    lat: p && num(p.lat) != null ? p.lat : num(b.lat), lng: p && num(p.lng) != null ? p.lng : num(b.lng),
    coordSource: p && num(p.lat) != null ? p.coordSource : (num(b.lat) != null ? 'estime' : null),
    mapsUrl: (p && p.mapsUrl) || null, address: (p && p.address) || b.address || null, city: (p && p.city) || b.city || null,
    checkIn: b.time || null, checkOut: b.endTime || null };
}
function dayAnchors(day){
  const st = hotelStays();
  const s = st.find(x => x.from < day && day <= x.to), e = st.find(x => x.from <= day && day < x.to);
  return { start: s ? hotelAnchor(s) : null, end: e ? hotelAnchor(e) : null };
}
function dayModel(day){
  const A = dayAnchors(day);
  const ids = new Set([A.start && A.start.id, A.end && A.end.id].filter(Boolean));
  const ps = placesOf(day).filter(p => !ids.has(p.id));
  return { A, ps };
}

/* ---- liens Google Maps ---- */
function placeQuery(p){ if (num(p.lat) != null && p.coordSource && p.coordSource !== 'estime') return p.lat + ',' + p.lng; return [p.name, p.address || p.city].filter(Boolean).join(', '); }
const placeUrl = p => p.mapsUrl || 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(placeQuery(p));
function legUrl(from, to, mode){
  let u = 'https://www.google.com/maps/dir/?api=1&travelmode=' + mode + '&destination=' + encodeURIComponent(placeQuery(to));
  if (from && from.status !== 'visited') u += '&origin=' + encodeURIComponent(placeQuery(from));
  return u;
}
function parseCoords(s){
  if (!s) return null;
  for (const r of [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&](?:q|query|ll|destination|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/]){
    const m = s.match(r); if (m){ const lat = +m[1], lng = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }; }
  }
  return null;
}
const dist = (a, b) => { const R = 6371e3, t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lng - a.lng) * t; const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const fmtDist = m => m < 950 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 9500 ? 1 : 0).replace('.', ',') + ' km';

/* ================= carte ================= */
const M = { el: null, map: null, markers: [], ready: false, placing: null, focus: null, sig: '', showIdeas: LS.get('tabi.ideas') === '1' };
function mapPanel(){
  if (M.el) return M.el;
  M.inner = h('div', { style: 'position:absolute;inset:0' });
  M.msg = h('div', { class: 'map-msg' }, 'Chargement de la carte…');
  M.banner = h('div', { class: 'map-banner', hidden: true });
  M.tools = h('div', { class: 'map-tools' });
  M.el = h('div', { class: 'map' }, M.inner, M.msg, M.banner, M.tools);
  if (!window.maplibregl){ M.msg.textContent = 'Carte indisponible : la bibliothèque cartographique ne s’est pas chargée.'; return M.el; }
  try {
    M.map = new maplibregl.Map({ container: M.inner, style: CONFIG.mapStyle, center: [139.75, 35.68], zoom: 11, attributionControl: false, cooperativeGestures: false });
  } catch (e){ M.msg.textContent = 'Carte indisponible sur cet appareil (WebGL).'; return M.el; }
  M.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  M.map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
  M.map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
  M.map.on('load', () => {
    M.ready = true; M.msg.hidden = true;
    const css = getComputedStyle(document.documentElement);
    M.map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const col = n => css.getPropertyValue(n).trim();
    M.map.addLayer({ id: 'route-straight', type: 'line', source: 'route', filter: ['all', ['==', ['get', 'done'], false], ['==', ['get', 'kind'], 'straight']], paint: { 'line-color': col('--route') || '#8A93AB', 'line-width': 3, 'line-dasharray': [2, 2] } });
    M.map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['all', ['==', ['get', 'done'], false], ['==', ['get', 'kind'], 'walk']], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': col('--route') || '#8A93AB', 'line-width': 4 } });
    M.map.addLayer({ id: 'route-done', type: 'line', source: 'route', filter: ['==', ['get', 'done'], true], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': col('--stamp') || '#6338B0', 'line-width': 4 } });
    M.map.addSource('focus', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    M.map.addLayer({ id: 'focus-casing', type: 'line', source: 'focus', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 } });
    M.map.addLayer({ id: 'focus-line', type: 'line', source: 'focus', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': col('--stamp') || '#6338B0', 'line-width': 5 } });
    M.sig = ''; updateMap();
  });
  M.map.on('error', e => { if (!M.ready){ M.msg.hidden = false; M.msg.textContent = S.online ? 'Fond de carte indisponible pour le moment.' : 'Hors ligne : seules les zones préparées s’affichent.'; } console.warn('Tabi carte', e && e.error); });
  M.map.on('click', e => {
    if (!M.placing) return;
    const { lng, lat } = e.lngLat; const job = M.placing; M.placing = null; M.banner.hidden = true;
    job({ lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
  });
  return M.el;
}
function startPlacing(text, cb){
  if (!M.map){ toast('Carte indisponible.'); return; }
  if (S.sheet) S.sheet.close();
  if (S.view !== 'jour'){ S.view = 'jour'; renderAll(); }
  M.placing = cb;
  M.banner.replaceChildren(h('span', null, text), h('button', { class: 'btn', type: 'button', onclick: () => { M.placing = null; M.banner.hidden = true; } }, 'Annuler'));
  M.banner.hidden = false; M.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function markerEl(cls, text, onclick, title){
  const el = h('button', { class: 'mk ' + cls, type: 'button', title, 'aria-label': title, onclick: e => { e.stopPropagation(); onclick(); } }, text);
  return el;
}
function updateMap(){
  if (!M.map) return;
  const day = currentDay();
  M.tools.replaceChildren(
    h('button', { class: 'btn', type: 'button', onclick: () => startPlacing('Touche la carte pour placer le nouveau lieu', c => openPlaceForm({ day, lat: c.lat, lng: c.lng, coordSource: 'carte' })) }, '＋ Lieu sur la carte'),
    h('button', { class: 'btn', type: 'button', 'aria-pressed': String(M.showIdeas), onclick: () => { M.showIdeas = !M.showIdeas; LS.set('tabi.ideas', M.showIdeas ? '1' : '0'); M.sig = ''; updateMap(); } }, M.showIdeas ? 'Masquer les idées' : 'Voir les idées'));
  if (!M.ready || !day) return;
  const { seq } = daySeq(day);
  const pts = seq.filter(hasPos);
  const ps = seq.filter(p => !p.anchor);
  const ideas = M.showIdeas ? placesOf(null).filter(hasPos) : [];
  M.markers.forEach(m => m.remove()); M.markers = [];
  const add = (el, p) => M.markers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(M.map));
  for (const p of ideas) add(markerEl('i', '?', () => openPlace(p.id), 'Idée : ' + p.name), p);
  pts.forEach(p => {
    const i = ps.indexOf(p);
    add(p.anchor ? markerEl('h', 'H', () => openBooking(p.bookingId), p.name)
      : markerEl((p.status === 'visited' ? 'v' : '') + (p.status === 'skipped' ? ' s' : ''), String(i + 1), () => openPlace(p.id), (i + 1) + '. ' + p.name), p);
  });
  // tracés de la journée : tracé à pied réel quand il est calculé, sinon ligne droite pointillée
  const feats = [];
  for (let j = 1; j < pts.length; j++){
    const a = pts[j - 1], b = pts[j]; const g = legInfo(a, b);
    const done = (a.anchor || a.status === 'visited') && !b.anchor && b.status === 'visited';
    const coords = g.eff === 'walk' && g.route ? shapeCoords(g.route) : [[a.lng, a.lat], [b.lng, b.lat]];
    feats.push({ type: 'Feature', properties: { done, kind: g.eff === 'walk' && g.route ? 'walk' : 'straight' }, geometry: { type: 'LineString', coordinates: coords } });
  }
  const src = M.map.getSource('route'); if (src) src.setData({ type: 'FeatureCollection', features: feats });
  // trajet mis en avant (fiche trajet)
  const F = M.focus && legFromId(M.focus, day);
  const ffeats = [];
  if (F){
    const g = legInfo(F.a, F.b);
    if (g.eff === 'walk' && g.route) ffeats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: shapeCoords(g.route) } });
    if (g.eff !== 'walk' && g.L && g.L.lastMile && g.L.lastMile.route) ffeats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: shapeCoords(g.L.lastMile.route) } });
    if (g.eff === 'walk'){
      g.via.forEach((v, k) => add(markerEl('via', String.fromCharCode(97 + k), () => openLeg(F.a, F.b), 'Étape : ' + v.name), v));
      if (g.style === 'promenade' && g.L && g.L.pois) for (const p of g.L.pois) if (!g.via.some(v => v.id === p.id)) add(markerEl('poi', '★', () => openPoi(F.a, F.b, p), p.cat + ' : ' + p.name), p);
    } else if (g.eff === 'transit' && g.L && g.L.near){
      for (const side of ['a', 'b']){ const n = g.L.near[side]; if (!n) continue;
        n.entrances.slice(0, 8).forEach(e => add(markerEl('ent', e.ref || 'M', () => toast((e.ref ? 'Sortie ' + e.ref : 'Entrée') + (e.name ? ' · ' + e.name : '') + ' · ' + fmtDist(e.d)), 'Entrée/sortie ' + (e.ref || '')), e));
        n.bus.slice(0, 4).forEach(s => add(markerEl('bus', 'B', () => toast('Bus : ' + s.name + ' · ' + fmtDist(s.d)), 'Arrêt de bus ' + s.name), s)); }
    }
    if (!M.placing){
      M.banner.replaceChildren(h('span', null, F.a.name + ' → ' + F.b.name + ' · ' + legLabel(g)), h('button', { class: 'btn', type: 'button', onclick: () => { M.focus = null; M.banner.hidden = true; M.sig = ''; updateMap(); } }, 'Fermer'));
      M.banner.hidden = false;
    }
  } else if (!M.placing) M.banner.hidden = true;
  const fsrc = M.map.getSource('focus'); if (fsrc) fsrc.setData({ type: 'FeatureCollection', features: ffeats });
  // cadrage : seulement quand la journée ou le trajet affiché change
  const sig = day + '|' + (F ? M.focus : '') + '|' + pts.length;
  if (sig !== M.sig){
    let fit = pts.length ? pts.map(p => [p.lng, p.lat]) : ideas.map(p => [p.lng, p.lat]);
    if (F){ const c = ffeats.flatMap(f => f.geometry.coordinates); fit = c.length ? c : [[F.a.lng, F.a.lat], [F.b.lng, F.b.lat]]; }
    if (fit.length === 1) M.map.jumpTo({ center: fit[0], zoom: 15 });
    else if (fit.length > 1){ const b = new maplibregl.LngLatBounds(); fit.forEach(c => b.extend(c)); M.map.fitBounds(b, { padding: 50, maxZoom: 17, duration: F ? 600 : 0 }); }
  }
  M.sig = sig;
  requestAnimationFrame(() => M.map && M.map.resize());
}

/* ---- carte hors ligne : pré-téléchargement des tuiles d'une zone ---- */
function tilesFor(b, z){
  const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
  const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
  const out = []; const x0 = lon2x(b.w, z), x1 = lon2x(b.e, z), y0 = lat2y(b.n, z), y1 = lat2y(b.s, z);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  return out;
}
async function tileTemplate(){
  const style = await (await fetch(CONFIG.mapStyle)).json();
  for (const s of Object.values(style.sources || {})){
    if (s.type !== 'vector') continue;
    if (s.tiles && s.tiles[0]) return s.tiles[0];
    if (s.url){ const tj = await (await fetch(s.url)).json(); if (tj.tiles && tj.tiles[0]) return tj.tiles[0]; }
  }
  throw new Error('Modèle de tuiles introuvable.');
}
function zoneOf(pointsList, marginKm){
  const pts = pointsList.filter(p => num(p.lat) != null); if (!pts.length) return null;
  const dLat = marginKm / 111, lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length, dLng = marginKm / (111 * Math.cos(lat0 * Math.PI / 180));
  return { s: Math.min(...pts.map(p => p.lat)) - dLat, n: Math.max(...pts.map(p => p.lat)) + dLat, w: Math.min(...pts.map(p => p.lng)) - dLng, e: Math.max(...pts.map(p => p.lng)) + dLng };
}
function openOfflinePrep(){
  const st = { phase: 'form', done: 0, total: 0, fail: 0, ctl: null };
  const allPts = [...places(), ...hotelStays().map(hotelAnchor)];
  openSheet(close => {
    const zone = zoneOf(allPts, 1.5);
    const plan = zone ? [[10, 13, 0], [14, 15, 0], [16, 16, 0]].map(([a, b]) => { let n = 0; for (let z = a; z <= b; z++) n += tilesFor(zone, z).length; return n; }) : null;
    const total = plan ? plan[0] + plan[1] + plan[2] : 0;
    const body = [];
    if (!zone) body.push(h('div', { class: 'banner' }, 'Ajoute d’abord des lieux positionnés : la zone à préparer est calculée autour d’eux.'));
    else if (st.phase === 'form'){
      body.push(h('div', null, 'Zone couverte : tous les lieux et hôtels du voyage, plus 1,5 km de marge.'),
        h('div', { class: 'muted small' }, `${total} tuiles (zooms 10 à 16). Ordre de grandeur, non mesuré : 20 à 60 Ko par tuile, soit ${Math.round(total * 20 / 1024)} à ${Math.round(total * 60 / 1024)} Mo. Utilise le Wi-Fi.`),
        total > 12000 ? h('div', { class: 'banner warn' }, 'Zone très étendue (villes éloignées) : seuls les zooms 10 à 15 seront préparés pour limiter le volume.') : null,
        h('div', null, h('button', { class: 'btn primary', type: 'button', disabled: !S.online ? true : null, onclick: () => run(zone, total > 12000 ? 15 : 16) }, S.online ? 'Préparer la carte hors ligne' : 'Connexion requise')));
    } else if (st.phase === 'run'){
      body.push(h('div', { class: 'row' }, h('span', { class: 'spin' }), `${st.done} / ${st.total} tuiles${st.fail ? ' · ' + st.fail + ' échecs' : ''}`),
        h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => st.ctl && st.ctl.abort() }, 'Arrêter')));
    } else body.push(h('div', { class: 'banner' }, st.msg));
    body.push(h('div', { class: 'muted small' }, 'Vérifie avant de partir : passe en mode avion et ouvre la carte. Les zones déjà affichées en ligne restent aussi en mémoire.'));
    return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, sheetHead('Carte hors ligne', close), h('div', { class: 'sec' }, body), h('div', { style: 'height:8px' }));
  });
  async function run(zone, maxZ){
    st.phase = 'run'; st.ctl = new AbortController(); S.sheet.render();
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const tpl = await tileTemplate();
      const list = []; for (let z = 10; z <= maxZ; z++) list.push(...tilesFor(zone, z));
      st.total = list.length;
      let last = 0;
      await pool(list, 6, async ([z, x, y]) => {
        if (st.ctl.signal.aborted) return;
        try { const r = await fetch(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal: st.ctl.signal }); if (!r.ok) st.fail++; else await r.arrayBuffer(); } catch { st.fail++; }
        st.done++; if (Date.now() - last > 400){ last = Date.now(); S.sheet && S.sheet.render(); }
      });
      st.phase = 'done'; st.msg = st.ctl.signal.aborted ? `Arrêté : ${st.done} tuiles en mémoire.` : `Carte prête : ${st.done - st.fail} tuiles en mémoire${st.fail ? ', ' + st.fail + ' échecs (relance plus tard)' : ''}.`;
    } catch (e){ st.phase = 'done'; st.msg = 'Préparation impossible : ' + (e.message || e); }
    S.sheet && S.sheet.render();
  }
}

/* ================= en-tête, onglets ================= */
function renderHeader(){
  const t = trip();
  $('#tripName').textContent = t ? t.name : 'Tabi';
  $('#tripBtn').onclick = openTripSheet;
  const days = $('#days'); const ds = tripDays(); const cur = currentDay(); const td = todayIso();
  const show = !!t && (S.view === 'jour' || S.view === 'souvenirs');
  days.hidden = !show; if (!show) return;
  const sig = ds.join() + cur + places().length;
  if (days.dataset.sig === sig) return;
  days.dataset.sig = sig;
  days.replaceChildren(...ds.map((d, i) => { const n = placesOf(d).length;
    return h('button', { class: 'day' + (d === td ? ' today' : ''), role: 'tab', 'aria-current': String(d === cur), onclick: () => { S.day = d; renderAll(); } },
      h('b', null, fmtDay(d, { weekday: 'short', day: 'numeric' })), h('i', null, 'J' + (i + 1) + (n ? ' · ' + n : ''))); }));
  const el = days.querySelector('[aria-current="true"]'); if (el) el.scrollIntoView({ inline: 'center', block: 'nearest' });
}
const ICONS = {
  jour: 'M9 4l-5 2v14l5-2 6 2 5-2V4l-5 2-6-2zM9 4v14M15 6v14',
  resa: 'M4 7h16v4a2 2 0 000 4v4H4v-4a2 2 0 000-4z M10 7v12',
  idees: 'M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0012 3z',
  souvenirs: 'M4 7h4l2-2h4l2 2h4v12H4z M12 10a3 3 0 100 6 3 3 0 000-6z',
  claude: 'M4 5h16v11H9l-5 4z M8 9h8M8 12h5',
};
function renderTabs(){
  const nS = all('place').filter(p => p.status === 'suggested').length;
  const tabs = [['jour', 'Journée'], ['resa', 'Réservations'], ['idees', 'Idées'], ['souvenirs', 'Souvenirs'], ['claude', nS ? 'Claude · ' + nS : 'Claude']];
  $('#tabs').replaceChildren(...tabs.map(([k, l]) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[k]); svg.append(p);
    return h('button', { type: 'button', 'aria-current': String(S.view === k), onclick: () => { S.view = k; LS.set('tabi.view', k); window.scrollTo(0, 0); renderAll(); } }, svg, l);
  }));
}

/* ================= vues ================= */
function renderMain(){
  if (!CONFIG.clientId) return [welcome('config')];
  if (!S.account) return [welcome('login')];
  if (!trip()){
    if (S.sync === 'busy' || (!S.lastSync && hasToken())) return [h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Lecture du dossier Drive…')];
    if (S.syncErr) return [h('div', { class: 'panel empty' }, h('h3', null, 'Dossier inaccessible'), h('span', null, S.syncErr))];
    if (!S.lastSync) return [h('div', { class: 'panel empty' }, h('h3', null, 'Première synchronisation'), h('span', null, 'Touche « Synchroniser » en haut pour lire le dossier Drive.'))];
    return [tripForm(true)];
  }
  const out = [];
  if (S.syncErr) out.push(h('div', { class: 'banner warn' }, S.syncErr));
  if (S.view === 'jour') out.push(...viewDay());
  else if (S.view === 'resa') out.push(...viewBookings());
  else if (S.view === 'idees') out.push(...viewIdeas());
  else if (S.view === 'souvenirs') out.push(...viewMemories());
  else out.push(...viewClaude());
  return out;
}
function welcome(kind){
  return h('div', { class: 'welcome' },
    h('h1', null, 'Tabi 旅'),
    h('p', { class: 'muted', style: 'margin:0' }, 'Carnet de voyage partagé : journées sur une vraie carte, lieux tamponnés au fil de la visite, réservations et billets, photos et notes. Tout est rangé dans votre dossier Google Drive « Tabi - Japon ».'),
    kind === 'config'
      ? h('div', { class: 'banner warn' }, 'Configuration en cours : l’identifiant de connexion Google n’est pas encore renseigné.')
      : h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => connect(false) }, 'Se connecter avec Google')),
    h('p', { class: 'muted small', style: 'margin:0' }, 'Google affichera « application non validée » : c’est normal pour cette appli privée. Choisis « Paramètres avancés », puis « Accéder à Tabi ».'));
}

/* ---- Journée ---- */
function daySeq(day){
  const { A, ps } = dayModel(day);
  const seq = [];
  if (A.start) seq.push(A.start);
  ps.forEach(p => seq.push(p));
  if (A.end && !(A.start && A.end.bookingId === A.start.bookingId && !ps.length)) seq.push(A.end);
  return { A, ps, seq };
}
function viewDay(){
  const day = currentDay(); if (!day) return [h('div', { class: 'empty' }, 'Ajoute les dates du voyage pour voir les journées.')];
  const { A, ps, seq } = daySeq(day);
  const bks = bookingsOf(day).filter(b => b.kind !== 'hotel');
  const done = ps.filter(p => p.status === 'visited').length;
  const idx = tripDays().indexOf(day);
  const prevOf = p => { const i = seq.indexOf(p); return i > 0 ? seq[i - 1] : null; };
  const rows = [];
  if (A.start) rows.push(anchorRow(A.start, 'Départ', null));
  else if (!A.end) rows.push(anchorRow(null, 'Départ', null, true));
  ps.forEach((p, i) => { const f = prevOf(p); if (f) rows.push(legRow(f, p)); rows.push(stopRow(p, i, f)); });
  if (!ps.length) rows.push(h('div', { class: 'empty' }, h('h3', null, 'Rien de prévu ce jour-là'), h('span', null, 'Ajoute un lieu, pioche dans les idées ou demande à Claude.')));
  const endA = seq[seq.length - 1];
  if (A.end && endA === A.end && seq.length > 1){ const f = seq[seq.length - 2]; rows.push(legRow(f, A.end)); rows.push(anchorRow(A.end, A.start && A.end.bookingId === A.start.bookingId ? 'Retour' : 'Nuit', f)); }
  else if (A.end && !ps.length && !A.start) rows.push(anchorRow(A.end, 'Nuit', null));
  return [
    h('div', { class: 'split' },
      h('div', { class: 'map-col' }, mapPanel()),
      h('div', null,
        h('div', { class: 'spread' },
          h('div', null, h('div', { class: 'eyebrow' }, 'Jour ' + (idx + 1) + ' sur ' + tripDays().length), h('h2', null, fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' }))),
          h('div', { class: 'chip solid' }, done + ' / ' + ps.length + ' tamponnés')),
        bks.length ? h('div', { class: 'panel' }, h('div', { class: 'sec', style: 'padding-bottom:4px' }, h('div', { class: 'eyebrow' }, 'Réservations du jour')), ...bks.map(bookingRow)) : null,
        h('div', { class: 'panel' }, h('div', { class: 'stops' }, rows)),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => openPlaceForm({ day }) }, 'Ajouter un lieu'),
          h('button', { class: 'btn', type: 'button', onclick: () => openDayNote(day) }, 'Note ou photos du jour'),
          seq.length > 1 ? h('button', { class: 'btn', type: 'button', onclick: () => prepareDayLegs(day) }, 'Préparer les trajets') : null),
        seq.length > 1 ? h('div', { class: 'muted small' }, 'Touche un trajet entre deux étapes pour choisir à pied, transports ou taxi, et le mode promenade. « Préparer les trajets » calcule toute la journée à l’avance pour l’avoir hors ligne.') : null))
  ];
}
function anchorRow(a, label, from, hint){
  if (!a) return hint ? h('div', { class: 'stop', style: 'grid-template-columns:44px 1fr' }, h('div', { class: 'stamp hotel' }, 'H'),
    h('div', { class: 'muted', style: 'font-size:13.5px' }, 'Ajoute la réservation d’hôtel avec sa date de départ : il deviendra le point de départ et d’arrivée de chaque journée.')) : null;
  const sub = label === 'Départ' ? (a.checkOut ? 'Check-out ' + a.checkOut : '') : (label === 'Nuit' && a.checkIn ? 'Check-in ' + a.checkIn : '');
  return h('div', { class: 'stop' }, h('div', { class: 'stamp hotel' }, 'H'),
    h('div', { class: 'body', role: 'button', tabindex: '0', onclick: () => openBooking(a.bookingId), onkeydown: e => { if (e.key === 'Enter') openBooking(a.bookingId); } },
      h('div', { class: 'eyebrow' }, label), h('div', { class: 'name' }, a.name),
      h('div', { class: 'meta' }, sub ? h('span', { class: 'mono muted small' }, sub) : null,
        num(a.lat) == null ? h('span', { class: 'chip' }, 'Sans position') : null,
        a.guessed ? h('span', { class: 'chip warn' }, 'Date de départ manquante') : null)),
    from && hasPos(from) && hasPos(a) ? h('a', { class: 'btn ghost', href: legUrlFor(from, a), target: '_blank', rel: 'noopener', 'aria-label': 'Google Maps vers ' + a.name }, 'Y aller')
      : h('a', { class: 'btn ghost', href: placeUrl(a), target: '_blank', rel: 'noopener' }, 'Maps'));
}
function stopRow(p, i, from){
  const st = p.status;
  const np = mediaOf('placeId', p.id, 'photo').length, nn = notesOf('placeId', p.id).length;
  const linked = bookings().filter(b => b.placeId === p.id);
  return h('div', { class: 'stop' + (st === 'skipped' ? ' skipped' : '') },
    h('button', { class: 'stamp' + (st === 'visited' ? ' done' : '') + (st === 'skipped' ? ' skip' : ''), type: 'button', 'aria-label': st === 'visited' ? 'Retirer le tampon' : 'Tamponner : visité', onclick: () => toggleVisit(p) },
      st === 'visited' ? h('span', null, 'VU', h('br'), p.visitedAt ? fmtTime(p.visitedAt) : '') : String(i + 1)),
    h('div', { class: 'body', onclick: () => openPlace(p.id), role: 'button', tabindex: '0', onkeydown: e => { if (e.key === 'Enter') openPlace(p.id); } },
      h('div', { class: 'name' }, p.time ? h('span', { class: 'mono muted', style: 'font-weight:600;margin-right:6px' }, p.time) : null, p.name),
      h('div', { class: 'meta' }, kindChip(p.kind),
        linked.length ? h('span', { class: 'chip solid' }, 'Réservé') : null,
        p.addedDuring ? h('span', { class: 'chip warn' }, 'Ajouté en route') : null,
        num(p.lat) == null ? h('span', { class: 'chip' }, 'Sans position') : (p.coordSource === 'estime' ? h('span', { class: 'chip', title: 'Position estimée' }, '≈ position') : null),
        np ? h('span', { class: 'muted small' }, np + ' photo' + (np > 1 ? 's' : '')) : null,
        nn ? h('span', { class: 'muted small' }, nn + ' note' + (nn > 1 ? 's' : '')) : null,
        p._pending ? h('span', { class: 'muted small' }, '· non synchronisé') : null)),
    from && hasPos(from) && hasPos(p) ? h('a', { class: 'btn ghost', href: legUrlFor(from, p), target: '_blank', rel: 'noopener', 'aria-label': 'Google Maps vers ' + p.name }, 'Y aller')
      : h('a', { class: 'btn ghost', href: placeUrl(p), target: '_blank', rel: 'noopener' }, 'Maps'));
}
async function toggleVisit(p){
  const v = p.status === 'visited';
  await save({ id: p.id, status: v ? 'planned' : 'visited', visitedAt: v ? null : new Date().toISOString(), visitedBy: v ? null : meName() }, v ? 'Tampon retiré' : 'Tamponné · ' + p.name);
}

/* ---- Trajets entre deux étapes ---- */
const hasPos = p => !!p && num(p.lat) != null && num(p.lng) != null;
const pkey = p => p.anchor ? 'h' + p.bookingId : p.id;
const legId = (a, b) => 'leg_' + pkey(a) + '_' + pkey(b);
const legSig = (a, b, via) => [a, ...(via || []), b].map(p => p.lat.toFixed(5) + ',' + p.lng.toFixed(5)).join(';');
const walkMax = () => (trip() && trip().walkMax) || 20;
const GM = { walk: 'walking', transit: 'transit', taxi: 'driving' };
const MODES = { walk: 'À pied', transit: 'Transports', taxi: 'Taxi' };
function legInfo(a, b){
  const L = S.items.get(legId(a, b)) || null;
  const ok = hasPos(a) && hasPos(b);
  const straight = ok ? dist(a, b) : null;
  const via = ((L && L.via) || []).filter(hasPos);
  const route = ok && L && L.route && L.route.sig === legSig(a, b, via) ? L.route : null;
  const estMin = straight != null ? Math.max(1, Math.round(straight * 1.25 / 78)) : null; // ≈ 4,7 km/h et 25 % de détours : estimation grossière, remplacée par le tracé calculé
  const walkMin = route ? Math.max(1, Math.round(route.time / 60)) : estMin;
  const chosen = (L && L.mode) || 'auto';
  const eff = chosen !== 'auto' ? chosen : (walkMin != null && walkMin <= walkMax() ? 'walk' : 'transit');
  return { L, a, b, ok, straight, route, walkMin, estimated: !route, chosen, eff, style: (L && L.style) || 'fonctionnel', via };
}
function legLabel(g){
  if (!g.ok) return 'Position manquante';
  if (g.eff === 'walk') return `À pied${g.style === 'promenade' ? ' · promenade' : ''} · ${g.estimated ? '≈ ' : ''}${g.walkMin} min · ${fmtDist(g.route ? g.route.length : g.straight * 1.25)}`;
  if (g.eff === 'transit') return 'Transports · ' + fmtDist(g.straight) + ' à vol d’oiseau';
  return 'Taxi · ' + fmtDist(g.straight) + ' à vol d’oiseau';
}
function legUrlFor(a, b){
  const g = legInfo(a, b);
  let u = 'https://www.google.com/maps/dir/?api=1&travelmode=' + GM[g.eff] + '&destination=' + encodeURIComponent(placeQuery(b));
  if (a.status !== 'visited') u += '&origin=' + encodeURIComponent(placeQuery(a));
  if (g.eff === 'walk' && g.via.length) u += '&waypoints=' + encodeURIComponent(g.via.slice(0, 3).map(v => v.lat + ',' + v.lng).join('|'));
  return u;
}
function legRow(a, b){
  const g = legInfo(a, b);
  return h('button', { class: 'leg-btn', type: 'button', onclick: () => g.ok ? openLeg(a, b) : toast('Place les deux étapes sur la carte pour calculer le trajet.') },
    h('span', { class: 'leg-mode m-' + (g.ok ? g.eff : 'none') }, g.ok ? ({ walk: '徒', transit: '電', taxi: '車' })[g.eff] : '?'),
    h('span', { class: 'leg-txt' }, legLabel(g), g.chosen === 'auto' && g.ok ? h('span', { class: 'muted' }, ' · choix auto') : null),
    h('span', { class: 'leg-go', 'aria-hidden': 'true' }, '›'));
}
function legFromId(id, day){
  const { seq } = daySeq(day);
  for (let i = 1; i < seq.length; i++) if (legId(seq[i - 1], seq[i]) === id) return { a: seq[i - 1], b: seq[i] };
  return null;
}
const setLeg = (a, b, patch, msg) => save({ id: legId(a, b), type: 'leg', from: pkey(a), to: pkey(b), ...patch }, msg);

async function computeWalk(a, b){
  const g = legInfo(a, b);
  const r = await walkRoute([a, ...g.via, b]);
  r.sig = legSig(a, b, g.via); r.at = new Date().toISOString();
  await setLeg(a, b, { route: r });
  return r;
}
async function computeNear(a, b){
  const [na, nb] = await Promise.all([transitNear(a), transitNear(b)]);
  const patch = { near: { a: na, b: nb, sig: legSig(a, b, []) } };
  const exit = nb.entrances[0];
  if (exit && exit.d > 40){
    try { const r = await walkRoute([exit, b]); r.sig = legSig(exit, b, []); patch.lastMile = { exit, route: r }; } catch (e){ console.warn(e); }
  } else patch.lastMile = exit ? { exit, route: null } : null;
  await setLeg(a, b, patch);
}
async function computePois(a, b, radius){
  const g = legInfo(a, b); if (!g.route) return;
  const pois = await poisAlong(shapeCoords(g.route), radius);
  await setLeg(a, b, { pois, poisRadius: radius, poisSig: g.route.sig });
}
const nearFresh = g => g.L && g.L.near && g.L.near.sig === legSig(g.a, g.b, []);
const poisFresh = (g, radius) => g.L && g.L.pois && g.route && g.L.poisSig === g.route.sig && g.L.poisRadius === radius;
const errText = e => S.online ? 'Service de calcul indisponible (' + (e.message || e) + '). Réessaie dans un moment.' : 'Hors ligne : calcul impossible maintenant.';

function openLeg(a, b){
  const st = { busy: '', err: '', radius: 300, auto: true };
  const run = async (label, fn) => {
    if (st.busy) return;
    if (!S.online){ st.err = 'Hors ligne : calcul impossible maintenant.'; S.sheet && S.sheet.render(); return; }
    st.busy = label; st.err = ''; S.sheet && S.sheet.render();
    try { await fn(); } catch (e){ console.warn(e); st.err = errText(e); }
    st.busy = ''; S.sheet && S.sheet.render();
  };
  const showOnMap = (close) => { close(); M.focus = legId(a, b); if (S.view !== 'jour'){ S.view = 'jour'; } M.sig = ''; renderAll(); setTimeout(() => M.el && M.el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50); };
  openSheet(close => {
    const g = legInfo(a, b);
    if (!g.ok) return null;
    // calculs automatiques à l'ouverture, une seule fois
    if (st.auto){
      st.auto = false;
      // le tracé à pied est calculé même en mode auto : sa durée réelle décide du choix à pied / transports
      setTimeout(() => run('Calcul du trajet…', async () => {
        if (!legInfo(a, b).route && (g.eff === 'walk' || g.straight < 5000)) await computeWalk(a, b);
        const n = legInfo(a, b);
        if (n.eff === 'transit' && !nearFresh(n)) await computeNear(a, b);
        if (n.eff === 'walk' && n.style === 'promenade' && !poisFresh(n, st.radius)) await computePois(a, b, st.radius);
      }), 0);
    }
    const modeBtn = (m, label) => h('button', { class: 'seg' + (g.chosen === m ? ' on' : ''), type: 'button', 'aria-pressed': String(g.chosen === m), onclick: async () => {
      await setLeg(a, b, { mode: m === 'auto' ? null : m });
      const n = legInfo(a, b);
      if (n.eff === 'walk' && !n.route) run('Calcul du trajet à pied…', () => computeWalk(a, b));
      if (n.eff === 'transit' && !nearFresh(n)) run('Recherche des entrées de métro et arrêts…', () => computeNear(a, b));
    } }, label);
    const body = [];
    body.push(h('div', { class: 'sec' },
      h('div', { class: 'seg-row', role: 'group', 'aria-label': 'Mode de déplacement' },
        modeBtn('auto', 'Auto'), modeBtn('walk', 'À pied'), modeBtn('transit', 'Transports'), modeBtn('taxi', 'Taxi')),
      h('div', { class: 'muted small' }, g.chosen === 'auto'
        ? `Choix auto : ${MODES[g.eff].toLowerCase()} (${g.estimated ? 'environ ' : ''}${g.walkMin} min à pied ; au-delà de ${walkMax()} min, transports). Réglable dans les réglages du voyage.`
        : 'Mode choisi pour ce trajet, partagé avec tout le monde.'),
      st.busy ? h('div', { class: 'row muted small' }, h('span', { class: 'spin' }), st.busy) : null,
      st.err ? h('div', { class: 'banner warn' }, st.err) : null));

    if (g.eff === 'walk'){
      body.push(h('div', { class: 'sec' },
        h('div', { class: 'seg-row', role: 'group', 'aria-label': 'Style de trajet' },
          h('button', { class: 'seg' + (g.style === 'fonctionnel' ? ' on' : ''), type: 'button', onclick: () => setLeg(a, b, { style: 'fonctionnel' }) }, 'Fonctionnel'),
          h('button', { class: 'seg' + (g.style === 'promenade' ? ' on' : ''), type: 'button', onclick: async () => { await setLeg(a, b, { style: 'promenade' }); const n = legInfo(a, b); if (n.route && !poisFresh(n, st.radius)) run('Recherche des lieux le long du trajet…', () => computePois(a, b, st.radius)); } }, 'Promenade')),
        g.route ? h('div', { class: 'leg-sum' }, h('b', { class: 'mono' }, g.walkMin + ' min'), h('span', { class: 'mono' }, fmtDist(g.route.length)), g.via.length ? h('span', { class: 'muted' }, g.via.length + ' détour' + (g.via.length > 1 ? 's' : '')) : null)
          : h('div', { class: 'muted' }, 'Trajet pas encore calculé' + (g.straight != null ? ' · ≈ ' + g.walkMin + ' min' : '') + '.'),
        h('div', { class: 'row' },
          g.route ? h('button', { class: 'btn primary', type: 'button', onclick: () => showOnMap(close) }, 'Voir sur la carte') : null,
          h('a', { class: 'btn', href: legUrlFor(a, b), target: '_blank', rel: 'noopener' }, 'Google Maps'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => run('Calcul du trajet à pied…', () => computeWalk(a, b)) }, g.route ? 'Recalculer' : 'Calculer'))));
      if (g.via.length) body.push(h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Détours ajoutés'),
        g.via.map((v, k) => h('div', { class: 'spread' }, h('span', null, String.fromCharCode(97 + k) + '. ' + v.name, v.cat ? h('span', { class: 'muted small' }, ' · ' + v.cat) : null),
          h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await setLeg(a, b, { via: g.via.filter(x => x.id !== v.id) }); run('Recalcul du trajet…', () => computeWalk(a, b)); } }, 'Retirer')))));
      if (g.style === 'promenade'){
        const pois = g.L && g.L.pois || [];
        body.push(h('div', { class: 'sec' },
          h('div', { class: 'spread' }, h('div', { class: 'eyebrow' }, 'À découvrir en chemin'),
            h('select', { id: 'poi-radius', 'aria-label': 'Distance au trajet', style: 'width:auto', onchange: e => { st.radius = +e.target.value; e.target.blur(); run('Recherche des lieux le long du trajet…', () => computePois(a, b, st.radius)); } },
              [150, 300, 500].map(r => h('option', { value: r, selected: r === (g.L && g.L.poisRadius || st.radius) ? true : null }, 'à ' + r + ' m')))),
          !g.route ? h('div', { class: 'muted small' }, 'Calcule d’abord le trajet.') :
            pois.length ? pois.map(p => poiRow(a, b, g, p)) : (g.L && g.L.pois ? h('div', { class: 'muted small' }, 'Rien de notable cartographié près du trajet. Élargis la distance ou demande à Claude.') : null),
          g.route ? h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => askClaude(promenadePrompt(a, b, g)) }, 'Demander à Claude pour ce trajet')) : null,
          h('div', { class: 'muted small' }, 'Lieux issus d’OpenStreetMap, classés par intérêt (fiche Wikipédia, type de lieu) et proximité. « Passer par là » recalcule le trajet.')));
      }
      if (g.route && g.route.steps && g.route.steps.length) body.push(h('details', { class: 'sec' }, h('summary', { class: 'eyebrow', style: 'cursor:pointer;padding-block:4px' }, 'Instructions pas à pas (' + g.route.steps.length + ')'),
        h('ol', { class: 'steps' }, g.route.steps.map(([t, len]) => h('li', null, t, len ? h('span', { class: 'muted mono' }, ' · ' + fmtDist(len)) : null)))));
    } else if (g.eff === 'transit'){
      const n = g.L && g.L.near;
      body.push(h('div', { class: 'sec' },
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: legUrlFor(a, b), target: '_blank', rel: 'noopener' }, 'Itinéraire et horaires dans Google Maps'),
          n ? h('button', { class: 'btn', type: 'button', onclick: () => showOnMap(close) }, 'Voir sorties sur la carte') : null),
        h('div', { class: 'muted small' }, 'Lignes, correspondances et horaires : Google Maps (non disponibles dans Tabi pour le Japon). Ci-dessous, les entrées et sorties proches d’après OpenStreetMap ; vérifie la sortie conseillée par Google Maps.')));
      if (n){
        const lm = g.L.lastMile;
        body.push(h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'À l’arrivée · ' + b.name),
          lm && lm.exit ? h('div', { class: 'banner' }, h('b', null, lm.exit.ref ? 'Sortie ' + lm.exit.ref : 'Entrée la plus proche'), lm.exit.name ? ' · ' + lm.exit.name : '',
            ' · ' + (lm.route ? Math.max(1, Math.round(lm.route.time / 60)) + ' min à pied (' + fmtDist(lm.route.length) + ')' : fmtDist(lm.exit.d))) : null,
          nearList(n.b)));
        body.push(h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Au départ · ' + a.name), nearList(n.a)));
        body.push(h('div', { class: 'sec' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => run('Recherche des entrées de métro et arrêts…', () => computeNear(a, b)) }, 'Actualiser')));
      } else body.push(h('div', { class: 'sec' }, h('button', { class: 'btn', type: 'button', onclick: () => run('Recherche des entrées de métro et arrêts…', () => computeNear(a, b)) }, 'Chercher les entrées de métro et arrêts')));
    } else {
      body.push(h('div', { class: 'sec' }, h('div', { class: 'row' }, h('a', { class: 'btn primary', href: legUrlFor(a, b), target: '_blank', rel: 'noopener' }, 'Itinéraire en voiture dans Google Maps')),
        h('div', { class: 'muted small' }, fmtDist(g.straight) + ' à vol d’oiseau. Montre l’adresse de destination au chauffeur, elle est dans la fiche du lieu.')));
    }
    if (g.route && g.eff === 'walk') body.push(h('div', { class: 'sec muted small' }, 'Tracé : ' + (g.route.engine === 'osrm' ? 'OSRM' : 'Valhalla') + ', données © OpenStreetMap · calculé le ' + fmtDay(isoDay(new Date(g.route.at))) + ' ' + fmtTime(g.route.at)));
    return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Trajet' },
      sheetHead(a.name + ' → ' + b.name, close), ...body, h('div', { style: 'height:10px' }));
  });
}
function nearList(n){
  if (!n) return null;
  const items = [
    ...n.entrances.slice(0, 6).map(e => h('div', { class: 'near' }, h('span', { class: 'mk ent sm' }, e.ref || 'M'), h('span', null, (e.ref ? 'Sortie ' + e.ref : 'Entrée') + (e.name ? ' · ' + e.name : '') + (e.wc ? ' · accès fauteuil' : '')), h('span', { class: 'mono muted' }, fmtDist(e.d)))),
    ...n.stations.slice(0, 3).map(s => h('div', { class: 'near' }, h('span', { class: 'mk st sm' }, '駅'), h('span', null, s.name + (s.alt ? ' (' + s.alt + ')' : '') + (s.op ? ' · ' + s.op : '')), h('span', { class: 'mono muted' }, fmtDist(s.d)))),
    ...n.bus.slice(0, 3).map(s => h('div', { class: 'near' }, h('span', { class: 'mk bus sm' }, 'B'), h('span', null, s.name + (s.alt ? ' (' + s.alt + ')' : '')), h('span', { class: 'mono muted' }, fmtDist(s.d)))),
  ];
  return items.length ? h('div', { class: 'near-list' }, items) : h('div', { class: 'muted small' }, 'Aucune entrée de métro, gare ou arrêt de bus cartographié à proximité.');
}
function poiRow(a, b, g, p){
  const on = g.via.some(v => v.id === p.id);
  return h('div', { class: 'poi' },
    h('div', { style: 'min-width:0' }, h('div', { style: 'font-weight:600;overflow-wrap:anywhere' }, p.name, p.wiki ? h('span', { class: 'muted small' }, ' · W') : null),
      h('div', { class: 'muted small' }, p.cat + ' · ' + fmtDist(p.d) + ' du trajet' + (p.alt ? ' · ' + p.alt : ''))),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' },
      h('button', { class: 'btn' + (on ? '' : ' primary'), type: 'button', onclick: () => togglePoi(a, b, p) }, on ? 'Retirer' : 'Passer par là'),
      h('button', { class: 'btn ghost', type: 'button', title: 'Garder en idée', onclick: () => poiToIdea(p) }, 'Idée')));
}
async function togglePoi(a, b, p){
  const g = legInfo(a, b);
  let via = g.via.some(v => v.id === p.id) ? g.via.filter(v => v.id !== p.id) : [...g.via, { id: p.id, name: p.name, cat: p.cat, lat: p.lat, lng: p.lng, idx: p.idx }];
  via = via.sort((x, y) => (x.idx ?? 0) - (y.idx ?? 0)).slice(0, 8);
  await setLeg(a, b, { via });
  if (!S.online){ toast('Détour enregistré : le trajet sera recalculé en ligne.'); return; }
  try { await computeWalk(a, b); toast(via.length > g.via.length ? 'Détour ajouté · ' + p.name : 'Détour retiré'); }
  catch (e){ toast(errText(e)); }
}
function poiToIdea(p){
  if (places().some(x => x.name === p.name)){ toast('Déjà dans le carnet'); return; }
  save({ id: uid(), type: 'place', name: p.name, kind: /Restaurant/.test(p.cat) ? 'resto' : 'visite', day: null, lat: p.lat, lng: p.lng, coordSource: 'osm', order: nextOrder(null), status: 'planned', note: p.cat + (p.alt ? ' · ' + p.alt : ''), createdBy: meName(), createdAt: new Date().toISOString() }, 'Gardé en idée · ' + p.name);
}
function openPoi(a, b, p){
  openSheet(close => {
    const g = legInfo(a, b); const on = g.via.some(v => v.id === p.id);
    return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, sheetHead(p.name, close),
      h('div', { class: 'sec' }, h('div', { class: 'muted' }, p.cat + ' · ' + fmtDist(p.d) + ' du trajet' + (p.alt ? ' · ' + p.alt : '')),
        h('div', { class: 'row' },
          h('button', { class: 'btn' + (on ? '' : ' primary'), type: 'button', onclick: async () => { close(); await togglePoi(a, b, p); } }, on ? 'Retirer du trajet' : 'Passer par là'),
          h('button', { class: 'btn', type: 'button', onclick: () => { poiToIdea(p); close(); } }, 'Garder en idée'),
          h('a', { class: 'btn', href: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.name + ' ' + p.lat + ',' + p.lng), target: '_blank', rel: 'noopener' }, 'Google Maps'))),
      h('div', { style: 'height:10px' }));
  });
}
function promenadePrompt(a, b, g){
  const c = shapeCoords(g.route); const step = Math.max(1, Math.floor(c.length / 8));
  const pts = c.filter((_, i) => i % step === 0).slice(0, 10).map(([lng, lat]) => lat.toFixed(4) + ',' + lng.toFixed(4)).join(' ; ');
  return `Je vais à pied de « ${a.name} » à « ${b.name} » (${g.walkMin} min, ${fmtDist(g.route.length)}) en mode promenade, le ${currentDay()}. Tracé approximatif : ${pts}. Propose 3 à 5 arrêts qui valent vraiment le détour à moins de 300 m du trajet (avec pourquoi et le bon moment), et dépose-les comme suggestions dans data/ (status "suggested", day "${currentDay()}").`;
}
async function prepareDayLegs(day){
  if (!S.online){ toast('Connexion requise pour préparer les trajets.'); return; }
  const { seq } = daySeq(day); let n = 0, fail = 0;
  const pairs = []; for (let i = 1; i < seq.length; i++) if (hasPos(seq[i - 1]) && hasPos(seq[i])) pairs.push([seq[i - 1], seq[i]]);
  if (!pairs.length){ toast('Aucun trajet calculable : place les étapes sur la carte.'); return; }
  toast('Préparation de ' + pairs.length + ' trajet(s)…');
  for (const [a, b] of pairs){
    const g = legInfo(a, b);
    try {
      if (!g.route && g.straight < 8000) await computeWalk(a, b);
      const g2 = legInfo(a, b);
      if (g2.eff === 'transit' && !nearFresh(g2)) await computeNear(a, b);
      if (g2.eff === 'walk' && g2.style === 'promenade' && !(g2.L && g2.L.pois)) await computePois(a, b, 300);
      n++;
    } catch (e){ console.warn(e); fail++; }
    await new Promise(r => setTimeout(r, 1100)); // services publics : on reste raisonnable
  }
  toast(`${n} trajet(s) prêts${fail ? ', ' + fail + ' en échec' : ''}. Ils restent disponibles hors ligne.`);
}

/* ---- Lieu : création / modification ---- */
function openPlaceForm(init){
  const st = { results: null, searching: false, coords: num(init.lat) != null ? { lat: init.lat, lng: init.lng, coordSource: init.coordSource || 'carte' } : null };
  openSheet(close => {
    const f = h('form', { class: 'form', onsubmit: async e => {
      e.preventDefault(); const fd = new FormData(f);
      const name = String(fd.get('name') || '').trim(); if (!name) return;
      const link = String(fd.get('link') || '').trim(); const c = parseCoords(link);
      const day = fd.get('day') || null;
      const coords = c ? { lat: c.lat, lng: c.lng, coordSource: /^https?:/.test(link) ? 'lien' : 'saisie' } : st.coords;
      document.activeElement && document.activeElement.blur();
      await save({ id: uid(), type: 'place', name, kind: fd.get('kind') || 'visite', day, time: fd.get('time') || null,
        city: String(fd.get('city') || '').trim() || (st.picked && st.picked.city) || null, address: (st.picked && st.picked.address) || null,
        lat: coords ? coords.lat : null, lng: coords ? coords.lng : null, coordSource: coords ? coords.coordSource : null,
        mapsUrl: /^https?:\/\//.test(link) ? link : null, order: nextOrder(day), status: 'planned', addedDuring: duringTrip(day),
        note: String(fd.get('note') || '').trim() || null, createdBy: meName(), createdAt: new Date().toISOString() }, 'Ajouté · ' + name);
      close();
    } },
      h('label', { class: 'f' }, 'Nom du lieu', h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        h('input', { type: 'text', name: 'name', id: 'pf-name', required: true, placeholder: 'Ex. Fushimi Inari Taisha', autocomplete: 'off', value: init.name || '' }),
        h('button', { class: 'btn', type: 'button', disabled: !S.online ? true : null, onclick: () => search(f.querySelector('#pf-name').value) }, 'Chercher'))),
      st.searching ? h('div', { class: 'row muted small' }, h('span', { class: 'spin' }), 'Recherche OpenStreetMap…') : null,
      st.results ? (st.results.length ? h('div', { class: 'results' }, st.results.map(r => h('button', { type: 'button', onclick: () => {
          st.coords = { lat: +(+r.lat).toFixed(6), lng: +(+r.lon).toFixed(6), coordSource: 'osm' };
          st.picked = { address: r.display_name, city: (r.address && (r.address.city || r.address.town || r.address.village || r.address.suburb)) || null };
          const n = f.querySelector('#pf-name'); if (n && !n.value.trim()) n.value = r.name || r.display_name.split(',')[0];
          st.results = null; S.sheet.render(); } }, h('strong', null, r.name || r.display_name.split(',')[0]), h('div', { class: 'muted small' }, r.display_name))))
        : h('div', { class: 'muted small' }, 'Aucun résultat. Essaie le nom en anglais ou en japonais, colle un lien Google Maps, ou place-le sur la carte.')) : null,
      h('div', { class: 'muted small' }, st.coords ? `Position : ${st.coords.lat.toFixed(5)}, ${st.coords.lng.toFixed(5)}` + (st.picked ? ' · ' + st.picked.address.slice(0, 80) : '') : 'Pas encore de position.'),
      h('div', { class: 'grid2' },
        h('label', { class: 'f' }, 'Type', h('select', { name: 'kind', id: 'pf-kind' }, Object.entries(KINDS).map(([v, l]) => h('option', { value: v, selected: v === (init.kind || 'visite') ? true : null }, l)))),
        h('label', { class: 'f' }, 'Quand', h('select', { name: 'day', id: 'pf-day' }, h('option', { value: '' }, 'Idée (sans date)'), tripDays().map(d => h('option', { value: d, selected: d === init.day ? true : null }, fmtDay(d)))))),
      h('div', { class: 'grid2' },
        h('label', { class: 'f' }, 'Heure (facultatif)', h('input', { type: 'time', name: 'time', id: 'pf-time' })),
        h('label', { class: 'f' }, 'Ville / quartier', h('input', { type: 'text', name: 'city', id: 'pf-city', placeholder: 'Kyoto' }))),
      h('label', { class: 'f' }, 'Lien Google Maps ou coordonnées (facultatif)', h('input', { type: 'text', name: 'link', id: 'pf-link', placeholder: 'Lien « Partager » de Google Maps' })),
      h('label', { class: 'f' }, 'Note (facultatif)', h('input', { type: 'text', name: 'note', id: 'pf-note', placeholder: 'Pourquoi y aller, horaires…' })),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Ajouter'),
        h('button', { class: 'btn', type: 'button', onclick: () => { const v = f.querySelector('#pf-name').value; const d = f.querySelector('#pf-day').value; startPlacing('Touche la carte pour placer le lieu', c => openPlaceForm({ ...init, name: v, day: d || null, lat: c.lat, lng: c.lng, coordSource: 'carte' })); } }, 'Placer sur la carte')));
    return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, sheetHead('Nouveau lieu', close), f);
  });
  async function search(q){
    q = (q || '').trim(); if (!q) return;
    st.searching = true; st.results = null; S.sheet.render();
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&accept-language=fr,en,ja&q=' + encodeURIComponent(q));
      st.results = r.ok ? await r.json() : [];
    } catch { st.results = []; toast('Recherche indisponible (réseau).'); }
    st.searching = false; S.sheet && S.sheet.render();
  }
}

/* ---- Lieu : fiche ---- */
function openPlace(id){
  let confirmDel = false;
  openSheet(close => {
    const p = S.items.get(id); if (!p) return null;
    const notes = notesOf('placeId', id), photos = mediaOf('placeId', id, 'photo'), linked = bookings().filter(b => b.placeId === id);
    const list = placesOf(p.day || null); const pos = list.findIndex(x => x.id === id);
    return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': p.name },
      sheetHead(p.name, close),
      h('div', { class: 'sec' },
        h('div', { class: 'row' }, kindChip(p.kind), h('span', { class: 'chip' }, p.day ? fmtDay(p.day) : 'Idée'),
          p.status === 'visited' ? h('span', { class: 'chip solid' }, 'Visité' + (p.visitedAt ? ' · ' + fmtDay(isoDay(new Date(p.visitedAt))) + ' ' + fmtTime(p.visitedAt) : '') + (p.visitedBy ? ' · ' + p.visitedBy : '')) : null,
          p.addedDuring ? h('span', { class: 'chip warn' }, 'Ajouté en route') : null),
        p.note ? h('div', { class: 'muted' }, p.note) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn' + (p.status === 'visited' ? '' : ' primary'), type: 'button', onclick: () => toggleVisit(p) }, p.status === 'visited' ? 'Retirer le tampon' : 'Tamponner : visité'),
          p.status !== 'visited' ? h('button', { class: 'btn', type: 'button', onclick: () => save({ id, status: p.status === 'skipped' ? 'planned' : 'skipped' }) }, p.status === 'skipped' ? 'Remettre au programme' : 'Pas fait') : null,
          h('a', { class: 'btn', href: placeUrl(p), target: '_blank', rel: 'noopener' }, 'Google Maps'),
          num(p.lat) != null && M.map ? h('button', { class: 'btn', type: 'button', onclick: () => { close(); if (S.view !== 'jour'){ S.view = 'jour'; renderAll(); } M.map.flyTo({ center: [p.lng, p.lat], zoom: 16 }); M.el.scrollIntoView({ block: 'center' }); } }, 'Voir sur la carte') : null)),
      h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Photos'),
        photos.length ? thumbs(photos) : h('span', { class: 'muted' }, 'Pas encore de photo.'),
        uploadButton('Ajouter des photos', 'image/*', { role: 'photo', placeId: id, day: p.day || null }, true)),
      h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Notes et impressions'),
        notes.map(noteEl), noteForm({ placeId: id, day: p.day || null })),
      linked.length ? h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Réservations liées'), linked.map(b => h('button', { class: 'doc', type: 'button', onclick: () => openBooking(b.id) }, h('span', null, b.title + (b.time ? ' · ' + b.time : ''))))) : null,
      h('details', { class: 'sec' }, h('summary', { class: 'eyebrow', style: 'cursor:pointer;padding-block:4px' }, 'Modifier'),
        (() => { const f = h('form', { class: 'form', style: 'padding:0', onsubmit: async e => {
          e.preventDefault(); const fd = new FormData(f); const link = String(fd.get('link') || '').trim(); const c = parseCoords(link);
          const upd = { id, name: String(fd.get('name')).trim() || p.name, kind: fd.get('kind'), time: fd.get('time') || null, city: String(fd.get('city') || '').trim() || null, address: String(fd.get('address') || '').trim() || null, note: String(fd.get('note') || '').trim() || null };
          if (link !== (p.mapsUrl || '')){ upd.mapsUrl = /^https?:\/\//.test(link) ? link : null; if (c){ upd.lat = c.lat; upd.lng = c.lng; upd.coordSource = /^https?:/.test(link) ? 'lien' : 'saisie'; } }
          const nd = fd.get('day') || null; if (nd !== (p.day || null)){ upd.day = nd; upd.order = nextOrder(nd); }
          document.activeElement && document.activeElement.blur();
          await save(upd, 'Enregistré');
          if (link && !c && /^https?:/.test(link)) toast('Lien enregistré. Lien court : position non lue, utilise « Placer sur la carte ».');
        } },
          h('label', { class: 'f' }, 'Nom', h('input', { type: 'text', name: 'name', id: 'pe-name', value: p.name })),
          h('div', { class: 'grid2' },
            h('label', { class: 'f' }, 'Type', h('select', { name: 'kind', id: 'pe-kind' }, Object.entries(KINDS).map(([v, l]) => h('option', { value: v, selected: v === p.kind ? true : null }, l)))),
            h('label', { class: 'f' }, 'Jour', h('select', { name: 'day', id: 'pe-day' }, h('option', { value: '' }, 'Idée (sans date)'), tripDays().map(d => h('option', { value: d, selected: d === p.day ? true : null }, fmtDay(d)))))),
          h('div', { class: 'grid2' },
            h('label', { class: 'f' }, 'Heure', h('input', { type: 'time', name: 'time', id: 'pe-time', value: p.time || '' })),
            h('label', { class: 'f' }, 'Ville / quartier', h('input', { type: 'text', name: 'city', id: 'pe-city', value: p.city || '' }))),
          h('label', { class: 'f' }, 'Adresse', h('input', { type: 'text', name: 'address', id: 'pe-address', value: p.address || '' })),
          h('label', { class: 'f' }, 'Note', h('input', { type: 'text', name: 'note', id: 'pe-note', value: p.note || '' })),
          h('label', { class: 'f' }, 'Lien Google Maps ou coordonnées', h('input', { type: 'text', name: 'link', id: 'pe-link', value: p.mapsUrl || '' })),
          h('div', { class: 'muted small' }, num(p.lat) != null ? `Position ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · source : ${({ lien: 'lien Google Maps', saisie: 'saisie', carte: 'placé sur la carte', osm: 'OpenStreetMap', estime: 'estimation' })[p.coordSource] || '?'}` : 'Pas de position.'),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer'),
            h('button', { class: 'btn', type: 'button', onclick: () => startPlacing('Touche la carte pour repositionner « ' + p.name + ' »', c => save({ id, lat: c.lat, lng: c.lng, coordSource: 'carte' }, 'Position enregistrée')) }, 'Placer sur la carte'),
            pos > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => swapOrder(list[pos - 1], p) }, 'Monter') : null,
            pos >= 0 && pos < list.length - 1 ? h('button', { class: 'btn', type: 'button', onclick: () => swapOrder(p, list[pos + 1]) }, 'Descendre') : null),
          h('div', { class: 'row', style: 'margin-top:6px' },
            confirmDel ? [h('span', { class: 'muted' }, 'Supprimer ce lieu ?'),
              h('button', { class: 'btn danger', type: 'button', onclick: async () => { close(); for (const b of linked) await save({ id: b.id, placeId: null }); await removeItem(id); toast('Lieu supprimé'); } }, 'Confirmer'),
              h('button', { class: 'btn', type: 'button', onclick: () => { confirmDel = false; S.sheet.render(); } }, 'Annuler')]
              : h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmDel = true; S.sheet.render(); } }, 'Supprimer le lieu')));
          return f; })()));
  });
}
async function swapOrder(a, b){ const oa = a.order ?? 0, ob = b.order ?? 0; await save({ id: a.id, order: oa === ob ? ob + 0.5 : ob }); await save({ id: b.id, order: oa }); }

/* ---- notes, photos ---- */
const noteEl = n => h('div', { class: 'note' }, h('div', null, n.text), h('div', { class: 'by' }, (n.by || n.updatedBy || '') + (n.at ? ' · ' + fmtDay(isoDay(new Date(n.at))) + ' ' + fmtTime(n.at) : '') + (n._pending ? ' · non synchronisé' : '')));
function noteForm(link){
  const f = h('form', { class: 'row', style: 'flex-wrap:nowrap;align-items:flex-end', onsubmit: async e => {
    e.preventDefault(); const ta = f.querySelector('textarea'); const text = ta.value.trim(); if (!text) return; ta.blur(); ta.value = '';
    await save({ id: uid(), type: 'note', text, placeId: link.placeId || null, bookingId: link.bookingId || null, day: link.day || null, by: meName(), at: new Date().toISOString() });
  } }, h('textarea', { name: 'text', id: 'note-' + (link.placeId || link.bookingId || link.day), placeholder: 'Une impression, un détail à retenir…', rows: '2', style: 'flex:1' }), h('button', { class: 'btn primary', type: 'submit' }, 'Noter'));
  return f;
}
const urlCache = new Map();
async function mediaUrl(m, full){
  if (!full && m.thumb) return m.thumb;
  const key = m.id + (full ? ':f' : ':t'); if (urlCache.has(key)) return urlCache.get(key);
  let blob = null;
  if (m._localBlob){ const r = await idb.get('blobs', m.id); blob = r && r.blob; }
  else if (m.fileId && hasToken()) blob = await drive.blob(m.fileId);
  if (!blob) return null;
  const u = URL.createObjectURL(blob); urlCache.set(key, u); return u;
}
function thumbs(list){
  return h('div', { class: 'thumbs' }, list.map(m => {
    const img = h('img', { alt: m.caption || 'Photo', loading: 'lazy' });
    mediaUrl(m, false).then(u => { if (u) img.src = u; }).catch(() => {});
    return h('button', { class: 'th', type: 'button', onclick: () => openPhoto(m.id) }, img, m._localBlob ? h('span', { class: 'pend' }, 'en attente') : null);
  }));
}
function uploadButton(label, accept, link, multiple){
  const inp = h('input', { type: 'file', accept, multiple: multiple ? true : null, hidden: true, onchange: async () => {
    const files = [...inp.files]; inp.value = ''; if (!files.length) return;
    btn.disabled = true; let n = 0;
    for (const file of files){
      btn.textContent = 'Préparation ' + (++n) + '/' + files.length + '…';
      try {
        const isImg = file.type.startsWith('image/') && !/gif|svg/.test(file.type);
        const blob = isImg ? await resize(file, 2560, 0.86) : file;
        const thumb = isImg ? await thumbData(blob) : null;
        const id = uid(); const mime = blob.type || file.type || 'application/octet-stream';
        const ext = mime.includes('jpeg') ? 'jpg' : (file.name.split('.').pop() || 'bin');
        const base = (file.name.replace(/\.[^.]+$/, '') || 'fichier').replace(/[^\w\-. ]+/g, '').slice(0, 60);
        await idb.put('blobs', id, { blob, name: `${link.role}_${id}_${base}.${ext}`, mime, folder: link.role === 'billet' ? 'billets' : 'photos' });
        const it = { id, type: 'media', role: link.role, placeId: link.placeId || null, bookingId: link.bookingId || null, day: link.day || null,
          name: file.name, mime, thumb, by: meName(), at: new Date().toISOString(), takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null, fileId: null, _localBlob: true, _pending: true };
        S.items.set(id, it); await idb.put('items', id, it);
        await idb.put('outbox', 'u:' + id, { kind: 'upload', id, ts: Date.now() });
      } catch (e){ console.warn(e); toast('Impossible de préparer ' + file.name + '.'); }
    }
    await countPending(); btn.disabled = false; btn.textContent = label;
    toast(files.length > 1 ? files.length + ' fichiers ajoutés' : 'Fichier ajouté'); schedule(); kick(300);
  } });
  const btn = h('button', { class: 'btn', type: 'button', onclick: () => inp.click() }, label);
  return h('div', null, inp, btn);
}
function loadImg(blob){ return new Promise((res, rej) => { const u = URL.createObjectURL(blob); const i = new Image(); i.onload = () => { res(i); URL.revokeObjectURL(u); }; i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('image')); }; i.src = u; }); }
async function resize(file, max, q){
  try { const img = await loadImg(file); const s = Math.min(1, max / Math.max(img.width, img.height)); const w = Math.round(img.width * s), hh = Math.round(img.height * s);
    const c = document.createElement('canvas'); c.width = w; c.height = hh; c.getContext('2d').drawImage(img, 0, 0, w, hh);
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); return b && b.size < file.size ? b : file; } catch { return file; }
}
async function thumbData(blob){
  try { const img = await loadImg(blob); const S2 = 320; const s = Math.min(1, S2 / Math.min(img.width, img.height)); const w = Math.round(img.width * s), hh = Math.round(img.height * s);
    const c = document.createElement('canvas'); c.width = w; c.height = hh; c.getContext('2d').drawImage(img, 0, 0, w, hh); return c.toDataURL('image/jpeg', 0.7); } catch { return null; }
}
function openPhoto(id){
  let confirmDel = false;
  openSheet(close => {
    const m = S.items.get(id); if (!m) return null;
    const img = h('img', { alt: m.caption || 'Photo', src: m.thumb || '' });
    mediaUrl(m, true).then(u => { if (u) img.src = u; }).catch(() => {});
    return h('div', { class: 'sheet lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo' },
      sheetHead(m.caption || (m.role === 'billet' ? 'Billet' : 'Photo'), close),
      h('div', { class: 'sec' }, img,
        h('div', { class: 'muted small' }, 'Ajoutée par ' + (m.by || '?') + (m.takenAt ? ' · ' + fmtDay(isoDay(new Date(m.takenAt))) + ' ' + fmtTime(m.takenAt) : '') + (m._localBlob ? ' · en attente d’envoi' : '')),
        (() => { const f = h('form', { class: 'row', style: 'flex-wrap:nowrap', onsubmit: async e => { e.preventDefault(); const v = f.querySelector('input').value.trim(); f.querySelector('input').blur(); await save({ id, caption: v || null }, 'Légende enregistrée'); } },
          h('input', { type: 'text', id: 'cap-' + id, value: m.caption || '', placeholder: 'Légende', style: 'flex:1' }), h('button', { class: 'btn', type: 'submit' }, 'OK')); return f; })(),
        h('div', { class: 'row' },
          m.fileId ? h('a', { class: 'btn', href: 'https://drive.google.com/file/d/' + m.fileId + '/view', target: '_blank', rel: 'noopener' }, 'Ouvrir dans Drive') : null,
          confirmDel ? h('button', { class: 'btn danger', type: 'button', onclick: async () => { close(); const fid = m.fileId; await removeItem(id); if (fid && hasToken()) drive.trash(fid).catch(() => {}); toast('Supprimée (récupérable dans la corbeille Drive)'); } }, 'Confirmer la suppression')
            : h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmDel = true; S.sheet.render(); } }, 'Supprimer'))));
  });
}
function openDayNote(day){
  openSheet(close => h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, sheetHead('Journal du ' + fmtDay(day), close),
    h('div', { class: 'sec' }, h('span', { class: 'muted small' }, 'Pour la journée, sans lieu précis.'),
      all('note').filter(n => n.day === day && !n.placeId && !n.bookingId).map(noteEl), noteForm({ day }),
      thumbs(all('media').filter(m => m.role === 'photo' && m.day === day && !m.placeId)),
      uploadButton('Ajouter des photos du jour', 'image/*', { role: 'photo', day }, true)), h('div', { style: 'height:8px' })));
}

/* ---- Réservations ---- */
const BK = { hotel: 'Hôtel', resto: 'Restaurant', activite: 'Activité', transport: 'Transport', autre: 'Autre' };
function bookingRow(b){
  const nt = mediaOf('bookingId', b.id, 'billet').length;
  return h('div', { class: 'bk', role: 'button', tabindex: '0', onclick: () => openBooking(b.id), onkeydown: e => { if (e.key === 'Enter') openBooking(b.id); } },
    h('div', { class: 'spread' }, h('div', { style: 'font-weight:700;min-width:0;overflow-wrap:anywhere' }, b.title), kindChip(b.kind)),
    h('div', { class: 'row muted', style: 'font-size:13.5px' },
      b.date ? h('span', { class: 'mono' }, fmtDay(b.date) + (b.time ? ' · ' + b.time : '')) : h('span', null, 'Date inconnue'),
      b.endDate && b.endDate !== b.date ? h('span', { class: 'mono' }, '→ ' + fmtDay(b.endDate) + (b.endTime ? ' ' + b.endTime : '')) : null,
      b.confirmation ? h('span', { class: 'conf' }, b.confirmation) : null,
      nt ? h('span', { class: 'chip solid' }, nt + ' billet' + (nt > 1 ? 's' : '')) : null,
      b.cancelled ? h('span', { class: 'chip warn' }, 'Annulée') : null));
}
function viewBookings(){
  const ds = tripDays(); const list = bookings();
  const inTrip = list.filter(b => b.date && ds.includes(b.date)).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const other = list.filter(b => !b.date || !ds.includes(b.date));
  const groups = {}; inTrip.forEach(b => { (groups[b.date] ||= []).push(b); });
  return [
    h('div', { class: 'spread' }, h('div', null, h('div', { class: 'eyebrow' }, list.length + ' réservation' + (list.length > 1 ? 's' : '')), h('h2', null, 'Réservations et billets')),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => askClaude('Importe mes nouvelles réservations Gmail pour ce voyage dans le dossier Drive « Tabi - Japon », en suivant le format du README.') }, 'Import Gmail par Claude'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openBookingForm() }, 'Ajouter'))),
    !list.length ? h('div', { class: 'panel empty' }, h('h3', null, 'Aucune réservation pour l’instant'), h('span', null, 'Claude peut lire tes confirmations Gmail et les déposer ici : bouton « Import Gmail par Claude ». Tu peux aussi saisir une réservation et joindre ses billets.')) : null,
    ...Object.entries(groups).map(([d, l]) => h('div', { class: 'panel' }, h('div', { class: 'sec', style: 'padding-bottom:4px' }, h('div', { class: 'eyebrow' }, fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' }))), ...l.map(bookingRow))),
    other.length ? h('div', { class: 'panel' }, h('div', { class: 'sec', style: 'padding-bottom:4px' }, h('div', { class: 'eyebrow' }, 'Hors des dates du voyage ou sans date')), ...other.map(bookingRow)) : null,
  ];
}
function openBooking(id){
  let confirmDel = false;
  openSheet(close => {
    const b = S.items.get(id); if (!b) return null;
    const tickets = mediaOf('bookingId', id, 'billet'); const place = b.placeId && S.items.get(b.placeId);
    const del = async withPlace => { close(); if (withPlace && place) await removeItem(place.id); await removeItem(id); toast(withPlace && place ? 'Réservation et lieu supprimés' : 'Réservation supprimée'); };
    return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': b.title },
      sheetHead(b.title, close),
      h('div', { class: 'sec' },
        h('div', { class: 'row' }, kindChip(b.kind), b.cancelled ? h('span', { class: 'chip warn' }, 'Annulée') : null, b.source === 'gmail' ? h('span', { class: 'chip' }, 'importée de Gmail') : null),
        h('div', { class: 'mono' }, b.date ? fmtDay(b.date, { weekday: 'long', day: 'numeric', month: 'long' }) + (b.time ? ' · ' + b.time : '') : 'Date inconnue', b.endDate && b.endDate !== b.date ? ' → ' + fmtDay(b.endDate) + (b.endTime ? ' · ' + b.endTime : '') : ''),
        b.confirmation ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'N° de réservation'), h('span', { class: 'conf' }, b.confirmation),
          h('button', { class: 'btn ghost', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(b.confirmation); toast('Copié'); } catch { toast('Copie impossible : sélectionne le numéro.'); } } }, 'Copier')) : null,
        b.address ? h('div', null, b.address) : null, b.details ? h('div', { class: 'muted' }, b.details) : null,
        h('div', { class: 'row' },
          b.address || place ? h('a', { class: 'btn', href: place ? placeUrl(place) : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(b.address), target: '_blank', rel: 'noopener' }, 'Google Maps') : null,
          b.gmailUrl ? h('a', { class: 'btn', href: b.gmailUrl, target: '_blank', rel: 'noopener' }, 'Ouvrir le mail') : null,
          place ? h('button', { class: 'btn', type: 'button', onclick: () => openPlace(place.id) }, 'Voir le lieu') : null),
        b.gmailUrl ? h('div', { class: 'muted small' }, 'Le mail ne s’ouvre que dans la boîte Gmail qui l’a reçu. Pour que vous l’ayez tous les deux, joins le billet ci-dessous.') : null),
      h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Billets et documents'),
        tickets.length ? tickets.map(m => h('button', { class: 'doc', type: 'button', onclick: () => openTicket(m) }, h('span', null, m.name || 'Document'), h('span', { class: 'muted', style: 'margin-left:auto' }, (m.mime || '').includes('pdf') ? 'PDF' : 'Image', m._localBlob ? ' · en attente' : ''))) : h('span', { class: 'muted' }, 'Aucun billet joint.'),
        uploadButton('Joindre un billet (PDF ou image)', 'application/pdf,image/*', { role: 'billet', bookingId: id, day: b.date || null }, true)),
      h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Notes'), notesOf('bookingId', id).map(noteEl), noteForm({ bookingId: id })),
      h('div', { class: 'sec' }, h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => openBookingForm(b) }, 'Modifier'),
        !place && b.date ? h('button', { class: 'btn', type: 'button', onclick: () => placeFromBooking(b) }, 'Créer le lieu dans la journée') : null,
        confirmDel ? (place ? [h('button', { class: 'btn danger', type: 'button', onclick: () => del(true) }, 'Supprimer aussi le lieu'), h('button', { class: 'btn', type: 'button', onclick: () => del(false) }, 'Garder le lieu')]
            : h('button', { class: 'btn danger', type: 'button', onclick: () => del(false) }, 'Confirmer la suppression'))
          : h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmDel = true; S.sheet.render(); } }, 'Supprimer'))),
      h('div', { style: 'height:8px' }));
  });
}
async function openTicket(m){
  if (m.fileId && S.online){ window.open('https://drive.google.com/file/d/' + m.fileId + '/view', '_blank', 'noopener'); return; }
  const u = await mediaUrl(m, true).catch(() => null);
  if (u) window.open(u, '_blank'); else toast('Billet indisponible hors ligne sur cet appareil.');
}
async function placeFromBooking(b){
  const id = uid();
  await save({ id, type: 'place', name: b.title, kind: BK[b.kind] ? b.kind : 'visite', day: b.date || null, time: b.time || null, city: b.city || null, address: b.address || null,
    lat: num(b.lat), lng: num(b.lng), coordSource: num(b.lat) != null ? 'estime' : null, order: nextOrder(b.date || null), status: 'planned', createdBy: meName(), createdAt: new Date().toISOString() });
  await save({ id: b.id, placeId: id }, 'Lieu créé');
}
function openBookingForm(b){
  b = b || {};
  openSheet(close => {
    const f = h('form', { class: 'form', onsubmit: async e => {
      e.preventDefault(); const fd = new FormData(f);
      const data = { title: String(fd.get('title')).trim(), kind: fd.get('kind'), date: fd.get('date') || null, time: fd.get('time') || null, endDate: fd.get('endDate') || null, endTime: fd.get('endTime') || null,
        confirmation: String(fd.get('confirmation') || '').trim() || null, address: String(fd.get('address') || '').trim() || null, details: String(fd.get('details') || '').trim() || null };
      if (!data.title) return; document.activeElement && document.activeElement.blur();
      if (b.id) await save({ id: b.id, ...data }, 'Réservation enregistrée');
      else await save({ id: uid(), type: 'booking', ...data, source: 'manuel', createdBy: meName(), createdAt: new Date().toISOString() }, 'Réservation ajoutée');
      close();
    } },
      h('label', { class: 'f' }, 'Intitulé', h('input', { type: 'text', name: 'title', id: 'bf-title', required: true, value: b.title || '', placeholder: 'Ex. Ryokan Sumiya, Kyoto' })),
      h('div', { class: 'grid2' },
        h('label', { class: 'f' }, 'Type', h('select', { name: 'kind', id: 'bf-kind' }, Object.entries(BK).map(([v, l]) => h('option', { value: v, selected: v === b.kind ? true : null }, l)))),
        h('label', { class: 'f' }, 'N° de réservation', h('input', { type: 'text', name: 'confirmation', id: 'bf-conf', value: b.confirmation || '' }))),
      h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Date', h('input', { type: 'date', name: 'date', id: 'bf-date', value: b.date || '' })), h('label', { class: 'f' }, 'Heure', h('input', { type: 'time', name: 'time', id: 'bf-time', value: b.time || '' }))),
      h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Fin (départ, check-out)', h('input', { type: 'date', name: 'endDate', id: 'bf-edate', value: b.endDate || '' })), h('label', { class: 'f' }, 'Heure de fin', h('input', { type: 'time', name: 'endTime', id: 'bf-etime', value: b.endTime || '' }))),
      h('label', { class: 'f' }, 'Adresse', h('input', { type: 'text', name: 'address', id: 'bf-addr', value: b.address || '' })),
      h('label', { class: 'f' }, 'Détails', h('textarea', { name: 'details', id: 'bf-details' }, b.details || '')),
      h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer')));
    return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, sheetHead(b.id ? 'Modifier la réservation' : 'Nouvelle réservation', close), f);
  });
}

/* ---- Idées ---- */
function viewIdeas(){
  const ideas = placesOf(null);
  return [
    h('div', { class: 'spread' }, h('div', null, h('div', { class: 'eyebrow' }, ideas.length + ' idée' + (ideas.length > 1 ? 's' : '')), h('h2', null, 'Idées à caser')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => openPlaceForm({ day: null }) }, 'Ajouter une idée')),
    h('div', { class: 'panel' }, ideas.length ? h('div', { class: 'stops' }, ideas.map(p => h('div', { class: 'stop' },
      h('div', { class: 'stamp', style: 'border-style:dotted' }, '＋'),
      h('div', { class: 'body', onclick: () => openPlace(p.id), role: 'button', tabindex: '0' }, h('div', { class: 'name' }, p.name),
        h('div', { class: 'meta' }, kindChip(p.kind), p.city ? h('span', { class: 'muted small' }, p.city) : null, p.note ? h('span', { class: 'muted small' }, p.note) : null)),
      h('select', { 'aria-label': 'Planifier ' + p.name, id: 'plan-' + p.id, style: 'width:auto;max-width:130px', onchange: async e => { const d = e.target.value; if (!d) return; e.target.blur(); await save({ id: p.id, day: d, order: nextOrder(d), addedDuring: duringTrip(d) }, 'Planifié le ' + fmtDay(d)); } },
        h('option', { value: '' }, 'Planifier…'), tripDays().map(d => h('option', { value: d }, fmtDay(d))))))) :
      h('div', { class: 'empty' }, h('h3', null, 'Pas encore d’idées'), h('span', null, 'Note ici ce qui te tente sans date précise. Sur la carte du jour, « Voir les idées » les affiche pour repérer ce qui est proche.'))),
  ];
}

/* ---- Souvenirs ---- */
function viewMemories(){
  const ds = tripDays(); const ps = places().filter(p => p.day); const visited = ps.filter(p => p.status === 'visited');
  const photos = all('media').filter(m => m.role === 'photo');
  const out = [
    h('div', null, h('div', { class: 'eyebrow' }, 'Le voyage tel qu’il s’est passé'), h('h2', null, 'Souvenirs')),
    h('div', { class: 'panel', style: 'padding:12px' }, h('div', { class: 'stats' },
      h('div', null, h('b', null, visited.length), 'lieux visités'), h('div', null, h('b', null, ps.length), 'prévus'),
      h('div', null, h('b', null, ps.filter(p => p.addedDuring).length), 'ajoutés en route'), h('div', null, h('b', null, ps.filter(p => p.status === 'skipped').length), 'pas faits'),
      h('div', null, h('b', null, photos.length), 'photos'), h('div', null, h('b', null, all('note').length), 'notes'))),
  ];
  const daysWith = ds.filter(d => ps.some(p => p.day === d && p.status === 'visited') || photos.some(m => m.day === d) || all('note').some(n => n.day === d));
  if (!daysWith.length) out.push(h('div', { class: 'panel empty' }, h('h3', null, 'Rien encore'), h('span', null, 'Chaque lieu tamponné, chaque photo et chaque note viendra s’inscrire ici, jour par jour, dans l’ordre réel de la visite.')));
  for (const d of daysWith){
    const v = ps.filter(p => p.day === d && p.status === 'visited').sort((a, b) => (a.visitedAt || '').localeCompare(b.visitedAt || ''));
    const dayPhotos = photos.filter(m => m.day === d && !m.placeId); const dayNotes = all('note').filter(n => n.day === d && !n.placeId && !n.bookingId);
    out.push(h('div', { class: 'mem-day' },
      h('div', { class: 'spread' }, h('h3', null, fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' })), h('span', { class: 'eyebrow' }, 'J' + (ds.indexOf(d) + 1))),
      h('div', { class: 'tl' }, v.map(p => { const ph = mediaOf('placeId', p.id, 'photo'), nt = notesOf('placeId', p.id);
        return h('div', { class: 'tl-item' + (p.addedDuring ? ' unplanned' : '') },
          h('div', { class: 'row' }, h('span', { class: 'mono muted' }, p.visitedAt ? fmtTime(p.visitedAt) : ''), h('strong', { style: 'cursor:pointer', onclick: () => openPlace(p.id) }, p.name), p.addedDuring ? h('span', { class: 'chip warn' }, 'improvisé') : null),
          nt.map(noteEl), ph.length ? h('div', { style: 'margin-top:6px' }, thumbs(ph)) : null); })),
      dayNotes.map(noteEl), dayPhotos.length ? thumbs(dayPhotos) : null));
  }
  return out;
}

/* ---- Claude ---- */
function tripContext(){
  const t = trip(), d = currentDay();
  const lines = [`Voyage « ${t.name} » du ${t.start} au ${t.end}. Aujourd'hui : ${todayIso()}. Journée affichée : ${d || '—'}.`];
  if (d){ const { A, ps } = dayModel(d);
    if (A.start) lines.push(`Départ : ${A.start.name}.`);
    lines.push('Étapes : ' + (ps.map(p => `${p.time ? p.time + ' ' : ''}${p.name} [${p.status === 'visited' ? 'fait' : p.status === 'skipped' ? 'abandonné' : 'à faire'}]`).join(' ; ') || 'aucune'));
    if (A.end) lines.push(`Nuit : ${A.end.name}.`);
    const bk = bookingsOf(d).filter(b => b.kind !== 'hotel'); if (bk.length) lines.push('Réservations : ' + bk.map(b => `${b.time || ''} ${b.title}`).join(' ; '));
  }
  return lines.join('\n');
}
function askClaude(question){
  const prompt = `${question}\n\nContexte depuis l'appli Tabi :\n${tripContext()}\n\nLe détail complet est dans mon dossier Google Drive « Tabi - Japon » (lis d'abord README.md). Si tu proposes des lieux, ajoute-les comme suggestions dans data/ selon le format du README.`;
  const url = 'https://claude.ai/new?q=' + encodeURIComponent(prompt.slice(0, 1800));
  (navigator.clipboard ? navigator.clipboard.writeText(prompt).catch(() => {}) : Promise.resolve()).finally(() => {});
  window.open(url, '_blank', 'noopener');
  toast('Question copiée et ouverte dans Claude');
}
function viewClaude(){
  const sugg = all('place').filter(p => p.status === 'suggested').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const day = currentDay();
  const presets = ['Que faire près de mes prochains arrêts aujourd’hui ?', 'Propose un restaurant pour ce soir près de mon dernier lieu.', 'Il pleut : quelles alternatives couvertes pour ma journée ?', 'Ma journée est-elle trop chargée ? Propose un ordre plus logique.'];
  const box = h('textarea', { id: 'ask-in', rows: '2', placeholder: 'Pose ta question…', style: 'flex:1' });
  return [
    h('div', null, h('div', { class: 'eyebrow' }, 'Ouvre Claude avec le contexte de la journée'), h('h2', null, 'Demander à Claude')),
    h('div', { class: 'panel', style: 'padding:12px;display:flex;flex-direction:column;gap:10px' },
      h('div', { class: 'row' }, presets.map(p => h('button', { class: 'btn', type: 'button', onclick: () => askClaude(p) }, p))),
      h('div', { class: 'row', style: 'flex-wrap:nowrap;align-items:flex-end' }, box, h('button', { class: 'btn primary', type: 'button', onclick: () => { const q = box.value.trim(); if (q) askClaude(q); } }, 'Demander')),
      h('div', { class: 'muted small' }, 'La question s’ouvre dans claude.ai (elle est aussi copiée, au cas où elle ne serait pas pré-remplie). Claude lit le dossier Drive et dépose ses propositions ici.')),
    h('div', null, h('div', { class: 'eyebrow' }, sugg.length ? sugg.length + ' suggestion' + (sugg.length > 1 ? 's' : '') + ' de Claude' : 'Suggestions de Claude')),
    sugg.length ? h('div', { class: 'stops panel' }, sugg.map(p => h('div', { class: 'sec sugg', style: 'margin:8px;padding:10px 12px' },
      h('div', { class: 'spread' }, h('strong', null, p.name), kindChip(p.kind)),
      p.note ? h('div', { class: 'muted', style: 'font-size:13.5px' }, p.note) : null,
      p.city ? h('div', { class: 'muted small' }, p.city + (p.day ? ' · proposé pour le ' + fmtDay(p.day) : '')) : null,
      h('div', { class: 'row' },
        day ? h('button', { class: 'btn primary', type: 'button', onclick: () => save({ id: p.id, status: 'planned', day: p.day || day, order: nextOrder(p.day || day), addedDuring: duringTrip(p.day || day) }, 'Ajouté au ' + fmtDay(p.day || day)) }, 'Ajouter au ' + fmtDay(p.day || day)) : null,
        h('button', { class: 'btn', type: 'button', onclick: () => save({ id: p.id, status: 'planned', day: null }, 'Gardé en idée') }, 'Garder en idée'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => removeItem(p.id) }, 'Ignorer'))))) :
      h('div', { class: 'panel empty' }, h('span', null, 'Aucune suggestion en attente.')),
  ];
}

/* ---- Voyage, réglages ---- */
function tripForm(first){
  const t = trip() || {};
  const f = h('form', { class: first ? 'panel form' : 'form', style: first ? '' : 'padding:0', onsubmit: async e => {
    e.preventDefault(); const fd = new FormData(f);
    const name = String(fd.get('name')).trim(), start = fd.get('start'), end = fd.get('end');
    if (!name || !start || !end) return; if (end < start){ toast('La fin doit suivre le début.'); return; }
    document.activeElement && document.activeElement.blur();
    await save({ id: 'trip', type: 'trip', name, start, end, walkMax: +fd.get('walkMax') || 20 }, first ? 'Voyage créé' : 'Voyage mis à jour');
  } },
    first ? h('div', null, h('div', { class: 'eyebrow' }, 'Premier voyage'), h('h2', null, 'Ouvrir le carnet')) : null,
    h('label', { class: 'f' }, 'Nom', h('input', { type: 'text', name: 'name', id: 'tf-name', required: true, value: t.name || 'Japon', placeholder: 'Japon, hiver 2026' })),
    h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Arrivée', h('input', { type: 'date', name: 'start', id: 'tf-start', required: true, value: t.start || '' })), h('label', { class: 'f' }, 'Départ', h('input', { type: 'date', name: 'end', id: 'tf-end', required: true, value: t.end || '' }))),
    h('label', { class: 'f' }, 'Marche maximale avant de proposer les transports (choix auto)', h('select', { name: 'walkMax', id: 'tf-walk' }, [10, 15, 20, 25, 30, 40].map(m => h('option', { value: m, selected: m === (t.walkMax || 20) ? true : null }, m + ' min')))),
    h('div', null, h('button', { class: 'btn primary', type: 'submit' }, first ? 'Créer le voyage' : 'Enregistrer')));
  return f;
}
function openTripSheet(){
  openSheet(close => h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Voyage et réglages' },
    sheetHead('Voyage et réglages', close),
    trip() ? h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Ce voyage'), tripForm(false)) : null,
    h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Carte hors ligne'),
      h('div', { class: 'small' }, 'Télécharge le fond de carte autour de tous les lieux du voyage, à faire en Wi-Fi avant le départ.'),
      h('div', null, h('button', { class: 'btn', type: 'button', onclick: openOfflinePrep }, 'Préparer la carte hors ligne'))),
    h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Compte et synchronisation'),
      h('div', { class: 'small' }, S.account ? 'Connecté : ' + (S.account.displayName || '') + ' · ' + S.account.emailAddress : 'Non connecté'),
      h('div', { class: 'small muted' }, (S.lastSync ? 'Dernière synchro : ' + fmtDay(isoDay(new Date(S.lastSync))) + ' ' + fmtTime(S.lastSync) : 'Jamais synchronisé') + (S.pendingCount ? ' · ' + S.pendingCount + ' envoi(s) en attente' : '')),
      S.syncErr ? h('div', { class: 'banner warn' }, S.syncErr) : null,
      h('div', { class: 'row' },
        S.account ? h('button', { class: 'btn', type: 'button', onclick: () => { if (!hasToken()) connect(true); else syncNow(); } }, 'Synchroniser maintenant') : h('button', { class: 'btn primary', type: 'button', onclick: () => connect(false) }, 'Se connecter avec Google'),
        h('a', { class: 'btn', href: 'https://drive.google.com/drive/folders/' + CONFIG.rootFolderId, target: '_blank', rel: 'noopener' }, 'Dossier Drive'),
        S.account ? h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
          if (S.pendingCount && !confirmTwice()) return;
          clearToken(); S.account = null; await idb.del('meta', 'account'); for (const s of ['items', 'outbox', 'blobs']) await idb.clear(s); S.items.clear(); S.folders = null; await idb.del('meta', 'folders'); close(); renderAll(); } }, 'Se déconnecter') : null)),
    h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Installer sur le téléphone'),
      h('div', { class: 'small' }, 'Android (Chrome) : menu ⋮ › « Ajouter à l’écran d’accueil ». iPhone (Safari) : bouton Partager › « Sur l’écran d’accueil ».')),
    h('div', { style: 'height:8px' })));
}
let confirmArmed = 0;
function confirmTwice(){ if (Date.now() - confirmArmed < 4000) return true; confirmArmed = Date.now(); toast(S.pendingCount + ' modification(s) pas encore envoyée(s) seraient perdues. Touche encore pour confirmer.'); return false; }

/* ---- panneaux ---- */
function openSheet(builder){
  const root = $('#sheetRoot');
  const close = () => { S.sheet = null; root.replaceChildren(); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  if (S.sheet) S.sheet.close();
  document.addEventListener('keydown', esc);
  const st = { close, render(){ if (typingIn(root)){ S.deferred = true; return; } const top = (root.querySelector('.sheet') || {}).scrollTop || 0; const c = builder(close); if (!c){ close(); return; }
    root.replaceChildren(h('div', { class: 'scrim', onclick: e => { if (e.target === e.currentTarget) close(); } }, c)); const sh = root.querySelector('.sheet'); if (sh) sh.scrollTop = top; } };
  S.sheet = st; st.render();
}
const sheetHead = (title, close) => h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { class: 'btn ghost', type: 'button', onclick: close, 'aria-label': 'Fermer' }, 'Fermer'));

/* ================= démarrage ================= */
(async function boot(){
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('Tabi SW', e));
  try { await loadLocal(); } catch (e){ console.warn('Tabi cache', e); }
  renderAll();
})();
