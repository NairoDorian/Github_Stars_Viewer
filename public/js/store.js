// Persistence. Same app everywhere; only where the cache lives changes. The "💾 Keep cache" toggle is OFF by default
// (nothing is stored: the data lives in this tab only); when it is ON, remembered by a cookie, the cache is kept in:
//   'server'  — running locally with server.js: JSON files in ./data next to the app (GET/PUT/DELETE /cache/<key>);
//               files of 64 KB or more are gzip-compressed by the server
//   'browser' — online (e.g. GitHub Pages): IndexedDB in this browser (structured-clone copies, not compressed)
//   'memory'  — toggle OFF: this tab only, gone on reload (nothing is written anywhere)
//
// Keys:  config {token, user} · stars:<user> {v, at, repos, pages} · readmes:<user> {<id>: {…}}
//        history:<user>:<0-255> {<repo id>: {commit messages + release notes}} (sharded, see below; history.js)
//        discover:<user> {dismissed, results} · starcurves {<owner/name>: {at, pts}} (star-history.com, all users)
import {S, ukey} from './state.js';
import {status} from './util.js';

export const CACHE_VERSION = 1;   // bump if the stored shape changes, and migrate in main.js load()
const CACHE_COOKIE = 'starsViewerCache';   // "1" = keep the cache, "0" = don't; remembered for a year
const OLD_FLAG = 'starsViewer.browserCache';   // localStorage flag of earlier versions, read as a fallback

let mode = 'memory', serverUp = false, persistOn = false;
const mem = new Map();   // memory mode: the whole cache; browser mode: a copy of what was read or written, kept when the cache is switched off
// Keys whose stored copy could NOT be read (server hiccup, corrupt file, IndexedDB error). get() answers null for them like for
// "nothing stored", so this tab would build a near-empty replacement; put() refuses to overwrite the real file with it.
const unreadable = new Set();

// ---- IndexedDB (browser mode) ----
let dbp = null;
function idb(txMode, fn) {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('stars-viewer', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch(e => { dbp = null; throw e; });   // a failed open is tried again by the next call, not remembered forever
  return dbp.then(db => new Promise((res, rej) => {
    const tx = db.transaction('kv', txMode), req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = tx.onabort = () => rej(tx.error);   // abort: e.g. the browser's storage quota is full
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

const readCookie = name => {
  try { return document.cookie.split('; ').find(c => c.startsWith(name + '='))?.slice(name.length + 1) ?? null; } catch { return null; }
};
const writeCookie = (name, value) => {
  try { document.cookie = `${name}=${value}; max-age=31536000; path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; } catch {}
};
/** Is "Keep cache" on? The cookie decides; without one, an earlier version's localStorage flag; otherwise off. */
const persistWanted = () => {
  const c = readCookie(CACHE_COOKIE);
  if (c !== null) return c === '1';
  try { return localStorage.getItem(OLD_FLAG) === '1'; } catch { return false; }
};

/** Is "Keep cache" on right now? */
export const persisting = () => persistOn;

/** Picks the storage backend. Call once at boot. */
export async function initStore() {
  serverUp = await hasServer();
  persistOn = persistWanted();
  mode = !persistOn ? 'memory' : serverUp ? 'server' : 'browser';
  return {mode, serverUp, persistOn};
}

/**
 * Turns "Keep cache" on or off and remembers the choice in a cookie. On: later reads and writes go to the local server's
 * files (or IndexedDB online); the caller decides what to do with this tab's data (see main.js). Off: this tab keeps
 * working from memory; IndexedDB is erased (its data is copied to memory first); the local server's files are left
 * untouched, use clearAll() to delete them. Either way this tab's data is kept in memory, so loading the profile again
 * finds it (the local server's files are never copied into memory: they can be hundreds of MB).
 */
export async function setPersist(on) {
  writeCookie(CACHE_COOKIE, on ? '1' : '0');
  try { localStorage.removeItem(OLD_FLAG); } catch {}
  persistOn = on;
  unreadable.clear();   // read failures belong to the backend that was in use
  if (on) { mode = serverUp ? 'server' : 'browser'; return; }
  if (mode === 'browser') {
    for (const k of await idb('readonly', s => s.getAllKeys())) if (!mem.has(k)) mem.set(k, await idb('readonly', s => s.get(k)));
    await idb('readwrite', s => s.clear());
  }
  mode = 'memory';
  while (S.loading) await S.loading;   // a profile still being read would be kept half-loaded
  if (S.user) await saveAll();   // memory mode: keeps references, nothing is copied or written anywhere
}

/** Deletes everything this app stored: the local server's cache files, this browser's IndexedDB, the app's preferences in
 *  localStorage and this tab's memory. The "Keep cache" cookie stays (a preference, not data). Returns {files}. */
export async function clearAll() {
  mem.clear();
  dirtyShards.clear();
  unreadable.clear();
  let files = 0;
  if (serverUp) {
    try { const r = await fetch('/cache', {method: 'DELETE'}); if (r.ok) files = (await r.json()).deleted ?? 0; } catch {}
  }
  try { (await dbp)?.close(); } catch {}
  dbp = null;
  await new Promise(done => {
    try { const q = indexedDB.deleteDatabase('stars-viewer'); q.onsuccess = q.onerror = q.onblocked = () => done(); } catch { done(); }
  });
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('starsViewer.') || k === 'tokenPanelOpen') localStorage.removeItem(k); } catch {}
  return {files};
}

/** Writes this tab's whole state (config, curves, stars, READMEs, history, suggestions) to the active backend. */
export async function saveAll(g = S.gen) {
  await saveConfig();
  await put('starcurves', S.starCurves);
  await saveStars(g);
  await saveReadmes(g);
  markAllHistory();
  await saveHistory(g);
  await saveDisc(g);
}

export async function get(key) {
  try {
    if (mode === 'memory') return mem.get(key) ?? null;
    let v;
    if (mode === 'browser') {
      v = (await idb('readonly', s => s.get(key))) ?? null;
      if (v !== null) mem.set(key, v);
    } else {
      const r = await fetch('/cache/' + encodeURIComponent(key), {cache: 'no-store'});
      if (!r.ok) throw new Error('server returned ' + r.status);   // a missing key is a 200 "null", so this is a real failure
      v = await r.json();
    }
    unreadable.delete(key);
    return v;
  } catch (e) { console.warn('cache read failed', key, e); unreadable.add(key); return null; }
}

/** Was this key's stored copy unreadable the last time it was read? (Writing it is refused, see put.) */
export const isUnreadable = key => unreadable.has(key);

/** Forgets which history shards are waiting to be saved (another profile is being loaded: they belong to the old one). */
export const forgetHistoryDirty = () => { dirtyShards.clear(); };

export async function put(key, value) {
  if (unreadable.has(key)) {
    status(`⚠ "${key}" could not be read, so the stored copy is kept as it is and not overwritten. Reload the page to try again.`);
    return false;
  }
  try {
    if (mode !== 'server') mem.set(key, value);   // kept for online tabs (also lets the browser cache be switched on/off later)
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

/* Commit messages and release notes are large (hundreds of MB for a big star list), so they are stored in HISTORY_SHARDS
   small records, `history:<user>:<n>` holding {<repo id>: record}, and a save rewrites only the shards whose repos
   changed. The old single `history:<user>` record is split into shards on first load, then emptied. */
export const HISTORY_SHARDS = 256;
export const shardOf = k => [...String(k)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % HISTORY_SHARDS;
const dirtyShards = new Set();
/** Marks a repo's history record as changed (written by the next saveHistory). */
export const markHistory = k => { dirtyShards.add(shardOf(k)); };
export const markAllHistory = () => { for (let i = 0; i < HISTORY_SHARDS; i++) dirtyShards.add(i); };
export const historyDirty = () => dirtyShards.size;

/** Writes the shards marked dirty (records of `history`, default S.history). True when every write succeeded; a failed
 *  shard stays dirty and is retried by the next call. Saves run one after another: a save that started later holds
 *  newer records, and must not have one of its shards overwritten by an earlier, slower save (a big index takes longer
 *  to write than the time between two progress saves). */
let historySaves = Promise.resolve();
export function saveHistory(g = S.gen, history = S.history) {
  const save = historySaves.then(() => writeHistory(g, history));
  historySaves = save.catch(() => {});
  return save;
}
async function writeHistory(g, history) {
  if (g !== S.gen) return false;
  const user = ukey(), todo = [...dirtyShards];
  dirtyShards.clear();
  const shards = new Map(todo.map(i => [i, {}]));
  for (const [k, rec] of Object.entries(history)) { const shard = shards.get(shardOf(k)); if (shard) shard[k] = rec; }
  let ok = true;
  for (const [i, data] of shards) {
    if (g !== S.gen) return false;   // another profile now: the rest belongs to the old one and is never written for the new one
    if (!(await put(`history:${user}:${i}`, data))) { dirtyShards.add(i); ok = false; }
  }
  return ok;
}

/** Reads every shard and returns the history ({} when none), or null if the profile changed meanwhile. A legacy single
 *  record (written by an older version) is imported on top, split into shards, then emptied. */
export async function loadHistory(g = S.gen) {
  const user = ukey(), out = {};
  const [legacy, ...parts] = await Promise.all([get('history:' + user), ...Array.from({length: HISTORY_SHARDS}, (_, i) => get(`history:${user}:${i}`))]);
  for (const part of parts) if (part) Object.assign(out, part);
  if (g !== S.gen) return null;
  if (legacy && typeof legacy === 'object') {   // an older version wrote it last: it wins, then it is retired
    Object.assign(out, legacy);
    markAllHistory();
    if (await saveHistory(g, out)) await put('history:' + user, null);
  }
  return out;
}
