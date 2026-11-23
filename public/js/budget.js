// GitHub's rate limits ("budgets"), known exactly instead of guessed. GitHub reports them on every answer (the
// x-ratelimit-limit / -remaining / -used / -reset / -resource headers) and, for free (it counts against nothing), at
// GET /rate_limit. Each kind has its own budget and its own window:
//   core         REST requests (star list, READMEs without a token, file lists): 5,000 an hour with a token, 60 without
//   graphql      GraphQL points (details, commits, releases, owners): 5,000 an hour; a query costs at least 1 point
//   search       repository search (Discover): 30 a minute with a token, 10 without
//   code_search  code search: 10 a minute
// A window opens with the first request after the previous window ended and lasts one hour (one minute for search);
// `reset` is the exact second the budget refills. The budget belongs to the token (or, without one, to your IP address),
// so what other tabs, scripts (slab_stars.py, the gh CLI…) or an earlier visit of this page used is included: reading
// /rate_limit when the page opens and before each pull shows the real budget left, not a full one.
import {S} from './state.js';
import {status, sleep} from './util.js';
import {info, warn} from './log.js';

/** kind → {limit, remaining, used, reset (unix seconds), at (ms: when this was learned)} */
export const BUDGET = {};
const NAMES = {core: 'REST', graphql: 'GraphQL', search: 'search', code_search: 'code search'};
export const kindName = kind => NAMES[kind] || kind;
const PER = kind => /search/.test(kind) ? 'minute' : 'hour';

/** "52 s", "14 min", "1 h 02 min" */
export function inTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.round(s % 3600 / 60)).padStart(2, '0')} min`;
}
const clock = unix => new Date(unix * 1000).toLocaleTimeString();

let notify = null;
/** Tells the page the budget changed (at most every 250 ms: hundreds of answers can arrive per second). */
function changed() {
  if (notify || typeof window === 'undefined') return;
  notify = setTimeout(() => { notify = null; window.dispatchEvent(new CustomEvent('budget')); }, 250);
}

/** Learns the budget from an answer's headers (every GitHub answer carries them, 304s included). */
export function noteHeaders(h) {
  const left = h?.get?.('x-ratelimit-remaining');
  if (left == null) return;
  const kind = h.get('x-ratelimit-resource') || 'core';
  const b = {limit: Number(h.get('x-ratelimit-limit')) || BUDGET[kind]?.limit || 0, remaining: Number(left),
    used: Number(h.get('x-ratelimit-used')) || 0, reset: Number(h.get('x-ratelimit-reset')) || BUDGET[kind]?.reset || 0, at: Date.now()};
  // Answers arrive out of order: an older one must not raise the count again within the same window.
  const old = BUDGET[kind];
  if (old && old.reset === b.reset && old.remaining < b.remaining) return;
  BUDGET[kind] = b;
  changed();
}

/** Takes the whole picture from GET /rate_limit ({resources: {core: {limit, remaining, used, reset}, graphql: …}}). */
export function setBudgets(resources) {
  for (const [kind, x] of Object.entries(resources || {})) {
    if (x && typeof x.remaining === 'number') BUDGET[kind] = {limit: x.limit, remaining: x.remaining, used: x.used ?? x.limit - x.remaining, reset: x.reset, at: Date.now()};
  }
  changed();
}

/** The budget of a kind as it is now: a window that has ended counts as full again. null when not known yet. */
export function budgetNow(kind) {
  const b = BUDGET[kind];
  if (!b) return null;
  return b.reset && Date.now() >= b.reset * 1000 ? {...b, remaining: b.limit, used: 0, refilled: true} : b;
}

/** "it refills at 18:47:42 (in 52 s)" */
export function refillText(kind) {
  const b = BUDGET[kind];
  return b?.reset ? `it refills at ${clock(b.reset)} (in ${inTime(b.reset * 1000 - Date.now())})` : 'it refills within the hour';
}

/** The words for a used-up budget: which one, its size, when it refills. */
export function limitMessage(kind) {
  const b = BUDGET[kind];
  const size = b?.limit ? `${b.limit.toLocaleString()} ${kind === 'graphql' ? 'points' : 'requests'} per ${PER(kind)}` : `per ${PER(kind)}`;
  return `GitHub's ${kindName(kind)} budget is used up (${size}${kind === 'core' && !S.token ? ' without a token; 5,000 with one' : ''}): ${refillText(kind)}`;
}

/** The error thrown for a used-up budget, from the answer that said so. Carries {fatal, rateLimited, kind, reset}. */
export function rateLimitError(r, fallbackKind = 'core') {
  noteHeaders(r.headers);
  const kind = r.headers.get('x-ratelimit-resource') || fallbackKind;
  const reset = Number(r.headers.get('x-ratelimit-reset')) || BUDGET[kind]?.reset || 0;
  if (BUDGET[kind]) BUDGET[kind].remaining = 0;
  warn('budget', `${limitMessage(kind)} · window: one ${PER(kind)} from its first request; the budget belongs to the token, so other tabs and scripts count too`);
  return Object.assign(new Error(limitMessage(kind)), {fatal: true, rateLimited: true, kind, reset});
}

const LONGEST_WAIT = 61 * 60_000;   // a primary window is one hour: never wait longer than that
/** Margin after the refill time (the clocks of GitHub and this computer are not exactly equal). A knob so tests don't wait. */
export const TUNING = {marginMs: 2000};
const waits = {};
/**
 * A pull that ran out of budget waits for the refill and continues, instead of stopping: resolves true when the budget
 * is back, false when it can't wait (unknown refill time, more than an hour away), Cancel was clicked or another profile
 * was loaded (`g`). Workers that hit the limit together share one wait. The status line counts down meanwhile.
 */
export function waitForRefill(e, g, label) {
  if (!e?.rateLimited || !e.reset) return Promise.resolve(false);
  const until = e.reset * 1000 + TUNING.marginMs;
  if (until - Date.now() > LONGEST_WAIT) return Promise.resolve(false);
  if (waits[e.kind]) return waits[e.kind];
  const run = async () => {
    info('budget', `${label}: waiting for GitHub's ${kindName(e.kind)} budget to refill at ${clock(e.reset)}, then continuing (■ Cancel stops now; progress is saved)`);
    while (Date.now() < until) {
      if (S.stop || g !== S.gen) return false;
      status(`⏸ ${label}: GitHub's ${kindName(e.kind)} budget is used up (${(BUDGET[e.kind]?.limit || 0).toLocaleString()} per ${PER(e.kind)}). Continuing automatically at ${clock(e.reset)} (in ${inTime(until - Date.now())}) · ■ Cancel to stop now, progress is saved`);
      await sleep(Math.min(1000, until - Date.now()));
    }
    if (S.stop || g !== S.gen) return false;
    if (BUDGET[e.kind]) Object.assign(BUDGET[e.kind], {remaining: BUDGET[e.kind].limit, used: 0});
    changed();
    info('budget', `${label}: the ${kindName(e.kind)} budget refilled, continuing`);
    return true;
  };
  // Stored before it can end: a wait that ends at once (Cancel already clicked) must not leave a stale answer behind.
  const p = waits[e.kind] = run().finally(() => { if (waits[e.kind] === p) delete waits[e.kind]; });
  return p;
}

/** GitHub's "slow down" (its secondary rate limit: too many requests in a short time, while the hourly budget still has
 *  room). baseMs: the pause when GitHub names none (its documentation asks for at least a minute), doubled for every
 *  pause in a row; max: that many pauses in a row end the pull. A knob so tests don't wait. */
export const SLOW = {baseMs: 60_000, max: 4};
let slowWait = null, slowStreak = 0;
/**
 * A REST pull was told to slow down: every worker shares one pause (the time GitHub named, at least baseMs, longer each
 * time in a row), then the pull continues. Resolves true to ask again; false when it can't: Cancel, another profile
 * (`g`), or GitHub still saying so after SLOW.max pauses in a row. The status line counts down meanwhile.
 */
export function waitSlowDown(e, g, label) {
  if (!e?.secondary) return Promise.resolve(false);
  if (slowWait) return slowWait;
  if (slowStreak >= SLOW.max) { warn('budget', `${label}: GitHub still asks to slow down after ${SLOW.max} pauses in a row: stopping here, progress is kept`); return Promise.resolve(false); }
  const ms = Math.max((e.retryAfter || 0) * 1000, SLOW.baseMs * 2 ** slowStreak), until = Date.now() + ms;
  slowStreak++;
  const run = async () => {
    warn('budget', `${label}: GitHub asked to slow down (too many requests at once; the budget is not used up): pausing ${inTime(ms)}, then continuing with fewer requests at a time (pause ${slowStreak} of at most ${SLOW.max} in a row)`);
    while (Date.now() < until) {
      if (S.stop || g !== S.gen) return false;
      status(`⏸ ${label}: GitHub asked to slow down. Continuing automatically in ${inTime(until - Date.now())} · ■ Cancel to stop now, progress is saved`);
      await sleep(Math.min(1000, until - Date.now()));
    }
    return !(S.stop || g !== S.gen);
  };
  const p = slowWait = run().finally(() => { if (slowWait === p) slowWait = null; });
  return p;
}
/** Requests go through again: the next "slow down" starts from the short pause. */
export const slowDownOver = () => { slowStreak = 0; };

/** One line for logs and pull plans: "REST 1,204 / 5,000 left (refills at 18:47:42, in 52 s)". */
export function budgetLine(kind) {
  const b = budgetNow(kind);
  if (!b) return `${kindName(kind)}: not known yet`;
  return `${kindName(kind)} ${b.remaining.toLocaleString()} / ${b.limit.toLocaleString()} left${b.refilled ? ' (refilled)' : b.reset ? ` (refills at ${clock(b.reset)}, in ${inTime(b.reset * 1000 - Date.now())})` : ''}`;
}
