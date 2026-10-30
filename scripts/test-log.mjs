// Tests for the activity log (log.js) and what the app writes into it.
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)},
  configurable: true,
});
const els = {};
const el = sel => (els[sel] ??= {value: '', checked: false, textContent: '', innerHTML: '', hidden: false, scrollTop: 0, scrollHeight: 1000, clientHeight: 200,
  classList: {on: false, toggle(_, f) { this.on = f; }, add() { this.on = true; }, remove() { this.on = false; }, contains() { return this.on; }},
  setAttribute() {}, addEventListener() {}});
globalThis.document = {querySelector: el};
globalThis.window = {dispatchEvent() {}};
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };

const {log, debug, info, warn, error, entries, text, clearLog, LOG, stamp, bytes, names, initLog} = await import('../public/js/log.js');
const {S} = await import('../public/js/state.js');
const {ghFetch, gql} = await import('../public/js/github.js');
const {status} = await import('../public/js/util.js');
const later = ms => new Promise(r => setTimeout(r, ms));

test('every line has a time, a level, an area and the text; the log can be read back as plain text', () => {
  clearLog();
  info('sync', 'first');
  warn('http', 'second');
  debug('store', 'third');
  error('task', 'fourth');
  assert.deepEqual(entries().map(e => [e.level, e.area, e.text]), [['info', 'sync', 'first'], ['warn', 'http', 'second'], ['debug', 'store', 'third'], ['error', 'task', 'fourth']]);
  const lines = text().trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^\d\d:\d\d:\d\d\.\d{3} INFO  \[sync\] first$/);
  assert.match(lines[3], /^\d\d:\d\d:\d\d\.\d{3} ERROR \[task\] fourth$/);
  assert.equal(stamp(new Date(2026, 0, 2, 3, 4, 5, 6).getTime()), '03:04:05.006');
  assert.deepEqual([bytes(900), bytes(2048), bytes(5 * 1048576)], ['900 B', '2.0 KB', '5.0 MB']);
  assert.equal(names(['a', 'b', 'c'], 2), 'a, b and 1 more');
});

test('the log keeps the newest lines only, so a long index run can not eat memory', () => {
  clearLog();
  const capacity = LOG.capacity;
  LOG.capacity = 50;
  try {
    for (let i = 0; i < 2000; i++) log('x', 'line ' + i);
    assert.ok(entries().length <= 550, 'trimmed in chunks: ' + entries().length);
    assert.equal(entries().at(-1).text, 'line 1999');
    assert.ok(entries().length >= 50);
  } finally { LOG.capacity = capacity; clearLog(); }
});

test('the panel escapes text, shows the newest lines, and the detail switch hides the fine print', async () => {
  clearLog();
  initLog();
  info('sync', '<script>alert(1)</script> & more');
  debug('http', 'GET /user → 200');
  await later(180);
  const html = els['#conBody'].innerHTML;
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more') && !html.includes('<script>'));
  assert.ok(html.includes('GET /user → 200'), 'detail is on by default: every request is there');
  assert.match(els['#conCount'].textContent, /2 lines/);
  els['#conDebug'].onchange({target: {checked: false}});
  await later(180);
  assert.ok(!els['#conBody'].innerHTML.includes('GET /user') && els['#conBody'].innerHTML.includes('more'), 'detail off: only info, warnings and errors');
  els['#conDebug'].onchange({target: {checked: true}});
  els['#conClear'].onclick();
  assert.equal(els['#conBody'].innerHTML, '');
});

test('status messages reach the log, but a progress counter does not flood it', () => {
  clearLog();
  status('Checked 1/100 changed repos…');
  status('Checked 2/100 changed repos…');
  status('Checked 3/100 changed repos…');
  status('⚠ Something went wrong');
  status('⚠ Something went wrong');   // the very same text again (a repeating progress message) is not written twice
  assert.deepEqual(entries().map(e => [e.level, e.area, e.text]), [['info', 'status', 'Checked 1/100 changed repos…'], ['warn', 'status', '⚠ Something went wrong']]);
});

test('every request is logged with its answer, duration and rate-limit budget, and the token is NEVER written', async () => {
  clearLog();
  const SECRET = 'ghp_TopSecretToken1234567890';
  const realFetch = globalThis.fetch;
  S.token = SECRET;
  const answer = (status, headers = {}, body = {}) => async () => ({ok: status < 300, status, headers: new Headers(headers), json: async () => body});
  try {
    globalThis.fetch = answer(200, {'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-resource': 'core'});
    await ghFetch('/user', {headers: {Authorization: 'Bearer ' + SECRET}});
    globalThis.fetch = answer(304, {'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000'});
    await ghFetch('/users/x/starred?per_page=100&page=2', {headers: {Authorization: 'Bearer ' + SECRET}});
    globalThis.fetch = answer(200, {'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000', 'x-ratelimit-resource': 'graphql'}, {data: {r0: null, r1: {}}});
    await gql('query{r0:repository(owner:"o",name:"gone"){id} r1:repository(owner:"o",name:"here"){id}}', '2 repositories');
    globalThis.fetch = answer(403, {'x-ratelimit-remaining': '0', 'retry-after': '120'});
    await ghFetch('/repos/o/r', {headers: {Authorization: 'Bearer ' + SECRET}});
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(ghFetch('/user', {}, 1));
    const t = text();
    assert.ok(!t.includes(SECRET) && !t.includes('Bearer'), 'no token, no authorization header, anywhere in the log');
    assert.match(t, /\[http\] GET \/user → 200 in \d+ ms · core budget 4,999\/5,000 left/);
    assert.match(t, /GET \/users\/x\/starred\?per_page=100&page=2 → 304 not modified \(free\)/);
    assert.match(t, /POST \/graphql \(2 repositories\) → 200 in \d+ ms · graphql budget 4,990\/5,000 left/);
    assert.match(t, /WARN  \[http\] GET \/repos\/o\/r → 403 in \d+ ms · api budget 0 left, retry-after 120 s/);
    assert.match(t, /ERROR \[http\] GET \/user failed after 1 tries: offline/);
  } finally { globalThis.fetch = realFetch; S.token = ''; clearLog(); }
});

test('GraphQL says which repositories came back empty', async () => {
  clearLog();
  const {gqlRepos} = await import('../public/js/github.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ok: true, status: 200, headers: new Headers(), json: async () => ({data: {r0: {id: 1}, r1: null, r2: null}})});
  try {
    await gqlRepos([{owner: 'a', name: 'ok'}, {owner: 'b', name: 'private-now'}, {owner: 'c', name: 'deleted'}], 'id');
    assert.match(text(), /2 of 3 repositories came back empty \(private, deleted, or GitHub timed out\): b\/private-now, c\/deleted/);
  } finally { globalThis.fetch = realFetch; clearLog(); }
});

test('a step that is still open when the job ends says where it stopped, and steps that were not needed say so', async () => {
  const {plan, start, report, finish, stopAll, reset} = await import('../public/js/progress.js');
  clearLog();
  plan([['stars'], ['details'], ['commits']]);
  start('stars', 2); finish('stars', '2 pages');
  start('details', 85); report('details', 55, 85, '55 of 85 repos');   // 30 repos failed: the step never reaches its end
  stopAll(false);
  const t = text();
  assert.match(t, /\[steps\] plan: Pull the star list → Update repo details → Fetch commit messages/);
  assert.match(t, /\[steps\] ✓ Pull the star list: 2 pages/);
  assert.match(t, /\[steps\] • Update repo details: ended at 55 of 85 \(anything left is retried at the next check\)/);
  assert.match(t, /\[steps\] Fetch commit messages: not needed this time/);
  clearLog(); plan([['x']]); start('x', 10); report('x', 4, 10); stopAll(true);
  assert.match(text(), /■ x: ended at 4 of 10 \(Cancel: progress is kept, the next run continues\)/);
  reset(); clearLog();
});
