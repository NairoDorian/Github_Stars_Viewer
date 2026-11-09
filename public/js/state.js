// Shared app state: one object so every module reads and writes the same live values.

export const S = {
  user: '',          // GitHub login whose stars are shown
  home: '',          // YOUR login: the profile that is saved. Any other profile is a visit (see store.js setVisit)
  visit: '',         // login being visited ('' = not visiting): nothing of a visit is ever written to disk or IndexedDB
  mine: null,        // while visiting: {ids, names} of the repos YOU starred (null = not known yet), to mark and filter the visited tiles
  onlyNew: false,    // while visiting: show only repos you have not starred
  token: '',         // GitHub token (stored with the config only while "💾 Keep cache" is on)
  repos: [],         // starred repos, shape built by mapStar() in github.js
  starPages: [],     // [{etag, ids}] per star-list page, for conditional (304) re-fetches
  readmes: {},       // {<repo id>: {t: text, sha, path, etag, at, pushed}}
  history: {},       // {<repo id>: {head, tail, c: [[oid10, unix s, message]…], rel: [[tag, name, unix s, notes, pre]…], done, capped, …}} (history.js)
  indexVer: 0,       // bumped when README / history text changes, so cached search facets are rebuilt
  disc: {dismissed: [], results: {}},   // discovery cache (see discover.js)
  users: {},         // {<owner login lower-cased>: {at, type, stars, followers, name} | {at, missing}}: how many repos each user of your stars starred (users.js)
  starCurves: {},    // {<owner/name lower-cased>: {at, pts: [[time, stars], …] | null}} from star-history.com (shared by all users)
  forkMode: 'all',   // the toolbar's Forks choice (forks.js FORK_MODES): show, hide or show only forks and/or hidden forks
  hideForks: false,  // derived from forkMode: GitHub forks are hidden (starred repos and Discover)
  hideCopies: false, // derived from forkMode: hidden forks (copies GitHub doesn't mark as forks) are hidden
  stop: false,       // set by the Cancel button: running jobs save what they have and end (see sync.js task())
  gen: 0,            // bumped when the user changes: running jobs compare it and stop without saving
  loading: null,     // a Promise while load() reads the profile's cache: jobs started then would save half-loaded data
};

let genCtrl = new AbortController(), ctrlGen = 0;
/** Bumps S.gen and aborts any in-flight requests from the previous generation. */
export function nextGen() {
  genCtrl.abort();
  genCtrl = new AbortController();
  ctrlGen = ++S.gen;
  return S.gen;
}
/** AbortSignal for the current generation (also reacts if S.gen was bumped directly). */
export function genSignal() {
  if (ctrlGen !== S.gen) {
    genCtrl.abort();
    genCtrl = new AbortController();
    ctrlGen = S.gen;
  }
  return genCtrl.signal;
}

/** Did you star this repo? true / false while visiting, null when that isn't known yet; always true outside a visit (they are your stars). */
export function isMine(r) {
  if (!S.visit) return true;
  if (!S.mine) return null;
  return S.mine.ids.has(r.id) || S.mine.names.has(String(r.full).toLowerCase());
}
/** The set {ids, names} of a list of repos ({id, full}). */
export const mineOf = repos => ({ids: new Set(repos.map(r => r.id).filter(i => i != null)), names: new Set(repos.map(r => r.full.toLowerCase()))});

export const ukey = () => S.user.toLowerCase();

/** Cache key of a repo: GitHub's numeric id (survives renames/transfers). Old caches without id fall back to "owner/name". */
export const rkey = r => String(r.id ?? r.full);

export const readmeEntry = r => S.readmes[rkey(r)];
export const readmeText = r => readmeEntry(r)?.t || '';

// Lower-cased README text, computed once per README version (entries are replaced when a README changes),
// so searching doesn't lowercase ~10 MB of text on every keystroke.
const lowerCache = new WeakMap();
export function readmeLower(r) {
  const e = readmeEntry(r);
  if (!e?.t) return '';
  let low = lowerCache.get(e);
  if (low === undefined) lowerCache.set(e, low = e.t.toLowerCase());
  return low;
}

export const bumpIndex = () => { S.indexVer++; };

// Commit messages and/or release notes of one repo as a single lower-cased text (one line per message, releases first,
// newest first), built once per history record and per choice of parts (records are replaced, never edited, when their
// text changes). `which` is 'rc' (both), 'r' (releases only) or 'c' (commits only). `offs` holds each line's start so a
// hit position maps back to its commit or release.
const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const histCache = new WeakMap();
/** The search-in checkboxes as a `which` value: true = both (older callers), false / '' = none. */
export const partsKey = (commits, releases) => `${releases ? 'r' : ''}${commits ? 'c' : ''}`;
const norm = which => which === true ? 'rc' : which || '';
export function historyIndex(r, which = 'rc') {
  which = norm(which);
  const rec = S.history[rkey(r)];
  if (!rec || !which) return null;
  let per = histCache.get(rec);
  if (per === undefined) histCache.set(rec, per = {});
  let ix = per[which];
  if (ix === undefined) {
    const parts = [], offs = [];
    let pos = 0;
    const add = text => { const t = text.toLowerCase(); offs.push(pos); parts.push(t); pos += t.length + 1; };
    const rel = which.includes('r') ? rec.rel || [] : [];
    for (const x of rel) add(squash(`${x[0]} ${x[1]} ${x[3]}`));
    if (which.includes('c')) for (const x of rec.c || []) add(squash(x[2]));
    per[which] = ix = {low: parts.join('\n'), offs, nRel: rel.length};
  }
  return ix;
}
/** Newest commit message or release note containing `term` (lower-cased), as {kind, id, t, text}, or null. */
export function historyHit(r, term, which = 'rc') {
  const ix = historyIndex(r, which);
  const i = ix ? ix.low.indexOf(term) : -1;
  if (i < 0) return null;
  let lo = 0, hi = ix.offs.length - 1;   // the line containing position i
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ix.offs[mid] <= i) lo = mid; else hi = mid - 1; }
  const rec = S.history[rkey(r)];
  if (lo < ix.nRel) { const x = rec.rel[lo]; return {kind: 'Release', id: x[0], t: x[2], text: squash(`${x[0]} ${x[1]} ${x[3]}`)}; }
  const x = rec.c[lo - ix.nRel];
  return {kind: 'Commit', id: x[0], t: x[1], text: squash(x[2])};
}

/** Builds every repo's history search text (for the parts `which`) in small slices, yielding between them, so the first
 *  search over a large index doesn't freeze the page. Stops early if the list of repos was replaced (another profile, a sync). */
export async function warmHistoryIndex(repos = S.repos, which = 'rc') {
  const todo = repos.filter(r => S.history[rkey(r)]);
  for (let i = 0; i < todo.length; i += 25) {
    if (repos !== S.repos) return;
    for (const r of todo.slice(i, i + 25)) historyIndex(r, which);
    await new Promise(resolve => setTimeout(resolve));
  }
}

/** Have this record's commits been pulled (a walk started or finished)? */
export const commitsPulled = h => !!(h && (h.c?.length || h.head || h.cAt));
/** Have this record's releases been fetched at least once? (relN is -1 until then, and again when marked to fetch again.) */
export const releasesPulled = h => !!(h && (h.relAt || h.rAt || h.rel?.length || h.relN >= 0));
/** Which parts of the commit & release index this profile has pulled: the background top-up keeps exactly those up to
 *  date (it never starts a new one), and loading a profile turns on searching them. */
export function indexedParts(history = S.history) {
  let commits = false, releases = false;
  for (const [k, h] of Object.entries(history)) {
    if (k.startsWith('_')) continue;
    commits ||= commitsPulled(h);
    releases ||= releasesPulled(h);
    if (commits && releases) break;
  }
  return {commits, releases};
}

// Starred names/ids as Sets, rebuilt only when S.repos is replaced (every change assigns a new array).
let setsFor = null, names = new Set(), ids = new Set();
function starredSets() {
  if (setsFor !== S.repos) {
    setsFor = S.repos;
    names = new Set(S.repos.map(r => r.full.toLowerCase()));
    ids = new Set(S.repos.map(r => r.id).filter(i => i != null));
  }
  return {names, ids};
}
/** Lower-cased "owner/name" of every starred repo. */
export const starredSet = () => starredSets().names;
/** GitHub ids of every starred repo (catches renamed/transferred repos a name check would miss). */
export const starredIds = () => starredSets().ids;
