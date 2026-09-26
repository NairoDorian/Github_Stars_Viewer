// The main list: search, facet filters, sorting and rendering of repo cards.
import {S, readmeText, readmeLower} from './state.js';
import {$, esc, escRe, fmtN, ago, when, safeUrl, tally} from './util.js';
import {activityNow, starGains, ACTIVITY_SPAN, ACTIVITY_BUCKETS} from './github.js';
import {drawableCurve, starsAt, watchStarCharts} from './starhistory.js';

const PAGE = 200;   // cards rendered per step; more load automatically when you reach the end (or via Show more)
const filters = {lang: null, topic: null, owner: null};
let limit = PAGE;

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

const time = d => d ? Date.parse(d) : 0;
const SORTS = {
  starred: r => -time(r.starred),
  stars: r => -r.stars,
  pushed: r => -time(r.commitAt || r.pushed),
  release: r => -time(r.releaseAt),
  name: r => r.name.toLowerCase(),
  created: r => -time(r.created),
};

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

function card(r, snip, re) {
  const avatar = r.avatar ? `${r.avatar}${r.avatar.includes('?') ? '&' : '?'}s=36` : '';
  const home = safeUrl(r.homepage);
  const license = r.license && r.license !== 'NOASSERTION' ? `<span>${esc(r.license)}</span>` : '';
  return `<div class="card">
    <div class="owner">${avatar ? `<img src="${esc(avatar)}" loading="lazy" alt="">` : ''}<span class="chip" data-owner="${esc(r.owner)}">${esc(r.owner)}</span>${r.archived ? ' · archived' : ''}${r.fork ? ' · fork' : ''}</div>
    <a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener">${hl(r.name, re)}</a>
    <p class="desc">${r.about ? hl(r.about, re) : '<span class="muted">No description</span>'}</p>
    ${snip ? `<div class="snip">README: …${hl(snip, re)}…</div>` : ''}
    <div class="chips">${r.topics.slice(0, 8).map(t => `<span class="chip" data-topic="${esc(t)}">${hl(t, re)}</span>`).join('')}</div>
    <div class="meta">
      <span>★ ${fmtN(r.stars)}</span><span>⑂ ${fmtN(r.forks)}</span>${r.lang ? `<span>● ${esc(r.lang)}</span>` : ''}${license}
      <span class="lastcommit" title="Last commit: ${esc(when(r.commitAt || r.pushed))}${r.commitAt ? '' : ' (last push)'}">🕒 last commit ${ago(r.commitAt || r.pushed)}</span>
      ${r.release ? `<span title="${esc(r.releaseAt)}">🏷 ${esc(r.release)} · ${ago(r.releaseAt)}</span>` : ''}
      <span title="${esc(r.starred)}">starred ${ago(r.starred)}</span>
      ${home ? `<a href="${esc(home)}" target="_blank" rel="noopener">site ↗</a>` : ''}
    </div>
    ${activityHTML(r)}${languagesHTML(r)}
    <button class="similar" data-similar="${esc(r.id)}" title="Find repos related to this one that you haven't starred">✨ Show suggestions</button>
  </div>`;
}

export function render() {
  const terms = $('#q').value.toLowerCase().split(/\s+/).filter(Boolean);
  const re = terms.length ? new RegExp(terms.map(escRe).join('|'), 'gi') : null;
  const inReadme = $('#inReadme').checked;
  const key = SORTS[$('#sort').value] || SORTS.starred;

  const out = [];
  for (const r of S.repos) {
    if (filters.lang && r.lang !== filters.lang) continue;
    if (filters.topic && !r.topics.includes(filters.topic)) continue;
    if (filters.owner && r.owner !== filters.owner) continue;
    const m = match(r, terms, inReadme);
    if (m) out.push({r, snip: m.snip, k: key(r)});   // sort key computed once per repo
  }
  out.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0);

  const filtered = Object.values(filters).some(Boolean);
  $('#count').textContent = `${out.length} of ${S.repos.length} repos` + (filtered ? ' (filtered: click a facet again to clear)' : '');
  $('#list').innerHTML = out.slice(0, limit).map(x => card(x.r, x.snip, re)).join('');
  const left = out.length - limit, more = $('#more');
  more.hidden = left <= 0;   // everything shown: no button at all
  if (left > 0) more.textContent = `Show more (${left} left)`;
  renderFacets();
  watchStarCharts($('#list'));
}

// Facet counts only change when the repo list or the active filters change.
let facetsKey = null;
function renderFacets() {
  const k = [S.repos, filters.lang, filters.topic, filters.owner];
  if (facetsKey && k.every((v, i) => v === facetsKey[i])) return;
  facetsKey = k;
  const block = (title, kind, list, n) => `<h3>${title}</h3>` + list.slice(0, n).map(([v, c]) =>
    `<div class="facet ${filters[kind] === v ? 'on' : ''}" data-${kind}="${esc(v)}"><span title="${esc(v)}">${esc(v)}</span><span class="muted">${c}</span></div>`).join('');
  $('#facets').innerHTML = block('Languages', 'lang', tally(S.repos, r => r.lang), 15) +
    block('Topics', 'topic', tally(S.repos, r => r.topics), 30) +
    block('Owners', 'owner', tally(S.repos, r => r.owner).filter(x => x[1] > 1), 15);
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
  let hidden = false;
  try { hidden = localStorage.getItem(FACETS_PREF) === '1'; } catch {}
  setFacetsHidden(hidden);
  $('#toggleFacets').onclick = () => setFacetsHidden(!document.querySelector('main').classList.contains('nofacets'));
  window.addEventListener('star-curve', e => refreshActivity(e.detail));
  let timer;
  $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { limit = PAGE; render(); }, 120); };
  $('#sort').onchange = () => { limit = PAGE; render(); };
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
