// Small shared helpers: DOM, formatting, safe HTML, async concurrency.

export const $ = sel => document.querySelector(sel);
export const DAY = 864e5;

/** Escapes text for use inside HTML (content and double- or single-quoted attributes). */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** Only http(s) links are allowed into href: blocks `javascript:` URLs that a repo could set as its homepage. */
export const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '';

/** Compact counts, including millions; bad cached values display as zero instead of NaN. */
export function fmtN(n) {
  const value = Number(n ?? 0);
  if (!Number.isFinite(value)) return '0';
  if (value < 0) return '-' + fmtN(-value);   // "stars gained" can be negative
  if (value >= 999_950) return (value / 1e6).toFixed(value >= 9_950_000 ? 0 : 1) + 'M';   // thresholds are where rounding would print "1000k" / "10.0M"
  if (value >= 1e3) return (value / 1e3).toFixed(value >= 9_950 ? 0 : 1) + 'k';
  return String(value);
}

/** ISO date → "3d ago". */
export function ago(d) {
  if (!d) return '—';
  const s = (Date.now() - new Date(d)) / 1000;
  if (!Number.isFinite(s)) return '—';
  for (const [u, v] of [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]]) if (s >= v) return Math.floor(s / v) + u + ' ago';
  return 'just now';
}

// toLocaleDateString(…, options) builds a new Intl.DateTimeFormat on every call, which made drawing 200 cards (26 bar
// tooltips each) take seconds; each format is built once instead.
const formats = new Map();
/** A date (ISO text, ms or Date) as local text in the given Intl format; '' when it isn't a valid date. */
export function fmtDate(d, opts) {
  const t = d == null || d === '' ? NaN : new Date(d).getTime();
  if (!Number.isFinite(t)) return '';
  const key = JSON.stringify(opts);
  let f = formats.get(key);
  if (!f) formats.set(key, f = new Intl.DateTimeFormat(undefined, opts));
  return f.format(t);
}

/** ISO date → full local date and time, for tooltips. */
export const when = d => fmtDate(d, {dateStyle: 'medium', timeStyle: 'short'});

/** Elapsed time since a performance.now() mark, e.g. "2.4s". */
export const secs = t0 => ((performance.now() - t0) / 1000).toFixed(1) + 's';

/** Status line under the toolbar. */
export const status = text => { $('#status').textContent = text; };

/** Waits ms, or less if `signal` aborts. The abort listener is removed either way: a generation's signal lives through
 *  thousands of sleeps during a long index run. */
export const sleep = (ms, signal) => new Promise(r => {
  if (signal?.aborted) return r();
  const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); r(); };
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', done, {once: true});
});

/** Runs fn over every item with at most n calls in flight. Once a call throws, no new item is started and the error is
 *  thrown (the calls already in flight finish on their own). */
export async function pool(items, n, fn) {
  let i = 0, failed = false;
  const worker = async () => {
    while (!failed && i < items.length) {
      try { await fn(items[i++]); } catch (e) { failed = true; throw e; }
    }
  };
  await Promise.all(Array.from({length: Math.min(n, items.length)}, worker));
}

/** Splits an array into chunks of n. */
export const chunks = (a, n) => Array.from({length: Math.ceil(a.length / n)}, (_, i) => a.slice(i * n, i * n + n));

/** Counts values produced by f over a list → [[value, count], …] sorted by count desc. f may return one value or an array. */
export function tally(list, f) {
  const m = new Map();
  for (const x of list) for (const v of [].concat(f(x) ?? [])) m.set(v, (m.get(v) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

/** Regex-escapes a literal string. */
export const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
