/* Local persistence in IndexedDB (photos can be big, so localStorage is not enough). Nothing leaves the device. */
(function () {
  const DB = 'deer-whisperer', VERSION = 1, STORES = ['cameras', 'stands', 'bucks', 'photos', 'settings'];
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => STORES.forEach((s) => { if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' }); });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode), s = t.objectStore(store), r = fn(s);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  const all = (store) => tx(store, 'readonly', (s) => s.getAll());
  const get = (store, id) => tx(store, 'readonly', (s) => s.get(id));
  const put = (store, obj) => tx(store, 'readwrite', (s) => s.put(obj));
  const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
  const clear = (store) => tx(store, 'readwrite', (s) => s.clear());
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  async function getSetting(key, fallback) { const r = await get('settings', key); return r ? r.value : fallback; }
  const setSetting = (key, value) => put('settings', { id: key, value });

  const blobToDataURL = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
  async function dataURLToBlob(u) { return (await fetch(u)).blob(); }

  /** Full JSON backup including photos (as data URLs). */
  async function exportAll() {
    const out = { app: 'deer-whisperer', version: 1, exported: new Date().toISOString() };
    for (const s of STORES) {
      const rows = await all(s);
      out[s] = await Promise.all(rows.map(async (r) => (r.blob ? { ...r, blob: await blobToDataURL(r.blob) } : r)));
    }
    return out;
  }
  async function importAll(data) {
    if (!data || data.app !== 'deer-whisperer') throw new Error('Not a Deer Whisperer backup file');
    for (const s of STORES) {
      if (!Array.isArray(data[s])) continue;
      await clear(s);
      for (const r of data[s]) await put(s, r.blob ? { ...r, blob: await dataURLToBlob(r.blob) } : r);
    }
  }

  window.Store = { all, get, put, del, clear, uid, getSetting, setSetting, exportAll, importAll, blobToDataURL };
})();
