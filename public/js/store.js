// Persistence. Same app everywhere; only where the cache lives changes. The "💾 Keep cache" toggle is OFF by default
// (nothing is stored: the data lives in this tab only); when it is ON, remembered by a cookie, the cache is kept in:
//   'server'  — running locally with server.js: JSON files in ./data next to the app (GET/PUT/DELETE /cache/<key>);
//               files of 64 KB or more are gzip-compressed by the server
//   'browser' — online (e.g. GitHub Pages): IndexedDB in this browser (structured-clone copies, not compressed)
//   'memory'  — toggle OFF: this tab only, gone on reload (nothing is written anywhere)
//
// Keys:  config {token, user} · stars:<user> {v, at, repos, pages} · readmes:<user> {<id>: {…}}
//        history:<user>:<0-255> {<repo id>: {commit messages + release notes}} (sharded, see below; history.js)
//        filesum:<user> {v, recs: {<repo id>: what the file list says about the repo}} · paths:<user>:<0-1023> {<repo id>:
//        the file paths, packed} (read only when file names are searched; see "File lists" below and files.js)
//        discover:<user> {dismissed, results} · users:<user> {<owner login>: {stars, followers…}} (users.js)
//        starcurves {<owner/name>: {at, pts}} (star-history.com, all users)
//
// Visiting: while S.visit is set (someone else's stars are on screen), every key except 'config' lives in visitMem, a map that
// is never written to disk or IndexedDB and is emptied when the visit ends. That is the whole guarantee, enforced here in
// get() / put(), the only door to storage.
import {S, ukey} from './state.js';
import {status, pool} from './util.js';
import {debug, info, warn, error, bytes} from './log.js';

export const CACHE_VERSION = 2;   // bump if the stored shape changes, and migrate in main.js load(). 2: repos carry ownerType, so older star lists are downloaded once more (their page ETags are dropped)
const CACHE_COOKIE = 'starsViewerCache';   // "1" = keep the cache, "0" = don't; remembered for a year
const OLD_FLAG = 'starsViewer.browserCache';   // localStorage flag of earlier versions, read as a fallback

let mode = 'memory', serverUp = false, persistOn = false;
const mem = new Map();   // memory mode: the whole cache; browser mode: a copy of what was read or written, kept when the cache is switched off
// Keys whose stored copy could NOT be read (server hiccup, corrupt file, IndexedDB error). get() answers null for them like for
// "nothing stored", so this tab would build a near-empty replacement; put() refuses to overwrite the real file with it.
const unreadable = new Set();
/** Shards of the commit index are logged as a group (writeHistory), not one line each. */
const quiet = key => /^(?:history|files|paths):[^:]+:\d+$/.test(key);
/** "found" / "nothing stored" for a read. The old single-file commit index is expected to be absent: it lives in 256 shards now. */
const found = (key, v) => v != null ? 'found' : /^history:[^:]+$/.test(key) ? 'nothing stored (normal: the commit index lives in 256 shards, this key only held an older single-file copy)' : 'nothing stored';
const where = () => mode === 'server' ? 'the data/ folder' : mode === 'browser' ? 'IndexedDB' : 'memory';
const visitMem = new Map();
const visited = new Set();   // logins (lower-cased) visited in this tab and not adopted since: put() refuses their keys, whatever happens
/** The login a profile key belongs to (stars:<user>, history:<user>:<n>…), or null for shared keys (config, starcurves). */
const keyUser = key => key.match(/^(?:stars|readmes|discover|users|history|histopts|files|filesum|paths):([^:]+)/)?.[1].toLowerCase() ?? null;

/** Starts, switches or (with '') ends a visit. A visit never inherits the previous visit's data. */
export function setVisit(login) {
  login = login || '';
  const was = S.visit;
  if (login.toLowerCase() !== was.toLowerCase()) {
    if (visitMem.size) debug('visit', `forgot ${visitMem.size} item(s) kept in memory for ${was}`);
    visitMem.clear();
  }
  S.visit = login;
  if (login !== was) info('visit', login ? `visiting ${login}: what is downloaded stays in memory, nothing is written to disk or to this browser` : `the visit of ${was} ended: its data was forgotten`);
  if (login) visited.add(login.toLowerCase());
}
/** The profile is wanted as a normal, saved one (loaded as your own, or adopted from a visit): its keys may be written again. */
export const adoptProfile = login => { visited.delete(String(login).toLowerCase()); };

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
  info('store', `storage: ${serverUp ? 'the local server is running' : 'no local server (online copy)'} · Keep cache is ${persistOn ? 'ON' : 'OFF'} → ${mode === 'server' ? 'files in the data/ folder' : mode === 'browser' ? 'IndexedDB in this browser' : 'memory only, nothing is written'}`);
  return {mode, serverUp, persistOn};
}

/**
 * Turns "Keep cache" on or off and remembers the choice in a cookie. On: later reads and writes go to the local server's
 * files (or IndexedDB online); the caller decides what to do with this tab's data (see main.js). Off: this tab keeps
 * working from memory; IndexedDB is erased (its data is copied to memory first); the local server's files are left
 * untouched, use clearAll() to delete them. Either way this tab's data is kept in memory, so loading the profile again
 * finds it. The file paths of the profile on screen are not in this tab's memory (they are read when needed), so they are
 * carried across by hand, whichever way the switch goes: the next saveAll() hands them to the store then in use.
 */
export async function setPersist(on) {
  writeCookie(CACHE_COOKIE, on ? '1' : '0');
  try { localStorage.removeItem(OLD_FLAG); } catch {}
  persistOn = on;
  info('store', `Keep cache switched ${on ? 'ON: ' + (serverUp ? 'files in the data/ folder' : 'IndexedDB in this browser') : 'OFF: this tab keeps its data in memory'}`);
  unreadable.clear();   // read failures belong to the backend that was in use
  const mine = !!S.user && !S.visit;
  if (on) {
    if (mine && mode === 'memory') await carryPaths();   // out of this tab's memory, for the store being switched on
    mode = serverUp ? 'server' : 'browser';
    return;
  }
  if (mode === 'browser') {
    for (const k of await idb('readonly', s => s.getAllKeys())) if (!mem.has(k)) mem.set(k, await idb('readonly', s => s.get(k)));
    await idb('readwrite', s => s.clear());
  } else if (mine && mode === 'server') await carryPaths();   // out of the data/ folder: this tab goes on from memory
  mode = 'memory';
  while (S.loading) await S.loading;   // a profile still being read would be kept half-loaded
  if (S.user) await saveAll();   // memory mode: keeps references, nothing is copied or written anywhere
}

/** Deletes everything this app stored: the local server's cache files, this browser's IndexedDB, the app's preferences in
 *  localStorage and this tab's memory. The "Keep cache" cookie stays (a preference, not data). Returns {files}. */
export async function clearAll() {
  mem.clear();
  visitMem.clear();
  visited.clear();
  historyShards.forget();
  forgetFiles();
  unreadable.clear();
  let files = 0;
  if (serverUp) {
    try { const r = await fetch('/cache', {method: 'DELETE'}); if (r.ok) files = (await r.json()).deleted ?? 0; } catch {}
  }
  try { (await dbp)?.close(); } catch {}
  dbp = null;
  info('store', `cleared: ${files} file(s) deleted from the data folder, memory emptied, IndexedDB and preferences removed`);
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
  if (carried && mayWrite(g)) {   // the file paths carried over from the store that was in use (setPersist, a visit being adopted)
    const list = carried;
    carried = null;
    debug('store', `file paths: ${list.length} shard(s) carried over to ${where()}`);
    for (const [key, value] of list) await put(key, value, {keep: false});
  }
  markFiles();
  await saveFiles(g);
  await saveDisc(g);
  await saveUsers(g);
}

/** Reads a key. `keep: false`: online, no copy stays in this tab's memory (the file paths are read when needed and let go
 *  again; everything else is small enough to keep, so the cache can be switched off without losing it). */
export async function get(key, {keep = true} = {}) {
  if (S.visit && keyUser(key) !== null) {   // a visit reads nothing stored, not even a copy of that profile saved earlier
    const v = visitMem.get(key) ?? null;
    if (!quiet(key)) debug('visit', `read ${key} from visit memory: ${v == null ? 'nothing yet' : 'found'} (nothing is read from disk during a visit)`);
    return v;
  }
  return readStored(key, keep);
}

/** Reads YOUR stored copy of a key, visit or not (a visit uses it to know which repos you starred). Never writes. */
export const peek = key => readStored(key);

async function readStored(key, keep = true) {
  try {
    if (mode === 'memory') {
      const v = mem.get(key) ?? null;
      if (!quiet(key)) debug('store', `read ${key} from memory: ${found(key, v)}`);
      return v;
    }
    let v, via = '';
    if (mode === 'browser') {
      v = (await idb('readonly', s => s.get(key))) ?? null;
      if (v !== null && keep) mem.set(key, v);
    } else {
      const t0 = Date.now();
      const r = await fetch('/cache/' + encodeURIComponent(key), {cache: 'no-store'});
      if (!r.ok) throw new Error('server returned ' + r.status);   // a missing key is a 200 "null", so this is a real failure
      v = await r.json();
      via = `  (GET /cache/${key} → ${r.status} in ${Date.now() - t0} ms${r.headers?.get?.('content-length') ? ', ' + bytes(Number(r.headers.get('content-length'))) : ''})`.replace('  (', ' (');
    }
    unreadable.delete(key);
    if (!quiet(key)) debug('store', `read ${key} from ${where()}: ${found(key, v)}${via}`);
    return v;
  } catch (e) {
    console.warn('cache read failed', key, e);
    error('store', `could not read ${key} from ${where()}: ${e.message}. It is kept as it is and never overwritten until a reload reads it`);
    unreadable.add(key);
    return null;
  }
}

/** Was this key's stored copy unreadable the last time it was read? (Writing it is refused, see put.) */
export const isUnreadable = key => unreadable.has(key);

/** Forgets which history / file-list shards are waiting to be saved (another profile is being loaded: they belong to the old one). */
export const forgetHistoryDirty = () => { historyShards.forget(); forgetFiles(); };

export async function put(key, value, {keep = true} = {}) {
  if (S.visit && key !== 'config') {   // kept for this visit only
    visitMem.set(key, value);
    if (!quiet(key)) debug('visit', `${key}: kept in visit memory only, NOT saved`);
    return true;
  }
  const owner = keyUser(key);
  if (owner !== null && visited.has(owner)) {
    status(`⚠ ${owner}'s data is not saved: you only visited. Use "★ Make this my profile" to keep it.`);
    warn('visit', `refused to write ${key}: ${owner} was only visited`);
    return false;
  }
  if (unreadable.has(key)) {
    status(`⚠ "${key}" could not be read, so the stored copy is kept as it is and not overwritten. Reload the page to try again.`);
    warn('store', `refused to write ${key}: its stored copy could not be read, so it is kept untouched`);
    return false;
  }
  try {
    if (mode === 'memory' || (mode === 'browser' && keep)) mem.set(key, value);   // kept for online tabs (also lets the browser cache be switched on/off later)
    if (mode === 'browser') await idb('readwrite', s => s.put(value, key));
    else if (mode === 'server') {
      const body = JSON.stringify(value), t0 = Date.now();
      const r = await fetch('/cache/' + encodeURIComponent(key), {method: 'PUT', headers: {'Content-Type': 'application/json'}, body});
      if (!r.ok) throw new Error('server returned ' + r.status);
      if (!quiet(key)) debug('store', `wrote ${key} to the data/ folder (PUT /cache/${key} → ${r.status}): ${bytes(body.length)} (the server compresses big files) in ${Date.now() - t0} ms`);
    } else if (!quiet(key)) debug('store', `${key}: kept in ${where()}${mode === 'memory' ? ' (Keep cache is off: nothing is written)' : ''}`);
    return true;
  } catch (e) {
    error('store', `could not save ${key} to ${where()}: ${e.message}`);
    status(`⚠ Could not save "${key}": ${e.message}` + (mode === 'server' ? '. Is server.js running?' : ''));
    return false;
  }
}

/** Deletes a stored key for good (a shard that was emptied, a record of an older format that was taken over). True when it
 *  is gone. A visit only forgets its own memory; a profile that was merely visited is never touched. */
export async function del(key) {
  if (S.visit && key !== 'config') { visitMem.delete(key); return true; }
  const owner = keyUser(key);
  if (owner !== null && visited.has(owner)) { warn('visit', `refused to delete ${key}: ${owner} was only visited`); return false; }
  try {
    mem.delete(key);
    if (mode === 'browser') await idb('readwrite', s => s.delete(key));
    else if (mode === 'server') {
      const r = await fetch('/cache/' + encodeURIComponent(key), {method: 'DELETE'});
      if (!r.ok) throw new Error('server returned ' + r.status);
    }
    unreadable.delete(key);
    if (!quiet(key)) debug('store', `deleted ${key} from ${where()}`);
    return true;
  } catch (e) {
    error('store', `could not delete ${key} from ${where()}: ${e.message}`);
    return false;
  }
}

// `g` = generation the calling job started in. If the user switched profile meanwhile, nothing is written,
// so data from one user can never be saved under another. While a profile is being read (S.loading) S still holds a mix of
// the old and the new profile, so nothing is written then either.
const mayWrite = g => g === S.gen && !S.loading;
export const saveStars = (g = S.gen) => mayWrite(g) && put('stars:' + ukey(), {v: CACHE_VERSION, at: Date.now(), repos: S.repos, pages: S.starPages});
export const saveReadmes = (g = S.gen) => mayWrite(g) && put('readmes:' + ukey(), S.readmes);
export const saveDisc = (g = S.gen) => mayWrite(g) && put('discover:' + ukey(), S.disc);
export const saveUsers = (g = S.gen) => mayWrite(g) && put('users:' + ukey(), S.users);
/** The options the commit / release index of this profile is built with (history.js fitOptsToIndex): kept with the index,
 *  so another browser opening it uses them instead of applying its own defaults to it. */
export const saveHistOpts = (g, opts) => mayWrite(g) && put('histopts:' + ukey(), opts);
/** The config holds the token and YOUR login (S.home), never the profile on screen: a visit must not become the next start's profile. */
export const saveConfig = () => put('config', {token: S.token, user: S.home});

/* Commit messages and release notes are large (hundreds of MB for a big star list), and so are the file lists of every
   repo, so each is stored in small records, `<name>:<user>:<n>` holding {<repo id>: record}, and a save rewrites only
   the shards whose repos changed. The old single `history:<user>` record is split into shards on first load, then
   emptied. */
function shardStore(name, count, label, data) {
  const shardOf = k => [...String(k)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % count;
  const dirty = new Set();
  let saves = Promise.resolve();
  async function write(g, records) {
    if (g !== S.gen) return false;
    const user = ukey(), todo = [...dirty];
    dirty.clear();
    if (todo.length) debug('store', `${label}: writing ${todo.length} changed shard(s) of ${count} to ${where()}`);
    const shards = new Map(todo.map(i => [i, {}]));
    for (const [k, rec] of Object.entries(records)) { const shard = shards.get(shardOf(k)); if (shard) shard[k] = rec; }
    let ok = true;
    for (const [i, part] of shards) {
      if (g !== S.gen) return false;   // another profile now: the rest belongs to the old one and is never written for the new one
      if (!(await put(`${name}:${user}:${i}`, part))) { dirty.add(i); ok = false; }
    }
    if (todo.length && !ok) warn('store', `${label}: some shards could not be saved; they stay marked and are written by the next save`);
    return ok;
  }
  return {
    count, shardOf,
    mark: k => { dirty.add(shardOf(k)); },
    markAll: () => { for (let i = 0; i < count; i++) dirty.add(i); },
    dirty: () => dirty.size,
    forget: () => { dirty.clear(); },
    /** Writes the shards marked dirty. True when every write succeeded; a failed shard stays dirty and is retried by the
     *  next call. Saves run one after another: a save that started later holds newer records, and must not have one of its
     *  shards overwritten by an earlier, slower save. */
    save(g = S.gen, records = data()) {
      const run = saves.then(() => write(g, records));
      saves = run.catch(() => {});
      return run;
    },
    /** Reads every shard: {} when none, null if the profile changed meanwhile. */
    async load(g = S.gen, extra = []) {
      const user = ukey(), out = {};
      const parts = await Promise.all([...extra.map(k => get(k)), ...Array.from({length: count}, (_, i) => get(`${name}:${user}:${i}`))]);
      for (const part of parts.slice(extra.length)) if (part) Object.assign(out, part);
      if (g !== S.gen) return null;
      return {out, extra: parts.slice(0, extra.length)};
    },
  };
}

export const HISTORY_SHARDS = 256;
const historyShards = shardStore('history', HISTORY_SHARDS, 'commit index', () => S.history);
export const shardOf = historyShards.shardOf;
/** Marks a repo's history record as changed (written by the next saveHistory). */
export const markHistory = historyShards.mark;
export const markAllHistory = historyShards.markAll;
export const historyDirty = historyShards.dirty;
/** Writes the commit-index shards marked dirty (records of `history`, default S.history). */
export const saveHistory = (g = S.gen, history = S.history) => historyShards.save(g, history);

/** Reads every shard and returns the history ({} when none), or null if the profile changed meanwhile. A legacy single
 *  record (written by an older version) is imported on top, split into shards, then emptied. */
export async function loadHistory(g = S.gen) {
  const user = ukey(), got = await historyShards.load(g, ['history:' + user]);
  if (!got) return null;
  const {out, extra: [legacy]} = got;
  info('store', `commit index: ${Object.keys(out).length.toLocaleString()} repos read from its ${HISTORY_SHARDS} shards${legacy ? ' (+ an older single-file copy, being split into shards)' : ''}`);
  if (legacy && typeof legacy === 'object') {   // an older version wrote it last: it wins, then it is retired
    Object.assign(out, legacy);
    markAllHistory();
    if (await saveHistory(g, out)) await put('history:' + user, null);
  }
  return out;
}

/* File lists. What a repo's files say about it (how many, which kinds, build systems, extensions: a few hundred bytes)
   is kept for every repo in ONE record, `filesum:<user>`, read when the profile opens. The paths themselves are far
   bigger (millions of them for a large star list) and only needed to search file names, so they live apart, packed
   (paths.js), in `paths:<user>:<0-1023>` holding {<repo id>: {d, f}}: read when a search asks for them, never at start.
   A shard is small (a handful of repos), so changing one repo's list reads, changes and writes a few hundred KB.
   Earlier versions kept everything, paths as plain arrays, in 64 big shards `files:<user>:<0-63>` that were all read
   at start: files.js takes those over once (upgradeFiles), shard by shard. */
export const PATH_SHARDS = 1024, LEGACY_FILE_SHARDS = 64;
const FILESUM_VERSION = 3;   // 3: summaries apart from the paths (1 and 2 were the 64-shard layouts)

/** Shards of {<repo id>: value} that are NOT kept in memory: a change waits in `pending` until save() reads its shard,
 *  applies it and writes the shard back. */
function lazyShards(name, count, label) {
  const shardOf = k => [...String(k)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % count;
  const keyOf = (user, i) => `${name}:${user}:${i}`;
  const all = () => Array.from({length: count}, (_, i) => i);
  const pending = new Map();   // repo id → the value to store, or null to delete it
  let saves = Promise.resolve();
  async function write(g) {
    if (g !== S.gen) return false;
    if (!pending.size) return true;
    const user = ukey(), groups = new Map();
    for (const [id, v] of pending) { const i = shardOf(id); let list = groups.get(i); if (!list) groups.set(i, list = []); list.push([id, v]); }
    debug('store', `${label}: ${pending.size} repo(s) changed, in ${groups.size} of ${count} shards (each is read, changed and written back) → ${where()}`);
    pending.clear();
    let ok = true;
    await pool([...groups], 4, async ([i, changes]) => {
      const keep = () => { ok = false; for (const [id, v] of changes) if (!pending.has(id)) pending.set(id, v); };   // a newer change of the same repo wins
      if (g !== S.gen) return;   // another profile now: what is left belonged to the old one (its pending changes were forgotten)
      const key = keyOf(user, i), cur = await get(key, {keep: false});
      if (g !== S.gen) return;
      if (cur === null && unreadable.has(key)) return keep();   // never rebuilt from nothing: the stored shard could not be read
      const next = {...(cur || {})};
      for (const [id, v] of changes) { if (v == null) delete next[id]; else next[id] = v; }
      if (cur === null && !Object.keys(next).length) return;   // only deletions, and nothing is stored: nothing to write
      if (!(Object.keys(next).length ? await put(key, next, {keep: false}) : await del(key))) keep();   // a shard left empty is deleted, not kept as "{}"
    });
    if (g !== S.gen) return false;
    if (!ok) warn('store', `${label}: some shards could not be saved; their changes are kept and written by the next save`);
    return ok;
  }
  return {
    count, shardOf,
    /** Stores (or with null deletes) one repo's value at the next save. */
    set: (id, value) => { pending.set(String(id), value ?? null); },
    pending: () => pending.size,
    forget: () => { pending.clear(); },
    /** Writes the pending changes. True when every one is stored; saves run one after another. */
    save(g = S.gen) {
      const run = saves.then(() => write(g));
      saves = run.catch(() => false);
      return run;
    },
    /** One repo's value: a change not saved yet, else from its shard; null when there is none. */
    async readOne(id) {
      id = String(id);
      if (pending.has(id)) return pending.get(id);
      return (await get(keyOf(ukey(), shardOf(id)), {keep: false}))?.[id] ?? null;
    },
    /** Every repo's value as {out: Map(id → value), failed: shards that could not be read}; null if the profile changed.
     *  `only(i)`: read just those shards. `onProgress(done, total)` after each one. */
    async loadAll(g = S.gen, onProgress = null, only = null) {
      const user = ukey(), out = new Map(), todo = all().filter(i => !only || only(i));
      let done = 0, failed = 0;
      await pool(todo, 8, async i => {
        if (g !== S.gen) return;
        const key = keyOf(user, i), part = await get(key, {keep: false});
        if (part) for (const [id, v] of Object.entries(part)) out.set(id, v);
        else if (unreadable.has(key)) failed++;
        onProgress?.(++done, todo.length);
      });
      if (g !== S.gen) return null;
      for (const [id, v] of pending) { if (v == null) out.delete(id); else if (!only || only(shardOf(id))) out.set(id, v); }
      return {out, failed};
    },
    /** Every stored shard as [[key, {<id>: value}]…], pending changes not included (a snapshot to carry elsewhere). */
    async exportAll() {
      const user = ukey(), list = [];
      await pool(all(), 8, async i => { const key = keyOf(user, i), part = await get(key, {keep: false}); if (part) list.push([key, part]); });
      return list;
    },
    /** Deletes every shard. True when all are gone. */
    async clear(g = S.gen) {
      pending.clear();
      const user = ukey();
      let ok = true;
      await pool(all(), 8, async i => { if (g !== S.gen || !(await del(keyOf(user, i)))) ok = false; });
      return ok;
    },
  };
}

const pathShards = lazyShards('paths', PATH_SHARDS, 'file paths');
let filesDirty = false, fileSaves = Promise.resolve(), carried = null, legacyLeft = [];

/** Stores (or with null deletes) a repo's packed file paths at the next saveFiles. */
export const setPaths = pathShards.set;
/** A repo's packed file paths, or null. */
export const readPaths = pathShards.readOne;
/** Every repo's packed paths (see lazyShards.loadAll): what a search of file names reads, on demand. */
export const loadAllPaths = pathShards.loadAll;
export const pathShardOf = pathShards.shardOf;
/** Writes the pending paths only (the upgrade of an older layout packs a lot of them before their summaries are due). */
export const savePaths = (g = S.gen) => mayWrite(g) ? pathShards.save(g) : Promise.resolve(false);
/** The summaries (S.files) changed: the next saveFiles writes them. */
export const markFiles = () => { filesDirty = true; };
function forgetFiles() { pathShards.forget(); filesDirty = false; carried = null; legacyLeft = []; }

/**
 * Writes what changed of the file lists: first the paths, then the summaries. In that order on purpose: a summary says
 * "this repo's list is stored, as of this push", so it must never reach the store before the paths it describes (a tab
 * closed in between leaves an older summary, and the repo is simply fetched again). Saves run one after another.
 */
export function saveFiles(g = S.gen) {
  const run = fileSaves.then(async () => {
    if (!mayWrite(g)) return false;
    if (!(await pathShards.save(g))) return false;   // the summaries wait for their paths
    if (!filesDirty) return true;
    if (!mayWrite(g)) return false;
    filesDirty = false;
    const ok = await put('filesum:' + ukey(), {v: FILESUM_VERSION, at: Date.now(), recs: S.files, ...(legacyLeft.length ? {old: legacyLeft} : {})});
    if (!ok) filesDirty = true;
    return ok;
  });
  fileSaves = run.catch(() => false);
  return run;
}

/**
 * Reads the file-list summaries of the profile: {recs, legacy} — `legacy`: lists stored by an older version are still to
 * be taken over (files.js upgradeFiles) — or null if the profile changed meanwhile. Without a summaries record the 64
 * shards of the older layout are looked for: nothing there either means no list was ever pulled.
 */
export async function loadFiles(g = S.gen) {
  const user = ukey(), key = 'filesum:' + user, sum = await get(key);
  if (g !== S.gen) return null;
  if (sum?.recs && typeof sum.recs === 'object') {
    legacyLeft = Array.isArray(sum.old) ? sum.old.filter(i => Number.isInteger(i) && i >= 0 && i < LEGACY_FILE_SHARDS) : [];
    info('store', `file lists: ${Object.keys(sum.recs).length.toLocaleString()} summaries read (the paths stay in their ${PATH_SHARDS} shards until a search needs them)${legacyLeft.length ? ` · ${legacyLeft.length} shard(s) of the older layout are still to be taken over` : ''}`);
    return {recs: sum.recs, legacy: legacyLeft.length > 0};
  }
  legacyLeft = [];
  if (unreadable.has(key)) return {recs: {}, legacy: false};   // unknown, not empty: nothing is taken over on top of a record that could not be read
  // Is there an older layout? Its shards are big, so they are asked about one after the other, up to the first that exists.
  for (let i = 0; i < LEGACY_FILE_SHARDS; i++) {
    const part = await get(`files:${user}:${i}`, {keep: false});
    if (g !== S.gen) return null;
    if (part || unreadable.has(`files:${user}:${i}`)) { legacyLeft = Array.from({length: LEGACY_FILE_SHARDS - i}, (_, k) => i + k); break; }
  }
  if (legacyLeft.length) info('store', `file lists: stored in the older layout (64 big shards, all read at every start): they are taken over once, into summaries and ${PATH_SHARDS} small shards of packed paths`);
  return {recs: {}, legacy: legacyLeft.length > 0};
}

/** The shards of the older layout still to take over. */
export const legacyFileShards = () => [...legacyLeft];
/** One of them: {<repo id>: {p: [paths], …}}; null when it does not exist; undefined when it could not be read (it is
 *  then left alone). */
export async function readLegacyFiles(i) {
  const key = `files:${ukey()}:${i}`, part = await get(key, {keep: false});
  return part === null && unreadable.has(key) ? undefined : part;
}
/** An older shard was taken over (or never existed): it is deleted and no longer listed. False if it could not be deleted. */
export async function dropLegacyFiles(i, existed = true) {
  if (existed && !(await del(`files:${ukey()}:${i}`))) return false;
  legacyLeft = legacyLeft.filter(x => x !== i);
  filesDirty = true;
  return true;
}

/** Deletes every stored file list of the profile: the summaries first (so nothing ever claims paths that are gone), then
 *  the paths. Call with S.files already emptied. */
export async function clearStoredFiles(g = S.gen) {
  if (!mayWrite(g)) return false;
  pathShards.forget();
  filesDirty = false;
  const user = ukey(), old = legacyLeft;
  legacyLeft = [];   // lists of the older layout that were not taken over yet go too, or the next start would bring them back
  let ok = await put('filesum:' + user, {v: FILESUM_VERSION, at: Date.now(), recs: S.files});
  for (const i of old) if (!(await del(`files:${user}:${i}`))) ok = false;
  return (await pathShards.clear(g)) && ok;
}

/** Takes the stored file paths of the profile on screen along (out of a visit's memory, or of the store being switched
 *  off): the next saveAll() writes them to the store then in use. */
export async function carryPaths() {
  carried = await pathShards.exportAll();
  if (!carried.length) carried = null;
}
