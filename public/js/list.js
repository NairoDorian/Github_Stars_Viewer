/* The main list: search, facet filters, sorting, export and rendering of repo cards (also used for Discover suggestions).

   Search: every positive term must match the card fields (name, owner, about, topics, languages) or, when ticked, the
   READMEs or the commit messages / release notes; each term may match somewhere different. "exact phrase", -exclude and
   qualifiers (lang: owner: topic: is: stars:) are supported. Matches outside the card fields are explained by snippets. */
import {S, isMine, rkey, readmeEntry, readmeText, readmeLower, historyIndex, historyHit, warmHistoryIndex, partsKey, indexedParts, commitsPulled, releasesPulled} from './state.js';
import {$, esc, escRe, fmtN, fmtDate, ago, when, safeUrl, tally, status} from './util.js';
import {activityNow, starGains, ACTIVITY_SPAN, ACTIVITY_BUCKETS, setStar, whoAmI, needToken} from './github.js';
import {drawableCurve, starsAt, watchStarCharts} from './starhistory.js';
import {sortRepos, SORT_OPTIONS, EXTRA_VALUES} from './sort.js';
import {summaryOf, hasKind, extOf, hardwareCount, models3dCount, KINDS, EMBEDDED, kindLabel, kindIcon, kindHelp} from './filekinds.js';
import {debug, info, warn} from './log.js';
import {hiddenFork, copiesOf, forkKind, forkVisible, setForkMode, scheduleForkScan, notACopy, resetForks, FORK_MODES} from './forks.js';

const PAGE = 200;   // cards rendered per step; more load automatically when you reach the end (or via Show more)
const filters = {lang: null, topic: null, owner: null, gone: false, family: null, kind: null};   // gone: only the repos GitHub no longer shows (removed, private or hidden) · family: rkey of an original, shown with its hidden forks
let limit = PAGE;

// ---- file lists (files.js): summaries, path search, has: / ext: / path: / files: ----
const fileRec = r => S.files[rkey(r)];
/** The file-list summary of a repo (kinds, build systems, extensions), or null when its files were not pulled. */
export const filesOf = r => summaryOf(fileRec(r));
// Lower-cased paths of a file-list record, one per line, built once per record (records are replaced, never edited).
const pathCache = new WeakMap();
function pathsLower(rec) {
  if (!rec?.p?.length) return '';
  let t = pathCache.get(rec);
  if (t === undefined) pathCache.set(rec, t = rec.p.join('\n').toLowerCase());
  return t;
}
/** First stored path containing `term` (lower-cased), or null. */
function fileHit(r, term) {
  const rec = fileRec(r), low = pathsLower(rec), i = low.indexOf(term);
  if (i < 0) return null;
  const start = low.lastIndexOf('\n', i) + 1, end = low.indexOf('\n', i), line = low.slice(start, end < 0 ? undefined : end);
  return rec.p.find(x => x.toLowerCase() === line) || line;
}
/** Does the repo have a "file kind" (filters.kind / the sidebar): a kind key, or 'firmware' (an embedded build system). */
const hasFileKind = (r, kind) => { const f = filesOf(r); return !!f && !!hasKind(f, kind, fileRec(r).p); };
// Sort orders that need the file lists (sort.js asks for them by key; repos without the kind sort last).
EXTRA_VALUES.hardware = r => { const c = hardwareCount(filesOf(r)); return c || null; };
EXTRA_VALUES.models3d = r => { const c = models3dCount(filesOf(r)); return c || null; };
EXTRA_VALUES.files = r => fileRec(r)?.n || null;

// Lower-cased searchable text per repo object: name, about, topics and languages. Repo objects are replaced on every
// sync; the language breakdown (r.langs) is filled in later by the details check, so it is part of the cache check.
const hayCache = new WeakMap();
function hay(r) {
  let h = hayCache.get(r);
  if (!h || h.langs !== r.langs) {
    h = {langs: r.langs, text: [r.full, r.about, r.topics.join(' '), r.lang, ...(r.langs || []).map(l => l[0])].join(' ').toLowerCase()};
    hayCache.set(r, h);
  }
  return h.text;
}

/** Parses search text into {inc, exc, quals, hasQuery}: supports "exact phrases", -negation, and key:value qualifiers. */
export function parseQuery(raw) {
  const inc = [], exc = [], quals = [], QK = /^(lang|language|owner|user|topic|tag|is|stars|has|ext|path|file|files|build)$/;
  for (const m of (raw || '').toLowerCase().matchAll(/(-?)(?:([a-z]+):)?"([^"]+)"|(\S+)/g)) {
    if (m[3] !== undefined) {
      const neg = m[1] === '-', k = m[2], v = m[3].trim();
      if (!v) continue;
      if (k && QK.test(k)) quals.push({k, v, neg});
      else (neg ? exc : inc).push(k ? `${k}:${v}` : v);
      continue;
    }
    const tok = m[4].replace(/^(-?)"+|"+$/g, '$1'), neg = tok.startsWith('-'), body = neg ? tok.slice(1) : tok;   // a quote still being typed is ignored
    if (!body) continue;
    const colon = body.indexOf(':');
    if (colon > 0) {
      const k = body.slice(0, colon), v = body.slice(colon + 1);
      if (v && QK.test(k)) { quals.push({k, v, neg}); continue; }
    }
    (neg ? exc : inc).push(body);
  }
  return {inc, exc, quals, hasQuery: inc.length > 0 || exc.length > 0 || quals.length > 0};
}

/** "1500", "1.5k", "2m" → a number; NaN when it isn't one. */
const count = s => {
  const m = s.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  return m ? Number(m[1]) * ({k: 1e3, m: 1e6}[m[2]] || 1) : NaN;
};
/** Does the qualifier hold for this repo? null when it can't be understood (e.g. "is:foo", "stars:lots"): such a
 *  qualifier is ignored instead of hiding every repo, with or without a "-" in front. */
function checkQual(r, {k, v}) {
  if (k === 'lang' || k === 'language') return (r.lang || '').toLowerCase() === v || (r.langs || []).some(([n]) => n.toLowerCase() === v);
  if (k === 'owner' || k === 'user') return (r.owner || '').toLowerCase() === v;
  if (k === 'topic' || k === 'tag') return (r.topics || []).some(t => t.toLowerCase() === v);
  // is:new / is:mine: did YOU star it (while visiting someone: unknown, hence ignored, until your stars are known). is:removed: deleted, private or hidden on GitHub.
  // is:fork: GitHub's forks · is:hiddenfork / is:copy: copies GitHub doesn't mark (forks.js) · is:anyfork: either · is:original: has hidden forks in your stars.
  if (k === 'is') return v === 'archived' ? !!r.archived : v === 'active' ? !r.archived : v === 'fork' ? !!r.fork : v === 'removed' ? !!r.gone
    : v === 'hiddenfork' || v === 'hidden-fork' || v === 'copy' ? forkKind(r) === 'hidden' : v === 'anyfork' ? !!forkKind(r) : v === 'original' ? copiesOf(r).length > 0
    : v === 'mine' ? isMine(r) : v === 'new' ? (isMine(r) === null ? null : !isMine(r)) : null;
  // File lists (📁 Files): unknown (ignored) for a repo whose files were not pulled.
  if (k === 'has') { const f = filesOf(r); return f ? hasKind(f, v, fileRec(r).p) : null; }
  if (k === 'ext') { const rec = fileRec(r); if (!rec?.p) return null; const e = v.replace(/^\./, ''); return rec.p.some(x => extOf(x) === e); }
  if (k === 'path' || k === 'file') { const rec = fileRec(r); return rec?.p ? pathsLower(rec).includes(v) : null; }
  if (k === 'build') { const f = filesOf(r); return f ? f.build.some(b => b.toLowerCase().replace(/\s+/g, '-') === v) : null; }
  if (k === 'stars' || k === 'files') {   // GitHub's forms: stars:>1000, stars:>=1k, stars:10..500, stars:100..*, stars:*..50 (files: the same, on the file count)
    if (k === 'files' && !fileRec(r)) return null;
    const s = (k === 'files' ? fileRec(r).n : r.stars) ?? 0, range = v.split('..');
    if (range.length === 2) {
      const lo = range[0] === '*' ? -Infinity : count(range[0]), hi = range[1] === '*' ? Infinity : count(range[1]);
      return Number.isNaN(lo) || Number.isNaN(hi) ? null : s >= lo && s <= hi;
    }
    const m = v.match(/^(>=|<=|>|<|=)?(.+)$/), n = count(m[2]), op = m[1] || '=';
    if (Number.isNaN(n)) return null;
    return op === '>' ? s > n : op === '>=' ? s >= n : op === '<' ? s < n : op === '<=' ? s <= n : s === n;
  }
  return null;
}

const MAX_SNIPS = 4;
const inHistoryText = (r, t, which) => historyIndex(r, which)?.low.includes(t) ?? false;
const date = unix => unix ? fmtDate(unix * 1000, {dateStyle: 'medium'}) : '';
const around = (text, term) => {
  const j = Math.max(0, text.toLowerCase().indexOf(term)), a = Math.max(0, j - 80);
  return (a ? '…' : '') + text.slice(a, a + 220) + (a + 220 < text.length ? '…' : '');
};

/** Every positive term must match name/owner/about/topics/language (or the README / commit messages / release notes
 *  when those are enabled: `inHistory` is 'rc', 'c', 'r' or '' (see partsKey), true meaning both), with no excluded
 *  term matching anywhere that is enabled. Each term may match in a
 *  different place. Returns {snips} or null; snips explain the terms that matched only inside a README, a commit
 *  message or a release note (one line per source, newest commit / release first, at most MAX_SNIPS). */
export function match(r, q, inReadme, inHistory = false, inFiles = false) {
  for (const qual of q.quals) { const ok = checkQual(r, qual); if (ok !== null && ok === qual.neg) return null; }
  for (const t of q.exc) if (hay(r).includes(t) || (inReadme && readmeLower(r).includes(t)) || (inHistory && inHistoryText(r, t, inHistory)) || (inFiles && pathsLower(fileRec(r)).includes(t))) return null;
  const snips = [];
  for (const t of q.inc) {
    if (hay(r).includes(t)) continue;
    const i = inReadme ? readmeLower(r).indexOf(t) : -1;
    if (i >= 0) {
      if (!snips.some(x => x.kind === 'README')) snips.push({kind: 'README', text: readmeText(r).slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' ')});
      continue;
    }
    const h = inHistory ? historyHit(r, t, inHistory) : null;
    if (!h) {
      const path = inFiles ? fileHit(r, t) : null;
      if (!path) return null;
      if (!snips.some(x => x.kind === 'File' && x.id === path)) snips.push({kind: 'File', id: path, text: path});
      continue;
    }
    if (!snips.some(x => x.kind === h.kind && x.id === h.id)) snips.push({kind: h.kind, id: h.id, when: date(h.t), text: around(h.text, t)});   // one line per commit / release
  }
  return {snips: snips.slice(0, MAX_SNIPS)};
}

/** Escapes text and wraps matches of `re` in <mark>. Works on raw text, so it can't break entities or tags. */
function hl(text, re) {
  text = String(text ?? '');
  if (!re) return esc(text);
  let out = '', last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/* ---- activity mini-charts: commits and stars per 2 weeks over the last 12 months ----
   One series each, so no legend: the row label names it. Bars have a 2px gap, a 1px baseline tick for empty
   periods (the rhythm stays readable), faint full-height blocks for periods the data doesn't cover, and a native
   tooltip per bar. Values are text in ink colors; only the bars carry the series color. */
const W = 260, H = 26, BAR = 8, GAP = 2;
const day = t => fmtDate(t, {month: 'short', day: 'numeric'});

function sparkbars(counts, {end, unit, cls}) {
  const n = counts.length, max = Math.max(1, ...counts.filter(v => v != null)), start = end - n * ACTIVITY_SPAN;
  const bars = counts.map((v, i) => {
    const from = start + i * ACTIVITY_SPAN, to = from + ACTIVITY_SPAN, x = i * (BAR + GAP);
    const tip = `${day(from)} – ${day(to)}`;
    if (v == null) return `<rect class="nodata" x="${x}" y="0" width="${BAR}" height="${H}" rx="1"><title>${tip}: not tracked yet</title></rect>`;
    const h = v ? Math.max(2, Math.round(v / max * (H - 1))) : 1;
    return `<rect class="${v ? cls : 'zero'}" x="${x}" y="${H - h}" width="${BAR}" height="${h}" rx="${v ? 1.5 : 0}"><title>${tip}: ${v} ${unit}${v === 1 ? '' : 's'}</title></rect>`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${unit}s per 2 weeks, last 12 months">${bars}</svg>`;
}

/** Full star timeline, from the repo's first star to today: a cumulative area (x scaled per repo) with invisible
 *  hover segments that show the date range, the total at its end and the stars gained in it. */
function starTimeline(pts) {
  const t0 = pts[0][0], t1 = Date.now(), span = Math.max(1, t1 - t0), max = Math.max(1, starsAt(pts, t1));
  const N = 60, x = t => (t - t0) / span * W, y = v => H - 1 - v / max * (H - 3);
  const line = Array.from({length: N + 1}, (_, i) => { const t = t0 + span * i / N; return `${x(t).toFixed(1)},${y(starsAt(pts, t)).toFixed(1)}`; });
  const month = t => fmtDate(t, {month: 'short', year: 'numeric'});
  const tips = Array.from({length: 26}, (_, i) => {
    const a = t0 + span * i / 26, b = t0 + span * (i + 1) / 26, va = Math.round(starsAt(pts, a)), vb = Math.round(starsAt(pts, b));
    return `<rect class="hit" x="${x(a).toFixed(1)}" y="0" width="${(W / 26).toFixed(1)}" height="${H}"><title>${month(a)} – ${month(b)}: ${vb.toLocaleString()} stars (+${(vb - va).toLocaleString()})</title></rect>`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="stars over the repo's whole life">
    <path class="s-area" d="M0,${H} L${line.join(' L')} L${W},${H} Z"/><path class="s-line" d="M${line.join(' L')}" vector-effect="non-scaling-stroke"/>${tips}</svg>`;
}

/** Commits row (GitHub) + stars row. Stars come from star-history.com (full history, loaded lazily when the card
 *  scrolls into view, see starhistory.js); if it has no data for a repo, the app's own daily star-count samples are used. */
const shown = new Map();   // lower-cased full name → repo object, so a card can be redrawn when its star history arrives (reset with the filters, i.e. when the profile changes)
export function activityHTML(r) {
  const full = r.full || r.full_name;
  if (full) shown.set(full.toLowerCase(), r);
  const commits = activityNow(r.activity), curve = full ? drawableCurve(full) : null, hist = r.starHist;
  const rows = [];
  if (commits) {
    const total = commits.reduce((a, b) => a + b, 0);
    rows.push(`<span class="act-label">Commits</span>${sparkbars(commits, {end: Date.now(), unit: 'commit', cls: 'c'})}
      <span class="act-val" title="commits on the default branch in the last 12 months">${fmtN(total)}<small> / yr</small></span>`);
  }
  const empty = Array(ACTIVITY_BUCKETS).fill(null);
  if (curve?.pts) {
    const pts = curve.pts, total = Math.max(pts.at(-1)[1], r.stars ?? r.stargazers_count ?? 0);
    rows.push(`<span class="act-label">Stars</span>${starTimeline(pts)}
      <span class="act-val" title="${fmtN(total)} stars since ${day(pts[0][0])} ${new Date(pts[0][0]).getFullYear()} (full history from star-history.com)">${fmtN(total)}<small> since ${new Date(pts[0][0]).getFullYear()}</small></span>`);
  } else if (!curve && full) {   // not loaded yet: same frame, filled in when star-history.com answers
    rows.push(`<span class="act-label">Stars</span>${sparkbars(empty, {end: Date.now(), unit: 'new star', cls: 's'})}
      <span class="act-val muted"><small>loading…</small></span>`);
  } else {
    const gains = starGains(hist);   // fallback: this app's own daily samples
    if (gains) {
      const since = hist[0][0], gained = hist.at(-1)[1] - hist[0][1];
      rows.push(`<span class="act-label">Stars</span>${sparkbars(gains, {end: Date.now(), unit: 'new star', cls: 's'})}
        <span class="act-val" title="stars gained since ${day(since)} (recorded by this app)">${gained >= 0 ? '+' : ''}${fmtN(gained)}<small> since ${day(since)}</small></span>`);
    } else if (hist?.length) {
      rows.push(`<span class="act-label">Stars</span>${sparkbars(empty, {end: Date.now(), unit: 'new star', cls: 's'})}
        <span class="act-val" title="no star history available; recording daily star counts since ${day(hist[0][0])}">${fmtN(hist.at(-1)[1])}<small> ★</small></span>`);
    }
  }
  if (!rows.length) return '';
  return `<div class="activity"${full ? ` data-sh="${esc(full)}"` : ''} title="last 12 months, per 2 weeks">${rows.join('')}</div>`;
}

/** Redraws every visible activity block of a repo (called when its star history arrives). */
function refreshActivity(k) {
  const r = shown.get(k);
  if (!r) return;
  for (const el of document.querySelectorAll('.activity[data-sh]')) if (el.dataset.sh.toLowerCase() === k) el.outerHTML = activityHTML(r);
}

/** GitHub-style language breakdown: a colored bar plus every language with its share, largest first.
 *  Takes anything with a `langs` array ([[name, percent, color], …]): starred repos (filled in by checks with a token)
 *  and suggestion cards (filled in by discover.js). */
export function languagesHTML(r) {
  if (!r.langs?.length) return '';
  const color = c => /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#8b949e';   // only real hex colors reach the style attribute
  const pct = p => p >= 0.1 ? p + '%' : '&lt;0.1%';
  return `<div class="langs">
    <div class="langbar">${r.langs.filter(([, p]) => p >= 0.1).map(([n, p, c]) => `<i style="width:${p}%;background:${color(c)}" title="${esc(n)} ${p}%"></i>`).join('')}</div>
    <div class="langlist">${r.langs.map(([n, p, c]) => `<span><b style="background:${color(c)}"></b>${esc(n)} <span class="muted">${pct(p)}</span></span>`).join('')}</div>
  </div>`;
}

/** Compact external views shared by starred and suggested repo cards. GitHistory animates one file, so use the
 * cached README path when available and fall back to the usual README.md name. */
function viewerLinks(r) {
  const full = r.full.split('/').map(encodeURIComponent).join('/');
  const branch = encodeURIComponent(r.branch || 'HEAD');
  const path = (readmeEntry(r)?.path || 'README.md').split('/').map(encodeURIComponent).join('/');
  const links = [
    ['Diagram', `https://gitdiagram.com/${full}`, 'GitDiagram: repository architecture diagram'],
    ['Wiki', `https://deepwiki.com/${full}`, 'DeepWiki: generated repository documentation'],
    ['Ingest', `https://gitingest.com/${full}`, 'GitIngest: repository text for an LLM'],
    ['UIthub', `https://uithub.com/${full}`, 'UIthub: repository context viewer'],
    ['Code', `https://github.dev/${full}`, 'github.dev: browse code in VS Code'],
    ['History', `https://github.githistory.xyz/${full}/blob/${branch}/${path}`, 'GitHistory: animate the README file history'],
  ];
  return `<nav class="repo-viewers" aria-label="Other views of ${esc(r.full)}">${links.map(([label, url, title]) =>
    `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${label}</a>`).join('')}</nav>`;
}

/** "🕒 last commit 3d ago" (head of the default branch). Without that date the repo's last push is shown and called
 *  a push: a push can be a tag or another branch, months after the last commit. */
export function lastCommitTile(r) {
  if (r.commitAt) return `<span class="lastcommit" title="Last commit on the default branch: ${esc(when(r.commitAt))}">🕒 last commit ${ago(r.commitAt)}</span>`;
  if (r.pushed) return `<span class="lastcommit muted" title="Last push: ${esc(when(r.pushed))}. The exact last commit date is fetched with a token (🕒 Refresh tiles).">🕒 last push ${ago(r.pushed)}</span>`;
  return '';
}

/** "🏷 last release v1.2 · 3mo ago": the newest release by date, pre-releases included (flagged). A repo without any
 *  says so; one not fetched yet shows a dash on starred cards. */
export function lastReleaseTile(r, suggestion = false) {
  if (r.release) {
    const pre = r.releasePre ? ' <span class="pre">pre-release</span>' : '';
    const latest = r.releaseLatest ? ` GitHub's “Latest” release is ${r.releaseLatest}.` : '';
    return `<span class="lastrelease" title="${esc(`Newest release by date: ${r.release}, published ${when(r.releaseAt)}.${latest}`)}">🏷 last release ${esc(r.release)}${pre} · ${ago(r.releaseAt)}</span>`;
  }
  if (r.release === null) return '<span class="lastrelease muted" title="This repository has no published releases">🏷 no releases</span>';
  return suggestion ? '' : '<span class="lastrelease muted" title="Not fetched yet: click 🕒 Refresh tiles (needs a token)">🏷 last release —</span>';
}

/** One search-hit line: README text, or a commit / release note linking to it on GitHub. */
function snipHTML(r, s, re) {
  let label = esc(s.kind);
  if (s.id && r.url) {
    const href = s.kind === 'Commit' ? `${r.url}/commit/${s.id}` : s.kind === 'File' ? `${r.url}/blob/${encodeURIComponent(fileRec(r)?.branch || 'HEAD')}/${s.id.split('/').map(encodeURIComponent).join('/')}`
      : `${r.url}/releases/tag/${encodeURIComponent(s.id)}`;
    label = `<a href="${esc(safeUrl(href))}" target="_blank" rel="noopener" title="Open on GitHub">${label} ${esc(s.id)}</a>`;
  }
  return `<div class="snip"><b>${label}</b>${s.when ? ` <span class="muted">${esc(s.when)}</span>` : ''}: …${hl(s.text, re)}…</div>`;
}

/** "🔎 1,204 commits · 3 releases" once commit messages / release notes are indexed for this repo. */
function historyBadge(r) {
  const h = S.history[rkey(r)], nc = h?.c?.length || 0, nr = h?.rel?.length || 0;   // a record may lack either list
  if (!nc && !nr) return '';
  const part = [nc ? `${nc.toLocaleString()}${h.done ? '' : '+'} commits` : '', nr ? `${nr} release${nr === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  const note = !nc ? '' : h.capped ? ` (only the newest ${nc.toLocaleString()} commits)` : h.done ? '' : ' (commits still being pulled)';
  return `<span title="Searchable with “Search in: Commits / Releases”${note}">🔎 ${part}</span>`;
}

/** "📁 1,204 files · 🔌 12 · 🧊 4 · PlatformIO": what the file list says, each kind clickable (filters by it). */
function filesBadge(r) {
  const rec = fileRec(r), f = summaryOf(rec);
  if (!f) return '';
  if (rec.miss) return `<span class="muted" title="GitHub has no file tree for it (HTTP ${rec.miss}: an empty repository)">📁 empty</span>`;
  const tree = `${r.url}/tree/${encodeURIComponent(rec.branch || 'HEAD')}`;
  const exts = f.ext.slice(0, 8).map(([e, c]) => `.${e} ${c.toLocaleString()}`).join(', ');
  const kinds = Object.entries(f.kinds).sort((a, b) => b[1] - a[1]).map(([k, c]) =>
    `<span class="chip fk" tabindex="0" role="button" data-kind="${esc(k)}" title="${esc(kindLabel(k))}: ${c.toLocaleString()} file(s), e.g. ${esc((f.ex[k] || []).join(', '))}. Click to show every repo with such files">${kindIcon(k)} ${c.toLocaleString()}</span>`).join('');
  const build = f.build.length ? `<span class="muted" title="Build systems and platforms found from their marker files">${esc(f.build.slice(0, 4).join(' · '))}</span>` : '';
  return `<a href="${esc(safeUrl(tree))}" target="_blank" rel="noopener" title="${rec.n.toLocaleString()} files${rec.cut || (rec.trunc && !rec.walked) ? ' (incomplete, from an older version: completed at the next 📁 Files pull)' : ''}. Most common: ${esc(exts)}. Open the file tree on GitHub">📁 ${rec.n.toLocaleString()} files</a>${kinds}${build}`;
}

/** At most 8 topics; when there are more, the ones matching the active topic filter or the search come first. */
function pickTopics(topics, re) {
  if (topics.length <= 8) return topics;
  const test = re && new RegExp(re.source, 'i');   // a copy without the "g" flag, whose .test() would remember a position
  const rank = t => t === filters.topic || (test && test.test(t)) ? 1 : 0;
  return [...topics].sort((a, b) => rank(b) - rank(a)).slice(0, 8);
}

/** While visiting someone: mark what you already starred, and let you star the rest from here. */
function visitStar(r) {
  if (!S.visit || r.gone) return '';
  const mine = isMine(r);
  return mine === true ? '<span class="mine" title="You already starred this repository">★ starred by you</span>'
    : mine === false ? `<button class="starbtn" data-vstar="${esc(r.full)}" title="Star on GitHub, on your own account">☆ Star</button>`
    : '<span class="muted small" title="Reading your own stars to compare…">…</span>';
}

/** The ☆ Star button of a visited repo: stars it for the token's owner, who must be you (S.home). */
async function starVisited(full, btn) {
  if (!S.token) { needToken(); return status('⚠ Starring needs a token. See the 🔑 panel.'); }
  btn.disabled = true;
  btn.textContent = 'Starring…';
  try {
    const me = await whoAmI();
    if (S.home && me.toLowerCase() !== S.home.toLowerCase()) throw new Error(`Your token belongs to ${me}, but your profile is ${S.home}.`);
    const code = await setStar(full, true);
    if (code === 403 || code === 404) { needToken(); throw new Error('Your token can read but not star. Grant "Starring: Read and write" (fine-grained) or "public_repo" (classic) in the 🔑 panel.'); }
    if (code >= 300) throw new Error('GitHub ' + code);
    const repo = S.repos.find(r => r.full.toLowerCase() === full.toLowerCase());
    if (S.mine) { S.mine.names.add(full.toLowerCase()); if (repo?.id != null) S.mine.ids.add(repo.id); }
    info('stars', `★ ${full} starred from ${S.visit}'s list (GitHub answered ${code}); it joins your own list the next time it is loaded`);
    status(`★ Starred ${full} on GitHub. It joins your stars the next time your own list is loaded.`);
    window.dispatchEvent(new CustomEvent('mine-changed'));   // main.js redraws the banner and the tiles
  } catch (e) {
    status('⚠ ' + e.message);
    btn.disabled = false;
    btn.textContent = '☆ Star';
  }
}

/** "⧉ hidden fork of a/b" (with its evidence and a "not a copy" button) on a copy; "⧉ 2 hidden forks" on an original.
 *  Both open the family: the original and its copies. */
function forkTags(r) {
  const h = hiddenFork(r), cs = copiesOf(r);
  const via = h && h.root !== h.of ? ` ${h.of.full} is itself a copy of ${h.root.full}.` : '';
  if (h) return ` <span class="chip hfork-tag" tabindex="0" role="button" data-family="${esc(rkey(h.root))}" title="${esc(`Probably copied from ${h.of.full} without GitHub marking it as a fork: ${h.why.join(', ')}.${via} Click to see the whole family.`)}">⧉ hidden fork of ${esc(h.of.full)}</span>` +
    `<button class="linkish notcopy" data-notcopy="${esc(rkey(r))}" title="${esc(`Not a copy of ${h.of.full}: don't report this pair again`)}">not a copy?</button>`;
  return cs.length ? ` <span class="chip hfork-tag" tabindex="0" role="button" data-family="${esc(rkey(r))}" title="${esc(`Copied without GitHub marking them as forks: ${cs.map(c => c.full).join(', ')}. Click to see them.`)}">⧉ ${cs.length} hidden fork${cs.length === 1 ? '' : 's'}</span>` : '';
}

/** Shared card layout. Discovery passes a normalized repo plus reasons and actions. */
export function card(r, {snips = [], re = null, suggestion = false, reasons = []} = {}) {
  const avatar = r.avatar ? `${r.avatar}${r.avatar.includes('?') ? '&' : '?'}s=36` : '';
  const home = safeUrl(r.homepage);
  const license = r.license && r.license !== 'NOASSERTION' ? `<span>${esc(r.license)}</span>` : '';
  const tag = suggestion ? 'li' : 'div';
  const shownTopics = pickTopics(r.topics || [], re);
  return `<${tag} class="card${suggestion ? ' suggestion-card' : ''}${r.gone ? ' gone' : ''}">
    <div class="owner">${avatar ? `<img src="${esc(avatar)}" loading="lazy" alt="">` : ''}<span class="chip" tabindex="0" role="button" data-owner="${esc(r.owner)}">${hl(r.owner, re)}</span>${r.archived ? ' · archived' : ''}${r.fork ? ' · fork' : ''}${suggestion ? '' : forkTags(r)}${r.gone ? ' <span class="chip gone-tag" tabindex="0" role="button" data-gone="1" title="Deleted, made private or hidden on GitHub. Click to see all such repos">🚫 removed / private</span>' : ''}</div>
    <a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener">${hl(r.name, re)}</a>
    ${r.gone ? `<div class="gone-note" title="GitHub no longer shows this repository: it was deleted, made private or hidden. You still starred it, so this local copy is kept. It is not updated any more.">🚫 Removed, private or hidden on GitHub · local copy from ${esc(ago(r.gone.at))}</div>` : ''}
    <p class="desc">${r.about ? hl(r.about, re) : '<span class="muted">No description</span>'}</p>
    ${snips.map(s => snipHTML(r, s, re)).join('')}
    <div class="chips">${shownTopics.map(t => `<span class="chip" tabindex="0" role="button" data-topic="${esc(t)}">${hl(t, re)}</span>`).join('')}</div>
    <div class="meta">
      <span>★ ${fmtN(r.stars)}</span>${r.forks != null ? `<span>⑂ ${fmtN(r.forks)}</span>` : ''}${r.issues != null ? `<span title="Open issues and pull requests">◉ ${fmtN(r.issues)} open</span>` : ''}${r.lang ? `<span class="chip" tabindex="0" role="button" data-lang="${esc(r.lang)}">● ${esc(r.lang)}</span>` : ''}${license}
      ${lastCommitTile(r)}
      ${historyBadge(r)}
      ${lastReleaseTile(r, suggestion)}
      ${suggestion ? '' : filesBadge(r)}
      ${r.created ? `<span title="Created ${esc(when(r.created))}">created ${ago(r.created)}</span>` : ''}
      ${r.starred ? `<span title="${esc(r.starred)}">starred ${ago(r.starred)}</span>` : ''}
      ${home ? `<a href="${esc(home)}" target="_blank" rel="noopener">site ↗</a>` : ''}
    </div>
    ${activityHTML(r)}${languagesHTML(r)}${viewerLinks(r)}
    ${suggestion ? `<div class="chips reasons">${reasons.slice(0, 5).map(reason => `<span class="why">${esc(reason)}</span>`).join('')}</div>
      <div class="suggestion-actions"><button class="starbtn" data-star="${esc(r.full)}" title="Star on GitHub">☆ Star</button>
      <button class="x" data-dismiss="${esc(r.full.toLowerCase())}" title="Never suggest this repo again">✕ Not interested</button></div>`
      : `<div class="suggestion-actions"><button class="similar" data-similar="${esc(rkey(r))}" title="Find repos related to this one that you haven't starred">✨ Show suggestions</button>${visitStar(r)}</div>`}
  </${tag}>`;
}

/** Shows only the repos GitHub no longer shows (deleted, private, hidden), or all again. */
export function showOnlyRemoved(on) { filters.gone = !!on; info('list', on ? 'showing only the repos that were removed, made private or hidden on GitHub' : 'showing all repos again'); limit = PAGE; render(); }

/** Resets active facet filters and pagination when switching GitHub users. */
export function resetFilters() {
  filters.lang = filters.topic = filters.owner = null;
  filters.gone = false;
  filters.family = filters.kind = null;
  limit = PAGE;
  shown.clear();
}

// What the list on screen was rendered from: the matches in order ({r, snips}) and the highlight. "Show more" adds the
// next cards from it instead of searching and drawing the whole list again; export downloads it.
let shownMatches = [], shownRe = null;

/** The "Show more (N left)" button under the list, hidden when every match is on screen. */
function moreButton() {
  const left = shownMatches.length - limit, more = $('#more');
  more.hidden = left <= 0;
  if (left > 0) more.textContent = `Show more (${left} left)`;
}

/** Appends the next PAGE cards of the matches already on screen. */
function showMore() {
  if ($('#more').hidden) return;
  const from = limit;
  limit += PAGE;
  $('#list').insertAdjacentHTML('beforeend', shownMatches.slice(from, limit).map(x => card(x.r, {snips: x.snips, re: shownRe})).join(''));
  moreButton();
  watchStarCharts($('#list'));
}

export function render() {
  const t0 = performance.now();
  const rawQ = $('#q').value;
  const q = parseQuery(rawQ);
  const re = q.inc.length ? new RegExp(q.inc.map(escRe).join('|'), 'gi') : null;
  const inReadme = $('#inReadme').checked, inHistory = searchParts(), inFiles = $('#inFiles').checked;

  const out = [], forLang = [], forTopic = [], forOwner = [];
  scheduleForkScan();   // finds hidden forks in the background when the repos, READMEs or commit index changed
  const family = filters.family ? S.repos.find(r => rkey(r) === filters.family) : null;
  if (!family) filters.family = null;
  for (const r of S.repos) {
    if (family) { if (r !== family && rkey(hiddenFork(r)?.root ?? {}) !== filters.family) continue; }   // a family (an original and every copy down its chain) is shown whole, whatever the Forks choice
    else if (!forkVisible(r)) continue;
    if (filters.gone && !r.gone) continue;   // "🚫 removed or hidden": only the repos kept as a local copy
    if (filters.kind && !hasFileKind(r, filters.kind)) continue;   // a "File kinds" row of the sidebar
    if (S.visit && S.onlyNew && isMine(r) === true) continue;   // visiting: only what you have not starred yet
    const okLang = !filters.lang || r.lang === filters.lang;
    const okTopic = !filters.topic || r.topics.includes(filters.topic);
    const okOwner = !filters.owner || r.owner === filters.owner;
    if (okLang + okTopic + okOwner < 2) continue;
    const m = match(r, q, inReadme, inHistory, inFiles);
    if (!m) continue;
    if (okTopic && okOwner) forLang.push(r);
    if (okLang && okOwner) forTopic.push(r);
    if (okLang && okTopic) forOwner.push(r);
    if (okLang && okTopic && okOwner) out.push({r, snips: m.snips});
  }
  sortRepos(out, $('#sort').value, 'name');
  shownMatches = out;
  shownRe = re;

  const pills = [['lang', 'Language'], ['topic', 'Topic'], ['owner', 'Owner']]
    .filter(([k]) => filters[k])
    .map(([k, label]) => `<button class="chip filter-pill" data-${k}="${esc(filters[k])}" title="Remove ${label.toLowerCase()} filter">${label}: ${esc(filters[k])} ✕</button>`);
  if (filters.gone) pills.push('<button class="chip filter-pill" data-gone="1" title="Show all repos again">Status: removed or hidden ✕</button>');
  if (filters.kind) pills.push(`<button class="chip filter-pill" data-kind="${esc(filters.kind)}" title="Show all repos again">Files: ${esc(kindName(filters.kind))} ✕</button>`);
  if (family) pills.push(`<button class="chip filter-pill" data-family="${esc(filters.family)}" title="Show all repos again">${esc(family.full)} and its hidden forks ✕</button>`);
  const nGone = S.repos.filter(r => r.gone).length;
  const goneChip = nGone && !filters.gone ? `<button class="chip gone-chip" data-gone="1" title="Show only the repos that were deleted, made private or hidden on GitHub (kept here as a local copy). Search: is:removed">🚫 ${nGone} removed or hidden</button>` : '';
  const filtered = S.forkMode !== 'all' || (S.visit && S.onlyNew) || pills.length > 0 || q.hasQuery;
  forkCounts();
  const exportBtns = out.length ? `<span class="export-actions"><button class="clear-filters" data-export="md" title="Export shown repos as Markdown">⬇ .md</button><button class="clear-filters" data-export="json" title="Export shown repos as JSON">⬇ .json</button></span>` : '';
  $('#count').innerHTML = `<span>${out.length} of ${S.repos.length} repos${filtered ? ' (filtered)' : ''}</span>` + (goneChip ? ' ' + goneChip : '') +
    (pills.length ? ` <span class="active-filters">${pills.join('')}<button class="clear-filters" data-clear-filters title="Clear active filters">Clear</button></span>` : '') + exportBtns;
  $('#list').innerHTML = out.slice(0, limit).map(x => card(x.r, {snips: x.snips, re})).join('');
  moreButton();
  indexCounts();
  debug('list', `showing ${Math.min(out.length, limit)} of ${out.length} matches (${S.repos.length.toLocaleString()} repos) in ${Math.round(performance.now() - t0)} ms · sort ${$('#sort').value || 'default'}${rawQ.trim() ? ' · search “' + rawQ.trim() + '”' + (inReadme ? ' + READMEs' : '') + (inHistory ? ' + ' + {rc: 'commits & releases', c: 'commits', r: 'releases'}[inHistory] : '') + (inFiles ? ' + file names' : '') : ''}${filters.kind ? ' · files: ' + filters.kind : ''}${filters.lang ? ' · language ' + filters.lang : ''}${filters.topic ? ' · topic ' + filters.topic : ''}${filters.owner ? ' · owner ' + filters.owner : ''}${filters.gone ? ' · only removed/hidden' : ''}${S.forkMode !== 'all' ? ' · forks: ' + S.forkMode : ''}${family ? ' · family of ' + family.full : ''}`);
  renderFacets({forLang, forTopic, forOwner}, `${rawQ.trim().toLowerCase()}\0${inReadme ? 1 : 0}${inHistory}${inFiles ? 'f' : ''}`);
  watchStarCharts($('#list'));
}

/** Counts in the Forks menu: "Only forks (12)", "Only hidden forks (3)". */
let forkCountsFor = null;
function forkCounts() {
  const sel = $('#forkMode');
  if (!sel?.options) return;
  const nFork = S.repos.filter(r => r.fork).length, nHidden = S.repos.filter(r => forkKind(r) === 'hidden').length, key = nFork + ',' + nHidden;
  if (forkCountsFor === key) return;
  forkCountsFor = key;
  const n = {hide: nFork, only: nFork, hideHidden: nHidden, onlyHidden: nHidden, hideAll: nFork + nHidden, onlyAll: nFork + nHidden};
  for (const o of sel.options) { const label = FORK_MODES.find(([m]) => m === o.value)?.[1]; if (label) o.textContent = label + (o.value in n ? ` (${n[o.value].toLocaleString()})` : ''); }
}

/** "(1,512)" / "(800/1,512)" next to the search-in checkboxes: how much of your stars is searchable there. */
let countsFor = null;
function indexCounts() {
  const key = [S.repos, S.indexVer];
  if (countsFor && key.every((v, i) => v === countsFor[i])) return;
  countsFor = key;
  const total = S.repos.length, n = x => x.toLocaleString();
  const readmes = S.repos.filter(r => readmeText(r)).length;
  let commits = 0, done = 0, releases = 0;
  for (const r of S.repos) {
    const h = S.history[rkey(r)];
    if (!h) continue;
    if (commitsPulled(h)) { commits++; if (h.done) done++; }
    if (releasesPulled(h)) releases++;
  }
  const set = (id, text, title) => { const el = $(id); if (el) { el.textContent = text; el.title = title; } };
  set('#cntReadme', readmes ? `(${n(readmes)})` : '', `${n(readmes)} of ${n(total)} READMEs are indexed`);
  set('#cntCommits', commits ? `(${done === total ? n(total) : `${n(done)}/${n(total)}`})` : '', `Commit messages: ${n(done)} of ${n(total)} repos complete, ${n(commits - done)} partial`);
  const files = S.repos.filter(r => fileRec(r)).length;
  set('#cntFiles', files ? `(${files === total ? n(total) : `${n(files)}/${n(total)}`})` : '', `File lists pulled for ${n(files)} of ${n(total)} repos`);
  set('#cntReleases', releases ? `(${releases === total ? n(total) : `${n(releases)}/${n(total)}`})` : '', `Release notes pulled for ${n(releases)} of ${n(total)} repos`);
}

/** "🔌 PCB & schematic sources", or "🔧 Embedded firmware" for the build-system kind. */
const kindName = k => k === 'firmware' ? '🔧 Embedded firmware' : kindLabel(k);
/** The sidebar's "File kinds": how many of your stars hold each kind of file (once file lists are pulled). Click to
 *  show only those, again to show everything. */
function fileKindsBlock() {
  const lists = S.repos.map(filesOf).filter(Boolean);
  if (!lists.length && !filters.kind) return '';
  const counts = KINDS.map(([k]) => [k, lists.filter(f => f.kinds[k]).length]);
  counts.splice(4, 0, ['firmware', lists.filter(f => f.build.some(b => EMBEDDED.has(b))).length]);
  const rows = counts.filter(([k, c]) => c || filters.kind === k).map(([k, c]) =>
    `<div class="facet ${filters.kind === k ? 'on' : ''}" tabindex="0" role="button" data-kind="${esc(k)}" title="${esc(k === 'firmware' ? 'ESP-IDF, PlatformIO, Arduino, Zephyr, Rust embedded, MicroPython, STM32Cube projects' : kindHelp(k))} · search: has:${esc(k)}"><span>${esc(kindName(k))}</span><span class="muted">${c}</span></div>`);
  return `<h3 title="From the file lists (📁 Files): ${lists.length.toLocaleString()} of ${S.repos.length.toLocaleString()} repos listed">File kinds</h3>${rows.join('') || '<div class="muted small">No special files found</div>'}`;
}

// Each facet group is cross-filtered by the active search and the other two facets, so counts reflect real matches.
let facetsKey = null;
function renderFacets({forLang, forTopic, forOwner}, queryKey) {
  const k = [S.repos, S.forkMode, filters.lang, filters.topic, filters.owner, filters.gone, filters.family, filters.kind, queryKey, S.indexVer, hiddenVer];   // indexVer: README / history text changed · hiddenVer: a fork scan changed its result
  if (facetsKey && k.every((v, i) => v === facetsKey[i])) return;
  facetsKey = k;
  const row = (kind, active, [v, c]) =>
    `<div class="facet ${active === v ? 'on' : ''}" tabindex="0" role="button" data-${kind}="${esc(v)}"><span title="${esc(v)}">${esc(v)}</span><span class="muted">${c}</span></div>`;
  const block = (title, kind, list, n) => {
    const top = list.slice(0, n), rest = list.slice(n), active = filters[kind];
    if (active && !top.some(([v]) => v === active)) {
      const hit = list.find(([v]) => v === active);
      top.unshift([active, hit ? hit[1] : 0]);
    }
    const more = rest.filter(([v]) => v !== active);
    return `<h3>${title}</h3>` + top.map(x => row(kind, active, x)).join('') +
      (more.length ? `<details><summary class="small">Show ${more.length} more</summary>${more.map(x => row(kind, active, x)).join('')}</details>` : '');
  };
  const nGone = S.repos.filter(r => r.gone).length;   // the Status block exists only when there is something to show
  const gone = nGone || filters.gone ? `<div class="facet ${filters.gone ? 'on' : ''}" tabindex="0" role="button" data-gone="1" title="Repos that were deleted, made private or hidden on GitHub: your local copy is kept"><span>🚫 Removed or hidden</span><span class="muted">${nGone}</span></div>` : '';
  // Forks: click to show only that kind (the toolbar's Forks menu), again to show everything.
  const nFork = S.repos.filter(r => r.fork).length, nHidden = S.repos.filter(r => forkKind(r) === 'hidden').length;
  const forkRow = (mode, label, c, title) => c || S.forkMode === mode ? `<div class="facet ${S.forkMode === mode ? 'on' : ''}" tabindex="0" role="button" data-forkmode="${mode}" title="${title}"><span>${label}</span><span class="muted">${c}</span></div>` : '';
  const forks = forkRow('only', '⑂ Forks', nFork, 'Repos GitHub marks as forks') +
    forkRow('onlyHidden', '⧉ Hidden forks', nHidden, 'Copies of another of your stars that GitHub does not mark as forks (same commits, README, description or name)');
  const status = gone || forks ? `<h3>Status</h3>${gone}${forks}` : '';
  $('#facets').innerHTML = status + fileKindsBlock() + block('Languages', 'lang', tally(forLang, r => r.lang), 15) +
    block('Topics', 'topic', tally(forTopic, r => r.topics), 30) +
    block('Owners', 'owner', tally(forOwner, r => r.owner).filter(([v, c]) => c > 1 || v === filters.owner), 15);
}

// Bookkeeping of this app that the JSON export leaves out: check dates, daily star samples (up to 400 per repo) and the
// commit-chart buckets.
const NOT_EXPORTED = new Set(['starHist', 'activity', 'enrichedAt', 'enrichedPushed']);

/** The text of an export: repos as JSON, or as a Markdown list. */
export function exportText(repos, fmt, user) {
  const oneLine = s => String(s).replace(/\s+/g, ' ').trim();   // a description with line breaks would end its list item
  return fmt === 'json'
    ? JSON.stringify(repos.map(r => hiddenFork(r) ? {...r, hiddenForkOf: hiddenFork(r).of.full} : r), (k, v) => NOT_EXPORTED.has(k) ? undefined : v, 2)
    : `# ★ ${user}'s Starred Repositories (${repos.length})\n\n` +
      repos.map(r => `- **[${r.full}](${r.url})** (★ ${fmtN(r.stars)}${r.lang ? ` · ${r.lang}` : ''})${r.about ? ` — ${oneLine(r.about)}` : ''}${r.fork ? ' (fork)' : hiddenFork(r) ? ` (hidden fork of ${hiddenFork(r).of.full})` : ''}`).join('\n') + '\n';
}

/** Downloads the currently shown (filtered and sorted) repositories as Markdown or JSON. */
function exportMatches(fmt) {
  const repos = shownMatches.map(x => x.r);
  if (!repos.length) return;
  const user = S.user || 'github', body = exportText(repos, fmt, user);
  info('export', `${repos.length.toLocaleString()} repos exported as ${fmt === 'json' ? 'JSON' : 'Markdown'} (${body.length.toLocaleString()} characters)`);
  const url = URL.createObjectURL(new Blob([body], {type: fmt === 'json' ? 'application/json' : 'text/markdown;charset=utf-8'}));
  const a = Object.assign(document.createElement('a'), {href: url, download: `stars-${user.toLowerCase()}.${fmt}`});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);   // revoking at once can cancel the download in some browsers
}

/** Before the first search over commit messages / release notes: builds their search text without freezing the page. */
/** The "Search in" checkboxes for commits and releases, as a partsKey ('rc', 'c', 'r' or ''). */
export const searchParts = () => partsKey($('#inCommits').checked, $('#inReleases').checked);

export async function prepareHistorySearch() {
  const which = searchParts();
  if (!which) return;
  const msg = `Preparing the ${{rc: 'commit & release', c: 'commit', r: 'release'}[which]} search…`;
  status(msg);
  await warmHistoryIndex(S.repos, which);
  if ($('#status').textContent === msg) status('');
}

/** Puts a query in the search box (with README search on) and shows the matches. */
export async function searchFor(q) {
  $('#q').value = q;
  $('#inReadme').checked = true;
  if (Object.keys(S.history).length) {
    const {commits, releases} = indexedParts();
    if (commits) $('#inCommits').checked = true;
    if (releases) $('#inReleases').checked = true;
    await prepareHistorySearch();
  }
  limit = PAGE; render();
  $('#q').scrollIntoView({block: 'nearest'});
}

const FACETS_PREF = 'starsViewer.hideFacets';   // localStorage: sidebar hidden?
const FORK_PREF = 'starsViewer.forkMode';
let hiddenVer = 0;

/** The Forks menu changed (or a Status row of the sidebar was clicked). */
function applyForkMode(mode) {
  setForkMode(mode);
  $('#forkMode').value = S.forkMode;
  try { localStorage.setItem(FORK_PREF, S.forkMode); localStorage.removeItem('starsViewer.hideForks'); } catch {}
  filters.family = null;
  limit = PAGE;
  render();
  window.dispatchEvent(new CustomEvent('fork-filter-change'));
}
const SORT_PREF = 'starsViewer.sort';
function setFacetsHidden(hide, save = true) {
  document.querySelector('main').classList.toggle('nofacets', hide);
  const b = $('#toggleFacets');
  b.textContent = hide ? '◧ Show filters' : '◧ Hide filters';
  b.setAttribute('aria-expanded', String(!hide));
  if (save) try { localStorage.setItem(FACETS_PREF, hide ? '1' : '0'); } catch {}
}

/** After "Clear cache" erased the stored preferences: the toolbar shows the defaults again (nothing is saved back). */
export function resetListPrefs() {
  setForkMode('all');
  resetForks();   // the "not a copy" choices were preferences too
  $('#forkMode').value = 'all';
  $('#sort').value = 'starred';
  $('#inReadme').checked = $('#inCommits').checked = $('#inReleases').checked = $('#inFiles').checked = false;   // the indexes they search are gone too
  setFacetsHidden(false, false);
  limit = PAGE;
}

export function initList() {
  // One list of sort choices for the toolbar and for Discover (sort.js); "Best match" only makes sense for suggestions.
  $('#sort').innerHTML = SORT_OPTIONS.filter(([key]) => key !== 'relevance').map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
  // Forks: one menu for both kinds. Earlier versions had a "Hide forks" checkbox; its choice is carried over.
  $('#forkMode').innerHTML = FORK_MODES.map(([m, label]) => `<option value="${m}">${esc(label)}</option>`).join('');
  let mode = 'all';
  try { mode = localStorage.getItem(FORK_PREF) || (localStorage.getItem('starsViewer.hideForks') === '1' ? 'hide' : 'all'); } catch {}
  setForkMode(mode);
  $('#forkMode').value = S.forkMode;
  $('#forkMode').onchange = e => applyForkMode(e.target.value);
  window.addEventListener('hidden-forks', () => { hiddenVer++; render(); window.dispatchEvent(new CustomEvent('fork-filter-change')); });   // forks.js finished a scan with a different result
  try {
    const savedSort = localStorage.getItem(SORT_PREF);
    if (savedSort && [...$('#sort').options].some(o => o.value === savedSort)) $('#sort').value = savedSort;
  } catch {}
  let hidden = false;
  try { hidden = localStorage.getItem(FACETS_PREF) === '1'; } catch {}
  setFacetsHidden(hidden);
  $('#toggleFacets').onclick = () => setFacetsHidden(!document.querySelector('main').classList.contains('nofacets'));
  window.addEventListener('star-curve', e => refreshActivity(e.detail));
  // A user's row in the Users panel (users.js): show only their repos. The other facets are cleared so the list matches the number clicked.
  window.addEventListener('filter-owner', e => {
    filters.lang = filters.topic = null;
    filters.owner = e.detail;
    limit = PAGE; render();
    document.querySelector('main').scrollIntoView({block: 'start', behavior: 'smooth'});
  });
  let timer;
  // Searching commit messages scans far more text than the card fields, so it waits a little longer after each keystroke.
  $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { limit = PAGE; render(); }, searchParts() ? 300 : 120); };
  $('#q').onkeydown = e => {
    if (e.key === 'Escape') {
      if ($('#q').value) { clearTimeout(timer); $('#q').value = ''; limit = PAGE; render(); }
      else $('#q').blur();
    }
  };
  $('#sort').onchange = () => {
    try { localStorage.setItem(SORT_PREF, $('#sort').value); } catch {}
    limit = PAGE;
    render();
  };
  $('#inReadme').onchange = $('#inFiles').onchange = () => { limit = PAGE; render(); };
  for (const id of ['#inCommits', '#inReleases']) $(id).onchange = async e => { if (e.target.checked) await prepareHistorySearch(); limit = PAGE; render(); };
  $('#more').onclick = showMore;
  // Infinite scroll: when the button comes near the viewport, load the next step automatically.
  if (typeof IntersectionObserver !== 'undefined')
    new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) showMore(); }, {rootMargin: '600px'}).observe($('#more'));
  // "✨ Show suggestions" on a card: discover.js listens (an event keeps list.js independent of discover.js).
  $('#list').addEventListener('click', e => {
    const b = e.target.closest('[data-similar]');
    if (b) window.dispatchEvent(new CustomEvent('suggest-for', {detail: b.dataset.similar}));
    const star = e.target.closest('[data-vstar]');
    if (star) starVisited(star.dataset.vstar, star);
  });
  // Facet, chip and export clicks (sidebar, filter bar and cards).
  document.addEventListener('click', e => {
    const exp = e.target.closest('[data-export]');
    if (exp) { exportMatches(exp.dataset.export); return; }
    if (e.target.closest('[data-gone]')) { showOnlyRemoved(!filters.gone); return; }   // the chip, the facet, the pill and the tag on a card all toggle it
    const nc = e.target.closest('#list [data-notcopy]');
    if (nc) { notACopy(nc.dataset.notcopy); return; }
    const fam = e.target.closest('#list [data-family], #count [data-family]');
    if (fam) { filters.family = filters.family === fam.dataset.family ? null : fam.dataset.family; limit = PAGE; render(); return; }
    const fk = e.target.closest('[data-kind]');
    if (fk) { filters.kind = filters.kind === fk.dataset.kind ? null : fk.dataset.kind; info('list', filters.kind ? `showing only repos with ${kindName(filters.kind)} files` : 'file-kind filter removed'); limit = PAGE; render(); return; }
    const fm = e.target.closest('#facets [data-forkmode]');
    if (fm) { applyForkMode(S.forkMode === fm.dataset.forkmode ? 'all' : fm.dataset.forkmode); return; }
    if (e.target.closest('[data-clear-filters]')) {
      filters.lang = filters.topic = filters.owner = filters.family = filters.kind = null;
      filters.gone = false;
      limit = PAGE; render();
      return;
    }
    const el = e.target.closest('#facets [data-lang], #facets [data-topic], #facets [data-owner], #count [data-lang], #count [data-topic], #count [data-owner], #list [data-lang], #list [data-topic], #list [data-owner]');
    if (!el) return;
    for (const k of ['lang', 'topic', 'owner']) if (el.dataset[k] !== undefined) filters[k] = filters[k] === el.dataset[k] ? null : el.dataset[k];
    limit = PAGE; render();
  });
  // "/" focuses the search box (unless typing in a field); Enter/Space activates role="button" elements.
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) { e.preventDefault(); $('#q').focus(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target?.getAttribute?.('role') === 'button' && e.target.id !== 'tpToggle') {
      e.preventDefault();
      e.target.click();
    }
  });
}
