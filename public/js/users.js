/* Users: everyone who owns a repo in your stars, in one big list, with how many repos each of them starred themselves.
   A row opens that user's stars on github.com, or here in Visit mode (main.js): their stars are browsed in memory, nothing
   of them is ever saved (store.js). Clicking the number of repos you starred of them filters the main list to that user.

   Counts come from GitHub: with a token one GraphQL call answers 50 users (ownerStats); without one each user costs a REST
   request (starredCount, 60 per hour), so counting is manual there. Organizations can't star anything and are not asked.
   Counts are cached with the profile (users:<user>) and refreshed after a week. list.js and main.js are reached through
   window events ('filter-owner', 'visit-user'), like the rest of the app. */
import {S} from './state.js';
import {$, DAY, esc, ago, pool} from './util.js';
import {ownerStats, starredCount, isFatalError} from './github.js';
import {saveUsers} from './store.js';

const MAX_AGE = 7 * DAY, PAGE = 100, REST_BATCH = 25;

/** Organizations and bots own repos but can't star any. */
export const isPerson = u => u.type !== 'Organization' && u.type !== 'Bot';

/** One entry per owner of the given repos: how many of your stars they own, plus what is known about their own stars. */
export function buildUsers(repos = S.repos, stats = S.users) {
  const by = new Map();
  for (const r of repos) {
    const key = r.owner.toLowerCase();
    let u = by.get(key);
    if (!u) by.set(key, u = {login: r.owner, key, n: 0, avatar: r.avatar || '', type: null});
    u.n++;
    u.type ||= r.ownerType || null;
    u.avatar ||= r.avatar || '';
  }
  for (const u of by.values()) {
    const s = stats[u.key];
    if (!s) continue;
    u.at = s.at;
    u.type = s.type || u.type;
    u.missing = !!s.missing;
    u.stars = s.stars ?? null;
    u.followers = s.followers ?? null;
    u.name = s.name || '';
  }
  return [...by.values()];
}

/** Does this user's count have to be fetched (never counted, or counted over a week ago)? Organizations never do. */
export const needsStats = (u, now = Date.now()) => isPerson(u) && !(u.at && now - u.at <= MAX_AGE);

const SORTS = {login: u => u.key, type: u => u.type, n: u => u.n, stars: u => u.stars ?? null, followers: u => u.followers ?? null};
/** Sorts in place. `dir` 1 = ascending, -1 = descending. Unknown values come last in both directions. */
export function sortUsers(list, key, dir) {
  const val = SORTS[key] ?? SORTS.n;
  return list.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y != null) return 1;
    if (y == null && x != null) return -1;
    if (x != null && x !== y) return (x < y ? -1 : 1) * dir;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** `text`: part of the login or the name; `type`: 'all' | 'person' | 'org'. */
export function filterUsers(list, text = '', type = 'all') {
  const t = text.trim().toLowerCase();
  return list.filter(u => (type === 'all' || (type === 'person') === isPerson(u)) && (!t || u.key.includes(t) || (u.name || '').toLowerCase().includes(t)));
}

/** Writes one answer into S.users. `r` null = GitHub knows no such user; a REST answer carries only the star count. */
function record(login, r) {
  const key = login.toLowerCase(), at = Date.now();
  if (!r || r.missing) S.users[key] = {at, missing: true};
  else S.users[key] = {...S.users[key], ...r, at, missing: undefined};
}

// ---------- the panel ----------
const ui = {sort: 'n', dir: -1, type: 'all', text: '', shown: PAGE};
const COLUMNS = [['login', 'User', 1], ['type', 'Type', 1], ['n', 'In your stars', -1], ['stars', 'Their stars', -1], ['followers', 'Followers', -1]];
let job = null;   // the running count: {stop, done, total, failed, fatal}
let note = '';

const open = () => $('#usersPanel')?.classList.contains('show');
const people = () => filterUsers(buildUsers(S.hideForks ? S.repos.filter(r => !r.fork) : S.repos), ui.text, ui.type);

function rowHTML(u) {
  const org = !isPerson(u), login = encodeURIComponent(u.login), q = esc(u.login);
  const avatar = u.avatar ? `<img src="${esc(u.avatar + (u.avatar.includes('?') ? '&' : '?') + 's=36')}" loading="lazy" alt="">` : '<i class="u-noimg"></i>';
  const theirs = org ? '<span class="muted" title="Organizations can\'t star repositories">—</span>'
    : u.missing ? '<span class="muted" title="GitHub knows no such user any more">not found</span>'
    : u.stars != null ? u.stars.toLocaleString()
    : S.token ? '<span class="muted">…</span>'
    : `<button class="linkish" data-ucount="${q}" title="Count this user's stars (1 request of the 60 per hour without a token)">count</button>`;
  const canVisit = !org && !u.missing && u.stars !== 0;
  const links = (org ? `<a href="https://github.com/${login}" target="_blank" rel="noopener" title="${q} on GitHub">GitHub ↗</a>`
    : `<a href="https://github.com/${login}?tab=stars" target="_blank" rel="noopener" title="${q}'s starred repositories on GitHub">★ Stars on GitHub ↗</a>`) +
    (canVisit ? `<a href="?visit=${login}" data-visit="${q}" title="Browse ${q}'s stars here. Nothing about them is saved; click in the same tab, middle-click for a new one">👁 Visit</a>` : '');
  return `<tr><td><div class="u-name">${avatar}<a href="https://github.com/${login}" target="_blank" rel="noopener">${esc(u.login)}</a>${u.name ? `<span class="muted">${esc(u.name)}</span>` : ''}</div></td>
    <td>${org ? 'Org' : u.type ? 'Person' : '<span class="muted">?</span>'}</td>
    <td class="num"><button class="linkish" data-ufilter="${q}" title="Show only the ${u.n} of your stars owned by ${q}">${u.n.toLocaleString()}</button></td>
    <td class="num">${theirs}</td><td class="num">${u.followers != null ? u.followers.toLocaleString() : '<span class="muted">—</span>'}</td>
    <td><div class="u-actions">${links}</div></td></tr>`;
}

/** Draws the panel (when it is open): summary, controls, the table of the first `ui.shown` matches. */
export function renderUsers() {
  if (!open()) return;
  const all = buildUsers(S.hideForks ? S.repos.filter(r => !r.fork) : S.repos), list = sortUsers(filterUsers(all, ui.text, ui.type), ui.sort, ui.dir);
  const persons = all.filter(isPerson), counted = persons.filter(u => u.stars != null).length;
  $('#usersSummary').textContent = S.repos.length
    ? `${all.length.toLocaleString()} users (${(all.length - persons.length).toLocaleString()} organizations) · star counts known for ${counted.toLocaleString()} of ${persons.length.toLocaleString()} people` +
      (list.length !== all.length ? ` · ${list.length.toLocaleString()} shown` : '')
    : '';
  const btn = $('#usersFetch');
  btn.textContent = job ? '■ Stop' : S.token ? '↻ Refresh counts' : `↻ Count shown (up to ${REST_BATCH})`;
  btn.title = S.token ? 'Ask GitHub how many repos each person starred (50 users per request)' : `Without a token each user costs one request and GitHub allows 60 per hour: counts the first ${REST_BATCH} shown users that are not counted yet`;
  $('#usersNote').textContent = note;
  if (!S.repos.length) { $('#usersTable').innerHTML = '<p class="muted">Load some stars first.</p>'; $('#usersMore').hidden = true; return; }
  const head = COLUMNS.map(([k, label]) => `<th aria-sort="${ui.sort === k ? (ui.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button data-usort="${k}">${label}${ui.sort === k ? (ui.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('');
  $('#usersTable').innerHTML = `<table class="users-table"><thead><tr>${head}<th></th></tr></thead><tbody>${list.slice(0, ui.shown).map(rowHTML).join('')}</tbody></table>` +
    (list.length ? '' : '<p class="muted">No user matches.</p>');
  const more = $('#usersMore');
  more.hidden = list.length <= ui.shown;
  more.textContent = `Show more (${(list.length - ui.shown).toLocaleString()} left)`;
}

// ---------- counting ----------
/** Counts the given logins; progress shows in the panel, results are kept as they arrive and saved at the end. */
async function runCount(logins) {
  if (job || !logins.length || S.loading) return;
  const g = S.gen, run = job = {stop: false, done: 0, total: logins.length, failed: 0, fatal: null};
  const halted = () => run.stop || g !== S.gen;
  const progress = () => { note = `Counting… ${run.done.toLocaleString()} of ${run.total.toLocaleString()} users`; renderUsers(); };
  progress();
  try {
    if (S.token) {
      const {failed} = await ownerStats(logins, batch => {
        if (g !== S.gen) return;
        for (const [key, r] of batch) record(key, r);
        run.done += batch.size;
        progress();
      }, halted);
      run.failed += failed;
    } else {
      let left = null;
      await pool(logins, 4, async login => {
        if (halted()) return;
        try {
          const r = await starredCount(login);
          if (g !== S.gen) return;
          left = r.remaining;
          record(login, r.missing ? null : {stars: r.stars});
        } catch (e) {
          if (isFatalError(e)) { run.fatal = e; run.stop = true; } else run.failed++;
        }
        run.done++;
        progress();
      });
      if (left != null && !run.fatal) run.left = left;
    }
  } catch (e) { run.fatal = e; }   // a rejected token or a used-up budget: what arrived so far is kept
  job = null;
  if (g !== S.gen) { note = ''; return; }
  await saveUsers(g);
  note = `Counted ${run.done.toLocaleString()} users` + (run.failed ? ` · ${run.failed} failed, try again` : '') + (run.stop && !run.fatal ? ' · stopped, what was counted is kept' : '') +
    (run.left != null ? ` · ${run.left} requests left this hour` : '') + (run.fatal ? ` · ⚠ ${run.fatal.message}` : '');
  renderUsers();
}

/** What the toolbar button counts: with a token everyone (a refresh); without, the first few shown users still without a count. */
function countTargets() {
  const list = sortUsers(filterUsers(buildUsers(S.hideForks ? S.repos.filter(r => !r.fork) : S.repos), ui.text, ui.type), ui.sort, ui.dir);
  const persons = list.filter(isPerson);
  return (S.token ? persons : persons.filter(u => needsStats(u)).slice(0, REST_BATCH)).map(u => u.login);
}

// ---------- open / close ----------
function show(on) {
  const panel = $('#usersPanel');
  panel.classList.toggle('show', on);
  $('#toggleUsers').setAttribute('aria-expanded', String(on));
  if (!on) return;
  renderUsers();
  // With a token the counts that are missing or a week old are fetched on opening: a few requests for the whole list.
  if (S.token && !S.loading && !job) {
    const todo = buildUsers().filter(u => needsStats(u)).map(u => u.login);
    if (todo.length) runCount(todo);
  }
  panel.scrollIntoView({block: 'nearest', behavior: 'smooth'});
}

/** Closes the panel and ends a running count (another profile is being loaded). */
export function closeUsers() {
  if (job) job.stop = true;
  note = '';
  $('#usersPanel')?.classList.remove('show');
  $('#toggleUsers')?.setAttribute('aria-expanded', 'false');
}
/** After "Clear cache": back to the default view. */
export function resetUsersPrefs() { Object.assign(ui, {sort: 'n', dir: -1, type: 'all', text: '', shown: PAGE}); $('#usersFilter').value = ''; $('#usersType').value = 'all'; }

export function initUsers() {
  $('#toggleUsers').onclick = () => show(!open());
  $('#usersFilter').oninput = e => { ui.text = e.target.value; ui.shown = PAGE; renderUsers(); };
  $('#usersType').onchange = e => { ui.type = e.target.value; ui.shown = PAGE; renderUsers(); };
  $('#usersMore').onclick = () => { ui.shown += PAGE; renderUsers(); };
  $('#usersFetch').onclick = () => { if (job) job.stop = true; else { note = ''; runCount(countTargets()); } };
  window.addEventListener('fork-filter-change', renderUsers);
  $('#usersPanel').addEventListener('click', e => {
    const t = e.target.closest('[data-usort],[data-ufilter],[data-visit],[data-ucount]');
    if (!t) return;
    const d = t.dataset;
    if (d.usort) {
      if (ui.sort === d.usort) ui.dir = -ui.dir; else { ui.sort = d.usort; ui.dir = COLUMNS.find(c => c[0] === d.usort)[2]; }
      renderUsers();
    } else if (d.ufilter) window.dispatchEvent(new CustomEvent('filter-owner', {detail: d.ufilter}));
    else if (d.ucount) runCount([d.ucount]);
    else if (d.visit && e.button === 0 && !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) {   // a modified click keeps the link's own behaviour: a new tab at ?visit=
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('visit-user', {detail: d.visit}));
    }
  });
}
