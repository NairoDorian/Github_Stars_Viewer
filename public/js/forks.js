/* Forks, both kinds: GitHub's forks (r.fork) and "hidden forks", repos copied without GitHub knowing (clone and push to
   a new repo, or upload of a downloaded zip), so GitHub doesn't mark them as forks.

   Hidden forks are found locally, among your own stars, for free (no request). A pair of repos of different owners is
   compared on these signals:
     · shared git history: copies made with clone + push keep every commit, with the same id and date. Seen in the
       commit index (📝 Commits); the strongest signal. Only the stored part of each history is compared.
     · README: near-identical text (MinHash of 4-word shingles, URLs and badges left out, since a copy usually rewrites
       them). Needs the README index. A README shared by many repos (a template, e.g. a framework's starter README)
       doesn't count.
     · description: the same About text, or nearly.
     · name: the same repo name (ignoring case, "-", "_" and ".").
     · topics: the same set of three or more topics.
   Points add up; at HIDDEN_AT or more the newer repo (by creation date; fewer stars on a tie) is the hidden fork of
   the older one. A repo that GitHub already marks as a fork is never called hidden. A pair you mark "not a copy" is
   never reported again (kept in this browser's preferences).

   The scan runs in the background (signatures are cached per README and per commit history, so later scans are fast)
   whenever the repos, READMEs or commit index change, and announces its result with a "hidden-forks" event. */
import {S, rkey, readmeEntry} from './state.js';
import {debug, info} from './log.js';

export const HIDDEN_AT = 2.5;
const K = 64, ROWS = 4, BANDS = K / ROWS;   // MinHash size and LSH banding: pairs ≥ ~60% similar almost always meet in a band
const SHINGLE = 4, MAX_WORDS = 1500, MIN_SHINGLES = 30;   // a copied README matches over its first 1,500 words already
const TEMPLATE = 2;   // a README close to more than this many other READMEs is a template (a starter README, a vendor example), not evidence of a copy
const PROBES = 25;    // newest and oldest stored commits of each history, looked up in every other history

/* ------------------------------------------------ text signals ------------------------------------------------ */

function hash(s) {   // FNV-1a, 32 bits
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const SEEDS = Array.from({length: K}, (_, i) => (Math.imul(i + 1, 0x9e3779b1) ^ 0x5bd1e995) >>> 0);
function mix(h, seed) {   // murmur3 finalizer: one independent-looking permutation per seed
  h = Math.imul(h ^ seed, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The words of a README that a copy keeps: lower-cased, without URLs, images / badges, HTML tags and punctuation. */
export function readmeWords(text) {
  return String(text || '').toLowerCase()
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                  // images and badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                 // links keep their text
    .replace(/<[^>]+>/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1).slice(0, MAX_WORDS);
}

/* Text that says nothing about a project counts as empty, so two repos are never linked by having nothing (or the same
   placeholder) to say: default READMEs and descriptions written by project generators, and placeholder descriptions.
   A long README that merely keeps a generator's section still counts (BOILERPLATE_WORDS). */
const BOILERPLATE = [
  /bootstrapped with \[?create react app/, /getting started with create react app/, /this project was bootstrapped with \[?create-?react-?app/,
  /a new flutter (project|application|app|plugin|package|module)/, /this project is a starting point for a flutter/,
  /this is a \[?next\.?js\]? project bootstrapped with/, /this project was generated with \[?angular cli/,
  /this template should help get you started developing with vue/, /this template provides a minimal setup to get react working in vite/,
  /react \+ typescript \+ vite/, /vue 3 \+ (typescript \+ )?vite/, /look at the \[?nuxt/, /welcome to your new (jekyll|gatsby|docusaurus|astro)/,
  /this (repository|repo|project) (was )?(created|generated) (from|with|using) (a |the )?template/,
  /this is a \[?remix\]? (project|app)/,
  // vendor examples copied as a starting point: two repos that started from one example didn't copy each other
  /^\s*\|\s*supported targets\s*\|/, /this repository offers dev containers supports? for/, /this example (demonstrates|shows|illustrates) how/,
  /^\s*#\s*(hello[ _-]?world|blink|get[ _-]?started|sample[ _-]project)( example)?\s*$/m,
];
const BOILERPLATE_WORDS = 700;
const PLACEHOLDER_DESC = /^(no description( provided| yet)?|description|desc|todo|tbd|test|testing|wip|work in progress|none|empty|n a|na|null|undefined|placeholder|coming soon|my (first )?(project|repo|repository)|initial commit|first commit|hello world)$/;
/** Is this README empty for comparing: nothing, only badges / links / markup, or a generator's untouched README? */
export function blankReadme(text) {
  const w = readmeWords(text);
  if (!w.length) return true;
  const low = String(text).toLowerCase();
  return w.length < BOILERPLATE_WORDS && BOILERPLATE.some(re => re.test(low));
}

/** MinHash signature (Uint32Array of K) of a text's 4-word shingles, or null when the text is too short or empty to judge. */
export const signature = text => sketch(text)?.sig ?? null;
/** {sig, n: how many distinct shingles} or null. */
function sketch(text) {
  if (blankReadme(text)) return null;
  const w = readmeWords(text), sh = new Set();
  for (let i = 0; i + SHINGLE <= w.length; i++) sh.add(hash(w.slice(i, i + SHINGLE).join(' ')));
  if (sh.size < MIN_SHINGLES) return null;
  const sig = new Uint32Array(K).fill(0xffffffff);
  for (const h of sh) for (let i = 0; i < K; i++) { const v = mix(h, SEEDS[i]); if (v < sig[i]) sig[i] = v; }
  return {sig, n: sh.size};
}
/** Estimated Jaccard similarity (0…1) of two signatures. */
export function similarity(a, b) {
  let same = 0;
  for (let i = 0; i < K; i++) if (a[i] === b[i]) same++;
  return same / K;
}

const sigCache = new WeakMap();   // README entry → {sig, n} | null. Entries are replaced when a README changes.
function readmeSig(r) {
  const e = readmeEntry(r);
  if (!e?.t) return null;
  let s = sigCache.get(e);
  if (s === undefined) sigCache.set(e, s = sketch(e.t));
  return s;
}
const hasSig = r => { const e = readmeEntry(r); return !e?.t || sigCache.has(e); };

export const normName = n => String(n || '').toLowerCase().replace(/[-_.\s]+/g, '');
/** A description reduced to its words; '' when it says nothing (empty, only symbols, a placeholder or a generator's default). */
export function normDesc(d) {
  const n = String(d || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return !n || PLACEHOLDER_DESC.test(n) || BOILERPLATE.some(re => re.test(String(d).toLowerCase())) ? '' : n;
}
const tokens = d => new Set(normDesc(d).split(' ').filter(w => w.length > 1));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
/** How alike two descriptions are: 'same' (identical once normalized, long enough to mean something), 'close', or null. */
export function descMatch(a, b) {
  const na = normDesc(a), nb = normDesc(b);
  if (!na || !nb) return null;
  if (na === nb) return na.length >= 15 ? 'same' : null;
  const ta = tokens(a), tb = tokens(b);
  return Math.min(ta.size, tb.size) >= 4 && jaccard(ta, tb) >= 0.7 ? 'close' : null;
}

/* ------------------------------------------------ git history ------------------------------------------------ */

/** Stored commits of a repo ([[oid10, unix time, message]…], newest first), or null. */
const commitsOf = r => { const c = S.history[rkey(r)]?.c; return c?.length ? c : null; };
/** Is only the newest part of this history stored (the index keeps the newest N commits per repo by default)? */
const truncated = r => { const h = S.history[rkey(r)]; return !!h && (h.capped || !h.done); };
const probesOf = c => c.length <= 2 * PROBES ? c : [...c.slice(0, PROBES), ...c.slice(-PROBES)];
/** Of the copy's stored commits, how many the original has (the same id AND date: a 10-character id alone could
 *  collide), counted only over the time both histories cover: when the original keeps only its newest commits, the
 *  copy's older ones can't be found there and say nothing either way. Returns {shared, total}. */
export function sharedCommits(copy, orig, origTruncated = false) {
  const at = new Map(orig.map(x => [x[0], x[1]])), from = origTruncated ? orig.at(-1)[1] : -Infinity;
  let shared = 0, total = 0;
  for (const x of copy) {
    if (x[1] < from) continue;
    total++;
    if (at.get(x[0]) === x[1]) shared++;
  }
  return {shared, total};
}

/* ------------------------------------------------ detection ------------------------------------------------ */

/** Which of two look-alike repos came first: the older one by creation date, else the one with more stars. */
const older = (a, b) => {
  const ta = Date.parse(a.created || '') || Infinity, tb = Date.parse(b.created || '') || Infinity;
  if (ta !== tb) return ta < tb ? a : b;
  return (a.stars ?? 0) >= (b.stars ?? 0) ? a : b;
};
export const pairKey = (a, b) => [rkey(a), rkey(b)].sort().join('|');

/* Evidence and its points. A pair is a copy at HIDDEN_AT points, with commits, README or description among them:
     commits      CLONE: ≥ 3 shared, at least half of the copy's stored history (and ≥ 10 shared, or ≥ 90% for tiny repos)  4
                  PARTIAL: ≥ 20 shared but a smaller part (siblings of one upstream, long-diverged continuations)            1
     README       ≥ 90% identical and long enough to mean something (LONG_README shingles) 2.5 · ≥ 75% 1.5 · ≥ 50% 1
     description  the same (≥ 15 characters of real words) 1.5 · nearly the same 1
     name 1 · topics (the same 3 or more) 0.5
   So a README alone must be near-identical and substantial; anything weaker needs a second, independent signal. */
const LONG_README = 150;

/** The detection, as steps that yield now and then (scan() lets the page breathe in between; detectHiddenForks() doesn't). */
function* detect(repos, ignored, out) {
  const n = repos.length, cand = new Map();   // i * n + j (i < j) → evidence
  const pair = (i, j) => {
    if (i === j) return null;
    if (i > j) [i, j] = [j, i];
    const a = repos[i], b = repos[j];
    if (!a.owner || String(a.owner).toLowerCase() === String(b.owner).toLowerCase()) return null;   // the same owner's own repos aren't copies
    const k = i * n + j;
    let e = cand.get(k);
    if (!e) cand.set(k, e = {i, j});
    return e;
  };

  // README: LSH bands. A README in a huge bucket is boilerplate seen everywhere; see also the template rule below.
  const sigs = repos.map(readmeSig), near = new Map(), template = new Set();
  for (let b = 0; b < BANDS; b++) {
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const s = sigs[i]?.sig;
      if (!s) continue;
      const key = Array.prototype.join.call(s.subarray(b * ROWS, b * ROWS + ROWS), ',');
      const list = buckets.get(key);
      if (list) list.push(i); else buckets.set(key, [i]);
    }
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      if (list.length > 60) { for (const i of list) template.add(i); continue; }
      for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
        const e = pair(list[x], list[y]);
        if (e && e.readme === undefined) e.readme = similarity(sigs[list[x]].sig, sigs[list[y]].sig);
      }
    }
    yield;
  }

  // Same exact description or the same name: cheap groups (large groups are generic, e.g. "dotfiles").
  const group = (keyOf, max) => {
    const g = new Map();
    repos.forEach((r, i) => { const k = keyOf(r); if (k) { const l = g.get(k); if (l) l.push(i); else g.set(k, [i]); } });
    for (const l of g.values()) if (l.length > 1 && l.length <= max) for (let x = 0; x < l.length; x++) for (let y = x + 1; y < l.length; y++) pair(l[x], l[y]);
  };
  group(r => { const d = normDesc(r.about); return d.length >= 15 ? d : ''; }, 8);
  group(r => normName(r.name), 8);

  // Git history: the newest and oldest stored commits of each repo, looked up (id and date) in every other repo's history.
  const commits = repos.map(commitsOf), probe = new Map();   // oid → [repo index, time, repo index, time, …]
  commits.forEach((c, i) => { if (c) for (const x of probesOf(c)) { const l = probe.get(x[0]); if (!l) probe.set(x[0], [i, x[1]]); else if (!l.includes(i)) l.push(i, x[1]); } });
  const hits = new Map();
  for (let i = 0; i < n; i++) {
    const c = commits[i];
    if (c) for (const x of c) {
      const l = probe.get(x[0]);
      if (l) for (let m = 0; m < l.length; m += 2) if (l[m] !== i && l[m + 1] === x[1]) { const j = l[m], k = i < j ? i * n + j : j * n + i; hits.set(k, (hits.get(k) || 0) + 1); }
    }
    if (i % 300 === 299) yield;
  }
  for (const [k, h] of hits) if (h >= 2) pair(Math.floor(k / n), k % n);

  // Templates: a README close to more than TEMPLATE others WITHOUT shared history (a vendor example, a starter README:
  // repos that each started from it didn't copy each other). The copies of a popular original share its commits, so
  // they don't make the original's README a template.
  for (const e of cand.values()) if (e.readme >= 0.5 && (hits.get(e.i * n + e.j) || 0) < 2) for (const i of [e.i, e.j]) near.set(i, (near.get(i) || 0) + 1);
  for (const [i, c] of near) if (c > TEMPLATE) template.add(i);

  // Score every candidate pair; keep each copy's qualifying originals.
  const edges = new Map();   // copy index → [{o: original index, score, why}]
  let done = 0;
  for (const e of cand.values()) {
    if (++done % 2000 === 0) yield;
    const a = repos[e.i], b = repos[e.j];
    if (ignored.has(pairKey(a, b))) continue;   // you said it isn't a copy
    let score = 0, ci = null;
    const why = [], ca = commits[e.i], cb = commits[e.j];
    if (ca && cb && (hits.get(e.i * n + e.j) || 0) >= 2) {
      // The copy is the newer repo. Not "the side whose history is contained": an original that stopped changing is
      // contained in every continuation of it (Shizuku in Shizuku-Next), yet it came first.
      ci = older(a, b) === a ? e.j : e.i;
      const oi = ci === e.i ? e.j : e.i, {shared, total} = sharedCommits(commits[ci], commits[oi], truncated(repos[oi]));
      const part = total ? shared / total : 0, text = `shares ${shared.toLocaleString()} commits (${Math.round(part * 100)}% of its history ${truncated(repos[oi]) ? 'in the period both indexes cover' : 'that is indexed'})`;
      if (shared >= 3 && part >= 0.5 && (shared >= 10 || part >= 0.9)) { score += 4; why.push(text); }
      else if (shared >= 20) { score += 1; why.push(text); }
    }
    if (ci === null) ci = older(a, b) === a ? e.j : e.i;
    const oi = ci === e.i ? e.j : e.i, copy = repos[ci];
    if (copy.fork) continue;   // GitHub already calls it a fork
    if (e.readme >= 0.5 && !template.has(e.i) && !template.has(e.j)) {
      const long = Math.min(sigs[e.i].n, sigs[e.j].n) >= LONG_README;
      score += e.readme >= 0.9 && long ? 2.5 : e.readme >= 0.75 ? 1.5 : 1;
      why.push(`README ${Math.round(e.readme * 100)}% identical`);
    }
    const d = descMatch(a.about, b.about);
    if (d) { score += d === 'same' ? 1.5 : 1; why.push(d === 'same' ? 'same description' : 'nearly the same description'); }
    const content = why.length > 0;   // commits, README or description: a name and topics alone never make a copy
    if (normName(a.name) && normName(a.name) === normName(b.name)) { score += 1; why.push('same name'); }
    const ta = new Set(a.topics || []), tb = b.topics || [];
    if (ta.size >= 3 && ta.size === tb.length && tb.every(t => ta.has(t))) { score += 0.5; why.push('same topics'); }
    if (!content || score < HIDDEN_AT) continue;
    const l = edges.get(ci);
    if (l) l.push({o: oi, score, why}); else edges.set(ci, [{o: oi, score, why}]);
  }

  // Each copy points at an original that is no fork of any kind when it can (a copy of a copy, or two copies of one
  // upstream, would otherwise name another copy); then the best evidence, then the most stars. `root`: the top of the chain.
  // A GitHub fork of the upstream is a worse original than the upstream itself, a hidden copy worse still.
  const derived = x => edges.has(x.o) ? 2 : repos[x.o].fork ? 1 : 0;
  // On equal evidence the older repo is further upstream (a copy of a copy matches both), then the more starred.
  const age = x => Date.parse(repos[x.o].created || '') || Infinity;
  const rank = (x, y) => (derived(x) - derived(y)) || (y.score - x.score) || (age(x) - age(y)) || ((repos[y.o].stars ?? 0) - (repos[x.o].stars ?? 0));
  const best = new Map([...edges].map(([ci, l]) => [ci, [...l].sort(rank)[0]]));
  for (const [ci, x] of best) {
    let root = x.o;
    for (let hop = 0; best.has(root) && best.get(root).o !== ci && hop < 20; hop++) root = best.get(root).o;
    out.set(rkey(repos[ci]), {of: repos[x.o], root: repos[root], score: x.score, why: x.why});
  }
}

/** Finds hidden forks among `repos`. Returns Map(rkey of the copy → {of: the original it matches, root: the original at
 *  the top of a chain of copies, score, why: [reasons]}). `ignored`: Set of pairKey()s the user marked "not a copy". */
export function detectHiddenForks(repos = S.repos, ignored = new Set()) {
  const out = new Map();
  for (const _ of detect(repos, ignored, out));
  return out;
}

/* ------------------------------------------------ state & modes ------------------------------------------------ */

const IGNORE_PREF = 'starsViewer.notCopies';
let ignored = new Set();
try { ignored = new Set(JSON.parse(localStorage.getItem(IGNORE_PREF) || '[]')); } catch {}

let found = new Map();      // rkey of a hidden fork → {of, score, why}
let copies = new Map();     // rkey of an original → [hidden forks of it]
let scannedFor = null, timer = null, running = null;

export const hiddenFork = r => found.get(rkey(r)) || null;
export const copiesOf = r => copies.get(rkey(r)) || [];
export const hiddenCount = () => found.size;
/** "fork" (GitHub's), "hidden" (a copy found here) or null. */
export const forkKind = r => r.fork ? 'fork' : found.has(rkey(r)) ? 'hidden' : null;

function setFound(map) {
  found = map;
  copies = new Map();
  const byKey = new Map(S.repos.map(r => [rkey(r), r]));
  for (const [k, v] of map) {
    const o = rkey(v.of), copy = byKey.get(k);
    if (copy) { const l = copies.get(o); if (l) l.push(copy); else copies.set(o, [copy]); }
  }
}

/** The toolbar's Forks choice: which kinds of fork the lists show. */
export const FORK_MODES = [
  ['all', 'Show all repos'],
  ['hide', 'Hide forks'],
  ['hideHidden', 'Hide hidden forks'],
  ['hideAll', 'Hide forks & hidden forks'],
  ['only', 'Only forks'],
  ['onlyHidden', 'Only hidden forks'],
  ['onlyAll', 'Only forks & hidden forks'],
];
/** Does the Forks choice let this repo through? */
export function forkVisible(r, mode = S.forkMode) {
  const k = forkKind(r);
  switch (mode) {
    case 'hide': return k !== 'fork';
    case 'hideHidden': return k !== 'hidden';
    case 'hideAll': return !k;
    case 'only': return k === 'fork';
    case 'onlyHidden': return k === 'hidden';
    case 'onlyAll': return !!k;
    default: return true;
  }
}
/** Sets the mode and the two flags Discover uses (suggestions are never limited to forks). */
export function setForkMode(mode) {
  S.forkMode = FORK_MODES.some(([m]) => m === mode) ? mode : 'all';
  S.hideForks = S.forkMode === 'hide' || S.forkMode === 'hideAll';
  S.hideCopies = S.forkMode === 'hideHidden' || S.forkMode === 'hideAll';
}

/** "Not a copy": this pair is never reported again. */
export function notACopy(copyKey) {
  const v = found.get(copyKey), copy = S.repos.find(r => rkey(r) === copyKey);
  if (!v || !copy) return;
  ignored.add(pairKey(copy, v.of));
  try { localStorage.setItem(IGNORE_PREF, JSON.stringify([...ignored])); } catch {}
  info('forks', `${copy.full} is not a copy of ${v.of.full}: this pair won't be reported again`);
  const next = new Map(found);
  next.delete(copyKey);
  setFound(next);
  scannedFor = null;   // the next render rescans: another original may still match
  window.dispatchEvent(new CustomEvent('hidden-forks'));
}
/** After "Clear cache" erased the preferences. */
export function resetForks() { ignored = new Set(); setFound(new Map()); scannedFor = null; }

/** Called by every render: rescans (in the background, debounced) when the repos, READMEs or commit index changed. */
export function scheduleForkScan() {
  const key = [S.repos, S.indexVer, ignored.size];
  if (scannedFor && key.every((v, i) => v === scannedFor[i])) return;
  scannedFor = key;
  clearTimeout(timer);
  timer = setTimeout(() => { running = scan(key); }, 300);
  timer.unref?.();   // Node (tests): a pending scan must not keep the process alive
}

/** Warms README signatures and commit lists in small slices (yielding to the page), then runs the detection. */
async function scan(key) {
  const repos = key[0], t0 = performance.now(), todo = repos.filter(r => !hasSig(r));   // the repos the scan was scheduled for: replaced since → a newer scan is due
  for (let i = 0; i < todo.length; i += 15) {
    if (repos !== S.repos || scannedFor !== key) return;
    for (const r of todo.slice(i, i + 15)) readmeSig(r);
    await new Promise(resolve => setTimeout(resolve));
  }
  const map = new Map();
  let slice = performance.now();
  for (const _ of detect(repos, ignored, map)) {   // runs in ~25 ms slices, so a big profile never freezes the page
    if (performance.now() - slice < 25) continue;
    await new Promise(resolve => setTimeout(resolve));
    if (repos !== S.repos || scannedFor !== key) return;
    slice = performance.now();
  }
  if (repos !== S.repos || scannedFor !== key) return;
  const before = found;
  setFound(map);
  const sameAs = (k, v) => { const p = before.get(k); return !!p && rkey(p.of) === rkey(v.of) && p.why.join() === v.why.join(); };
  const same = before.size === map.size && [...map].every(([k, v]) => sameAs(k, v));
  const nReadme = repos.filter(r => readmeEntry(r)?.t).length, nHist = repos.filter(r => S.history[rkey(r)]?.c?.length).length;
  (same ? debug : info)('forks', `hidden forks: ${map.size} found among ${repos.length.toLocaleString()} repos in ${Math.round(performance.now() - t0)} ms` +
    ` (compared ${nReadme.toLocaleString()} READMEs, ${nHist.toLocaleString()} commit histories, names and descriptions)` +
    (map.size ? ': ' + [...map].slice(0, 5).map(([k, v]) => `${repos.find(r => rkey(r) === k)?.full} ⧉ ${v.of.full}`).join(', ') + (map.size > 5 ? '…' : '') : ''));
  if (!same) window.dispatchEvent(new CustomEvent('hidden-forks'));
}
/** For tests: waits for a scheduled scan to finish. */
export async function settleForks() { if (timer) await new Promise(r => setTimeout(r, 320)); await running; }

/* ------------------------------------------------ suggestions ------------------------------------------------ */

/** Is this suggestion (a GitHub API repo) a copy of one of your stars? The same name and description as an older
 *  starred repo of another owner. Returns that star or null. Suggestions have no README or history to compare. */
export function copyOfStar(x) {
  const name = normName(String(x.full_name || '').split('/')[1]), owner = String(x.full_name || '').split('/')[0].toLowerCase();
  if (!name || x.fork) return null;
  for (const r of S.repos) {
    if (normName(r.name) !== name || String(r.owner).toLowerCase() === owner) continue;
    if (descMatch(r.about, x.description) && older(r, {created: x.created_at, stars: x.stargazers_count}) === r) return r;
  }
  return null;
}
