/* File lists: the name and path of every file of every starred repo (never any file content), for searching file names
  ("Also search in: Files"), the "File kinds" filters (PCB sources, Gerbers, 3D models, firmware…), has: / ext: / path:
  in the search and the file-based sort orders. What the names mean is decided in filekinds.js.

  The lists are always COMPLETE: every file path of the default branch, bundled folders included, however big the repo.
  One REST call per repo: GET /repos/{repo}/git/trees/{default branch}?recursive=1 (the whole tree in one answer). For a
  very large repo GitHub cuts that answer (100,000 entries or 7 MB, flagged "truncated"); the tree is then walked folder
  by folder as GitHub documents it (walkTree: one request per folder whose own recursive answer is cut again), so
  nothing is missing. Such a walk can need more requests than the hourly budget allows (a huge repo can hold thousands
  of folders), so the half-done walk is stored and the next run continues it where it stopped, never from the start.
  Sent with the stored ETag, so a tree that did not change answers 304, which costs nothing from the rate limit. A repo
  is looked at again only when it was pushed since, after 30 days, or when its stored list is incomplete (a walk still
  in progress, or written by an older version that capped or filtered it). Works without a token too, but 60 requests an
  hour then only covers a few repos per hour.

  Two things are kept per repo, apart (store.js "File lists"):
   · S.files[<repo id>], small and always in memory: n (how many files), s (the summary: kinds, build systems,
     extensions; filekinds.js describePacked), fv (FILES_VERSION; 1 = an older version that capped / filtered the list),
     trunc (GitHub cut the recursive answer), walked (the tree was then completed folder by folder), subs (git
     submodules), branch, etag, pushed (the repo's push date it was fetched for), at (when), miss (the HTTP status of a
     repo without a tree: 409 = empty repository, 404 = gone or private), walk ({ref, todo, requests}: a cut tree's
     folder walk still in progress), redo (stored by an older version that may have left files out: fetched again);
   · its paths, packed (paths.js), in the store only: millions of paths for a large star list, needed for nothing but
     searching file names. They are read when a search asks for them (loadPaths), dropped again when it no longer
     does (releasePaths), and written repo by repo as they are fetched. */
import {S, rkey} from './state.js';
import {DAY, status, secs, pool, sleep, chunks} from './util.js';
import {plan, start, report, finish} from './progress.js';
import {gh, isFatalError, needToken, readBudget} from './github.js';
import {waitForRefill, waitSlowDown, slowDownOver, budgetNow, budgetLine, refillText} from './budget.js';
import {saveFiles, savePaths, markFiles, setPaths, readPaths, loadAllPaths, pathShardOf, clearStoredFiles, legacyFileShards, readLegacyFiles, dropLegacyFiles, PATH_SHARDS} from './store.js';
import {debug, info, warn} from './log.js';
import {describePacked, staleSummary} from './filekinds.js';
import {packPaths, unpackPaths, lowerPack, findPath, pathAt, EMPTY} from './paths.js';

/** 2: lists are complete (no cap, no folder left out, truncated trees walked). */
export const FILES_VERSION = 2;
const MAX_AGE = 30 * DAY, PARALLEL = 10;
const spread = r => ((r.id || 0) % 7) * DAY;

/**
 * Is a stored list possibly incomplete? A folder walk still in progress, cut by the old 50,000-path cap, truncated by
 * GitHub and not walked, or written by version 1 in a repo where it may have left folders out (`redo`, see
 * legacyIncomplete). Such a list is fetched again, whole, without its ETag.
 */
export const incomplete = rec => !!rec && !rec.miss && (!!rec.walk || !!rec.cut || (!!rec.trunc && !rec.walked) || !!rec.redo);
/** A list written by version 1, which left out node_modules/, bower_components/ and vendor/bundle/, in a repo that can
 *  have those folders (it has a package.json, bower.json or Gemfile). `paths`: its stored paths. */
export const legacyIncomplete = (rec, paths) => !rec.miss && (rec.fv || 1) < FILES_VERSION && paths.some(x => /(?:^|\/)(?:package\.json|bower\.json|Gemfile)$/.test(x));

/** Does this repo's file list need a look? Never fetched, incomplete, pushed since, or checked over a month ago. */
export const needsFiles = (r, rec = S.files[rkey(r)]) => !rec || incomplete(rec) || rec.pushed !== r.pushed || Date.now() - (rec.at || 0) > MAX_AGE + spread(r);

/** Of `repos`: how many have a file list, and how many files those hold. */
export function fileTotals(repos = S.repos) {
  let repoCount = 0, files = 0;
  for (const r of repos) { const rec = S.files[rkey(r)]; if (rec) { repoCount++; files += rec.n || 0; } }
  return {repos: repoCount, files};
}

// ---- the paths, in memory only while a search needs them ----
let held = null, heldGen = -1;           // Map(repo id → packed paths) of the profile of generation heldGen
let loading = null, loadingGen = -1;     // a load in progress
let changedMeanwhile = null;             // lists that changed while a load was reading the store

/** Are every repo's paths in memory, ready to be searched? */
export const pathsReady = () => !!held && heldGen === S.gen;
/** Lets the paths go (they are read again when a search asks). */
export function releasePaths() {
  if (held) debug('files', `the file paths of ${held.size.toLocaleString()} repos were let go from memory (read again when a search needs them)`);
  held = null; heldGen = -1;
}
/** Reads every repo's paths into memory, for searching file names. Resolves true when they are ready.
 *  `onProgress(fraction)`: how far the reading is, 0…1 (the status line is left alone: it belongs to the running job). */
export function loadPaths(onProgress = null) {
  if (pathsReady()) return Promise.resolve(true);
  if (loading && loadingGen === S.gen) return loading;
  const g = S.gen, t0 = performance.now();
  loadingGen = g;
  changedMeanwhile = new Map();
  debug('files', `a search looks at file names: reading the paths of ${Object.keys(S.files).length.toLocaleString()} repos from their ${PATH_SHARDS} shards`);
  onProgress?.(0);
  const p = loading = (async () => {
    const got = await loadAllPaths(g, (done, total) => { if (g === S.gen && done % 32 === 0) onProgress?.(Math.min(0.99, done / total)); });
    if (!got || g !== S.gen) return false;
    for (const [k, packed] of changedMeanwhile) { if (packed) got.out.set(k, packed); else got.out.delete(k); }
    held = got.out; heldGen = g;
    const files = fileTotals().files;
    (got.failed ? warn : info)('files', `file paths in memory for the search: ${held.size.toLocaleString()} repos, ${files.toLocaleString()} files, read from ${PATH_SHARDS} shards in ${secs(t0)}${got.failed ? ` · ⚠ ${got.failed} shard(s) could not be read: their repos are not searched` : ''}`);
    if (got.failed) status(`⚠ ${got.failed} part(s) of the file lists could not be read: the file names of their repos are not searched. Reload the page to try again.`);
    return true;
  })().finally(() => { if (loading === p) { loading = null; changedMeanwhile = null; } onProgress?.(1); });
  return p;
}
/** A repo's paths changed (null: they are gone): stored at the next saveFiles, and known to the search at once. */
function putPaths(k, packed) {
  setPaths(k, packed);
  if (pathsReady()) { if (packed) held.set(k, packed); else held.delete(k); }
  else if (loading && loadingGen === S.gen) changedMeanwhile?.set(k, packed);
}
const heldFor = r => pathsReady() ? held.get(rkey(r)) : null;
/** The first path of the repo containing `term` (lower-cased), as git has it; null when none does or the paths are
 *  not in memory. */
export function pathHit(r, term) {
  const packed = heldFor(r), hit = packed ? findPath(lowerPack(packed), term) : null;
  return hit ? pathAt(packed, hit) : null;
}
/** Does a path of the repo contain `term` (lower-cased)? */
export const pathHas = (r, term) => { const packed = heldFor(r); return !!packed && !!findPath(lowerPack(packed), term); };
/** Every stored path of one repo (read from the store when the lists are not in memory). */
export async function pathsOf(r) { return unpackPaths(heldFor(r) ?? await readPaths(rkey(r))); }

/** A tree answer ({tree: [{path, type}], truncated}) → {rec: the summary record, packed: every file path, nothing left out}. */
export function toRecord(r, tree, etag, {walked = false} = {}) {
  const entries = tree.tree || [], paths = entries.filter(x => x.type === 'blob').map(x => x.path), packed = packPaths(paths);
  return {packed, rec: {n: paths.length, fv: FILES_VERSION, trunc: !!tree.truncated, walked, subs: entries.filter(x => x.type === 'commit').length,
    s: describePacked(packed), branch: r.branch || null, etag: etag || null, pushed: r.pushed, at: Date.now()}};
}
/** Puts a repo's file list in place: its record in S.files, its paths on their way to the store. */
export function setFileList(k, rec, packed) {
  S.files[k] = rec;
  putPaths(k, rec.n ? packed : null);
  markFiles();
}
/** Forgets a repo's file list (it was unstarred, or removed by hand). True when there was one. */
export function forgetFileList(k) {
  if (!S.files[k]) return false;
  delete S.files[k];
  putPaths(k, null);
  markFiles();
  return true;
}

/**
 * The complete tree of a repo whose recursive answer GitHub truncated: `paths` grows as the walk goes and the folders
 * still to visit wait in rec.walk.todo, so a walk interrupted by a used-up budget (or a closed tab) keeps its progress
 * and the next run continues it where it stopped. The root is walked without recursion, then each sub-folder
 * recursively; a sub-folder whose answer is truncated again is walked the same way, one level down.
 * `onFolder(prefix, files, entries)` is called for every folder visited. Throws what gh() throws (a used-up budget: the
 * caller waits and continues the walk).
 */
export async function walkTree(r, rec, paths, onFolder) {
  const w = rec.walk;
  w.requests ??= 0;
  w.todo ??= [{sha: w.ref, prefix: '', recursive: false}];
  while (w.todo.length) {
    const {sha, prefix, recursive} = w.todo[0];
    const res = await gh(`/repos/${r.full}/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`);
    w.requests++;
    if (res.status === 404) throw new Error(`GitHub 404 for a folder of ${r.full}${prefix ? ` (${prefix})` : ''}`);
    const d = await res.json();
    w.todo.shift();   // only now: a walk interrupted above resumes with this folder still in the queue
    if (recursive && d.truncated) { w.todo.unshift({sha, prefix, recursive: false}); continue; }   // still too big: one level at a time
    let files = 0;
    for (const x of d.tree || []) {
      const path = prefix + x.path;
      if (x.type === 'tree') { if (!recursive) w.todo.push({sha: x.sha, prefix: path + '/', recursive: true}); }
      else if (x.type === 'blob') { paths.push(path); files++; }
      else rec.subs = (rec.subs || 0) + 1;
    }
    rec.n = paths.length;
    onFolder?.(prefix, files, (d.tree || []).length);
  }
  return paths;
}

/**
 * Fetches the file lists of `todo`. `quiet`: part of a bigger job (Check for updates owns the plan and the status line).
 * A folder walk that the budget (or a closed tab) interrupted is continued where it stopped, not restarted. Returns
 * {got, same, failed, fatal, summary}.
 */
export async function fetchFiles(g, todo, {quiet = false} = {}) {
  if (!todo.length) { finish('files', 'all up to date'); return {got: 0, same: 0, failed: 0, summary: 'file lists up to date (0 requests)'}; }
  start('files', todo.length);
  if (!S.token && todo.length > 50 && !quiet) status(`⚠ ${todo.length} file lists to fetch but only ~60 requests/hour without a token. Add one in the 🔑 panel.`);
  info('files', `file lists: ${todo.length.toLocaleString()} repo(s) to look at · one request each (GET /repos/…/git/trees/<branch>?recursive=1, names only, nothing downloaded), ${PARALLEL} at a time · an unchanged tree answers 304 (free)`);
  let done = 0, got = 0, same = 0, failed = 0, fatal = null, lastSave = Date.now();
  const said = rec => { const kinds = Object.entries(rec.s.kinds).map(([key, c]) => `${key} ${c}`).join(', '); return `${kinds ? ' · ' + kinds : ''}${rec.s.build.length ? ' · ' + rec.s.build.join(', ') : ''}`; };
  /** Runs a cut tree's folder walk (walkTree) to the end, logging every folder and saving as it goes, then turns the
   *  record into a finished one. An interruption (used-up budget, a bad answer) keeps what was collected: it is stored
   *  as it is and the next run continues the walk. */
  const finishWalk = async (r, k, rec, paths) => {
    let saved = Date.now();
    const keep = () => { rec.n = paths.length; putPaths(k, paths.length ? packPaths(paths) : null); markFiles(); };
    try {
      await walkTree(r, rec, paths, (prefix, files, entries) => {
        debug('files', `${r.full}: walked ${prefix || 'the root'}: +${files} file(s) in ${entries.toLocaleString()} entr${entries === 1 ? 'y' : 'ies'} → ${paths.length.toLocaleString()} file(s) so far, ${rec.walk.todo.length.toLocaleString()} folder(s) left`);
        report('files', done, todo.length, `${done.toLocaleString()} of ${todo.length.toLocaleString()} repos · ${r.full}: walking ${prefix || 'the root'} (${paths.length.toLocaleString()} files so far, ${rec.walk.todo.length.toLocaleString()} folders left)`);
        if (Date.now() - saved > 10_000) { saved = Date.now(); keep(); saveFiles(g); }   // a long walk keeps its progress
      });
    } catch (e) {
      keep();   // the half-done walk is kept and continued by the next run, not restarted
      if (g === S.gen) await saveFiles(g);
      if (e.rateLimited) info('files', `${r.full}: the budget ran out mid-walk after ${rec.walk.requests.toLocaleString()} request(s): ${paths.length.toLocaleString()} file(s) kept, the walk continues from there when the budget allows`);
      throw e;
    }
    if (g !== S.gen) return;
    delete rec.walk;
    const packed = packPaths(paths);
    Object.assign(rec, {walked: true, fv: FILES_VERSION, s: describePacked(packed), n: paths.length, at: Date.now()});
    putPaths(k, paths.length ? packed : null);
    markFiles();
    got++;
    info('files', `${r.full}: ${rec.n.toLocaleString()} files (complete: walked folder by folder)${said(rec)} · https://github.com/${r.full}/tree/${r.branch || 'HEAD'}`);
  };
  /** A repo GitHub has no tree for: remembered, not asked again every time. */
  const setMiss = (r, k, code) => setFileList(k, {n: 0, s: describePacked(EMPTY), miss: code, branch: r.branch || null, pushed: r.pushed, at: Date.now()}, null);
  /** Fetches one repo's tree. Throws what gh() throws (rate limit, network, other statuses). */
  const fetchOne = async r => {
    const k = rkey(r), old = S.files[k];
    // A walk that the budget (or a closed tab) interrupted continues where it stopped — unless the repo was pushed since.
    if (old?.walk) {
      if (old.pushed === r.pushed) {
        const soFar = unpackPaths(await readPaths(k));
        if (g !== S.gen) return;
        await finishWalk(r, k, old, soFar);
        return;
      }
      debug('files', `${r.full}: pushed since the interrupted walk: starting it over`);
    }
    const ref = encodeURIComponent(r.branch || 'HEAD');
    // An incomplete stored list must come back whole: no ETag then (a 304 would keep it as it is).
    const etag = old?.etag && old.branch === (r.branch || null) && !incomplete(old) ? {'If-None-Match': old.etag} : {};
    const res = await gh(`/repos/${r.full}/git/trees/${ref}?recursive=1`, etag);
    if (g !== S.gen) return;
    if (res.status === 304) { S.files[k] = {...old, pushed: r.pushed, at: Date.now()}; markFiles(); same++; debug('files', `${r.full}: file list unchanged (304, free)`); }   // only the record: its paths stay where they are
    else if (res.status === 404) { setMiss(r, k, 404); debug('files', `${r.full}: no tree (404: empty, private or gone)`); }
    else {
      const tree = await res.json();
      if (g !== S.gen) return;
      if (tree.truncated) {   // GitHub cut the answer (a very large repo): complete it folder by folder
        info('files', `${r.full}: GitHub cut the list at ${(tree.tree || []).length.toLocaleString()} entries: walking the tree folder by folder to get every file`);
        // The record exists during the walk and is saved as it goes, so an interrupted run keeps its progress.
        const rec = {n: 0, subs: 0, trunc: true, walked: false, fv: FILES_VERSION, s: describePacked(EMPTY), branch: r.branch || null,
          etag: res.headers.get('ETag'), pushed: r.pushed, at: Date.now(), walk: {ref: tree.sha || r.branch || 'HEAD', requests: 0}};
        S.files[k] = rec;
        markFiles();
        await finishWalk(r, k, rec, []);
      } else {
        const {rec, packed} = toRecord(r, tree, res.headers.get('ETag'));
        setFileList(k, rec, packed);
        got++;
        info('files', `${r.full}: ${rec.n.toLocaleString()} files${said(rec)} · https://github.com/${r.full}/tree/${r.branch || 'HEAD'}`);
      }
    }
  };
  let cap = PARALLEL, inFlight = 0, lastPause = null;   // requests at once: halved each time GitHub asks to slow down
  await pool(todo, PARALLEL, async r => {
    while (inFlight >= cap && !(fatal || S.stop || g !== S.gen)) await sleep(100);
    if (fatal || S.stop || g !== S.gen) return;
    inFlight++;
    try { for (;;) {
      try { await fetchOne(r); slowDownOver(); }
      catch (e) {
        // Out of budget: wait for the hourly refill (Cancel stops the wait) and ask again; it ends the pull only when
        // waiting is impossible (refill time unknown or over an hour away).
        if (e.rateLimited && await waitForRefill(e, g, `File lists ${done.toLocaleString()}/${todo.length.toLocaleString()}`)) continue;
        // "Slow down" (secondary limit, budget left): one shared pause, then on with fewer requests at a time. If GitHub
        // keeps saying so the pull ends here with its progress saved, instead of failing every repo that is left.
        if (e.secondary) {
          const pause = waitSlowDown(e, g, `File lists ${done.toLocaleString()}/${todo.length.toLocaleString()}`);
          if (pause !== lastPause) { lastPause = pause; cap = Math.max(1, Math.floor(cap / 2)); }   // once per pause, however many workers share it
          if (await pause) continue;
          if (!S.stop && g === S.gen) fatal = e;
          break;
        }
        if (isFatalError(e)) fatal = e;
        else if (/GitHub (409|422|451)/.test(e.message) || (e.status === 403 && /blocked|disabled|taken down|dmca/i.test(e.detail || ''))) {   // 409: an empty repository · 422 / 451 / a blocked repo: no tree to give
          if (g === S.gen) setMiss(r, rkey(r), e.status || Number(e.message.slice(-3)));
          debug('files', `${r.full}: no files (${e.message}${e.detail ? ': ' + e.detail : ''})`);
        } else { failed++; warn('files', `${r.full}: file list failed (${e.message}), tried again next time`); }
      }
      break;
    } } finally { inFlight--; }
    if (g !== S.gen) return;
    done++;
    report('files', done, todo.length, `${done.toLocaleString()} of ${todo.length.toLocaleString()} repos · ${got.toLocaleString()} fetched, ${same.toLocaleString()} unchanged`);
    if (!quiet && done % 25 === 0) status(`File lists ${done}/${todo.length}…`);
    if (Date.now() - lastSave > 10_000) { lastSave = Date.now(); await saveFiles(g); }   // a long run keeps its progress
  });
  if (g === S.gen && done === todo.length) finish('files');
  if (g === S.gen) await saveFiles(g);
  const t = fileTotals();
  info('files', `file lists: ${got} fetched, ${same} unchanged, ${failed} failed${fatal ? ', stopped: ' + fatal.message : S.stop ? ', stopped by Cancel' : ''} · ${t.files.toLocaleString()} files known in ${t.repos.toLocaleString()} repos`);
  return {got, same, failed, fatal, summary: `📁 ${t.files.toLocaleString()} files listed in ${t.repos.toLocaleString()} repos (${got} fetched, ${same} unchanged)` +
    (failed ? ` · ${failed} failed (retried next time)` : '') + (S.stop && done < todo.length ? ' · ■ stopped, progress saved: click again to continue' : '') +
    (fatal ? ` · ⚠ ${fatal.message} · ${done.toLocaleString()} of ${todo.length.toLocaleString()} done, progress saved: click 📁 Files again then to continue` : '')};
}

/** Toolbar button "📁 Files": the file list of every star that needs one. `planned`: part of "Pull all", whose steps
 *  are already on screen. Returns the summary (the caller redraws the list). */
export async function indexFiles(g, {planned = false} = {}) {
  const live = S.repos.filter(r => !r.gone), todo = live.filter(r => needsFiles(r));
  info('files', `Pull file lists: ${todo.length.toLocaleString()} of ${live.length.toLocaleString()} repos need a look (never fetched, pushed since, or over a month old)`);
  if (!S.token && todo.length > 60) needToken();
  const t0 = performance.now();
  // The real budget left (other tabs and scripts count too): say up front whether the pull will have to wait for a refill.
  await readBudget();
  const b = budgetNow('core');
  info('files', `budget before the pull: ${budgetLine('core')} · ${todo.length.toLocaleString()} request(s) needed (fewer when trees did not change)`);
  if (b && todo.length > b.remaining) status(`📁 ${todo.length.toLocaleString()} file lists to fetch, ${b.remaining.toLocaleString()} REST requests left this hour: the pull pauses when they run out and continues by itself when ${refillText('core').replace(/^it /, 'the budget ')}…`);
  if (!planned) plan([['files']]);
  const {summary} = await fetchFiles(g, todo);
  if (g !== S.gen) return '';
  status(`${summary} · ${secs(t0)}`);
  return summary;
}

/** Forgets every file list of this profile (the 🗑 of the Files menu). */
export async function clearFiles(g) {
  const n = Object.keys(S.files).length;
  S.files = {};
  releasePaths();
  await clearStoredFiles(g);
  info('files', `file lists cleared: ${n.toLocaleString()} repos' lists deleted`);
  return n;
}

// ---- lists stored by an older version, and summaries written by older rules ----
/** Is there something for upgradeFiles to do? */
export const filesNeedUpgrade = () => legacyFileShards().length > 0 || Object.values(S.files).some(staleSummary);
const breathe = () => new Promise(resolve => setTimeout(resolve));

/**
 * Brings what is stored up to date, without a single request to GitHub:
 *  1. lists kept by an older version (64 big shards of plain path arrays, all read at every start) are taken over,
 *     shard by shard: paths packed into the small shards, summaries computed with today's rules. An old shard is
 *     deleted only once everything it held is safely stored in the new form, so stopping at any point (Cancel, a
 *     closed tab) loses nothing and the next start continues.
 *  2. summaries written by older rules (filekinds.js KINDS_VERSION) are computed again from the stored paths.
 * Returns a line for the status, '' when there was nothing to do.
 */
export async function upgradeFiles(g) {
  const t0 = performance.now(), legacy = legacyFileShards();
  let repos = 0, files = 0, slice = performance.now();
  const pause = async () => { if (performance.now() - slice < 30) return; await breathe(); slice = performance.now(); };   // the page stays usable
  if (legacy.length) {
    plan([['upgrade', 'Upgrade the stored file lists (once)']]);
    start('upgrade', legacy.length);
    status('📁 Upgrading the stored file lists to the lighter format (once, no download)…');
    info('files', `upgrade: ${legacy.length} shard(s) of the older layout to take over (paths packed, summaries computed with today's rules; nothing is downloaded)`);
    let done = 0;
    // Old shards whose lists are packed and written, waiting for their summaries to be stored: only then do they go.
    // (A few at a time: the summaries record is written once for all of them, not once per shard.)
    const taken = [];
    const settle = async () => {
      if (!taken.length) return true;
      markFiles();
      if (!(await saveFiles(g))) return false;
      for (const [i, existed] of taken.splice(0)) {
        if (g === S.gen && !(await dropLegacyFiles(i, existed))) warn('files', `upgrade: old shard ${i} was taken over but could not be deleted; tried again at the next start`);
      }
      return true;
    };
    for (const i of legacy) {
      if (g !== S.gen) return '';
      if (S.stop) break;
      const part = await readLegacyFiles(i);
      if (g !== S.gen) return '';
      if (part === undefined) { warn('files', `upgrade: old shard ${i} could not be read: it is left as it is and tried again at the next start`); done++; continue; }
      if (part) {
        for (const [k, old] of Object.entries(part)) {
          if (!old || typeof old !== 'object') continue;
          const cur = S.files[k];
          if (cur && (cur.at || 0) >= (old.at || 0)) continue;   // taken over already (an interrupted upgrade), or fetched again since
          const {p, s, ...rec} = old, paths = Array.isArray(p) ? p : [], packed = packPaths(paths);
          rec.n = paths.length;
          rec.s = describePacked(packed);
          if (legacyIncomplete(old, paths)) rec.redo = true;
          setFileList(k, rec, packed);
          repos++; files += paths.length;
          await pause();
          if (g !== S.gen) return '';
        }
        if (!(await savePaths(g))) { warn('files', `upgrade: the lists of old shard ${i} could not be saved: it is kept, and the upgrade continues at the next start`); break; }   // their memory is free again
      }
      taken.push([i, !!part]);
      if (taken.length >= 8 && !(await settle())) { warn('files', 'upgrade: the summaries could not be saved: the old shards are kept, and the upgrade continues at the next start'); break; }
      done++;
      report('upgrade', done, legacy.length, `${done} of ${legacy.length} parts · ${repos.toLocaleString()} repos, ${files.toLocaleString()} files`);
    }
    if (g !== S.gen) return '';
    await settle();
    markFiles();
    await saveFiles(g);
    if (!legacyFileShards().length) finish('upgrade', `${repos.toLocaleString()} repos, ${files.toLocaleString()} files`);
    info('files', `upgrade: ${repos.toLocaleString()} file lists (${files.toLocaleString()} files) taken over in ${secs(t0)}${legacyFileShards().length ? ` · ${legacyFileShards().length} old shard(s) left for the next start` : ' · the older layout is gone'}`);
  }
  // Summaries of older rules: read the paths shard by shard (a few at a time, never all in memory) and compute again.
  const stale = Object.keys(S.files).filter(k => staleSummary(S.files[k]));
  let renewed = 0;
  if (stale.length && g === S.gen && !S.stop) {
    info('files', `upgrade: ${stale.length.toLocaleString()} summaries were written by older rules: computing them again from the stored paths (no download)`);
    status(`📁 Reading ${stale.length.toLocaleString()} file lists again with the new rules (no download)…`);
    const byShard = new Map();
    for (const k of stale) { const i = pathShardOf(k); let list = byShard.get(i); if (!list) byShard.set(i, list = []); list.push(k); }
    let lastSave = Date.now();
    for (const group of chunks([...byShard.keys()], 32)) {
      if (g !== S.gen) return '';
      if (S.stop) break;
      const want = new Set(group), got = await loadAllPaths(g, null, i => want.has(i));
      if (!got) return '';
      for (const i of group) for (const k of byShard.get(i)) {
        const rec = S.files[k], packed = got.out.get(k);
        if (!rec) continue;
        // A list whose paths are not in the store can't be read again: it is fetched again at the next pull.
        S.files[k] = packed || !rec.n ? {...rec, s: describePacked(packed || EMPTY)} : {...rec, s: {...describePacked(EMPTY), kinds: rec.s?.kinds || {}, build: rec.s?.build || []}, redo: true};
        renewed++;
        await pause();
        if (g !== S.gen) return '';
      }
      markFiles();
      if (Date.now() - lastSave > 10_000) { lastSave = Date.now(); await saveFiles(g); }
    }
    if (g !== S.gen) return '';
    await saveFiles(g);
    info('files', `upgrade: ${renewed.toLocaleString()} summaries computed again in ${secs(t0)}`);
  }
  if (!repos && !renewed) return '';
  const line = `📁 File lists upgraded: ${[repos && `${repos.toLocaleString()} lists (${files.toLocaleString()} files) moved to the lighter format`, renewed && `${renewed.toLocaleString()} read again with the new rules`].filter(Boolean).join(' · ')} · ${secs(t0)}`;
  status(line);
  return line;
}
