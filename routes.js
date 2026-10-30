// Trajets à pied et lieux à proximité, via les services publics OpenStreetMap :
// Valhalla (FOSSGIS) en priorité, OSRM (FOSSGIS) en secours ; Overpass pour les entrées de métro et les lieux.
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function getJson(url, opts = {}, ms = 20000){
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e){ throw new Error(e.name === 'AbortError' ? 'délai dépassé' : (e.message || 'réseau')); }
  finally { clearTimeout(t); }
}

export function decode6(str){
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length){
    for (const k of [0, 1]){
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i <= str.length);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}
export const shapeCoords = route => (route && route.shapes ? route.shapes.flatMap(decode6) : []);

export function distM(a, b){
  const R = 6371e3, t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lng - a.lng) * t;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/* ---------- trajet à pied ---------- */
export async function walkRoute(pts){
  try { return await valhalla(pts); }
  catch (e){ console.warn('Tabi: Valhalla indisponible, essai OSRM', e); return await osrm(pts); }
}
async function valhalla(pts){
  const body = { locations: pts.map((p, i) => ({ lat: p.lat, lon: p.lng, type: i === 0 || i === pts.length - 1 ? 'break' : 'through' })),
    costing: 'pedestrian', directions_options: { language: 'fr-FR', units: 'kilometers' } };
  const j = await getJson(VALHALLA + '?json=' + encodeURIComponent(JSON.stringify(body)));
  const t = j && j.trip; if (!t || !t.legs) throw new Error('aucun trajet');
  return { engine: 'valhalla', time: Math.round(t.summary.time), length: Math.round(t.summary.length * 1000), shapes: t.legs.map(l => l.shape),
    steps: t.legs.flatMap(l => (l.maneuvers || []).map(m => [m.instruction, Math.round(m.length * 1000), Math.round(m.time)])) };
}
const DIR = { left: 'à gauche', right: 'à droite', 'slight left': 'légèrement à gauche', 'slight right': 'légèrement à droite', 'sharp left': 'franchement à gauche', 'sharp right': 'franchement à droite', straight: 'tout droit', uturn: 'demi-tour' };
function osrmText(s){
  const m = s.maneuver || {}, on = s.name ? ' sur ' + s.name : '';
  if (m.type === 'depart') return 'Partez' + on;
  if (m.type === 'arrive') return 'Vous êtes arrivé';
  if (m.type === 'roundabout' || m.type === 'rotary') return 'Au rond-point, continuez' + on;
  return (m.modifier ? 'Tournez ' + (DIR[m.modifier] || m.modifier) : 'Continuez') + on;
}
async function osrm(pts){
  const j = await getJson(OSRM_FOOT + pts.map(p => p.lng + ',' + p.lat).join(';') + '?overview=full&geometries=polyline6&steps=true');
  const r = j && j.routes && j.routes[0]; if (!r) throw new Error('aucun trajet');
  return { engine: 'osrm', time: Math.round(r.duration), length: Math.round(r.distance), shapes: [r.geometry],
    steps: r.legs.flatMap(l => l.steps.map(s => [osrmText(s), Math.round(s.distance), Math.round(s.duration)])) };
}

/* ---------- Overpass ---------- */
async function overpass(q){
  let last;
  for (const u of OVERPASS){
    try { return await getJson(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) }, 35000); }
    catch (e){ last = e; }
  }
  throw last || new Error('Overpass indisponible');
}
const nameOf = t => t['name:fr'] || t['name:en'] || t.name || '';
const altName = t => { const n = nameOf(t); return t.name && t.name !== n ? t.name : ''; };

// Entrées/sorties de métro et de gare, stations, arrêts de bus autour d'un point.
export async function transitNear(p){
  const a = `${p.lat},${p.lng}`;
  const q = `[out:json][timeout:25];(node["railway"~"^(subway_entrance|train_station_entrance)$"](around:450,${a});node["railway"="station"](around:900,${a});node["highway"="bus_stop"](around:300,${a}););out body;`;
  const j = await overpass(q);
  const ent = [], st = [], bus = []; const seenSt = new Set();
  for (const el of j.elements || []){
    const t = el.tags || {}; const pt = { lat: el.lat, lng: el.lon }; const d = Math.round(distM(p, pt));
    if (t.railway === 'subway_entrance' || t.railway === 'train_station_entrance'){
      ent.push({ ref: t.ref || t['ref:exit'] || '', name: nameOf(t), alt: altName(t), lat: el.lat, lng: el.lon, d, wc: t.wheelchair === 'yes' });
    } else if (t.railway === 'station'){
      const n = nameOf(t); if (!n || seenSt.has(n)) continue; seenSt.add(n);
      st.push({ name: n, alt: altName(t), lat: el.lat, lng: el.lon, d, op: t.operator || t.network || '', lines: t.line || '' });
    } else if (t.highway === 'bus_stop'){
      bus.push({ name: nameOf(t) || 'Arrêt de bus', alt: altName(t), lat: el.lat, lng: el.lon, d });
    }
  }
  const by = (x, y) => x.d - y.d;
  return { entrances: ent.sort(by).slice(0, 12), stations: st.sort(by).slice(0, 6), bus: bus.sort(by).slice(0, 6), at: new Date().toISOString() };
}

// Lieux à découvrir le long d'un tracé (mode promenade).
const CATS = [
  [t => t.tourism === 'viewpoint', 'Point de vue', 3],
  [t => t.tourism === 'attraction', 'Curiosité', 3],
  [t => t.tourism === 'museum', 'Musée', 2],
  [t => t.tourism === 'gallery', 'Galerie', 1],
  [t => t.amenity === 'place_of_worship' && /shinto/.test(t.religion || ''), 'Sanctuaire', 2],
  [t => t.amenity === 'place_of_worship' && /buddhist/.test(t.religion || ''), 'Temple', 2],
  [t => t.amenity === 'place_of_worship', 'Lieu de culte', 1],
  [t => t.leisure === 'garden', 'Jardin', 2],
  [t => t.amenity === 'marketplace', 'Marché', 2],
  [t => !!t.historic, 'Patrimoine', 1],
  [t => t.leisure === 'park', 'Parc', 1],
  [t => t.tourism === 'artwork', 'Œuvre', 0],
];
export async function poisAlong(coords, radius){
  if (coords.length < 2) return [];
  const step = Math.max(1, Math.ceil(coords.length / 60));
  const line = coords.filter((_, i) => i % step === 0 || i === coords.length - 1).map(([lng, lat]) => lat.toFixed(5) + ',' + lng.toFixed(5)).join(',');
  const R = `around:${radius},${line}`;
  const q = `[out:json][timeout:40];(nwr["tourism"~"^(attraction|viewpoint|museum|gallery|artwork)$"]["name"](${R});nwr["historic"]["name"](${R});nwr["amenity"~"^(place_of_worship|marketplace)$"]["name"](${R});nwr["leisure"~"^(garden|park)$"]["name"](${R}););out center tags 300;`;
  const j = await overpass(q);
  const pts = coords.map(([lng, lat]) => ({ lat, lng }));
  const seen = new Set(), out = [];
  for (const el of j.elements || []){
    const t = el.tags || {}; const lat = el.lat ?? (el.center && el.center.lat), lng = el.lon ?? (el.center && el.center.lon);
    if (lat == null) continue;
    const name = nameOf(t); if (!name || seen.has(name)) continue;
    const c = CATS.find(([f]) => f(t)); if (!c) continue;
    seen.add(name);
    let best = Infinity, idx = 0;
    pts.forEach((p, i) => { const d = distM(p, { lat, lng }); if (d < best){ best = d; idx = i; } });
    const score = c[2] + (t.wikidata || t.wikipedia ? 3 : 0) + (t.heritage ? 1 : 0) - best / 300;
    out.push({ id: el.type[0] + el.id, name, alt: altName(t), cat: c[1], lat: +lat.toFixed(6), lng: +lng.toFixed(6), d: Math.round(best), idx, score: +score.toFixed(2), wiki: !!(t.wikidata || t.wikipedia) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 30);
}

/* ---------- NAVITIME Route (totalnavi) via RapidAPI : itinéraires en transports au Japon ---------- */
const NAV_HOST = 'navitime-route-totalnavi.p.rapidapi.com';
const r5 = v => Math.round(v * 1e5) / 1e5;
function fareOf(f){
  if (f == null) return null;
  if (typeof f === 'number') return f;
  if (typeof f === 'object'){ const v = Object.values(f).find(x => typeof x === 'number'); return v ?? null; }
  return null;
}
const addMin = (t, n) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); const x = h * 60 + m + (n || 0); return String(Math.floor(x / 60) % 24).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const hhmm = s => { const m = String(s || '').match(/T(\d\d:\d\d)/); return m ? m[1] : ''; };
function shapeLines(shapes){
  const out = [];
  for (const f of (shapes && shapes.features) || []){
    const g = f.geometry || {}; const p = f.properties || {};
    const col = p.color ? (String(p.color).startsWith('#') ? p.color : '#' + p.color) : (p.inline_style && p.inline_style.color) || null;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const l of lines) if (l && l.length > 1) out.push({ color: col, coords: l.map(([x, y]) => [r5(x), r5(y)]) });
  }
  return out;
}
export async function navitimeRoutes(key, a, b, startTime){
  const q = new URLSearchParams({ start: a.lat + ',' + a.lng, goal: b.lat + ',' + b.lng, start_time: startTime, limit: '3', shape: 'true', shape_color: 'railway_line', datum: 'wgs84' }); // pas de « lang » : le multilingue n'est pas inclus dans le forfait gratuit
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
  let r;
  try { r = await fetch('https://' + NAV_HOST + '/route_transit?' + q, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': NAV_HOST }, signal: c.signal }); }
  catch (e){ throw new Error(e.name === 'AbortError' ? 'NAVITIME ne répond pas (délai dépassé)' : 'NAVITIME injoignable (réseau)'); }
  finally { clearTimeout(t); }
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
  if (!r.ok){
    const msg = (j && (j.message || (j.error && (j.error.message || j.error)))) || txt.slice(0, 160);
    const e = new Error(r.status === 429 ? 'Quota NAVITIME atteint pour le moment.' : r.status === 403 ? 'Clé NAVITIME refusée ou abonnement absent : ' + msg : 'NAVITIME : erreur ' + r.status + ' · ' + msg);
    e.status = r.status; throw e;
  }
  const items = (j && j.items) || [];
  return items.map(it => {
    const m = (it.summary && it.summary.move) || {};
    const secs = (it.sections || []).map(s => s.type === 'point'
      ? { t: 'p', name: s.name || '', gate: s.gateway || '', plat: s.start_platform || s.goal_platform || '', num: s.numbering ? JSON.stringify(s.numbering).replace(/[{}"\[\]]/g, '').slice(0, 40) : '', lat: s.coord ? r5(s.coord.lat) : null, lng: s.coord ? r5(s.coord.lon) : null }
      : { t: 'm', move: s.move || '', line: s.line_name || (s.transport && s.transport.name) || '', from: hhmm(s.from_time), to: hhmm(s.to_time), min: s.time ?? null, dist: s.distance ?? null,
          color: s.transport && s.transport.color ? (String(s.transport.color).startsWith('#') ? s.transport.color : '#' + s.transport.color) : null,
          dest: (s.transport && s.transport.destination && (s.transport.destination.name || s.transport.destination)) || '',
          getoff: (s.transport && s.transport.getoff) || '', company: (s.transport && s.transport.company && (s.transport.company.name || '')) || '', fare: fareOf(s.transport && s.transport.fare) });
    return { min: m.time ?? null, dist: m.distance ?? null, walk: m.walk_distance ?? null, transfers: m.transit_count ?? null, fare: fareOf(m.fare),
      dep: hhmm(it.summary && it.summary.start && it.summary.start.time) || hhmm(m.from_time) || (secs.find(s => s.t === 'm' && s.from) || {}).from || '',
      arr: hhmm(it.summary && it.summary.goal && it.summary.goal.time) || hhmm(m.to_time) || addMin(([...secs].reverse().find(s => s.t === 'm' && s.to) || {}).to, secs.slice(secs.map(s => s.t === 'm' && !!s.to).lastIndexOf(true) + 1).filter(s => s.t === 'm').reduce((t, s) => t + (s.min || 0), 0)),
      secs, shapes: shapeLines(it.shapes) };
  });
}

/* ---------- Traduction des résultats NAVITIME (japonais → lettres latines) ----------
   1) OpenStreetMap (Overpass) : noms anglais officiels des gares et des lignes ;
   2) dictionnaire des principales lignes et des sorties ;
   3) à défaut, transcription des kana en rōmaji (les kanji restent tels quels). */
const nfkc = s => String(s || '').normalize('NFKC').trim();
const LINE_DICT = [
  ['東京メトロ', 'Tokyo Metro '], ['都営', 'Toei '], ['ＪＲ', 'JR '], ['JR', 'JR '],
  ['銀座線', 'Ginza Line'], ['丸ノ内線', 'Marunouchi Line'], ['日比谷線', 'Hibiya Line'], ['東西線', 'Tōzai Line'], ['千代田線', 'Chiyoda Line'],
  ['有楽町線', 'Yūrakuchō Line'], ['半蔵門線', 'Hanzōmon Line'], ['南北線', 'Namboku Line'], ['副都心線', 'Fukutoshin Line'],
  ['浅草線', 'Asakusa Line'], ['三田線', 'Mita Line'], ['新宿線', 'Shinjuku Line'], ['大江戸線', 'Ōedo Line'],
  ['山手線', 'Yamanote Line'], ['中央・総武線', 'Chūō-Sōbu Line'], ['中央線快速', 'Chūō Rapid Line'], ['中央本線', 'Chūō Main Line'], ['中央線', 'Chūō Line'], ['総武線', 'Sōbu Line'],
  ['京浜東北線', 'Keihin-Tōhoku Line'], ['埼京線', 'Saikyō Line'], ['湘南新宿ライン', 'Shōnan-Shinjuku Line'], ['上野東京ライン', 'Ueno-Tokyo Line'],
  ['東海道新幹線', 'Tōkaidō Shinkansen'], ['山陽新幹線', 'San’yō Shinkansen'], ['東北新幹線', 'Tōhoku Shinkansen'], ['北陸新幹線', 'Hokuriku Shinkansen'], ['上越新幹線', 'Jōetsu Shinkansen'],
  ['東海道線', 'Tōkaidō Line'], ['横須賀線', 'Yokosuka Line'], ['常磐線', 'Jōban Line'], ['京葉線', 'Keiyō Line'],
  ['つくばエクスプレス', 'Tsukuba Express'], ['ゆりかもめ', 'Yurikamome'], ['りんかい線', 'Rinkai Line'], ['東京モノレール', 'Tokyo Monorail'],
  ['京王線', 'Keiō Line'], ['小田急線', 'Odakyū Line'], ['東急東横線', 'Tōkyū Tōyoko Line'], ['東急田園都市線', 'Tōkyū Den-en-toshi Line'],
  ['京急本線', 'Keikyū Main Line'], ['京成本線', 'Keisei Main Line'], ['西武池袋線', 'Seibu Ikebukuro Line'], ['西武新宿線', 'Seibu Shinjuku Line'], ['東武スカイツリーライン', 'Tōbu Skytree Line'],
  ['御堂筋線', 'Midōsuji Line'], ['堺筋線', 'Sakaisuji Line'], ['谷町線', 'Tanimachi Line'], ['四つ橋線', 'Yotsubashi Line'], ['長堀鶴見緑地線', 'Nagahori Tsurumi-ryokuchi Line'],
  ['烏丸線', 'Karasuma Line'], ['大阪環状線', 'Osaka Loop Line'], ['ＪＲ京都線', 'JR Kyōto Line'], ['奈良線', 'Nara Line'], ['嵯峨野線', 'Sagano Line'], ['嵐山線', 'Arashiyama Line'],
  ['京阪本線', 'Keihan Main Line'], ['阪急京都線', 'Hankyū Kyōto Line'], ['近鉄奈良線', 'Kintetsu Nara Line'], ['近鉄京都線', 'Kintetsu Kyōto Line'], ['南海本線', 'Nankai Main Line'],
  ['都営バス', 'Toei Bus'], ['市バス', 'City Bus'], ['バス', 'Bus'],
];
const GATE_DICT = [['中央口', 'centrale'], ['東口', 'Est'], ['西口', 'Ouest'], ['南口', 'Sud'], ['北口', 'Nord'], ['改札', ''], ['出口', ''], ['番', '']];
const KANA = {'きゃ':'kya','きゅ':'kyu','きょ':'kyo','しゃ':'sha','しゅ':'shu','しょ':'sho','ちゃ':'cha','ちゅ':'chu','ちょ':'cho','にゃ':'nya','にゅ':'nyu','にょ':'nyo','ひゃ':'hya','ひゅ':'hyu','ひょ':'hyo','みゃ':'mya','みゅ':'myu','みょ':'myo','りゃ':'rya','りゅ':'ryu','りょ':'ryo','ぎゃ':'gya','ぎゅ':'gyu','ぎょ':'gyo','じゃ':'ja','じゅ':'ju','じょ':'jo','びゃ':'bya','びゅ':'byu','びょ':'byo','ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo',
  'あ':'a','い':'i','う':'u','え':'e','お':'o','か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko','さ':'sa','し':'shi','す':'su','せ':'se','そ':'so','た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to','な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no','は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho','ま':'ma','み':'mi','む':'mu','め':'me','も':'mo','や':'ya','ゆ':'yu','よ':'yo','ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro','わ':'wa','を':'o','ん':'n',
  'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go','ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo','だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do','ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo','ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po','ー':'-'};
function kanaToRomaji(s){
  s = s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)); // katakana → hiragana
  let out = '';
  for (let i = 0; i < s.length; i++){
    const two = s.slice(i, i + 2);
    if (s[i] === 'っ' && i + 1 < s.length){ const nx = KANA[s.slice(i + 1, i + 3)] || KANA[s[i + 1]]; if (nx){ out += nx[0]; continue; } }
    if (KANA[two]){ out += KANA[two]; i++; continue; }
    out += KANA[s[i]] ?? s[i];
  }
  return out;
}
const hasJa = s => /[぀-ヿ一-鿿]/.test(s);
function dictLine(s){
  let o = nfkc(s); let hit = false;
  for (const [ja, en] of LINE_DICT){ const j = nfkc(ja); if (o.includes(j)){ o = o.split(j).join(en); hit = true; } }
  return hit ? o.replace(/\s+/g, ' ').trim() : null;
}
export function translateGate(g){
  let o = nfkc(g); if (!hasJa(o)) return o;
  for (const [ja, en] of GATE_DICT) o = o.split(ja).join(en);
  o = o.trim();
  return o ? 'Sortie ' + o : nfkc(g);
}
// Dictionnaire japonais → latin pour une liste de noms de gares et de lignes, centré sur une zone.
export async function translateNames(stations, lines, center){
  const map = {};
  const esc = s => s.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
  const st = [...new Set(stations.map(nfkc).filter(hasJa))].slice(0, 60);
  const ln = [...new Set(lines.map(nfkc).filter(hasJa))].slice(0, 30);
  if (st.length || ln.length){
    const d = 1.3, bb = `${(center.lat - d).toFixed(3)},${(center.lng - d).toFixed(3)},${(center.lat + d).toFixed(3)},${(center.lng + d).toFixed(3)}`;
    const parts = [];
    if (st.length){ const re = '^(' + st.map(esc).join('|') + ')(駅)?$'; parts.push(`node["railway"="station"]["name"~"${re}"](${bb});`, `node["public_transport"="station"]["name"~"${re}"](${bb});`); }
    if (ln.length){ const re = '(' + ln.map(s => esc(s.replace(/^(ＪＲ|JR)/, ''))).join('|') + ')'; parts.push(`relation["type"="route_master"]["name"~"${re}"](${bb});`); }
    try {
      const j = await overpass(`[out:json][timeout:40];(${parts.join('')});out tags;`);
      for (const el of j.elements || []){
        const t = el.tags || {}; const ja = nfkc(t.name || '').replace(/駅$/, '');
        const en = t['name:en'] || t['name:ja-Latn'] || t['name:ja_rm'] || '';
        if (!ja || !en) continue;
        if (el.type === 'node'){ if (!map[ja]) map[ja] = en.replace(/ Station$/i, ''); }
        else for (const l of ln) if (ja.includes(l.replace(/^(ＪＲ|JR)/, '')) && !map[l]) map[l] = en;
      }
    } catch (e){ console.warn('Tabi traduction', e); }
  }
  for (const s of st) if (!map[s]) map[s] = hasJa(kanaToRomaji(s)) ? '' : kanaToRomaji(s).replace(/^./, c => c.toUpperCase());
  for (const l of ln){ const dl = dictLine(l); if (dl && (!map[l] || /[぀-鿿]/.test(map[l]))) map[l] = dl; }
  return map;
}

/* ---------- Google Places (New) : recherche de lieux ---------- */
const PLACES = 'https://places.googleapis.com/v1/';
async function gfetch(url, key, opts = {}, fields){
  let r;
  try { r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, ...(fields ? { 'X-Goog-FieldMask': fields } : {}), ...(opts.headers || {}) } }); }
  catch { throw new Error('Recherche Google injoignable (réseau)'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok){ const e = new Error((j.error && j.error.message) || ('Google Places : erreur ' + r.status)); e.status = r.status; throw e; }
  return j;
}
export async function googleAutocomplete(key, input, bias, session){
  const body = { input, languageCode: 'fr', sessionToken: session };
  if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 30000 } };
  const j = await gfetch(PLACES + 'places:autocomplete', key, { method: 'POST', body: JSON.stringify(body) });
  return (j.suggestions || []).filter(s => s.placePrediction).map(s => { const p = s.placePrediction;
    return { src: 'g', id: p.placeId, name: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || (p.text && p.text.text) || '',
      sub: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || '', types: p.types || [] }; });
}
export async function googlePlace(key, id, session){
  const j = await gfetch(PLACES + 'places/' + encodeURIComponent(id) + '?languageCode=fr&sessionToken=' + encodeURIComponent(session || ''), key, {},
    'id,displayName,formattedAddress,location,types,primaryType,googleMapsUri,addressComponents');
  const comp = t => ((j.addressComponents || []).find(c => (c.types || []).includes(t)) || {}).longText || '';
  return { id: j.id, name: (j.displayName && j.displayName.text) || '', address: j.formattedAddress || '', lat: j.location && j.location.latitude, lng: j.location && j.location.longitude,
    types: [j.primaryType, ...(j.types || [])].filter(Boolean), mapsUrl: j.googleMapsUri || null,
    city: comp('locality') || comp('sublocality_level_1') || comp('administrative_area_level_2') || comp('administrative_area_level_1') };
}
export function kindFromGoogle(types){
  const t = (types || []).join(' ');
  if (/lodging|hotel|hostel|inn|guest_house|ryokan/.test(t)) return 'hotel';
  if (/restaurant|cafe|bar|bakery|food|meal|coffee|ramen|sushi|izakaya|tea_house|dessert|confectionery/.test(t)) return 'resto';
  if (/train_station|subway_station|transit_station|bus_station|airport|light_rail_station|ferry_terminal/.test(t)) return 'transport';
  if (/amusement|aquarium|zoo|spa|onsen|bowling|karaoke|stadium|water_park|ski|gym|theater|movie|night_club|escape/.test(t)) return 'activite';
  return 'visite';
}
