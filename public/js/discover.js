/* Discover: themes, patterns and smart suggestions.

  1. Themes are detected from your stars: distinctive words shared by several repos (repo name > topics > description),
     scored so that words naming projects and tight clusters win ("scrcpy") over broad words ("android").
     Words covering the same repos are merged into one theme.
  2. For a theme, candidates come from independent signals, each adding points and a visible reason:
     keyword search (name/description/README, forks included) · topic search · repos whose README mentions one of the
     theme's projects · most-starred forks of the theme's top repos · links inside your cached READMEs.
  3. Ranking = relevance to the theme + number of signals + popularity − staleness. Curated "awesome" lists are pushed
     down, and a fork doesn't get credit for README text it inherited from its parent.
  Starred and dismissed (✕) repos are always excluded. Results are cached for 3 days in data/discover_<user>.json. */
import {S, ukey, readmeText, readmeLower, starredSet, starredIds} from './state.js';
import {$, DAY, esc, ago, status, tally} from './util.js';
import {gh, ghSearch, repoMeta, repoCardDetails, repoSortDetails, mapStar, whoAmI, setStar, needToken} from './github.js';
import {saveDisc, saveStars} from './store.js';
import {render, searchFor, card} from './list.js';
import {watchStarCharts} from './starhistory.js';
import {SORT_OPTIONS, sortRepos} from './sort.js';

const DISC_TTL = 3 * DAY;

// ---------------- theme detection ----------------
const STOP = new Set(`the and for with from into over under your you our this that its are was were has have been
  using use used based via simple fast easy small tiny lightweight modern powerful open source free official project projects
  app apps application applications tool tools toolkit library lib libs framework plugin plugins support supports written made
  new best awesome list lists collection curated repo repository code github version like more all any not can will just other
  own one two way ways also get set make build run how what which when where who why etc http https www com org readme doc docs
  file files data user users easily allows allow help helps without within yet some most very work works working
  cli api sdk web implementation example examples demo alternative client server time real text model models engine
  local device devices high quality level full native multi hacktoberfest samples sample template anything top manager`.split(/\s+/));

/** Words of a text: camelCase split, lower-cased, stop words and numbers removed. */
const words = s => (s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9+#]+/)
  .filter(t => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));
const nameWords = name => words(name.replace(/[-_.]/g, ' '));
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

/** Word → weight for one repo: 3 if in its name, 2 in its topics, 1 in its description. */
function repoWords(r) {
  const w = new Map(), add = (list, n) => { for (const t of list) w.set(t, Math.max(w.get(t) || 0, n)); };
  add(words(r.about), 1);
  add(r.topics.flatMap(t => [t, ...words(t.replace(/-/g, ' '))]), 2);
  add(nameWords(r.name), 3);
  return w;
}

function detectThemes() {
  const N = S.repos.length, weight = new Map(), members = new Map();
  for (const r of S.repos) for (const [t, w] of repoWords(r)) {
    weight.set(t, (weight.get(t) || 0) + w);
    if (!members.has(t)) members.set(t, new Set());
    members.get(t).add(r);
  }
  // Words used as a name part in 3+ repos also match inside other names ("escrcpy", "QtScrcpy" → scrcpy).
  const squashed = S.repos.map(r => [r, r.name.toLowerCase().replace(/[^a-z0-9+#]/g, '')]);
  for (const [t, s] of members) {
    if (t.length < 5 || [...s].filter(r => nameWords(r.name).includes(t)).length < 3) continue;
    for (const [r, n] of squashed) if (!s.has(r) && n.includes(t)) { s.add(r); weight.set(t, weight.get(t) + 3); }
  }
  // Score: (avg weight − 0.8)² favours words that name projects, × size^0.8 (many stars around one thing = strong
  // interest) × rarity. Tight niches like "scrcpy" beat broad words like "android".
  const cands = [...members].filter(([, s]) => s.size >= 3 && s.size <= Math.max(12, N * 0.2))
    .map(([t, s]) => ({t, s, score: (weight.get(t) / s.size - 0.8) ** 2 * s.size ** 0.8 * Math.log(N / s.size)}))
    .sort((a, b) => b.score - a.score).slice(0, 150);
  const themes = [];
  for (const c of cands) {
    const th = themes.find(x => jaccard(x.core, c.s) >= 0.45);
    if (th) { th.keys.push(c.t); for (const r of c.s) th.all.add(r); }
    else themes.push({keys: [c.t], core: c.s, all: new Set(c.s)});
  }
  const recent = Date.now() - 120 * DAY;
  return themes.slice(0, 60).map(th => {
    const m = [...th.all].sort((a, b) => b.stars - a.stars);
    return {id: 'theme:' + th.keys.slice(0, 3).join('+'), keys: th.keys.slice(0, 5), members: m,
      recent: m.filter(r => Date.parse(r.starred) > recent).length};
  });
}

// ---------------- signals ----------------
const NOT_OWNER = /^(orgs|topics|sponsors|features|about|settings|marketplace|apps|login|users|site|contact|pricing|search|collections|trending|security|customer-stories|enterprise|readme)$/i;
const NOT_REPO = /^(issues|pulls|releases|wiki|actions|blob|tree|raw|workflows|discussions)$/i;
/** github.com/<owner>/<repo> links in a starred repo's cached README (badges, "related", "alternatives"…). */
function readmeLinks(r) {
  const out = new Set();
  for (const [, o, n0] of readmeText(r).matchAll(/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})/g)) {
    const n = n0.replace(/\.git$/, '').replace(/\.+$/, '');
    if (!n || NOT_OWNER.test(o) || NOT_REPO.test(n)) continue;
    const f = `${o}/${n}`;
    if (f.toLowerCase() !== r.full.toLowerCase()) out.add(f);
  }
  return out;
}

const isCuratedList = x => /awesome|curated|(^|[-_])list([-_]|$)|free-lunch|great-open/i.test(x.full_name) ||
  /curated list|collection of|list of (awesome|the best|useful)/i.test(x.description || '');

/** True if a candidate must never be shown: already starred (by id or name, so renames can't slip through) or dismissed. */
function excluded(x) {
  const name = x.full_name.toLowerCase();
  return starredSet().has(name) || (x.id != null && starredIds().has(x.id)) || S.disc.dismissed.includes(name);
}

/** Collects candidates from all signals, then scores them against the theme keywords. */
function collector(keys) {
  const cands = new Map();
  const add = (x, reason, pts) => {
    if (!x?.full_name || excluded(x)) return;
    const k = x.full_name.toLowerCase();
    let c = cands.get(k);
    if (!c) cands.set(k, c = {x, reasons: [], sig: 0});
    if (x.stargazers_count != null && c.x.stargazers_count == null) c.x = x;
    if (!c.reasons.includes(reason)) { c.reasons.push(reason); c.sig += pts; }
  };
  const finish = () => [...cands.values()].map(c => {
    const x = c.x, name = nameWords(x.full_name.split('/')[1] || ''), desc = words(x.description), tp = x.topics || [];
    let rel = 0;
    for (const k of keys) {
      if (name.includes(k) || x.full_name.toLowerCase().includes(k)) rel += 3;
      if (desc.includes(k)) rel += 2;
      if (tp.includes(k)) rel += 2;
    }
    const stale = x.pushed_at && Date.now() - Date.parse(x.pushed_at) > 2 * 365 * DAY;
    const list = isCuratedList(x);
    const reasons = list ? ['📚 curated list', ...c.reasons] : c.reasons;
    // A fork inherits its parent's README, so "README mentions …" isn't independent evidence for it.
    const sig = c.sig - (c.reasons.some(r => r.startsWith('fork of')) ? c.reasons.filter(r => r.startsWith('README mentions')).length * 2 : 0);
    const score = rel * 1.5 + sig * 2 + Math.log10((x.stargazers_count || 0) + 1) * 1.5 - (stale ? 2 : 0) - (x.archived ? 3 : 0) - (list ? 8 : 0);
    return {x: {id: x.id, full_name: x.full_name, html_url: x.html_url || 'https://github.com/' + x.full_name, description: x.description,
      stargazers_count: x.stargazers_count, forks_count: x.forks_count, open_issues_count: x.open_issues_count,
      created_at: x.created_at, pushed_at: x.pushed_at, homepage: x.homepage, owner: x.owner,
      license: typeof x.license === 'string' ? x.license : x.license?.spdx_id,
      archived: x.archived, fork: x.fork, language: x.language, topics: tp.slice(0, 12)}, reasons, score: +score.toFixed(1)};
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
  return {add, finish};
}

/* ---------------- explorers ----------------
  Every explorer takes a `depth`: 0 = first run, 1, 2… = "fetch the next page of every source". When fewer than
  MIN_VISIBLE suggestions are left (after starring or dismissing), the next depth runs automatically and its finds are
  merged in, so there's always something to suggest. When a deeper run adds nothing new, the result is marked
  `exhausted` and no more requests are made for it (↻ Refresh starts over). */
const MIN_VISIBLE = 12, MAX_DEPTH = 5;
let busy = false;
const fresh = id => { const r = S.disc.results[id]; return r && Date.now() - r.at < DISC_TTL; };
const progress = text => { const el = $('#dres'); if (el) el.innerHTML = `<p class="muted">⏳ ${esc(text)}</p>`; };
const visible = res => res.items.filter(c => !excluded(c.x));

/** Runs an explorer (depth 0 replaces the result, deeper runs merge into it), saves it and shows it. */
async function explore(id, {force = false, depth = 0}, run) {
  if (!force && !depth && fresh(id)) return showResults(id);
  if (busy) return status('⏳ Discovery already running, please wait');
  busy = true;
  const g = S.gen;
  try {
    const result = await run(g, depth);
    if (g !== S.gen || !result) return;
    const old = depth ? S.disc.results[id] : null;
    let items = result.items;
    if (old) {   // merge: keep the best score and all reasons for repos found again
      const byName = new Map(old.items.map(c => [c.x.full_name.toLowerCase(), c]));
      for (const c of result.items) {
        const k = c.x.full_name.toLowerCase(), prev = byName.get(k);
        byName.set(k, prev ? {...prev, score: Math.max(prev.score, c.score), reasons: [...new Set([...prev.reasons, ...c.reasons])]} : c);
      }
      items = [...byName.values()].sort((a, b) => b.score - a.score);
    }
    const added = old ? items.length - old.items.length : items.length;
    S.disc.results[id] = {...(old || {}), ...result, items, at: old?.at || Date.now(), depth,
      sortDatesAt: depth ? null : undefined,   // a deeper page adds candidates that need dates too
      exhausted: depth >= MAX_DEPTH || (depth > 0 && added === 0)};
    await saveDisc(g);
    showResults(id);
  } catch (e) { progress('⚠ ' + e.message); }
  finally { busy = false; }
}

/** Fetches the next depth for a result (used when it runs low). */
function topUp(id) {
  const res = S.disc.results[id];
  if (!res || res.exhausted || busy) return;
  const depth = (res.depth || 0) + 1;
  if (id === 'mentions') return exploreMentions({depth});
  if (id === 'owners') return exploreOwners({depth});
  exploreTheme(id, res.keys, membersOf(res), {depth});
}
const membersOf = res => {
  const byId = new Map(S.repos.map(r => [r.id, r]));
  return res.memberIds?.map(i => byId.get(i)).filter(Boolean) ?? keywordMembers(res.keys);
};

function exploreTheme(id, keys, members, opts = {}) {
  return explore(id, opts, async (g, depth) => {
    const {add, finish} = collector(keys), note = [];
    const page = depth + 1;
    const step = async (label, fn) => {
      if (g !== S.gen) return;
      progress(depth ? `Finding more suggestions (round ${page})… ${label}` : label);
      try { await fn(); } catch (e) { note.push(`${label.replace(/…$/, '')}: ${e.message}`); }
    };
    const n = S.token ? 3 : 1;   // search API allows 30/min with a token, 10/min without
    // 1. keyword searches, forks included (a fork is often exactly what you're after)
    for (const k of keys.slice(0, n)) await step(`Searching “${k}”…`, async () => {
      for (const x of await ghSearch(`${k} in:name,description,readme fork:true`, 60, page)) add(x, `matches “${k}”`, 1);
    });
    if (keys.length > 1) await step('Searching keyword combination…', async () => {
      for (const x of await ghSearch(`${keys[0]} ${keys[1]} fork:true`, 40, page)) add(x, `matches “${keys[0]} + ${keys[1]}”`, 1.5);
    });
    // 2. topic search, for keys that are real topics among your stars
    for (const k of keys.filter(k => members.some(r => r.topics.includes(k))).slice(0, n)) await step(`Topic ${k}…`, async () => {
      for (const x of await ghSearch(`topic:${k}`, 40, page)) add(x, `topic: ${k}`, 1.5);
    });
    // 3. repos whose README mentions one of the theme's projects (GUIs, wrappers, add-ons, alternatives)
    for (const name of members.map(r => r.name).filter(x => x.length >= 5 && !STOP.has(x.toLowerCase())).slice(0, n)) {
      await step(`Repos mentioning ${name}…`, async () => {
        for (const x of await ghSearch(`"${name}" in:readme fork:true`, 40, page)) add(x, `README mentions ${name}`, 2);
      });
    }
    // 4. most-starred forks of the theme's top repos
    for (const r of members.filter(r => !r.fork).slice(0, n)) await step(`Forks of ${r.full}…`, async () => {
      const res = await gh(`/repos/${r.full}/forks?sort=stargazers&per_page=100&page=${page}`);
      if (res.ok) for (const x of await res.json()) if (x.stargazers_count >= 1) add(x, `fork of ${r.full}`, 2);
    });
    // 5. links inside the theme's cached READMEs (all found on the first run)
    if (!depth) await step('Reading links in your starred READMEs…', async () => {
      const links = new Map();
      for (const r of members) for (const f of readmeLinks(r)) {
        const k = f.toLowerCase();
        if (starredSet().has(k)) continue;
        if (!links.has(k)) links.set(k, {f, from: []});
        links.get(k).from.push(r.name);
      }
      const top = [...links.values()].sort((a, b) => b.from.length - a.from.length).slice(0, 80);
      const meta = await repoMeta(top.map(c => c.f));
      for (const c of top) {
        const x = meta.get(c.f.toLowerCase());
        if (x) add(x, `linked from ${c.from.slice(0, 3).join(', ')}${c.from.length > 3 ? '…' : ''} README`, 2.5 * c.from.length);
      }
    });
    return {keys, memberIds: members.map(r => r.id), items: finish(), note};
  });
}

/** Repos linked from your starred READMEs: 2+ different stars first; deeper rounds also take single links. */
function exploreMentions(opts = {}) {
  if (!Object.keys(S.readmes).length) {
    $('#dres').innerHTML = '<p class="muted">Click <b>Index READMEs</b> first: this view reads the links inside your starred repos\' READMEs.</p>';
    return;
  }
  return explore('mentions', opts, async (g, depth) => {
    progress(depth ? 'Finding more linked repos…' : 'Reading links in all your READMEs…');
    const links = new Map();
    for (const r of S.repos) for (const f of readmeLinks(r)) {
      const k = f.toLowerCase();
      if (starredSet().has(k)) continue;
      if (!links.has(k)) links.set(k, {f, from: new Set()});
      links.get(k).from.add(r.name);
    }
    // A README linking its own org's repos isn't much of a signal, so links from 2+ different stars come first.
    const ranked = [...links.values()].sort((a, b) => b.from.size - a.from.size);
    const top = ranked.slice(depth * 160, (depth + 1) * 160).filter(c => depth > 0 || c.from.size >= 2);
    const meta = await repoMeta(top.map(c => c.f)), {add, finish} = collector([]);
    for (const c of top) {
      const x = meta.get(c.f.toLowerCase()), from = [...c.from];
      if (x) add(x, `linked from ${from.length} of your stars: ${from.slice(0, 4).join(', ')}${from.length > 4 ? '…' : ''}`, 2 * from.length);
    }
    return {items: finish(), note: S.token ? [] : ['Without a token only the top 12 links get details.']};
  });
}

/** Top repos of owners you star often; deeper rounds go to the next page of each owner and to more owners. */
function exploreOwners(opts = {}) {
  return explore('owners', opts, async (g, depth) => {
    const per = S.token ? 10 : 3;
    const owners = tally(S.repos, r => r.owner).filter(([o, n]) => n >= 2 && o.toLowerCase() !== ukey()).slice(0, per * (depth + 1));
    const {add, finish} = collector([]), note = [];
    for (const [i, [o, n]] of owners.entries()) {
      if (g !== S.gen) return null;
      const page = i >= per * depth ? 1 : depth + 1;   // owners new in this round start at page 1
      progress(`${depth ? 'Finding more… ' : ''}Top repos of ${o}…`);
      try { for (const x of await ghSearch(`user:${o}`, 15, page)) add(x, `by ${o}: you starred ${n} of their repos`, n); }
      catch (e) { note.push(e.message); break; }
    }
    return {items: finish(), note};
  });
}

function exploreKeyword(input) {
  const keys = input.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!keys.length) return;
  const members = keywordMembers(keys);
  $('#dbody').innerHTML = `<p class="muted">“${esc(keys.join(' '))}”: ${members.length} of your stars match. Searching for the ones you're missing…
    <a href="#" data-filterq="${esc(keys.join(' '))}">show my matching stars</a></p>`;
  exploreTheme('kw:' + keys.join('+'), keys, members);
}
/** Suggestions around one starred repo: the same signals as a theme (searches, repos whose README mentions it, its
 *  most-starred forks, links in its README), with keywords picked from the repo in this order:
 *    1. words of its name ("scrcpy", "orca slicer")
 *    2. its topics that other stars of yours share, most shared first ("android", "3d-printer"),
 *       then its remaining topics
 *    3. description words found in 3+ of your stars ("speech"), which skips one-off words like "robust" */
function exploreRepo(repo) {
  const df = new Map();
  for (const r of S.repos) for (const t of repoWords(r).keys()) df.set(t, (df.get(t) || 0) + 1);
  const byShared = list => [...new Set(list)].sort((a, b) => (df.get(b) || 0) - (df.get(a) || 0));
  const name = nameWords(repo.name);
  const topics = byShared(repo.topics.filter(t => !STOP.has(t)));
  const shared = topics.filter(t => df.get(t) >= 2), rest = topics.filter(t => !(df.get(t) >= 2));
  const about = byShared(words(repo.about)).filter(t => df.get(t) >= 3);
  const keys = [...new Set([...name, ...shared, ...rest, ...about])].slice(0, 4);
  if (!keys.length) keys.push(repo.name.toLowerCase());
  openPanel();
  $('#dbody').innerHTML = `<p>✨ Suggestions related to <b>${esc(repo.full)}</b>
    <span class="muted">· based on ${keys.map(k => `“${esc(k)}”`).join(', ')}, repos mentioning it, its forks and its README links</span></p>`;
  $('#insights').scrollIntoView({block: 'start', behavior: 'smooth'});
  exploreTheme('repo:' + repo.id, keys, [repo]);
}

const keywordMembers = keys => S.repos
  .filter(r => keys.some(k => (r.full + ' ' + r.about + ' ' + r.topics.join(' ')).toLowerCase().includes(k) || readmeLower(r).includes(k)))
  .sort((a, b) => b.stars - a.stars);

// ---------------- UI ----------------
let tab = 'themes', themes = [];

const PAGE = 40;
let current = null, shown = PAGE;   // result on screen, and how many of its cards are shown
const SORT_PREF = 'starsViewer.discoverySort';
let discoverySort = 'relevance';
try { discoverySort = localStorage.getItem(SORT_PREF) || 'relevance'; } catch {}
if (!SORT_OPTIONS.some(([key]) => key === discoverySort) || discoverySort === 'starred') discoverySort = 'relevance';

/** Old discovery caches have fewer fields; normalize them for the shared starred-repo card. */
function suggestionRepo(x) {
  const [owner, name] = x.full_name.split('/');
  return {id: x.id, full: x.full_name, name, owner: x.owner?.login || owner, avatar: x.owner?.avatar_url,
    url: x.html_url || `https://github.com/${x.full_name}`, about: x.description, homepage: x.homepage,
    stars: x.stargazers_count, forks: x.forks_count, issues: x.open_issues_count, lang: x.language,
    topics: x.topics || [], license: typeof x.license === 'string' ? x.license : x.license?.spdx_id,
    archived: x.archived, fork: x.fork, created: x.created_at, pushed: x.pushed_at,
    release: x.release, releaseAt: x.releaseAt, commitAt: x.commitAt, activity: x.activity, langs: x.langs};
}

// Exact dates for the whole result pool are only needed for these two choices.
const sortAttempted = new WeakSet();
const sortPending = new WeakSet(), sortIncomplete = new WeakSet();
async function fillSortDates(id, res) {
  if (!S.token || res.sortDatesAt || sortAttempted.has(res)) return;
  sortAttempted.add(res);
  sortPending.add(res);
  $('#dres .discovery-note').textContent = 'Checking exact commit and release dates for the full result list…';
  const g = S.gen, candidates = visible(res);
  let details;
  try { details = await repoSortDetails(candidates.map(c => c.x.full_name)); }
  finally { sortPending.delete(res); }
  if (g !== S.gen || S.disc.results[id] !== res) return;
  for (const c of candidates) {
    const d = details.get(c.x.full_name.toLowerCase());
    if (d) Object.assign(c.x, d);
  }
  if (details.size < candidates.length) sortIncomplete.add(res);
  else res.sortDatesAt = Date.now();   // persisted: reopen without querying the same dates again
  if (details.size) await saveDisc(g);
  if (current === id) showResults(id);
}

/** Renders a result, always without starred/dismissed repos. Cards removed by ☆/✕ are refilled from the pool, and the
 *  pool refills itself from GitHub (next depth) when it runs low. */
function showResults(id) {
  const res = S.disc.results[id], el = $('#dres');
  if (!res || !el) return;
  if (id !== current) { current = id; shown = PAGE; }
  const items = sortRepos([...visible(res)], discoverySort);
  const low = items.length < MIN_VISIBLE && !res.exhausted;
  const empty = !items.length && res.exhausted
    ? `<p>No more suggestions here: everything found is starred or dismissed. Try ↻ Refresh later, another theme, or a keyword.</p>` : '';
  el.innerHTML = `<div class="discovery-controls"><span class="muted">${items.length} suggestions · found ${ago(res.at)}</span>
      <label>Sort <select id="discoverySort" aria-label="Sort suggestions">${SORT_OPTIONS.filter(([key]) => key !== 'starred')
        .map(([key, label]) => `<option value="${key}"${discoverySort === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <button data-refresh="${esc(id)}">↻ Refresh</button></div>
    <p class="muted discovery-note">${(discoverySort === 'release' || discoverySort === 'commit') ?
      (!S.token ? 'Add a token for exact commit and release dates.' : sortPending.has(res) ? 'Checking exact dates…' : sortIncomplete.has(res) ? 'Some dates could not be checked; refresh to retry.' : '') : ''}
      ${low ? ' · ⏳ finding more…' : ''}${res.note?.length ? `<br>⚠ ${res.note.map(esc).join(' · ')}` : ''}</p>
    ${empty}<ul class="sugg">${items.slice(0, shown).map(c => card(suggestionRepo(c.x), {suggestion: true, reasons: c.reasons})).join('')}</ul>
    ${items.length > shown ? `<button data-more>Show more (${items.length - shown} left)</button>` : ''}`;
  watchStarCharts(el);   // star history of the suggestions loads as they scroll into view
  if (low) topUp(id);   // runs in the background and re-renders when done
  else fillCardDetails(id, items.slice(0, shown));
  if ((discoverySort === 'release' || discoverySort === 'commit') && S.token) fillSortDates(id, res);
}

/** Hydrate only the cards on screen, then persist those details with the discovery result. */
let cardBusy = false;
async function fillCardDetails(id, onScreen) {
  const need = onScreen.filter(c => c.x.cardDetailsVersion !== 2);
  if (!S.token || cardBusy || !need.length) return;
  cardBusy = true;
  const g = S.gen;
  let updated = false;
  try {
    const found = await repoCardDetails(need.map(c => c.x.full_name));
    if (g !== S.gen) return;
    for (const c of need) {
      const d = found.get(c.x.full_name.toLowerCase());
      if (d) { Object.assign(c.x, d, {cardDetailsVersion: 2}); updated = true; }
    }
    if (updated) await saveDisc(g);
  } finally { cardBusy = false; }
  if (updated && current && !busy && g === S.gen) showResults(current);
}

function overviewHTML() {
  const bars = (list, explore = false) => { const max = list[0]?.[1] || 1; return list.slice(0, 10).map(([k, c]) =>
    `<div class="barline"><span title="${esc(k)}">${explore ? `<button class="pattern-link" data-pattern="${esc(k)}" title="Find related repositories">${esc(k)}</button>` : esc(k)}</span><i style="width:${c / max * 120}px"></i><span class="muted">${c}</span></div>`).join(''); };
  const since = Date.now() - 90 * DAY;
  const stale = S.repos.filter(r => r.archived || Date.now() - Date.parse(r.commitAt || r.pushed) > 2 * 365 * DAY).length;
  return `<div class="row">
    <div><h3>Top topics</h3>${bars(tally(S.repos, r => r.topics), true)}</div>
    <div><h3>Trending for you (last 90 days)</h3>${bars(tally(S.repos, r => Date.parse(r.starred) > since ? r.topics : []), true) || '<p class="muted">No recent stars.</p>'}</div>
    <div><h3>Languages</h3>${bars(tally(S.repos, r => r.lang), true)}</div>
    <div><h3>Stars per year</h3>${bars(tally(S.repos, r => r.starred?.slice(0, 4)).sort((a, b) => b[0] - a[0]))}
      <p class="muted">${stale} look stale (archived or no commit in 2y) · ${S.repos.filter(r => r.stars < 500).length} hidden gems (&lt;500★) · ${S.repos.filter(r => r.fork).length} forks</p></div></div>
    <p class="muted">Click a topic or language to find related repos. You can sort the results in Discover.</p>`;
}

function themesHTML() {
  themes = detectThemes();
  const group = (title, pick) => `<h3>${title}</h3><div class="themes">${themes.map((t, i) => !pick(t) ? '' : `<div class="theme" data-theme="${i}">
      <b>${esc(t.keys.slice(0, 3).join(' · '))}</b> <span class="muted">${t.members.length} repos${t.recent ? ` · 🔥 ${t.recent} recent` : ''}${S.disc.results[t.id] ? ' · ✓ explored' : ''}</span>
      <div class="muted small">${t.members.slice(0, 5).map(r => esc(r.name)).join(', ')}${t.members.length > 5 ? '…' : ''}</div></div>`).join('')}</div>`;
  return `<p class="muted">Clusters detected in your ${S.repos.length} stars. Pick one to hunt for related repos you haven't starred yet
    (searches, forks, READMEs that mention them, links in your READMEs).</p>` +
    group('Niches', t => t.members.length <= 25) + group('Broad interests', t => t.members.length > 25);
}

/** Opens the panel with its tab bar and empty body/result areas, without loading any tab content. */
function openPanel(activeTab = null) {
  const box = $('#insights');
  box.classList.add('show');
  const tabs = [['themes', 'Your themes'], ['mentions', 'Linked from your READMEs'], ['owners', 'Owners you like'], ['overview', 'Patterns']];
  box.innerHTML = `<div class="tabs">${tabs.map(([k, l]) => `<button data-dtab="${k}" class="${activeTab === k ? 'on' : ''}">${l}</button>`).join('')}
      <form id="kwForm"><input id="kw" placeholder="Explore any keyword, e.g. scrcpy" aria-label="Keyword"><button>Explore</button></form></div>
    <div id="dbody"></div><div id="dres"></div>`;
  $('#kwForm').onsubmit = e => { e.preventDefault(); exploreKeyword($('#kw').value); };
}

/** Opens/closes the panel (no argument) or switches tab. */
function show(newTab) {
  const box = $('#insights');
  if (!newTab) { box.classList.toggle('show'); if (!box.classList.contains('show')) return; }
  if (!S.repos.length) { box.innerHTML = '<p class="muted">Load some stars first.</p>'; return; }
  current = null;   // a result from a previous tab must not redraw over this tab
  tab = newTab || tab;
  openPanel(tab);
  if (tab === 'themes') $('#dbody').innerHTML = themesHTML();
  else if (tab === 'mentions') exploreMentions();
  else if (tab === 'owners') exploreOwners();
  else $('#dbody').innerHTML = overviewHTML();
}
export const closeDiscover = () => $('#insights').classList.remove('show');

/* Stars a suggestion on GitHub; it then joins your stars and its card is replaced by the next suggestion.
   Needs a token allowed to star: classic token with "public_repo", or fine-grained with "Starring: read and write".
   Only for your own list: a star always goes to the token owner's account. */
async function starSuggestion(full, btn) {
  if (!S.token) { needToken(); return status('⚠ Starring needs a token. See the 🔑 panel.'); }
  btn.disabled = true;
  btn.textContent = 'Starring…';
  try {
    const me = await whoAmI();
    if (me.toLowerCase() !== ukey()) throw new Error(`You're viewing ${S.user}'s stars. Starring only works on your own list (${me}).`);
    const code = await setStar(full, true);
    if (code === 403 || code === 404) { needToken(); throw new Error('Your token can read but not star. Create one with the "public_repo" scope (the 🔑 panel explains how).'); }
    if (code >= 300) throw new Error('GitHub ' + code);
    // Add it to your stars locally right away (1 request) instead of re-syncing everything.
    const x = await (await gh('/repos/' + full)).json();
    S.repos = [mapStar({starred_at: new Date().toISOString(), repo: x}), ...S.repos];
    S.starPages = [];   // page ETags are outdated now; the next check refetches the list
    await saveStars(); render();
    status(`★ Starred ${full} on GitHub (unstar it from github.com if that was a mistake)`);
    showResults(current);   // the starred card disappears and the next suggestion takes its place
  } catch (e) {
    status('⚠ ' + e.message);
    btn.disabled = false;
    btn.textContent = '☆ Star';
  }
}

export function initDiscover() {
  $('#toggleInsights').onclick = () => show();
  $('#insights').addEventListener('change', e => {
    if (e.target.id !== 'discoverySort') return;
    discoverySort = e.target.value;
    try { localStorage.setItem(SORT_PREF, discoverySort); } catch {}
    shown = PAGE;
    if (current) showResults(current);
  });
  window.addEventListener('suggest-for', e => {   // "✨ Show suggestions" on a repo card (list.js)
    const repo = S.repos.find(r => r.id === e.detail);
    if (repo) exploreRepo(repo);
  });
  $('#insights').addEventListener('click', async e => {
    const t = e.target.closest('[data-dtab],[data-theme],[data-dismiss],[data-refresh],[data-filterq],[data-pattern],[data-star],[data-more]');
    if (!t) return;
    const d = t.dataset;
    if (d.star) starSuggestion(d.star, t);
    else if (d.more !== undefined) { shown += PAGE; showResults(current); }
    else if (d.dtab) show(d.dtab);
    else if (d.pattern) exploreKeyword(d.pattern);
    else if (d.theme) {
      const th = themes[+d.theme];
      document.querySelectorAll('.theme.on').forEach(x => x.classList.remove('on'));
      t.classList.add('on');
      exploreTheme(th.id, th.keys, th.members);
    } else if (d.dismiss) {
      if (!S.disc.dismissed.includes(d.dismiss)) S.disc.dismissed.push(d.dismiss);
      showResults(current);   // the next suggestion takes its place
      await saveDisc();
    } else if (d.refresh) {   // start over from depth 0 (works from any tab: members come from stored ids)
      const id = d.refresh, res = S.disc.results[id];
      if (id === 'mentions') exploreMentions({force: true});
      else if (id === 'owners') exploreOwners({force: true});
      else if (res) exploreTheme(id, res.keys, membersOf(res), {force: true});
    } else if (d.filterq) { e.preventDefault(); searchFor(d.filterq); }
  });
}
