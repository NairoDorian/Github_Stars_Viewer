// Tests for GitHub's budgets (budget.js): learned from every answer and from /rate_limit, clear messages with the exact
// refill time, and long pulls that wait for the refill instead of stopping.
import test from 'node:test';
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'localStorage', {value: {getItem: () => null, setItem() {}, removeItem() {}}, configurable: true});
const {S, nextGen} = await import('../public/js/state.js');
const {BUDGET, noteHeaders, setBudgets, budgetNow, limitMessage, rateLimitError, waitForRefill, budgetLine, inTime, TUNING} = await import('../public/js/budget.js');
const {fetchFiles} = await import('../public/js/files.js');

const now = () => Math.floor(Date.now() / 1000);
const hdrs = o => new Headers(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])));
const el = {value: '', checked: false, textContent: '', innerHTML: '', hidden: false, title: '', classList: {add() {}, remove() {}, toggle() {}}};

test('budgets are learned from answers and /rate_limit; an older answer never raises the count; an ended window counts as full', () => {
  for (const k of Object.keys(BUDGET)) delete BUDGET[k];
  const reset = now() + 1800;
  noteHeaders(hdrs({'x-ratelimit-remaining': 120, 'x-ratelimit-limit': 5000, 'x-ratelimit-used': 4880, 'x-ratelimit-reset': reset, 'x-ratelimit-resource': 'core'}));
  assert.deepEqual([BUDGET.core.remaining, BUDGET.core.limit, BUDGET.core.reset], [120, 5000, reset]);
  noteHeaders(hdrs({'x-ratelimit-remaining': 130, 'x-ratelimit-limit': 5000, 'x-ratelimit-reset': reset, 'x-ratelimit-resource': 'core'}));
  assert.equal(BUDGET.core.remaining, 120, 'answers arrive out of order: the lower count of the same window wins');
  noteHeaders(hdrs({'x-ratelimit-remaining': 4999, 'x-ratelimit-limit': 5000, 'x-ratelimit-reset': reset, 'x-ratelimit-resource': 'graphql'}));
  assert.equal(BUDGET.graphql.remaining, 4999, 'each kind has its own budget');
  // what other tabs or scripts used shows up at the first /rate_limit read
  setBudgets({core: {limit: 5000, remaining: 3100, used: 1900, reset}, search: {limit: 30, remaining: 30, used: 0, reset: now() + 60}});
  assert.deepEqual([BUDGET.core.remaining, BUDGET.search.limit], [3100, 30]);
  assert.match(budgetLine('core'), /^REST 3,100 \/ 5,000 left \(refills at .+, in 30 min\)$/);
  setBudgets({core: {limit: 5000, remaining: 0, used: 5000, reset: now() - 5}});
  assert.deepEqual([budgetNow('core').remaining, budgetNow('core').refilled], [5000, true], 'the window ended: full again');
  assert.deepEqual([inTime(52_000), inTime(14 * 60_000), inTime(62 * 60_000)], ['52 s', '14 min', '1 h 02 min']);
});

test('a used-up budget says which one, how big, and the exact refill time', () => {
  S.token = 'tok';
  const reset = now() + 52;
  const e = rateLimitError({headers: hdrs({'x-ratelimit-remaining': 0, 'x-ratelimit-limit': 5000, 'x-ratelimit-reset': reset, 'x-ratelimit-resource': 'core'})});
  assert.match(e.message, /^GitHub's REST budget is used up \(5,000 requests per hour\): it refills at .+ \(in 5\d s\)$/);
  assert.deepEqual([e.fatal, e.rateLimited, e.kind, e.reset], [true, true, 'core', reset]);
  S.token = '';
  assert.match(limitMessage('core'), /without a token; 5,000 with one/);
  setBudgets({graphql: {limit: 5000, remaining: 0, used: 5000, reset}});
  assert.match(limitMessage('graphql'), /GraphQL budget is used up \(5,000 points per hour\)/);
});

test('waiting for a refill: shared by every worker, stopped by Cancel, refused when over an hour away', async () => {
  globalThis.document = {querySelector: () => el};
  TUNING.marginMs = 0;
  try {
    const g = nextGen();
    const e = {rateLimited: true, kind: 'core', reset: Math.ceil(Date.now() / 1000) + 1};
    const [a, b] = [waitForRefill(e, g, 'test'), waitForRefill(e, g, 'test')];
    assert.equal(a, b, 'one wait for all the workers that hit the limit');
    assert.match(el.textContent, /⏸ test: GitHub's REST budget is used up .*Continuing automatically at/);
    assert.equal(await a, true);
    assert.equal(await waitForRefill({...e, reset: now() + 2 * 3600}, g, 'test'), false, 'more than an hour away: not waited for');
    assert.equal(await waitForRefill({message: 'other'}, g, 'test'), false);
    S.stop = true;
    assert.equal(await waitForRefill({...e, reset: now() + 30}, g, 'test'), false, 'Cancel ends the wait');
    S.stop = false;
  } finally { delete globalThis.document; TUNING.marginMs = 2000; S.stop = false; }
});

test('a file-list pull that runs out of budget waits for the refill and finishes, instead of stopping', async () => {
  globalThis.document = {querySelector: () => el};
  TUNING.marginMs = 0;
  const realFetch = globalThis.fetch;
  let left = 2, refusals = 0;
  const reset = Math.ceil(Date.now() / 1000) + 1;
  globalThis.fetch = async url => {
    const m = String(url).match(/repos\/(o\/r\d)\/git\/trees/);
    if (!m) return {ok: false, status: 404, headers: hdrs({}), json: async () => ({})};
    if (left <= 0 && Date.now() < reset * 1000) {
      refusals++;
      return {ok: false, status: 403, headers: hdrs({'x-ratelimit-remaining': 0, 'x-ratelimit-limit': 5000, 'x-ratelimit-reset': reset, 'x-ratelimit-resource': 'core'}), json: async () => ({})};
    }
    left--;
    return {ok: true, status: 200, headers: hdrs({etag: '"e"', 'x-ratelimit-remaining': Math.max(0, left), 'x-ratelimit-limit': 5000, 'x-ratelimit-reset': reset, 'x-ratelimit-resource': 'core'}),
      json: async () => ({tree: [{path: m[1] + '.stl', type: 'blob'}]})};
  };
  try {
    S.token = 'tok'; S.files = {};
    S.repos = [1, 2, 3, 4].map(i => ({id: i, full: 'o/r' + i, owner: 'o', name: 'r' + i, pushed: 'p', branch: 'main', topics: []}));
    const res = await fetchFiles(nextGen(), S.repos);
    assert.ok(refusals >= 1, 'the budget did run out');
    assert.equal(res.fatal, null, 'not a stop');
    assert.equal(Object.keys(S.files).length, 4, 'every repo listed after the refill');
  } finally { globalThis.fetch = realFetch; delete globalThis.document; TUNING.marginMs = 2000; S.token = ''; S.files = {}; S.repos = []; }
});
