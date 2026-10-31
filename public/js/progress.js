// Progress of the running job, shown as a list of steps ("lanes"), one row each: a bar, the percentage, what is being
// counted, the elapsed time and an estimate of what is left. Steps are announced up front as "waiting" so the whole plan
// is visible (pull the stars → update details → download READMEs → check / releases / commits), and rows are redrawn
// at most every 60 ms plus every 0.5 s, so the numbers keep moving between server answers.
//
//   plan([[id, label], …])    announce the steps (all waiting)         start(id, total)      a step begins
//   report(id, done, total, detail)   progress (done may be fractional)   finish(id, note)    a step is complete
//   stopAll(stopped)          end the job: running steps become done / stopped      settle()   hide the panel soon
//   reset()                   hide the panel now
import {$, esc} from './util.js';
import {debug, info} from './log.js';

/** Default names of the steps; callers may pass their own label to start(). */
const LABELS = {stars: 'Pull the star list', details: 'Update repo details', readmes: 'Download READMEs',
  check: 'Check commits & releases', releases: 'Fetch release notes', commits: 'Fetch commit messages'};

const lanes = new Map();   // id → {label, state: 'waiting' | 'running' | 'done' | 'stopped', done, total, detail, t0, t1}
let redraw = null, ticker = null, hider = null;

const clock = () => Date.now();
/** 75 → "1m 15s", 4000 → "1h 07m" */
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;
}
/** Time left, from the average speed of this step so far; empty until there is something to base it on. */
export function eta(l, now = clock()) {
  const elapsed = (now - l.t0) / 1000;
  if (l.state !== 'running' || !(l.done > 0) || !(l.total > l.done) || elapsed < 2) return '';
  return `~${duration(elapsed / l.done * (l.total - l.done))} left`;
}

function row(id, l, n, now) {
  const known = l.total > 0, pct = l.state === 'done' ? 100 : known ? Math.min(100, Math.floor(l.done / l.total * 100)) : null;
  const bar = l.state === 'waiting' ? '<progress value="0" max="1"></progress>'
    : known || l.state === 'done' ? `<progress value="${l.state === 'done' ? 1 : l.done}" max="${l.state === 'done' ? 1 : l.total}" aria-label="${esc(l.label)}"></progress>`
    : `<progress aria-label="${esc(l.label)}"></progress>`;   // no total yet: an animated "working" bar
  const took = l.t0 ? duration(((l.t1 || now) - l.t0) / 1000) : '';
  const text = l.state === 'waiting' ? 'waiting' : [pct != null ? pct + '%' : '', l.detail, l.state === 'running' ? (took && 'elapsed ' + took) : took, eta(l, now), l.state === 'stopped' ? 'stopped, progress saved' : '']
    .filter(Boolean).join(' · ');
  return `<div class="lane ${l.state}" data-lane="${esc(id)}"><span class="lane-label"><b>${n}</b> ${esc(l.label)}</span>${bar}<span class="lane-text">${esc(text)}</span></div>`;
}
function draw() {
  const el = $('#lanes');
  if (!el) return;
  el.hidden = lanes.size === 0;
  if (!lanes.size) { el.innerHTML = ''; return; }
  const now = clock();
  el.innerHTML = [...lanes].map(([id, l], i) => row(id, l, i + 1, now)).join('');
  const running = [...lanes.values()].some(l => l.state === 'running');
  if (running && !ticker) { ticker = setInterval(draw, 500); ticker.unref?.(); }
  else if (!running && ticker) { clearInterval(ticker); ticker = null; }
}
function schedule() {
  if (redraw) return;
  redraw = setTimeout(() => { redraw = null; draw(); }, 60);
  redraw.unref?.();
}
const touch = () => { clearTimeout(hider); hider = null; schedule(); };
const lane = (id, label) => {
  if (!lanes.has(id)) lanes.set(id, {label: label || LABELS[id] || id, state: 'waiting', done: 0, total: 0, detail: '', t0: 0, t1: 0});
  return lanes.get(id);
};

export function plan(list) {
  lanes.clear();
  for (const [id, label] of list) lane(id, label);
  info('steps', `plan: ${[...lanes.values()].map((l, i) => (i + 1) + ' ' + l.label).join(' → ')}`);
  touch();
}
export function start(id, total = 0, label) {
  const l = lane(id, label);
  Object.assign(l, {state: 'running', done: 0, total, detail: '', t0: clock(), t1: 0, bucket: undefined});
  info('steps', '▶ step ' + ([...lanes.keys()].indexOf(id) + 1) + ' of ' + lanes.size + ': ' + l.label + (total ? ', ' + total.toLocaleString() + ' to do' : ''));
  touch();
}
export function report(id, done, total, detail) {
  const l = lane(id);
  if (l.state === 'waiting' || l.state === 'done') Object.assign(l, {state: 'running', t0: l.t0 || clock(), t1: 0});
  l.done = done;
  if (total != null) l.total = total;
  if (detail != null) l.detail = detail;
  const bucket = l.total > 0 ? Math.floor(l.done / l.total * 10) : -1;   // one line per 10 %, the panel shows the rest
  if (bucket >= 0 && bucket !== l.bucket) { l.bucket = bucket; debug('steps', l.label + ': ' + bucket * 10 + ' %' + (l.detail ? ' · ' + l.detail : '')); }
  touch();
}
export function finish(id, note) {
  const l = lane(id);
  if (!l.t0) l.t0 = clock();
  Object.assign(l, {state: 'done', t1: clock()});
  l.done = l.total || l.done;
  if (note != null) l.detail = note;
  info('steps', '✓ ' + l.label + (l.detail ? ': ' + l.detail : '') + ' (' + duration((l.t1 - l.t0) / 1000) + ')');
  touch();
}
/** The job is over: steps that were running are done (or stopped by Cancel); steps that never started disappear. */
export function stopAll(stopped = false) {
  for (const [id, l] of [...lanes]) {
    if (l.state === 'running') {
      Object.assign(l, {state: stopped ? 'stopped' : 'done', t1: clock()});
      info('steps', (stopped ? '■ ' : '• ') + l.label + ': ended at ' + (l.total ? l.done.toLocaleString() + ' of ' + l.total.toLocaleString() : l.done.toLocaleString()) + (stopped ? ' (Cancel: progress is kept, the next run continues)' : ' (anything left is retried at the next check)'));
    } else if (l.state === 'waiting') { lanes.delete(id); debug('steps', l.label + ': not needed this time'); }
  }
  info('steps', stopped ? '■ stopped by Cancel: what was done is kept, the next run continues from there' : 'job finished');
  touch();
}
/** Hides the panel now. */
export function reset() {
  clearTimeout(hider);
  hider = null;
  lanes.clear();
  draw();
}
/** Keeps the finished panel on screen a moment so the last numbers can be read, then hides it. */
export function settle(ms = 4000) {
  clearTimeout(hider);
  hider = setTimeout(reset, ms);
  hider.unref?.();
}
