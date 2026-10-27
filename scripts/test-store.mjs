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
