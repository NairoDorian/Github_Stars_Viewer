// Tests for the star-list part of a check (sync.js) against a fake GitHub REST API: pages are conditional on their ETag, an
// unchanged page comes back as 304 and is rebuilt from the cache, unstarred repos and empty last pages go, renamed or
// pre-id repos keep their data, and a page that fails never overwrites the cached list.
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)},
  configurable: true,
});
// One stub element per selector (status line, list, progress panel…). It stays for the whole file: the progress panel
// redraws on timers that may fire between tests.
const els = {};
globalThis.document = {querySelector: sel => (els[sel] ??= {value: '', checked: false, textContent: '', innerHTML: '', hidden: false})};
globalThis.window ??= {dispatchEvent() {}};   // a rate-limit error asks the page to show the token panel
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };   // Node 18 has none

const {S, nextGen} = await import('../public/js/state.js');
const {sync, task} = await import('../public/js/sync.js');

const PUSHED = '2026-01-01T00:00:00Z';
/** A REST "starred" item (star+json media type). */
const star = (id, full = `acme/repo${id}`) => ({starred_at: '2026-01-01T00:00:00Z', repo: {id, full_name: full, name: full.split('/')[1],
  owner: {login: full.split('/')[0], avatar_url: ''}, html_url: 'https://github.com/' + full, description: 'repo ' + id, homepage: null,
  stargazers_count: id, forks_count: 0, open_issues_count: 0, language: 'Go', topics: [], license: null, archived: false, fork: false,
  created_at: '2025-01-01T00:00:00Z', pushed_at: PUSHED, default_branch: 'main'}});

/** Fake GitHub: serves `list` in pages of 100 with an ETag per page that changes when the page's content does, answers
 *  304 to a matching If-None-Match (without a Link header, like GitHub), and answers 403 "budget used up" for pages where
 *  fail(page) is true. Returns the log of requests. */
function fakeStarList(list, {fail = () => false} = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), page = Number(u.searchParams.get('page'));
    if (!/^\/users\/[^/]+\/starred$/.test(u.pathname)) return {ok: false, status: 404, headers: new Headers(), json: async () => ({})};
    const items = list.slice((page - 1) * 100, page * 100), last = Math.max(1, Math.ceil(list.length / 100));
    const etag = `"${page}:${items.map(x => x.repo.id + x.repo.full_name).join(',')}"`;
    calls.push({page, conditional: !!init.headers?.['If-None-Match']});
    if (fail(page)) return {ok: false, status: 403, headers: new Headers({'x-ratelimit-remaining': '0'}), json: async () => ({})};
    if (init.headers?.['If-None-Match'] === etag) return {ok: false, status: 304, headers: new Headers({ETag: etag}), json: async () => []};
    const link = page === 1 && last > 1 ? {Link: `<https://api.github.com/users/x/starred?per_page=100&page=${last}>; rel="last"`} : {};
    return {ok: true, status: 200, headers: new Headers({ETag: etag, ...link}), json: async () => items};
  };
  return calls;
}

/** Runs fn(generation) for the user "tester" without a token (no GraphQL involved), then puts everything back. */
async function check(fn) {
  const realFetch = globalThis.fetch;
  try {
    Object.assign(S, {user: 'tester', token: '', repos: [], starPages: [], readmes: {}, history: {}});
    return await fn(nextGen());
  } finally { globalThis.fetch = realFetch; Object.assign(S, {user: '', repos: [], starPages: [], readmes: {}, history: {}}); }
}

test('unchanged pages answer 304 and come from the cache; unstarring shrinks the list, and the empty last page is dropped for good', async () => {
  await check(async g => {
    const list = Array.from({length: 250}, (_, i) => star(i + 1));

    let calls = fakeStarList(list);
    await sync(g);
    assert.equal(S.repos.length, 250);
    assert.equal(S.starPages.length, 3);
    assert.deepEqual(calls.map(c => c.conditional), [false, false, false], 'a first run has no ETags yet');

    // Nothing changed: every page is asked conditionally, answers 304, and the list is rebuilt from the cache.
    const etags = S.starPages.map(p => p.etag), ids = S.repos.map(r => r.id);
    calls = fakeStarList(list);
    await sync(g);
    assert.deepEqual(calls.map(c => c.conditional), [true, true, true]);
    assert.deepEqual(S.starPages.map(p => p.etag), etags);
    assert.deepEqual(S.repos.map(r => r.id), ids);
    assert.match(els['#status'].textContent, /list up to date/);

    // 60 repos unstarred: page 1 is unchanged (304, which carries no page count), page 2 shrinks, page 3 is now empty.
    S.repos[150].commitAt = '2026-02-02T00:00:00Z';   // a detail from an earlier check, on a page that is downloaded again
    const kept = list.slice(0, 190);
    calls = fakeStarList(kept);
    await sync(g);
    assert.equal(calls.length, 3);
    assert.equal(S.repos.length, 190);
    assert.equal(S.starPages.length, 2, 'the empty page is not kept');
    assert.equal(S.repos.find(r => r.id === 151).commitAt, '2026-02-02T00:00:00Z', 'details survive a re-downloaded page');
    assert.match(els['#status'].textContent, /60 unstarred/);

    // ...and the next check does not ask for it again.
    calls = fakeStarList(kept);
    await sync(g);
    assert.deepEqual(calls.map(c => c.page).sort(), [1, 2]);
    assert.equal(S.repos.length, 190);
  });
});

test('a repo cached before ids existed is matched by name and its README moves to the id key; unstarred repos lose their README', async () => {
  await check(async g => {
    const entry = {t: 'legacy text', whole: true, at: Date.now(), pushed: PUSHED};   // fresh: no README request is needed
    S.repos = [{full: 'o/legacy', name: 'legacy', owner: 'o', topics: [], stars: 1, pushed: PUSHED},
      {id: 78, full: 'o/gone', name: 'gone', owner: 'o', topics: [], stars: 1, pushed: PUSHED}];
    S.readmes = {'o/legacy': entry, '78': {...entry, t: 'gone text'}};

    fakeStarList([star(77, 'o/legacy')]);
    await sync(g);
    assert.deepEqual(S.repos.map(r => r.id), [77]);
    assert.equal(S.readmes['77'].t, 'legacy text');
    assert.deepEqual(Object.keys(S.readmes), ['77']);
  });
});

test('no job starts while the profile\'s cache is still being read (it would save half-loaded data over it)', async () => {
  await check(async () => {
    const calls = fakeStarList([star(1), star(2)]);
    let loaded;
    S.loading = new Promise(resolve => { loaded = resolve; });   // what load() does until READMEs and history are read
    try {
      await task(sync);   // "Check for updates" clicked meanwhile
      assert.equal(calls.length, 0, 'nothing was fetched, so nothing could be saved');
      assert.match(els['#status'].textContent, /Still reading the cached data/);
    } finally { S.loading = null; loaded(); }
    await task(sync);
    assert.equal(S.repos.length, 2, 'once the cache is read, the job runs');
  });
});

test('a page that fails stops the check and leaves the cached list untouched', async () => {
  await check(async g => {
    const list = Array.from({length: 150}, (_, i) => star(i + 1));
    fakeStarList(list);
    await sync(g);
    const repos = S.repos, pages = S.starPages;

    fakeStarList([...list, star(999)], {fail: page => page === 2});
    await assert.rejects(sync(g), /Rate limited/);
    assert.equal(S.repos, repos, 'a partial list never replaces the cache');
    assert.equal(S.starPages, pages);
  });
});
