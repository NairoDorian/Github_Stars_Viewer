/* Star history from star-history.com.

   GitHub no longer serves star timestamps (REST /stargazers → 401/404, GraphQL `stargazers` → empty), but
   star-history.com keeps its own copy. Its public chart endpoint returns an SVG (CORS allowed, CDN-cached for a day);
   we read the curve and the axes back into real [time, stars] points and draw our own chart from them.

   Loading is lazy: only charts scrolled into view are fetched (4 at a time), then cached for a week in
   `starcurves` (shared by all users and by suggestion cards). When a curve arrives, a `star-curve` event lets
   list.js redraw the matching cards. */
import {S} from './state.js';
import {put} from './store.js';

const TTL = 7 * 864e5, FAIL_TTL = 864e5, CONCURRENCY = 4;
const key = full => full.toLowerCase();

export const curveFor = full => S.starCurves[key(full)];
/** Curve to draw: any saved one with points (even from an older parser), so charts don't blink while refreshing. */
export const drawableCurve = full => { const c = curveFor(full); return c?.pts ? c : c && fresh(c) ? c : null; };
// Bump PARSER when parsing improves: entries saved by an older parser (e.g. "unavailable" because a label format
// wasn't understood) are then fetched again instead of waiting for their TTL.
const PARSER = 3;
const fresh = c => c && c.v === PARSER && Date.now() - c.at < (c.pts ? TTL : FAIL_TTL);

// ---------- SVG → points ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const translate = el => (el.getAttribute('transform') || '').match(/translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)/)?.slice(1).map(Number);

/** "100" → 100, "5K" → 5000, "1.2M" → 1200000, blank → 0 (the axis origin). */
function tickValue(text) {
  const t = text.trim().replace(/,/g, '');
  if (!t) return 0;
  const m = t.match(/^([\d.]+)\s*([kKmM]?)$/);
  return m ? Number(m[1]) * ({k: 1e3, m: 1e6}[m[2].toLowerCase()] || 1) : null;
}

/** X-axis labels → dates. star-history.com picks the label format from the repo's age (d3 time ticks):
 *  "2024" (years) · "July" / "Sep 21" (months, weeks) · "Wed 09" (days: weekday + day of month, month implied).
 *  Years and months are explicit or inferred from neighbouring labels and today; day-only labels take their month
 *  from the nearest labelled tick. */
function tickDates(ticks) {
  const all = ticks.map(({x, text}) => {
    const t = text.trim();
    if (/^\d{4}$/.test(t)) return {x, year: +t, month: 0, day: 1};
    const m = t.match(/^([A-Za-z]{3,})\.?(?:\s+(\d{1,2}))?$/);
    if (!m) return null;
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return {x, month: mi, day: m[2] ? +m[2] : 1};
    if (WEEKDAYS.includes(m[1].slice(0, 3).toLowerCase()) && m[2]) return {x, dayOnly: +m[2]};   // "Wed 09"
    return null;
  }).filter(Boolean).sort((a, b) => a.x - b.x);
  const parsed = all.filter(p => p.dayOnly == null), dayOnly = all.filter(p => p.dayOnly != null);
  const resolved = resolveMonths(parsed);
  // Day-only ticks: same month as the nearest resolved tick, stepping a month when the day number says so.
  const out = [...resolved];
  for (const p of dayOnly) {
    const right = resolved.find(r => r.x > p.x), left = [...resolved].reverse().find(r => r.x < p.x);
    let base = right || left, d;
    if (!base) {   // only day labels (repo a few days old): the last one is the latest date ≤ today
      const now = new Date(); base = {t: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())};
    }
    const b = new Date(base.t);
    d = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), p.dayOnly);
    if (base === right && d > base.t) d = Date.UTC(b.getUTCFullYear(), b.getUTCMonth() - 1, p.dayOnly);
    if (base === left && d < base.t) d = Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, p.dayOnly);
    if (!right && !left && d > base.t) d = Date.UTC(b.getUTCFullYear(), b.getUTCMonth() - 1, p.dayOnly);
    out.push({x: p.x, t: d});
  }
  return out.sort((a, b) => a.x - b.x);
}
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Year/month ticks → dates. */
function resolveMonths(parsed) {
  if (!parsed.length) return [];
  // Walk left→right: a month after a year label belongs to it; months before the first year label belong to year−1.
  const firstYear = parsed.find(p => p.year != null)?.year;
  let year = firstYear != null ? firstYear - 1 : null;
  if (year == null) {   // no year label at all: the last tick is the latest date ≤ today
    const now = new Date(), last = parsed.at(-1);
    year = last && last.month > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
    for (let i = parsed.length - 2; i >= 0; i--) if (parsed[i].month > parsed[i + 1].month) year--;
  }
  let prevMonth = -1;
  return parsed.map(p => {
    if (p.year != null) year = p.year;
    else if (p.month < prevMonth) year++;
    prevMonth = p.month;
    return {x: p.x, t: Date.UTC(year, p.month, p.day)};
  });
}

/** Least-squares line through (a, b) pairs → f(a) = b. */
function fit(pairs) {
  const n = pairs.length, ma = pairs.reduce((s, p) => s + p[0], 0) / n, mb = pairs.reduce((s, p) => s + p[1], 0) / n;
  const k = pairs.reduce((s, p) => s + (p[0] - ma) * (p[1] - mb), 0) / pairs.reduce((s, p) => s + (p[0] - ma) ** 2, 0);
  return a => mb + k * (a - ma);
}

/** End points of every segment of an SVG path: all commands (M L H V C S Q T A Z), absolute or relative, including
 *  minified forms like "a.4.4 0 01.108-.032" where arc flags are single digits glued to the next number. */
function pathPoints(d) {
  const argc = {m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0};
  const num = /^\s*,?\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/i, flag = /^\s*,?\s*([01])/;
  const pts = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  while (i < d.length) {
    const c = d.slice(i).match(/^\s*([a-zA-Z])/);
    if (c) { cmd = c[1]; i += c[0].length; }
    const lc = cmd.toLowerCase(), rel = cmd === lc, n = argc[lc];
    if (n === undefined) break;
    if (!n) { x = sx; y = sy; if (!c) break; continue; }   // Z: back to the subpath start
    const args = [];
    for (let k = 0; k < n; k++) {
      const m = d.slice(i).match(lc === 'a' && (k === 3 || k === 4) ? flag : num);   // arc flags are one digit
      if (!m) break;
      args.push(Number(m[1])); i += m[0].length;
    }
    if (args.length < n) break;
    if (lc === 'h') x = rel ? x + args[0] : args[0];
    else if (lc === 'v') y = rel ? y + args[0] : args[0];
    else { x = rel ? x + args[n - 2] : args[n - 2]; y = rel ? y + args[n - 1] : args[n - 1]; }
    if (lc === 'm') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }   // extra pairs after M are line-tos
    pts.push([x, y]);
  }
  return pts;
}

/** star-history SVG → [[time ms, stars], …] sorted by time, or null if it can't be read. */
export function parseStarHistorySvg(svgText) {
  const doc = new DOMParser().parseFromString(svgText.replace(/<style>[\s\S]*?<\/style>/, ''), 'image/svg+xml');
  const xTicks = [...doc.querySelectorAll('.xaxis text.tick')].map(el => ({x: translate(el)?.[0], text: el.textContent})).filter(t => t.x != null);
  const yTicks = [...doc.querySelectorAll('.yaxis .tick')].map(g => {
    const txt = g.querySelector('text');
    return {y: txt && translate(txt)?.[1], v: txt ? tickValue(txt.textContent) : null};
  }).filter(t => t.y != null && t.v != null);
  const curve = [...doc.querySelectorAll('path[fill="none"]')].find(p => !p.classList.contains('domain') && p.getAttribute('stroke') !== 'currentColor');
  const dates = tickDates(xTicks);
  if (!curve || dates.length < 2 || yTicks.length < 2) return null;
  const xToT = fit(dates.map(d => [d.x, d.t])), yToV = fit(yTicks.map(t => [t.y, t.v]));
  const pts = pathPoints(curve.getAttribute('d')).map(([x, y]) => [Math.round(xToT(x) / 36e5) * 36e5, Math.max(0, Math.round(yToV(y)))]);
  pts.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < pts.length; i++) pts[i][1] = Math.max(pts[i][1], pts[i - 1][1]);   // stars only accumulate on the curve
  return pts.length >= 2 ? pts : null;
}

/** Stars at time t, interpolated on the curve (0 before the first star). */
export function starsAt(pts, t) {
  if (t <= pts[0][0]) return 0;
  if (t >= pts.at(-1)[0]) return pts.at(-1)[1];
  let i = 1; while (pts[i][0] < t) i++;
  const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
  return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
}

/** Stars gained per bucket for `n` buckets of `span` ms ending now. */
export function curveGains(pts, n, span, now = Date.now()) {
  const start = now - n * span;
  return Array.from({length: n}, (_, i) => Math.max(0, Math.round(starsAt(pts, start + (i + 1) * span) - starsAt(pts, start + i * span))));
}

// ---------- lazy loading ----------
const queue = [], pending = new Set();
let active = 0, saveTimer = null;

/** Fetches one chart. star-history.com sometimes answers 403/429/5xx for a moment (the same repo works seconds later),
 *  so those and network errors are retried with backoff and never cached. Only 404, or a chart without a readable
 *  curve, is cached as "unavailable" (retried after a day). */
async function load(full) {
  const k = key(full), url = `https://api.star-history.com/svg?repos=${encodeURIComponent(k)}&type=Date`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let r = null;
    try { r = await fetch(url); } catch {}
    if (r?.ok) { S.starCurves[k] = {v: PARSER, at: Date.now(), pts: parseStarHistorySvg(await r.text())}; break; }
    if (r?.status === 404) { S.starCurves[k] = {v: PARSER, at: Date.now(), pts: null}; break; }
    await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));   // 403 / 429 / 5xx / network: wait and retry
  }
  if (!S.starCurves[k]) return;   // still failing: leave it unloaded, it's tried again next time it's on screen
  window.dispatchEvent(new CustomEvent('star-curve', {detail: k}));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => put('starcurves', S.starCurves), 3000);   // batch cache writes
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const full = queue.shift();
    active++;
    load(full).finally(() => { active--; pending.delete(key(full)); pump(); });
  }
}

const observer = typeof IntersectionObserver !== 'undefined' && new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    observer.unobserve(e.target);
    const full = e.target.dataset.sh, k = key(full);
    if (fresh(curveFor(full)) || pending.has(k)) continue;
    pending.add(k); queue.push(full); pump();
  }
}, {rootMargin: '300px'});

/** Starts watching every activity block under `root`; their star history loads when they come into view. */
export function watchStarCharts(root) {
  if (!observer || !root) return;
  for (const el of root.querySelectorAll('.activity[data-sh]')) if (!fresh(curveFor(el.dataset.sh))) observer.observe(el);
}
