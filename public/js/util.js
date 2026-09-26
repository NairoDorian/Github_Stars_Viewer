// Small shared helpers: DOM, formatting, safe HTML, async concurrency.

export const $ = sel => document.querySelector(sel);
export const DAY = 864e5;

/** Escapes text for use inside HTML (content and double- or single-quoted attributes). */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** Only http(s) links are allowed into href: blocks `javascript:` URLs that a repo could set as its homepage. */
export const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '';

/** 1234 → "1.2k", 45678 → "46k". */
export const fmtN = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n ?? 0);

/** ISO date → "3d ago". */
export function ago(d) {
  if (!d) return '—';
  const s = (Date.now() - new Date(d)) / 1000;
  for (const [u, v] of [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]]) if (s >= v) return Math.floor(s / v) + u + ' ago';
  return 'just now';
}

/** ISO date → full local date and time, for tooltips. */
export const when = d => d ? new Date(d).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : '';

/** Elapsed time since a performance.now() mark, e.g. "2.4s". */
export const secs = t0 => ((performance.now() - t0) / 1000).toFixed(1) + 's';

/** Status line under the toolbar. */
export const status = text => { $('#status').textContent = text; };

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Runs fn over every item with at most n calls in flight. */
export async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
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
