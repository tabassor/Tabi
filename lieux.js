// Tabi — bibliothèque de lieux, visites, cartes postales et QR codes (lot 1, voir docs/lieux-lot1.md).
// Un lieu (type `lieu`, id = code permanent « TB-XXXXXX ») existe en dehors des journées ; une visite (type `visite`)
// est un passage daté ; une étape de journée (`place`) peut pointer vers un lieu par `lieuId`.
// Le module reçoit les outils de l'appli (rendu, sauvegarde, carte…) par installLieux(X).

export const LIEU_KINDS = { facade: 'Façade / architecture', ambiance: 'Rue / ambiance', photo: 'Spot photo' };
export const SEASONS = { printemps: 'Printemps', ete: 'Été', automne: 'Automne', hiver: 'Hiver' };
export const MOMENTS = { matin: 'Matin', journee: 'Journée', doree: 'Heure dorée', soir: 'Soir', nuit: 'Nuit' };
export const DETOUR = { passage: 'En passant', detour: 'Vaut un détour', expres: 'À faire exprès' };
// Marques de notation japonaises : ◎ excellent, ○ bien, △ moyen.
export const VERDICT = { super: ['◎', 'Super'], bien: ['○', 'Bien'], bof: ['△', 'Bof'] };
const DIRS = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SO', 225], ['O', 270], ['NO', 315]];
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_RE = /TB-[2-9A-HJKMNP-Z]{6}(?:\/\d{1,3})?/;

export const seasonOf = d => { if (!d) return null; const m = +d.slice(5, 7); return m >= 3 && m <= 5 ? 'printemps' : m >= 6 && m <= 8 ? 'ete' : m >= 9 && m <= 11 ? 'automne' : 'hiver'; };
export const momentOf = t => { if (!t) return null; const hh = +t.slice(0, 2); return hh < 10 ? 'matin' : hh < 16 ? 'journee' : hh < 18 ? 'doree' : hh < 20 ? 'soir' : 'nuit'; };
const dirLabel = deg => deg == null ? '' : DIRS.reduce((b, d) => Math.abs(((deg - d[1] + 540) % 360) - 180) < Math.abs(((deg - b[1] + 540) % 360) - 180) ? d : b, DIRS[0])[0];
export const normCode = s => { const m = String(s || '').toUpperCase().replace(/\s+/g, '').match(/TB-?([2-9A-HJKMNP-Z]{6})(\/\d+)?/); if (!m) return null;
  return { code: 'TB-' + m[1], n: m[2] ? +m[2].slice(1) : null }; };

const loadScript = (() => { const p = {}; return src => p[src] || (p[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { delete p[src]; rej(new Error('chargement ' + src)); }; document.head.append(s); })); })();

export function installLieux(X){
  const { h, S, all, live, save, toast, uid, meName, num, dist, fmtDist, fmtDay, fmtTime, isoDay, todayIso, tripDays, currentDay, daySeq, hasPos,
    kindIcon, kindKey, KINDS, kindChip, openSheet, sheetHead, mediaOf, thumbs, mediaUrl, uploadButton, addMediaFile, readExif, schedule, renderAll,
    M, markerEl, mapPanel, mapTools, startPlacing, nextOrder, duringTrip, dayAnchors, placeUrl, openPlace, openPlaceForm, refreshDayLegs, LS, CONFIG,
    nearbyNames, viewIdeas, placesOf, addrButton } = X;

  /* ---------- données ---------- */
  const rawLieux = () => [...S.items.values()].filter(x => x.type === 'lieu');
  const lieux = () => all('lieu').filter(l => !l.mergedInto);
  const visitesOf = code => all('visite').filter(v => v.lieuId === code).sort((a, b) => ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || '')) || (a.n || 0) - (b.n || 0));
  const photosOf = code => all('media').filter(m => m.lieuId === code && m.role === 'photo').sort((a, b) => (a.takenAt || a.at || '').localeCompare(b.takenAt || b.at || ''));
  const statusOf = l => visitesOf(l.id).length ? 'vecu' : 'repere';
  const verdictOf = l => l.verdict || (visitesOf(l.id).filter(v => v.verdict).pop() || {}).verdict || null;
  const refPhoto = l => (l.refPhoto && live(l.refPhoto)) || photosOf(l.id)[0] || null;
  const knownNames = () => [...new Set([meName(), ...lieux().map(l => l.by), ...all('visite').map(v => v.by)].filter(Boolean))];

  function newCode(){
    for (let k = 0; k < 50; k++){
      const a = new Uint8Array(6); crypto.getRandomValues(a);
      const c = 'TB-' + [...a].map(x => ALPHA[x % ALPHA.length]).join('');
      if (!S.items.has(c)) return c;
    }
    throw new Error('code');
  }
  // Résolution d'un code lu (QR ou saisie) : suit les fusions, retrouve la visite n (y compris son ancien numéro).
  function resolve(input){
    const c = typeof input === 'string' ? normCode(input) : input; if (!c) return null;
    let l = S.items.get(c.code); const orig = c.code; let g = 0;
    while (l && l.type === 'lieu' && l.mergedInto && g++ < 6) l = S.items.get(l.mergedInto);
    if (!l || l.type !== 'lieu' || l.deleted) return null;
    let v = null;
    if (c.n != null){
      v = visitesOf(l.id).find(x => (orig === l.id && x.n === c.n) || x.formerly === orig + '/' + c.n) || null;
    }
    return { lieu: l, visite: v };
  }
  async function createLieu(f){
    const code = newCode(); const at = new Date().toISOString();
    return save({ id: code, type: 'lieu', code, name: f.name || 'Lieu sans nom', kind: f.kind || 'visite', by: f.by || meName(), createdAt: at,
      seasons: [], moments: [], tags: [], ...f });
  }
  const nextN = code => 1 + Math.max(0, ...[...S.items.values()].filter(x => x.type === 'visite' && x.lieuId === code).map(x => x.n || 0));
  async function createVisite(code, f = {}){
    const date = f.date || todayIso();
    return save({ id: 'vi-' + uid(), type: 'visite', lieuId: code, n: nextN(code), date, time: f.time || null, season: seasonOf(date), by: f.by || meName(), at: new Date().toISOString(), ...f });
  }
  // Étape de journée créée à partir d'un lieu de la bibliothèque.
  async function stepFromLieu(l, day, extra = {}){
    const p = await save({ id: uid(), type: 'place', name: l.name, nameJa: l.nameJa || null, kind: l.kind || 'visite', day, order: nextOrder(day), time: null,
      city: l.city || null, address: l.address || null, addressJa: l.addressJa || null, lat: num(l.lat), lng: num(l.lng), coordSource: l.coordSource || null,
      mapsUrl: l.mapsUrl || null, status: 'planned', addedDuring: duringTrip(day), lieuId: l.id, note: null, createdBy: meName(), createdAt: new Date().toISOString(), ...extra },
      'Ajouté au ' + fmtDay(day) + ' · ' + l.name);
    M.sig = ''; refreshDayLegs(day);
    return p;
  }
  const near = (p, radius, exclude) => lieux().filter(l => hasPos(l) && l.id !== exclude).map(l => ({ l, d: dist(p, l) })).filter(x => x.d <= radius).sort((a, b) => a.d - b.d);

  // Fusion : les visites, photos et étapes du lieu absorbé passent au lieu gardé ; l'ancien code reste résolu.
  async function merge(fromCode, intoCode){
    const a = live(fromCode), b = live(intoCode); if (!a || !b || a.id === b.id) return;
    let n = nextN(b.id);
    for (const v of visitesOf(a.id)) await save({ id: v.id, lieuId: b.id, n: n++, formerly: v.formerly || (a.id + '/' + v.n) });
    for (const m of all('media').filter(m => m.lieuId === a.id)) await save({ id: m.id, lieuId: b.id });
    for (const p of all('place').filter(p => p.lieuId === a.id)) await save({ id: p.id, lieuId: b.id });
    const u = arr => [...new Set([...(b[arr] || []), ...(a[arr] || [])])];
    const patch = { id: b.id, seasons: u('seasons'), moments: u('moments'), tags: u('tags') };
    for (const k of ['nameJa', 'nameKana', 'heading', 'city', 'country', 'address', 'addressJa', 'access', 'detour', 'source', 'refPhoto', 'mapsUrl']) if (b[k] == null && a[k] != null) patch[k] = a[k];
    if (a.note && a.note !== b.note) patch.note = [b.note, a.note].filter(Boolean).join('\n');
    if (!hasPos(b) && hasPos(a)) Object.assign(patch, { lat: a.lat, lng: a.lng, coordSource: a.coordSource });
    await save(patch);
    await save({ id: a.id, mergedInto: b.id }, 'Fusionné dans « ' + b.name + ' »');
  }

  /* ---------- hooks pour les journées ---------- */
  // Tamponner une étape liée à un lieu crée la visite du jour ; retirer le tampon supprime une visite restée vide.
  async function onStepStamped(p){
    if (!p.lieuId || !live(p.lieuId)) return;
    const date = p.day || todayIso();
    if (visitesOf(p.lieuId).some(v => v.date === date)) return;
    await createVisite(p.lieuId, { date, time: fmtTime(new Date().toISOString()), stepId: p.id });
  }
  async function onStepUnstamped(p){
    if (!p.lieuId) return;
    const v = visitesOf(p.lieuId).find(v => v.stepId === p.id);
    if (v && !v.phrase && !v.verdict && !all('media').some(m => m.visiteId === v.id)) await save({ id: v.id, deleted: true });
  }
  const dayLinked = day => new Set(placesOf(day).map(p => p.lieuId).filter(Boolean));
  // Lieux repérés à moins de ~10 min à pied (800 m à vol d'oiseau) d'une étape positionnée de la journée.
  function nearDay(day, radius = 800){
    if (!day) return [];
    const stops = daySeq(day).seq.filter(hasPos); if (!stops.length) return [];
    const linked = dayLinked(day);
    return lieux().filter(l => hasPos(l) && !linked.has(l.id) && statusOf(l) === 'repere').map(l => {
      let best = null; for (const s of stops){ const d = dist(s, l); if (!best || d < best.d) best = { d, s }; }
      return { l, ...best };
    }).filter(x => x.d <= radius).sort((a, b) => a.d - b.d);
  }
  function nearPanel(day){
    const list = nearDay(day); if (!list.length) return null;
    const se = seasonOf(day);
    return h('div', { class: 'panel near-lieux' },
      h('div', { class: 'sec', style: 'padding-bottom:4px' }, h('div', { class: 'eyebrow' }, 'À voir près de ta journée · ' + list.length + ' lieu' + (list.length > 1 ? 'x' : '') + ' repéré' + (list.length > 1 ? 's' : ''))),
      list.slice(0, 8).map(({ l, d, s }) => h('div', { class: 'lrow' },
        lieuThumb(l),
        h('div', { class: 'grow', role: 'button', tabindex: '0', onclick: () => openLieu(l.id), onkeydown: e => { if (e.key === 'Enter') openLieu(l.id); } },
          h('div', { class: 'name' }, l.name, l.nameJa ? h('span', { class: 'muted small', lang: 'ja' }, ' ' + l.nameJa) : null),
          h('div', { class: 'meta' }, kindChip(l.kind), h('span', { class: 'muted small' }, fmtDist(d) + ' de ' + (s.name || 'une étape')),
            (l.seasons || []).includes(se) ? h('span', { class: 'chip solid' }, 'bonne saison') : null,
            (l.moments || []).map(m => h('span', { class: 'chip' }, MOMENTS[m])),
            l.detour ? h('span', { class: 'chip' }, DETOUR[l.detour]) : null)),
        h('button', { class: 'btn', type: 'button', onclick: () => stepFromLieu(l, day) }, 'Ajouter'))),
      h('div', { class: 'sec muted small' }, 'Lieux de ta bibliothèque pas encore vécus. « Ajouter » les place en fin de journée ; fais-les glisser pour les ranger.'));
  }
  function dayMarkers(E, day){
    for (const { l } of nearDay(day)) E.marker(markerEl('i lieu k-' + kindKey(l.kind), kindIcon(kindKey(l.kind)), () => openLieu(l.id), 'À voir · ' + l.name), l);
  }
  // Section « Bibliothèque » dans la fiche d'une étape.
  function placeSection(p, close){
    const l = p.lieuId ? live(p.lieuId) : null;
    if (l) return h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Bibliothèque de lieux'),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { close(); openLieu(l.id); } }, 'Ouvrir le lieu ', h('span', { class: 'mono small' }, l.id)),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => save({ id: p.id, lieuId: null }, 'Lien retiré') }, 'Délier')));
    const cands = hasPos(p) ? near(p, 200).slice(0, 4) : [];
    return h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Bibliothèque de lieux'),
      cands.length ? h('div', { class: 'col' }, h('div', { class: 'muted small' }, 'Lieu déjà connu tout près :'),
        cands.map(({ l, d }) => h('button', { class: 'doc', type: 'button', onclick: async () => { await save({ id: p.id, lieuId: l.id }, 'Lié à « ' + l.name + ' »'); if (p.status === 'visited') await onStepStamped({ ...p, lieuId: l.id }); } },
          h('span', null, 'Lier à « ' + l.name + ' » · ' + fmtDist(d))))) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: async () => {
        const l2 = await createLieu({ name: p.name, nameJa: p.nameJa || null, kind: p.kind || 'visite', lat: num(p.lat), lng: num(p.lng), coordSource: p.coordSource || null,
          city: p.city || null, address: p.address || null, addressJa: p.addressJa || null, mapsUrl: p.mapsUrl || null, note: p.note || null });
        await save({ id: p.id, lieuId: l2.id });
        if (p.status === 'visited'){
          const v = await createVisite(l2.id, { date: p.day || (p.visitedAt ? isoDay(new Date(p.visitedAt)) : todayIso()), time: p.visitedAt ? fmtTime(p.visitedAt) : null, stepId: p.id, by: p.visitedBy || meName() });
          for (const m of mediaOf('placeId', p.id, 'photo')) await save({ id: m.id, lieuId: l2.id, visiteId: v.id });
        }
        toast('Ajouté à la bibliothèque · ' + l2.id);
      } }, 'Garder dans la bibliothèque'),
        h('span', { class: 'muted small' }, 'Le lieu survivra au voyage, avec ses visites et ses photos.')));
  }

  /* ---------- vue « Lieux » ---------- */
  const F = (() => { let s = {}; try { s = JSON.parse(LS.get('tabi.lieuxF') || '{}'); } catch {} return Object.assign({ mode: 'lib', q: '', kind: '', status: '', verdict: '', season: '', moment: '', tag: '', by: '', city: '', near: null, radius: 1000 }, s, { near: null }); })();
  const keepF = () => LS.set('tabi.lieuxF', JSON.stringify({ ...F, near: null, q: '' }));
  const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function filtered(){
    const q = fold(F.q);
    return lieux().filter(l => {
      if (q && ![l.name, l.nameJa, l.nameKana, l.city, l.country, l.note, l.id, ...(l.tags || [])].some(x => fold(x).includes(q))) return false;
      if (F.kind && l.kind !== F.kind) return false;
      if (F.status && statusOf(l) !== F.status) return false;
      if (F.verdict && verdictOf(l) !== F.verdict) return false;
      if (F.season && !(l.seasons || []).includes(F.season) && !visitesOf(l.id).some(v => v.season === F.season)) return false;
      if (F.moment && !(l.moments || []).includes(F.moment)) return false;
      if (F.tag && !(l.tags || []).includes(F.tag)) return false;
      if (F.by && l.by !== F.by && !visitesOf(l.id).some(v => v.by === F.by)) return false;
      if (F.city && (l.city || l.country) !== F.city) return false;
      if (F.near && !(hasPos(l) && dist(F.near, l) <= F.radius)) return false;
      return true;
    }).sort((a, b) => F.near ? dist(F.near, a) - dist(F.near, b) : (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  const lieuThumb = l => {
    const m = refPhoto(l);
    if (m && m.thumb) return h('img', { class: 'lthumb', src: m.thumb, alt: '' });
    return h('span', { class: 'lthumb k-' + kindKey(l.kind) }, kindIcon(kindKey(l.kind)));
  };
  const statusChip = l => { const n = visitesOf(l.id).length; return n ? h('span', { class: 'chip solid' }, 'Vécu' + (n > 1 ? ' ×' + n : '')) : h('span', { class: 'chip dashed' }, 'Repéré'); };
  const verdictChip = v => v ? h('span', { class: 'chip vd vd-' + v, title: VERDICT[v][1] }, VERDICT[v][0] + ' ' + VERDICT[v][1]) : null;
  function lieuRow(l){
    return h('div', { class: 'lrow', 'data-id': l.id },
      lieuThumb(l),
      h('div', { class: 'grow', role: 'button', tabindex: '0', onclick: () => openLieu(l.id), onkeydown: e => { if (e.key === 'Enter') openLieu(l.id); } },
        h('div', { class: 'name' }, l.name, l.nameJa ? h('span', { class: 'muted small', lang: 'ja' }, ' ' + l.nameJa) : null),
        h('div', { class: 'meta' }, kindChip(l.kind), statusChip(l), verdictChip(verdictOf(l)), l.private ? h('span', { class: 'chip', title: 'Privé : jamais exporté' }, '🔒 privé') : null,
          (l.seasons || []).map(s => h('span', { class: 'chip' }, SEASONS[s])),
          l.city ? h('span', { class: 'muted small' }, l.city) : null,
          F.near && hasPos(l) ? h('span', { class: 'muted small' }, fmtDist(dist(F.near, l))) : null,
          l._pending ? h('span', { class: 'muted small' }, '· non synchronisé') : null)));
  }
  function filterBar(){
    const all0 = lieux();
    const opts = (vals, labels, cur, empty) => [h('option', { value: '' }, empty), ...vals.map(v => h('option', { value: v, selected: v === cur ? true : null }, labels ? labels[v] || v : v))];
    const sel = (k, vals, labels, empty) => h('select', { id: 'lf-' + k, 'aria-label': empty, onchange: e => { F[k] = e.target.value; e.target.blur(); keepF(); schedule(); } }, opts(vals, labels, F[k], empty));
    const kinds = [...new Set(all0.map(l => l.kind).filter(Boolean))].sort();
    const tags = [...new Set(all0.flatMap(l => l.tags || []))].sort();
    const cities = [...new Set(all0.map(l => l.city || l.country).filter(Boolean))].sort();
    const bys = [...new Set([...all0.map(l => l.by), ...all('visite').map(v => v.by)].filter(Boolean))].sort();
    const active = ['kind', 'status', 'verdict', 'season', 'moment', 'tag', 'by', 'city'].filter(k => F[k]).length + (F.near ? 1 : 0);
    const nearSel = h('select', { id: 'lf-near', 'aria-label': 'Autour de', onchange: e => setNear(e.target.value) },
      h('option', { value: '' }, 'Partout'), h('option', { value: 'me', selected: F.near && F.near.src === 'me' ? true : null }, 'Autour de moi'),
      h('option', { value: 'hotel', selected: F.near && F.near.src === 'hotel' ? true : null }, 'Autour de l’hôtel du jour'));
    return h('div', { class: 'panel', style: 'padding:10px 12px;display:flex;flex-direction:column;gap:8px' },
      h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        // la liste et la carte se mettent à jour sur place pendant la frappe (le reste de la vue attend la fin de la saisie)
        h('input', { type: 'search', id: 'lf-q', placeholder: 'Chercher un lieu, une ville, une étiquette, un code…', value: F.q, style: 'flex:1', oninput: e => { F.q = e.target.value; clearTimeout(filterBar.t);
          filterBar.t = setTimeout(() => { const el = document.getElementById('lieux-list'); if (el) el.replaceChildren(listBody()); M.sig = ''; updateLibMap(); }, 250); } })),
      h('details', { open: F.fopen || active ? true : null, ontoggle: e => { F.fopen = e.target.open; } }, h('summary', { class: 'small', style: 'cursor:pointer;font-weight:600' }, 'Filtres' + (active ? ' (' + active + ')' : '')),
        h('div', { class: 'grid2', style: 'margin-top:8px' },
          sel('kind', kinds, KINDS, 'Toutes catégories'), sel('status', ['repere', 'vecu'], { repere: 'Repérés (à voir)', vecu: 'Vécus' }, 'Repérés et vécus'),
          sel('verdict', Object.keys(VERDICT), Object.fromEntries(Object.entries(VERDICT).map(([k, v]) => [k, v[0] + ' ' + v[1]])), 'Tous avis'),
          sel('season', Object.keys(SEASONS), SEASONS, 'Toutes saisons'), sel('moment', Object.keys(MOMENTS), MOMENTS, 'Tous moments'),
          sel('city', cities, null, 'Toutes villes'), sel('tag', tags, null, 'Toutes étiquettes'), sel('by', bys, null, 'Tous auteurs'),
          nearSel,
          h('select', { id: 'lf-radius', 'aria-label': 'Rayon', disabled: F.near ? null : true, onchange: e => { F.radius = +e.target.value; e.target.blur(); keepF(); schedule(); } },
            [300, 500, 1000, 2000, 5000, 20000].map(r => h('option', { value: r, selected: r === F.radius ? true : null }, 'Dans un rayon de ' + fmtDist(r))))),
        active ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => { for (const k of ['kind', 'status', 'verdict', 'season', 'moment', 'tag', 'by', 'city']) F[k] = ''; F.near = null; keepF(); schedule(); } }, 'Effacer les filtres')) : null));
  }
  function setNear(v){
    if (!v){ F.near = null; schedule(); return; }
    if (v === 'hotel'){
      const A = dayAnchors(currentDay() || todayIso()); const a = [A.end, A.start].find(x => x && hasPos(x));
      if (!a){ toast('Pas d’hôtel positionné pour ce jour.'); F.near = null; schedule(); return; }
      F.near = { lat: a.lat, lng: a.lng, src: 'hotel' }; M.sig = ''; schedule(); return;
    }
    if (!navigator.geolocation){ toast('Position indisponible.'); return; }
    toast('Recherche de ta position…');
    navigator.geolocation.getCurrentPosition(p => { F.near = { lat: p.coords.latitude, lng: p.coords.longitude, src: 'me' }; M.sig = ''; schedule(); },
      () => { toast('Position refusée ou indisponible.'); F.near = null; schedule(); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  function viewLieux(){
    const nIdeas = placesOf(null).length;
    const head = h('div', { class: 'spread' },
      h('div', null, h('div', { class: 'eyebrow' }, lieux().length + ' lieu' + (lieux().length > 1 ? 'x' : '') + ' · ' + lieux().filter(l => statusOf(l) === 'vecu').length + ' vécu' + (lieux().filter(l => statusOf(l) === 'vecu').length > 1 ? 's' : '')), h('h2', null, 'Lieux')),
      h('div', { class: 'seg-row', role: 'tablist' },
        h('button', { class: 'seg' + (F.mode === 'lib' ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(F.mode === 'lib'), onclick: () => { F.mode = 'lib'; keepF(); M.sig = ''; renderAll(); } }, 'Bibliothèque'),
        h('button', { class: 'seg' + (F.mode === 'idees' ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(F.mode === 'idees'), onclick: () => { F.mode = 'idees'; keepF(); renderAll(); } }, 'Idées du voyage' + (nIdeas ? ' · ' + nIdeas : ''))));
    if (F.mode === 'idees') return [head, ...viewIdeas()];
    return [
      head,
      h('div', { class: 'row' }, captureButtons(), h('button', { class: 'btn', type: 'button', onclick: () => openPlaceForm({ asLieu: true }) }, '＋ Repérer un lieu'),
        h('button', { class: 'btn', type: 'button', onclick: openScanner }, '⌗ Scanner une carte')),
      h('div', { class: 'split' },
        h('div', { class: 'map-col' }, mapPanel()),
        h('div', null, filterBar(), h('div', { class: 'panel', id: 'lieux-list' }, listBody()))),
    ];
  }
  function listBody(){
    const list = filtered();
    return list.length ? h('div', { class: 'llist' }, list.map(lieuRow)) :
      h('div', { class: 'empty' }, h('h3', null, lieux().length ? 'Aucun lieu pour ces critères' : 'Ta bibliothèque est vide'),
        h('span', null, lieux().length ? 'Élargis la recherche, les filtres ou le rayon.' : 'Repère un lieu vu dans un livre ou sur Instagram, ou capture sur place un endroit qui vaut l’arrêt : il te suivra d’un voyage à l’autre.'));
  }
  function updateLibMap(){
    if (F.mode !== 'lib'){ mapTools([]); return; }
    mapTools([h('button', { class: 'btn', type: 'button', onclick: () => startPlacing('Touche la carte pour placer le lieu repéré', c => openPlaceForm({ asLieu: true, lat: c.lat, lng: c.lng, coordSource: 'carte' })) }, '＋ Lieu')]);
    if (!M.ready) return;
    const E = M.eng; E.clear(); E.lines([]);
    const list = filtered().filter(hasPos);
    if (!M.placing) M.banner.hidden = true;
    for (const l of list) E.marker(markerEl('lieu k-' + kindKey(l.kind) + (statusOf(l) === 'vecu' ? ' vecu' : ''), kindIcon(kindKey(l.kind)), () => openLieu(l.id), l.name), l);
    if (F.near) E.marker(h('div', { class: 'me-dot' }), F.near);
    const sig = M.kind + '|lieux|' + list.map(l => l.id).join(',') + '|' + (F.near ? F.near.lat : '');
    if (sig !== M.sig){ const fit = list.map(l => [l.lng, l.lat]); if (F.near) fit.push([F.near.lng, F.near.lat]); if (fit.length) E.fit(fit, 16, false); M.sig = sig; }
    requestAnimationFrame(() => M.eng && M.eng.resize());
  }

  /* ---------- capture sur place ---------- */
  // Boussole : orientation absolue du téléphone si le navigateur la donne (Android : deviceorientationabsolute ; iPhone : webkitCompassHeading après autorisation).
  function readHeading(ms = 1500){
    return new Promise(res => {
      let done = false, last = null;
      const fin = () => { if (done) return; done = true; window.removeEventListener('deviceorientationabsolute', on); window.removeEventListener('deviceorientation', on); res(last); };
      const on = e => { if (typeof e.webkitCompassHeading === 'number') last = Math.round(e.webkitCompassHeading); else if (e.absolute && typeof e.alpha === 'number') last = Math.round((360 - e.alpha) % 360); };
      const go = () => { window.addEventListener('deviceorientationabsolute', on); window.addEventListener('deviceorientation', on); setTimeout(fin, ms); };
      try {
        if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then(r => r === 'granted' ? go() : fin()).catch(fin);
        else if (window.DeviceOrientationEvent) go(); else fin();
      } catch { fin(); }
    });
  }
  const getPos = () => new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy || 0) }), () => res(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
  });
  function captureButtons(){
    const inp = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: () => { const f = inp.files[0]; inp.value = ''; if (f) capture(f, pending); } });
    let pending = null;
    const start = () => { pending = { pos: getPos(), heading: readHeading(), at: new Date() }; };
    return h('span', { class: 'row', style: 'gap:6px' }, inp,
      h('button', { class: 'btn primary', type: 'button', onclick: () => { start(); inp.click(); } }, '📷 Capturer'),
      h('button', { class: 'btn', type: 'button', title: 'Enregistrer l’endroit où tu es, sans photo', onclick: () => { start(); capture(null, pending); } }, 'Sans photo'));
  }
  async function capture(file, ctx){
    ctx = ctx || { pos: getPos(), heading: readHeading(), at: new Date() };
    const at = ctx.at.toISOString(); const date = isoDay(ctx.at); const time = fmtTime(at);
    toast(file ? 'Photo reçue, enregistrement…' : 'Position en cours…');
    const ex = file ? await readExif(file) : {};
    const [pos, heading] = await Promise.all([ctx.pos, ctx.heading]);
    const where = ex.gps || pos;
    const l = await createLieu({ name: 'Lieu du ' + fmtDay(date, { day: 'numeric', month: 'short' }) + ' ' + time, kind: file ? 'photo' : 'visite', toIdentify: true,
      lat: where ? where.lat : null, lng: where ? where.lng : null, coordSource: where ? 'gps' : null, heading: heading != null ? heading : null,
      pin: pos ? { ...pos, at } : null, moments: [momentOf(time)].filter(Boolean), seasons: [] });
    const inTrip = tripDays().includes(date);
    let step = null;
    if (inTrip){
      step = await save({ id: uid(), type: 'place', name: l.name, kind: l.kind, day: date, time, lat: l.lat, lng: l.lng, coordSource: l.coordSource, status: 'visited', visitedAt: at, visitedBy: meName(),
        addedDuring: true, order: nextOrder(date), lieuId: l.id, createdBy: meName(), createdAt: at });
    }
    const v = await createVisite(l.id, { date, time, stepId: step ? step.id : null });
    if (file){
      try {
        const m = await addMediaFile(file, { role: 'photo', lieuId: l.id, visiteId: v.id, placeId: step ? step.id : null, day: inTrip ? date : null }, ex);
        await save({ id: l.id, refPhoto: m.id }); await save({ id: v.id, photo: m.id });
      } catch (e){ console.warn(e); toast('Photo non enregistrée : ' + (e.message || e)); }
    }
    if (!where) toast('Position indisponible : place le lieu sur la carte depuis sa fiche.');
    schedule();
    openQuick(l.id, v.id);
  }
  // Après une capture : tout est facultatif (nom, catégorie, avis, phrase) ; doublon proposé si un lieu existe à moins de 50 m.
  function openQuick(code, vid){
    const st = { names: null, loading: false, err: null, v: { name: '', kind: null, phrase: '', verdict: null } };
    openSheet(close => {
      const l = live(code), v = live(vid); if (!l || !v) return null;
      if (st.v.kind == null) st.v.kind = l.kind;
      const dups = hasPos(l) ? near(l, 50, l.id) : [];
      const finish = async () => {
        const nm = st.v.name.trim();
        const pl = { id: l.id, kind: st.v.kind || l.kind }; if (nm){ pl.name = nm; pl.toIdentify = false; }
        await save(pl);
        if (st.v.phrase.trim() || st.v.verdict) await save({ id: v.id, phrase: st.v.phrase.trim() || null, verdict: st.v.verdict || null });
        const step = v.stepId && live(v.stepId); if (step) await save({ id: step.id, name: nm || step.name, kind: st.v.kind || step.kind, toIdentify: !nm && !!l.toIdentify });
        toast('Lieu enregistré · ' + l.id); close();
      };
      return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lieu capturé' },
        sheetHead('Lieu capturé', close),
        h('div', { class: 'sec' },
          h('div', { class: 'row small muted' }, h('span', { class: 'mono' }, l.id), hasPos(l) ? '· position enregistrée' + (l.pin && l.pin.acc ? ' (± ' + l.pin.acc + ' m)' : '') : '· sans position', l.heading != null ? '· regard vers ' + dirLabel(l.heading) : null),
          dups.length ? h('div', { class: 'banner warn' }, 'Tu es à ' + fmtDist(dups[0].d) + ' de « ' + dups[0].l.name + ' », déjà dans ta bibliothèque. ',
            h('button', { class: 'btn small', type: 'button', onclick: async () => { const into = dups[0].l; await merge(l.id, into.id); close(); openLieu(into.id); } }, 'C’est le même lieu')) : null,
          h('label', { class: 'f' }, 'Nom (facultatif)', h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('input', { type: 'text', id: 'lq-name', placeholder: 'Ex. ruelle des lanternes', value: st.v.name, style: 'flex:1', oninput: e => { st.v.name = e.target.value; } }),
            hasPos(l) ? h('button', { class: 'btn', type: 'button', disabled: !S.online ? true : null, onclick: async () => {
              st.loading = true; st.err = null; S.sheet.render();
              try { st.names = await nearbyNames({ lat: l.lat, lng: l.lng, acc: l.pin && l.pin.acc }); } catch { st.err = 'Recherche indisponible.'; }
              st.loading = false; S.sheet && S.sheet.render(); } }, 'Lieux proches') : null)),
          st.loading ? h('div', { class: 'row small muted' }, h('span', { class: 'spin' }), 'Recherche…') : null,
          st.err ? h('div', { class: 'small warn-t' }, st.err) : null,
          st.names && st.names.length ? h('div', { class: 'results' }, st.names.slice(0, 8).map(r => h('button', { type: 'button', onclick: () => { st.v.name = r.name; st.v.kind = r.kind || st.v.kind; st.names = null; save({ id: l.id, address: r.address || null, city: r.city || null, mapsUrl: r.mapsUrl || null }); S.sheet.render(); } },
            h('strong', null, r.name), h('div', { class: 'muted small' }, (r.d != null ? r.d + ' m' : '') + (r.address ? ' · ' + r.address : ''))))) : null,
          h('div', { class: 'f' }, 'Catégorie', h('div', { class: 'row' }, ['photo', 'vue', 'facade', 'ambiance', 'temple', 'parc', 'cafe', 'resto', 'visite'].map(k =>
            h('button', { class: 'chip k-' + k + (st.v.kind === k ? ' on' : ''), type: 'button', 'aria-pressed': String(st.v.kind === k), onclick: () => { st.v.kind = k; S.sheet.render(); } }, kindIcon(k), KINDS[k])))),
          h('div', { class: 'f' }, 'Ton avis', h('div', { class: 'row' }, Object.entries(VERDICT).map(([k, [m, t]]) =>
            h('button', { class: 'btn vd-' + k + (st.v.verdict === k ? ' on' : ''), type: 'button', 'aria-pressed': String(st.v.verdict === k), onclick: () => { st.v.verdict = st.v.verdict === k ? null : k; S.sheet.render(); } }, m + ' ' + t)))),
          h('label', { class: 'f' }, 'La petite phrase (pour la carte postale)', h('textarea', { id: 'lq-phrase', rows: '2', placeholder: 'Ce qu’on veut se rappeler…', oninput: e => { st.v.phrase = e.target.value; } }, st.v.phrase)),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: finish }, 'Enregistrer'),
            h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Plus tard'))),
        h('div', { style: 'height:8px' }));
    });
  }
  // Création depuis le formulaire « Repérer un lieu » (formulaire des étapes en mode bibliothèque).
  async function createFromForm(v, coords, extra){
    const l = await createLieu({ name: v.name, kind: v.kind || 'visite', city: v.city || null, address: v.address || null, note: v.note || null,
      lat: coords ? coords.lat : null, lng: coords ? coords.lng : null, coordSource: coords ? coords.coordSource : null, mapsUrl: extra.mapsUrl || null, googlePlaceId: extra.gid || null,
      source: v.source ? { url: /^https?:\/\//.test(v.source) ? v.source : null, text: /^https?:\/\//.test(v.source) ? null : v.source, at: new Date().toISOString() } : null, by: v.by || meName() });
    if (v.lived) await createVisite(l.id, { date: v.livedDate || todayIso() });
    toast((v.lived ? 'Lieu vécu ajouté · ' : 'Lieu repéré · ') + l.id);
    return l;
  }
  const dupsAt = c => c && num(c.lat) != null ? near(c, 50) : [];

  /* ---------- fiche d'un lieu ---------- */
  function openLieu(input, focusVid){
    const r = typeof input === 'string' && !input.startsWith('TB-') ? null : resolve(typeof input === 'string' ? input : input);
    const code = r ? r.lieu.id : input;
    if (!live(code)){ toast('Lieu introuvable dans ce carnet.'); return; }
    let confirmDel = false, mergeOpen = false, editV = r && r.visite ? r.visite.id : focusVid || null;
    openSheet(close => {
      const l = live(code); if (!l || l.mergedInto) return null;
      const vs = visitesOf(code); const ph = photosOf(code); const ref = refPhoto(l); const vd = verdictOf(l);
      const steps = all('place').filter(p => p.lieuId === code);
      const img = ref ? h('img', { class: 'lhero', alt: l.name, src: ref.thumb || '' }) : null;
      if (ref) mediaUrl(ref, true).then(u => { if (u && img) img.src = u; }).catch(() => {});
      const days = tripDays();
      const candidates = hasPos(l) ? near(l, 200, l.id) : [];
      return h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': l.name },
        sheetHead(l.name, close),
        img ? h('div', { class: 'sec', style: 'padding-top:0' }, img) : null,
        h('div', { class: 'sec' },
          l.nameJa || l.nameKana ? h('div', { class: 'ljp' }, l.nameJa ? h('span', { lang: 'ja' }, l.nameJa) : null, l.nameKana ? h('span', { class: 'muted small' }, ' ' + l.nameKana) : null) : null,
          h('div', { class: 'row' }, kindChip(l.kind), statusChip(l), verdictChip(vd), l.detour ? h('span', { class: 'chip' }, DETOUR[l.detour]) : null,
            l.private ? h('span', { class: 'chip' }, '🔒 privé') : null, h('span', { class: 'chip mono', title: 'Code permanent du lieu' }, l.id)),
          l.toIdentify ? h('div', { class: 'banner warn small' }, 'Lieu capturé sans nom : donne-lui un nom dans « Modifier ».') : null,
          (l.seasons || []).length || (l.moments || []).length || l.heading != null ? h('div', { class: 'row small' },
            (l.seasons || []).map(s => h('span', { class: 'chip' }, SEASONS[s])), (l.moments || []).map(m => h('span', { class: 'chip' }, MOMENTS[m])),
            l.heading != null ? h('span', { class: 'chip', title: 'Direction du regard' }, h('span', { class: 'dir', style: '--a:' + l.heading + 'deg' }, '↑'), ' ' + dirLabel(l.heading)) : null) : null,
          (l.tags || []).length ? h('div', { class: 'row small' }, l.tags.map(t => h('span', { class: 'chip' }, '#' + t))) : null,
          l.access ? h('div', { class: 'small' }, h('b', null, 'Accès · '), l.access) : null,
          l.note ? h('div', { class: 'muted' }, l.note) : null,
          l.source && (l.source.url || l.source.text || l.source.mediaId) ? h('div', { class: 'small src' }, h('b', null, 'Source · '),
            l.source.url ? h('a', { href: l.source.url, target: '_blank', rel: 'noopener' }, (() => { try { return new URL(l.source.url).hostname.replace(/^www\./, ''); } catch { return l.source.url; } })()) : null,
            l.source.text ? h('span', null, (l.source.url ? ' · ' : '') + l.source.text) : null,
            l.source.at ? h('span', { class: 'muted' }, ' · ' + fmtDay(isoDay(new Date(l.source.at)), { day: 'numeric', month: 'short', year: 'numeric' })) : null,
            l.source.mediaId && live(l.source.mediaId) ? h('div', { style: 'margin-top:6px' }, thumbs([live(l.source.mediaId)])) : null) : null,
          h('div', { class: 'muted small' }, 'Ajouté par ' + (l.by || '?') + (l.createdAt ? ' le ' + fmtDay(isoDay(new Date(l.createdAt)), { day: 'numeric', month: 'short', year: 'numeric' }) : '')),
          h('div', { class: 'row' },
            days.length ? h('select', { id: 'lp-day', 'aria-label': 'Ajouter à une journée', style: 'width:auto;max-width:190px', onchange: async e => { const d = e.target.value; if (!d) return; e.target.blur(); await stepFromLieu(l, d); } },
              h('option', { value: '' }, 'Ajouter à une journée…'), days.map(d => h('option', { value: d }, fmtDay(d)))) : null,
            h('button', { class: 'btn', type: 'button', onclick: async () => { const v = await createVisite(code, { time: fmtTime(new Date().toISOString()) }); editV = v.id; S.sheet.render(); } }, '＋ Visite'),
            hasPos(l) || l.address ? h('a', { class: 'btn', href: placeUrl(l), target: '_blank', rel: 'noopener' }, 'Google Maps') : null,
            addrButton ? addrButton(l) : null,
            hasPos(l) ? h('button', { class: 'btn', type: 'button', onclick: () => { close(); if (S.view !== 'lieux'){ S.view = 'lieux'; F.mode = 'lib'; renderAll(); } setTimeout(() => { M.eng && M.eng.fly(l, 17); M.el && M.el.scrollIntoView({ block: 'center' }); }, 60); } }, 'Voir sur la carte') : null)),
        h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, vs.length ? vs.length + ' visite' + (vs.length > 1 ? 's' : '') : 'Pas encore de visite'),
          vs.map(v => visiteBlock(l, v, editV === v.id, () => { editV = editV === v.id ? null : v.id; S.sheet.render(); })),
          !vs.length ? h('div', { class: 'muted small' }, 'Lieu repéré. Quand tu y passes, ajoute une visite (ou tamponne l’étape liée dans la journée) : il deviendra « vécu ».') : null),
        ph.length ? h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Toutes les photos · touche ☆ pour la photo de référence'),
          h('div', { class: 'thumbs' }, ph.map(m => { const im = h('img', { alt: '', loading: 'lazy', src: m.thumb || '' });
            return h('div', { class: 'th-wrap' }, h('button', { class: 'th', type: 'button', onclick: () => X.openPhoto(m.id) }, im),
              h('button', { class: 'ref' + ((ref && ref.id === m.id) ? ' on' : ''), type: 'button', 'aria-label': 'Photo de référence', onclick: () => save({ id: code, refPhoto: m.id }, 'Photo de référence choisie') }, (ref && ref.id === m.id) ? '★' : '☆')); }))) : null,
        steps.length ? h('div', { class: 'sec' }, h('div', { class: 'eyebrow' }, 'Étapes liées'), steps.map(p => h('button', { class: 'doc', type: 'button', onclick: () => { close(); openPlace(p.id); } }, h('span', null, (p.day ? fmtDay(p.day) : 'Idée') + ' · ' + p.name)))) : null,
        candidates.length ? h('div', { class: 'sec' }, h('details', { open: mergeOpen ? true : null, ontoggle: e => { mergeOpen = e.target.open; } },
          h('summary', { class: 'small', style: 'cursor:pointer' }, 'Doublon ? ' + candidates.length + ' lieu' + (candidates.length > 1 ? 'x' : '') + ' à moins de 200 m'),
          candidates.map(({ l: o, d }) => h('div', { class: 'frow' }, h('span', { class: 'grow' }, o.name, h('span', { class: 'muted small' }, ' · ' + fmtDist(d) + ' · ' + o.id)),
            h('button', { class: 'btn small', type: 'button', onclick: async () => { await merge(o.id, code); S.sheet.render(); } }, 'Absorber ici'))),
          h('div', { class: 'muted small' }, 'Les visites, photos et étapes du lieu absorbé passent ici ; son code reste lisible par le scanner.'))) : null,
        h('details', { class: 'sec' }, h('summary', { class: 'eyebrow', style: 'cursor:pointer;padding-block:4px' }, 'Modifier le lieu'), editForm(l),
          h('div', { class: 'row', style: 'margin-top:8px' }, confirmDel ? [h('span', { class: 'muted' }, 'Supprimer ce lieu et ses visites ?'),
            h('button', { class: 'btn danger', type: 'button', onclick: async () => { close(); for (const v of vs) await save({ id: v.id, deleted: true }); for (const p of steps) await save({ id: p.id, lieuId: null }); await save({ id: code, deleted: true }, 'Lieu supprimé'); } }, 'Confirmer'),
            h('button', { class: 'btn', type: 'button', onclick: () => { confirmDel = false; S.sheet.render(); } }, 'Annuler')]
            : h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmDel = true; S.sheet.render(); } }, 'Supprimer le lieu'))),
        h('div', { style: 'height:8px' }));
    });
  }
  function visiteBlock(l, v, editing, toggle){
    const ph = all('media').filter(m => m.visiteId === v.id && m.role === 'photo');
    const label = 'Visite ' + v.n + ' · ' + (v.date ? fmtDay(v.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '?') + (v.time ? ' ' + v.time : '');
    return h('div', { class: 'visite' },
      h('div', { class: 'spread' }, h('div', null, h('b', null, label), h('span', { class: 'muted small' }, ' · ' + (SEASONS[v.season] || '') + (v.by ? ' · ' + v.by : ''))),
        h('div', { class: 'row' }, verdictChip(v.verdict),
          !l.private ? h('button', { class: 'btn small primary', type: 'button', onclick: () => openPostcard(l.id, v.id) }, 'Carte postale') : null,
          h('button', { class: 'btn small ghost', type: 'button', 'aria-expanded': String(editing), onclick: toggle }, editing ? 'Fermer' : 'Modifier'))),
      v.phrase ? h('div', { class: 'phrase' }, '« ' + v.phrase + ' »') : null,
      ph.length ? thumbs(ph) : null,
      v.printedAt ? h('div', { class: 'muted small' }, 'Carte postale imprimée · code ' + l.id + '/' + v.n) : null,
      editing ? (() => {
        const f = h('form', { class: 'form', style: 'padding:6px 0 0', onsubmit: async e => {
          e.preventDefault(); const fd = new FormData(f); document.activeElement && document.activeElement.blur();
          const date = fd.get('date') || v.date;
          await save({ id: v.id, date, time: fd.get('time') || null, season: fd.get('season') || seasonOf(date), verdict: fd.get('verdict') || null, phrase: String(fd.get('phrase') || '').trim() || null, by: String(fd.get('by') || '').trim() || v.by }, 'Visite enregistrée');
        } },
          h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Date', h('input', { type: 'date', name: 'date', id: 'vf-date-' + v.id, value: v.date || '' })), h('label', { class: 'f' }, 'Heure', h('input', { type: 'time', name: 'time', id: 'vf-time-' + v.id, value: v.time || '' }))),
          h('div', { class: 'grid2' },
            h('label', { class: 'f' }, 'Saison', h('select', { name: 'season', id: 'vf-season-' + v.id }, Object.entries(SEASONS).map(([k, t]) => h('option', { value: k, selected: k === v.season ? true : null }, t)))),
            h('label', { class: 'f' }, 'Avis', h('select', { name: 'verdict', id: 'vf-vd-' + v.id }, h('option', { value: '' }, '—'), Object.entries(VERDICT).map(([k, [m, t]]) => h('option', { value: k, selected: k === v.verdict ? true : null }, m + ' ' + t))))),
          h('label', { class: 'f' }, 'La petite phrase', h('textarea', { name: 'phrase', id: 'vf-phrase-' + v.id, rows: '2' }, v.phrase || '')),
          h('label', { class: 'f' }, 'Par', h('input', { type: 'text', name: 'by', id: 'vf-by-' + v.id, value: v.by || '', list: 'tabi-names' })), namesList(),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer'),
            h('button', { class: 'btn danger ghost', type: 'button', onclick: () => save({ id: v.id, deleted: true }, 'Visite supprimée') }, 'Supprimer la visite')),
          uploadButton('Ajouter des photos de cette visite', 'image/*', { role: 'photo', lieuId: l.id, visiteId: v.id, day: tripDays().includes(v.date) ? v.date : null, placeId: v.stepId || null }, true));
        return f; })() : null);
  }
  const namesList = () => h('datalist', { id: 'tabi-names' }, knownNames().map(n => h('option', { value: n })));
  function editForm(l){
    const st = { heading: l.heading ?? null };
    const f = h('form', { class: 'form', style: 'padding:0', onsubmit: async e => {
      e.preventDefault(); const fd = new FormData(f); document.activeElement && document.activeElement.blur();
      const s = k => String(fd.get(k) || '').trim() || null;
      const srcUrl = s('srcUrl'), srcText = s('srcText');
      const upd = { id: l.id, name: s('name') || l.name, nameJa: s('nameJa'), nameKana: s('nameKana'), kind: fd.get('kind'), city: s('city'), country: s('country'), address: s('address'), addressJa: s('addressJa'),
        seasons: fd.getAll('seasons'), moments: fd.getAll('moments'), detour: fd.get('detour') || null, tags: (s('tags') || '').split(/[,#]/).map(t => t.trim().toLowerCase()).filter(Boolean),
        access: s('access'), note: s('note'), verdict: fd.get('verdict') || null, private: fd.get('private') === 'on', by: s('by') || l.by, heading: st.heading, toIdentify: s('name') && s('name') !== l.name ? false : l.toIdentify };
      if (srcUrl !== ((l.source || {}).url || null) || srcText !== ((l.source || {}).text || null)) upd.source = { ...(l.source || {}), url: srcUrl, text: srcText, at: (l.source && l.source.at) || new Date().toISOString() };
      const link = s('link'); const c = link ? X.parseCoords(link) : null;
      if (link !== (l.mapsUrl || null)){ upd.mapsUrl = link && /^https?:\/\//.test(link) ? link : null; if (c) Object.assign(upd, { lat: c.lat, lng: c.lng, coordSource: /^https?:/.test(link) ? 'lien' : 'saisie' }); }
      await save(upd, 'Lieu enregistré');
    } },
      h('label', { class: 'f' }, 'Nom', h('input', { type: 'text', name: 'name', id: 'le-name', value: l.toIdentify ? '' : l.name, placeholder: l.name })),
      h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Nom local', h('input', { type: 'text', name: 'nameJa', id: 'le-nameja', lang: 'ja', value: l.nameJa || '', placeholder: '伏見稲荷大社' })),
        h('label', { class: 'f' }, 'Lecture', h('input', { type: 'text', name: 'nameKana', id: 'le-kana', value: l.nameKana || '', placeholder: 'Fushimi Inari Taisha' }))),
      h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Catégorie', h('select', { name: 'kind', id: 'le-kind' }, Object.entries(KINDS).map(([k, t]) => h('option', { value: k, selected: k === l.kind ? true : null }, t)))),
        h('label', { class: 'f' }, 'Vaut-il le détour ?', h('select', { name: 'detour', id: 'le-detour' }, h('option', { value: '' }, '—'), Object.entries(DETOUR).map(([k, t]) => h('option', { value: k, selected: k === l.detour ? true : null }, t))))),
      h('div', { class: 'f' }, 'Meilleures saisons', h('div', { class: 'row' }, Object.entries(SEASONS).map(([k, t]) => h('label', { class: 'ck' }, h('input', { type: 'checkbox', name: 'seasons', value: k, checked: (l.seasons || []).includes(k) }), t)))),
      h('div', { class: 'f' }, 'Meilleurs moments', h('div', { class: 'row' }, Object.entries(MOMENTS).map(([k, t]) => h('label', { class: 'ck' }, h('input', { type: 'checkbox', name: 'moments', value: k, checked: (l.moments || []).includes(k) }), t)))),
      h('div', { class: 'f' }, 'Direction du regard (d’où l’on regarde, vers où)', h('div', { class: 'row dirs' },
        DIRS.map(([t, a]) => h('button', { class: 'btn small' + (st.heading != null && dirLabel(st.heading) === t ? ' on' : ''), type: 'button', onclick: e => { st.heading = a; e.currentTarget.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); } }, t)),
        h('button', { class: 'btn small', type: 'button', onclick: async e => { const b = e.currentTarget; b.textContent = 'Boussole…'; const hd = await readHeading(1500); b.textContent = hd != null ? 'Téléphone : ' + dirLabel(hd) : 'Boussole indisponible'; if (hd != null) st.heading = hd; } }, 'Boussole du téléphone'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: e => { st.heading = null; e.currentTarget.parentNode.querySelectorAll('button').forEach(b => b.classList.remove('on')); } }, 'Aucune'))),
      h('label', { class: 'f' }, 'Étiquettes d’ambiance (séparées par des virgules)', h('input', { type: 'text', name: 'tags', id: 'le-tags', value: (l.tags || []).join(', '), placeholder: 'calme, néons, vue dégagée' })),
      h('label', { class: 'f' }, 'Accès', h('input', { type: 'text', name: 'access', id: 'le-access', value: l.access || '', placeholder: 'Escalier à gauche du konbini, 5e étage…' })),
      h('label', { class: 'f' }, 'Note', h('textarea', { name: 'note', id: 'le-note', rows: '2' }, l.note || '')),
      h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Ville / quartier', h('input', { type: 'text', name: 'city', id: 'le-city', value: l.city || '' })), h('label', { class: 'f' }, 'Pays', h('input', { type: 'text', name: 'country', id: 'le-country', value: l.country || '', placeholder: 'Japon' }))),
      h('label', { class: 'f' }, 'Adresse', h('input', { type: 'text', name: 'address', id: 'le-address', value: l.address || '' })),
      h('label', { class: 'f' }, 'Adresse en japonais', h('input', { type: 'text', name: 'addressJa', id: 'le-addrja', lang: 'ja', value: l.addressJa || '' })),
      h('label', { class: 'f' }, 'Lien Google Maps ou coordonnées', h('input', { type: 'text', name: 'link', id: 'le-link', value: l.mapsUrl || '' })),
      h('div', { class: 'muted small' }, hasPos(l) ? 'Position ' + l.lat.toFixed(5) + ', ' + l.lng.toFixed(5) + ' (' + (l.coordSource || '?') + ')' : 'Pas de position.',
        ' ', h('button', { class: 'btn small', type: 'button', onclick: () => startPlacing('Touche la carte pour placer « ' + l.name + ' »', c => save({ id: l.id, lat: c.lat, lng: c.lng, coordSource: 'carte' }, 'Position enregistrée')) }, 'Placer sur la carte')),
      h('div', { class: 'f' }, 'Source de l’idée (Instagram, site, livre…)',
        h('input', { type: 'url', name: 'srcUrl', id: 'le-srcurl', value: (l.source || {}).url || '', placeholder: 'https://www.instagram.com/p/…' }),
        h('input', { type: 'text', name: 'srcText', id: 'le-srctext', value: (l.source || {}).text || '', placeholder: 'Ce qui donnait envie (copie du texte)', style: 'margin-top:6px' }),
        h('div', { class: 'muted small' }, 'Une publication peut disparaître : garde aussi une capture d’écran.'),
        uploadButton((l.source || {}).mediaId ? 'Remplacer la capture d’écran' : 'Ajouter une capture d’écran', 'image/*', { role: 'capture', lieuId: l.id, onDone: m => save({ id: l.id, source: { ...(live(l.id).source || {}), mediaId: m.id, at: (live(l.id).source || {}).at || new Date().toISOString() } }) }, false)),
      h('div', { class: 'grid2' },
        h('label', { class: 'f' }, 'Avis global', h('select', { name: 'verdict', id: 'le-vd' }, h('option', { value: '' }, 'Celui de la dernière visite'), Object.entries(VERDICT).map(([k, [m, t]]) => h('option', { value: k, selected: k === l.verdict ? true : null }, m + ' ' + t)))),
        h('label', { class: 'f' }, 'Ajouté par', h('input', { type: 'text', name: 'by', id: 'le-by', value: l.by || '', list: 'tabi-names' }))), namesList(),
      h('label', { class: 'ck' }, h('input', { type: 'checkbox', name: 'private', id: 'le-private', checked: !!l.private }), ' Lieu privé (domicile, école, rendez-vous…) : jamais de carte postale, de QR code ni d’export'),
      h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer')));
    return f;
  }

  /* ---------- carte postale ---------- */
  const PC = { W: 1800, H: 1200 };
  let washiStyleP = null;
  // Fond de carte OpenFreeMap restylé « washi » : couleurs papier, sans étiquettes ni relief.
  function washiStyle(){
    if (washiStyleP) return washiStyleP;
    washiStyleP = fetch(CONFIG.mapStyle).then(r => r.json()).then(st => {
      const keep = [];
      for (const ly of st.layers || []){
        const id = (ly.id || '') + ' ' + (ly['source-layer'] || '');
        if (ly.type === 'symbol' || ly.type === 'fill-extrusion' || ly.type === 'hillshade' || ly.type === 'raster') continue;
        ly.paint = ly.paint || {};
        if (ly.type === 'background'){ ly.paint = { 'background-color': '#F4ECDD' }; keep.push(ly); continue; }
        if (ly.type === 'fill'){
          const c = /water|ocean|river|lake/.test(id) ? '#C9D9D8' : /park|wood|forest|grass|landcover|green|garden|cemetery/.test(id) ? '#DCE0C6' : /building/.test(id) ? '#E8DCCB' : null;
          if (!c) continue;
          ly.paint = { 'fill-color': c, 'fill-opacity': 1 }; keep.push(ly); continue;
        }
        if (ly.type === 'line'){
          if (/water|river|stream|canal/.test(id)){ ly.paint = { 'line-color': '#C9D9D8', 'line-width': ly.paint['line-width'] || 1.5 }; keep.push(ly); continue; }
          if (/rail|transit/.test(id)){ ly.paint = { 'line-color': '#B9A98F', 'line-width': 1.2, 'line-dasharray': [3, 2] }; keep.push(ly); continue; }
          if (/road|highway|street|path|bridge|tunnel|transportation/.test(id)){ ly.paint = { 'line-color': /casing/.test(id) ? '#E3D5BE' : '#FFFDF8', 'line-width': ly.paint['line-width'] || 1.2, 'line-opacity': 1 }; keep.push(ly); continue; }
          continue;
        }
      }
      st.layers = keep; delete st.terrain; delete st.sky;
      return st;
    }).catch(e => { washiStyleP = null; throw e; });
    return washiStyleP;
  }
  async function miniMap(lat, lng, px){
    if (!window.maplibregl) throw new Error('carte');
    const style = await washiStyle();
    const box = h('div', { style: `position:fixed;left:-4000px;top:0;width:${px / 2}px;height:${px / 2}px;pointer-events:none` });
    document.body.append(box);
    let map;
    try {
      map = new maplibregl.Map({ container: box, style, center: [lng, lat], zoom: 15.3, interactive: false, attributionControl: false, preserveDrawingBuffer: true, pixelRatio: 2, fadeDuration: 0 });
      await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('délai')), 9000); map.once('idle', () => { clearTimeout(t); res(); }); map.on('error', () => {}); });
      const c = map.getCanvas(); const out = document.createElement('canvas'); out.width = px; out.height = px; out.getContext('2d').drawImage(c, 0, 0, px, px);
      return out;
    } finally { try { map && map.remove(); } catch {} box.remove(); }
  }
  async function qrCanvas(text, px){
    await loadScript('vendor/qrcode.js');
    const q = window.qrcode(0, 'M'); q.addData(text); q.make();
    const n = q.getModuleCount(), quiet = 2, cell = Math.floor(px / (n + quiet * 2)), size = cell * (n + quiet * 2);
    const c = document.createElement('canvas'); c.width = size; c.height = size; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#1F1A14';
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + quiet) * cell, (r + quiet) * cell, cell, cell);
    return c;
  }
  async function loadPhoto(m){ const u = await mediaUrl(m, true) || m.thumb; if (!u) return null; return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = u; }); }
  function cover(g, img, x, y, w, hh){
    const s = Math.max(w / img.width, hh / img.height); const sw = w / s, sh = hh / s;
    g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, hh);
  }
  function wrap(g, text, maxW, maxLines){
    const words = String(text || '').split(/\s+/).filter(Boolean); const lines = []; let cur = '';
    for (const w of words){ const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; } }
    if (cur) lines.push(cur);
    if (lines.length > maxLines){ const l = lines.slice(0, maxLines); let last = l[maxLines - 1]; while (last.length > 1 && g.measureText(last + '…').width > maxW) last = last.slice(0, -1); l[maxLines - 1] = last + '…'; return l; }
    return lines;
  }
  function fit(g, text, font, size, maxW, min){ let s = size; g.font = font.replace('{s}', s); while (s > min && g.measureText(text).width > maxW){ s -= 2; g.font = font.replace('{s}', s); } return s; }
  function kindGlyph(g, kind, x, y, s, color){
    const paths = (X.KIND_ICONS[kind] || X.KIND_ICONS.autre);
    g.save(); g.translate(x, y); g.scale(s / 24, s / 24); g.strokeStyle = color; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round';
    if (kind === 'onsen'){ g.fillStyle = color; g.font = '20px serif'; g.fillText('♨', 2, 20); }
    else for (const d of paths) g.stroke(new Path2D(d));
    g.restore();
  }
  function pinOn(g, cx, cy, r){
    g.save(); g.fillStyle = '#B23A2A'; g.strokeStyle = '#fff'; g.lineWidth = r * 0.22;
    g.beginPath(); g.arc(cx, cy - r * 1.4, r, Math.PI * 0.8, Math.PI * 2.2); g.lineTo(cx, cy); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy - r * 1.4, r * 0.38, 0, Math.PI * 2); g.fill(); g.restore();
  }
  function seal(g, x, y, s){
    g.save(); g.translate(x + s / 2, y + s / 2); g.rotate(-0.08); g.fillStyle = 'rgba(178,58,42,.92)';
    const r = s * 0.12, a = -s / 2; g.beginPath(); g.moveTo(a + r, a); g.arcTo(-a, a, -a, -a, r); g.arcTo(-a, -a, a, -a, r); g.arcTo(a, -a, a, a, r); g.arcTo(a, a, -a, a, r); g.fill();
    g.fillStyle = '#FBF5EA'; g.font = `700 ${Math.round(s * 0.62)}px "Shippori Mincho", serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('旅', 0, s * 0.03); g.restore();
  }
  async function renderCard(o){
    const portrait = o.orient === 'portrait'; const W = portrait ? PC.H : PC.W, H = portrait ? PC.W : PC.H;
    try { await Promise.all(['700 64px "Shippori Mincho"', '500 40px "Shippori Mincho"', '500 30px "JetBrains Mono"', '700 30px "Zen Kaku Gothic New"'].map(f => document.fonts.load(f))); } catch {}
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    const paper = '#F5EFE4', ink = '#2A231B', soft = '#7A6E5E', red = '#B23A2A';
    g.fillStyle = paper; g.fillRect(0, 0, W, H);
    // grain léger du papier
    g.save(); g.globalAlpha = 0.05; for (let k = 0; k < 2200; k++){ g.fillStyle = k % 2 ? '#000' : '#8a6d3b'; g.fillRect((k * 7919) % W, (k * 104729) % H, 2, 2); } g.restore();
    const img = o.photo ? await loadPhoto(o.photo) : null;
    // Gabarits : zone photo, colonne de texte (x, largeur), lignes de base des textes, mini-carte ronde, QR code.
    let photoBox, tx, tw, Y, mapC, qrBox;
    if (o.tpl === 'carnet' && !portrait){ photoBox = [60, 60, 1080, H - 120]; tx = 1200; tw = W - 1260; mapC = { x: 1200 + (W - 1260) / 2, y: 290, r: 190 }; qrBox = { x: W - 60 - 190, y: H - 60 - 190 - 40, s: 190 };
      Y = { kind: 560, name: 634, meta: 694, phrase: 766, lh: 50, lines: 3 }; }
    else if (o.tpl === 'carnet'){ photoBox = [70, 70, W - 140, 1020]; tx = 70; tw = W - 140; mapC = { x: W - 70 - 165, y: 1300, r: 150 }; qrBox = { x: W - 70 - 180, y: H - 70 - 180 - 40, s: 180 };
      Y = { kind: 1190, name: 1264, meta: 1320, phrase: 1392, lh: 50, lines: 4 }; }
    else if (!portrait){ photoBox = [0, 0, W, 840]; tx = 64; tw = W - 128; mapC = { x: W - 64 - 220 - 56 - 160, y: 840, r: 160 }; qrBox = { x: W - 64 - 220, y: H - 56 - 220 - 34, s: 220 };
      Y = { kind: 922, name: 996, meta: 1050, phrase: 1110, lh: 46, lines: 2 }; }
    else { photoBox = [0, 0, W, 1240]; tx = 64; tw = W - 128; mapC = { x: W - 64 - 150, y: 1240, r: 150 }; qrBox = { x: W - 64 - 200, y: H - 64 - 200 - 38, s: 200 };
      Y = { kind: 1324, name: 1402, meta: 1458, phrase: 1532, lh: 52, lines: 4 }; }
    // photo
    if (img){ g.save(); if (o.tpl === 'carnet'){ g.shadowColor = 'rgba(0,0,0,.18)'; g.shadowBlur = 18; g.shadowOffsetY = 6; g.fillStyle = '#fff'; g.fillRect(...photoBox); g.shadowColor = 'transparent'; } cover(g, img, ...photoBox); g.restore(); }
    else { g.fillStyle = '#E7DCC8'; g.fillRect(...photoBox); kindGlyph(g, o.kind, photoBox[0] + photoBox[2] / 2 - 90, photoBox[1] + photoBox[3] / 2 - 90, 180, '#B8A98F'); }
    // mini-carte ronde avec l'épingle
    if (o.showMap && o.lat != null){
      const d = mapC.r * 2;
      let m = null; try { m = await miniMap(o.lat, o.lng, d); } catch (e){ console.warn('Tabi mini-carte', e); }
      g.save(); g.beginPath(); g.arc(mapC.x, mapC.y, mapC.r, 0, Math.PI * 2); g.closePath(); g.fillStyle = '#EFE6D5'; g.fill(); g.clip();
      if (m) g.drawImage(m, mapC.x - mapC.r, mapC.y - mapC.r, d, d);
      else { g.strokeStyle = '#D9CBB2'; g.lineWidth = 2; for (let k = -4; k <= 4; k++){ g.beginPath(); g.moveTo(mapC.x - mapC.r, mapC.y + k * mapC.r / 4); g.lineTo(mapC.x + mapC.r, mapC.y + k * mapC.r / 4); g.stroke(); g.beginPath(); g.moveTo(mapC.x + k * mapC.r / 4, mapC.y - mapC.r); g.lineTo(mapC.x + k * mapC.r / 4, mapC.y + mapC.r); g.stroke(); } }
      g.restore();
      g.save(); g.lineWidth = 10; g.strokeStyle = '#FBF7F0'; g.beginPath(); g.arc(mapC.x, mapC.y, mapC.r, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 2; g.strokeStyle = '#CDBEA4'; g.beginPath(); g.arc(mapC.x, mapC.y, mapC.r + 6, 0, Math.PI * 2); g.stroke(); g.restore();
      pinOn(g, mapC.x, mapC.y, mapC.r * 0.13);
      if (!m){ g.save(); g.fillStyle = soft; g.font = '500 22px "JetBrains Mono", monospace'; g.textAlign = 'center'; g.fillText(o.lat.toFixed(4) + ', ' + o.lng.toFixed(4), mapC.x, mapC.y + mapC.r * 0.55); g.restore(); }
    }
    // QR code + code en clair
    if (o.showQr){
      const q = await qrCanvas(o.code, qrBox.s);
      g.save(); g.fillStyle = '#fff'; g.fillRect(qrBox.x - 6, qrBox.y - 6, q.width + 12, q.height + 12); g.drawImage(q, qrBox.x, qrBox.y); g.restore();
      g.save(); g.fillStyle = soft; g.font = '500 26px "JetBrains Mono", monospace'; g.textAlign = 'center'; g.fillText(o.code, qrBox.x + q.width / 2, qrBox.y + q.height + 34); g.restore();
    }
    // textes : à gauche de la mini-carte (ou du QR code), sauf en colonne « carnet » paysage
    const hasMap = o.showMap && o.lat != null;
    const maxW = o.tpl === 'carnet' && !portrait ? tw : Math.min(tw, (hasMap ? mapC.x - mapC.r - 40 : o.showQr ? qrBox.x - 40 : tx + tw) - tx);
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    kindGlyph(g, o.kind, tx, Y.kind - 28, 32, red);
    g.fillStyle = red; g.font = '700 25px "Zen Kaku Gothic New", sans-serif'; g.fillText((KINDS[o.kind] || 'Lieu').toUpperCase(), tx + 44, Y.kind - 2);
    const font = '700 {s}px "Shippori Mincho", serif';
    fit(g, o.name, font, 64, maxW, 38); g.fillStyle = ink;
    const name1 = wrap(g, o.name, maxW, 1)[0] || ''; g.fillText(name1, tx, Y.name);
    let meta = [o.dateLabel, o.city].filter(Boolean).join(' · ');
    if (o.showJa && o.nameJa){
      const nw = g.measureText(name1).width; g.font = '500 34px "Shippori Mincho", serif';
      const ja = o.nameJa + (o.nameKana ? ' · ' + o.nameKana : '');
      if (nw + 28 + g.measureText(ja).width <= maxW){ g.fillStyle = soft; g.fillText(ja, tx + nw + 28, Y.name); }
      else meta = [o.nameJa, meta].filter(Boolean).join(' · ');
    }
    g.font = '500 27px "JetBrains Mono", monospace'; g.fillStyle = soft;
    g.fillText(wrap(g, meta, maxW - 58, 1)[0] || '', tx + 58, Y.meta);
    seal(g, tx, Y.meta - 33, 42);
    if (o.phrase){
      g.font = 'italic 500 ' + (Y.lh > 48 ? 40 : 37) + 'px "Shippori Mincho", serif'; g.fillStyle = ink;
      let y = Y.phrase; for (const ln of wrap(g, '« ' + o.phrase + ' »', maxW, Y.lines)){ g.fillText(ln, tx, y); y += Y.lh; }
    }
    return c;
  }
  function openPostcard(code, vid){
    const st = { tpl: LS.get('tabi.pcTpl') || 'plein', orient: 'paysage', photo: null, showQr: true, showMap: true, showJa: true, busy: false, url: null, blob: null, err: null, phrase: null, gen: 0 };
    const v0 = live(vid); if (!v0) return;
    st.phrase = v0.phrase || '';
    const pics = () => { const own = all('media').filter(m => m.visiteId === vid && m.role === 'photo'); return own.length ? own : photosOf(code); };
    st.photo = (v0.photo && live(v0.photo)) || pics()[0] || null;
    if (st.photo && st.photo.thumb){ const i = new Image(); i.onload = () => { if (i.height > i.width && st.orient === 'paysage'){ st.orient = 'portrait'; draw(); } }; i.src = st.photo.thumb; }
    async function draw(){
      const l = live(code), v = live(vid); if (!l || !v) return;
      if (l.private){ st.err = 'Lieu privé : pas de carte postale.'; S.sheet && S.sheet.render(); return; }
      const my = ++st.gen; st.busy = true; st.err = null; S.sheet && S.sheet.render();
      try {
        const c = await renderCard({ tpl: st.tpl, orient: st.orient, photo: st.photo, showQr: st.showQr, showMap: st.showMap, showJa: st.showJa, code: l.id + '/' + v.n, kind: kindKey(l.kind), name: l.toIdentify ? (l.name || '') : l.name, nameJa: l.nameJa, nameKana: l.nameKana,
          dateLabel: v.date ? fmtDay(v.date, { day: 'numeric', month: 'long', year: 'numeric' }) : '', city: [l.city, l.country].filter(Boolean).join(', '), phrase: st.phrase, lat: num(l.lat), lng: num(l.lng) });
        if (my !== st.gen) return;
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
        if (st.url) URL.revokeObjectURL(st.url);
        st.blob = blob; st.url = URL.createObjectURL(blob); st.w = c.width; st.h = c.height;
      } catch (e){ console.warn(e); st.err = 'Génération impossible : ' + (e.message || e); }
      st.busy = false; S.sheet && S.sheet.render();
    }
    const fname = () => { const l = live(code), v = live(vid); return 'carte_' + l.id + '-' + v.n + '.jpg'; };
    const markPrinted = () => save({ id: vid, printedAt: new Date().toISOString(), phrase: st.phrase.trim() || null, photo: st.photo ? st.photo.id : null });
    openSheet(close => {
      const l = live(code), v = live(vid); if (!l || !v) return null;
      const seg = (k, val, label) => h('button', { class: 'seg' + (st[k] === val ? ' on' : ''), type: 'button', onclick: () => { st[k] = val; if (k === 'tpl') LS.set('tabi.pcTpl', val); draw(); } }, label);
      const ps = pics();
      return h('div', { class: 'sheet wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Carte postale' },
        sheetHead('Carte postale · ' + l.name, close),
        h('div', { class: 'sec' },
          h('div', { class: 'pc-prev' + (st.busy ? ' busy' : '') }, st.url ? h('img', { src: st.url, alt: 'Aperçu de la carte postale', style: 'aspect-ratio:' + st.w + '/' + st.h }) : h('div', { class: 'muted small', style: 'padding:40px;text-align:center' }, st.busy ? 'Préparation…' : ''),
            st.busy ? h('span', { class: 'spin' }) : null),
          st.err ? h('div', { class: 'banner warn' }, st.err) : null,
          h('div', { class: 'row' }, h('div', { class: 'seg-row' }, seg('tpl', 'plein', 'Plein cadre'), seg('tpl', 'carnet', 'Carnet')),
            h('div', { class: 'seg-row' }, seg('orient', 'paysage', 'Paysage'), seg('orient', 'portrait', 'Portrait'))),
          ps.length > 1 ? h('div', { class: 'thumbs pick' }, ps.map(m => h('button', { class: 'th' + (st.photo && st.photo.id === m.id ? ' on' : ''), type: 'button', onclick: () => { st.photo = m; draw(); } }, h('img', { src: m.thumb || '', alt: '' })))) : null,
          !ps.length ? h('div', { class: 'muted small' }, 'Pas de photo pour cette visite : ajoute-en une depuis la fiche, ou garde la carte sans photo.') : null,
          h('label', { class: 'f' }, 'La petite phrase', h('div', { class: 'row', style: 'flex-wrap:nowrap' },
            h('input', { type: 'text', id: 'pc-phrase', value: st.phrase, maxlength: '140', style: 'flex:1', placeholder: 'Un souvenir, un mot…', oninput: e => { st.phrase = e.target.value; }, onkeydown: e => { if (e.key === 'Enter'){ e.preventDefault(); e.target.blur(); draw(); } } }),
            h('button', { class: 'btn', type: 'button', onclick: () => { document.activeElement && document.activeElement.blur(); draw(); } }, 'Appliquer'))),
          h('div', { class: 'row small' },
            h('label', { class: 'ck' }, h('input', { type: 'checkbox', checked: st.showMap, onchange: e => { st.showMap = e.target.checked; draw(); } }), ' Mini-carte'),
            h('label', { class: 'ck' }, h('input', { type: 'checkbox', checked: st.showQr, onchange: e => { st.showQr = e.target.checked; draw(); } }), ' QR code ' + l.id + '/' + v.n),
            l.nameJa ? h('label', { class: 'ck' }, h('input', { type: 'checkbox', checked: st.showJa, onchange: e => { st.showJa = e.target.checked; draw(); } }), ' Nom local') : null),
          h('div', { class: 'row' },
            h('a', { class: 'btn primary', href: st.url || '#', download: fname(), 'aria-disabled': String(!st.url), onclick: e => { if (!st.url){ e.preventDefault(); return; } markPrinted(); } }, 'Enregistrer l’image'),
            navigator.canShare ? h('button', { class: 'btn', type: 'button', disabled: !st.blob ? true : null, onclick: async () => {
              const file = new File([st.blob], fname(), { type: 'image/jpeg' });
              if (!navigator.canShare({ files: [file] })){ toast('Partage de fichier non pris en charge ici : utilise « Enregistrer l’image ».'); return; }
              try { await navigator.share({ files: [file], title: l.name }); markPrinted(); } catch {} } }, 'Partager / imprimer') : null),
          h('div', { class: 'muted small' }, (st.w || 1800) + ' × ' + (st.h || 1200) + ' px : 10 × 15 cm à 300 dpi. Au Japon, les imprimantes des konbini tirent les photos depuis le téléphone (format L ou 2L) ; papier mat conseillé pour coller et écrire.')),
        h('div', { style: 'height:8px' }));
    });
    draw();
  }

  /* ---------- lecteur de QR code ---------- */
  function openScanner(){
    const st = { stream: null, stop: false };
    const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'scan-v' });
    // panneau rendu une seule fois (la vidéo ne doit pas être recréée) : les messages sont écrits directement
    const errEl = h('div', { class: 'banner warn small', hidden: true });
    const setErr = t => { errEl.textContent = t || ''; errEl.hidden = !t; };
    const found = text => {
      const c = normCode(text); if (!c) return false;
      const r = resolve(c);
      if (!r){ setErr('Code ' + c.code + ' inconnu dans ce carnet (autre voyage, ou pas encore synchronisé).'); return false; }
      st.stop = true; stopCam(); S.sheet && S.sheet.close(true);
      try { navigator.vibrate && navigator.vibrate(30); } catch {}
      openLieu(r.lieu.id, r.visite ? r.visite.id : null);
      if (r.visite) toast('Visite ' + r.visite.n + ' · ' + r.lieu.name);
      return true;
    };
    const stopCam = () => { if (st.stream){ st.stream.getTracks().forEach(t => t.stop()); st.stream = null; } };
    (async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ setErr('Caméra indisponible ici : saisis le code écrit sous le QR code.'); return; }
      try { st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
      catch { setErr('Caméra refusée : autorise-la pour Tabi, ou saisis le code écrit sous le QR code.'); return; }
      if (st.stop){ stopCam(); return; }
      video.srcObject = st.stream; try { await video.play(); } catch {}
      let detector = null;
      try { if ('BarcodeDetector' in window){ const f = await BarcodeDetector.getSupportedFormats(); if (f.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] }); } } catch {}
      if (!detector){ try { await loadScript('vendor/jsQR.js'); } catch { setErr('Lecteur indisponible hors ligne : saisis le code.'); } }
      const cv = document.createElement('canvas'); const g = cv.getContext('2d', { willReadFrequently: true });
      const tick = async () => {
        if (st.stop) return;
        if (!document.contains(video)){ st.stop = true; stopCam(); return; }
        try {
          if (video.readyState >= 2){
            if (detector){ const r = await detector.detect(video); if (r && r.length && found(r[0].rawValue)) return; }
            else if (window.jsQR){ const w = Math.min(640, video.videoWidth), hh = Math.round(video.videoHeight * w / video.videoWidth); cv.width = w; cv.height = hh; g.drawImage(video, 0, 0, w, hh);
              const r = window.jsQR(g.getImageData(0, 0, w, hh).data, w, hh, { inversionAttempts: 'dontInvert' }); if (r && r.data && found(r.data)) return; }
          }
        } catch {}
        setTimeout(() => requestAnimationFrame(tick), 120);
      };
      tick();
    })();
    openSheet(close => h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scanner une carte postale' },
      sheetHead('Scanner une carte', () => { st.stop = true; stopCam(); close(); }),
      h('div', { class: 'sec' }, h('div', { class: 'scan-box' }, video, h('span', { class: 'scan-frame', 'aria-hidden': 'true' })),
        h('div', { class: 'muted small' }, 'Vise le QR code de la carte postale, ou saisis le code écrit dessous.'), errEl,
        h('form', { class: 'row', style: 'flex-wrap:nowrap', onsubmit: e => { e.preventDefault(); const v = e.currentTarget.querySelector('input').value; if (!normCode(v)) setErr('Code illisible : il ressemble à TB-7K3M9Q ou TB-7K3M9Q/2.'); else found(v); } },
          h('input', { type: 'text', id: 'scan-code', placeholder: 'TB-7K3M9Q/2', autocapitalize: 'characters', autocomplete: 'off', style: 'flex:1' }),
          h('button', { class: 'btn', type: 'submit' }, 'Ouvrir'))),
      h('div', { style: 'height:8px' })), true);
  }

  return { viewLieux, updateLibMap, nearPanel, dayMarkers, placeSection, openLieu, openScanner, onStepStamped, onStepUnstamped, createFromForm, dupsAt, merge, createVisite,
    resolve, lieux, visitesOf, statusOf, setMode: m => { F.mode = m; keepF(); }, renderCard, newCode };
}
