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
  const q = `[out:json][timeout:25];(node["railway"~"^(subway_entrance|train_station_entrance)$"](around:450,${a});node["railway"="station"](around:900,${a});node["highway"="bus_stop"](around:300,${a}););out tags;`;
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
