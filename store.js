// Cache local (IndexedDB) : éléments, file d'attente des envois, fichiers en attente, réglages.
const DB_NAME = 'tabi', DB_VERSION = 1;
let dbp = null;
function open(){
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['items', 'outbox', 'blobs', 'meta']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn){
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store);
    let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
export const idb = {
  get: (store, key) => tx(store, 'readonly', s => s.get(key)),
  put: (store, key, val) => tx(store, 'readwrite', s => s.put(val, key)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
  all: async store => {
    const d = await open();
    return new Promise((res, rej) => {
      const out = []; const t = d.transaction(store, 'readonly'); const c = t.objectStore(store).openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur){ out.push([cur.key, cur.value]); cur.continue(); } };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
    });
  },
  clear: store => tx(store, 'readwrite', s => s.clear()),
};
