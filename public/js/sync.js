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
import {S, rkey, ukey, bumpIndex} from './state.js';   // S.visit: someone else's stars are on screen (see store.js), which get the lighter check below
import {$, DAY, status, secs, pool, chunks} from './util.js';
import {plan, start, report, finish, stopAll, settle} from './progress.js';
import {gh, ghFetch, headers, gqlRepos, isFatalError, mapStar, gitSha, needToken, LANG_FIELDS, LAST_FIELDS, parseLast, languageShares, activityFields, parseActivity, recordStars} from './github.js';
import {saveStars, saveReadmes, saveHistory, saveUsers, markHistory} from './store.js';
import {debug, info, warn, error, names} from './log.js';
import {render} from './list.js';
import {syncHistory} from './history.js';

const ENRICH_MAX_AGE = 7 * DAY, README_MAX_AGE = 30 * DAY;
// READMEs are the first source of information and are never trimmed. Older versions cut them at this many characters;
// such records are recognised (they lack `whole`) and downloaded again in full.
const LEGACY_README_CAP = 100_000;
// Checked via GraphQL (one cheap lookup each); a repo with any other name falls back to the REST endpoint.
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README.rst', 'README.txt', 'README'];
const DETAIL_FIELDS = ['release', 'releaseAt', 'releasePre', 'releaseLatest', 'commitAt', 'langs', 'activity', 'enrichedAt', 'enrichedPushed', 'liteAt'];

const spread = r => ((r.id || 0) % 7) * DAY;
/** The light check of a visit asks only for last commit and last release (no languages, no 12-month chart, no READMEs):
 *  a visit is for looking around, so it costs one cheap GraphQL call per 10 repos. A full check (needsEnrich) counts too. */
export const needsLite = r => {
  const at = Math.max(r.enrichedAt || 0, r.liteAt || 0);
  return !at || r.enrichedPushed !== r.pushed || Date.now() - at > ENRICH_MAX_AGE + spread(r);
};
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
    if (!lock) {
      warn('task', `another tab or window already holds the lock of ${S.user}: this job does not run (two tabs would overwrite each other's cache)`);
      status('⚠ Another tab or window is already syncing this profile. Reload this tab when it has finished to see its progress.');
      return;
    }
    debug('task', `lock of ${S.user} taken: no other tab syncs this profile`);
    return fn();
  });
}

/** Runs job(gen) unless another job is running for the current profile, or the profile's cache is still being read
 *  (the job would save half-loaded data over it). Errors end up in the status line.
 *  The Cancel button (S.stop) asks the job to save what it has and end.
 *  A job of an earlier generation (the profile was loaded again) is stopping, but may still hold the profile's lock: the
 *  new job starts once it has ended, instead of finding the lock taken and reporting another tab. */
export function task(job) {
  if (S.loading) { warn('task', `${job.name || 'job'} not started: the cached data of ${S.user} is still being read`); status('⏳ Still reading the cached data, try again in a moment'); return Promise.resolve(); }
  if (running && runningGen === S.gen) { warn('task', `${job.name || 'job'} not started: another task is still running`); status('⏳ Busy with another task, please wait'); return running; }
  const g = S.gen, cancel = $('#cancelTask'), previous = running || Promise.resolve();
  runningGen = g;
  S.stop = false;
  if (cancel) cancel.hidden = false;
  const started = Date.now();
  info('task', `▶ ${job.name || 'job'} for ${S.user}${S.visit ? ' (a visit: nothing is saved)' : ''} · generation ${g} · token ${S.token ? 'set' : 'not set'} · ${S.repos.length.toLocaleString()} repos on screen`);
  const p = previous.then(() => g === S.gen ? withLock(() => job(g)) : undefined)
    .catch(e => {
      if (e?.name === 'AbortError') debug('task', `${job.name || 'job'} cancelled: its requests were aborted`);
      else error('task', `${job.name || 'job'} failed: ${e?.message || e}`);
      if (g === S.gen && e?.name !== 'AbortError') status('⚠ ' + e.message);
    })
    .finally(() => {
      info('task', `■ ${job.name || 'job'} ${S.stop ? 'stopped by Cancel' : g !== S.gen ? 'ended (another profile was loaded)' : 'ended'} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
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

// ---- repos that left the star list ----
const MISSING_CHECKS_WITHOUT_TOKEN = 50;   // one REST request each, of the 60 an hour
const recentlyChecked = r => !!r.gone && Date.now() - (r.gone.checked ?? 0) < DAY;

/**
 * Why is a cached repo missing from the star list? GitHub silently leaves out repos you can no longer reach, so the list
 * alone can't tell "unstarred" from "deleted / made private / hidden". Asked per missing repo (checked against the real
 * ESP32-P4-Knob-Touch-AMOLED-1.75 case: its page, its REST entry, the org's list and the star list all just omit it):
 *   'unstarred'  it still exists: you unstarred it, so it is forgotten (the list, the cache).
 *   'gone'       GitHub says "not found" (404), "unavailable for legal reasons" (451) or "access blocked / disabled"
 *                (403): its local copy is kept and marked (r.gone).
 * A repo without an entry could not be verified (rate limit, network, an unclear answer): it is kept as it is and asked
 * again at the next check. The judge is REST by numeric id (GET /repositories/<id>), which follows renames, transfers and
 * a name taken over by another repo; nothing is ever marked 'gone' on less than such an answer. With a token a GraphQL call
 * first clears 40 repos at a time that plainly still exist (same id): it may only confirm existence, because GraphQL also
 * answers null when it merely times out. Without a token it costs one request per repo, at most 50.
 */
async function checkMissing(g, missing) {
  const out = new Map();
  for (const r of missing) if (recentlyChecked(r)) out.set(r, 'gone');   // verified in the last day: not asked again at every check
  const unasked = missing.filter(r => !out.has(r));
  let todo = unasked.slice(0, S.token ? Infinity : MISSING_CHECKS_WITHOUT_TOKEN), stop = false;
  if (missing.length) info('sync', `${missing.length} cached repo(s) are not in your star list any more (${names(missing.map(r => r.full), 8)}): ${unasked.length ? 'asking GitHub whether each still exists (' + (S.token ? 'GraphQL first, then REST by id as the judge' : 'REST by id, no token: at most ' + MISSING_CHECKS_WITHOUT_TOKEN) + ')' : 'all were verified as removed less than a day ago, so GitHub is not asked again'}`);
  if (out.size && unasked.length) debug('sync', `${out.size} of them were verified as removed less than a day ago: not asked again`);
  if (todo.length < unasked.length) warn('sync', `${unasked.length - todo.length} repo(s) are not checked this time (without a token the budget is 60 requests an hour); they stay in the list and are asked again next time`);
  if (S.token && todo.length) {
    const rest = [];
    await pool(chunks(todo, 40), 4, async batch => {
      if (g !== S.gen) return;
      let data;
      try { data = await gqlRepos(batch, 'databaseId', r => [r.owner, r.name]); } catch { rest.push(...batch); return; }
      batch.forEach((r, j) => { const d = data['r' + j]; if (d && (r.id == null || d.databaseId === r.id)) out.set(r, 'unstarred'); else rest.push(r); });
    });
    todo = rest;
    info('sync', `GraphQL found ${todo.length === 0 ? 'all' : (unasked.length - rest.length) + ' of ' + unasked.length} of them: they exist, so they were unstarred${rest.length ? '. ' + rest.length + ' came back empty or with another id: asking REST by id' : ''}`);
  }
  await pool(todo, 6, async r => {
    if (stop || g !== S.gen) return;
    try {
      const res = await ghFetch(r.id != null ? '/repositories/' + r.id : '/repos/' + r.full, {headers: headers()});
      if (g !== S.gen) return;
      if (res.status === 404 || res.status === 451) out.set(r, 'gone');
      else if (res.ok) out.set(r, 'unstarred');   // it exists (by id: whatever it is called now); without a cached id the name is all there is
      else if (res.status === 401) { needToken(); stop = true; }
      else if (res.status === 403 || res.status === 429) {
        if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after')) stop = true;   // budget used up: the rest waits
        else if (/blocked|disabled|taken down|dmca/i.test((await res.json().catch(() => ({}))).message || '')) out.set(r, 'gone');
      }
      const v = out.get(r);
      info('sync', `${r.full} (id ${r.id ?? 'unknown'}): GitHub answered ${res.status} → ${v === 'gone' ? 'REMOVED, private or hidden: the local copy is kept' : v === 'unstarred' ? 'it still exists, so it was unstarred: forgotten' : 'cannot tell yet (kept, asked again next time)'}`);
    } catch (e) { debug('sync', `${r.full}: could not be checked (${e?.message || 'offline or aborted'}); kept, asked again next time`); }
  });
  return out;
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
      if (items.every(Boolean)) {
        debug('sync', `star list page ${p}: 304 not modified, ${items.length} repos rebuilt from the cache (free: costs no rate limit)`);
        return {etag: old.etag, ids: old.ids, items: items.map(x => ({...x})), last: 0, hit: true};
      }
      warn('sync', `star list page ${p}: 304, but the cache lacks some of its repos: downloading the page for real`);
      return fetchPage(p, false);   // cache doesn't have every repo of that page: fetch it for real
    }
    const items = (await r.json()).map(mapStar);
    const last = Number(r.headers.get('Link')?.match(/[?&]page=(\d+)>; rel="last"/)?.[1] || 0);
    debug('sync', `star list page ${p}: ${items.length} repos downloaded${last ? ' · GitHub says the list has ' + last + ' pages' : ''}${useEtag && old?.etag ? ' · its ETag changed' : ''}`);
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
  info('sync', `star list: ${pages.length} page(s), ${pages.reduce((n, p) => n + p.items.length, 0).toLocaleString()} repos, ${pages.filter(p => p.hit).length} page(s) unchanged (304)`);
  return pages;
}

// A repo missing from ONE star-list check keeps its README and commit index. The pages are fetched in parallel, so a star
// added or removed meanwhile can move a repo across a page boundary and hide it; deleting its (expensive) index on that
// glimpse would be a loss. Only a second check in a row confirms that it is really gone.
let gone = {user: '', keys: new Set()};

/** Full check: star list, then details (releases/READMEs) for whatever changed. A visit does the light version. */
export async function sync(g) {
  const t0 = performance.now(), lite = !!S.visit;
  status('Checking GitHub (all pages in parallel)…');
  info('sync', `checking ${S.user}'s stars (${lite ? 'light check, a visit' : 'full check'}) · cache: ${S.repos.length.toLocaleString()} repos, ${Object.keys(S.readmes).length.toLocaleString()} READMEs, ${Object.keys(S.history).length.toLocaleString()} repos indexed for commits & releases · token ${S.token ? 'set' : 'not set'}`);
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
  const addedNames = [], changedNames = [], renames = [];
  for (const r of fresh.values()) {
    const o = byId.get(r.id) || byFull.get(r.full);
    if (!o) { added++; addedNames.push(r.full); continue; }
    if (o.full !== r.full) { renamed++; renames.push(`${o.full} → ${r.full}`); }
    if (o.pushed !== r.pushed) { changed++; changedNames.push(r.full); }
    for (const f of DETAIL_FIELDS) r[f] = o[f];
    r.starHist = o.starHist;   // keep details; needsEnrich() decides if they're still valid
    const oldKey = rkey(o), newKey = rkey(r);      // old caches had no id: re-key the README entry
    if (oldKey !== newKey && S.readmes[oldKey]) { S.readmes[newKey] = S.readmes[oldKey]; delete S.readmes[oldKey]; }
    if (oldKey !== newKey && S.history[oldKey]) { S.history[newKey] = S.history[oldKey]; delete S.history[oldKey]; markHistory(oldKey); markHistory(newKey); }
  }
  info('sync', `compared with the cache: ${fresh.size.toLocaleString()} repos on GitHub · ${added} new · ${changed} pushed since the last check · ${renamed} renamed`);
  if (added) info('sync', `new stars: ${names(addedNames, 12)}`);
  if (renamed) info('sync', `renamed on GitHub: ${names(renames, 12)}`);
  if (changed) debug('sync', `pushed since the last check: ${names(changedNames, 12)}`);
  const freshFulls = new Set([...fresh.values()].map(r => r.full));
  // Repos of the cache that the star list no longer has: unstarred (it still exists: forget it), or deleted / made private /
  // hidden by GitHub (it can't be listed any more: keep the local copy, marked). See checkMissing.
  const missing = S.repos.filter(r => !(r.id ? fresh.has(r.id) : freshFulls.has(r.full)));
  const verdict = await checkMissing(g, missing);
  if (g !== S.gen) return;
  const kept = missing.filter(r => verdict.get(r) !== 'unstarred').map(r => verdict.get(r) === 'gone' ? {...r, gone: {at: r.gone?.at ?? Date.now(), checked: recentlyChecked(r) ? r.gone.checked : Date.now()}} : r);
  const removed = missing.length - kept.length, hidden = kept.filter(r => r.gone).length, unverified = missing.filter(r => !verdict.has(r)).length;
  if (missing.length) info('sync', `not in the list any more: ${removed} unstarred (forgotten) · ${hidden} removed or private (local copy kept) · ${unverified} not verified (kept)`);
  const hadEnrich = S.repos.some(r => r.enrichedAt || r.commitAt);
  const hadReadmes = Object.keys(S.readmes).length > 0;
  const hadHistory = Object.keys(S.history).length > 0;

  S.repos = [...fresh.values(), ...kept];
  for (const r of S.repos) r.starHist = recordStars(r.starHist, r.stars);   // one sample per day → star growth charts
  S.starPages = pages.map(({etag, ids}) => ({etag, ids}));
  const keep = new Set(S.repos.map(rkey));
  if (gone.user !== ukey()) gone = {user: ukey(), keys: new Set()};
  const orphans = [...new Set([...Object.keys(S.readmes), ...Object.keys(S.history)])].filter(k => !keep.has(k));
  const confirmed = orphans.filter(k => gone.keys.has(k));   // missing from the previous check too: really unstarred
  for (const k of confirmed) { delete S.readmes[k]; if (S.history[k]) { delete S.history[k]; markHistory(k); } }
  gone.keys = new Set(orphans.filter(k => !confirmed.includes(k)));
  if (orphans.length) info('sync', `${orphans.length - confirmed.length} README / commit index entr(ies) belong to repos missing from the list for the first time: kept until a second check agrees · ${confirmed.length} were missing twice in a row: dropped`);
  // Counts of users you no longer star anything from.
  const owners = new Set(S.repos.map(r => r.owner.toLowerCase()));
  const staleUsers = Object.keys(S.users).filter(k => !owners.has(k));
  for (const k of staleUsers) delete S.users[k];
  if (staleUsers.length) debug('sync', `dropped the star counts of ${staleUsers.length} user(s) you no longer star anything from`);
  bumpIndex();
  await saveStars(g);
  if (confirmed.length) await saveReadmes(g);
  if (staleUsers.length) await saveUsers(g);
  await saveHistory(g);   // writes only the shards that changed
  if (g !== S.gen) return;   // a profile change may happen while a large cache file is being written
  debug('sync', `star list saved (${S.repos.length.toLocaleString()} repos, ${S.starPages.length} page ETags)`);

  const diff = [added && `+${added} new`, changed && `${changed} with new commits`, renamed && `${renamed} renamed`,
    removed && `−${removed} unstarred`, hidden && `${hidden} removed or private (kept)`, unverified && `${unverified} not verified (kept, checked again next time)`].filter(Boolean).join(' · ') || 'list up to date';
  const hits = pages.filter(p => p.hit).length;
  status(`${S.repos.length} stars · ${diff} · ${pages.length} pages in ${secs(t0)}${hits ? ` (${hits} unchanged)` : ''}`);
  render();

  // Details only for what's missing or stale. With a token the tiles' last commit / last release are always kept
  // current; READMEs only if they were indexed before.
  const wantEnrich = lite ? !!S.token : hadEnrich || !!S.token;
  const res = wantEnrich || hadReadmes ? await refreshDetails(g, {wantReadmes: hadReadmes, wantEnrich, lite}) : null;
  // Commit messages and release notes: only if they were indexed before (the toolbar button does the first full run).
  let hist = null;
  if (g === S.gen && hadHistory && S.token) {
    hist = await syncHistory(g, S.repos.filter(r => !r.gone));
    if (g === S.gen) { bumpIndex(); render(); }
  }
  if (g === S.gen) status(`${S.repos.length} stars · ${diff} · ${res?.summary ? res.summary + ' · ' : ''}${hist?.summary ? hist.summary + ' · ' : ''}all checked in ${secs(t0)}`);
}

// ---- 2-4. releases, commits, READMEs ----
/** Refreshes details of repos that need it. Returns {summary}. `lite`: only last commit and last release (a visit's check). */
async function refreshDetails(g, {wantReadmes, wantEnrich, lite = false}) {
  const live = S.repos.filter(r => !r.gone);   // a repo GitHub no longer shows can't be refreshed: its local copy stays as it is
  if (!S.token) {
    info('sync', wantReadmes ? `no token: READMEs are checked over REST, one request per repo (an unchanged one answers 304 for free)` : 'no token: last commit, last release, languages and charts need one, so they are skipped');
    return wantReadmes ? restReadmes(g, live.filter(needsReadme)) : {summary: 'add a token for releases'};
  }
  const stale = lite ? needsLite : needsEnrich;
  const todo = live.filter(r => (wantEnrich && stale(r)) || (wantReadmes && needsReadme(r)));
  if (!todo.length) {
    info('sync', `details: all ${live.length.toLocaleString()} repos are up to date (0 requests)`);
    finish('details', 'all up to date');
    if (wantReadmes) finish('readmes', 'all up to date');   // READMEs not indexed: there is no such step to finish
    return {summary: 'details up to date (0 requests)'};
  }
  start('details', todo.length);

  const now0 = Date.now();   // activity buckets are counted up to this moment
  const readmeFields = README_NAMES.map((n, k) => `m${k}:object(expression:${JSON.stringify('HEAD:' + n)}){...on Blob{oid}}`).join(' ');   // the README's git hash
  const fullFields = LAST_FIELDS + (lite ? '' : ' ' + LANG_FIELDS + ' ' + activityFields(now0)) + (wantReadmes ? ' ' + readmeFields : '');
  // Repos whose tiles, languages and activity are still fresh only need their README hash: a much lighter query.
  const full = todo.filter(r => wantEnrich && stale(r)), light = todo.filter(r => !(wantEnrich && stale(r)));
  const batches = [...chunks(full, 10).map(items => ({items, isFull: true})), ...chunks(light, 10).map(items => ({items, isFull: false}))];
  const download = [], viaRest = [];
  let checked = 0, same = 0, skipped = 0, fatal = null;
  info('sync', `details: ${todo.length.toLocaleString()} of ${live.length.toLocaleString()} repos need a refresh · ${full.length} ${lite ? 'last commit + last release only (a visit)' : 'full (tiles, languages, 12-month chart)'} · ${light.length} README hash only · ${batches.length} GraphQL calls of 10 repos, 6 at a time`);

  await pool(batches, 6, async ({items: batch, isFull}) => {
    if (fatal || S.stop || g !== S.gen) return;
    let data;
    try { data = await gqlRepos(batch, isFull ? fullFields : readmeFields, undefined, `details of ${batch.length} repos, ${isFull ? (lite ? 'tiles' : 'full') : 'README hash'}`); }
    catch (e) {   // auth/rate limit: stop; anything else (a big query that times out…): ask again as two smaller calls; a small batch is skipped, retried next check
      const split = !isFatalError(e) && batch.length > 3 && g === S.gen && !S.stop;
      warn('sync', `details: a batch of ${batch.length} repos failed (${e.message}): ${isFatalError(e) ? 'this ends the run, progress is kept' : split ? 'asking again as two smaller calls (a big query can time out)' : 'skipped, retried at the next check'}`);
      if (isFatalError(e)) fatal = e;
      else if (split) { const half = Math.ceil(batch.length / 2); batches.push({items: batch.slice(0, half), isFull}, {items: batch.slice(half), isFull}); }
      else skipped += batch.length;
      return;
    }
    const now = Date.now();
    for (const [j, r] of batch.entries()) {
      if (g !== S.gen) return;   // never write an old profile's results into the newly loaded profile
      const d = data['r' + j];
      if (!d) { skipped++; debug('sync', `${r.full}: GitHub returned nothing for it (private, deleted or timed out): old details kept, retried next check`); continue; }   // GraphQL may omit one repo; keep its old details and retry later
      if (isFull) Object.assign(r, parseLast(d), lite ? {liteAt: now, enrichedPushed: r.pushed}
        : {langs: languageShares(d.languages), activity: parseActivity(d, now0), enrichedAt: now, enrichedPushed: r.pushed});
      if (!wantReadmes || !needsReadme(r)) continue;
      const k = rkey(r), c = S.readmes[k];
      const hit = README_NAMES.map((path, i) => d['m' + i]?.oid && {path, oid: d['m' + i].oid}).find(Boolean);   // a directory named README has no oid
      if (!hit) { viaRest.push(r); debug('readmes', `${r.full}: no README at the usual names (README.md, readme.md…): asking the REST endpoint`); continue; }
      const sameSha = c && !readmeCut(c) && (c.sha === hit.oid || (!c.sha && c.t && await gitSha(c.t) === hit.oid));
      if (g !== S.gen) return;
      if (sameSha) {
        Object.assign(c, {sha: hit.oid, path: hit.path, whole: true, at: now, pushed: r.pushed}); same++;
      } else { download.push({r, ...hit}); debug('readmes', `${r.full}: README changed (${hit.path}, hash ${hit.oid.slice(0, 7)}${c?.sha ? ', was ' + c.sha.slice(0, 7) : ', not stored yet'}): will download`); }
    }
    checked += batch.length;
    debug('sync', `details: ${checked}/${todo.length} repos checked (${names(batch.map(r => r.full), 3)})`);
    if (g === S.gen) {
      status(`Checked ${checked}/${todo.length} changed repos…`);
      report('details', checked, todo.length, `${checked.toLocaleString()} of ${todo.length.toLocaleString()} repos`);
    }
  });
  if (g !== S.gen) return {summary: ''};
  if (checked === todo.length) finish('details');
  await saveStars(g);

  let got = 0;
  if (wantReadmes) info('readmes', `${same.toLocaleString()} README(s) unchanged (same git hash: no download) · ${download.length} changed · ${viaRest.length} without a standard name`);
  if (wantReadmes) { if (download.length) start('readmes', download.length); else finish('readmes', 'all unchanged'); }
  await pool(chunks(download, 10), 8, async batch => {
    if (fatal || S.stop || g !== S.gen) return;
    let data;
    try { data = await gqlRepos(batch, x => `object(expression:${JSON.stringify('HEAD:' + x.path)}){...on Blob{text isTruncated}}`, x => [x.r.owner, x.r.name]); }
    catch (e) {
      warn('readmes', `download of ${batch.length} READMEs failed (${e.message}): ${isFatalError(e) ? 'run ends, progress kept' : 'trying each over REST'}`);
      if (isFatalError(e)) fatal = e; else for (const x of batch) viaRest.push(x.r);
      return;
    }
    if (g !== S.gen) return;
    batch.forEach((x, j) => {
      const blob = data['r' + j]?.object;
      if (blob?.text == null || blob.isTruncated) { viaRest.push(x.r); debug('readmes', `${x.r.full}: ${x.path} ${blob?.text == null ? 'is binary or empty' : 'was cut by GraphQL'}: fetching the whole file over REST`); return; }   // binary, or GraphQL cut it: REST returns the whole file
      S.readmes[rkey(x.r)] = readmeRecord(x.r, {t: blob.text, sha: x.oid, path: x.path});
      info('readmes', `${x.r.full}: downloaded ${x.path}, ${blob.text.length.toLocaleString()} characters (never trimmed)`);
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
      if (res.status === 304) { Object.assign(c, {whole: true, at: Date.now(), pushed: r.pushed}); same++; debug('readmes', `${r.full}: README unchanged (304)`); }
      else if (res.status === 404) { S.readmes[k] = readmeRecord(r, {}); debug('readmes', `${r.full}: the repo has no README`); }   // repo has no README
      else {
        const text = await res.text();
        if (g !== S.gen) return;
        S.readmes[k] = readmeRecord(r, {t: text, etag: res.headers.get('ETag')}); got++;
        info('readmes', `${r.full}: downloaded over REST, ${text.length.toLocaleString()} characters`);
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
  info('sync', 'Refresh latest tiles: last commit, last release, languages and the 12-month chart of every repo that needs it');
  if (!S.token) { needToken(); return status('⚠ Releases/commits need a token (GraphQL). Add one in the 🔑 panel.'); }
  const t0 = performance.now(), wantReadmes = Object.keys(S.readmes).length > 0;
  plan([['details'], wantReadmes && ['readmes']].filter(Boolean));
  const {summary} = await refreshDetails(g, {wantReadmes, wantEnrich: true});
  if (g === S.gen) status(`${summary} · ${secs(t0)}`);
}

export async function indexReadmes(g) {
  info('readmes', `Index READMEs: ${S.repos.length.toLocaleString()} repos, a README is downloaded only when its git hash changed`);
  const t0 = performance.now();
  plan([S.token && ['details', 'Check repos & README versions'], ['readmes']].filter(Boolean));
  const {summary} = await refreshDetails(g, {wantReadmes: true, wantEnrich: !!S.token});
  if (g !== S.gen) return;
  $('#inReadme').checked = true;
  bumpIndex();
  render();
  status(`${summary} · ${secs(t0)}`);
}
