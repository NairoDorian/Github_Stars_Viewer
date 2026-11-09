// The collapsible ⚙ Options panel next to the 📝 Commits / 🏷 Releases buttons: strip @mentions / links from release notes (always kept
// whole), commits per repo, what the index holds, and clearing it. The rules themselves live in history.js.
import {S, bumpIndex} from './state.js';
import {$, status} from './util.js';
import {ghFetch, headers} from './github.js';
import {saveHistory, markAllHistory} from './store.js';
import {render} from './list.js';
import {waitIdle} from './sync.js';
import {info} from './log.js';
import {histOpts, setHistOpts, forgetHistOpts, reconcile, historyTotals, keepLegacyCommitCap, COMMIT_CHOICES} from './history.js';

const OPEN_PREF = 'starsViewer.histOptsOpen';   // localStorage: panel open?
const n = x => x.toLocaleString();

/** Applies the options to the stored records right now and explains what that did. */
function describe(r, o) {
  const parts = [];
  if (r.stripped) parts.push(`Applied to the stored release notes of ${n(r.stripped)} repos (no download needed).`);
  if (r.refetch) parts.push(`${n(r.refetch)} repos stored release notes that were stripped or cut earlier: they are downloaded again, whole, at the next index (cheap, releases only).`);
  if (r.trimmed) parts.push(`${n(r.trimmed)} repos cut to their newest ${n(o.commits)} commits.`);
  if (r.restart) parts.push(`${n(r.restart)} repos that had reached the old commit cap will be walked again at the next index.`);
  return parts.join(' ');
}

function summary() {
  const o = histOpts();
  $('#histOptsSummary').textContent = [commitLabel(o.commits) + ' per repo', o.mentions ? '@mentions stripped' : '@mentions kept', o.links ? 'links stripped' : 'links kept'].join(' · ');
}

/** What the index holds, in numbers; plus GitHub's GraphQL budget when a token is set. */
async function stats() {
  const t = historyTotals();
  let chars = 0;
  for (const h of Object.values(S.history)) {
    for (const e of h.c || []) chars += e[2].length + 24;
    for (const x of h.rel || []) chars += x[3].length + x[0].length + x[1].length + 24;
  }
  const el = $('#optStats');
  const base = t.repos ? `Index: ${n(t.commits)} commit messages and ${n(t.releases)} releases in ${n(t.repos)} repos, about ${Math.round(chars / 1e6)} MB of text (the local server stores it compressed).` : 'Nothing indexed yet.';
  el.textContent = base;
  if (!S.token) return;
  try {
    const r = await ghFetch('/rate_limit', {headers: headers(), signal: null});
    const gql = (await r.json()).resources?.graphql;
    if (gql && $('#optStats') === el) el.textContent = `${base} GitHub GraphQL budget left: ${n(gql.remaining)} of ${n(gql.limit)} (resets ${new Date(gql.reset * 1000).toLocaleTimeString()}).`;
  } catch {}
}

const commitLabel = c => c === 0 ? 'ALL commits' : `${n(c)} commits`;

function fill() {
  const o = histOpts();
  $('#optMentions').checked = o.mentions;
  $('#optLinks').checked = o.links;
  const sel = $('#optCommits');
  // The choices, plus a value saved by hand or by an older version that isn't one of them, in order (0 = ALL comes last).
  const values = [...new Set([...COMMIT_CHOICES, o.commits])].sort((a, b) => (a || Infinity) - (b || Infinity));
  sel.replaceChildren(...values.map(v => new Option(v === 0 ? 'ALL commits (no limit)' : `${n(v)} newest`, String(v))));
  sel.value = String(o.commits);
  summary();
}

async function change(patch) {
  info('history', `option changed: ${JSON.stringify(patch)}`);
  setHistOpts(patch);
  summary();
  const note = $('#optNote');
  note.textContent = 'Applying…';
  while (S.loading) await S.loading;   // the records must be loaded before they can be changed
  await waitIdle();   // never edit records while an index run is writing them
  const o = histOpts(), g = S.gen, r = reconcile(o);
  if (g === S.gen) await saveHistory(g);
  bumpIndex();
  render();
  const warn = o.commits === 0 ? ' ALL commits: repos with 100k+ commits (Linux, Chromium…) cost about one request per 100 commits and tens of MB each. You can Cancel at any time and the next click continues.' : '';
  const next = [r.restart && 'Click 📝 Pull commits to download the commits.', r.refetch && 'Click 🏷 Pull releases to download the release notes.'].filter(Boolean).map(x => ' ' + x).join('');
  note.textContent = (describe(r, o) || 'Saved. New downloads use this setting.') + next + warn;
  stats();
}

function setOpen(open) {
  $('#histOpts').hidden = !open;
  $('#histOptsToggle').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem(OPEN_PREF, open ? '1' : '0'); } catch {}
  if (open) stats();
}

/** After "Clear cache": back to the default options. */
export function resetHistOpts() {
  forgetHistOpts();
  fill();
  $('#optNote').textContent = '';
  stats();
}

/** Brings stored records in line with the saved options after the cache was loaded (a no-op when nothing differs). */
export async function reconcileStored(g) {
  if (keepLegacyCommitCap()) fill();
  const r = reconcile();
  if (r.stripped || r.refetch || r.trimmed || r.restart) { if (g === S.gen) await saveHistory(g); bumpIndex(); }
  return r;
}

export function initHistOpts() {
  fill();
  let open = false;
  try { open = localStorage.getItem(OPEN_PREF) === '1'; } catch {}
  setOpen(open);
  $('#histOptsToggle').onclick = () => setOpen($('#histOpts').hidden);
  $('#optMentions').onchange = e => change({mentions: e.target.checked});
  $('#optLinks').onchange = e => change({links: e.target.checked});
  $('#optCommits').onchange = e => change({commits: Number(e.target.value)});
  $('#optCommits2').onclick = () => $('#indexCommits').click();   // the same tasks, the same one-job-at-a-time rules
  $('#optReleases2').onclick = () => $('#indexReleases').click();
  const clear = $('#optClear');
  let armed = null;
  clear.onclick = async () => {
    if (!armed) {   // two clicks: no native confirm dialog
      clear.textContent = 'Click again to delete the whole index';
      clear.classList.add('confirm');
      armed = setTimeout(() => { armed = null; clear.textContent = 'Clear commit & release index'; clear.classList.remove('confirm'); }, 4000);
      return;
    }
    clearTimeout(armed); armed = null;
    clear.textContent = 'Clear commit & release index'; clear.classList.remove('confirm');
    if (S.loading) return status('⏳ Still reading the cached data, try again in a moment');   // the load would bring the index back
    await waitIdle();
    const g = S.gen;
    info('history', `commit & release index cleared: ${Object.keys(S.history).length.toLocaleString()} repos' records deleted`);
    S.history = {};
    markAllHistory();
    await saveHistory(g);
    bumpIndex();
    render();
    $('#optNote').textContent = 'Index cleared.';
    status('Commit & release index cleared');
    stats();
  };
}
