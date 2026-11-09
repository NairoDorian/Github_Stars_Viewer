// The ▾ menus of the four "Pull for search" buttons (📄 READMEs, 📝 Commits, 🏷 Releases, 📁 Files): a small drop-down under
// each button with that category's options and a 🗑 to clear what was pulled. Commits: how many per repo. Releases:
// strip @mentions / links from the notes (always kept whole). The rules themselves live in history.js / files.js.
import {S, bumpIndex} from './state.js';
import {$, status} from './util.js';
import {ghFetch, headers} from './github.js';
import {saveHistory} from './store.js';
import {render} from './list.js';
import {waitIdle, clearReadmes} from './sync.js';
import {info} from './log.js';
import {histOpts, setHistOpts, forgetHistOpts, reconcile, historyTotals, partCounts, keepLegacyCommitCap, clearPart, COMMIT_CHOICES} from './history.js';
import {clearFiles, fileTotals} from './files.js';

const n = x => x.toLocaleString();
const MENUS = ['readmes', 'commits', 'releases', 'files'];
const menuEl = key => $(`#menu-${key}`), caretEl = key => $(`#caret-${key}`);

/** What a change of options did to the stored records, in words. */
function describe(r, o) {
  const parts = [];
  if (r.stripped) parts.push(`Applied to the stored release notes of ${n(r.stripped)} repos (no download needed).`);
  if (r.refetch) parts.push(`${n(r.refetch)} repos stored release notes that were stripped or cut earlier: pull 🏷 Releases to download them again, whole (cheap, releases only).`);
  if (r.trimmed) parts.push(`${n(r.trimmed)} repos cut to their newest ${n(o.commits)} commits.`);
  if (r.restart) parts.push(`${n(r.restart)} repos had reached the old limit: pull 📝 Commits to download the rest.`);
  return parts.join(' ');
}

/** The small numbers at the bottom of each menu: what is stored, plus GitHub's GraphQL budget for commits / releases. */
async function stats(key) {
  const el = $(`#stat-${key}`);
  if (!el) return;
  const t = historyTotals(), pc = partCounts(), f = fileTotals(), readmes = Object.values(S.readmes).filter(x => x?.t).length;
  const text = {
    readmes: readmes ? `${n(readmes)} READMEs stored.` : 'No README pulled yet.',
    commits: pc.commits ? `${n(t.commits)} commit messages from ${n(pc.commits)} repos (${n(pc.commitsDone)} complete).` : 'No commit pulled yet.',
    releases: pc.releases ? `${n(t.releases)} releases from ${n(pc.releases)} repos.` : 'No release pulled yet.',
    files: f.repos ? `${n(f.files)} file names from ${n(f.repos)} repos.` : 'No file list pulled yet.',
  }[key];
  el.textContent = text;
  if (!S.token || (key !== 'commits' && key !== 'releases')) return;
  try {
    const r = await ghFetch('/rate_limit', {headers: headers(), signal: null});
    const gql = (await r.json()).resources?.graphql;
    if (gql) el.textContent = `${text} GraphQL budget: ${n(gql.remaining)} of ${n(gql.limit)} (resets ${new Date(gql.reset * 1000).toLocaleTimeString()}).`;
  } catch {}
}

/** Puts the saved options into the controls. */
function fill() {
  const o = histOpts();
  $('#optMentions').checked = o.mentions;
  $('#optLinks').checked = o.links;
  const sel = $('#optCommits');
  // The choices, plus a value saved by hand or by an older version that isn't one of them, in order (0 = ALL comes last).
  const values = [...new Set([...COMMIT_CHOICES, o.commits])].sort((a, b) => (a || Infinity) - (b || Infinity));
  sel.replaceChildren(...values.map(v => new Option(v === 0 ? 'ALL commits (no limit)' : `${n(v)} newest`, String(v))));
  sel.value = String(o.commits);
  $('#indexCommits').title = `Downloads the commit messages of every starred repo, newest first: ${o.commits ? 'the ' + n(o.commits) + ' newest' : 'ALL of them'} per repo (▾ to change; needs a token). Later checks only fetch new commits.`;
}

async function change(patch, noteId) {
  info('history', `option changed: ${JSON.stringify(patch)}`);
  setHistOpts(patch);
  fill();
  const note = $(noteId);
  note.textContent = 'Applying…';
  while (S.loading) await S.loading;   // the records must be loaded before they can be changed
  await waitIdle();   // never edit records while a pull is writing them
  const o = histOpts(), g = S.gen, r = reconcile(o);
  if (g === S.gen) await saveHistory(g);
  bumpIndex();
  render();
  const warn = patch.commits === 0 ? ' ALL commits: repos with 100k+ commits (Linux, Chromium…) cost about one request per 100 commits and tens of MB each. Cancel keeps the progress.' : '';
  note.textContent = (describe(r, o) || 'Saved: the next pull uses it.') + warn;
}

function setOpen(key, open) {
  for (const other of MENUS) {
    const show = other === key && open;
    if (menuEl(other).hidden === !show) continue;
    menuEl(other).hidden = !show;
    caretEl(other).setAttribute('aria-expanded', String(show));
  }
  if (open) stats(key);
}

/** A 🗑 button that asks for a second click (no native dialog) before `run` deletes anything. */
function twoClick(btn, label, armedLabel, run) {
  let armed = null;
  const disarm = () => { armed = null; btn.textContent = label; btn.classList.remove('confirm'); };
  btn.textContent = label;
  btn.onclick = async () => {
    if (!armed) { btn.textContent = armedLabel; btn.classList.add('confirm'); armed = setTimeout(disarm, 4000); return; }
    clearTimeout(armed); disarm();
    if (S.loading) return status('⏳ Still reading the cached data, try again in a moment');   // the load would bring it back
    await waitIdle();   // never delete under a pull that is writing
    await run(S.gen);
  };
}

/** After "Clear cache": back to the default options. */
export function resetHistOpts() {
  forgetHistOpts();
  fill();
  for (const id of ['#note-commits', '#note-releases']) $(id).textContent = '';
}

/** Brings stored records in line with the saved options after the cache was loaded (a no-op when nothing differs). */
export async function reconcileStored(g) {
  if (keepLegacyCommitCap()) fill();
  const r = reconcile();
  if (r.stripped || r.refetch || r.trimmed || r.restart) { if (g === S.gen) await saveHistory(g); bumpIndex(); }
  return r;
}

export function initPullMenus() {
  fill();
  for (const key of MENUS) caretEl(key).onclick = e => { e.stopPropagation(); setOpen(key, menuEl(key).hidden); };
  // Closed by a click anywhere else or Escape; clicks inside a menu keep it open.
  document.addEventListener('click', e => { if (!e.target.closest?.('.menu')) setOpen(null, false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && MENUS.some(k => !menuEl(k).hidden)) setOpen(null, false); });
  $('#optMentions').onchange = e => change({mentions: e.target.checked}, '#note-releases');
  $('#optLinks').onchange = e => change({links: e.target.checked}, '#note-releases');
  $('#optCommits').onchange = e => change({commits: Number(e.target.value)}, '#note-commits');

  const after = (box, msg) => { $(box).checked = false; bumpIndex(); render(); status(msg); };
  twoClick($('#clearReadmes'), '🗑 Clear READMEs', '⚠ Click again to delete every README', async g => {
    const k = await clearReadmes(g);
    after('#inReadme', `🗑 ${n(k)} READMEs deleted`); stats('readmes');
  });
  twoClick($('#clearCommits'), '🗑 Clear commits', '⚠ Click again to delete every commit message', async g => {
    const k = await clearPart(g, 'commits');
    after('#inCommits', `🗑 Commit messages of ${n(k)} repos deleted (release notes kept)`); stats('commits');
  });
  twoClick($('#clearReleases'), '🗑 Clear releases', '⚠ Click again to delete every release note', async g => {
    const k = await clearPart(g, 'releases');
    after('#inReleases', `🗑 Release notes of ${n(k)} repos deleted (commit messages kept)`); stats('releases');
  });
  twoClick($('#clearFiles'), '🗑 Clear file lists', '⚠ Click again to delete every file list', async g => {
    const k = await clearFiles(g);
    after('#inFiles', `🗑 File lists of ${n(k)} repos deleted`); stats('files');
  });
}
