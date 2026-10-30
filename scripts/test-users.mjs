// Tests for the Users list (users.js) and the GitHub calls behind it (github.js ownerStats / starredCount), against a fake GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)},
  configurable: true,
});
const els = {};
const el = sel => (els[sel] ??= {value: '', checked: false, textContent: '', innerHTML: '', hidden: true, title: '',
  classList: {add() { this.on = true; }, remove() { this.on = false; }, toggle(_, force) { this.on = force; }, contains() { return !!this.on; }},
  setAttribute() {}, scrollIntoView() {}, addEventListener() {}});
globalThis.document = {querySelector: el};
globalThis.window = {dispatchEvent() {}, addEventListener() {}};
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };

const {S, nextGen} = await import('../public/js/state.js');
const {ownerStats, starredCount, mapStar} = await import('../public/js/github.js');
const {buildUsers, sortUsers, filterUsers, needsStats, isPerson, renderUsers, initUsers} = await import('../public/js/users.js');
const store = await import('../public/js/store.js');

const repo = (id, owner, extra = {}) => ({id, full: `${owner}/r${id}`, name: 'r' + id, owner, avatar: `https://avatars.githubusercontent.com/u/${id}`, topics: [], stars: 1, ...extra});
const DAY = 864e5;

test('mapStar keeps whether the owner is a person or an organization', () => {
  const x = {id: 1, full_name: 'o/r', name: 'r', owner: {login: 'o', avatar_url: '', type: 'Organization'}, html_url: '', stargazers_count: 1, forks_count: 0, open_issues_count: 0, topics: []};
  assert.equal(mapStar({starred_at: 'x', repo: x}).ownerType, 'Organization');
});

test('buildUsers: one entry per owner (case-insensitive), with how many of your stars they own and what is known about their own stars', () => {
  const repos = [repo(1, 'Alice', {ownerType: 'User'}), repo(2, 'alice'), repo(3, 'acme', {ownerType: 'Organization'}), repo(4, 'bob')];
  const stats = {alice: {at: 5, type: 'User', stars: 12, followers: 3, name: 'Alice A.'}, bob: {at: 5, missing: true}};
  const users = Object.fromEntries(buildUsers(repos, stats).map(u => [u.key, u]));
  assert.deepEqual(Object.keys(users).sort(), ['acme', 'alice', 'bob']);
  assert.deepEqual([users.alice.n, users.alice.login, users.alice.stars, users.alice.followers, users.alice.name], [2, 'Alice', 12, 3, 'Alice A.']);
  assert.equal(users.alice.avatar, repos[0].avatar);
  assert.equal(users.acme.type, 'Organization');
  assert.equal(isPerson(users.acme), false);
  assert.equal(users.bob.missing, true);
  assert.equal(users.bob.stars, null);
  assert.equal(users.acme.stars, undefined, 'never asked');
});

test('users are sorted (unknown counts last in both directions) and filtered by name, login and type', () => {
  const list = () => buildUsers([repo(1, 'a'), repo(2, 'b'), repo(3, 'b'), repo(4, 'c', {ownerType: 'Organization'}), repo(5, 'd')],
    {a: {at: 1, type: 'User', stars: 50, name: 'Zed Person'}, b: {at: 1, type: 'User', stars: 5}, d: {at: 1, type: 'User', stars: 0}});
  const order = (key, dir) => sortUsers(list(), key, dir).map(u => u.key).join('');
  assert.equal(order('n', -1), 'bacd', 'most of your stars first; ties by login');
  assert.equal(order('stars', -1), 'abdc', 'highest first, the organization (no count) last');
  assert.equal(order('stars', 1), 'dbac', 'lowest first, the organization still last');
  assert.equal(order('login', 1), 'abcd');
  assert.deepEqual(filterUsers(list(), 'zed').map(u => u.key), ['a'], 'matches the real name');
  assert.deepEqual(filterUsers(list(), 'B').map(u => u.key), ['b']);
  assert.deepEqual(filterUsers(list(), '', 'org').map(u => u.key), ['c']);
  assert.deepEqual(filterUsers(list(), '', 'person').map(u => u.key), ['a', 'b', 'd']);
});

test('counts are refetched after a week, never for organizations, and "not found" users wait for the week too', () => {
  const now = Date.now();
  const u = (extra = {}) => ({type: 'User', ...extra});
  assert.equal(needsStats(u(), now), true, 'never counted');
  assert.equal(needsStats(u({at: now - DAY}), now), false);
  assert.equal(needsStats(u({at: now - 8 * DAY}), now), true);
  assert.equal(needsStats(u({at: now - DAY, missing: true}), now), false);
  assert.equal(needsStats({type: 'Organization'}, now), false);
  assert.equal(needsStats({type: 'Bot'}, now), false);
});

/** A fake GitHub GraphQL endpoint knowing a few owners; `starred` fakes /users/<login>/starred?per_page=1. */
function fakeGitHub(owners, {failBatch = () => false} = {}) {
  const calls = {graphql: 0, logins: [], rest: []};
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), reply = (status, body, headers = {}) => ({ok: status < 300, status, headers: new Headers(headers), json: async () => body});
    if (u.pathname === '/graphql') {
      calls.graphql++;
      const query = JSON.parse(init.body).query, data = {};
      const logins = [...query.matchAll(/(u\d+):repositoryOwner\(login:"([^"]+)"\)/g)];
      calls.logins.push(logins.length);
      if (failBatch(calls.graphql)) return reply(403, {});   // "slow down": not fatal, not retried by ghFetch
      for (const [, alias, login] of logins) {
        const o = owners[login.toLowerCase()];
        data[alias] = !o ? null : o.org ? {__typename: 'Organization', login, name: o.name}
          : {__typename: 'User', login, name: o.name, starredRepositories: {totalCount: o.stars}, followers: {totalCount: o.followers}};
      }
      return reply(200, {data});
    }
    const m = u.pathname.match(/^\/users\/([^/]+)\/starred$/);
    if (m) {
      calls.rest.push(m[1]);
      const o = owners[m[1].toLowerCase()];
      if (!o) return reply(404, {});
      const link = o.stars > 1 ? {Link: `<https://api.github.com/user/1/starred?per_page=1&page=2>; rel="next", <https://api.github.com/user/1/starred?per_page=1&page=${o.stars}>; rel="last"`} : {};
      return reply(200, o.stars ? [{id: 1}] : [], {...link, 'x-ratelimit-remaining': '41'});
    }
    return reply(404, {});
  };
  return calls;
}

test('ownerStats asks 50 users per GraphQL call, tells users from organizations, and reports users GitHub no longer knows', async () => {
  const owners = {gone: null};
  const logins = Array.from({length: 120}, (_, i) => 'user' + i);
  for (const l of logins) owners[l] = {name: 'N ' + l, stars: l.length, followers: 7};
  owners.user3 = {org: true, name: 'An Org'};
  const calls = fakeGitHub(owners), got = new Map();
  S.token = 'tok';
  try {
    const res = await ownerStats([...logins, 'Gone'], batch => batch.forEach((v, k) => got.set(k, v)));
    assert.deepEqual(calls.logins.sort((a, b) => b - a), [50, 50, 21], '121 users in 3 calls');
    assert.equal(res.failed, 0);
    assert.equal(got.size, 121);
    assert.deepEqual(got.get('user5'), {type: 'User', name: 'N user5', stars: 5, followers: 7});
    assert.equal(got.get('user3').type, 'Organization');
    assert.equal(got.get('user3').stars, null);
    assert.equal(got.get('gone'), null, 'unknown to GitHub');
  } finally { S.token = ''; }
});

test('ownerStats: a failed batch is counted and skipped, a rejected token stops the rest', async () => {
  const owners = Object.fromEntries(Array.from({length: 120}, (_, i) => ['u' + i, {name: '', stars: 1, followers: 0}]));
  const logins = Object.keys(owners);
  let calls = fakeGitHub(owners, {failBatch: n => n === 2});
  S.token = 'tok';
  try {
    const got = new Map(), res = await ownerStats(logins, b => b.forEach((v, k) => got.set(k, v)));
    assert.equal(res.failed, 50, 'one batch of 50 was skipped');
    assert.equal(got.size, 70);

    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ok: false, status: 401, headers: new Headers(), json: async () => ({})});
    await assert.rejects(ownerStats(logins, () => {}), e => e.fatal === true);
    globalThis.fetch = realFetch;

    let stop = false;
    const many = Array.from({length: 400}, (_, i) => 'm' + i);
    calls = fakeGitHub(Object.fromEntries(many.map(l => [l, {name: '', stars: 1, followers: 0}])));
    await ownerStats(many, () => { stop = true; }, () => stop);
    assert.ok(calls.graphql <= 3, 'halted() ends the run between batches: only the 3 calls already in flight (of 8 batches) were made, got ' + calls.graphql);
  } finally { S.token = ''; }
});

test('starredCount reads the star count from the last-page link (one repo per page), or from the list when there is no link', async () => {
  fakeGitHub({many: {stars: 1512}, one: {stars: 1}, none: {stars: 0}});
  assert.deepEqual(await starredCount('many'), {stars: 1512, remaining: 41});
  assert.equal((await starredCount('one')).stars, 1);
  assert.equal((await starredCount('none')).stars, 0);
  assert.equal((await starredCount('nobody')).missing, true);
});

test('the Users panel counts people with one request each without a token, keeps the answers, and saves them with the profile', async () => {
  const saved = [];
  const realPut = globalThis.fetch;
  const calls = fakeGitHub({alice: {stars: 30}, bob: {stars: 0}});
  S.user = 'me'; S.token = ''; S.users = {};
  S.repos = [repo(1, 'alice', {ownerType: 'User'}), repo(2, 'bob', {ownerType: 'User'}), repo(3, 'acme', {ownerType: 'Organization'})];
  const clicks = {};
  globalThis.window.addEventListener = (type, fn) => { clicks[type] = fn; };
  initUsers();
  el('#usersPanel').classList.add();   // the panel is open
  const g = nextGen();
  try {
    await el('#usersFetch').onclick();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(calls.rest.sort(), ['alice', 'bob'], 'the organization is never asked');
    assert.equal(S.users.alice.stars, 30);
    assert.equal(S.users.bob.stars, 0);
    assert.match(el('#usersNote').textContent, /Counted 2 users · 41 requests left this hour/);
    renderUsers();
    const html = el('#usersTable').innerHTML;
    assert.ok(html.includes('?visit=alice') && html.includes('https://github.com/alice?tab=stars'), 'a person: visit link and GitHub stars link');
    assert.ok(!html.includes('?visit=bob'), 'someone with no stars has nothing to visit');
    assert.ok(!html.includes('?visit=acme') && html.includes('href="https://github.com/acme"'), 'an organization: only its GitHub page');
    assert.equal(g, S.gen);
  } finally { globalThis.fetch = realPut; S.users = {}; S.repos = []; S.user = ''; }
});
