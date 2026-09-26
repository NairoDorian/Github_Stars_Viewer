/* Keeping the cache in sync with GitHub while doing as little work as possible.

  Checks, cheapest first:
   1. Star list: every page fetched in parallel, each with its ETag. An unchanged page answers 304 (tiny, and free
      against the rate limit) and is rebuilt from the cache.
   2. `pushed_at` is the "dirty" flag: if it didn't change since a repo was cached, nothing in it changed
      (no commit → no new README/commit date) → zero requests for that repo.
   3. Repos that did change: one GraphQL call per 20 repos (8 in parallel) returns latest release + last commit +
      README hash together.
   4. README hash equal to the cached one (or to the hash of the cached text) → no download. Only READMEs that really
      changed are downloaded, 10 per GraphQL call. Unusual README names/locations fall back to REST with ETags.
   A safety-net max age (spread per repo so they don't all expire the same day) re-checks things occasionally.

  Nothing is deleted before its replacement arrived: a failed or aborted refresh always leaves the previous data. */
import {S, rkey} from './state.js';
import {DAY, status, secs, pool, chunks} from './util.js';
import {gh, gql, repoQ, mapStar, gitSha, needToken} from './github.js';
import {saveStars, saveReadmes} from './store.js';
import {render} from './list.js';

const ENRICH_MAX_AGE = 7 * DAY, README_MAX_AGE = 30 * DAY, README_MAX_CHARS = 100_000;
const README_NAMES = ['README.md', 'readme.md'];   // checked via GraphQL; covers most repos
const DETAIL_FIELDS = ['release', 'releaseAt', 'commitAt', 'enrichedAt', 'enrichedPushed'];

const spread = r => ((r.id || 0) % 7) * DAY;
export const needsEnrich = r => !r.enrichedAt || r.enrichedPushed !== r.pushed || Date.now() - r.enrichedAt > ENRICH_MAX_AGE + spread(r);
export const needsReadme = r => {
  const c = S.readmes[rkey(r)];
  return !c || c.pushed !== r.pushed || Date.now() - c.at > README_MAX_AGE + spread(r);
};
const readmeRecord = (r, fields) => ({t: '', sha: null, etag: null, path: null, ...fields, at: Date.now(), pushed: r.pushed});

// ---- one network job at a time ----
let running = null;
/** Runs job(gen) unless another job is running. Errors end up in the status line. */
export function task(job) {
  if (running) { status('⏳ Busy with another task, please wait'); return running; }
  running = job(S.gen).catch(e => status('⚠ ' + e.message)).finally(() => { running = null; });
  return running;
}
export const waitIdle = () => running || Promise.resolve();

/** Older caches keyed READMEs by "owner/name" and stored plain strings: convert in place, no re-download. */
export function migrateReadmes() {
  const byFull = new Map(S.repos.map(r => [r.full, r]));
  for (const [k, v] of Object.entries(S.readmes)) {
    if (typeof v !== 'string' && !k.includes('/')) continue;
    const r = byFull.get(k);
    delete S.readmes[k];
    if (r) S.readmes[rkey(r)] = typeof v === 'string' ? readmeRecord(r, {t: v}) : v;
  }
}

// ---- 1. star list ----
/** All pages in parallel, each conditional on its cached ETag. Returns [{etag, ids, items, hit}] in page order. */
async function fetchStarPages(g) {
  const cachedById = new Map(S.repos.map(r => [r.id, r]));
  const fetchPage = async (p, useEtag = true) => {
    const old = S.starPages[p - 1];
    const r = await gh(`/users/${encodeURIComponent(S.user)}/starred?per_page=100&page=${p}`,
      {Accept: 'application/vnd.github.star+json', ...(useEtag && old?.etag ? {'If-None-Match': old.etag} : {})});
    if (r.status === 404) throw new Error(`User "${S.user}" not found`);
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
  const lastPage = first.last || (first.hit ? S.starPages.length : 1) || 1;
  const pages = [first];
  await pool(Array.from({length: lastPage - 1}, (_, i) => i + 2), 10, async p => { pages[p - 1] = await fetchPage(p); });
  // The list may have grown beyond what the cache knew: continue while pages come back full.
  while (pages.at(-1).items.length === 100 && g === S.gen) pages.push(await fetchPage(pages.length + 1));
  return pages;
}

/** Full check: star list, then details (releases/READMEs) for whatever changed. */
export async function sync(g) {
  const t0 = performance.now();
  status('Checking GitHub (all pages in parallel)…');
  const pages = await fetchStarPages(g);
  if (g !== S.gen) return;
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
    for (const f of DETAIL_FIELDS) r[f] = o[f];   // keep details; needsEnrich() decides if they're still valid
    const oldKey = rkey(o), newKey = rkey(r);      // old caches had no id: re-key the README entry
    if (oldKey !== newKey && S.readmes[oldKey]) { S.readmes[newKey] = S.readmes[oldKey]; delete S.readmes[oldKey]; }
  }
  const freshFulls = new Set([...fresh.values()].map(r => r.full));
  const removed = S.repos.filter(r => !(r.id ? fresh.has(r.id) : freshFulls.has(r.full))).length;
  const hadEnrich = S.repos.some(r => r.enrichedAt || r.commitAt);
  const hadReadmes = Object.keys(S.readmes).length > 0;

  S.repos = [...fresh.values()];
  S.starPages = pages.map(({etag, ids}) => ({etag, ids}));
  const keep = new Set(S.repos.map(rkey));
  for (const k of Object.keys(S.readmes)) if (!keep.has(k)) delete S.readmes[k];   // unstarred
  await saveStars(g);
  if (removed) await saveReadmes(g);

  const diff = [added && `+${added} new`, changed && `${changed} with new commits`, renamed && `${renamed} renamed`,
    removed && `−${removed} unstarred`].filter(Boolean).join(' · ') || 'list up to date';
  const hits = pages.filter(p => p.hit).length;
  status(`${S.repos.length} stars · ${diff} · ${pages.length} pages in ${secs(t0)}${hits ? ` (${hits} unchanged)` : ''}`);
  render();

  // Details only for what's missing or stale, and only for the kinds of data fetched before.
  const res = hadEnrich || hadReadmes ? await refreshDetails(g, {wantReadmes: hadReadmes, wantEnrich: hadEnrich}) : null;
  if (g === S.gen) status(`${S.repos.length} stars · ${diff} · ${res?.summary ? res.summary + ' · ' : ''}all checked in ${secs(t0)}`);
}

// ---- 2-4. releases, commits, READMEs ----
/** Refreshes details of repos that need it. Returns {summary}. */
async function refreshDetails(g, {wantReadmes, wantEnrich}) {
  if (!S.token) return wantReadmes ? restReadmes(g, S.repos.filter(needsReadme)) : {summary: 'add a token for releases'};
  const todo = S.repos.filter(r => (wantEnrich && needsEnrich(r)) || (wantReadmes && needsReadme(r)));
  if (!todo.length) return {summary: 'details up to date (0 requests)'};

  const fields = 'latestRelease{tagName publishedAt} defaultBranchRef{target{...on Commit{committedDate}}}' +
    (wantReadmes ? ' ' + README_NAMES.map((n, k) => `m${k}:object(expression:${JSON.stringify('HEAD:' + n)}){...on Blob{oid}}`).join(' ') : '');
  const download = [], viaRest = [];
  let checked = 0, same = 0, fatal = null;

  await pool(chunks(todo, 20), 8, async batch => {
    if (fatal || g !== S.gen) return;
    let data;
    try { data = await gql('query{' + batch.map((r, j) => repoQ('r' + j, r.owner, r.name, fields)).join(' ') + '}'); }
    catch (e) { fatal = e; return; }
    const now = Date.now();
    for (const [j, r] of batch.entries()) {
      const d = data['r' + j];   // null = deleted/private/blocked: still marked checked so it isn't retried every sync
      Object.assign(r, {release: d?.latestRelease?.tagName, releaseAt: d?.latestRelease?.publishedAt,
        commitAt: d?.defaultBranchRef?.target?.committedDate, enrichedAt: now, enrichedPushed: r.pushed});
      if (!wantReadmes || !needsReadme(r)) continue;
      const k = rkey(r), c = S.readmes[k];
      if (!d) { S.readmes[k] = c ? {...c, at: now, pushed: r.pushed} : readmeRecord(r, {}); continue; }
      const hit = README_NAMES.map((path, i) => d['m' + i] && {path, oid: d['m' + i].oid}).find(Boolean);
      if (!hit) { viaRest.push(r); continue; }
      if (c && (c.sha === hit.oid || (!c.sha && c.t && await gitSha(c.t) === hit.oid))) {
        Object.assign(c, {sha: hit.oid, path: hit.path, at: now, pushed: r.pushed}); same++;
      } else download.push({r, ...hit});
    }
    checked += batch.length;
    status(`Checked ${checked}/${todo.length} changed repos…`);
  });
  if (g !== S.gen) return {summary: ''};
  await saveStars(g);

  let got = 0;
  await pool(chunks(download, 10), 8, async batch => {
    if (fatal || g !== S.gen) return;
    let data;
    try { data = await gql('query{' + batch.map((x, j) => repoQ('r' + j, x.r.owner, x.r.name, `object(expression:${JSON.stringify('HEAD:' + x.path)}){...on Blob{text}}`)).join(' ') + '}'); }
    catch (e) { fatal = e; return; }
    batch.forEach((x, j) => {
      const text = data['r' + j]?.object?.text;
      if (text == null) { viaRest.push(x.r); return; }   // binary or too large for GraphQL: REST handles it
      S.readmes[rkey(x.r)] = readmeRecord(x.r, {t: text.slice(0, README_MAX_CHARS), sha: x.oid, path: x.path});
      got++;
    });
    status(`Downloading changed READMEs ${got}/${download.length}…`);
  });

  const rest = viaRest.length && !fatal ? await restReadmes(g, viaRest, true) : null;
  await saveReadmes(g);
  if (g !== S.gen) return {summary: ''};
  render();
  return {summary: `${todo.length} changed repos checked` +
    (wantReadmes ? ` · READMEs: ${same + (rest?.same || 0)} unchanged, ${got + (rest?.got || 0)} downloaded` : '') +
    (fatal ? ` · ⚠ ${fatal.message} (progress saved)` : '')};
}

/** REST path (no token, or unusual README names). ETag conditional requests make "unchanged" nearly free. */
async function restReadmes(g, todo, quiet = false) {
  if (!todo.length) return {got: 0, same: 0, summary: 'READMEs up to date (0 requests)'};
  if (!S.token && todo.length > 50) status(`⚠ ${todo.length} READMEs to check but only ~60 requests/hour without a token. Add one in the 🔑 panel.`);
  let done = 0, same = 0, got = 0, failed = 0, fatal = null;
  await pool(todo, 12, async r => {
    if (fatal || g !== S.gen) return;
    const k = rkey(r), c = S.readmes[k];
    try {
      const res = await gh(`/repos/${r.full}/readme`, {Accept: 'application/vnd.github.raw', ...(c?.etag ? {'If-None-Match': c.etag} : {})});
      if (g !== S.gen) return;
      if (res.status === 304) { Object.assign(c, {at: Date.now(), pushed: r.pushed}); same++; }
      else if (res.status === 404) S.readmes[k] = readmeRecord(r, {});   // repo has no README
      else { S.readmes[k] = readmeRecord(r, {t: (await res.text()).slice(0, README_MAX_CHARS), etag: res.headers.get('ETag')}); got++; }
    } catch (e) { if (/Rate limited|Token/.test(e.message)) fatal = e; else failed++; }   // transient: retried next time
    if (!quiet && ++done % 25 === 0) status(`READMEs ${done}/${todo.length}…`);
  });
  if (!quiet) { await saveReadmes(g); render(); }
  return {got, same, summary: `READMEs: ${same} unchanged, ${got} downloaded${failed ? `, ${failed} failed (retried next time)` : ''}` +
    (fatal ? ` · ⚠ ${fatal.message}` : '')};
}

// ---- toolbar actions ----
export async function enrich(g) {
  if (!S.token) { needToken(); return status('⚠ Releases/commits need a token (GraphQL). Add one in the 🔑 panel.'); }
  const t0 = performance.now();
  const {summary} = await refreshDetails(g, {wantReadmes: Object.keys(S.readmes).length > 0, wantEnrich: true});
  if (g === S.gen) status(`${summary} · ${secs(t0)}`);
}

export async function indexReadmes(g) {
  const t0 = performance.now();
  const {summary} = await refreshDetails(g, {wantReadmes: true, wantEnrich: !!S.token});
  if (g !== S.gen) return;
  document.querySelector('#inReadme').checked = true;
  render();
  status(`${summary} · ${secs(t0)}`);
}
