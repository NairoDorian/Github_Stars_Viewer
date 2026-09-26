// Entry point: boot, loading a user, and toolbar wiring.
//
// Module map:
//   util.js      helpers (DOM, formatting, safe HTML, concurrency)
//   state.js     shared state object S
//   store.js     cache: ./data files via server.js locally, or IndexedDB / memory online
//   github.js    GitHub REST/GraphQL client (retries, rate limits, mapping)
//   sync.js      keeping the cache in sync with GitHub, cheaply
//   list.js      search, filters, sorting, repo cards
//   discover.js  themes, suggestions, star buttons
//   token.js     the 🔑 token panel
//   starhistory.js  star history charts from star-history.com (lazy, cached)
import {S, ukey} from './state.js';
import {$, ago, status} from './util.js';
import {get, saveConfig, initStore, setBrowserCache, CACHE_VERSION} from './store.js';
import {task, waitIdle, sync, enrich, indexReadmes, migrateReadmes} from './sync.js';
import {render, initList} from './list.js';
import {initDiscover, closeDiscover} from './discover.js';
import {initToken} from './token.js';

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
  const g = ++S.gen;          // running jobs see the new generation and stop without saving
  S.user = u;
  $('#user').value = u;
  history.replaceState(null, '', '?user=' + encodeURIComponent(u));
  saveConfig();

  const [stars, disc] = await Promise.all([get('stars:' + ukey()), get('discover:' + ukey())]);
  if (g !== S.gen) return;
  if (stars && stars.v > CACHE_VERSION) status('⚠ This cache was written by a newer version of the app.');
  S.repos = stars?.repos || [];
  S.starPages = stars?.pages || [];
  S.readmes = {};
  S.disc = disc || {dismissed: [], results: {}};
  closeDiscover();
  render();   // stars on screen now; the large README cache loads right after
  status(stars ? `Cached ${ago(stars.at)} · ${S.repos.length} stars · checking for updates…` : 'No cache for this user yet, downloading…');

  const readmes = await get('readmes:' + ukey());
  if (g !== S.gen) return;
  S.readmes = readmes || {};
  migrateReadmes();
  if ($('#inReadme').checked) render();
  // Show the new user's cache immediately. The old profile's network job can finish before this sync starts.
  await waitIdle();
  if (g !== S.gen) return;
  await task(sync);
}

/** Online (no local server): shows the "💾 Keep cache in this browser" toggle. */
function initCacheToggle(mode) {
  const label = $('#cacheToggle'), box = $('#browserCache');
  label.hidden = mode === 'server';
  box.checked = mode === 'browser';
  box.onchange = async () => {
    await setBrowserCache(box.checked);
    await saveConfig();
    status(box.checked ? '💾 Cache saved in this browser: reloads will be instant.'
      : 'Browser cache off and erased: data (and your token) stay in this tab only.');
  };
}

// ---- boot ----
if (location.protocol !== 'file:') {   // ES modules can't run from file://; index.html shows a notice instead
  const mode = await initStore();
  initCacheToggle(mode);
  initList();
  initDiscover();
  const config = (await get('config')) || {};
  S.starCurves = (await get('starcurves')) || {};
  initToken(config.token || '');
  $('#user').value = new URLSearchParams(location.search).get('user') || config.user || 'NairoDorian';

  $('#load').onclick = load;
  $('#user').onkeydown = e => { if (e.key === 'Enter') load(); };
  $('#refresh').onclick = () => task(sync);
  $('#enrich').onclick = () => task(enrich);
  $('#indexReadme').onclick = () => task(indexReadmes);
  load();
}
