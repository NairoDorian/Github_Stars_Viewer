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
const {languageShares, activityNow, recordStars, starGains, gitSha, ACTIVITY_BUCKETS, ACTIVITY_SPAN} = await import('../public/js/github.js');
const {curveFor, drawableCurve, starsAt, curveGains, parseStarHistorySvg} = await import('../public/js/starhistory.js');
const {detectThemes, keywordMembers, collector} = await import('../public/js/discover.js');
const {migrateReadmes, needsEnrich, needsReadme} = await import('../public/js/sync.js');
const {card, languagesHTML, activityHTML, parseQuery, match} = await import('../public/js/list.js');
import {spawn} from 'node:child_process';
import {rmSync, readFileSync, writeFileSync, mkdtempSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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
  assert.deepEqual(curveGains(c.pts, 2, 1000, 3000), [0, 20]);
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

