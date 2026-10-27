// Entry point: boot, loading a profile, and toolbar wiring.
//
// Module map (imports only point downwards; list.js never imports discover.js or sync.js, they talk through DOM events):
//   util.js         helpers: DOM, formatting, safe HTML, concurrency, status line and progress bar
//   state.js        the shared state object S, generation/cancellation, per-repo cache keys, search-text caches
//   store.js        the cache: ./data files via server.js locally, or IndexedDB / memory online; sharded history
//   github.js       GitHub REST/GraphQL client: retries, rate limits, batching, data mapping, last commit / release
//   sync.js         keeping stars, tiles and READMEs in sync with GitHub cheaply; one job at a time per profile
//   history.js      every commit message and release note of every star: fetching, options, stripping
//   histopts.js     the ▾ options panel of the commit & release index
//   progress.js     the live progress panel: one bar per step, counts, speed, time left
//   sort.js         shared ordering rules (stars and Discover results)
//   list.js         search, qualifiers, facet filters, export, repo cards
//   discover.js     themes, suggestions, star / unstar buttons
//   starhistory.js  star history charts from star-history.com (lazy, cached)
//   token.js        the 🔑 token panel
import {S, ukey, nextGen, bumpIndex} from './state.js';
import {$, ago, status} from './util.js';
import {get, saveConfig, initStore, setPersist, persisting, clearAll, saveAll, loadHistory, forgetHistoryDirty, CACHE_VERSION} from './store.js';
import {task, waitIdle, sync, enrich, indexReadmes, migrateReadmes} from './sync.js';
import {indexHistory} from './history.js';
import {initHistOpts, resetHistOpts, reconcileStored} from './histopts.js';
import {render, initList, resetFilters, resetListPrefs, prepareHistorySearch} from './list.js';
import {initDiscover, closeDiscover, resetDiscoverPrefs} from './discover.js';
import {initToken, setToken} from './token.js';
import {forgetStarCharts} from './starhistory.js';

/** "NairoDorian", "@NairoDorian" or "https://github.com/NairoDorian?tab=stars" → "NairoDorian". */
function parseUser(v) {
  v = v.trim();
  const m = v.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)(?:[/?#].*)?$/i);
  const user = m ? m[1] : v.replace(/^@/, '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user) ? user : '';
}

/** Shows the cached data instantly, then checks GitHub for changes in the background. */
async function load() {
  const u = parseUser($('#user').value);
  if (!u) return status('⚠ Enter a GitHub username or profile URL.');
  const prevUser = S.user.toLowerCase();
  const g = nextGen();          // running jobs see the new generation and abort without saving
  forgetHistoryDirty();         // shards the previous profile had not saved yet must not be written for this one
  S.user = u;
  $('#user').value = u;
  history.replaceState(null, '', '?user=' + encodeURIComponent(u));
  saveConfig();

  const [stars, disc] = await Promise.all([get('stars:' + ukey()), get('discover:' + ukey())]);
  if (g !== S.gen) return;
  if (stars && stars.v > CACHE_VERSION) status('⚠ This cache was written by a newer version of the app.');
  if (prevUser && prevUser !== u.toLowerCase()) resetFilters();
  S.repos = stars?.repos || [];
  S.starPages = stars?.pages || [];
  S.readmes = {};
  S.history = {};
  S.disc = disc || {dismissed: [], results: {}};
  closeDiscover();
  render();   // stars on screen now; the large README cache loads right after
  status(stars ? `Cached ${ago(stars.at)} · ${S.repos.length} stars · checking for updates…`
    : 'No cache for this user yet, downloading…' + (persisting() ? '' : ' (💾 Keep cache is off: nothing will be saved)'));

  const [readmes, commitHistory] = await Promise.all([get('readmes:' + ukey()), loadHistory(g)]);
  if (g !== S.gen) return;
  S.readmes = readmes || {};
  S.history = commitHistory || {};
  await reconcileStored(g);   // stored release notes follow the strip / length options
  bumpIndex();
  migrateReadmes();
  if ($('#inHistory').checked) { await prepareHistorySearch(); if (g !== S.gen) return; }   // build the search text in slices, not in the first render
  if ($('#inReadme').checked || $('#inHistory').checked) render();
  // Show the new user's cache immediately. The old profile's network job can finish before this sync starts.
  await waitIdle();
  if (g !== S.gen) return;
  await task(sync);
}

/** The "💾 Keep cache" toggle: off by default (the data lives in this tab only), remembered by a cookie once on. Turning it
 *  on loads what is already stored for this profile (stored data wins over this tab's), or saves this tab's data if
 *  nothing is stored yet. */
function initCacheToggle({serverUp, persistOn}) {
  const box = $('#browserCache');
  const where = serverUp ? "in the data/ folder next to the app (compressed)" : 'in this browser (IndexedDB)';
  $('#cacheLabel').textContent = serverUp ? '💾 Keep cache on disk' : '💾 Keep cache in this browser';
  $('#cacheToggle').title = `Off (default): nothing is stored, the data lives in this tab only. On: stars, READMEs, commits & releases, suggestions and your token are kept ${where}, so reloads are instant. Remembered by a cookie.`;
  box.checked = persistOn;
  box.onchange = async () => {
    const on = box.checked;
    await setPersist(on);
    if (!on) return status(serverUp ? '💾 Cache off: this tab keeps working, nothing more is saved. Files already in data/ are untouched (🗑 Clear cache deletes them).'
      : '💾 Cache off and erased from this browser: the data (and your token) stay in this tab only.');
    if (S.user && await get('stars:' + S.user.toLowerCase())) {
      status('💾 Cache found: loading it…');
      const stored = await get('config');
      if (stored?.token && !S.token) setToken(stored.token);
      return load();
    }
    await saveAll();
    status('💾 Cache on: everything fetched so far was saved, reloads will be instant.');
  };
}

/** Deletes ALL stored data (local server files, this browser's storage, preferences, this tab's state, the token). */
async function clearEverything() {
  nextGen();   // jobs still running see a new generation and write nothing after the wipe
  forgetStarCharts();   // neither does a pending star-chart save
  const {files} = await clearAll();
  Object.assign(S, {repos: [], starPages: [], readmes: {}, history: {}, disc: {dismissed: [], results: {}}, starCurves: {}});
  setToken('', {save: false});
  resetFilters();
  resetListPrefs();      // the stored preferences are gone: the controls show the defaults again
  closeDiscover();
  resetDiscoverPrefs();
  resetHistOpts();
  bumpIndex();
  render();
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
  const config = (await get('config')) || {};
  S.starCurves = (await get('starcurves')) || {};
  initToken(config.token || '');
  initHistOpts();
  $('#user').value = new URLSearchParams(location.search).get('user') || config.user || 'NairoDorian';

  $('#load').onclick = load;
  $('#user').onkeydown = e => { if (e.key === 'Enter') load(); };
  $('#refresh').onclick = () => task(sync);
  $('#enrich').onclick = () => task(enrich);
  $('#indexReadme').onclick = () => task(indexReadmes);
  $('#indexHistory').onclick = () => task(indexHistory);
  $('#cancelTask').onclick = () => { S.stop = true; status('■ Stopping after the current batch (progress is kept)…'); };
  load();
}
