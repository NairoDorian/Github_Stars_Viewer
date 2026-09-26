// Persistence. Same app everywhere; only where the cache lives changes:
//   'server'  — running locally with server.js: JSON files in ./data next to the app (GET/PUT /cache/<key>)
//   'browser' — online (e.g. GitHub Pages) with "💾 Keep cache in this browser" on: IndexedDB in this browser
//   'memory'  — online with the toggle off: kept in this tab only, gone on reload (nothing written anywhere)
//
// Keys:  config {token, user} · stars:<user> {v, at, repos, pages} · readmes:<user> {<id>: {…}}
//        discover:<user> {dismissed, results}
import {S, ukey} from './state.js';
import {status} from './util.js';

export const CACHE_VERSION = 1;   // bump if the stored shape changes, and migrate in main.js load()
const BROWSER_FLAG = 'starsViewer.browserCache';   // localStorage: is the browser cache enabled?

let mode = 'memory';
const mem = new Map();
export const storageMode = () => mode;

// ---- IndexedDB (browser mode) ----
let dbp = null;
function idb(txMode, fn) {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('stars-viewer', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp.then(db => new Promise((res, rej) => {
    const tx = db.transaction('kv', txMode), req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  }));
}

/** The local server answers /cache/* with JSON; a static host (GitHub Pages, python http.server…) doesn't. */
async function hasServer() {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return false;
  try {
    const r = await fetch('/cache/config', {cache: 'no-store'});
    return (r.headers.get('content-type') || '').includes('application/json');
  } catch { return false; }
}

const flag = () => { try { return localStorage.getItem(BROWSER_FLAG) === '1'; } catch { return false; } };

/** Picks the storage backend. Call once at boot. */
export async function initStore() {
  mode = await hasServer() ? 'server' : flag() ? 'browser' : 'memory';
  return mode;
}

/** Online only: turns the browser cache on (copies what's in memory into it) or off (erases it). */
export async function setBrowserCache(on) {
  if (mode === 'server') return;
  try { localStorage.setItem(BROWSER_FLAG, on ? '1' : '0'); } catch {}
  if (on) {
    mode = 'browser';
    for (const [k, v] of mem) await idb('readwrite', s => s.put(v, k));
  } else {
    // keep this tab's data in memory, erase the stored copy
    for (const k of await idb('readonly', s => s.getAllKeys())) if (!mem.has(k)) mem.set(k, await idb('readonly', s => s.get(k)));
    await idb('readwrite', s => s.clear());
    mode = 'memory';
  }
}

export async function get(key) {
  try {
    if (mode === 'memory') return mem.get(key) ?? null;
    if (mode === 'browser') return (await idb('readonly', s => s.get(key))) ?? null;
    const r = await fetch('/cache/' + encodeURIComponent(key), {cache: 'no-store'});
    return r.ok ? await r.json() : null;
  } catch (e) { console.warn('cache read failed', key, e); return null; }
}

export async function put(key, value) {
  try {
    mem.set(key, value);   // always kept for this tab (also lets the browser cache be switched on later)
    if (mode === 'browser') await idb('readwrite', s => s.put(value, key));
    else if (mode === 'server') {
      const r = await fetch('/cache/' + encodeURIComponent(key), {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
      if (!r.ok) throw new Error('server returned ' + r.status);
    }
    return true;
  } catch (e) {
    status(`⚠ Could not save "${key}": ${e.message}` + (mode === 'server' ? '. Is server.js running?' : ''));
    return false;
  }
}

// `g` = generation the calling job started in. If the user switched profile meanwhile, nothing is written,
// so data from one user can never be saved under another.
export const saveStars = (g = S.gen) => g === S.gen && put('stars:' + ukey(), {v: CACHE_VERSION, at: Date.now(), repos: S.repos, pages: S.starPages});
export const saveReadmes = (g = S.gen) => g === S.gen && put('readmes:' + ukey(), S.readmes);
export const saveDisc = (g = S.gen) => g === S.gen && put('discover:' + ukey(), S.disc);
export const saveConfig = () => put('config', {token: S.token, user: S.user});
