// Tests for Visit mode: browsing someone else's stars without saving anything about them (store.js setVisit / get / put),
// against a fake local server (the cache) and a fake GitHub. "Keep cache" is ON in these tests: that is when a leak would hurt.
import test from 'node:test';
import assert from 'node:assert/strict';

const prefs = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: new Proxy({getItem: k => prefs.get(k) ?? null, setItem: (k, v) => prefs.set(k, String(v)), removeItem: k => prefs.delete(k)},
    {ownKeys: () => [...prefs.keys()], getOwnPropertyDescriptor: () => ({enumerable: true, configurable: true, value: ''})}),
  configurable: true,
});
const jar = new Map();
const els = {};
Object.defineProperty(globalThis, 'document', {
  value: {
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(line) { const [pair] = line.split('; '), i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); },
    querySelector: sel => (els[sel] ??= {value: '', checked: false, textContent: '', innerHTML: '', hidden: false}),
  },
  configurable: true,
});
globalThis.location = {hostname: 'localhost', protocol: 'http:'};
globalThis.window ??= {dispatchEvent() {}};
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };

const {S, nextGen} = await import('../public/js/state.js');
const store = await import('../public/js/store.js');
const {sync} = await import('../public/js/sync.js');

const star = (id, full) => ({starred_at: '2026-01-01T00:00:00Z', repo: {id, full_name: full, name: full.split('/')[1],
  owner: {login: full.split('/')[0], avatar_url: '', type: 'User'}, html_url: 'https://github.com/' + full, description: '', homepage: null,
  stargazers_count: id, forks_count: 0, open_issues_count: 0, language: 'Go', topics: [], license: null, archived: false, fork: false,
  created_at: '2025-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z', default_branch: 'main'}});

/** The local server's cache (GET / PUT / DELETE /cache/<key>, DELETE /cache) and a GitHub with bob's three stars, in one fetch. */
function backend() {
  const files = new Map(), puts = [], github = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://localhost'), method = init.method || 'GET', json = body => ({ok: true, status: 200, headers: new Headers({'content-type': 'application/json'}), json: async () => body});
    if (u.hostname === 'api.github.com') {
      github.push(u.pathname);
      if (u.pathname === '/graphql') {
        const data = {};
        for (const m of JSON.parse(init.body).query.matchAll(/(r\d+):repository\(/g)) data[m[1]] = {lastCommit: {target: {committedDate: '2026-02-02T00:00:00Z'}}, releases: {nodes: []}, latestRelease: null};
        return json({data});
      }
      return /\/users\/bob\/starred$/.test(u.pathname)
        ? {ok: true, status: 200, headers: new Headers({ETag: '"e"'}), json: async () => [star(1, 'a/one'), star(2, 'b/two'), star(3, 'c/three')]}
        : {ok: false, status: 404, headers: new Headers(), json: async () => ({})};
    }
    if (u.pathname === '/cache') { const deleted = files.size; files.clear(); return json({deleted}); }
    const key = decodeURIComponent(u.pathname.slice('/cache/'.length));
    if (method === 'PUT') { files.set(key, init.body); puts.push(key); return {ok: true, status: 204, headers: new Headers()}; }
    if (method === 'DELETE') { files.delete(key); return {ok: true, status: 204, headers: new Headers()}; }
    return json(files.has(key) ? JSON.parse(files.get(key)) : null);
  };
  return {files, puts, github};
}

const reset = () => {
  jar.clear(); prefs.clear(); store.setVisit('');
  Object.assign(S, {home: '', visit: '', user: '', token: '', repos: [], starPages: [], readmes: {}, history: {}, users: {}, loading: null,
    disc: {dismissed: [], results: {}}, starCurves: {}});
};

test('a visit saves nothing: sync, READMEs, index, suggestions, counts and star charts all stay in memory; the config keeps YOUR login', async () => {
  reset();
  const srv = backend();
  await store.initStore();
  await store.setPersist(true);   // "Keep cache" ON: the server would receive everything
  Object.assign(S, {home: 'me', token: 'tok'});
  await store.saveConfig();
  srv.puts.length = 0;

  store.setVisit('bob');
  S.user = 'bob';
  const g = nextGen();
  await sync(g);   // the star list and the light check, as a visit
  assert.equal(S.repos.length, 3, 'bob\'s stars are on screen');
  Object.assign(S, {readmes: {1: {t: 'a readme'}}, history: {1: {c: [['aaaaaaaaaa', 1, 'msg']], rel: [], done: true}},
    disc: {dismissed: ['x/y'], results: {}}, users: {a: {at: 1, stars: 3}}, starCurves: {'a/one': {at: 1, pts: null}}});
  await store.saveAll(g);
  assert.equal(await store.saveHistory(g), true, 'saving "works" from the app\'s point of view');
  await store.put('starcurves', S.starCurves);
  await store.saveConfig();   // e.g. the token was changed during the visit

  assert.deepEqual([...new Set(srv.puts)], ['config'], 'the only thing written is the config');
  assert.deepEqual(JSON.parse(srv.files.get('config')), {token: 'tok', user: 'me'}, 'which still names YOUR profile, not bob');
  assert.deepEqual([...srv.files.keys()], ['config']);
  assert.equal((await store.get('stars:bob')).repos.length, 3, 'the visit reads its own memory back');
  assert.equal((await store.loadHistory(g))['1'].c[0][2], 'msg');
});

test('a visit never reads a copy of that profile stored earlier, and leaving it forgets everything it held', async () => {
  reset();
  const srv = backend();
  await store.initStore();
  await store.setPersist(true);
  srv.files.set('stars:bob', JSON.stringify({v: 2, repos: [{id: 9, full: 'old/copy'}], pages: []}));
  Object.assign(S, {home: 'me', user: 'bob'});
  store.setVisit('bob');
  assert.equal(await store.get('stars:bob'), null, 'what is stored for bob is not read: a visit is its own, empty world');
  await store.put('stars:bob', {repos: [1]});
  await store.put('readmes:bob', {1: {t: 'x'}});
  assert.deepEqual(JSON.parse(srv.files.get('stars:bob')).repos, [{id: 9, full: 'old/copy'}], 'and the stored copy is left alone');

  store.setVisit('carol');   // visiting someone else: bob's data does not carry over
  assert.equal(await store.get('readmes:bob'), null);
  store.setVisit('');
  assert.equal(await store.get('stars:carol'), null);
  assert.equal(await store.get('readmes:bob'), null, 'and nothing of the visits is left once they end');
  assert.deepEqual([...srv.files.keys()], ['stars:bob'], 'the disk holds only what it held before');
});

test('after a visit its keys stay refused until the profile is adopted: a late job can not save it', async () => {
  reset();
  const srv = backend();
  await store.initStore();
  await store.setPersist(true);
  store.setVisit('Bob');   // case does not matter
  store.setVisit('');
  S.user = 'bob';          // as if a job of the visit were still running after it ended
  assert.equal(await store.put('stars:bob', {repos: []}), false);
  assert.equal(await store.put('history:bob:7', {}), false);
  assert.equal(await store.put('readmes:BOB', {}), false);
  assert.deepEqual(srv.puts, []);
  assert.equal(await store.put('stars:someoneelse', {repos: []}), true, 'other profiles are not affected');
  store.adoptProfile('bob');   // "★ Make this my profile", or loading it as your own
  assert.equal(await store.put('stars:bob', {repos: []}), true);
  assert.ok(srv.puts.includes('stars:bob'));
});

test('"Clear cache" ends a visit and forgets it: its memory is emptied and its keys are writable again', async () => {
  reset();
  backend();
  await store.initStore();
  await store.setPersist(true);
  store.setVisit('bob');
  await store.put('stars:bob', {repos: [1]});
  await store.clearAll();
  store.setVisit('');
  assert.equal(await store.get('stars:bob'), null);
  assert.equal(await store.put('stars:bob', {repos: []}), true, 'nothing remembers the visit any more');
});

test('nothing is saved while a profile is being read: the old profile\'s suggestions can not land under the new profile\'s name', async () => {
  reset();
  const srv = backend();
  await store.initStore();
  await store.setPersist(true);
  S.user = 'newprofile';   // load() has switched S.user, but S.disc is still the old profile's
  S.disc = {dismissed: ['old/profiles-dismissal'], results: {}};
  let done;
  S.loading = new Promise(resolve => { done = resolve; });
  const g = S.gen;
  assert.equal(await store.saveDisc(g), false);
  assert.equal(await store.saveStars(g), false);
  assert.equal(await store.saveReadmes(g), false);
  assert.equal(await store.saveUsers(g), false);
  assert.deepEqual(srv.puts, [], 'a "✕ Not interested" click in that window writes nothing');
  S.loading = null; done();
  assert.equal(await store.saveDisc(g), true, 'once the profile is loaded, saving works again');
});

test('while visiting, tiles say whether you starred them and offer ☆ Star for the rest; is:new / is:mine search it; removed repos say so', async () => {
  const {isMine, mineOf} = await import('../public/js/state.js');
  const {card, parseQuery, match} = await import('../public/js/list.js');
  reset();
  const a = {id: 1, full: 'a/one', name: 'one', owner: 'a', url: 'https://github.com/a/one', topics: [], stars: 1};
  const b = {...a, id: 2, full: 'b/two', name: 'two', owner: 'b', url: 'https://github.com/b/two'};
  try {
    assert.equal(isMine(a), true, 'outside a visit every repo shown is one of your stars');
    assert.ok(!card(a).includes('data-vstar') && !card(a).includes('starred by you'));
    S.visit = 'bob'; S.home = 'me';
    assert.equal(isMine(a), null, 'your own stars are not known yet');
    assert.ok(!card(a).includes('data-vstar'), 'no button until they are');
    assert.ok(match(a, parseQuery('is:new'), false) && match(a, parseQuery('is:mine'), false), 'unknown: the qualifier is ignored, nothing disappears');
    S.mine = mineOf([{id: 1, full: 'A/One'}]);
    assert.equal(isMine(a), true);
    assert.equal(isMine(b), false);
    assert.ok(card(a).includes('★ starred by you') && !card(a).includes('data-vstar'));
    assert.ok(card(b).includes('data-vstar="b/two"') && !card(b).includes('starred by you'));
    assert.equal(match(a, parseQuery('is:new'), false), null);
    assert.ok(match(b, parseQuery('is:new'), false));
    assert.ok(match(a, parseQuery('is:mine'), false));
    assert.equal(match(b, parseQuery('is:mine'), false), null);
    assert.ok(match(b, parseQuery('-is:mine'), false));
    assert.ok(!card({...b, gone: {at: 1}}).includes('data-vstar'), 'a removed repo can not be starred');
  } finally { S.visit = ''; S.home = ''; S.mine = null; }
  const gone = {...a, gone: {at: Date.now() - 3 * 864e5}};
  assert.ok(card(gone).includes('Removed, private or hidden on GitHub') && card(gone).includes('class="card gone"'));
  assert.ok(!card(a).includes('Removed, private'));
  assert.ok(match(gone, parseQuery('is:removed'), false));
  assert.equal(match(a, parseQuery('is:removed'), false), null);
});

test('removed or hidden repos get a clickable tag, a Status facet and a "show only" filter', async () => {
  const {render, showOnlyRemoved, card} = await import('../public/js/list.js');
  reset();
  const repo = (id, extra = {}) => ({id, full: `o/r${id}`, name: 'r' + id, owner: 'o', url: `https://github.com/o/r${id}`, topics: [], stars: 1, about: '', ...extra});
  S.repos = [repo(1), repo(2, {gone: {at: Date.now()}}), repo(3, {gone: {at: Date.now()}})];
  try {
    assert.ok(card(S.repos[1]).includes('data-gone="1"') && card(S.repos[1]).includes('removed / private'), 'a tag on the card');
    assert.ok(!card(S.repos[0]).includes('removed / private'));
    render();
    assert.match(els['#count'].innerHTML, /🚫 2 removed or hidden/, 'a chip says how many');
    assert.match(els['#facets'].innerHTML, /Status[\s\S]*Removed or hidden[\s\S]*>2</, 'and so does the sidebar');
    assert.equal((els['#list'].innerHTML.match(/class="card/g) || []).length, 3);
    showOnlyRemoved(true);
    assert.equal((els['#list'].innerHTML.match(/class="card/g) || []).length, 2, 'only the removed ones');
    assert.ok(!els['#list'].innerHTML.includes('o/r1"'));
    assert.match(els['#count'].innerHTML, /Status: removed or hidden ✕/, 'a pill to remove the filter');
    assert.match(els['#count'].innerHTML, /2 of 3 repos \(filtered\)/);
    showOnlyRemoved(false);
    assert.equal((els['#list'].innerHTML.match(/class="card/g) || []).length, 3);
    S.repos = [repo(1)];
    render();
    assert.ok(!/removed or hidden/.test(els['#count'].innerHTML + els['#facets'].innerHTML), 'nothing removed: no chip, no facet');
  } finally { S.repos = []; showOnlyRemoved(false); }
});
