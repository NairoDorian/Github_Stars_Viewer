/* The main list: search, facet filters, sorting, export and rendering of repo cards (also used for Discover suggestions).

   Search: every positive term must match the card fields (name, owner, about, topics, languages) or, when ticked, the
   READMEs or the commit messages / release notes; each term may match somewhere different. "exact phrase", -exclude and
   qualifiers (lang: owner: topic: is: stars:) are supported. Matches outside the card fields are explained by snippets. */
import {S, rkey, readmeEntry, readmeText, readmeLower, historyIndex, historyHit, warmHistoryIndex} from './state.js';
import {$, esc, escRe, fmtN, fmtDate, ago, when, safeUrl, tally, status} from './util.js';
import {activityNow, starGains, ACTIVITY_SPAN, ACTIVITY_BUCKETS} from './github.js';
import {drawableCurve, starsAt, watchStarCharts} from './starhistory.js';
import {sortRepos, SORT_OPTIONS} from './sort.js';

const PAGE = 200;   // cards rendered per step; more load automatically when you reach the end (or via Show more)
const filters = {lang: null, topic: null, owner: null};
let limit = PAGE;

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
  const inc = [], exc = [], quals = [], QK = /^(lang|language|owner|user|topic|tag|is|stars)$/;
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
  if (k === 'is') return v === 'archived' ? !!r.archived : v === 'active' ? !r.archived : v === 'fork' ? !!r.fork : null;
  if (k === 'stars') {   // GitHub's forms: stars:>1000, stars:>=1k, stars:10..500, stars:100..*, stars:*..50
    const s = r.stars ?? 0, range = v.split('..');
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
const inHistoryText = (r, t) => historyIndex(r)?.low.includes(t) ?? false;
const date = unix => unix ? fmtDate(unix * 1000, {dateStyle: 'medium'}) : '';
const around = (text, term) => {
  const j = Math.max(0, text.toLowerCase().indexOf(term)), a = Math.max(0, j - 80);
  return (a ? '…' : '') + text.slice(a, a + 220) + (a + 220 < text.length ? '…' : '');
};

/** Every positive term must match name/owner/about/topics/language (or the README / commit messages / release notes
 *  when those are enabled), with no excluded term matching anywhere that is enabled. Each term may match in a
 *  different place. Returns {snips} or null; snips explain the terms that matched only inside a README, a commit
 *  message or a release note (one line per source, newest commit / release first, at most MAX_SNIPS). */
export function match(r, q, inReadme, inHistory = false) {
  for (const qual of q.quals) { const ok = checkQual(r, qual); if (ok !== null && ok === qual.neg) return null; }
  for (const t of q.exc) if (hay(r).includes(t) || (inReadme && readmeLower(r).includes(t)) || (inHistory && inHistoryText(r, t))) return null;
  const snips = [];
  for (const t of q.inc) {
    if (hay(r).includes(t)) continue;
    const i = inReadme ? readmeLower(r).indexOf(t) : -1;
    if (i >= 0) {
      if (!snips.some(x => x.kind === 'README')) snips.push({kind: 'README', text: readmeText(r).slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' ')});
      continue;
    }
    const h = inHistory ? historyHit(r, t) : null;
    if (!h) return null;
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
const shown = new Map();   // lower-cased full name → repo object, so a card can be redrawn when its star history arrives
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
  if (r.pushed) return `<span class="lastcommit muted" title="Last push: ${esc(when(r.pushed))}. The exact last commit date is fetched with a token (Refresh latest tiles).">🕒 last push ${ago(r.pushed)}</span>`;
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
  return suggestion ? '' : '<span class="lastrelease muted" title="Not fetched yet: click Refresh latest tiles (needs a token)">🏷 last release —</span>';
}

/** One search-hit line: README text, or a commit / release note linking to it on GitHub. */
function snipHTML(r, s, re) {
  let label = esc(s.kind);
  if (s.id && r.url) {
    const href = s.kind === 'Commit' ? `${r.url}/commit/${s.id}` : `${r.url}/releases/tag/${encodeURIComponent(s.id)}`;
    label = `<a href="${esc(safeUrl(href))}" target="_blank" rel="noopener" title="Open on GitHub">${label} ${esc(s.id)}</a>`;
  }
  return `<div class="snip"><b>${label}</b>${s.when ? ` <span class="muted">${esc(s.when)}</span>` : ''}: …${hl(s.text, re)}…</div>`;
}

/** "🔎 1,204 commits · 3 releases" once commit messages / release notes are indexed for this repo. */
function historyBadge(r) {
  const h = S.history[rkey(r)], nc = h?.c?.length || 0, nr = h?.rel?.length || 0;   // a record may lack either list
  if (!nc && !nr) return '';
  const part = [nc ? `${nc.toLocaleString()}${h.done ? '' : '+'} commits` : '', nr ? `${nr} release${nr === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  const note = h.capped ? ` (only the newest ${nc.toLocaleString()} commits)` : h.done ? '' : ' (still being indexed)';
  return `<span title="Commit messages and release notes searchable with “Search in commits &amp; releases”${note}">🔎 ${part}</span>`;
}

/** At most 8 topics; when there are more, the ones matching the active topic filter or the search come first. */
function pickTopics(topics, re) {
  if (topics.length <= 8) return topics;
  const test = re && new RegExp(re.source, 'i');   // a copy without the "g" flag, whose .test() would remember a position
  const rank = t => t === filters.topic || (test && test.test(t)) ? 1 : 0;
  return [...topics].sort((a, b) => rank(b) - rank(a)).slice(0, 8);
}

/** Shared card layout. Discovery passes a normalized repo plus reasons and actions. */
export function card(r, {snips = [], re = null, suggestion = false, reasons = []} = {}) {
  const avatar = r.avatar ? `${r.avatar}${r.avatar.includes('?') ? '&' : '?'}s=36` : '';
  const home = safeUrl(r.homepage);
  const license = r.license && r.license !== 'NOASSERTION' ? `<span>${esc(r.license)}</span>` : '';
  const tag = suggestion ? 'li' : 'div';
  const shownTopics = pickTopics(r.topics || [], re);
  return `<${tag} class="card${suggestion ? ' suggestion-card' : ''}">
    <div class="owner">${avatar ? `<img src="${esc(avatar)}" loading="lazy" alt="">` : ''}<span class="chip" tabindex="0" role="button" data-owner="${esc(r.owner)}">${hl(r.owner, re)}</span>${r.archived ? ' · archived' : ''}${r.fork ? ' · fork' : ''}</div>
    <a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener">${hl(r.name, re)}</a>
    <p class="desc">${r.about ? hl(r.about, re) : '<span class="muted">No description</span>'}</p>
    ${snips.map(s => snipHTML(r, s, re)).join('')}
    <div class="chips">${shownTopics.map(t => `<span class="chip" tabindex="0" role="button" data-topic="${esc(t)}">${hl(t, re)}</span>`).join('')}</div>
    <div class="meta">
      <span>★ ${fmtN(r.stars)}</span>${r.forks != null ? `<span>⑂ ${fmtN(r.forks)}</span>` : ''}${r.issues != null ? `<span title="Open issues and pull requests">◉ ${fmtN(r.issues)} open</span>` : ''}${r.lang ? `<span class="chip" tabindex="0" role="button" data-lang="${esc(r.lang)}">● ${esc(r.lang)}</span>` : ''}${license}
      ${lastCommitTile(r)}
      ${historyBadge(r)}
      ${lastReleaseTile(r, suggestion)}
      ${r.created ? `<span title="Created ${esc(when(r.created))}">created ${ago(r.created)}</span>` : ''}
      ${r.starred ? `<span title="${esc(r.starred)}">starred ${ago(r.starred)}</span>` : ''}
      ${home ? `<a href="${esc(home)}" target="_blank" rel="noopener">site ↗</a>` : ''}
    </div>
    ${activityHTML(r)}${languagesHTML(r)}${viewerLinks(r)}
    ${suggestion ? `<div class="chips reasons">${reasons.slice(0, 5).map(reason => `<span class="why">${esc(reason)}</span>`).join('')}</div>
      <div class="suggestion-actions"><button class="starbtn" data-star="${esc(r.full)}" title="Star on GitHub">☆ Star</button>
      <button class="x" data-dismiss="${esc(r.full.toLowerCase())}" title="Never suggest this repo again">✕ Not interested</button></div>`
      : `<button class="similar" data-similar="${esc(rkey(r))}" title="Find repos related to this one that you haven't starred">✨ Show suggestions</button>`}
  </${tag}>`;
}

/** Resets active facet filters and pagination when switching GitHub users. */
export function resetFilters() {
  filters.lang = filters.topic = filters.owner = null;
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
  const rawQ = $('#q').value;
  const q = parseQuery(rawQ);
  const re = q.inc.length ? new RegExp(q.inc.map(escRe).join('|'), 'gi') : null;
  const inReadme = $('#inReadme').checked, inHistory = $('#inHistory').checked;

  const out = [], forLang = [], forTopic = [], forOwner = [];
  for (const r of S.repos) {
    if (S.hideForks && r.fork) continue;
    const okLang = !filters.lang || r.lang === filters.lang;
    const okTopic = !filters.topic || r.topics.includes(filters.topic);
    const okOwner = !filters.owner || r.owner === filters.owner;
    if (okLang + okTopic + okOwner < 2) continue;
    const m = match(r, q, inReadme, inHistory);
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
  const filtered = S.hideForks || pills.length > 0 || q.hasQuery;
  const exportBtns = out.length ? `<span class="export-actions"><button class="clear-filters" data-export="md" title="Export shown repos as Markdown">⬇ .md</button><button class="clear-filters" data-export="json" title="Export shown repos as JSON">⬇ .json</button></span>` : '';
  $('#count').innerHTML = `<span>${out.length} of ${S.repos.length} repos${filtered ? ' (filtered)' : ''}</span>` +
    (pills.length ? ` <span class="active-filters">${pills.join('')}<button class="clear-filters" data-clear-filters title="Clear active filters">Clear</button></span>` : '') + exportBtns;
  $('#list').innerHTML = out.slice(0, limit).map(x => card(x.r, {snips: x.snips, re})).join('');
  moreButton();
  indexCounts();
  renderFacets({forLang, forTopic, forOwner}, `${rawQ.trim().toLowerCase()}\0${inReadme ? 1 : 0}${inHistory ? 1 : 0}`);
  watchStarCharts($('#list'));
}

/** "(1,512)" / "(800/1,512)" next to the search-in checkboxes: how much of your stars is searchable there. */
let countsFor = null;
function indexCounts() {
  const key = [S.repos, S.indexVer];
  if (countsFor && key.every((v, i) => v === countsFor[i])) return;
  countsFor = key;
  const total = S.repos.length, n = x => x.toLocaleString();
  const readmes = S.repos.filter(r => readmeText(r)).length;
  const hist = S.repos.filter(r => S.history[rkey(r)]), done = hist.filter(r => S.history[rkey(r)].done).length;
  const set = (id, text, title) => { const el = $(id); if (el) { el.textContent = text; el.title = title; } };
  set('#cntReadme', readmes ? `(${n(readmes)})` : '', `${n(readmes)} of ${n(total)} READMEs are indexed`);
  set('#cntHistory', hist.length ? `(${done === total ? n(total) : `${n(done)}/${n(total)}`})` : '', `Commit messages and release notes: ${n(done)} of ${n(total)} repos complete, ${n(hist.length - done)} partial`);
}

// Each facet group is cross-filtered by the active search and the other two facets, so counts reflect real matches.
let facetsKey = null;
function renderFacets({forLang, forTopic, forOwner}, queryKey) {
  const k = [S.repos, S.hideForks, filters.lang, filters.topic, filters.owner, queryKey, S.indexVer];   // indexVer: README / history text changed
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
  $('#facets').innerHTML = block('Languages', 'lang', tally(forLang, r => r.lang), 15) +
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
    ? JSON.stringify(repos, (k, v) => NOT_EXPORTED.has(k) ? undefined : v, 2)
    : `# ★ ${user}'s Starred Repositories (${repos.length})\n\n` +
      repos.map(r => `- **[${r.full}](${r.url})** (★ ${fmtN(r.stars)}${r.lang ? ` · ${r.lang}` : ''})${r.about ? ` — ${oneLine(r.about)}` : ''}`).join('\n') + '\n';
}

/** Downloads the currently shown (filtered and sorted) repositories as Markdown or JSON. */
function exportMatches(fmt) {
  const repos = shownMatches.map(x => x.r);
  if (!repos.length) return;
  const user = S.user || 'github', body = exportText(repos, fmt, user);
  const url = URL.createObjectURL(new Blob([body], {type: fmt === 'json' ? 'application/json' : 'text/markdown;charset=utf-8'}));
  const a = Object.assign(document.createElement('a'), {href: url, download: `stars-${user.toLowerCase()}.${fmt}`});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);   // revoking at once can cancel the download in some browsers
}

/** Before the first search over commit messages / release notes: builds their search text without freezing the page. */
export async function prepareHistorySearch() {
  const msg = 'Preparing the commit & release search…';
  status(msg);
  await warmHistoryIndex();
  if ($('#status').textContent === msg) status('');
}

/** Puts a query in the search box (with README search on) and shows the matches. */
export async function searchFor(q) {
  $('#q').value = q;
  $('#inReadme').checked = true;
  if (Object.keys(S.history).length) { $('#inHistory').checked = true; await prepareHistorySearch(); }
  limit = PAGE; render();
  $('#q').scrollIntoView({block: 'nearest'});
}

const FACETS_PREF = 'starsViewer.hideFacets';   // localStorage: sidebar hidden?
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
  S.hideForks = false;
  $('#hideForks').checked = false;
  $('#sort').value = 'starred';
  $('#inReadme').checked = $('#inHistory').checked = false;   // the indexes they search are gone too
  setFacetsHidden(false, false);
  limit = PAGE;
}

export function initList() {
  // One list of sort choices for the toolbar and for Discover (sort.js); "Best match" only makes sense for suggestions.
  $('#sort').innerHTML = SORT_OPTIONS.filter(([key]) => key !== 'relevance').map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
  try { S.hideForks = localStorage.getItem('starsViewer.hideForks') === '1'; } catch {}
  $('#hideForks').checked = S.hideForks;
  $('#hideForks').onchange = e => {
    S.hideForks = e.target.checked;
    try { localStorage.setItem('starsViewer.hideForks', S.hideForks ? '1' : '0'); } catch {}
    limit = PAGE;
    render();
    window.dispatchEvent(new CustomEvent('fork-filter-change'));
  };
  try {
    const savedSort = localStorage.getItem(SORT_PREF);
    if (savedSort && [...$('#sort').options].some(o => o.value === savedSort)) $('#sort').value = savedSort;
  } catch {}
  let hidden = false;
  try { hidden = localStorage.getItem(FACETS_PREF) === '1'; } catch {}
  setFacetsHidden(hidden);
  $('#toggleFacets').onclick = () => setFacetsHidden(!document.querySelector('main').classList.contains('nofacets'));
  window.addEventListener('star-curve', e => refreshActivity(e.detail));
  let timer;
  // Searching commit messages scans far more text than the card fields, so it waits a little longer after each keystroke.
  $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { limit = PAGE; render(); }, $('#inHistory').checked ? 300 : 120); };
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
  $('#inReadme').onchange = () => { limit = PAGE; render(); };
  $('#inHistory').onchange = async e => { if (e.target.checked) await prepareHistorySearch(); limit = PAGE; render(); };
  $('#more').onclick = showMore;
  // Infinite scroll: when the button comes near the viewport, load the next step automatically.
  if (typeof IntersectionObserver !== 'undefined')
    new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) showMore(); }, {rootMargin: '600px'}).observe($('#more'));
  // "✨ Show suggestions" on a card: discover.js listens (an event keeps list.js independent of discover.js).
  $('#list').addEventListener('click', e => {
    const b = e.target.closest('[data-similar]');
    if (b) window.dispatchEvent(new CustomEvent('suggest-for', {detail: b.dataset.similar}));
  });
  // Facet, chip and export clicks (sidebar, filter bar and cards).
  document.addEventListener('click', e => {
    const exp = e.target.closest('[data-export]');
    if (exp) { exportMatches(exp.dataset.export); return; }
    if (e.target.closest('[data-clear-filters]')) {
      filters.lang = filters.topic = filters.owner = null;
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
