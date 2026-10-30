// Entry point: boot, loading a profile (yours, or someone else's as a visit), and toolbar wiring.
//
// Module map (imports only point downwards; list.js never imports discover.js, sync.js or users.js, they talk through DOM events):
//   util.js         helpers: DOM, formatting (cached date formats), safe HTML, concurrency, status line
//   state.js        the shared state object S, generation/cancellation, per-repo cache keys, search-text caches
//   store.js        the cache: ./data files via server.js locally, or IndexedDB / memory online; sharded history; visit memory
//   github.js       GitHub REST/GraphQL client: retries, rate limits, batching, data mapping, last commit / release
//   sync.js         keeping stars, tiles and READMEs in sync with GitHub cheaply; one job at a time per profile
//   history.js      every commit message and release note of every star: fetching, options, stripping
//   histopts.js     the ▾ options panel of the commit & release index
//   progress.js     the live progress panel: one bar per step, counts, speed, time left
//   sort.js         shared ordering rules (stars and Discover results)
//   list.js         search, qualifiers, facet filters, export, repo cards
//   discover.js     themes, suggestions, star / unstar buttons
//   users.js        the Users panel: every owner in your stars and how many repos they starred
//   starhistory.js  star history charts from star-history.com (lazy, cached)
//   token.js        the 🔑 token panel
//
// Two kinds of profile: YOURS (S.home, saved as the cache toggle says) and VISITS (anyone else: S.visit). A visit shows
// someone's stars and keeps them in memory only; store.js refuses to write them anywhere. Typing another name, the Users
// panel's 👁 Visit button and ?visit=<login> all start a visit; "★ Make this my profile" turns a visit into your profile.
import {S, ukey, nextGen, bumpIndex, isMine, mineOf} from './state.js';
import {starredOf} from './github.js';
import {$, ago, esc, status} from './util.js';
import {get, peek, saveConfig, initStore, setPersist, persisting, isUnreadable, clearAll, saveAll, loadHistory, forgetHistoryDirty, setVisit, adoptProfile, CACHE_VERSION} from './store.js';
import {task, waitIdle, sync, enrich, indexReadmes, migrateReadmes} from './sync.js';
import {indexHistory} from './history.js';
import {initHistOpts, resetHistOpts, reconcileStored} from './histopts.js';
import {render, initList, resetFilters, resetListPrefs, prepareHistorySearch} from './list.js';
import {initDiscover, closeDiscover, resetDiscoverPrefs} from './discover.js';
import {initUsers, closeUsers, renderUsers, resetUsersPrefs} from './users.js';
import {initToken, setToken} from './token.js';
import {forgetStarCharts} from './starhistory.js';

/** "NairoDorian", "@NairoDorian" or "https://github.com/NairoDorian?tab=stars" → "NairoDorian". */
function parseUser(v) {
  v = v.trim();
  const m = v.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)(?:[/?#].*)?$/i);
  const user = m ? m[1] : v.replace(/^@/, '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user) ? user : '';
}

/** ?user=<you>&visit=<them> while visiting (so the page knows who "you" are, to mark what you starred), ?user=<you> otherwise. */
const profileURL = (user, visiting) => visiting
  ? `?${S.home ? 'user=' + encodeURIComponent(S.home) + '&' : ''}visit=${encodeURIComponent(user)}`
  : '?user=' + encodeURIComponent(user);

/** While visiting: which repos did YOU star? From the profile you came from, else your stored copy, else GitHub. */
async function loadMine(g) {
  if (!S.home) return;
  let repos = (await peek('stars:' + S.home.toLowerCase()))?.repos;
  if (g !== S.gen || S.mine) return;
  if (!repos?.length) {
    try { repos = await starredOf(S.home); } catch (e) { return status('⚠ Could not read your own stars to mark them here: ' + e.message); }
  }
  if (g !== S.gen) return;
  S.mine = mineOf(repos);
  window.dispatchEvent(new CustomEvent('mine-changed'));
}

// ---- the visit banner and the cache checkbox ----
let cacheLabel = '';   // what the 💾 label says outside a visit

/** The 💾 box shows what is true: during a visit nothing is saved, and the box can't be switched. */
function showCacheBox() {
  const box = $('#browserCache'), visiting = !!S.visit;
  box.disabled = visiting;
  box.checked = visiting ? false : persisting();
  $('#cacheLabel').textContent = visiting ? '💾 Not saved while visiting' : cacheLabel;
}

/** Banner, tab title and cache box for the current mode. */
function showVisit() {
  const banner = $('#visitBanner'), v = S.visit;
  banner.hidden = !v;
  document.title = v ? `👁 ${v} · Stars Viewer` : 'Stars Viewer';
  showCacheBox();
  if (!v) return;
  const mine = S.home ? `<button data-visit-act="back">← Back to ${esc(S.home)}</button>` : '';
  const fresh = S.mine ? S.repos.filter(r => isMine(r) === false).length : null;
  const compare = !S.home ? '' : fresh == null ? ' · checking which ones you starred…'
    : ` · <b>${fresh.toLocaleString()}</b> not starred by you yet`;
  banner.innerHTML = `<span class="grow">👁 Visiting <b>${esc(v)}</b> · ${S.repos.length ? S.repos.length.toLocaleString() + ' stars' : 'loading…'}${compare} · <b>nothing about them is saved</b>.</span>
    ${S.mine ? `<label title="Hide the repos you already starred, to see what you are missing"><input type="checkbox" id="onlyNew"${S.onlyNew ? ' checked' : ''}> Only repos I haven't starred</label>` : ''}
    <a href="https://github.com/${encodeURIComponent(v)}?tab=stars" target="_blank" rel="noopener">★ Their stars on GitHub ↗</a>
    <button data-visit-act="adopt" title="Make ${esc(v)} the profile this app keeps (saved as 💾 Keep cache says)">★ Make this my profile</button>${mine}`;
}

/** Shows the cached data instantly, then checks GitHub for changes in the background.
 *  `login`: the profile (default: the box). `visit`: true = browse without saving; undefined = a visit unless it is your own
 *  profile (or you have none yet). `push`: add a browser-history entry, so the Back button returns to the previous profile. */
async function load({login, visit, push = false} = {}) {
  const u = parseUser(login ?? $('#user').value);
  if (!u) return status('⚠ Enter a GitHub username or profile URL.');
  const isHome = !!S.home && u.toLowerCase() === S.home.toLowerCase();
  const visiting = !isHome && (visit ?? !!S.home);
  const prevUser = S.user.toLowerCase();
  // Coming from your own loaded profile: those stars are the "already starred by you" set of the visit.
  if (visiting && !S.visit && prevUser === S.home.toLowerCase() && S.repos.length) S.mine = mineOf(S.repos);
  if (!visiting) { S.mine = null; S.onlyNew = false; }
  const g = nextGen();          // running jobs see the new generation and abort without saving
  if (visiting && !S.mine) loadMine(g);
  forgetHistoryDirty();         // shards the previous profile had not saved yet must not be written for this one
  // Nothing of the old profile may be clicked or saved from here on: S.user changes now, but S.disc & co. only after the read.
  closeDiscover();
  closeUsers();
  // Until every part of the cache is read, S holds a mix of empty and loaded data: a job started now (a toolbar click)
  // would save it over the real cache. task() refuses to start jobs meanwhile, and the save functions refuse too.
  let loaded;
  S.loading = new Promise(resolve => { loaded = resolve; });
  setVisit(visiting ? u : '');   // before any read or write: decides where this profile's data may go
  if (!visiting) adoptProfile(u);
  S.user = u;
  $('#user').value = u;
  const url = profileURL(u, visiting);
  history[push && location.search !== url ? 'pushState' : 'replaceState'](null, '', url);
  showVisit();

  try {
    const [stars, disc] = await Promise.all([get('stars:' + ukey()), get('discover:' + ukey())]);
    if (g !== S.gen) return;
    if (prevUser && prevUser !== u.toLowerCase()) resetFilters();
    S.repos = stars?.repos || [];
    // A list saved by an older version lacks fields added since (e.g. each owner's type): download it once more, without ETags.
    S.starPages = (stars?.v || 0) >= CACHE_VERSION ? stars.pages || [] : [];
    S.readmes = {};
    S.history = {};
    S.users = {};
    S.disc = disc || {dismissed: [], results: {}};
    closeDiscover();
    render();   // stars on screen now; the large README cache loads right after
    const newer = stars?.v > CACHE_VERSION ? ' (⚠ written by a newer version of the app)' : '';
    status(stars ? `Cached ${ago(stars.at)}${newer} · ${S.repos.length} stars · checking for updates…`
      : isUnreadable('stars:' + ukey()) ? '⚠ The cached star list could not be read: it is kept as it is (never overwritten) and a fresh list is shown. Reload the page to try reading it again.'
      : visiting ? `👁 Visiting ${u}: downloading their stars. Nothing is saved.`
      : 'No cache for this user yet, downloading…' + (persisting() ? '' : ' (💾 Keep cache is off: nothing will be saved)'));

    const [readmes, commitHistory, users] = await Promise.all([get('readmes:' + ukey()), loadHistory(g), get('users:' + ukey())]);
    if (g !== S.gen) return;
    S.readmes = readmes || {};
    S.history = commitHistory || {};
    S.users = users || {};
    await reconcileStored(g);   // stored release notes follow the strip / length options
    bumpIndex();
    migrateReadmes();
  } finally {
    if (g === S.gen) S.loading = null;   // a newer load owns the flag now
    loaded();
  }
  if ($('#inHistory').checked) { await prepareHistorySearch(); if (g !== S.gen) return; }   // build the search text in slices, not in the first render
  if ($('#inReadme').checked || $('#inHistory').checked) render();
  renderUsers();
  // Show the new user's cache immediately. The old profile's network job can finish before this sync starts.
  await waitIdle();
  if (g !== S.gen) return;
  await task(sync);
  if (g !== S.gen) return;
  // The first profile that GitHub really answered for becomes yours: a typo is never remembered as the next start's profile.
  if (!visiting && !S.home && S.repos.length) { S.home = u; saveConfig(); }
  showVisit();
  renderUsers();
}

/** "★ Make this my profile": the visited profile becomes the one this app keeps. If something is stored for it already, that is
 *  loaded (stored data wins, like switching 💾 on); otherwise what this visit downloaded is kept. */
async function adopt() {
  const u = S.user;
  setVisit('');
  adoptProfile(u);
  S.home = u;
  history.replaceState(null, '', profileURL(u, false));
  await saveConfig();
  if (persisting() && (await get('stars:' + ukey()) || isUnreadable('stars:' + ukey()))) return load({login: u, visit: false});
  while (S.loading) await S.loading;
  if (persisting()) await saveAll();
  showVisit();
  status(`★ ${u} is now your profile` + (persisting() ? ': everything fetched so far was saved.' : ' (💾 Keep cache is off: nothing is stored).'));
}

/** The "💾 Keep cache" toggle: off by default (the data lives in this tab only), remembered by a cookie once on. Turning it
 *  on loads what is already stored for this profile (stored data wins over this tab's), or saves this tab's data if
 *  nothing is stored yet. */
function initCacheToggle({serverUp, persistOn}) {
  const box = $('#browserCache');
  const where = serverUp ? "in the data/ folder next to the app (compressed)" : 'in this browser (IndexedDB)';
  cacheLabel = serverUp ? '💾 Keep cache on disk' : '💾 Keep cache in this browser';
  $('#cacheToggle').title = `Off (default): nothing is stored, the data lives in this tab only. On: stars, READMEs, commits & releases, suggestions and your token are kept ${where}, so reloads are instant. Remembered by a cookie. Never used for profiles you only visit.`;
  showCacheBox();
  box.checked = persistOn;
  box.onchange = async () => {
    if (S.visit) return showCacheBox();   // a visit saves nothing: leave it first
    const on = box.checked;
    await setPersist(on);
    if (!on) return status(serverUp ? '💾 Cache off: this tab keeps working, nothing more is saved. Files already in data/ are untouched (🗑 Clear cache deletes them).'
      : '💾 Cache off and erased from this browser: the data (and your token) stay in this tab only.');
    while (S.loading) await S.loading;
    if (S.user && await get('stars:' + ukey())) {
      status('💾 Cache found: loading it…');
      const stored = await get('config');
      if (stored?.token && !S.token) setToken(stored.token);
      return load({login: S.user, visit: false});   // the profile on screen, not whatever is typed in the box
    }
    await saveAll();
    status('💾 Cache on: everything fetched so far was saved, reloads will be instant.');
  };
}

/** Deletes ALL stored data (local server files, this browser's storage, preferences, this tab's state, the token). */
async function clearEverything() {
  nextGen();   // jobs still running see a new generation and write nothing after the wipe
  S.loading = null;     // a profile being read is abandoned: this tab is about to be empty, which is consistent
  forgetStarCharts();   // neither does a pending star-chart save
  setVisit('');         // a visit ends with everything else
  const {files} = await clearAll();
  Object.assign(S, {home: '', repos: [], starPages: [], readmes: {}, history: {}, users: {}, disc: {dismissed: [], results: {}}, starCurves: {}});
  setToken('', {save: false});
  resetFilters();
  resetListPrefs();      // the stored preferences are gone: the controls show the defaults again
  closeDiscover();
  resetDiscoverPrefs();
  closeUsers();
  resetUsersPrefs();
  resetHistOpts();
  bumpIndex();
  render();
  showVisit();
  status(`🗑 Cleared everything: ${files ? `${files} files in data/, ` : ''}this browser's storage, preferences and this tab. Click “Load stars” to start fresh.`);
}

/** Two clicks (no native dialog) before anything is deleted. */
function initClearButton() {
  const btn = $('#clearCache');
  let armed = null;
  const disarm = () => { armed = null; btn.textContent = '🗑 Clear cache'; btn.classList.remove('confirm'); };
  btn.onclick = async () => {
    if (!armed) {
      btn.textContent = '⚠ Click again: erase ALL data';
      btn.classList.add('confirm');
      armed = setTimeout(disarm, 5000);
      return;
    }
    clearTimeout(armed);
    disarm();
    await clearEverything();
  };
}

// ---- boot ----
if (location.protocol !== 'file:') {   // ES modules can't run from file://; index.html shows a notice instead
  initCacheToggle(await initStore());
  initClearButton();
  initList();
  initDiscover();
  initUsers();
  const config = (await get('config')) || {};
  const params = new URLSearchParams(location.search), asked = params.get('visit');
  S.home = parseUser(String(config.user || '')) || (asked ? parseUser(params.get('user') || '') : '');   // ?user=<you>&visit=<them> names you when nothing is stored
  S.starCurves = (await get('starcurves')) || {};
  initToken(config.token || '');
  initHistOpts();
  $('#user').value = asked || params.get('user') || S.home || 'NairoDorian';

  $('#load').onclick = () => load({push: true});
  $('#visit').onclick = () => load({visit: true, push: true});
  $('#user').onkeydown = e => { if (e.key === 'Enter') load({push: true}); };
  $('#refresh').onclick = () => task(sync);
  $('#enrich').onclick = () => task(enrich);
  $('#indexReadme').onclick = () => task(indexReadmes);
  $('#indexHistory').onclick = () => task(indexHistory);
  $('#cancelTask').onclick = () => { S.stop = true; status('■ Stopping after the current batch (progress is kept)…'); };
  $('#visitBanner').onclick = e => {
    const act = e.target.closest('[data-visit-act]')?.dataset.visitAct;
    if (act === 'adopt') adopt();
    else if (act === 'back') load({login: S.home, visit: false, push: true});
  };
  $('#visitBanner').onchange = e => { if (e.target.id === 'onlyNew') { S.onlyNew = e.target.checked; render(); } };
  window.addEventListener('mine-changed', () => { showVisit(); render(); });   // your stars are known, or you just starred one
  window.addEventListener('visit-user', e => load({login: e.detail, visit: true, push: true}));   // 👁 Visit in the Users panel
  window.addEventListener('popstate', () => {   // the browser's Back / Forward between profiles
    const p = new URLSearchParams(location.search), visit = p.get('visit'), want = visit || p.get('user') || S.home;
    if (visit && !S.home) S.home = parseUser(p.get('user') || '');
    if (want) load({login: want, visit: visit ? true : undefined});
  });
  load({visit: asked ? true : undefined});
}
