// The main list: search, facet filters, sorting and rendering of repo cards.
import {S, readmeText, readmeLower} from './state.js';
import {$, esc, escRe, fmtN, ago, when, safeUrl, tally} from './util.js';
import {activityNow, starGains, ACTIVITY_SPAN, ACTIVITY_BUCKETS} from './github.js';
import {drawableCurve, starsAt, watchStarCharts} from './starhistory.js';
import {SORT_OPTIONS, sortRepos, sortEditorHTML, editSortKeys, loadSortKeys} from './sort.js';

const PAGE = 200;   // cards rendered per step; more load automatically when you reach the end (or via Show more)
const filters = {lang: null, topic: null, owner: null};
let limit = PAGE;
const STAR_SORT_PREF = 'starsViewer.starSortKeys';
const STAR_SORT_KEYS = SORT_OPTIONS.map(([k]) => k).filter(k => k !== 'relevance');
let starSortKeys = ['starred'];

function showStarSort() { $('#starSort').innerHTML = sortEditorHTML(starSortKeys, STAR_SORT_KEYS); }
function changeStarSort(e, action) {
  const t = e.target.closest('[data-sort-index],[data-sort-action]');
  if (!t || (action === 'change' && t.tagName !== 'SELECT')) return;
  const next = editSortKeys(starSortKeys, action === 'change' ? action : t.dataset.sortAction,
    Number(t.dataset.sortIndex), t.value, STAR_SORT_KEYS);
  if (next.join('|') === starSortKeys.join('|')) return;
  starSortKeys = next;
  try { localStorage.setItem(STAR_SORT_PREF, JSON.stringify(next)); } catch {}
  showStarSort();
  limit = PAGE; render();
}

// Lower-cased searchable text per repo object (repo objects are replaced on sync, so this never goes stale).
const hayCache = new WeakMap();
function hay(r) {
  let h = hayCache.get(r);
  if (h === undefined) hayCache.set(r, h = [r.full, r.about, r.topics.join(' '), r.lang, ...(r.langs || []).map(l => l[0])].join(' ').toLowerCase());
  return h;
}

/** Every term must match name/owner/about/topics/language, or the README when enabled. Returns {snip} or null. */
function match(r, terms, inReadme) {
  let snip = null;
  for (const t of terms) {
    if (hay(r).includes(t)) continue;
    if (!inReadme) return null;
    const i = readmeLower(r).indexOf(t);
    if (i < 0) return null;
    snip ??= readmeText(r).slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' ');
  }
  return {snip};
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

/** GitHub-style language breakdown: a colored bar plus every language with its share, largest first.
 *  Takes anything with a `langs` array ([[name, percent, color], …]): starred repos (filled in by checks with a token)
 *  and suggestion cards (filled in by discover.js). */
/* ---- activity mini-charts: commits and stars per 2 weeks over the last 12 months ----
   One series each, so no legend: the row label names it. Bars have a 2px gap, a 1px baseline tick for empty
   periods (the rhythm stays readable), faint full-height blocks for periods the data doesn't cover, and a native
   tooltip per bar. Values are text in ink colors; only the bars carry the series color. */
const W = 260, H = 26, BAR = 8, GAP = 2;
const day = t => new Date(t).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});

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
  const month = t => new Date(t).toLocaleDateString(undefined, {month: 'short', year: 'numeric'});
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
  const path = (S.readmes[String(r.id)]?.path || 'README.md').split('/').map(encodeURIComponent).join('/');
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

/** Shared card layout. Discovery passes a normalized repo plus reasons and actions. */
export function card(r, {snip = null, re = null, suggestion = false, reasons = []} = {}) {
  const avatar = r.avatar ? `${r.avatar}${r.avatar.includes('?') ? '&' : '?'}s=36` : '';
  const home = safeUrl(r.homepage);
  const license = r.license && r.license !== 'NOASSERTION' ? `<span>${esc(r.license)}</span>` : '';
  const tag = suggestion ? 'li' : 'div';
  return `<${tag} class="card${suggestion ? ' suggestion-card' : ''}">
    <div class="owner">${avatar ? `<img src="${esc(avatar)}" loading="lazy" alt="">` : ''}<span class="chip" data-owner="${esc(r.owner)}">${esc(r.owner)}</span>${r.archived ? ' · archived' : ''}${r.fork ? ' · fork' : ''}</div>
    <a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener">${hl(r.name, re)}</a>
    <p class="desc">${r.about ? hl(r.about, re) : '<span class="muted">No description</span>'}</p>
    ${snip ? `<div class="snip">README: …${hl(snip, re)}…</div>` : ''}
    <div class="chips">${(r.topics || []).slice(0, 8).map(t => `<span class="chip" data-topic="${esc(t)}">${hl(t, re)}</span>`).join('')}</div>
    <div class="meta">
      <span>★ ${fmtN(r.stars)}</span>${r.forks != null ? `<span>⑂ ${fmtN(r.forks)}</span>` : ''}${r.issues != null ? `<span title="Open issues">◉ ${fmtN(r.issues)} issues</span>` : ''}${r.lang ? `<span>● ${esc(r.lang)}</span>` : ''}${license}
      ${(r.commitAt || r.pushed) ? `<span class="lastcommit" title="Last commit: ${esc(when(r.commitAt || r.pushed))}${r.commitAt ? '' : ' (last push)'}">🕒 last commit ${ago(r.commitAt || r.pushed)}</span>` : ''}
      ${r.release ? `<span title="${esc(r.releaseAt)}">🏷 ${esc(r.release)} · ${ago(r.releaseAt)}</span>` : ''}
      ${r.created ? `<span title="Created ${esc(when(r.created))}">created ${ago(r.created)}</span>` : ''}
      ${r.starred ? `<span title="${esc(r.starred)}">starred ${ago(r.starred)}</span>` : ''}
      ${home ? `<a href="${esc(home)}" target="_blank" rel="noopener">site ↗</a>` : ''}
    </div>
    ${activityHTML(r)}${languagesHTML(r)}${viewerLinks(r)}
    ${suggestion ? `<div class="chips reasons">${reasons.slice(0, 5).map(reason => `<span class="why">${esc(reason)}</span>`).join('')}</div>
      <div class="suggestion-actions"><button class="starbtn" data-star="${esc(r.full)}" title="Star on GitHub">☆ Star</button>
      <button class="x" data-dismiss="${esc(r.full.toLowerCase())}" title="Never suggest this repo again">✕ Not interested</button></div>`
      : `<button class="similar" data-similar="${esc(r.id)}" title="Find repos related to this one that you haven't starred">✨ Show suggestions</button>`}
  </${tag}>`;
}

export function render() {
  const terms = $('#q').value.toLowerCase().split(/\s+/).filter(Boolean);
  const re = terms.length ? new RegExp(terms.map(escRe).join('|'), 'gi') : null;
  const inReadme = $('#inReadme').checked;

  const out = [];
  for (const r of S.repos) {
    if (S.hideForks && r.fork) continue;
    if (filters.lang && r.lang !== filters.lang) continue;
    if (filters.topic && !r.topics.includes(filters.topic)) continue;
    if (filters.owner && r.owner !== filters.owner) continue;
    const m = match(r, terms, inReadme);
    if (m) out.push({r, snip: m.snip});
  }
  sortRepos(out, starSortKeys, 'name');

  const filtered = S.hideForks || Object.values(filters).some(Boolean);
  $('#count').textContent = `${out.length} of ${S.repos.length} repos` + (filtered ? ' (filtered)' : '');
  $('#list').innerHTML = out.slice(0, limit).map(x => card(x.r, {snip: x.snip, re})).join('');
  const left = out.length - limit, more = $('#more');
  more.hidden = left <= 0;   // everything shown: no button at all
  if (left > 0) more.textContent = `Show more (${left} left)`;
  renderFacets();
  watchStarCharts($('#list'));
}

// Facet counts only change when the repo list or the active filters change.
let facetsKey = null;
function renderFacets() {
  const k = [S.repos, S.hideForks, filters.lang, filters.topic, filters.owner];
  if (facetsKey && k.every((v, i) => v === facetsKey[i])) return;
  facetsKey = k;
  const block = (title, kind, list, n) => `<h3>${title}</h3>` + list.slice(0, n).map(([v, c]) =>
    `<div class="facet ${filters[kind] === v ? 'on' : ''}" data-${kind}="${esc(v)}"><span title="${esc(v)}">${esc(v)}</span><span class="muted">${c}</span></div>`).join('');
  const source = S.hideForks ? S.repos.filter(r => !r.fork) : S.repos;
  $('#facets').innerHTML = block('Languages', 'lang', tally(source, r => r.lang), 15) +
    block('Topics', 'topic', tally(source, r => r.topics), 30) +
    block('Owners', 'owner', tally(source, r => r.owner).filter(x => x[1] > 1), 15);
}

/** Puts a query in the search box (with README search on) and shows the matches. */
export function searchFor(q) {
  $('#q').value = q;
  $('#inReadme').checked = true;
  limit = PAGE; render();
  $('#q').scrollIntoView({block: 'nearest'});
}

const FACETS_PREF = 'starsViewer.hideFacets';   // localStorage: sidebar hidden?
function setFacetsHidden(hide) {
  document.querySelector('main').classList.toggle('nofacets', hide);
  const b = $('#toggleFacets');
  b.textContent = hide ? '◧ Show filters' : '◧ Hide filters';
  b.setAttribute('aria-expanded', String(!hide));
  try { localStorage.setItem(FACETS_PREF, hide ? '1' : '0'); } catch {}
}

export function initList() {
  starSortKeys = loadSortKeys(STAR_SORT_PREF, STAR_SORT_KEYS, 'starred');
  showStarSort();
  $('#starSort').addEventListener('change', e => changeStarSort(e, 'change'));
  $('#starSort').addEventListener('click', e => changeStarSort(e, 'click'));
  try { S.hideForks = localStorage.getItem('starsViewer.hideForks') === '1'; } catch {}
  $('#hideForks').checked = S.hideForks;
  $('#hideForks').onchange = e => {
    S.hideForks = e.target.checked;
    try { localStorage.setItem('starsViewer.hideForks', S.hideForks ? '1' : '0'); } catch {}
    limit = PAGE;
    render();
    window.dispatchEvent(new CustomEvent('fork-filter-change'));
  };
  let hidden = false;
  try { hidden = localStorage.getItem(FACETS_PREF) === '1'; } catch {}
  setFacetsHidden(hidden);
  $('#toggleFacets').onclick = () => setFacetsHidden(!document.querySelector('main').classList.contains('nofacets'));
  window.addEventListener('star-curve', e => refreshActivity(e.detail));
  let timer;
  $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { limit = PAGE; render(); }, 120); };
  $('#inReadme').onchange = () => render();
  const showMore = () => { if (!$('#more').hidden) { limit += PAGE; render(); } };
  $('#more').onclick = showMore;
  // Infinite scroll: when the button comes near the viewport, load the next step automatically.
  if (typeof IntersectionObserver !== 'undefined')
    new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) showMore(); }, {rootMargin: '600px'}).observe($('#more'));
  // "✨ Show suggestions" on a card: discover.js listens (an event keeps list.js independent of discover.js).
  $('#list').addEventListener('click', e => {
    const b = e.target.closest('[data-similar]');
    if (b) window.dispatchEvent(new CustomEvent('suggest-for', {detail: Number(b.dataset.similar)}));
  });
  // Facet and chip clicks (sidebar and cards) toggle the matching filter.
  document.addEventListener('click', e => {
    const el = e.target.closest('#facets [data-lang], #facets [data-topic], #facets [data-owner], #list [data-topic], #list [data-owner]');
    if (!el) return;
    for (const k of ['lang', 'topic', 'owner']) if (el.dataset[k] !== undefined) filters[k] = filters[k] === el.dataset[k] ? null : el.dataset[k];
    limit = PAGE; render();
  });
  // "/" focuses the search box (unless typing in a field).
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) { e.preventDefault(); $('#q').focus(); }
  });
}
