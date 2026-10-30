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
const {text: logText} = await import('../public/js/log.js');

const PUSHED = '2026-01-01T00:00:00Z';
/** A REST "starred" item (star+json media type). */
const star = (id, full = `acme/repo${id}`) => ({starred_at: '2026-01-01T00:00:00Z', repo: {id, full_name: full, name: full.split('/')[1],
  owner: {login: full.split('/')[0], avatar_url: ''}, html_url: 'https://github.com/' + full, description: 'repo ' + id, homepage: null,
  stargazers_count: id, forks_count: 0, open_issues_count: 0, language: 'Go', topics: [], license: null, archived: false, fork: false,
  created_at: '2025-01-01T00:00:00Z', pushed_at: PUSHED, default_branch: 'main'}});

/** Fake GitHub: serves `list` in pages of 100 with an ETag per page that changes when the page's content does, answers
 *  304 to a matching If-None-Match (without a Link header, like GitHub), and answers 403 "budget used up" for pages where
 *  fail(page) is true. Returns the log of requests. */
const registry = new Map();   // every repo any list ever held: full name → id (they still exist online unless repoStatus says otherwise)
function fakeStarList(list, {fail = () => false, repoStatus = {}} = {}) {
  const calls = [], repoCalls = [];
  for (const x of list) registry.set(x.repo.full_name, x.repo.id);
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), page = Number(u.searchParams.get('page'));
    // GET /repositories/<id> (what the app asks) or /repos/<owner>/<name>: does this repository still exist? Like GitHub, a repo that
    // is private / deleted answers 404. repoStatus: 404 · 451 (taken down) · 'blocked' (403 "access blocked") · 403 (can't tell)
    // · 'limit' (budget used up) · {id} (the name now belongs to another repo; the original id is gone).
    const byId = u.pathname.match(/^\/repositories\/(\d+)$/)?.[1], byName = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/)?.[1];
    if (byId || byName) {
      const full = byName ?? [...registry].find(([, id]) => id === Number(byId))?.[0];
      repoCalls.push(full);
      const s = repoStatus[full], answer = (status, body = {}, headers = {}) => ({ok: status < 300, status, headers: new Headers(headers), json: async () => body});
      if (full === undefined || s === 404 || (byId && s?.id)) return answer(404);
      if (s === 451) return answer(451, {message: 'Repository access blocked'});
      if (s === 'blocked') return answer(403, {message: 'Repository access blocked'});
      if (s === 403) return answer(403, {message: 'Resource not accessible'});
      if (s === 'limit') return answer(403, {message: 'API rate limit exceeded'}, {'x-ratelimit-remaining': '0'});
      return answer(200, {id: s?.id ?? registry.get(full)});
    }
    if (!/^\/users\/[^/]+\/starred$/.test(u.pathname)) return {ok: false, status: 404, headers: new Headers(), json: async () => ({})};
    const items = list.slice((page - 1) * 100, page * 100), last = Math.max(1, Math.ceil(list.length / 100));
    const etag = `"${page}:${items.map(x => x.repo.id + x.repo.full_name).join(',')}"`;
    calls.push({page, conditional: !!init.headers?.['If-None-Match']});
    if (fail(page)) return {ok: false, status: 403, headers: new Headers({'x-ratelimit-remaining': '0'}), json: async () => ({})};
    if (init.headers?.['If-None-Match'] === etag) return {ok: false, status: 304, headers: new Headers({ETag: etag}), json: async () => []};
    const link = page === 1 && last > 1 ? {Link: `<https://api.github.com/users/x/starred?per_page=100&page=${last}>; rel="last"`} : {};
    return {ok: true, status: 200, headers: new Headers({ETag: etag, ...link}), json: async () => items};
  };
  calls.repoCalls = repoCalls;
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
    const list = Array.from({length: 249}, (_, i) => star(i + 1));

    let calls = fakeStarList(list);
    await sync(g);
    assert.equal(S.repos.length, 249);
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

    // 50 repos unstarred (each is verified to still exist online): page 1 is unchanged (304, which carries no page count), page 2 shrinks, page 3 is now empty.
    S.repos[150].commitAt = '2026-02-02T00:00:00Z';   // a detail from an earlier check, on a page that is downloaded again
    const kept = list.slice(0, 199);
    calls = fakeStarList(kept);
    await sync(g);
    assert.equal(calls.length, 3);
    assert.equal(S.repos.length, 199);
    assert.equal(S.starPages.length, 2, 'the empty page is not kept');
    assert.equal(S.repos.find(r => r.id === 151).commitAt, '2026-02-02T00:00:00Z', 'details survive a re-downloaded page');
    assert.match(els['#status'].textContent, /50 unstarred/);

    // ...and the next check does not ask for it again.
    calls = fakeStarList(kept);
    await sync(g);
    assert.deepEqual(calls.map(c => c.page).sort(), [1, 2]);
    assert.equal(S.repos.length, 199);
  });
});

test('a repo cached before ids existed is matched by name and its README moves to the id key; unstarred repos lose their README', async () => {
  await check(async g => {
    const entry = {t: 'legacy text', whole: true, at: Date.now(), pushed: PUSHED};   // fresh: no README request is needed
    S.repos = [{full: 'o/legacy', name: 'legacy', owner: 'o', topics: [], stars: 1, pushed: PUSHED},
      {id: 78, full: 'o/gone', name: 'gone', owner: 'o', topics: [], stars: 1, pushed: PUSHED}];
    S.readmes = {'o/legacy': entry, '78': {...entry, t: 'gone text'}};

    registry.set('o/gone', 78);   // it still exists online: it was unstarred, not removed
    fakeStarList([star(77, 'o/legacy')]);
    await sync(g);
    assert.deepEqual(S.repos.map(r => r.id), [77]);
    assert.equal(S.readmes['77'].t, 'legacy text');
    // The unstarred repo leaves the list at once, but its README is only dropped when a second check confirms it is gone:
    // the pages are fetched in parallel, so one check can miss a repo that moved across a page boundary.
    assert.deepEqual(Object.keys(S.readmes).sort(), ['77', '78'], 'kept after the first check');
    await sync(g);
    assert.deepEqual(Object.keys(S.readmes), ['77'], 'dropped once the second check agrees');
  });
});

test('a repo that is missing from one check and back in the next keeps its README and commit index', async () => {
  await check(async g => {
    const entry = {t: 'precious index', whole: true, at: Date.now(), pushed: PUSHED};
    fakeStarList([star(1), star(2)]);
    await sync(g);
    S.readmes = {'1': {...entry}, '2': {...entry}};
    S.history = {'2': {c: [['aaaaaaaaaa', 1, 'msg']], rel: [], done: true}};
    fakeStarList([star(1)]);   // repo 2 slipped between two pages for one check
    await sync(g);
    assert.equal(S.readmes['2'].t, 'precious index');
    assert.equal(S.history['2'].c.length, 1);
    fakeStarList([star(1), star(2)]);   // ...and is there again
    await sync(g);
    fakeStarList([star(1)]);            // gone once more: this is a first glimpse again, not a confirmation
    await sync(g);
    assert.ok(S.readmes['2'] && S.history['2'], 'the earlier glimpse was forgotten when the repo came back');
    await sync(g);
    assert.equal(S.readmes['2'], undefined, 'two checks in a row: really gone');
    assert.equal(S.history['2'], undefined);
  });
});

test('a visit checks only last commit and release: no languages, no 12-month chart, no README', async () => {
  await check(async g => {
    const queries = [];
    const stars = fakeStarList([star(1), star(2)]);
    const github = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url).endsWith('/graphql')) return github(url, init);
      const query = JSON.parse(init.body).query, data = {};
      queries.push(query);
      [...query.matchAll(/(r\d+):repository\(/g)].forEach(m => { data[m[1]] = {lastCommit: {target: {committedDate: '2026-02-02T00:00:00Z'}}, releases: {nodes: []}, latestRelease: null}; });
      return {ok: true, status: 200, headers: new Headers(), json: async () => ({data})};
    };
    S.token = 'tok'; S.visit = 'tester';
    try {
      await sync(g);
      assert.equal(stars.length, 1);
      assert.equal(queries.length, 1, 'one call for both repos');
      assert.ok(queries[0].includes('lastCommit:defaultBranchRef') && !/languages\(|history\(since|HEAD:/.test(queries[0]), 'only the tile fields');
      assert.equal(S.repos[0].commitAt, '2026-02-02T00:00:00Z');
      assert.equal(S.repos[0].release, null);
      assert.ok(S.repos[0].liteAt && !S.repos[0].enrichedAt, 'recorded as a light check, so the full check is still due');
      queries.length = 0;
      await sync(g);
      assert.equal(queries.length, 0, 'nothing changed: nothing asked again');
    } finally { S.visit = ''; S.token = ''; }
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

test('loading the same profile again during a check: the new check waits for the old one to stop, then runs', async () => {
  await check(async () => {
    const calls = fakeStarList([star(1), star(2)]), github = globalThis.fetch;
    let answer;
    const held = new Promise(resolve => { answer = resolve; });
    globalThis.fetch = async (url, init) => { if (!calls.length) await held; return github(url, init); };   // the first page is slow
    const first = task(sync);
    await new Promise(resolve => setTimeout(resolve, 10));
    nextGen();   // "Load stars" for the same profile: the old check is stopping but still holds the profile's lock
    const second = task(sync);
    answer();
    await Promise.all([first, second]);
    assert.doesNotMatch(els['#status'].textContent, /Another tab/, 'not mistaken for another tab');
    assert.equal(S.repos.length, 2, 'the new check ran');
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

test('a repo that left the star list: still online = unstarred and forgotten; deleted / private / hidden = its local copy is kept and marked', async () => {
  await check(async g => {
    const list = [star(1), star(2), star(3), star(4)];
    fakeStarList(list);
    await sync(g);
    S.readmes = {'2': {t: 'readme two', whole: true, at: Date.now(), pushed: PUSHED}, '3': {t: 'readme three', whole: true, at: Date.now(), pushed: PUSHED}};
    S.history = {'3': {c: [['aaaaaaaaaa', 1, 'msg']], rel: [], done: true}};

    // 1 unstarred (exists), 2 made private (404), 3 the name was taken by another repo (different id), 4 cannot be told (403)
    const calls = fakeStarList([star(1)], {repoStatus: {'acme/repo2': 404, 'acme/repo3': {id: 999}, 'acme/repo4': 403}});
    await sync(g);
    assert.deepEqual(calls.repoCalls.sort(), ['acme/repo2', 'acme/repo3', 'acme/repo4'], 'each missing repo was checked once');
    const by = id => S.repos.find(r => r.id === id);
    assert.equal(by(2).gone.at > 0, true, 'private: kept, marked');
    assert.equal(by(3).gone.at > 0, true, 'the name now belongs to another repository: the original is gone');
    assert.equal(by(4).gone, undefined, 'could not be verified: kept as it was, not marked');
    assert.equal(by(2).about, 'repo 2', 'with the cached details');
    assert.equal(S.repos.some(r => r.id === 1), true);
    assert.match(els['#status'].textContent, /2 removed or private \(kept\)/);
    // ...and the activity log tells exactly what was decided about each repo, and why
    const story = logText();
    assert.match(story, /3 cached repo\(s\) are not in your star list any more \(.*\): asking GitHub whether each still exists/);
    assert.match(story, /acme\/repo2 \(id 2\): GitHub answered 404 → REMOVED, private or hidden: the local copy is kept/);
    assert.match(story, /acme\/repo4 \(id 4\): GitHub answered 403 → cannot tell yet \(kept, asked again next time\)/);
    assert.match(story, /not in the list any more: 0 unstarred \(forgotten\) · 2 removed or private \(local copy kept\) · 1 not verified \(kept\)/);
    assert.match(story, /star list: 1 page\(s\), 1 repos, 0 page\(s\) unchanged \(304\)/);
    assert.match(story, /compared with the cache: 1 repos on GitHub · 0 new/);
    assert.match(els['#status'].textContent, /1 not verified/);
    assert.equal(S.readmes['2'].t, 'readme two', 'their README and commit index stay');
    assert.equal(S.history['3'].c.length, 1);
    assert.equal(by(2).starred, '2026-01-01T00:00:00Z');

    // The next check does not ask again about a repo verified a moment ago; the one that could not be verified is asked again.
    // (The log says so honestly: it does not claim to ask about repos it skips.)
    const again = fakeStarList([star(1)], {repoStatus: {'acme/repo2': 404, 'acme/repo3': {id: 999}, 'acme/repo4': 403}});
    await sync(g);
    assert.deepEqual(again.repoCalls, ['acme/repo4'], 'only the unverified one');
    assert.equal(by(4)?.gone, undefined);
    assert.equal(S.repos.length, 4);

    // Repo 4 turns out to exist: it was unstarred, so it disappears for good. Repo 2 becomes public and is starred again: it is a normal repo again.
    fakeStarList([star(1), star(2)]);
    await sync(g);
    assert.equal(S.repos.some(r => r.id === 4), false, 'unstarred: not shown, not cached');
    assert.equal(by(2).gone, undefined, 'back in the list: no longer marked');
    assert.equal(by(3).gone.at > 0, true, 'still gone');
  });
});

test('removed repos are not refreshed or indexed any more, and the unlisted ones are verified through GraphQL first with REST as the judge', async () => {
  await check(async g => {
    const listed = [star(1), star(2), star(3)];
    fakeStarList(listed);
    await sync(g);
    S.repos.find(r => r.id === 3).gone = {at: 1, checked: 1};
    const queries = [];
    const github = fakeStarList([star(1)], {repoStatus: {'acme/repo3': 404}}), rest = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url).endsWith('/graphql')) return rest(url, init);
      const query = JSON.parse(init.body).query, data = {};
      queries.push(query);
      for (const m of query.matchAll(/(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)/g)) data[m[1]] = m[3] === 'repo2' ? {databaseId: 2} : null;   // repo3 is "null" (private or a timeout)
      return {ok: true, status: 200, headers: new Headers(), json: async () => ({data})};
    };
    S.token = 'tok';
    try {
      await sync(g);
      const gql = queries.filter(q => q.includes('databaseId'));
      assert.equal(gql.length, 1, 'one call for both unlisted repos');
      assert.deepEqual(github.repoCalls, ['acme/repo3'], 'a GraphQL null is confirmed over REST; the repo GraphQL found is not');
      assert.equal(S.repos.some(r => r.id === 2), false, 'exists online: unstarred');
      assert.ok(S.repos.find(r => r.id === 3).gone, 'a 404 confirms it');
      assert.ok(!queries.some(q => /repository\(owner:"acme",name:"repo3"\)\{(lastCommit|languages)/.test(q)), 'the removed repo is not asked for details');
    } finally { S.token = ''; }
  });
});

test('what counts as removed: 404, 451 (taken down) and "access blocked" yes; a used-up budget or an unclear 403 no, those are asked again', async () => {
  await check(async g => {
    fakeStarList([star(1), star(2), star(3), star(4), star(5)]);
    await sync(g);
    const gone = id => S.repos.find(r => r.id === id)?.gone;

    const calls = fakeStarList([star(1)], {repoStatus: {'acme/repo2': 451, 'acme/repo3': 'blocked', 'acme/repo4': 403}});   // repo5: still online (unstarred)
    await sync(g);
    assert.ok(gone(2) && gone(3), 'taken down, blocked: kept as removed');
    assert.equal(gone(4), undefined, 'an unexplained 403 proves nothing');
    assert.ok(S.repos.some(r => r.id === 4) && !S.repos.some(r => r.id === 5), 'unverified is kept, unstarred is gone');
    assert.deepEqual(calls.repoCalls.sort(), ['acme/repo2', 'acme/repo3', 'acme/repo4', 'acme/repo5']);

    // A used-up budget ends the checks and removes nothing.
    S.repos.find(r => r.id === 4).gone = undefined;
    fakeStarList([star(1)], {repoStatus: {'acme/repo4': 'limit'}});
    await sync(g);
    assert.equal(S.repos.some(r => r.id === 4), true, 'rate limited: kept as it was');
    assert.equal(gone(4), undefined);
  });
});

test('a renamed repo is found by its id: when it is not in the list it is unstarred, never "removed"', async () => {
  await check(async g => {
    fakeStarList([star(1), star(2, 'acme/old-name')]);
    await sync(g);
    const asked = [];
    fakeStarList([star(1)]);   // repo 2 was renamed on GitHub; the old name no longer exists, the id does
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => { asked.push(new URL(url).pathname); return inner(url, init); };
    await sync(g);
    assert.ok(asked.includes('/repositories/2'), 'asked by id, not by the old name: ' + asked);
    assert.ok(!asked.includes('/repos/acme/old-name'));
    assert.equal(S.repos.some(r => r.id === 2), false);
  });
});
