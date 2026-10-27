/* Keeping the cache in sync with GitHub while doing as little work as possible.

  Checks, cheapest first:
   1. Star list: every page fetched in parallel, each with its ETag. An unchanged page answers 304 (tiny, and free
      against the rate limit) and is rebuilt from the cache.
   2. `pushed_at` is a cheap change hint: an unchanged value skips most detail requests. A periodic max-age check
      catches changes such as release metadata that need not move `pushed_at`.
   3. Repos that did change: one GraphQL call per 10 repos (6 in parallel) returns the tile data (last commit, last
      release: see parseLast in github.js) + languages + 12-month commit activity + README hash together.
   4. README hash equal to the cached one (or to the hash of the cached text) → no download. Only READMEs that really
      changed are downloaded, 10 per GraphQL call. Unusual README names/locations fall back to REST with ETags.
   5. If commit messages / release notes were indexed, history.js tops them up (and refreshes the tiles of the repos it
      checks, cheaply).
   A safety-net max age (spread per repo so they don't all expire the same day) re-checks things occasionally.

  Jobs run one at a time per tab (task) and per profile across tabs (a Web Lock). The Cancel button sets S.stop: a job
  finishes its current batch, saves, and ends. Nothing is deleted before its replacement arrived: a failed, cancelled
  or aborted refresh always leaves the previous data. */
import {S, rkey, ukey, bumpIndex} from './state.js';
import {$, DAY, status, secs, pool, chunks} from './util.js';
import {plan, start, report, finish, stopAll, settle} from './progress.js';
import {gh, gqlRepos, isFatalError, mapStar, gitSha, needToken, LANG_FIELDS, LAST_FIELDS, parseLast, languageShares, activityFields, parseActivity, recordStars} from './github.js';
import {saveStars, saveReadmes, saveHistory, markHistory} from './store.js';
import {render} from './list.js';
import {syncHistory} from './history.js';

const ENRICH_MAX_AGE = 7 * DAY, README_MAX_AGE = 30 * DAY;
// READMEs are the first source of information and are never trimmed. Older versions cut them at this many characters;
// such records are recognised (they lack `whole`) and downloaded again in full.
const LEGACY_README_CAP = 100_000;
// Checked via GraphQL (one cheap lookup each); a repo with any other name falls back to the REST endpoint.
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README.rst', 'README.txt', 'README'];
const DETAIL_FIELDS = ['release', 'releaseAt', 'releasePre', 'releaseLatest', 'commitAt', 'langs', 'activity', 'enrichedAt', 'enrichedPushed'];

const spread = r => ((r.id || 0) % 7) * DAY;
// Repos cached before a field existed get it on the next check (one-time): `!r.langs`, `r.activity === undefined`, and
// `r.releasePre === undefined` (their "last release" came from GitHub's "Latest" badge, not the newest by date).
export const needsEnrich = r => !r.enrichedAt || !r.langs || r.activity === undefined || r.releasePre === undefined ||
  r.enrichedPushed !== r.pushed || Date.now() - r.enrichedAt > ENRICH_MAX_AGE + spread(r);
/** A stored README that an older version cut short. */
const readmeCut = c => !!c && !c.whole && (c.t?.length || 0) >= LEGACY_README_CAP;
export const needsReadme = r => {
  const c = S.readmes[rkey(r)];
  return !c || readmeCut(c) || c.pushed !== r.pushed || Date.now() - c.at > README_MAX_AGE + spread(r);
};
/** A README cache entry. `whole`: the text is the entire file (never trimmed). */
const readmeRecord = (r, fields) => ({t: '', sha: null, etag: null, path: null, ...fields, whole: true, at: Date.now(), pushed: r.pushed});

// ---- one network job at a time ----
let running = null, runningGen = 0;

/** Only one tab / window may sync a profile at a time (they would overwrite each other's cache files). */
async function withLock(fn) {
  const locks = globalThis.navigator?.locks;
  if (!locks) return fn();
  return locks.request('stars-viewer:' + ukey(), {ifAvailable: true}, lock => {
    if (!lock) { status('⚠ Another tab or window is already syncing this profile. Reload this tab when it has finished to see its progress.'); return; }
    return fn();
  });
}

/** Runs job(gen) unless another job is running for the current profile, or the profile's cache is still being read
 *  (the job would save half-loaded data over it). Errors end up in the status line.
 *  The Cancel button (S.stop) asks the job to save what it has and end.
 *  A job of an earlier generation (the profile was loaded again) is stopping, but may still hold the profile's lock: the
 *  new job starts once it has ended, instead of finding the lock taken and reporting another tab. */
export function task(job) {
  if (S.loading) { status('⏳ Still reading the cached data, try again in a moment'); return Promise.resolve(); }
  if (running && runningGen === S.gen) { status('⏳ Busy with another task, please wait'); return running; }
  const g = S.gen, cancel = $('#cancelTask'), previous = running || Promise.resolve();
  runningGen = g;
  S.stop = false;
  if (cancel) cancel.hidden = false;
  const p = previous.then(() => g === S.gen ? withLock(() => job(g)) : undefined)
    .catch(e => { if (g === S.gen && e?.name !== 'AbortError') status('⚠ ' + e.message); })
    .finally(() => {
      if (running !== p) return;
      stopAll(S.stop);   // steps still running are marked done, or stopped if Cancel was clicked
      settle();          // the finished panel stays readable for a few seconds
      running = null; S.stop = false;
      if (cancel) cancel.hidden = true;
    });
  return (running = p);
}
export const waitIdle = () => (running && runningGen === S.gen) ? running : Promise.resolve();

/** Older caches keyed READMEs by "owner/name" and stored plain strings: convert in place, no re-download. */
export function migrateReadmes() {
  const byFull = new Map(S.repos.map(r => [r.full.toLowerCase(), r]));
  const byId = new Map(S.repos.map(r => [String(r.id), r]));
  for (const [k, v] of Object.entries(S.readmes)) {
    if (typeof v !== 'string' && !k.includes('/')) continue;
    const r = byFull.get(k.toLowerCase()) || byId.get(k);
    if (!r) continue;   // unknown entries are pruned only after a successful star-list refresh
    // Plain-string caches have no Git hash or check date. Keep the text, but verify it on the next sync.
    const target = rkey(r), replacement = typeof v === 'string' ? {...readmeRecord(r, {t: v}), at: 0, pushed: null} : v;
    delete S.readmes[k];
    if (target === k || !S.readmes[target]) S.readmes[target] = replacement;
  }
}

// ---- 1. star list ----
/** All pages in parallel, each conditional on its cached ETag. Returns [{etag, ids, items, hit}] in page order. */
async function fetchStarPages(g) {
  const user = S.user;   // an older check must not switch its remaining page requests to a newly selected profile
  const cachedPages = S.starPages;
  const cachedById = new Map(S.repos.map(r => [r.id, r]));
  const fetchPage = async (p, useEtag = true) => {
    if (g !== S.gen) return {items: [], ids: [], last: 0};
    const old = cachedPages[p - 1];
    const r = await gh(`/users/${encodeURIComponent(user)}/starred?per_page=100&page=${p}`,
      {Accept: 'application/vnd.github.star+json', ...(useEtag && old?.etag ? {'If-None-Match': old.etag} : {})});
    if (r.status === 404) throw new Error(`User "${user}" not found`);
    if (r.status === 304) {
      const items = old.ids.map(id => cachedById.get(id));
      if (items.every(Boolean)) return {etag: old.etag, ids: old.ids, items: items.map(x => ({...x})), last: 0, hit: true};
      return fetchPage(p, false);   // cache doesn't have every repo of that page: fetch it for real
    }
    const items = (await r.json()).map(mapStar);
    const last = Number(r.headers.get('Link')?.match(/[?&]page=(\d+)>; rel="last"/)?.[1] || 0);
    return {etag: r.headers.get('ETag'), ids: items.map(x => x.id), items, last, hit: false};
  };
  const first = await fetchPage(1);
  if (g !== S.gen) return [];
  const lastPage = first.last || (first.hit ? cachedPages.length : 1) || 1;
  const pages = [first];
  let got = 1;
  const shown = total => report('stars', got, total, `page ${got} of ${total}`);
  shown(lastPage);
  await pool(Array.from({length: lastPage - 1}, (_, i) => i + 2), 10, async p => { pages[p - 1] = await fetchPage(p); got++; shown(lastPage); });
  // The list may have grown beyond what the cache knew: continue while pages come back full.
  while (pages.at(-1).items.length === 100 && g === S.gen) { pages.push(await fetchPage(pages.length + 1)); got++; shown(Math.max(lastPage, got)); }
  // Unstarring shrinks the list, but an unchanged first page (304) carries no page count: the cache's old last pages
  // then come back empty. Drop them, or they would be requested again on every check.
  while (pages.length > 1 && !pages.at(-1).items.length) pages.pop();
  return pages;
}

/** Full check: star list, then details (releases/READMEs) for whatever changed. */
export async function sync(g) {
  const t0 = performance.now();
  status('Checking GitHub (all pages in parallel)…');
  // The steps of this job, shown up front: what exists in the cache decides which later steps will run.
  const indexed = S.token && Object.keys(S.history).length > 0;
  plan([['stars'], (S.token || S.repos.some(r => r.enrichedAt)) && ['details'], Object.keys(S.readmes).length > 0 && ['readmes'],
    ...(indexed ? [['check'], ['releases'], ['commits']] : [])].filter(Boolean));
  start('stars');
  const pages = await fetchStarPages(g);
  if (g !== S.gen) return;
  finish('stars', `${pages.length} page${pages.length === 1 ? '' : 's'}`);
  // Reached only when every page succeeded: a partial list never overwrites the cache.

  const fresh = new Map();
  for (const p of pages) for (const r of p.items) fresh.set(r.id, r);   // dedupes if the list shifted while paging
  const byId = new Map(S.repos.filter(r => r.id).map(r => [r.id, r]));
  const byFull = new Map(S.repos.map(r => [r.full, r]));
  let added = 0, changed = 0, renamed = 0;
  for (const r of fresh.values()) {
    const o = byId.get(r.id) || byFull.get(r.full);
    if (!o) { added++; continue; }
    if (o.full !== r.full) renamed++;
    if (o.pushed !== r.pushed) changed++;
    for (const f of DETAIL_FIELDS) r[f] = o[f];
    r.starHist = o.starHist;   // keep details; needsEnrich() decides if they're still valid
    const oldKey = rkey(o), newKey = rkey(r);      // old caches had no id: re-key the README entry
    if (oldKey !== newKey && S.readmes[oldKey]) { S.readmes[newKey] = S.readmes[oldKey]; delete S.readmes[oldKey]; }
    if (oldKey !== newKey && S.history[oldKey]) { S.history[newKey] = S.history[oldKey]; delete S.history[oldKey]; markHistory(oldKey); markHistory(newKey); }
  }
  const freshFulls = new Set([...fresh.values()].map(r => r.full));
  const removed = S.repos.filter(r => !(r.id ? fresh.has(r.id) : freshFulls.has(r.full))).length;
  const hadEnrich = S.repos.some(r => r.enrichedAt || r.commitAt);
  const hadReadmes = Object.keys(S.readmes).length > 0;
  const hadHistory = Object.keys(S.history).length > 0;

  S.repos = [...fresh.values()];
  for (const r of S.repos) r.starHist = recordStars(r.starHist, r.stars);   // one sample per day → star growth charts
  S.starPages = pages.map(({etag, ids}) => ({etag, ids}));
  const keep = new Set(S.repos.map(rkey));
  for (const k of Object.keys(S.readmes)) if (!keep.has(k)) delete S.readmes[k];   // unstarred
  for (const k of Object.keys(S.history)) if (!keep.has(k)) { delete S.history[k]; markHistory(k); }
  bumpIndex();
  await saveStars(g);
  if (removed) await saveReadmes(g);
  await saveHistory(g);   // writes only the shards that changed
  if (g !== S.gen) return;   // a profile change may happen while a large cache file is being written

  const diff = [added && `+${added} new`, changed && `${changed} with new commits`, renamed && `${renamed} renamed`,
    removed && `−${removed} unstarred`].filter(Boolean).join(' · ') || 'list up to date';
  const hits = pages.filter(p => p.hit).length;
  status(`${S.repos.length} stars · ${diff} · ${pages.length} pages in ${secs(t0)}${hits ? ` (${hits} unchanged)` : ''}`);
  render();

  // Details only for what's missing or stale. With a token the tiles' last commit / last release are always kept
  // current; READMEs only if they were indexed before.
  const wantEnrich = hadEnrich || !!S.token;
  const res = wantEnrich || hadReadmes ? await refreshDetails(g, {wantReadmes: hadReadmes, wantEnrich}) : null;
  // Commit messages and release notes: only if they were indexed before (the toolbar button does the first full run).
  let hist = null;
  if (g === S.gen && hadHistory && S.token) {
    hist = await syncHistory(g, S.repos);
    if (g === S.gen) { bumpIndex(); render(); }
  }
  if (g === S.gen) status(`${S.repos.length} stars · ${diff} · ${res?.summary ? res.summary + ' · ' : ''}${hist?.summary ? hist.summary + ' · ' : ''}all checked in ${secs(t0)}`);
}

// ---- 2-4. releases, commits, READMEs ----
/** Refreshes details of repos that need it. Returns {summary}. */
async function refreshDetails(g, {wantReadmes, wantEnrich}) {
  if (!S.token) return wantReadmes ? restReadmes(g, S.repos.filter(needsReadme)) : {summary: 'add a token for releases'};
  const todo = S.repos.filter(r => (wantEnrich && needsEnrich(r)) || (wantReadmes && needsReadme(r)));
  if (!todo.length) {
    finish('details', 'all up to date');
    if (wantReadmes) finish('readmes', 'all up to date');   // READMEs not indexed: there is no such step to finish
    return {summary: 'details up to date (0 requests)'};
  }
  start('details', todo.length);

  const now0 = Date.now();   // activity buckets are counted up to this moment
  const readmeFields = README_NAMES.map((n, k) => `m${k}:object(expression:${JSON.stringify('HEAD:' + n)}){...on Blob{oid}}`).join(' ');   // the README's git hash
  const fullFields = LAST_FIELDS + ' ' + LANG_FIELDS + ' ' + activityFields(now0) + (wantReadmes ? ' ' + readmeFields : '');
  // Repos whose tiles, languages and activity are still fresh only need their README hash: a much lighter query.
  const full = todo.filter(r => wantEnrich && needsEnrich(r)), light = todo.filter(r => !(wantEnrich && needsEnrich(r)));
  const batches = [...chunks(full, 10).map(items => ({items, isFull: true})), ...chunks(light, 10).map(items => ({items, isFull: false}))];
  const download = [], viaRest = [];
  let checked = 0, same = 0, skipped = 0, fatal = null;

  await pool(batches, 6, async ({items: batch, isFull}) => {
    if (fatal || S.stop || g !== S.gen) return;
    let data;
    try { data = await gqlRepos(batch, isFull ? fullFields : readmeFields); }
    catch (e) {   // auth/rate limit: stop; anything else (timeout…): skip this batch, it's retried next check
      if (isFatalError(e)) fatal = e; else skipped += batch.length;
      return;
    }
    const now = Date.now();
    for (const [j, r] of batch.entries()) {
      if (g !== S.gen) return;   // never write an old profile's results into the newly loaded profile
      const d = data['r' + j];
      if (!d) { skipped++; continue; }   // GraphQL may omit one repo; keep its old details and retry later
      if (isFull) Object.assign(r, parseLast(d), {langs: languageShares(d.languages), activity: parseActivity(d, now0), enrichedAt: now, enrichedPushed: r.pushed});
      if (!wantReadmes || !needsReadme(r)) continue;
      const k = rkey(r), c = S.readmes[k];
      const hit = README_NAMES.map((path, i) => d['m' + i]?.oid && {path, oid: d['m' + i].oid}).find(Boolean);   // a directory named README has no oid
      if (!hit) { viaRest.push(r); continue; }
      const sameSha = c && !readmeCut(c) && (c.sha === hit.oid || (!c.sha && c.t && await gitSha(c.t) === hit.oid));
      if (g !== S.gen) return;
      if (sameSha) {
        Object.assign(c, {sha: hit.oid, path: hit.path, whole: true, at: now, pushed: r.pushed}); same++;
      } else download.push({r, ...hit});
    }
    checked += batch.length;
    if (g === S.gen) {
      status(`Checked ${checked}/${todo.length} changed repos…`);
      report('details', checked, todo.length, `${checked.toLocaleString()} of ${todo.length.toLocaleString()} repos`);
    }
  });
  if (g !== S.gen) return {summary: ''};
  if (checked === todo.length) finish('details');
  await saveStars(g);

  let got = 0;
  if (wantReadmes) { if (download.length) start('readmes', download.length); else finish('readmes', 'all unchanged'); }
  await pool(chunks(download, 10), 8, async batch => {
    if (fatal || S.stop || g !== S.gen) return;
    let data;
    try { data = await gqlRepos(batch, x => `object(expression:${JSON.stringify('HEAD:' + x.path)}){...on Blob{text isTruncated}}`, x => [x.r.owner, x.r.name]); }
    catch (e) {
      if (isFatalError(e)) fatal = e; else for (const x of batch) viaRest.push(x.r);
      return;
    }
    if (g !== S.gen) return;
    batch.forEach((x, j) => {
      const blob = data['r' + j]?.object;
      if (blob?.text == null || blob.isTruncated) { viaRest.push(x.r); return; }   // binary, or GraphQL cut it: REST returns the whole file
      S.readmes[rkey(x.r)] = readmeRecord(x.r, {t: blob.text, sha: x.oid, path: x.path});
      got++;
    });
    if (g === S.gen) {
      status(`Downloading changed READMEs ${got}/${download.length}…`);
      report('readmes', got, download.length, `${got.toLocaleString()} of ${download.length.toLocaleString()} downloaded`);
    }
  });

  const rest = viaRest.length && !fatal ? await restReadmes(g, viaRest, true, got) : null;   // `got`: already counted by the step's bar
  if (g !== S.gen) return {summary: ''};
  if (wantReadmes && !fatal && !S.stop) finish('readmes');   // otherwise it would keep ticking while commits are checked
  if (wantReadmes) await saveReadmes(g);   // a job that never touched READMEs doesn't rewrite them
  if (g !== S.gen) return {summary: ''};
  bumpIndex();
  render();
  return {summary: `${todo.length} changed repos checked` +
    (wantReadmes ? ` · READMEs: ${same + (rest?.same || 0)} unchanged, ${got + (rest?.got || 0)} downloaded` : '') +
    (skipped ? ` · ${skipped} skipped (GitHub omitted results or timed out; retried next check)` : '') +
    (S.stop ? ' · ■ stopped, progress saved' : '') + (fatal ? ` · ⚠ ${fatal.message} (progress saved)` : '')};
}

/** REST path (no token, or unusual README names). ETag conditional requests make "unchanged" nearly free. `quiet`: part of a
 *  bigger job (refreshDetails owns the step, the saving and the final render); `base` = READMEs that job already counted. */
async function restReadmes(g, todo, quiet = false, base = 0) {
  if (!todo.length) { if (!quiet) finish('readmes', 'all up to date'); return {got: 0, same: 0, summary: 'READMEs up to date (0 requests)'}; }
  if (!quiet) start('readmes', todo.length);
  if (!S.token && todo.length > 50) status(`⚠ ${todo.length} READMEs to check but only ~60 requests/hour without a token. Add one in the 🔑 panel.`);
  let done = 0, same = 0, got = 0, failed = 0, fatal = null;
  await pool(todo, 12, async r => {
    if (fatal || S.stop || g !== S.gen) return;
    const k = rkey(r), c = S.readmes[k];
    try {
      const res = await gh(`/repos/${r.full}/readme`, {Accept: 'application/vnd.github.raw', ...(c?.etag && !readmeCut(c) ? {'If-None-Match': c.etag} : {})});
      if (g !== S.gen) return;
      if (res.status === 304) { Object.assign(c, {whole: true, at: Date.now(), pushed: r.pushed}); same++; }
      else if (res.status === 404) S.readmes[k] = readmeRecord(r, {});   // repo has no README
      else {
        const text = await res.text();
        if (g !== S.gen) return;
        S.readmes[k] = readmeRecord(r, {t: text, etag: res.headers.get('ETag')}); got++;
      }
    } catch (e) { if (isFatalError(e)) fatal = e; else failed++; }   // transient: retried next time
    if (g === S.gen) {
      done++;
      if (!quiet && done % 25 === 0) status(`READMEs ${done}/${todo.length}…`);
      report('readmes', base + done, base + todo.length, `${(base + done).toLocaleString()} of ${(base + todo.length).toLocaleString()} ${quiet ? 'downloaded' : 'checked'}`);
    }
  });
  if (!quiet && g === S.gen) finish('readmes');
  if (!quiet && g === S.gen) { await saveReadmes(g); if (g === S.gen) { bumpIndex(); render(); } }
  return {got, same, summary: `READMEs: ${same} unchanged, ${got} downloaded${failed ? `, ${failed} failed (retried next time)` : ''}` +
    (fatal ? ` · ⚠ ${fatal.message}` : '')};
}

// ---- toolbar actions ----
export async function enrich(g) {
  if (!S.token) { needToken(); return status('⚠ Releases/commits need a token (GraphQL). Add one in the 🔑 panel.'); }
  const t0 = performance.now(), wantReadmes = Object.keys(S.readmes).length > 0;
  plan([['details'], wantReadmes && ['readmes']].filter(Boolean));
  const {summary} = await refreshDetails(g, {wantReadmes, wantEnrich: true});
  if (g === S.gen) status(`${summary} · ${secs(t0)}`);
}

export async function indexReadmes(g) {
  const t0 = performance.now();
  plan([S.token && ['details', 'Check repos & README versions'], ['readmes']].filter(Boolean));
  const {summary} = await refreshDetails(g, {wantReadmes: true, wantEnrich: !!S.token});
  if (g !== S.gen) return;
  $('#inReadme').checked = true;
  bumpIndex();
  render();
  status(`${summary} · ${secs(t0)}`);
}
