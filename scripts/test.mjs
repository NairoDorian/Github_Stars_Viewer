// Zero-dependency unit tests for Stars Viewer core modules (Node 18+ built-in test runner).
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v))},
  configurable: true,
});

const {esc, safeUrl, fmtN, ago, tally, chunks, pool, sleep, DAY} = await import('../public/js/util.js');
const {S, rkey, readmeLower, starredSet, starredIds, nextGen, genSignal} = await import('../public/js/state.js');
const {sortRepos} = await import('../public/js/sort.js');
const {languageShares, activityNow, recordStars, starGains, gitSha, gql, ghSearch, isFatalError, ACTIVITY_BUCKETS, ACTIVITY_SPAN} = await import('../public/js/github.js');
const {curveFor, drawableCurve, starsAt, parseStarHistorySvg, loadCurve, pruneCurves, forgetStarCharts, TUNING: STAR_TUNING} = await import('../public/js/starhistory.js');
const {detectThemes, keywordMembers, collector, pruneResults} = await import('../public/js/discover.js');
const {migrateReadmes, needsEnrich, needsReadme} = await import('../public/js/sync.js');
const {card, languagesHTML, activityHTML, parseQuery, match} = await import('../public/js/list.js');
import {spawn} from 'node:child_process';
import {rmSync, readFileSync, writeFileSync, mkdtempSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// github.js asks the page to show the token panel with a window event; starhistory.js announces loaded charts the same way.
globalThis.window ??= {dispatchEvent() {}};
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };   // Node 18 has none

test('util: esc, safeUrl, fmtN, ago, tally, chunks, pool, sleep', async () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeUrl('http://example.com'), 'http://example.com');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,hi'), '');

  assert.equal(fmtN(0), '0');
  assert.equal(fmtN(999), '999');
  assert.equal(fmtN(1500), '1.5k');
  assert.equal(fmtN(12400), '12k');
  assert.equal(fmtN(1_250_000), '1.3M');
  assert.equal(fmtN(NaN), '0');
  assert.equal(fmtN(-1500), '-1.5k', 'negative counts (stars lost) are abbreviated too');
  assert.equal(fmtN(-12), '-12');
  assert.equal(fmtN(-2_000_000), '-2.0M');

  assert.equal(ago(null), '—');
  assert.equal(ago(Date.now() - 5000), 'just now');
  assert.equal(ago(Date.now() - 3 * DAY), '3d ago');

  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(tally([{a: ['x', 'y']}, {a: ['x']}], r => r.a), [['x', 2], ['y', 1]]);

  const seen = [];
  await pool([1, 2, 3, 4], 2, async x => { seen.push(x); });
  assert.deepEqual(seen.sort(), [1, 2, 3, 4]);

  // sleep wakes immediately when signal aborts
  const ctrl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctrl.abort(), 15);
  await sleep(5000, ctrl.signal);
  assert.ok(Date.now() - t0 < 1000, 'sleep should abort early');

  // ...and a sleep that simply ends removes its abort listener (one signal lives through a whole index run)
  const sig = new AbortController().signal, counts = {add: 0, remove: 0};
  const add = sig.addEventListener.bind(sig), remove = sig.removeEventListener.bind(sig);
  sig.addEventListener = (...a) => { counts.add++; return add(...a); };
  sig.removeEventListener = (...a) => { counts.remove++; return remove(...a); };
  await sleep(1, sig); await sleep(1, sig);
  assert.deepEqual(counts, {add: 2, remove: 2});

  // pool: once a call fails, no new item is started (e.g. the remaining star-list pages after a rate limit)
  let started = 0;
  await assert.rejects(pool([1, 2, 3, 4, 5, 6], 2, async x => { started++; if (x === 1) throw new Error('boom'); await sleep(5); }), /boom/);
  await sleep(40);
  assert.equal(started, 2, 'only the call already in flight finished');
});

test('token: whitespace from copying is dropped; a character no GitHub token has is refused instead of breaking every request', async () => {
  const {cleanToken} = await import('../public/js/token.js');
  assert.deepEqual(cleanToken('  ghp_abc123\r\n'), {token: 'ghp_abc123'});
  assert.deepEqual(cleanToken('github_pat_11AB\n_cd'), {token: 'github_pat_11AB_cd'});
  assert.deepEqual(cleanToken(''), {token: ''});
  for (const bad of ['ghp_…', 'ghp_ab​cd', 'tökén']) {
    const r = cleanToken(bad);
    assert.equal(r.token, '');
    assert.match(r.error, /Paste it again/, JSON.stringify(bad));
  }
});

test('github: search pages are asked for up to the 1000th result, not beyond', async () => {
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => { asked++; return {ok: true, status: 200, headers: new Headers(), json: async () => ({items: [{full_name: 'a/b'}]})}; };
  try {
    assert.equal((await ghSearch('x', 60, 17)).length, 1, 'results 961-1000 exist');
    assert.deepEqual(await ghSearch('x', 50, 21), [], 'results 1001-1050 do not');
    assert.equal(asked, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('index.html: the Content-Security-Policy allows the inline file:// notice by its exact hash', async () => {
  const {createHash} = await import('node:crypto');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(csp, 'the page has a policy');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(inline.length >= 1);
  for (const s of inline) assert.ok(csp.includes(`'sha256-${createHash('sha256').update(s).digest('base64')}'`), 'update the hash in the policy when the inline script changes');
  assert.match(csp, /connect-src 'self' https:\/\/api\.github\.com https:\/\/api\.star-history\.com;/, 'data only goes to GitHub, star-history.com and the local cache');
});

test('state: nextGen aborts previous genSignal, starredSet/starredIds track S.repos', () => {
  const sig1 = genSignal();
  assert.equal(sig1.aborted, false);
  const g = nextGen();
  assert.equal(sig1.aborted, true);
  assert.equal(S.gen, g);
  assert.equal(genSignal().aborted, false);

  S.repos = [
    {id: 10, full: 'Alice/One', name: 'One', owner: 'Alice', topics: [], stars: 5},
    {id: 20, full: 'Bob/Two', name: 'Two', owner: 'Bob', topics: [], stars: 10},
  ];
  assert.ok(starredSet().has('alice/one'));
  assert.ok(starredIds().has(20));
  assert.equal(rkey(S.repos[0]), '10');
  S.readmes = {'10': {t: 'Hello World'}};
  assert.equal(readmeLower(S.repos[0]), 'hello world');
});

test('sort: sortRepos orders by key, places nulls last, and breaks ties by name', () => {
  const items = [
    {name: 'beta', stars: 10, releaseAt: null, score: 2},
    {name: 'alpha', stars: 10, releaseAt: '2025-01-01T00:00:00Z', score: 5},
    {name: 'gamma', stars: 50, releaseAt: '2026-01-01T00:00:00Z', score: 2},
  ];
  assert.deepEqual(sortRepos([...items], 'stars').map(x => x.name), ['gamma', 'alpha', 'beta']);
  assert.deepEqual(sortRepos([...items], 'starsAsc').map(x => x.name), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(sortRepos([...items], 'release').map(x => x.name), ['gamma', 'alpha', 'beta']);
  assert.deepEqual(sortRepos([...items], 'relevance').map(x => x.name), ['alpha', 'beta', 'gamma']);
});

test('github: languageShares, activityNow, recordStars, starGains, gitSha', async () => {
  const shares = languageShares({
    totalSize: 1000,
    edges: [{size: 755, node: {name: 'Rust', color: '#dea584'}}, {size: 245, node: {name: 'C', color: null}}],
  });
  assert.deepEqual(shares, [['Rust', 75.5, '#dea584'], ['C', 24.5, null]]);

  const end = Date.now() - 2 * ACTIVITY_SPAN - 1000;
  const counts = Array.from({length: ACTIVITY_BUCKETS}, (_, i) => i + 1);
  const shifted = activityNow({end, counts});
  assert.equal(shifted.length, ACTIVITY_BUCKETS);
  assert.deepEqual(shifted.slice(-2), [0, 0]);
  assert.equal(shifted[0], 3);

  const d0 = 100 * DAY, d1 = 114 * DAY;
  let hist = recordStars([], 10, d0);
  hist = recordStars(hist, 12, d0 + 1000);   // same UTC day overwrites
  assert.equal(hist.length, 1);
  assert.equal(hist[0][1], 12);
  hist = recordStars(hist, 26, d1);
  const gains = starGains(hist, d1);
  assert.equal(gains.at(-1), 14);
  assert.equal(gains[0], null);

  const sha = await gitSha('what is up, doc?');
  assert.equal(sha, 'bd9dbf5aae1a3862dd1526723246b20206e5fc37');
});

test('starhistory: curveFor deduplication, starsAt interpolation, and SVG parsing', () => {
  S.starCurves = {
    'owner/repo': {v: 3, at: Date.now(), pts: [[1000, 5], [1000, 10], [2000, 8], [3000, 30]]},
  };
  const c = curveFor('Owner/Repo');
  assert.deepEqual(c.pts, [[1000, 10], [2000, 10], [3000, 30]]);
  assert.equal(starsAt(c.pts, 500), 0);
  assert.equal(starsAt(c.pts, 1000), 10);
  assert.equal(starsAt(c.pts, 2500), 20);
  assert.equal(starsAt(c.pts, 5000), 30);
  assert.ok(drawableCurve('owner/repo')?.pts);

  // Minimal DOMParser shim to verify parseStarHistorySvg on path & tick elements
  globalThis.DOMParser = class {
    parseFromString() {
      const mkTick = (x, text) => ({getAttribute: k => k === 'transform' ? `translate(${x}, 0)` : null, textContent: text});
      const mkYTick = (y, text) => ({
        querySelector: () => ({getAttribute: k => k === 'transform' ? `translate(0, ${y})` : null, textContent: text}),
      });
      return {
        querySelectorAll(sel) {
          if (sel === '.xaxis text.tick') return [mkTick(100, '2024'), mkTick(500, '2025')];
          if (sel === '.yaxis .tick') return [mkYTick(300, '0'), mkYTick(100, '1K')];
          if (sel === 'path[fill="none"]') return [{
            classList: {contains: () => false},
            getAttribute: k => k === 'd' ? 'M100,300 L300,200 a.4.4 0 01.1-.1 L500,100' : null,
          }];
          return [];
        },
      };
    }
  };
  const parsed = parseStarHistorySvg('<svg></svg>');
  assert.ok(Array.isArray(parsed) && parsed.length >= 3);
  assert.equal(parsed[0][1], 0);
  assert.equal(parsed.at(-1)[1], 1000);
});

test('discover: keywordMembers enforces word boundaries and ranks name/topic matches above README mentions', () => {
  S.repos = [
    {id: 1, full: 'mega/unrelated', name: 'unrelated', owner: 'mega', about: 'A huge project', topics: ['python'], stars: 150000, starred: '2025-01-01T00:00:00Z'},
    {id: 2, full: 'readme/mention', name: 'helper', owner: 'readme', about: 'Some helper', topics: ['cli'], stars: 50000, starred: '2025-01-01T00:00:00Z'},
    {id: 3, full: 'dev/adb-tool', name: 'adb-tool', owner: 'dev', about: 'Android bridge', topics: ['adb'], stars: 200, starred: '2025-01-01T00:00:00Z'},
  ];
  S.readmes = {
    '1': {t: 'Contains 0xdeadbeef and readbyte and payloadbody but not the tool.'},
    '2': {t: 'You can connect via adb shell to debug.'},
    '3': {t: 'ADB wrapper.'},
  };
  const matches = keywordMembers(['adb']);
  // Repo 1 ("0xdeadbeef" / "readbyte") must NOT match "adb"; Repo 3 (name+topic match, 200★) must rank ahead of Repo 2 (README mention, 50k★).
  assert.deepEqual(matches.map(r => r.id), [3, 2]);
});

test('discover: detectThemes clusters related repos and collector penalizes forks/curated lists', () => {
  S.repos = [
    {id: 1, full: 'a/scrcpy', name: 'scrcpy', owner: 'a', about: 'screen copy', topics: ['scrcpy', 'android'], stars: 1000, starred: '2026-09-01T00:00:00Z'},
    {id: 2, full: 'b/qtscrcpy', name: 'QtScrcpy', owner: 'b', about: 'Qt GUI for scrcpy', topics: ['scrcpy'], stars: 500, starred: '2026-09-02T00:00:00Z'},
    {id: 3, full: 'c/escrcpy', name: 'escrcpy', owner: 'c', about: 'Electron scrcpy client', topics: ['scrcpy'], stars: 300, starred: '2026-09-03T00:00:00Z'},
  ];
  S.disc = {dismissed: ['bad/dismissed'], results: {}};
  const themes = detectThemes();
  assert.ok(themes.some(t => t.keys.includes('scrcpy')));

  const {add, finish} = collector(['scrcpy'], false);
  add({id: 1, full_name: 'a/scrcpy', stargazers_count: 1000}, 'already starred', 3);
  add({id: 9, full_name: 'bad/dismissed', stargazers_count: 1000}, 'dismissed', 3);
  add({id: 4, full_name: 'd/scrcpy-plus', description: 'scrcpy GUI', stargazers_count: 400, topics: ['scrcpy']}, 'matches “scrcpy”', 2);
  add({id: 5, full_name: 'e/awesome-scrcpy', description: 'Curated list of scrcpy tools', stargazers_count: 400, topics: ['scrcpy']}, 'matches “scrcpy”', 2);
  const ranked = finish();
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].x.full_name, 'd/scrcpy-plus');
  assert.ok(ranked[1].reasons.includes('📚 curated list'));
});

test('sync & list: migrateReadmes, needsEnrich, card rendering, and activityHTML fallback', () => {
  const now = Date.now();
  const repo = {
    id: 42, full: 'owner/demo', name: 'demo', owner: 'owner', url: 'https://github.com/owner/demo',
    about: 'Demo <script> repo', topics: ['cli'], stars: 120, forks: 5, issues: 2, lang: 'Go',
    pushed: '2026-10-01T00:00:00Z', enrichedPushed: '2026-10-01T00:00:00Z', enrichedAt: now, release: null, releasePre: false,
    langs: [['Go', 99.2, '#00ADD8'], ['Shell', 0.05, 'javascript:bad']],
    activity: {end: now, counts: Array(26).fill(1)},
    starHist: [[now - 14 * DAY, 100], [now, 120]],
  };
  S.repos = [repo];
  S.readmes = {'owner/demo': {t: 'Custom README text', path: 'docs/README.md', at: now, pushed: '2026-10-01T00:00:00Z'}};
  migrateReadmes();
  assert.equal(S.readmes['42']?.t, 'Custom README text');
  assert.equal(S.readmes['owner/demo'], undefined);
  assert.equal(needsEnrich(repo), false);
  assert.equal(needsEnrich({...repo, releasePre: undefined}), true, 'details fetched before releases were taken by date are refreshed once');
  assert.equal(needsReadme(repo), false);

  // Sanitize invalid language color and escape HTML in card
  const langHtml = languagesHTML(repo);
  assert.ok(langHtml.includes('background:#00ADD8'));
  assert.ok(langHtml.includes('background:#8b949e'));
  assert.ok(!langHtml.includes('javascript:bad'));

  // When starCurves has a 404/unavailable entry (pts: null), activityHTML falls back to local starGains
  S.starCurves = {'owner/demo': {v: 3, at: now, pts: null}};
  const actHtml = activityHTML(repo);
  assert.ok(actHtml.includes('+20'), 'should render +20 gained stars from local starHist fallback');

  const cardHtml = card(repo);
  assert.ok(cardHtml.includes('Demo &lt;script&gt; repo'));
  assert.ok(cardHtml.includes('docs/README.md'), 'viewerLinks should use cached README path via rkey(r)');
  assert.ok(cardHtml.includes('role="button"'));
  assert.ok(cardHtml.includes('◉ 2 open'), 'open issues and pull requests, the same meaning on starred and suggestion cards');
});

test('list: a history record missing its commit or release list renders instead of throwing; matching topics survive the cut to 8', () => {
  S.starCurves = {};
  const repo = {id: 31, full: 'a/b', name: 'b', owner: 'a', topics: [], stars: 1};
  S.history = {'31': {rel: [['v1', '', 0, 'notes', 0]], done: true}};   // no `c`
  assert.ok(card(repo).includes('1 release'));
  S.history = {'31': {c: [['aaaaaaaaaa', 1, 'msg']], done: false}};     // no `rel`
  assert.ok(card(repo).includes('1+ commits'));
  S.history = {'31': {done: true}};
  assert.ok(!card(repo).includes('🔎'));
  S.history = {};

  const many = {...repo, topics: [...Array.from({length: 9}, (_, i) => 'topic' + i), 'needle']};
  const re = /needle/gi;
  for (let i = 0; i < 2; i++) {   // twice: a /g regex remembers its position between .test() calls
    const html = card(many, {re});
    assert.ok(html.includes('data-topic="needle"'), 'the searched topic is shown first');
    assert.equal((html.match(/data-topic=/g) || []).length, 8);
  }
});

test('github: fatal errors (bad token, used-up budget) are told apart from "slow down" answers', async () => {
  const realFetch = globalThis.fetch, token = S.token;
  S.token = 'tok';
  const answer = (status, headers = {}, body = {}) => async () => ({ok: status < 300, status, headers: new Headers(headers), json: async () => body});
  try {
    globalThis.fetch = answer(401);
    await assert.rejects(gql('query{}'), e => e.fatal === true && isFatalError(e));
    globalThis.fetch = answer(403, {'x-ratelimit-remaining': '0'});
    await assert.rejects(gql('query{}'), e => e.fatal === true && isFatalError(e));
    globalThis.fetch = answer(403);   // budget left: the secondary limit
    await assert.rejects(gql('query{}'), e => e.secondary === true && !isFatalError(e));
    globalThis.fetch = answer(200, {}, {data: null, errors: [{type: 'RATE_LIMITED', message: 'API rate limit already exceeded'}]});
    await assert.rejects(gql('query{}'), e => e.fatal === true && isFatalError(e));
    globalThis.fetch = answer(200, {}, {data: null, errors: [{message: 'You have exceeded a secondary rate limit'}]});
    await assert.rejects(gql('query{}'), e => e.secondary === true && !isFatalError(e), 'GitHub can report "slow down" inside a 200 answer');
    globalThis.fetch = answer(200, {}, {data: {r0: null}});
    assert.deepEqual(await gql('query{}'), {r0: null});
    assert.equal(isFatalError(new Error('GraphQL 502')), false);
    assert.equal(isFatalError(new Error('Network error (offline, or GitHub timed out or cut the answer)')), false);
  } finally { globalThis.fetch = realFetch; S.token = token; }
});

test('discover: pruneResults keeps the newest 40 and anything under 30 days old, and never the one just made', () => {
  const now = Date.now();
  S.disc = {dismissed: [], results: {old: {at: now - 40 * DAY}, keepme: {at: now - 50 * DAY}}};
  for (let i = 0; i < 45; i++) S.disc.results['r' + i] = {at: now - i * 60_000};
  pruneResults('keepme', now);
  const ids = Object.keys(S.disc.results);
  assert.equal(ids.length, 41);
  assert.ok(ids.includes('keepme') && ids.includes('r0') && ids.includes('r39'));
  assert.ok(!ids.includes('old') && !ids.includes('r40'));
  S.disc = {dismissed: [], results: {}};
});

test('starhistory: a failed refresh is remembered, "Clear cache" drops charts still downloading, old charts are pruned', async () => {
  const realFetch = globalThis.fetch, events = [];
  globalThis.window.dispatchEvent = e => events.push(e.detail);
  STAR_TUNING.retryMs = 1;
  try {
    // Every try fails (503) while a stale "unavailable" entry is saved: the stale entry stays, and the failure is
    // remembered so the card isn't retried at once (drawableCurve answers null only when nothing is known).
    const stale = {v: 3, at: Date.now() - 2 * DAY, pts: null};
    S.starCurves = {'o/r': stale};
    assert.equal(drawableCurve('o/r'), null, 'stale and not known to be failing: it will be fetched');
    let tries = 0;
    globalThis.fetch = async () => { tries++; return {ok: false, status: 503, text: async () => ''}; };
    await loadCurve('O/R');
    assert.equal(tries, 4);
    assert.equal(S.starCurves['o/r'], stale);
    assert.ok(drawableCurve('o/r'), 'the failure is remembered');
    assert.deepEqual(events, ['o/r']);

    // 404 is an answer: cached as "no chart".
    globalThis.fetch = async () => ({ok: false, status: 404, text: async () => ''});
    await loadCurve('n/f');
    assert.equal(S.starCurves['n/f'].pts, null);

    // "Clear cache" while a chart is downloading: its answer must not bring data back.
    S.starCurves = {};
    let answer;
    globalThis.fetch = () => new Promise(resolve => { answer = () => resolve({ok: true, status: 200, text: async () => '<svg/>'}); });
    const loading = loadCurve('late/chart');
    forgetStarCharts();
    answer();
    await loading;
    assert.deepEqual(S.starCurves, {});

    // A request that hangs is cut off by its timeout instead of holding a download slot forever.
    STAR_TUNING.timeoutMs = 20;
    globalThis.fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const t0 = Date.now();
    await loadCurve('hang/chart');
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(S.starCurves['hang/chart'], undefined);

    const now = Date.now();
    S.starCurves = {fresh: {at: now - DAY}, old: {at: now - 61 * DAY}, undated: {}};
    pruneCurves(now);
    assert.deepEqual(Object.keys(S.starCurves), ['fresh']);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.window.dispatchEvent = () => {};
    STAR_TUNING.retryMs = 1000; STAR_TUNING.timeoutMs = 20_000;
    forgetStarCharts();   // clears the pending cache save, so the test run can end
    S.starCurves = {};
  }
});

test('list: parseQuery and match support exact phrases, negation, and qualifiers', () => {
  const r = {
    id: 7, full: 'Genymobile/scrcpy', name: 'scrcpy', owner: 'Genymobile',
    about: 'Display and control your Android device', topics: ['android', 'adb'],
    lang: 'C', langs: [['C', 92, '#555555'], ['Meson', 8, null]],
    stars: 115000, archived: false, fork: false,
  };
  const q1 = parseQuery('"control your android" -flutter lang:meson stars:>10000 is:active -is:fork');
  assert.deepEqual(q1.inc, ['control your android']);
  assert.deepEqual(q1.exc, ['flutter']);
  assert.equal(q1.quals.length, 4);
  assert.ok(match(r, q1, false));

  assert.equal(match(r, parseQuery('"android control"'), false), null);   // exact phrase order matters
  assert.equal(match(r, parseQuery('android -adb'), false), null);          // excluded topic
  assert.equal(match(r, parseQuery('lang:rust'), false), null);             // wrong language
  assert.equal(match(r, parseQuery('stars:<500'), false), null);            // star threshold not met
  assert.equal(match(r, parseQuery('is:archived'), false), null);           // not archived

  // A qualifier that can't be understood is ignored, with or without "-", instead of hiding every repo.
  for (const q of ['is:foo', '-is:foo', 'stars:lots', '-stars:lots', 'stars:>>5']) assert.ok(match(r, parseQuery(q), false), q);
  // GitHub's star forms: ranges, open ends, k / m suffixes (r has 115,000 stars)
  assert.ok(match(r, parseQuery('stars:100000..200000'), false));
  assert.equal(match(r, parseQuery('stars:10..500'), false), null);
  assert.ok(match(r, parseQuery('stars:100k..*'), false));
  assert.equal(match(r, parseQuery('stars:*..1k'), false), null);
  assert.ok(match(r, parseQuery('stars:>=1.5k'), false));
  assert.equal(match(r, parseQuery('stars:<0.1m'), false), null);
  assert.equal(match(r, parseQuery('-stars:>100K'), false), null, 'negated, and upper-case suffixes work too');

  // A quote still being typed is ignored instead of making the search match nothing.
  assert.deepEqual(parseQuery('"android').inc, ['android']);
  assert.deepEqual(parseQuery('-"flutter').exc, ['flutter']);
  assert.deepEqual(parseQuery('"').inc, []);
  assert.ok(match(r, parseQuery('"android'), false));

  // Languages arrive after the first render (details check): the cached search text must pick them up.
  const late = {id: 8, full: 'a/late', name: 'late', owner: 'a', about: 'x', topics: [], lang: 'Go'};
  assert.equal(match(late, parseQuery('zig'), false), null);
  late.langs = [['Go', 90, null], ['Zig', 10, null]];
  assert.ok(match(late, parseQuery('zig'), false), 'language names from the breakdown become searchable without a new sync');
});

test('server.js: static serving, HEAD, cache PUT/GET, and DNS-rebinding / cross-origin protection', async () => {
  const port = 18780 + Math.floor(Math.random() * 1000);
  const testKey = '__test_suite_tmp__';
  const dataDir = mkdtempSync(join(tmpdir(), 'stars-viewer-test-'));   // never the real ./data: this test deletes cache files
  const testFile = join(dataDir, `${testKey}.json`);
  const proc = spawn(process.execPath, ['server.js'], {env: {...process.env, PORT: String(port), STARS_DATA: dataDir}, stdio: ['ignore', 'pipe', 'pipe']});
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server startup timeout')), 3000);
      proc.stdout.on('data', d => { if (String(d).includes('Stars Viewer running')) { clearTimeout(t); resolve(); } });
      proc.on('exit', code => { clearTimeout(t); reject(new Error(`server exited (${code})`)); });
    });
    const base = `http://localhost:${port}`;

    // Static GET & HEAD
    const headRes = await fetch(`${base}/`, {method: 'HEAD'});
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), '');

    // Cache PUT & GET
    const putRes = await fetch(`${base}/cache/${testKey}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({hello: 'world', count: 42}),
    });
    assert.equal(putRes.status, 204);
    const getRes = await fetch(`${base}/cache/${testKey}`);
    assert.equal(getRes.status, 200);
    assert.deepEqual(await getRes.json(), {hello: 'world', count: 42});

    // Big cache files are stored gzip-compressed on disk and read back transparently; plain legacy files still load.
    const big = {rows: Array.from({length: 4000}, (_, i) => ({i, text: 'commit message number ' + i}))};
    assert.equal((await fetch(`${base}/cache/${testKey}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(big)})).status, 204);
    const onDisk = readFileSync(testFile);
    assert.equal(onDisk[0] === 0x1f && onDisk[1] === 0x8b, true, 'stored gzip-compressed');
    assert.ok(onDisk.length < JSON.stringify(big).length / 3, 'and much smaller');
    assert.deepEqual(await (await fetch(`${base}/cache/${testKey}`)).json(), big);
    writeFileSync(testFile, JSON.stringify({legacy: true}));
    assert.deepEqual(await (await fetch(`${base}/cache/${testKey}`)).json(), {legacy: true});
    assert.equal((await fetch(`${base}/cache/%E0%A4%A`)).status, 400, 'a malformed URL is a 400, not a 500');

    // Invalid JSON is the client's mistake (400, not 500) and leaves the stored file alone.
    const json = {'Content-Type': 'application/json'};
    assert.equal((await fetch(`${base}/cache/${testKey}`, {method: 'PUT', headers: json, body: '{not json'})).status, 400);
    assert.deepEqual(await (await fetch(`${base}/cache/${testKey}`)).json(), {legacy: true});
    // Overlapping saves of one key are coalesced, and every request is answered by a write that carried its data.
    const bodies = Array.from({length: 25}, (_, i) => JSON.stringify({n: i}));
    const answers = await Promise.all(bodies.map(body => fetch(`${base}/cache/${testKey}`, {method: 'PUT', headers: json, body})));
    assert.deepEqual(answers.map(r => r.status), Array(25).fill(204));
    assert.ok(bodies.includes(JSON.stringify(await (await fetch(`${base}/cache/${testKey}`)).json())), 'one of the saved states is on disk, intact');
    assert.deepEqual(readdirSync(dataDir).filter(f => f.endsWith('.tmp')), [], 'no temp files are left behind');

    // A file that exists but can't be read is an error, never "nothing stored": the app would otherwise build an empty
    // replacement and save it over the real data (it marks the key unreadable instead, see store.js).
    writeFileSync(testFile, Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3]));   // a damaged compressed file
    assert.equal((await fetch(`${base}/cache/${testKey}`)).status, 500);

    // A missing key is "no data yet" (200 null), not an error.
    const missing = await fetch(`${base}/cache/__nothing_here__`);
    assert.equal(missing.status, 200);
    assert.equal(await missing.json(), null);

    // DELETE removes one key, or everything (all cache files of the data folder, nothing else).
    await fetch(`${base}/cache/a:one`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: '{"x":1}'});
    await fetch(`${base}/cache/a:two`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: '{"x":2}'});
    assert.equal((await fetch(`${base}/cache/a:one`, {method: 'DELETE'})).status, 204);
    assert.equal(await (await fetch(`${base}/cache/a:one`)).json(), null);
    assert.deepEqual(await (await fetch(`${base}/cache/a:two`)).json(), {x: 2});
    writeFileSync(join(dataDir, 'notes.txt'), 'not a cache file');
    const wiped = await fetch(`${base}/cache`, {method: 'DELETE'});
    assert.equal(wiped.status, 200);
    assert.ok((await wiped.json()).deleted >= 2);
    assert.deepEqual(readdirSync(dataDir), ['notes.txt'], 'every cache file is gone, other files are left alone');
    assert.equal((await fetch(`${base}/cache`, {method: 'GET'})).status, 405);
    assert.equal((await fetch(`${base}/cache`, {method: 'DELETE', headers: {Origin: 'https://evil.example'}})).status, 403, 'other sites can not wipe the cache');

    // Cross-site Origin / Sec-Fetch-Site must be rejected with 403
    const evilOrigin = await fetch(`${base}/cache/${testKey}`, {headers: {Origin: 'https://evil.example'}});
    assert.equal(evilOrigin.status, 403);
    const evilFetchSite = await fetch(`${base}/cache/${testKey}`, {headers: {'Sec-Fetch-Site': 'cross-site'}});
    assert.equal(evilFetchSite.status, 403);
  } finally {
    proc.kill();
    rmSync(dataDir, {recursive: true, force: true});
  }
});

