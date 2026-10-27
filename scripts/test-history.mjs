// Tests for commit-message and release-note indexing (history.js), run against a fake GitHub GraphQL endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v))},
  configurable: true,
});

const {S, nextGen, historyIndex, historyHit} = await import('../public/js/state.js');
const {syncHistory, advance, toCommit, needsHistory, historyTotals, MAX_COMMITS, setHistOpts, DEFAULT_OPTS, TUNING} = await import('../public/js/history.js');
const {parseQuery, match, card} = await import('../public/js/list.js');

/** A fake GitHub GraphQL endpoint holding repos with commits / releases (newest first). It understands just the queries
 *  history.js sends, including offset cursors ("<commit> <index>", counted from the commit the query starts at).
 *  `calls` counts them: check, releases, first (first page, asks totalCount), after (page at a cursor), seq (page from an
 *  explicit commit, no cursor). `state`: failAfter (answer "rate limit" after N queries), secondaryFor (answer the next N
 *  with a 403 "slow down"), delay (ms per query), maxInFlight (observed parallelism), releaseGate (a promise that pages of
 *  releases wait for). `cursors`: 'ok' | 'opaque' (cursors carry no offsets) | 'lying' (cursors at an offset are wrong and
 *  so is the content). */
function fakeGitHub(repos, {cursors = 'ok'} = {}) {
  const calls = {check: 0, releases: 0, first: 0, after: 0, seq: 0};
  const state = {failAfter: Infinity, queries: 0, secondaryFor: 0, delay: 0, inFlight: 0, maxInFlight: 0, releaseGate: null};
  globalThis.fetch = async (url, init) => {
    const reply = (data, errors) => ({ok: true, status: 200, headers: new Headers(), json: async () => ({data, errors})});
    if (++state.queries > state.failAfter) return reply(null, [{message: 'API rate limit exceeded'}]);
    if (state.secondaryFor > 0) { state.secondaryFor--; return {ok: false, status: 403, headers: new Headers(), json: async () => ({})}; }
    state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight);
    try {
      if (state.delay) await new Promise(r => setTimeout(r, state.delay));
      const query = JSON.parse(init.body).query, data = {};
      if (state.releaseGate && query.includes('releases(first:25')) await state.releaseGate;
      const starts = [...query.matchAll(/(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)\{/g)];
      starts.forEach((m, i) => {
        const body = query.slice(m.index + m[0].length, starts[i + 1]?.index ?? query.length);
        const repo = repos[`${m[2]}/${m[3]}`];
        if (!repo) { data[m[1]] = null; return; }
        const published = repo.releases.filter(x => !x.isDraft);
        if (body.includes('releases(first:5,')) {
          calls.check++;
          const latest = published.find(x => !x.isPrerelease);
          data[m[1]] = {defaultBranchRef: repo.commits.length ? {target: {oid: repo.commits[0].oid, committedDate: repo.commits[0].committedDate}} : null,
            latestRelease: latest ? {tagName: latest.tagName} : null,
            releases: {totalCount: published.length, nodes: repo.releases.slice(0, 5)}};
        } else if (body.includes('releases(first:25')) {
          calls.releases++;
          const from = Number(body.match(/after:"(\d+)"/)?.[1] || 0);
          data[m[1]] = {releases: {pageInfo: {hasNextPage: from + 25 < repo.releases.length, endCursor: String(from + 25)},
            nodes: repo.releases.slice(from, from + 25)}};
        } else if (body.includes('object(expression:')) {
          const oid = body.match(/expression:"([0-9a-f]+)"/)[1], after = body.match(/after:"([0-9a-f]+) (\d+)"/), idx = repo.commits.findIndex(c => c.oid === oid);
          if (idx < 0) { data[m[1]] = {object: null}; return; }
          if (after) calls.after++; else if (body.includes('totalCount')) calls.first++; else calls.seq++;
          const skip = after ? Number(after[2]) + 1 : 0, start = idx + skip + (after && cursors === 'lying' ? 1 : 0);   // lying: shifted content...
          const nodes = repo.commits.slice(start, start + 100), last = skip + nodes.length - 1;
          const endCursor = cursors === 'opaque' ? 'opaque-' + start : cursors === 'lying' && after ? `${oid} ${last + 1}` : `${oid} ${last}`;   // ...and a cursor that disagrees
          data[m[1]] = {object: {history: {...(body.includes('totalCount') ? {totalCount: repo.commits.length - idx} : {}),
            pageInfo: {hasNextPage: start + 100 < repo.commits.length, endCursor}, nodes}}};
        }
      });
      return reply(data);
    } finally { state.inFlight--; }
  };
  return {calls, state};
}
const zero = calls => Object.assign(calls, {check: 0, releases: 0, first: 0, after: 0, seq: 0});
const fakeOid = i => i.toString(16).padStart(8, '0') + 'a'.repeat(32);
// Commits numbered from..to-1, newest (highest number) first.
const makeCommits = (from, to) => Array.from({length: to - from}, (_, k) => to - 1 - k).map(i => ({
  oid: fakeOid(i), committedDate: new Date(Date.UTC(2020, 0, 1) + i * 36e5).toISOString(),
  message: `commit number ${i}${i % 50 === 0 ? ' fix flicker bug\n\nLong body mentioning Zebra' : ''}`,
}));
const release = (tag, notes, day, extra = {}) => ({tagName: tag, name: tag === 'v1.0.0' ? 'First stable' : tag, description: notes,
  createdAt: `2024-01-${day}T00:00:00Z`, publishedAt: `2024-01-${day}T00:00:00Z`, updatedAt: `2024-01-${day}T12:00:00Z`, isPrerelease: false, isDraft: false, ...extra});
const oids = commits => commits.map(c => c.oid.slice(0, 10));
/** Runs fn with a stubbed document (the status line / progress bar), a fake token and the given fake GitHub, then restores everything. */
async function withGitHub(repos, opts, fn) {
  const el = {value: '', checked: false, textContent: '', innerHTML: '', hidden: false};
  globalThis.document = {querySelector: () => el};
  const realFetch = globalThis.fetch;
  try {
    S.token = 'tok'; S.history = {};
    S.repos = Object.keys(repos).map((full, i) => ({id: 500 + i, full, owner: full.split('/')[0], name: full.split('/')[1], pushed: 'p1', topics: []}));
    return await fn(fakeGitHub(repos, opts), nextGen());
  } finally { globalThis.fetch = realFetch; delete globalThis.document; S.token = ''; S.history = {}; S.repos = []; setHistOpts(DEFAULT_OPTS); TUNING.slowDownMs = 15_000; }
}

test('toCommit trims and caps; historyHit finds the newest matching release or commit; match() honours the toggle', () => {
  const e = toCommit({oid: 'abcdef0123456789'.repeat(2) + 'abcdef01', committedDate: '2024-03-05T00:00:00Z', message: '  Fix crash\r\n\r\n' + 'x'.repeat(1000)});
  assert.equal(e[0], 'abcdef0123');
  assert.equal(e[1], Date.UTC(2024, 2, 5) / 1000);
  assert.ok(e[2].startsWith('Fix crash\n\nxxx') && e[2].length === 400);

  const repo = {id: 901, full: 'h/hit', name: 'hit', owner: 'h', url: 'https://github.com/h/hit', topics: [], about: 'nothing'};
  S.repos = [repo];
  S.history = {'901': {c: [['aaaaaaaaaa', 200, 'Newest: speed up Parser'], ['bbbbbbbbbb', 100, 'Older parser fix']],
    rel: [['v2.0', 'Big one', 300, 'Rewrote the PARSER\nin Rust', 0]], done: true}};
  assert.equal(historyHit(repo, 'rust').kind, 'Release');
  assert.equal(historyHit(repo, 'parser').kind, 'Release');   // releases are listed before commits
  assert.deepEqual(historyHit(repo, 'older'), {kind: 'Commit', id: 'bbbbbbbbbb', t: 100, text: 'Older parser fix'});
  assert.equal(historyHit(repo, 'nothing'), null);
  assert.ok(historyIndex(repo).low.includes('rewrote the parser in rust'), 'whitespace is squashed so phrases match across lines');

  const q = parseQuery('"older parser" -zebra');
  const hit = match(repo, q, false, true);
  assert.equal(hit.snips[0].kind, 'Commit');
  assert.equal(match(repo, q, false, false), null, 'history is only searched when enabled');
  assert.equal(match(repo, parseQuery('parser -rust'), false, true), null, 'an excluded term found in release notes rejects the repo');
  assert.ok(card(repo, {snips: hit.snips, re: /older parser/gi}).includes('github.com/h/hit/commit/bbbbbbbbbb'));
  S.history = {};
});

test('syncHistory indexes every commit and release, updates incrementally, and resumes after an interruption', async () => {
  const repos = {
    'o/big': {commits: makeCommits(0, 250), releases: [release('v2.0.0', 'Zebra mode added', '20'), release('v1.0.0', 'Initial', '10'), release('v0.9', 'beta', '05', {isDraft: true})]},
    'o/empty': {commits: [], releases: []},
    'o/small': {commits: makeCommits(0, 3), releases: []},
  };
  await withGitHub(repos, {}, async (gh, g) => {
    // First index: everything, 3 pages of the big repo fetched by offset after the first one said how many there are.
    let res = await syncHistory(g, S.repos, {force: true});
    const big = S.history['500'];
    assert.equal(big.c.length, 250, res.summary);
    assert.equal(big.done, true);
    assert.deepEqual(big.c.map(e => e[2].split('\n')[0]).slice(0, 2), ['commit number 249', 'commit number 248']);
    assert.deepEqual(big.c.map(e => e[0]), oids(repos['o/big'].commits), 'every commit, in order, none twice');
    assert.equal(big.rel.length, 2, 'draft releases are skipped');
    assert.deepEqual(big.rel[1], ['v1.0.0', 'First stable', Date.UTC(2024, 0, 10) / 1000, 'Initial', 0]);
    assert.equal(S.history['501'].done, true, 'an empty repository is complete');
    assert.equal(S.history['502'].c.length, 3);
    assert.deepEqual(historyTotals(), {commits: 253, releases: 2, repos: 3});
    assert.deepEqual([gh.calls.first, gh.calls.after, gh.calls.seq], [2, 2, 0], 'first pages ask the count; the rest follow by offset');
    assert.equal(needsHistory(S.repos[0]), false);
    assert.equal(historyHit(S.repos[0], 'zebra').kind, 'Release');
    assert.ok(historyHit(S.repos[0], 'flicker bug'), 'commit headline + body are searchable');

    // Nothing changed: a forced re-check costs only the cheap check.
    zero(gh.calls);
    await syncHistory(g, S.repos, {force: true});
    assert.deepEqual(gh.calls, {check: 3, releases: 0, first: 0, after: 0, seq: 0});

    // 130 new commits and a new release: only the new part is fetched (two pages down from the new head until the
    // stored history is found), the stored commits are kept, the releases are fetched again as a whole.
    repos['o/big'].commits = [...makeCommits(250, 380), ...repos['o/big'].commits];
    repos['o/big'].releases.unshift(release('v3.0.0', 'Shiny', '25'));
    S.repos[0].pushed = 'p2';
    assert.equal(needsHistory(S.repos[0]), true);
    zero(gh.calls);
    await syncHistory(g, S.repos);
    assert.deepEqual(gh.calls, {check: 1, releases: 1, first: 0, after: 0, seq: 2});
    assert.deepEqual(S.history['500'].c.map(e => e[0]), oids(repos['o/big'].commits));
    assert.equal(S.history['500'].rel.length, 3);
    assert.equal(S.history['500'].pushed, 'p2');
  });
});

test('an interrupted first index keeps its progress; the next run continues below it with a cursor, never from the head', async () => {
  const repos = {'o/huge': {commits: makeCommits(0, 450), releases: []}};
  await withGitHub(repos, {}, async (gh, g) => {
    gh.state.failAfter = 3;   // the check, the releases and the first page of commits succeed; then "rate limit"
    const res = await syncHistory(g, S.repos, {force: true});
    assert.match(res.summary, /rate limit/i);
    assert.equal(S.history['500'].c.length, 100);
    assert.equal(S.history['500'].done, false);
    assert.equal(needsHistory(S.repos[0]), true);
    gh.state.failAfter = Infinity;
    zero(gh.calls);
    await syncHistory(g, S.repos);
    assert.deepEqual([gh.calls.seq, gh.calls.first], [0, 0], 'no request starts from the head or from an explicit commit');
    assert.equal(gh.calls.after, 4, 'the first page at a cursor (which also asks the remaining count) and the 3 pages after it');
    assert.equal(S.history['500'].c.length, 450);
    assert.equal(S.history['500'].done, true);
    assert.deepEqual(S.history['500'].c.map(e => e[0]), oids(repos['o/huge'].commits));
  });
});

test('pages of one repo are fetched in parallel, and the result is exactly the history', async () => {
  const repos = {'o/long': {commits: makeCommits(0, 2050), releases: []}};
  await withGitHub(repos, {}, async (gh, g) => {
    gh.state.delay = 15;
    await syncHistory(g, S.repos, {force: true});
    assert.deepEqual(S.history['500'].c.map(e => e[0]), oids(repos['o/long'].commits));
    assert.deepEqual([gh.calls.first, gh.calls.after, gh.calls.seq], [1, 20, 0]);
    assert.ok(gh.state.maxInFlight >= 2, 'several requests were in flight at once: ' + gh.state.maxInFlight);
  });
});

test('if GitHub\'s cursors can not be trusted, the repo is fetched one page at a time and the result is still exact', async () => {
  const repos = {'o/long': {commits: makeCommits(0, 1050), releases: []}};
  for (const cursors of ['opaque', 'lying']) {
    await withGitHub(repos, {cursors}, async (gh, g) => {
      await syncHistory(g, S.repos, {force: true});
      assert.deepEqual(S.history['500'].c.map(e => e[0]), oids(repos['o/long'].commits), cursors);
      assert.equal(S.history['500'].done, true);
      assert.ok(gh.calls.seq >= 10, `${cursors}: continued sequentially (${gh.calls.seq} pages)`);
      if (cursors === 'opaque') assert.equal(gh.calls.after, 0, 'no offset cursor was even tried');
    });
  }
});

test('after the fallback to one page at a time, the offset pages still waiting in the queue are never requested', async () => {
  const repos = {'o/long': {commits: makeCommits(0, 12_000), releases: []}};
  await withGitHub(repos, {cursors: 'lying'}, async (gh, g) => {
    setHistOpts({commits: 0});   // no limit: 119 offset pages are queued at once
    await syncHistory(g, S.repos, {force: true});
    assert.deepEqual(S.history['500'].c.map(e => e[0]), oids(repos['o/long'].commits));
    // 8 requests of 12 pages are in flight when the first wrong cursor comes back; the 23 pages still queued are dropped.
    assert.ok(gh.calls.after <= 8 * 12, `offset pages requested: ${gh.calls.after} of 119`);
  });
});

test('a repo is marked as checked only when its releases were fetched too (Cancel between two pages of releases)', async () => {
  const releases = Array.from({length: 30}, (_, i) => release('v' + i, 'notes ' + i, String(10 + (i % 18))));
  const repos = {'o/r': {commits: makeCommits(0, 5), releases}};
  await withGitHub(repos, {}, async (gh, g) => {
    let open;
    gh.state.releaseGate = new Promise(resolve => { open = resolve; });
    const run = syncHistory(g, S.repos, {force: true});
    while (!S.history['500']?.done) await new Promise(resolve => setTimeout(resolve, 2));   // the commits are complete...
    S.stop = true;   // ...and Cancel is clicked while the first page of releases is on its way
    open();
    try { await run; } finally { S.stop = false; }
    assert.equal(S.history['500'].rel.length, 0, 'the second page of releases was never fetched');
    assert.equal(needsHistory(S.repos[0]), true, 'so the repo is not stamped as checked: the next check finishes it');
    gh.state.releaseGate = null;
    await syncHistory(g, S.repos);   // an ordinary update check, not the toolbar button
    assert.equal(S.history['500'].rel.length, 30);
    assert.equal(needsHistory(S.repos[0]), false);
  });
});

test('the commit cap and "no limit" decide how many pages are requested', async () => {
  const repos = {'o/long': {commits: makeCommits(0, 1234), releases: []}};
  await withGitHub(repos, {}, async (gh, g) => {
    setHistOpts({commits: 300});
    await syncHistory(g, S.repos, {force: true});
    assert.equal(S.history['500'].c.length, 300);
    assert.deepEqual([S.history['500'].capped, S.history['500'].done, gh.calls.after], [true, true, 2], 'only the pages up to the cap were asked for');
    setHistOpts({commits: 0});
    zero(gh.calls);
    await syncHistory(g, S.repos, {force: true});
    assert.equal(S.history['500'].c.length, 1234, 'every commit message');
    assert.deepEqual([S.history['500'].capped, S.history['500'].done], [false, true]);
    assert.deepEqual(S.history['500'].c.map(e => e[0]), oids(repos['o/long'].commits));
    // an update with the limit still off keeps joining new commits without ever cutting
    repos['o/long'].commits = [...makeCommits(1234, 1400), ...repos['o/long'].commits];
    S.repos[0].pushed = 'p2';
    await syncHistory(g, S.repos);
    assert.equal(S.history['500'].c.length, 1400);
    assert.equal(S.history['500'].capped, false);
  });
});

test('GitHub\'s "slow down" answers are waited out, not treated as a failure', async () => {
  const repos = {'o/a': {commits: makeCommits(0, 350), releases: [release('v1', 'x', '10')]}};
  await withGitHub(repos, {}, async (gh, g) => {
    TUNING.slowDownMs = 2;
    gh.state.secondaryFor = 2;
    const res = await syncHistory(g, S.repos, {force: true});
    assert.doesNotMatch(res.summary, /skipped|⚠/);
    assert.equal(S.history['500'].c.length, 350);
    assert.equal(S.history['500'].rel.length, 1);
  });
});

test('release notes are replaced when GitHub says they changed: edited newest release, 30 days, or an older record format', async () => {
  const repos = {'o/r': {commits: makeCommits(0, 3), releases: [release('v2', 'second', '20'), release('v1', 'first', '10')]}};
  await withGitHub(repos, {}, async (gh, g) => {
    await syncHistory(g, S.repos, {force: true});
    const rec = () => S.history['500'];
    assert.deepEqual(rec().rel.map(x => x[3]), ['second', 'first']);
    assert.equal(rec().relTop, 'v2|2024-01-20T00:00:00Z|2024-01-20T12:00:00Z');
    const recheck = async () => { zero(gh.calls); await syncHistory(g, S.repos, {force: true}); return gh.calls.releases; };

    assert.equal(await recheck(), 0, 'unchanged: nothing is downloaded again');
    repos['o/r'].releases[0] = {...repos['o/r'].releases[0], description: 'second, edited', updatedAt: '2024-06-01T00:00:00Z'};
    assert.equal(await recheck(), 1, 'the newest release was edited (its updatedAt moved)');
    assert.deepEqual(rec().rel.map(x => x[3]), ['second, edited', 'first'], 'the stored notes were replaced');

    rec().relTop = 'v2|2024-01-20T00:00:00Z';   // written before updatedAt was tracked
    assert.equal(await recheck(), 0, 'an old-format key is not a change');
    assert.equal(rec().relTop, 'v2|2024-01-20T00:00:00Z|2024-06-01T00:00:00Z', 'and is upgraded in place');

    rec().relAt = Date.now() - 40 * 864e5;   // older edits of a non-newest release can only be noticed by looking again
    assert.equal(await recheck(), 1, 'releases are fetched again after 30 days (+ up to 6 days, spread per repo)');
    assert.ok(Date.now() - rec().relAt < 60_000);

    repos['o/r'].releases.unshift(release('v3', 'third', '28'));
    assert.equal(await recheck(), 1, 'a new release');
    assert.deepEqual(rec().rel.map(x => x[0]), ['v3', 'v2', 'v1']);
  });
});

test('advance joins new commits onto the stored ones, continues, or replaces rewritten history', () => {
  S.history = {};
  const walker = (k, old, extra = {}) => ({k, old, known: new Set(old.c.map(e => e[0])), fresh: [], head: null, from: null, lastOid: null, ...extra});
  const stored = (done, n = 3) => ({c: makeCommits(0, n).map(toCommit), head: 'oldhead', tail: 'oldtail', done, rel: []});

  // joined: 5 new commits on top of 3 stored
  S.history.a = stored(true);
  let w = walker('a', S.history.a);
  assert.equal(advance(w, makeCommits(0, 8), true), 'done');
  assert.deepEqual(S.history.a.c.map(e => e[0]), oids(makeCommits(0, 8)));
  assert.equal(S.history.a.head, fakeOid(7), 'the new head');
  assert.equal(S.history.a.tail, 'oldtail');

  // joined, but the stored history was itself unfinished: the caller continues below it
  S.history.b = stored(false);
  assert.equal(advance(walker('b', S.history.b), makeCommits(0, 5), true), 'resume');
  assert.equal(S.history.b.c.length, 5);
  assert.equal(S.history.b.done, false);

  // more pages needed before the stored commits show up; the next page starts at the last commit seen
  S.history.c = stored(true, 2);
  w = walker('c', S.history.c);
  assert.equal(advance(w, makeCommits(1000, 1100), true), 'more');
  assert.equal(w.from, fakeOid(1000), 'the next page starts at the oldest commit of this one');
  assert.equal(S.history.c.c.length, 2, 'nothing is replaced before the join point is found');

  // the stored commits are gone (history rewritten): the new walk replaces them
  S.history.rw = stored(true);
  assert.equal(advance(walker('rw', S.history.rw), makeCommits(1000, 1005), false), 'done');
  assert.equal(S.history.rw.c.length, 5);
  assert.equal(S.history.rw.done, true);

  // the commit cap is reached before a join point
  S.history.cap = stored(true);
  w = walker('cap', S.history.cap, {fresh: Array.from({length: MAX_COMMITS - 50}, (_, i) => ['x' + i, 0, 'm']), lastOid: 'l'});
  assert.equal(advance(w, makeCommits(1000, 1100), true), 'done');
  assert.deepEqual([S.history.cap.capped, S.history.cap.c.length], [true, MAX_COMMITS]);
  S.history = {};
});

// ---------- tiles: last commit / last release ----------
const {parseLast} = await import('../public/js/github.js');
const {lastCommitTile, lastReleaseTile} = await import('../public/js/list.js');

test('parseLast picks the newest release by publish date (pre-releases included, drafts skipped), not GitHub "Latest"', () => {
  const node = (tagName, publishedAt, extra = {}) => ({tagName, publishedAt, createdAt: publishedAt, isPrerelease: false, isDraft: false, ...extra});
  // backport line: 5.0.0 was created first, 4.14.0 published later
  let l = parseLast({lastCommit: {target: {committedDate: '2026-10-01T00:00:00Z'}}, latestRelease: {tagName: '5.0.0'},
    releases: {nodes: [node('5.0.0', '2026-06-06T00:00:00Z'), node('4.14.0', '2026-07-19T00:00:00Z')]}});
  assert.deepEqual([l.release, l.releaseAt, l.releasePre, l.releaseLatest, l.commitAt], ['4.14.0', '2026-07-19T00:00:00Z', false, '5.0.0', '2026-10-01T00:00:00Z']);
  // pre-release newer than the stable one, and a newer draft that must be ignored
  l = parseLast({latestRelease: {tagName: 'v7.0.2'}, releases: {nodes: [node('v9-draft', '2026-12-01T00:00:00Z', {isDraft: true}),
    node('v7.1-beta', '2026-10-20T00:00:00Z', {isPrerelease: true}), node('v7.0.2', '2026-08-20T00:00:00Z')]}});
  assert.deepEqual([l.release, l.releasePre, l.releaseLatest], ['v7.1-beta', true, 'v7.0.2']);
  // only pre-releases (GitHub reports no "Latest"), and no releases at all
  l = parseLast({latestRelease: null, releases: {nodes: [node('0.1.0-rc1', '2025-01-01T00:00:00Z', {isPrerelease: true})]}});
  assert.deepEqual([l.release, l.releasePre, l.releaseLatest], ['0.1.0-rc1', true, null]);
  l = parseLast({latestRelease: null, releases: {nodes: []}, lastCommit: null});
  assert.deepEqual([l.release, l.releaseAt, l.commitAt], [null, null, null]);
});

test('tiles always say what is known: a push date is never shown as a last commit; releases say "no releases" or a dash', () => {
  const now = Date.now(), iso = d => new Date(now - d * 864e5).toISOString();
  assert.match(lastCommitTile({commitAt: iso(3), pushed: iso(1)}), /last commit 3d ago/);
  assert.match(lastCommitTile({pushed: iso(1)}), /last push 1d ago/);
  assert.ok(!lastCommitTile({pushed: iso(1)}).includes('🕒 last commit'), 'the visible label never claims a commit');
  assert.equal(lastCommitTile({}), '');
  const rel = lastReleaseTile({release: 'v7.1-beta', releaseAt: iso(40), releasePre: true, releaseLatest: 'v7.0.2'});
  assert.ok(rel.includes('last release v7.1-beta') && rel.includes('pre-release') && rel.includes('v7.0.2') && /1mo ago/.test(rel));
  assert.match(lastReleaseTile({release: null}), /no releases/);
  assert.match(lastReleaseTile({}), /last release —/);
  assert.equal(lastReleaseTile({}, true), '', 'suggestion cards without details show nothing instead of a dash');
});

test('syncHistory refreshes every repo tile from the cheap check', async () => {
  const el = {value: '', checked: false, textContent: '', innerHTML: '', hidden: false};
  globalThis.document = {querySelector: () => el};
  const realFetch = globalThis.fetch;
  try {
    const repos = {
      'o/back': {commits: makeCommits(0, 3), releases: [release('5.0.0', 'new line', '20'), release('4.14.0', 'backport', '15', {publishedAt: '2024-02-05T00:00:00Z'})]},
      'o/pre': {commits: makeCommits(0, 3), releases: [release('v2-beta', 'beta', '28', {isPrerelease: true}), release('v1.5.0', 'stable', '10')]},
      'o/none': {commits: makeCommits(0, 2), releases: []},
    };
    fakeGitHub(repos);
    S.token = 'tok'; S.history = {};
    S.repos = Object.keys(repos).map((full, i) => ({id: 700 + i, full, owner: 'o', name: full.slice(2), pushed: 'p', topics: [], commitAt: i === 2 ? '2000-01-01T00:00:00Z' : undefined}));
    const g = nextGen();
    await syncHistory(g, S.repos, {force: true});
    const [back, pre, none] = S.repos;
    assert.deepEqual([back.release, back.releaseLatest, back.releasePre], ['4.14.0', '5.0.0', false]);
    assert.equal(back.releaseAt, '2024-02-05T00:00:00Z');
    assert.deepEqual([pre.release, pre.releasePre, pre.releaseLatest], ['v2-beta', true, 'v1.5.0']);
    assert.equal(none.release, null, 'a repo without releases is known to have none');
    assert.equal(pre.commitAt, makeCommits(0, 3)[0].committedDate);
    assert.equal(none.commitAt, makeCommits(0, 2)[0].committedDate, 'the fresh commit date replaces the old one');
  } finally { globalThis.fetch = realFetch; delete globalThis.document; S.token = ''; S.history = {}; S.repos = []; }
});

// ---------- release-note options ----------
const {stripMentions, stripLinks, cleanNotes, reconcile, histOpts, optFlags} = await import('../public/js/history.js');

test('stripMentions removes @logins but keeps code, e-mails and scoped packages; stripLinks keeps link text', () => {
  assert.equal(stripMentions('Fix crash by @alice in https://github.com/o/r/pull/1'), 'Fix crash in https://github.com/o/r/pull/1');
  assert.equal(stripMentions('- Minor API change (@alteredq and @mrdoob)\n- Added filters (@julianwa)'), '- Minor API change\n- Added filters');
  const keep = 'Mail a@b.com, use `@Override` and @types/node, @angular/core, run npm i @scope/pkg';
  assert.equal(stripMentions(keep), keep);
  assert.equal(stripMentions('```\n@someone in code\n```\nthanks @dave'), '```\n@someone in code\n```\nthanks');
  assert.equal(stripMentions('* @newbie made their first contribution in https://x.test/1\n* @other'), '* made their first contribution in https://x.test/1');

  assert.equal(stripLinks('See [the docs](https://a.test/docs) and https://b.test/x now ![img](https://i.test/a.png)'), 'See the docs and now');
  assert.equal(stripLinks('Use `https://keep.me/in/code` and <https://auto.link>.'), 'Use `https://keep.me/in/code` and.');
  assert.equal(stripLinks('no links here'), 'no links here');
});

test('options: defaults keep links, notes are cleaned and capped, changes reconcile stored records', () => {
  assert.deepEqual(histOpts(), DEFAULT_OPTS);
  assert.deepEqual([DEFAULT_OPTS.mentions, DEFAULT_OPTS.links], [true, false], 'mentions stripped, links kept by default');
  const text = 'Fix by @alice in https://github.com/o/r/pull/1 ' + 'x'.repeat(10);
  const capped = cleanNotes(text, {mentions: true, links: false, notes: 30});
  assert.equal(capped.length, 30);
  assert.ok(capped.startsWith('Fix in https://github.com/o/r/'));
  assert.equal(cleanNotes(text, {mentions: true, links: true, notes: 100}), 'Fix in xxxxxxxxxx');

  // A record stored with nothing stripped is stripped locally when the options ask for it (no request)...
  S.history = {a: {c: [], rel: [['v1', '', 1, 'Fix by @alice in https://x.test/1', 0]], done: true, ro: ':6000'}};
  let r = reconcile({mentions: true, links: false, notes: 6000});
  assert.deepEqual([r.stripped, r.refetch], [1, 0]);
  assert.equal(S.history.a.rel[0][3], 'Fix in https://x.test/1');
  assert.equal(S.history.a.ro, 'm:6000');
  // ...stripping links as well, locally...
  reconcile({mentions: true, links: true, notes: 6000});
  assert.equal(S.history.a.rel[0][3], 'Fix in');
  // ...but bringing back what was stripped needs the notes fetched again: the record is marked, its text left alone.
  r = reconcile({mentions: true, links: false, notes: 6000});
  assert.deepEqual([r.stripped, r.refetch], [0, 1]);
  assert.equal(S.history.a.relN, -1);
  assert.equal(S.history.a.at, 0, 'so that the next check looks at it');
  assert.equal(S.history.a.rel[0][3], 'Fix in');
  // A longer notes cap only needs a refetch if some note actually hit the old cap.
  S.history = {b: {c: [], rel: [['v1', '', 1, 'short', 0]], done: true, ro: 'm:1000'}, d: {c: [], rel: [['v1', '', 1, 'y'.repeat(1000), 0]], done: true, ro: 'm:1000'}};
  r = reconcile({mentions: true, links: false, notes: 6000});
  assert.deepEqual([r.refetch, S.history.b.ro, S.history.d.relN], [1, 'm:6000', -1]);
  // Commit cap: lowering trims what is stored; raising it walks again only the repos that had been cut off, keeping their
  // release notes.
  S.history = {t: {c: Array.from({length: 5}, (_, i) => ['o' + i, i, 'm']), rel: [['v1', '', 1, 'kept notes', 0]], relN: 1, relTop: 'v1|a|b', relAt: 5,
    head: 'h', tail: 't', done: true, capped: false, ro: optFlags(DEFAULT_OPTS)}};
  reconcile({...DEFAULT_OPTS, commits: 3});
  assert.equal(S.history.t.c.length, 3);
  assert.equal(S.history.t.capped, true);
  r = reconcile({...DEFAULT_OPTS, commits: 10_000});
  assert.equal(r.restart, 1);
  const t = S.history.t;
  assert.deepEqual([t.c, t.head, t.tail, t.done, t.capped], [[], null, null, false, false], 'the commits are walked again from the head');
  assert.deepEqual([t.rel[0][3], t.relN, t.relTop, t.relAt], ['kept notes', 1, 'v1|a|b', 5], 'the release notes stay, and are not fetched again');
  // persisted in localStorage
  setHistOpts({links: true, notes: 3000});
  assert.deepEqual([histOpts().links, histOpts().notes, histOpts().mentions], [true, 3000, true]);
  setHistOpts(DEFAULT_OPTS);
  S.history = {};
});

// ---------- sharded storage ----------
const store = await import('../public/js/store.js');

test('history shards: only changed shards are written, and a legacy single record is migrated', async () => {
  S.user = 'shardtest';
  const g = nextGen();
  S.history = Object.fromEntries(Array.from({length: 40}, (_, i) => [String(1000 + i), {c: [['o', i, 'msg ' + i]], rel: [], done: true}]));
  store.markAllHistory();
  assert.equal(store.historyDirty(), store.HISTORY_SHARDS);
  assert.equal(await store.saveHistory(g), true);
  assert.equal(store.historyDirty(), 0);
  // change one repo: exactly its shard is dirty again
  S.history['1005'] = {...S.history['1005'], c: [['n', 9, 'changed']]};
  store.markHistory('1005');
  assert.equal(store.historyDirty(), 1);
  await store.saveHistory(g);
  S.history = {};
  let loaded = await store.loadHistory(g);
  assert.equal(Object.keys(loaded).length, 40);
  assert.equal(loaded['1005'].c[0][2], 'changed');
  assert.equal(loaded['1006'].c[0][2], 'msg 6');
  // an older version wrote everything into one record: it is imported, split into shards and retired
  await store.put('history:shardtest', {'9999': {c: [['z', 1, 'legacy']], rel: [], done: true}, '1005': {c: [['l', 1, 'legacy wins']], rel: [], done: true}});
  loaded = await store.loadHistory(g);
  assert.equal(loaded['9999'].c[0][2], 'legacy');
  assert.equal(loaded['1005'].c[0][2], 'legacy wins');
  assert.equal(await store.get('history:shardtest'), null, 'the legacy record is emptied');
  S.history = {};
  loaded = await store.loadHistory(g);
  assert.equal(loaded['9999'].c[0][2], 'legacy', 'and the data now lives in shards');
  S.user = ''; S.history = {};
});

// ---------- "no limit" values ----------
test('a cap of 0 means no limit: whole release notes, and every commit message of a repo', async () => {
  // notes: nothing is cut, and the options survive a round trip through localStorage
  const long = 'word '.repeat(5000);   // 25,000 characters
  assert.equal(cleanNotes(long, {mentions: false, links: false, notes: 6000}).length, 6000);
  assert.equal(cleanNotes(long, {mentions: false, links: false, notes: 0}).length, long.trim().length);
  setHistOpts({notes: 0, commits: 0});
  assert.deepEqual([histOpts().notes, histOpts().commits], [0, 0]);
  assert.equal(optFlags(histOpts()), 'm:0');
  setHistOpts({commits: 'junk', notes: null});
  assert.deepEqual([histOpts().notes, histOpts().commits], [DEFAULT_OPTS.notes, DEFAULT_OPTS.commits], 'invalid input falls back to the defaults, never to "no limit"');
  setHistOpts(DEFAULT_OPTS);

  // reconcile: a longer (or unlimited) cap re-fetches only the notes that were really cut
  S.history = {a: {c: [], rel: [['v1', '', 1, 'x'.repeat(6000), 0]], done: true, ro: 'm:6000'}, b: {c: [], rel: [['v1', '', 1, 'short', 0]], done: true, ro: 'm:6000'}};
  let r = reconcile({mentions: true, links: false, notes: 0, commits: 10_000});
  assert.deepEqual([r.refetch, r.stripped], [1, 1]);
  assert.equal(S.history.a.relN, -1);
  assert.equal(S.history.b.ro, 'm:0');
  // unlimited -> a cap trims locally, no request
  S.history = {a: {c: [], rel: [['v1', '', 1, 'y'.repeat(9000), 0]], done: true, ro: 'm:0'}};
  r = reconcile({mentions: true, links: false, notes: 6000, commits: 10_000});
  assert.equal(S.history.a.rel[0][3].length, 6000);
  assert.deepEqual([r.stripped, r.refetch], [1, 0]);

  // commits: a repo cut off at a cap is walked again and then keeps every commit
  const el = {value: '', checked: false, textContent: '', innerHTML: '', hidden: false};
  globalThis.document = {querySelector: () => el};
  const realFetch = globalThis.fetch;
  try {
    const repos = {'o/long': {commits: makeCommits(0, 1234), releases: []}};
    fakeGitHub(repos);
    S.token = 'tok'; S.history = {};
    S.repos = [{id: 800, full: 'o/long', owner: 'o', name: 'long', pushed: 'p1', topics: []}];
    const g = nextGen();
    setHistOpts({commits: 300});
    await syncHistory(g, S.repos, {force: true});
    assert.equal(S.history['800'].c.length, 300);
    assert.deepEqual([S.history['800'].capped, S.history['800'].done], [true, true]);
    setHistOpts({commits: 0});
    await syncHistory(g, S.repos, {force: true});
    assert.equal(S.history['800'].c.length, 1234, 'every commit message');
    assert.deepEqual([S.history['800'].capped, S.history['800'].done], [false, true]);
    assert.deepEqual(S.history['800'].c.map(e => e[0]), oids(repos['o/long'].commits));
    // and a later update with the limit still off keeps joining new commits without ever cutting
    repos['o/long'].commits = [...makeCommits(1234, 1400), ...repos['o/long'].commits];
    S.repos[0].pushed = 'p2';
    await syncHistory(g, S.repos);
    assert.equal(S.history['800'].c.length, 1400);
    assert.equal(S.history['800'].capped, false);
  } finally { setHistOpts(DEFAULT_OPTS); globalThis.fetch = realFetch; delete globalThis.document; S.token = ''; S.history = {}; S.repos = []; }
});
