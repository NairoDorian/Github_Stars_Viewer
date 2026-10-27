/* Commit messages and release notes: fetched for every starred repo so they can be searched ("Search in commits & releases").

  Needs a token (GraphQL). Per repo the cache keeps, newest first:
    c   [[oid10, unix seconds, message], …]    every commit message of the default branch (up to the commit cap)
    rel [[tag, name, unix seconds, notes, prerelease 0|1], …]    every published release (up to MAX_RELEASES, the newest 5,000)
  plus head (newest commit walked from), tail (oldest commit stored), done (history walked to its end), ro (the notes
  options the releases were fetched with), and relN / relTop / relAt (release count, newest release, when fetched), which
  tell whether the releases need fetching again.

  What is fetched, and when it is fetched again (first fetch and every later update use the same records):
   • Commits never change, so they are only ever added: a repo whose branch head moved is walked from the new head down to
     the first commit already stored ("join"), and only the new commits are added. If the stored commits are not found any
     more (history was rewritten) they are replaced by the new walk. An unfinished walk simply continues below its last
     stored commit.
   • Release notes can be edited, so a repo's releases are fetched again completely when their count, newest release
     (tag, created, updated) changed, or after 30 days. Stored notes are replaced, never merged.

  Work, cheapest first:
   1. Check (40 repos per call): head commit + date, the 5 newest releases, release count. Besides telling what changed,
      this refreshes every tile's "last commit" / "last release" (see parseLast in github.js).
   2. Releases of repos that changed (25 per page, several repos per call) and 3. commit messages (100 per page) are fetched
      at the same time from continuous work queues: a worker takes the next batch of pages as soon as it is free, so one
      slow or huge repo never holds the others back (no waiting for "rounds").
   A repo's pages are also fetched in parallel: after its first page says how many commits there are (totalCount), the
   other pages are requested with offset cursors ("<commit> <index>", the form GitHub's own cursors have), all pinned to
   the commit the walk started from. This is checked, never assumed: a page whose returned cursor doesn't match the
   offset asked for makes the repo fall back to one page at a time, from the last commit stored. Progress is saved as the
   contiguous run of commits grows, so a walk can be interrupted at any time (Cancel, rate limit, closed tab) and continue
   later. When GitHub says "slow down" (secondary rate limit) the run waits and continues with fewer parallel requests.
  Nothing is deleted before its replacement arrived; a failed or aborted run leaves what was stored.

  Options (the ▾ panel next to the Index button): release notes can have @mentions and/or links stripped, and the notes
  length and commits-per-repo caps can change. Stripping is applied to already stored notes without any request;
  going the other way (keeping what was stripped, a longer cap) marks the repos so their release notes are fetched again. */
import {S, rkey, bumpIndex} from './state.js';
import {$, DAY, status, secs, pool, chunks, sleep} from './util.js';
import {plan, start, report, finish} from './progress.js';
import {gqlRepos, isFatalError, needToken, parseLast} from './github.js';
import {saveHistory, saveStars, markHistory} from './store.js';
import {render, prepareHistorySearch} from './list.js';

export const DEFAULT_OPTS = {mentions: true, links: false, notes: 6_000, commits: 10_000};
export const MAX_COMMITS = DEFAULT_OPTS.commits, MAX_RELEASES = 5_000, MSG_CHARS = 400;
const HISTORY_MAX_AGE = 7 * DAY, RELEASES_MAX_AGE = 30 * DAY, SAVE_EVERY = 10_000;
const COMMIT_PAGE = 100, RELEASE_PAGE = 25;
/** Waiting time (ms) after GitHub says "slow down", times the attempt number. A knob so tests don't wait. */
export const TUNING = {slowDownMs: 15_000};
// Requests in flight at once / work items per request, per stage. Releases carry long texts, so fewer per call.
const CHECK_PARALLEL = 6, RELEASE_PARALLEL = 3, RELEASE_BATCH = 6, COMMIT_PARALLEL = 8, COMMIT_BATCH = 12;
const TILE_FIELDS = ['commitAt', 'release', 'releaseAt', 'releasePre', 'releaseLatest'];   // what parseLast() fills on a repo
const CHECK = 'defaultBranchRef{target{...on Commit{oid committedDate}}} latestRelease{tagName} ' +
  'releases(first:5,orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{tagName publishedAt createdAt updatedAt isPrerelease isDraft}}';

// ---------- options ----------
const OPT_KEY = 'starsViewer.histOpts';   // localStorage: a per-browser preference
let opts = null;
// A cap of 0 means "no limit" (entire release notes / every commit message); `lim` turns a cap into a number to compare with.
const UNLIMITED = 0;
export const lim = n => n > 0 ? n : Infinity;
const clamp = (v, lo, hi, d) => {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return d;
  return Number(v) === UNLIMITED ? UNLIMITED : Math.min(hi, Math.max(lo, Math.round(Number(v))));
};
const sanitize = o => ({mentions: !!(o.mentions ?? DEFAULT_OPTS.mentions), links: !!(o.links ?? DEFAULT_OPTS.links),
  notes: clamp(o.notes, 500, 10_000_000, DEFAULT_OPTS.notes), commits: clamp(o.commits, 100, 10_000_000, DEFAULT_OPTS.commits)});
export function histOpts() {
  if (!opts) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(OPT_KEY) || '{}') || {}; } catch {}
    opts = sanitize(saved);
  }
  return opts;
}
/** Forgets the in-memory copy so the next histOpts() re-reads localStorage (after "Clear cache" wiped it). */
export const forgetHistOpts = () => { opts = null; };
export function setHistOpts(patch) {
  opts = sanitize({...histOpts(), ...patch});
  try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch {}
  return opts;
}
/** What a release record was fetched with: "m" mentions stripped, "l" links stripped, then the notes length cap. */
export const optFlags = o => `${o.mentions ? 'm' : ''}${o.links ? 'l' : ''}:${o.notes}`;

// ---------- stripping @mentions and links from release notes ----------
const LOGIN = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
// A mention is "@login" not glued to a word, an e-mail address (a@b.c), a scoped package (@types/node) or a path.
const MENTION = new RegExp('(^|[^\\w@/.`-])@' + LOGIN + '(?![\\w@/-]|\\.\\w)', 'g');
const BY_MENTION = new RegExp('[ \\t]+by[ \\t]+@' + LOGIN + '(?![\\w@/-]|\\.\\w)', 'g');
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;   // code blocks and spans are never touched (`@Override`, `https://…` examples)
/** Applies fn to the text between code spans. */
const outsideCode = (text, fn) => text.split(CODE).map((part, i) => i % 2 ? part : fn(part)).join('');
/** Clean-up inside one text piece after something was removed: "( and )", double spaces, " ," */
const tidyPiece = s => s.replace(/\(\s*(?:(?:and|&|,)\s*)*\)/g, '').replace(/(\S)[ \t]{2,}/g, '$1 ').replace(/[ \t]+([,.;:!])/g, '$1');
const tidyWhole = s => s.replace(/[ \t]+$/gm, '').replace(/^[ \t]*[-*+][ \t]*$/gm, '').replace(/^\[[^\]]+\]:[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
function strip(text, fn) {
  let changed = false;
  const out = outsideCode(text, part => { const r = fn(part); if (r === part) return part; changed = true; return tidyPiece(r); });
  return changed ? tidyWhole(out) : text;
}
/** Removes @login mentions ("thanks @user", "by @user in …", "(@a and @b)"), keeping code, e-mails and scoped packages. */
export const stripMentions = text => strip(text, p => p.replace(BY_MENTION, '').replace(MENTION, '$1'));
/** Removes links: markdown links keep their text, images, <autolinks> and bare URLs go. */
export const stripLinks = text => strip(text, p => p.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<https?:\/\/[^>\s]+>/g, '').replace(/https?:\/\/[^\s)>\]"']+/g, ''));
/** Release notes as stored: line endings normalized, stripped as the options say, cut to the notes length cap. */
export function cleanNotes(text, o = histOpts()) {
  let t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (o.links) t = stripLinks(t);
  if (o.mentions) t = stripMentions(t);
  return o.notes > 0 ? t.slice(0, o.notes) : t;
}

// ---------- records ----------
const spread = r => ((r.id || 0) % 7) * DAY;
/** Whether the background check should look at this repo: never indexed, pushed since, unfinished, or checked long ago. */
export const needsHistory = r => {
  const h = S.history[rkey(r)];
  return !h || !h.done || h.pushed !== r.pushed || Date.now() - h.at > HISTORY_MAX_AGE + spread(r);
};
const blank = () => ({head: null, tail: null, c: [], rel: [], relN: -1, relTop: '', relAt: 0, done: false, capped: false, at: 0, pushed: null, ro: ''});
const set = (k, patch) => { S.history[k] = {...(S.history[k] || blank()), ...patch}; markHistory(k); };

/** GraphQL commit node → stored entry. Messages are trimmed and capped so the cache stays small. */
export const toCommit = n => [n.oid.slice(0, 10), Math.floor(Date.parse(n.committedDate) / 1000) || 0,
  String(n.message || '').replace(/\r\n?/g, '\n').trim().slice(0, MSG_CHARS)];
/** GraphQL release node → stored entry (the name is dropped when it only repeats the tag). */
const toRelease = (n, o = histOpts()) => [n.tagName, n.name && n.name !== n.tagName ? n.name : '',
  Math.floor(Date.parse(n.publishedAt || n.createdAt) / 1000) || 0, cleanNotes(n.description, o), n.isPrerelease ? 1 : 0];

export function historyTotals() {
  let commits = 0, releases = 0, repos = 0;
  for (const h of Object.values(S.history)) { commits += h.c?.length || 0; releases += h.rel?.length || 0; repos++; }
  return {commits, releases, repos};
}

/**
 * Are the stored releases still the repo's releases? Same count and same newest release (tag, created, updated). Records
 * written before `updatedAt` was tracked have a two-part key: they match on the two parts they have.
 */
const sameReleases = (rec, c) => rec.relN === c.relN &&
  (rec.relTop === c.relTop || (rec.relTop.split('|').length === 2 && c.relTop.startsWith(rec.relTop + '|')));

/**
 * Brings stored records in line with the options. Stripping more and shorter caps are applied to the stored text right
 * away (no request); keeping what was stripped or a longer cap can't be recovered locally, so those repos get their
 * release count reset and fetch release notes again at the next index. Returns counts for the options panel.
 */
export function reconcile(o = histOpts()) {
  const out = {stripped: 0, refetch: 0, trimmed: 0, restart: 0};
  const flags = optFlags(o);
  for (const [k, rec] of Object.entries(S.history)) {
    if (k.startsWith('_')) continue;
    const patch = {};
    const have = rec.ro ?? ':6000', capText = have.split(':')[1], haveCap = capText === undefined || capText === '' ? 6000 : Number(capText);
    const wasM = have.startsWith('m'), wasL = have.split(':')[0].includes('l');
    if (have !== flags && rec.rel?.length) {
      const truncated = rec.rel.some(x => x[3].length >= lim(haveCap));
      if ((!o.mentions && wasM) || (!o.links && wasL) || (lim(o.notes) > lim(haveCap) && truncated)) {
        patch.relN = -1; patch.ro = have; patch.at = 0; out.refetch++;   // fetched again, with the new options, at the next check
      } else {
        patch.rel = rec.rel.map(x => [x[0], x[1], x[2], cleanNotes(x[3], o), x[4]]);
        patch.ro = flags; out.stripped++;
      }
    } else if (have !== flags) patch.ro = flags;
    if (rec.c?.length > lim(o.commits)) { patch.c = rec.c.slice(0, o.commits); patch.capped = true; patch.done = true; out.trimmed++; }
    else if (rec.capped && rec.done && lim(o.commits) > rec.c.length) { delete S.history[k]; markHistory(k); out.restart++; continue; }
    if (Object.keys(patch).length) { S.history[k] = {...rec, ...patch}; markHistory(k); }
  }
  if (out.stripped || out.refetch || out.trimmed || out.restart) bumpIndex();
  return out;
}

/**
 * One page of a "join" walk: the branch head moved and commits are stored already, so walk down from the new head until a
 * stored commit shows up. `item` = {k, old (the stored record), known (Set of its oid10s), fresh, head, from, lastOid}.
 * Returns 'more' (ask for the next page, starting at item.from), 'resume' (joined the stored history, which itself is
 * unfinished: continue below it with a bulk walk) or 'done'.
 */
export function advance(item, nodes, hasNext) {
  const {k, old} = item, max = lim(histOpts().commits);
  let list = nodes;
  if (item.from && list[0]?.oid === item.from) list = list.slice(1);   // pages start at the commit the last page ended on
  if (!item.head && nodes[0]) item.head = nodes[0].oid;
  let found = null;
  for (const n of list) {
    const e = toCommit(n);
    if (item.known.has(e[0])) { found = e[0]; break; }
    item.fresh.push(e);
    item.lastOid = n.oid;
  }
  if (found) {   // joined the stored history: new commits + everything stored from the join on
    const c = item.fresh.concat(old.c.slice(old.c.findIndex(e => e[0] === found))), capped = c.length > max;
    set(k, {head: item.head, tail: old.tail, c: c.slice(0, max), capped: old.capped || capped, done: old.done || capped});
    return S.history[k].done ? 'done' : 'resume';
  }
  const capped = item.fresh.length >= max;
  if (!hasNext || capped) {   // no join point: the walk covered everything (history was rewritten), replace what was stored
    set(k, {head: item.head, tail: item.lastOid || old.tail, c: item.fresh.slice(0, max), capped, done: true});
    return 'done';
  }
  item.from = item.lastOid;
  return 'more';
}

// ---------- one run: shared plumbing ----------
/** State shared by the stages of one syncHistory run. `fatal` is set by a token / rate-limit error. */
const newRun = g => ({g, o: {...histOpts()}, fatal: null, skipped: 0, lastSave: Date.now(), slotCap: Infinity, beforeSave: null});
const halted = run => run.fatal || S.stop || run.g !== S.gen;
/** [owner, name] of a work item that has a .job (releases) or an .item with a .job (commits). */
const jobRepo = t => { const r = (t.job || t.item.job).r; return [r.owner, r.name]; };
/** Stops the run on token / rate-limit errors; any other error is the caller's to handle. */
const fatalOnly = (run, e) => isFatalError(e) && (run.fatal = e);
/** Puts a failed work item back in the queue; after 3 failures `giveUp` decides (the repo is left for the next check). */
const retry = (t, queue, giveUp) => { if ((t.tries = (t.tries || 0) + 1) < 3) queue.push(t); else giveUp(t); };

/** Saves progress at most every SAVE_EVERY ms (always when asked): stopping or closing the tab loses seconds, not minutes. */
async function flush(run, always = false) {
  if (run.g !== S.gen || (!always && Date.now() - run.lastSave < SAVE_EVERY)) return;
  run.lastSave = Date.now();
  run.beforeSave?.();   // walks that keep commits aside while pages arrive write them into their records first
  bumpIndex();
  await saveHistory(run.g);
}

/**
 * gqlRepos with patience for GitHub's secondary rate limit ("slow down"): wait, allow fewer parallel requests for the rest
 * of the run, try again. Primary limits and bad tokens are not retried here (they end the run).
 */
async function gqlRun(run, items, fields, nameOf) {
  for (let attempt = 0; ; attempt++) {
    try { return await gqlRepos(items, fields, nameOf); }
    catch (e) {
      if (!e.secondary || attempt >= 3 || halted(run)) throw e;
      run.slotCap = Math.max(1, Math.floor(Math.min(run.slotCap, 8) / 2));
      const wait = TUNING.slowDownMs * (attempt + 1);
      status(`GitHub asked to slow down: waiting ${Math.round(wait / 1000)} s, then continuing with fewer parallel requests…`);
      for (let waited = 0; waited < wait && !halted(run); waited += 500) await sleep(Math.min(500, wait - waited));   // Cancel ends the wait
      if (halted(run)) throw e;
    }
  }
}

/**
 * Works through a queue of tasks, `batch` per request with up to `parallel` requests in flight (fewer after a slow-down).
 * `handle(tasks)` fetches them and pushes follow-up tasks (the next page, a retry) onto the queue. There are no rounds:
 * a worker takes the next batch the moment it is free. Ends when the queue is empty and nothing is in flight, or when
 * the run is halted (cancel, fatal error, another profile).
 */
async function pump(run, queue, {parallel, batch}, handle) {
  let inFlight = 0, waiting = [];
  const wake = () => { const w = waiting; waiting = []; w.forEach(resolve => resolve()); };
  const worker = async () => {
    for (;;) {
      if (halted(run) || (!queue.length && !inFlight)) return;
      if (!queue.length || inFlight >= Math.min(parallel, run.slotCap)) { await new Promise(resolve => waiting.push(resolve)); continue; }
      const tasks = queue.splice(0, batch);
      inFlight++;
      try { await handle(tasks); } finally { inFlight--; wake(); }
    }
  };
  await Promise.all(Array.from({length: parallel}, worker));
}

// ---------- stage 1: check ----------
/** One cheap call per 40 repos. Returns Map(repo → {head, relN, relTop}) and refreshes each tile's last commit / last
 *  release from the same answer (a missing commit date never erases a known one). */
async function checkStage(run, todo) {
  const checks = new Map();
  let checked = 0, tiles = 0;
  start('check', todo.length);
  await pool(chunks(todo, 40), CHECK_PARALLEL, async batch => {
    if (halted(run)) return;
    let data;
    try { data = await gqlRun(run, batch, CHECK); }
    catch (e) { if (!fatalOnly(run, e)) run.skipped += batch.length; return; }
    batch.forEach((r, j) => {
      const d = data['r' + j];
      if (!d) { run.skipped++; return; }   // GitHub omitted it (private, deleted, timeout): retried next check
      const top = d.releases?.nodes?.[0], head = d.defaultBranchRef?.target?.oid || null;
      checks.set(r, {head, relN: d.releases?.totalCount || 0, relTop: top ? `${top.tagName}|${top.createdAt}|${top.updatedAt || ''}` : ''});
      const last = parseLast({lastCommit: d.defaultBranchRef, releases: d.releases, latestRelease: d.latestRelease});
      if (!last.commitAt && head) last.commitAt = r.commitAt ?? null;
      if (TILE_FIELDS.some(f => (r[f] ?? null) !== last[f])) { Object.assign(r, last); tiles++; }
    });
    checked += batch.length;
    if (run.g === S.gen) {
      status(`Checking commits & releases ${checked}/${todo.length}…`);
      report('check', checked, todo.length, `${checked.toLocaleString()} of ${todo.length.toLocaleString()} repos`);
    }
  });
  if (checked === todo.length) finish('check');
  if (tiles && run.g === S.gen) await saveStars(run.g);
  return checks;
}

/** Decides per repo what is missing. Repos with nothing to do are stamped as checked right away. */
function planStage(checks) {
  const jobs = [], now = Date.now();
  for (const [r, c] of checks) {
    const k = rkey(r), rec = S.history[k];
    const needRel = !rec || !sameReleases(rec, c) || now - (rec.relAt || rec.at || 0) > RELEASES_MAX_AGE + spread(r);
    const job = {r, k, c, failed: false, needRel,
      needNew: !!c.head && (!rec || rec.head !== c.head), needOld: !!c.head && !!rec && rec.head === c.head && !rec.done};
    if (!c.head && !rec?.done) set(k, {head: null, tail: null, c: [], done: true});   // empty repository
    if (job.needRel || job.needNew || job.needOld) { jobs.push(job); continue; }
    Object.assign(S.history[k], {at: now, pushed: r.pushed, relTop: c.relTop});   // relTop: upgrades a key from before updatedAt
    markHistory(k);
  }
  return jobs;
}

// ---------- stage 2: releases ----------
/** Every release of the repos whose release list changed, 25 per page, notes cleaned as the options say. Returns how many
 *  repos are unfinished. */
async function releaseStage(run, jobs) {
  const flags = optFlags(run.o);
  const page = t => `releases(first:${RELEASE_PAGE},${t.after ? `after:${JSON.stringify(t.after)},` : ''}orderBy:{field:CREATED_AT,direction:DESC})` +
    '{pageInfo{hasNextPage endCursor} nodes{tagName name description createdAt publishedAt isPrerelease isDraft}}';
  const queue = jobs.filter(j => j.needRel).map(job => ({job, after: null, nodes: []}));
  const total = queue.length, giveUp = t => { t.job.failed = true; };
  let done = 0;
  if (total) start('releases', total); else finish('releases', 'no release list changed');
  await pump(run, queue, {parallel: RELEASE_PARALLEL, batch: RELEASE_BATCH}, async batch => {
    let data;
    try { data = await gqlRun(run, batch, page, jobRepo); }
    catch (e) { if (!fatalOnly(run, e)) for (const t of batch) retry(t, queue, giveUp); return; }
    if (run.g !== S.gen) return;
    batch.forEach((t, j) => {
      const rel = data['r' + j]?.releases;
      if (!rel) return retry(t, queue, giveUp);
      t.tries = 0;
      t.nodes.push(...rel.nodes.filter(n => !n.isDraft));
      if (rel.pageInfo.hasNextPage && t.nodes.length < MAX_RELEASES) { t.after = rel.pageInfo.endCursor; queue.push(t); return; }
      set(t.job.k, {rel: t.nodes.slice(0, MAX_RELEASES).map(n => toRelease(n, run.o)), relN: t.job.c.relN, relTop: t.job.c.relTop, relAt: Date.now(), ro: flags});
      done++;
    });
    status(`Fetching release notes… ${done}/${total} repos`);
    report('releases', done, total, `${done.toLocaleString()} of ${total.toLocaleString()} repos`);
    await flush(run);
  });
  if (total && done === total) finish('releases');
  return total - done;
}

// ---------- stage 3: commit messages ----------
/** One page of commits starting at commit `t.oid` (or after cursor `t.after`); `t.total` also asks for the commit count. */
const commitPage = t => `object(expression:${JSON.stringify(t.oid)}){...on Commit{history(first:${COMMIT_PAGE}` +
  `${t.after ? `,after:${JSON.stringify(t.after)}` : ''}){${t.total ? 'totalCount ' : ''}pageInfo{hasNextPage endCursor} nodes{oid committedDate message}}}}`;

/** A walker is one repo's commit walk: 'join' (head moved, stored commits exist: see advance) or 'bulk' (everything below
 *  `start` stored commits, from the commit `base`: a first walk, or the rest of an unfinished one). */
function newWalker(job) {
  const rec = S.history[job.k], w = {job, k: job.k, over: false, dead: false};
  if (job.needNew && rec?.c.length) return Object.assign(w, {kind: 'join', old: rec, known: new Set(rec.c.map(e => e[0])), fresh: [], head: null, from: null, lastOid: null});
  return startBulk(w, job.c.head, job.needNew ? 0 : rec.c.length);
}
const startBulk = (w, base, start) => Object.assign(w, {kind: 'bulk', base, start, count: start, next: start, want: Infinity, total: null,
  fast: false, pages: new Map(), acc: [], lastOid: null, done: false, capped: false, final: false, gen: (w.gen || 0) + 1});
const firstTask = w => w.kind === 'join' ? {item: w, oid: w.job.c.head, after: null}
  : {item: w, oid: w.base, after: w.start ? `${w.base} ${w.start - 1}` : null, off: w.start, first: true, total: true, gen: w.gen};
/** Next page one at a time: below the last commit stored, or from the start when none is. */
const seqTask = w => {
  const from = w.lastOid ?? (w.start ? S.history[w.k].tail : null);
  return from ? {item: w, oid: from, skip: true, off: w.next, seq: true, gen: w.gen} : {item: w, oid: w.base, off: w.next, seq: true, gen: w.gen};
};
/** Writes the commits collected so far into the record (a contiguous run below what was already stored). */
function syncRecord(w) {
  if (w.kind !== 'bulk' || w.final || (!w.acc.length && !w.done)) return;
  const rec = S.history[w.k];
  set(w.k, {head: w.base, tail: w.lastOid ?? rec?.tail ?? null, c: (rec?.c ?? []).concat(w.acc), done: w.done, capped: w.capped});
  w.acc = [];
  if (w.done) w.final = true;
}

/** Fetches the commit messages of the repos in `jobs`. Returns how many repos are unfinished. */
/** How far along a walker is, 0..1: the share of its commits stored, so the bar moves page by page (big repos weigh what they cost). */
const fractionOf = w => w.over ? 1 : w.kind === 'bulk' && Number.isFinite(w.want) && w.want > 0 ? Math.min(0.99, w.count / w.want) : 0;

async function commitStage(run, jobs) {
  const items = jobs.filter(j => j.needNew || j.needOld).map(newWalker), queue = items.map(firstTask);
  const total = items.length, t0 = Date.now(), c0 = historyTotals().commits;
  let finished = 0;
  if (total) start('commits', total); else finish('commits', 'no new commits');
  const finishWalk = w => { if (!w.over) { w.over = true; finished++; } };
  const abandon = t => { const w = t.item; w.dead = true; w.job.failed = true; w.pages?.clear(); syncRecord(w); };
  run.beforeSave = () => items.forEach(syncRecord);

  /** Moves the contiguous pages that have arrived into the walker's collected commits; finishes it when done or capped. */
  const drain = w => {
    while (!w.done && w.pages.has(w.next)) {
      const pg = w.pages.get(w.next);
      w.pages.delete(w.next);
      const nodes = pg.skip ? pg.nodes.slice(1) : pg.nodes, room = w.want - w.count;
      const take = nodes.length > room ? nodes.slice(0, room) : nodes;
      for (const n of take) w.acc.push(toCommit(n));
      if (take.length) w.lastOid = take.at(-1).oid;
      w.count += take.length;
      w.next = w.count;
      if (!pg.hasNext || w.count >= w.want) { w.done = true; w.capped = pg.hasNext && w.count >= w.want; }
    }
    if (w.done) { w.pages.clear(); syncRecord(w); finishWalk(w); }
  };

  const bulkPage = (t, h) => {
    const w = t.item;
    if (w.dead || t.gen !== w.gen) return;   // an answer from before a fallback
    const nodes = h.nodes, hasNext = h.pageInfo.hasNextPage;
    // The offset trick is trusted only while GitHub's own cursor for this page equals the one we would build for it.
    const cursorOk = !t.seq && h.pageInfo.endCursor === `${w.base} ${t.off + nodes.length - 1}`;
    if (t.first) {
      if (t.off > 0 && !cursorOk) { w.gen++; queue.push(seqTask(w)); return; }   // resumed with a cursor we built and GitHub didn't confirm
      w.fast = cursorOk;
      w.total = h.totalCount ?? null;
      w.want = w.fast && w.total != null ? Math.min(w.total, lim(run.o.commits)) : lim(run.o.commits);
      if (w.fast) for (let off = t.off + COMMIT_PAGE; off < w.want; off += COMMIT_PAGE) queue.push({item: w, oid: w.base, after: `${w.base} ${off - 1}`, off, gen: w.gen});
    } else if (!t.seq && !cursorOk) {   // a parallel page disagreed about offsets: distrust them all, go on one page at a time
      w.fast = false; w.gen++; w.pages.clear();
      queue.push(seqTask(w));
      return;
    }
    w.pages.set(t.off, {nodes, hasNext, skip: !!t.skip});
    drain(w);
    if (!w.fast && !w.done) queue.push(seqTask(w));
  };

  const joinPage = (t, h) => {
    const w = t.item, next = advance(w, h.nodes, h.pageInfo.hasNextPage);
    if (next === 'more') queue.push({item: w, oid: w.from, after: null});
    else if (next === 'resume') { startBulk(w, w.head, S.history[w.k].c.length); queue.push(firstTask(w)); }
    else finishWalk(w);
  };

  await pump(run, queue, {parallel: COMMIT_PARALLEL, batch: COMMIT_BATCH}, async batch => {
    const live = batch.filter(t => !t.item.dead);
    if (!live.length) return;
    let data;
    try { data = await gqlRun(run, live, commitPage, jobRepo); }
    catch (e) { if (!fatalOnly(run, e)) for (const t of live) retry(t, queue, abandon); return; }
    if (run.g !== S.gen) return;
    live.forEach((t, j) => {
      const h = data['r' + j]?.object?.history;
      if (!h) return retry(t, queue, abandon);   // after 3 tries the repo keeps what is stored and is retried at the next check
      t.tries = 0;
      if (t.item.kind === 'join') joinPage(t, h); else bulkPage(t, h);
    });
    const pending = items.reduce((n, w) => n + (w.acc?.length || 0), 0), commits = historyTotals().commits + pending;
    const rate = Math.round((commits - c0) / Math.max(1, (Date.now() - t0) / 1000));
    report('commits', items.reduce((n, w) => n + fractionOf(w), 0), total,
      `${finished.toLocaleString()} of ${total.toLocaleString()} repos · ${commits.toLocaleString()} commits · ${rate.toLocaleString()}/s`);
    status(`Indexing commit messages… ${finished}/${total} repos done · ${commits.toLocaleString()} commits indexed · ${rate.toLocaleString()} commits/s`);
    await flush(run);
  });
  items.forEach(syncRecord);   // a halted walk keeps the commits it already has (the next run continues below them)
  if (total && finished === total) finish('commits');
  return items.filter(w => !w.over).length;
}

// ---------- the run ----------
/**
 * Brings commit messages and release notes of `repos` up to date. `force` checks every repo (the toolbar button);
 * otherwise only repos that need it (see needsHistory) are looked at. Returns {summary}.
 */
export async function syncHistory(g, repos, {force = false} = {}) {
  if (!S.token) return {summary: 'commits & releases need a token'};
  const run = newRun(g);
  reconcile(run.o);   // options changed since the records were written? apply what can be applied locally
  const todo = force ? repos : repos.filter(needsHistory);
  if (!todo.length) return {summary: 'commits & releases up to date (0 requests)'};

  const checks = await checkStage(run, todo);
  if (g !== S.gen) return {summary: ''};
  const jobs = planStage(checks);
  const left = await Promise.all([releaseStage(run, jobs), commitStage(run, jobs)]);   // the two stages run at the same time
  if (g !== S.gen) return {summary: ''};

  // A repo is marked as checked only when every part of it succeeded; anything else is looked at again next time.
  const stamp = Date.now();
  let failed = 0;
  for (const j of jobs) {
    if (j.failed) failed++;
    else if (!run.fatal && S.history[j.k]?.done) { Object.assign(S.history[j.k], {at: stamp, pushed: j.r.pushed}); markHistory(j.k); }
  }
  await flush(run, true);
  const t = historyTotals(), skipped = run.skipped + failed;
  return {summary: `🔎 ${t.commits.toLocaleString()} commit messages and ${t.releases.toLocaleString()} releases indexed in ${t.repos} repos` +
    (jobs.length ? ` (${jobs.length} updated)` : ' (all up to date)') +
    (skipped ? ` · ${skipped} skipped (GitHub omitted results or timed out; retried next check)` : '') +
    (S.stop && (left[0] || left[1]) ? ' · ■ stopped, progress saved: click again to continue' : '') +
    (run.fatal ? ` · ⚠ ${run.fatal.message} (progress saved, click again to continue)` : '')};
}

/** Toolbar button: index (or re-check) commits and releases of every starred repo, then turn on the search option. */
export async function indexHistory(g) {
  if (!S.token) { needToken(); return status('⚠ Commits & releases need a token (GraphQL). Add one in the 🔑 panel.'); }
  const t0 = performance.now();
  status('Checking commits & releases…');
  plan([['check'], ['releases'], ['commits']]);
  const {summary} = await syncHistory(g, S.repos, {force: true});
  if (g !== S.gen) return;
  $('#inHistory').checked = true;
  bumpIndex();
  await prepareHistorySearch();
  render();
  status(`${summary} · ${secs(t0)}`);
}
