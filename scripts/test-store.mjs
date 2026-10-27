// Tests for the cache toggle ("Keep cache": off by default, remembered by a cookie) and for clearing everything (store.js),
// against a fake local server and a fake cookie jar.
import test from 'node:test';
import assert from 'node:assert/strict';

const prefs = new Map();
// Object.keys(localStorage) must list the stored preferences, like a browser's Storage does
const storageApi = {getItem: k => prefs.get(k) ?? null, setItem: (k, v) => prefs.set(k, String(v)), removeItem: k => prefs.delete(k)};
Object.defineProperty(globalThis, 'localStorage', {
  value: new Proxy(storageApi, {ownKeys: () => [...prefs.keys()], getOwnPropertyDescriptor: () => ({enumerable: true, configurable: true, value: ''})}),
  configurable: true,
});

const jar = new Map();
Object.defineProperty(globalThis, 'document', {
  value: {
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(line) { const [pair, ...attrs] = line.split('; '), i = pair.indexOf('='); attrs.includes('max-age=0') ? jar.delete(pair.slice(0, i)) : jar.set(pair.slice(0, i), pair.slice(i + 1)); },
    querySelector: () => ({textContent: ''}),
  },
  configurable: true,
});
globalThis.location = {hostname: 'localhost', protocol: 'http:'};

const {S} = await import('../public/js/state.js');
let n = 0;
const freshStore = () => import(`../public/js/store.js?instance=${++n}`);   // a new module instance = a page (re)load

/** A fake local server: GET / PUT / DELETE /cache/<key>, and DELETE /cache. */
function fakeServer() {
  const files = new Map(), log = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url, 'http://localhost').pathname, method = init.method || 'GET';
    log.push(`${method} ${path}`);
    const json = body => ({ok: true, status: 200, headers: new Headers({'content-type': 'application/json'}), json: async () => body});
    if (path === '/cache') { const deleted = files.size; files.clear(); return json({deleted}); }
    const key = decodeURIComponent(path.slice('/cache/'.length));
    if (method === 'PUT') { files.set(key, init.body); return {ok: true, status: 204, headers: new Headers()}; }
    return json(files.has(key) ? JSON.parse(files.get(key)) : null);
  };
  return {files, log};
}

test('"Keep cache" is off by default: nothing is read from or written to the server, the data lives in memory', async () => {
  jar.clear(); prefs.clear();
  const srv = fakeServer();
  const store = await freshStore();
  const info = await store.initStore();
  assert.deepEqual(info, {mode: 'memory', serverUp: true, persistOn: false});
  assert.equal(store.persisting(), false);
  S.user = 'someone';
  await store.put('stars:someone', {repos: [1, 2, 3]});
  assert.deepEqual(await store.get('stars:someone'), {repos: [1, 2, 3]}, 'still readable in this tab');
  assert.equal(srv.files.size, 0);
  assert.ok(!srv.log.some(l => l.startsWith('PUT')), 'no write reached the server');
});

test('turning it on remembers the choice in a cookie, uses the local server, and survives a reload; off is remembered too', async () => {
  jar.clear(); prefs.clear();
  const srv = fakeServer();
  let store = await freshStore();
  await store.initStore();
  await store.setPersist(true);
  assert.equal(jar.get('starsViewerCache'), '1');
  assert.equal(store.persisting(), true);
  await store.put('stars:someone', {repos: [1]});
  assert.deepEqual(JSON.parse(srv.files.get('stars:someone')), {repos: [1]}, 'now written to the server');

  store = await freshStore();   // reload the page
  assert.deepEqual(await store.initStore(), {mode: 'server', serverUp: true, persistOn: true});
  assert.deepEqual(await store.get('stars:someone'), {repos: [1]});

  await store.setPersist(false);
  assert.equal(jar.get('starsViewerCache'), '0');
  store = await freshStore();
  assert.equal((await store.initStore()).mode, 'memory');
  assert.ok(srv.files.has('stars:someone'), 'turning it off leaves the files alone');
});

test('the cookie beats the flag of older versions; without a cookie that flag still counts; online it is the browser store', async () => {
  fakeServer();
  jar.clear(); prefs.clear(); prefs.set('starsViewer.browserCache', '1');
  assert.equal((await (await freshStore()).initStore()).persistOn, true, 'an older version\'s localStorage flag');
  jar.set('starsViewerCache', '0');
  assert.equal((await (await freshStore()).initStore()).persistOn, false, 'the cookie wins');
  jar.set('starsViewerCache', '1');
  prefs.clear();
  globalThis.location = {hostname: 'someone.github.io', protocol: 'https:'};   // no local server: online
  assert.deepEqual(await (await freshStore()).initStore(), {mode: 'browser', serverUp: false, persistOn: true});
  globalThis.location = {hostname: 'localhost', protocol: 'http:'};
});

test('saveAll writes the whole tab state; clearAll erases the server files, this tab and the preferences (but not the cookie)', async () => {
  jar.clear(); prefs.clear();
  const srv = fakeServer();
  const store = await freshStore();
  await store.initStore();
  await store.setPersist(true);
  Object.assign(S, {user: 'Someone', token: 'tok', repos: [{id: 1, full: 'a/b'}, {id: 2, full: 'c/d'}], starPages: [], readmes: {1: {t: 'readme'}},
    history: {1: {c: [], rel: [], done: true}, 2: {c: [], rel: [], done: true}}, disc: {dismissed: [], results: {}}, starCurves: {'a/b': {pts: null}}});
  prefs.set('starsViewer.hideForks', '1'); prefs.set('starsViewer.histOpts', '{}'); prefs.set('tokenPanelOpen', '1'); prefs.set('unrelated', 'keep me');

  await store.saveAll(S.gen);
  for (const key of ['config', 'starcurves', 'stars:someone', 'readmes:someone', 'discover:someone']) assert.ok(srv.files.has(key), key);
  assert.equal(JSON.parse(srv.files.get('config')).token, 'tok');
  assert.equal([...srv.files.keys()].filter(k => k.startsWith('history:someone:')).length, 256, 'every history shard');
  assert.ok(JSON.parse(srv.files.get('stars:someone')).repos.length === 2);

  const {files} = await store.clearAll();
  assert.ok(files > 256, 'the server reported what it deleted');
  assert.equal(srv.files.size, 0, 'the server has nothing left');
  assert.equal((await store.get('config')), null, 'nor does this tab remember it');
  assert.deepEqual([...prefs.keys()], ['unrelated'], 'the app\'s preferences are gone, other keys are not touched');
  assert.equal(jar.get('starsViewerCache'), '1', 'the toggle itself is a preference and stays');
  Object.assign(S, {user: '', token: '', repos: [], readmes: {}, history: {}, starCurves: {}});
});

test('switching "Keep cache" off keeps this tab\'s data: loading the profile again does not start from nothing', async () => {
  jar.clear(); prefs.clear();
  const srv = fakeServer();
  const store = await freshStore();
  await store.initStore();
  await store.setPersist(true);   // the local server holds the cache; this tab never copied it into memory
  Object.assign(S, {user: 'Someone', token: 'tok', repos: [{id: 1, full: 'a/b'}], starPages: [], readmes: {1: {t: 'readme'}},
    history: {1: {c: [['aaaaaaaaaa', 1, 'msg']], rel: [], done: true}}, disc: {dismissed: [], results: {}}, starCurves: {}});
  try {
    await store.setPersist(false);
    assert.deepEqual((await store.get('stars:someone')).repos, S.repos, 'what "Load stars" reads next');
    assert.equal((await store.get('readmes:someone'))[1].t, 'readme');
    assert.equal((await store.loadHistory())[1].c[0][2], 'msg', 'and the commit index, which costs many requests to rebuild');
    assert.ok(!srv.log.some(l => l.startsWith('PUT')), 'nothing was written to the server');
  } finally { Object.assign(S, {user: '', token: '', repos: [], readmes: {}, history: {}}); }
});

test('history saves run one after another: a later save is never overwritten by an earlier, slower one', async () => {
  jar.clear(); prefs.clear();
  const srv = fakeServer();
  const store = await freshStore();
  await store.initStore();
  await store.setPersist(true);
  const {nextGen} = await import('../public/js/state.js');
  S.user = 'order';
  const g = nextGen(), serverFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {   // the first save's shard takes a while to reach the server
    if (init?.method === 'PUT' && init.body.includes('"older"')) await new Promise(resolve => setTimeout(resolve, 30));
    return serverFetch(url, init);
  };
  try {
    S.history = {7: {c: [['aaaaaaaaaa', 1, 'older']], rel: [], done: false}};
    store.markHistory('7');
    const first = store.saveHistory(g);
    await new Promise(resolve => setTimeout(resolve, 5));   // its write is on its way
    S.history = {7: {c: [['bbbbbbbbbb', 2, 'newer']], rel: [], done: true}};
    store.markHistory('7');
    assert.deepEqual(await Promise.all([first, store.saveHistory(g)]), [true, true]);
    const shard = JSON.parse(srv.files.get(`history:order:${store.shardOf('7')}`));
    assert.equal(shard[7].c[0][2], 'newer', 'the newest records are what is stored');
  } finally { globalThis.fetch = serverFetch; Object.assign(S, {user: '', history: {}}); }
});

test('a key that could not be read is never overwritten by what this tab holds; a later good read lifts the block', async () => {
  jar.clear(); prefs.clear();
  const srv = fakeServer();
  const store = await freshStore();
  await store.initStore();
  await store.setPersist(true);
  srv.files.set('readmes:someone', JSON.stringify({1: {t: 'precious'}}));
  const serverFetch = globalThis.fetch;
  let failing = true;
  globalThis.fetch = async (url, init) => failing && (init?.method || 'GET') === 'GET'
    ? {ok: false, status: 500, headers: new Headers(), json: async () => ({})} : serverFetch(url, init);

  assert.equal(await store.get('readmes:someone'), null, 'a failed read looks like "nothing stored"...');
  assert.equal(store.isUnreadable('readmes:someone'), true, '...but is remembered as a failure');
  assert.equal(await store.put('readmes:someone', {}), false, 'so the near-empty copy of this tab is refused');
  assert.deepEqual(JSON.parse(srv.files.get('readmes:someone')), {1: {t: 'precious'}}, 'and the stored data is untouched');
  assert.equal(await store.put('stars:someone', {repos: []}), true, 'other keys are not affected');

  failing = false;
  assert.deepEqual(await store.get('readmes:someone'), {1: {t: 'precious'}});
  assert.equal(store.isUnreadable('readmes:someone'), false);
  assert.equal(await store.put('readmes:someone', {2: {t: 'new'}}), true);
  assert.deepEqual(JSON.parse(srv.files.get('readmes:someone')), {2: {t: 'new'}});

  // A key that simply doesn't exist (200 "null") is not a failure.
  assert.equal(await store.get('discover:nobody'), null);
  assert.equal(store.isUnreadable('discover:nobody'), false);
});

test('a history save cut short by a profile switch leaves nothing to be written under the new profile', async () => {
  jar.clear(); prefs.clear();
  const srv = fakeServer();
  const store = await freshStore();
  await store.initStore();
  await store.setPersist(true);
  const {nextGen} = await import('../public/js/state.js');
  S.user = 'old';
  const g = nextGen();
  S.history = {1: {c: [], rel: [], done: true}};
  store.markAllHistory();
  const serverFetch = globalThis.fetch;
  let switched = false;
  globalThis.fetch = async (url, init) => {
    const answer = await serverFetch(url, init);
    if (init?.method === 'PUT' && !switched) {   // what load() does when another profile is picked mid-save
      switched = true;
      S.user = 'new'; S.history = {};
      nextGen(); store.forgetHistoryDirty();
    }
    return answer;
  };
  try {
    assert.equal(await store.saveHistory(g), false, 'the old save stops');
    assert.equal(store.historyDirty(), 0, 'and marks nothing for the new profile, whose shards are still being read');
    assert.equal([...srv.files.keys()].filter(k => k.startsWith('history:new:')).length, 0);
  } finally { globalThis.fetch = serverFetch; Object.assign(S, {user: '', history: {}}); }
});

test('shards the previous profile left unsaved are forgotten', async () => {
  const store = await freshStore();
  store.markHistory('123');
  store.markHistory('456');
  assert.ok(store.historyDirty() > 0);
  store.forgetHistoryDirty();
  assert.equal(store.historyDirty(), 0);
});
