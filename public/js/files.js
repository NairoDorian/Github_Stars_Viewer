/* File lists: the name and path of every file of every starred repo (never any file content), for searching file names
  ("Also search in: Files"), the "File kinds" filters (PCB sources, Gerbers, 3D models, firmware…), has: / ext: / path:
  in the search and the file-based sort orders. What the names mean is decided in filekinds.js.

  The lists are always COMPLETE: every file path of the default branch, vendored folders included, however big the repo.
  One REST call per repo: GET /repos/{repo}/git/trees/{default branch}?recursive=1 (the whole tree in one answer). For a
  very large repo GitHub cuts that answer (100,000 entries or 7 MB, flagged "truncated"); the tree is then walked folder
  by folder as GitHub documents it (walkTree: one request per folder whose own recursive answer is cut again), so
  nothing is missing. Such a walk can need more requests than the hourly budget allows (a huge repo can hold thousands
  of folders), so the half-done walk is stored with the file lists and the next run continues it where it stopped,
  never from the start. Sent with the stored ETag, so a tree that did not change answers 304, which costs nothing from
  the rate limit. A repo is looked at again only when it was pushed since, after 30 days, or when its stored list is
  incomplete (a walk still in progress, or written by an older version that capped or filtered it). Works without a
  token too, but 60 requests an hour then only covers a few repos per hour.

  Per repo (S.files[<repo id>], stored in 64 shards, see store.js):
    p  every file path (blobs) · fv: FILES_VERSION (1 = an older version that capped / filtered the list)
    n  how many files · trunc: GitHub cut the recursive answer · walked: the tree was then completed folder by folder
    s  the summary (kinds, build systems, extensions; filekinds.js describe) · subs: git submodules
    branch, etag, pushed (the repo's push date it was fetched for), at (when) · miss: the HTTP status of a repo without a
    tree (409 = empty repository, 404 = gone or private) · walk: {ref, todo, requests} a cut tree's folder walk still in
    progress — the record stays incomplete until the walk is finished */
import {S, rkey, bumpIndex} from './state.js';
import {$, DAY, status, secs, pool} from './util.js';
import {plan, start, report, finish} from './progress.js';
import {gh, isFatalError, needToken, readBudget} from './github.js';
import {waitForRefill, budgetNow, budgetLine, refillText} from './budget.js';
import {saveFiles, markFiles, markAllFiles} from './store.js';
import {debug, info, warn} from './log.js';
import {describe} from './filekinds.js';
import {render} from './list.js';

/** 2: lists are complete (no cap, no folder left out, truncated trees walked). */
export const FILES_VERSION = 2;
const MAX_AGE = 30 * DAY, PARALLEL = 10;
const spread = r => ((r.id || 0) % 7) * DAY;

/**
 * Is a stored list possibly incomplete? A folder walk still in progress, cut by the old 50,000-path cap, truncated by
 * GitHub and not walked, or written by version 1 (which left out node_modules/, bower_components/ and vendor/bundle/)
 * in a repo that can have those folders (it has a package.json, bower.json or Gemfile). Such a list is fetched again,
 * whole, without its ETag.
 */
export const incomplete = rec => !!rec && !rec.miss && (!!rec.walk || rec.cut || (rec.trunc && !rec.walked) ||
  ((rec.fv || 1) < FILES_VERSION && (rec.p || []).some(x => /(?:^|\/)(?:package\.json|bower\.json|Gemfile)$/.test(x))));

/** Does this repo's file list need a look? Never fetched, incomplete, pushed since, or checked over a month ago. */
export const needsFiles = (r, rec = S.files[rkey(r)]) => !rec || incomplete(rec) || rec.pushed !== r.pushed || Date.now() - (rec.at || 0) > MAX_AGE + spread(r);

/** Of `repos`: how many have a file list, and how many files those hold. */
export function fileTotals(repos = S.repos) {
  let repoCount = 0, files = 0;
  for (const r of repos) { const rec = S.files[rkey(r)]; if (rec) { repoCount++; files += rec.n || 0; } }
  return {repos: repoCount, files};
}

/** A tree answer ({tree: [{path, type}], truncated}) → the stored record: every file, nothing left out. */
export function toRecord(r, tree, etag, {walked = false} = {}) {
  const entries = tree.tree || [], p = entries.filter(x => x.type === 'blob').map(x => x.path);
  return {p, n: p.length, fv: FILES_VERSION, trunc: !!tree.truncated, walked, subs: entries.filter(x => x.type === 'commit').length,
    s: describe(p), branch: r.branch || null, etag: etag || null, pushed: r.pushed, at: Date.now()};
}

/**
 * The complete tree of a repo whose recursive answer GitHub truncated, filled into `rec`: the record is updated as the
 * walk goes — every path found so far in rec.p, the folders still to visit in rec.walk.todo — so a walk interrupted by a
 * used-up budget (or a closed tab) keeps its progress and the next run continues it where it stopped. The root is
 * walked without recursion, then each sub-folder recursively; a sub-folder whose answer is truncated again is walked
 * the same way, one level down. `onFolder(prefix, files, entries)` is called for every folder visited. Returns `rec`.
 * Throws what gh() throws (a used-up budget: the caller waits and continues the walk).
 */
export async function walkTree(r, rec, onFolder) {
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
      else if (x.type === 'blob') { rec.p.push(path); files++; }
      else rec.subs = (rec.subs || 0) + 1;
    }
    rec.n = rec.p.length;
    onFolder?.(prefix, files, (d.tree || []).length);
  }
  return rec;
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
  /** Runs a cut tree's folder walk (walkTree) to the end, logging every folder and saving as it goes, then turns the
   *  record into a finished one. An interruption (used-up budget, a bad answer) keeps what was collected: the record is
   *  saved as it is and the next run continues the walk. */
  const finishWalk = async (r, k, rec) => {
    let saved = Date.now();
    try {
      await walkTree(r, rec, (prefix, files, entries) => {
        debug('files', `${r.full}: walked ${prefix || 'the root'}: +${files} file(s) in ${entries.toLocaleString()} entr${entries === 1 ? 'y' : 'ies'} → ${rec.p.length.toLocaleString()} file(s) so far, ${rec.walk.todo.length.toLocaleString()} folder(s) left`);
        report('files', done, todo.length, `${done.toLocaleString()} of ${todo.length.toLocaleString()} repos · ${r.full}: walking ${prefix || 'the root'} (${rec.p.length.toLocaleString()} files so far, ${rec.walk.todo.length.toLocaleString()} folders left)`);
        if (Date.now() - saved > 10_000) { saved = Date.now(); markFiles(k); saveFiles(g); }   // a long walk keeps its progress
      });
    } catch (e) {
      markFiles(k);   // the half-done walk is kept and continued by the next run, not restarted
      if (g === S.gen) await saveFiles(g);
      if (e.rateLimited) info('files', `${r.full}: the budget ran out mid-walk after ${rec.walk.requests.toLocaleString()} request(s): ${rec.p.length.toLocaleString()} file(s) kept, the walk continues from there when the budget allows`);
      throw e;
    }
    if (g !== S.gen) return;
    delete rec.walk;
    Object.assign(rec, {walked: true, fv: FILES_VERSION, s: describe(rec.p), n: rec.p.length, at: Date.now()});
    got++;
    const kinds = Object.entries(rec.s.kinds).map(([key, c]) => `${key} ${c}`).join(', ');
    info('files', `${r.full}: ${rec.n.toLocaleString()} files (complete: walked folder by folder)${kinds ? ' · ' + kinds : ''}${rec.s.build.length ? ' · ' + rec.s.build.join(', ') : ''} · https://github.com/${r.full}/tree/${r.branch || 'HEAD'}`);
  };
  /** Fetches one repo's tree into S.files. Throws what gh() throws (rate limit, network, other statuses). */
  const fetchOne = async r => {
    const k = rkey(r), old = S.files[k];
    // A walk that the budget (or a closed tab) interrupted continues where it stopped — unless the repo was pushed since.
    if (old?.walk) {
      if (old.pushed === r.pushed) { await finishWalk(r, k, old); markFiles(k); return; }
      debug('files', `${r.full}: pushed since the interrupted walk: starting it over`);
    }
    const ref = encodeURIComponent(r.branch || 'HEAD');
    // An incomplete stored list must come back whole: no ETag then (a 304 would keep it as it is).
    const etag = old?.etag && old.branch === (r.branch || null) && !incomplete(old) ? {'If-None-Match': old.etag} : {};
    const res = await gh(`/repos/${r.full}/git/trees/${ref}?recursive=1`, etag);
    if (g !== S.gen) return;
    if (res.status === 304) { S.files[k] = {...old, pushed: r.pushed, at: Date.now()}; same++; debug('files', `${r.full}: file list unchanged (304, free)`); }
    else if (res.status === 404) { S.files[k] = {p: [], n: 0, s: describe([]), miss: 404, branch: r.branch || null, pushed: r.pushed, at: Date.now()}; debug('files', `${r.full}: no tree (404: empty, private or gone)`); }
    else {
      const tree = await res.json();
      if (tree.truncated) {   // GitHub cut the answer (a very large repo): complete it folder by folder
        info('files', `${r.full}: GitHub cut the list at ${(tree.tree || []).length.toLocaleString()} entries: walking the tree folder by folder to get every file`);
        // The record exists during the walk and is saved as it goes, so an interrupted run keeps its progress.
        const rec = {p: [], n: 0, subs: 0, trunc: true, walked: false, fv: FILES_VERSION, s: describe([]), branch: r.branch || null,
          etag: res.headers.get('ETag'), pushed: r.pushed, at: Date.now(), walk: {ref: tree.sha || r.branch || 'HEAD', requests: 0}};
        S.files[k] = rec;
        await finishWalk(r, k, rec);
      } else {
        const rec = toRecord(r, tree, res.headers.get('ETag'));
        if (g !== S.gen) return;
        S.files[k] = rec; got++;
        const kinds = Object.entries(rec.s.kinds).map(([key, c]) => `${key} ${c}`).join(', ');
        info('files', `${r.full}: ${rec.n.toLocaleString()} files${kinds ? ' · ' + kinds : ''}${rec.s.build.length ? ' · ' + rec.s.build.join(', ') : ''} · https://github.com/${r.full}/tree/${r.branch || 'HEAD'}`);
      }
    }
    markFiles(k);
  };
  await pool(todo, PARALLEL, async r => {
    if (fatal || S.stop || g !== S.gen) return;
    for (;;) {
      try { await fetchOne(r); }
      catch (e) {
        // Out of budget: wait for the hourly refill (Cancel stops the wait) and ask again; it ends the pull only when
        // waiting is impossible (refill time unknown or over an hour away).
        if (e.rateLimited && await waitForRefill(e, g, `File lists ${done.toLocaleString()}/${todo.length.toLocaleString()}`)) continue;
        if (isFatalError(e)) fatal = e;
        else if (/GitHub (409|422|451)/.test(e.message)) {   // 409: an empty repository · 422 / 451: no tree to give
          const k = rkey(r);
          S.files[k] = {p: [], n: 0, s: describe([]), miss: Number(e.message.slice(-3)), branch: r.branch || null, pushed: r.pushed, at: Date.now()};
          markFiles(k);
          debug('files', `${r.full}: no files (${e.message}: an empty repository)`);
        } else { failed++; warn('files', `${r.full}: file list failed (${e.message}), tried again next time`); }
      }
      break;
    }
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

/** Toolbar button "📁 Files": the file list of every star that needs one, then searching file names is turned on.
 *  `planned`: part of "Pull all", whose steps are already on screen. Returns the summary. */
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
  $('#inFiles').checked = true;
  bumpIndex();
  render();
  status(`${summary} · ${secs(t0)}`);
  return summary;
}

/** Forgets every file list of this profile (the 🗑 of the Files menu). */
export async function clearFiles(g) {
  const n = Object.keys(S.files).length;
  S.files = {};
  markAllFiles();
  await saveFiles(g);
  info('files', `file lists cleared: ${n.toLocaleString()} repos' lists deleted`);
  return n;
}
