/* File lists: the name and path of every file of every starred repo (never any file content), for searching file names
  ("Also search in: Files"), the "File kinds" filters (PCB sources, Gerbers, 3D models, firmware…), has: / ext: / path:
  in the search and the file-based sort orders. What the names mean is decided in filekinds.js.

  One REST call per repo: GET /repos/{repo}/git/trees/{default branch}?recursive=1 (the whole tree in one answer; GitHub
  stops at 100,000 entries, which it says: "truncated"). Sent with the stored ETag, so a tree that did not change answers
  304, which costs nothing from the rate limit. A repo is looked at again only when it was pushed since, or after 30
  days. Works without a token too, but 60 requests an hour then only covers a few repos per hour.

  Per repo (S.files[<repo id>], stored in 64 shards, see store.js):
    p  the file paths (blobs; vendored folders such as node_modules left out), at most MAX_PATHS
    n  how many files the tree has · cut: p holds only the first MAX_PATHS · trunc: GitHub itself cut the tree
    s  the summary (kinds, build systems, extensions; filekinds.js describe) · subs: git submodules
    branch, etag, pushed (the repo's push date it was fetched for), at (when) · miss: the HTTP status of a repo without a
    tree (409 = empty repository, 404 = gone or private) */
import {S, rkey, bumpIndex} from './state.js';
import {$, DAY, status, secs, pool} from './util.js';
import {plan, start, report, finish} from './progress.js';
import {gh, isFatalError, needToken, readBudget} from './github.js';
import {waitForRefill, budgetNow, budgetLine, refillText} from './budget.js';
import {saveFiles, markFiles, markAllFiles} from './store.js';
import {debug, info, warn} from './log.js';
import {describe} from './filekinds.js';
import {render} from './list.js';

export const MAX_PATHS = 50_000;
const MAX_AGE = 30 * DAY, PARALLEL = 10;
const SKIP = /(?:^|\/)(?:node_modules|\.git|vendor\/bundle|bower_components)\//;
const spread = r => ((r.id || 0) % 7) * DAY;

/** Does this repo's file list need a look? Never fetched, pushed since, or checked over a month ago. */
export const needsFiles = (r, rec = S.files[rkey(r)]) => !rec || rec.pushed !== r.pushed || Date.now() - (rec.at || 0) > MAX_AGE + spread(r);

/** Of `repos`: how many have a file list, and how many files those hold. */
export function fileTotals(repos = S.repos) {
  let repoCount = 0, files = 0;
  for (const r of repos) { const rec = S.files[rkey(r)]; if (rec) { repoCount++; files += rec.n || 0; } }
  return {repos: repoCount, files};
}

/** A tree answer → the stored record. */
export function toRecord(r, tree, etag) {
  const all = (tree.tree || []).filter(x => x.type === 'blob' && !SKIP.test(x.path)).map(x => x.path);
  const p = all.length > MAX_PATHS ? all.slice(0, MAX_PATHS) : all;
  return {p, n: all.length, cut: all.length > MAX_PATHS, trunc: !!tree.truncated, subs: (tree.tree || []).filter(x => x.type === 'commit').length,
    s: describe(all), branch: r.branch || null, etag: etag || null, pushed: r.pushed, at: Date.now()};
}

/**
 * Fetches the file lists of `todo`. `quiet`: part of a bigger job (Check for updates owns the plan and the status line).
 * Returns {got, same, failed, fatal, summary}.
 */
export async function fetchFiles(g, todo, {quiet = false} = {}) {
  if (!todo.length) { finish('files', 'all up to date'); return {got: 0, same: 0, failed: 0, summary: 'file lists up to date (0 requests)'}; }
  start('files', todo.length);
  if (!S.token && todo.length > 50 && !quiet) status(`⚠ ${todo.length} file lists to fetch but only ~60 requests/hour without a token. Add one in the 🔑 panel.`);
  info('files', `file lists: ${todo.length.toLocaleString()} repo(s) to look at · one request each (GET /repos/…/git/trees/<branch>?recursive=1, names only, nothing downloaded), ${PARALLEL} at a time · an unchanged tree answers 304 (free)`);
  let done = 0, got = 0, same = 0, failed = 0, fatal = null, lastSave = Date.now();
  /** Fetches one repo's tree into S.files. Throws what gh() throws (rate limit, network, other statuses). */
  const fetchOne = async r => {
    const k = rkey(r), old = S.files[k], ref = encodeURIComponent(r.branch || 'HEAD');
    const res = await gh(`/repos/${r.full}/git/trees/${ref}?recursive=1`, old?.etag && old.branch === (r.branch || null) ? {'If-None-Match': old.etag} : {});
    if (g !== S.gen) return;
    if (res.status === 304) { S.files[k] = {...old, pushed: r.pushed, at: Date.now()}; same++; debug('files', `${r.full}: file list unchanged (304, free)`); }
    else if (res.status === 404) { S.files[k] = {p: [], n: 0, s: describe([]), miss: 404, branch: r.branch || null, pushed: r.pushed, at: Date.now()}; debug('files', `${r.full}: no tree (404: empty, private or gone)`); }
    else {
      const rec = toRecord(r, await res.json(), res.headers.get('ETag'));
      if (g !== S.gen) return;
      S.files[k] = rec; got++;
      const kinds = Object.entries(rec.s.kinds).map(([key, c]) => `${key} ${c}`).join(', ');
      info('files', `${r.full}: ${rec.n.toLocaleString()} files${rec.trunc ? ' (GitHub cut the list: a very large repo)' : ''}${kinds ? ' · ' + kinds : ''}${rec.s.build.length ? ' · ' + rec.s.build.join(', ') : ''} · https://github.com/${r.full}/tree/${r.branch || 'HEAD'}`);
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
