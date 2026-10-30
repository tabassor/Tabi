// Accès Google Drive depuis le navigateur : connexion (Google Identity Services) et appels à l'API Drive v3.
import { CONFIG } from './config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const ALL = 'supportsAllDrives=true';

let token = null, tokenExp = 0, client = null, pending = null;

export class DriveError extends Error { constructor(code, msg, status){ super(msg || code); this.code = code; this.status = status; } }

function gisReady(){
  return new Promise((res, rej) => {
    let n = 0;
    (function wait(){ if (window.google && google.accounts && google.accounts.oauth2) return res();
      if (++n > 100) return rej(new DriveError('gis', 'Le service de connexion Google ne s’est pas chargé.'));
      setTimeout(wait, 100); })();
  });
}

export function hasToken(){ return !!token && Date.now() < tokenExp - 60000; }
export function clearToken(){ if (token && window.google) try { google.accounts.oauth2.revoke(token); } catch {} token = null; tokenExp = 0; }

// Doit être appelé depuis un geste de l'utilisateur (clic) : le navigateur bloque sinon la fenêtre Google.
export async function signIn({ hint, silent } = {}){
  if (!CONFIG.clientId) throw new DriveError('config', 'ID client Google non configuré.');
  await gisReady();
  if (pending) return pending;
  pending = new Promise((res, rej) => {
    client = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.clientId, scope: CONFIG.scope, hint,
      callback: r => {
        pending = null;
        if (r.error) return rej(new DriveError('denied', r.error_description || r.error));
        token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000; res(token);
      },
      error_callback: e => { pending = null; rej(new DriveError(e && e.type === 'popup_closed' ? 'closed' : 'popup', e && e.message)); },
    });
    client.requestAccessToken({ prompt: silent ? '' : 'select_account' });
  });
  return pending;
}

async function call(url, opts = {}, raw = false){
  if (!hasToken()) throw new DriveError('auth', 'Connexion Google expirée.');
  let r;
  try { r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } }); }
  catch { throw new DriveError('network', 'Pas de réseau.'); }
  if (r.status === 401){ token = null; throw new DriveError('auth', 'Connexion Google expirée.', 401); }
  if (!r.ok){
    let msg = r.statusText; try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch {}
    throw new DriveError(r.status === 403 || r.status === 404 ? 'access' : (r.status >= 500 || r.status === 429 ? 'server' : 'http'), msg, r.status);
  }
  if (raw) return r;
  const t = r.headers.get('content-type') || '';
  return t.includes('json') ? r.json() : r.text();
}

export const drive = {
  me: () => call(`${API}/about?fields=user(displayName,emailAddress)`).then(j => j.user),
  get: (id, fields = 'id,name,mimeType,webViewLink') => call(`${API}/files/${id}?fields=${encodeURIComponent(fields)}&${ALL}`),
  async list(folderId, extraQ = ''){
    const out = []; let pageToken = '';
    const q = `'${folderId}' in parents and trashed=false${extraQ ? ' and ' + extraQ : ''}`;
    const fields = 'nextPageToken,files(id,name,mimeType,version,modifiedTime,lastModifyingUser(displayName,emailAddress))';
    do {
      const j = await call(`${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000&includeItemsFromAllDrives=true&${ALL}${pageToken ? '&pageToken=' + pageToken : ''}`);
      out.push(...(j.files || [])); pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  },
  async child(folderId, name, mimeType){
    const files = await drive.list(folderId, `name='${name.replace(/'/g, "\\'")}'` + (mimeType ? ` and mimeType='${mimeType}'` : ''));
    return files[0] || null;
  },
  createFolder: (parent, name) => call(`${API}/files?fields=id&${ALL}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) }),
  readJson: id => call(`${API}/files/${id}?alt=media&${ALL}`, {}, true).then(r => r.text()).then(t => JSON.parse(t)),
  async createJson(parent, name, obj){
    const b = 'tabi' + Math.random().toString(36).slice(2);
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent], mimeType: 'application/json' })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj, null, 1)}\r\n--${b}--`;
    return call(`${UP}/files?uploadType=multipart&fields=id,version,modifiedTime&${ALL}`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
  },
  updateJson: (id, obj) => call(`${UP}/files/${id}?uploadType=media&fields=id,version,modifiedTime&${ALL}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj, null, 1) }),
  trash: id => call(`${API}/files/${id}?fields=id&${ALL}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }),
  // Envoi de fichier (photo, billet) en deux temps pour supporter les gros fichiers.
  async upload(parent, name, blob, mime, appProperties){
    const init = await call(`${UP}/files?uploadType=resumable&fields=id,webViewLink&${ALL}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
      body: JSON.stringify({ name, parents: [parent], mimeType: mime, appProperties }) }, true);
    const loc = init.headers.get('Location'); if (!loc) throw new DriveError('http', 'Envoi refusé par Drive.');
    let r; try { r = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob }); } catch { throw new DriveError('network', 'Pas de réseau.'); }
    if (!r.ok) throw new DriveError('http', 'Envoi interrompu (' + r.status + ').', r.status);
    return r.json();
  },
  blob: id => call(`${API}/files/${id}?alt=media&${ALL}`, {}, true).then(r => r.blob()),
};
