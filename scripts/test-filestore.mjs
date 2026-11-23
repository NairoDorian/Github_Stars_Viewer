// Tests for how file lists are stored (store.js "File lists", files.js): the summaries in one small record, the paths packed
// in small shards that are read only when a search needs them, the one-time upgrade of the older layout (64 big shards
// read at every start), and what happens to the paths when the cache is switched or a visit is adopted. Against a fake
// local server that records every call.
import test from 'node:test';
import assert from 'node:assert/strict';

const prefs = new Map(), jar = new Map();
Object.defineProperty(globalThis, 'localStorage', {value: {getItem: k => prefs.get(k) ?? null, setItem: (k, v) => prefs.set(k, String(v)), removeItem: k => prefs.delete(k)}, configurable: true});
const el = {value: '', checked: false, textContent: '', innerHTML: '', hidden: false, title: '', classList: {add() {}, remove() {}}};
Object.defineProperty(globalThis, 'document', {
  value: {
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(line) { const pair = line.split('; ')[0], i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); },
    querySelector: () => el, querySelectorAll: () => [],
  },
  configurable: true,
});
globalThis.location = {hostname: 'localhost', protocol: 'http:'};

const {S, nextGen} = await import('../public/js/state.js');
const store = await import('../public/js/store.js');
const {toRecord, setFileList, forgetFileList, pathsOf, loadPaths, releasePaths, pathsReady, pathHit, upgradeFiles, filesNeedUpgrade, clearFiles, incomplete} = await import('../public/js/files.js');
const {unpackPaths} = await import('../public/js/paths.js');
const {KINDS_VERSION} = await import('../public/js/filekinds.js');

/** A fake local server: GET / PUT / DELETE /cache/<key>. `fail(method, key)` → true makes that call answer 500. */
function fakeServer() {
  const files = new Map(), log = [];
  const srv = {files, log, fail: () => false, onCall: null};
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url, 'http://localhost').pathname, method = init.method || 'GET';
    if (!path.startsWith('/cache')) throw new Error('no request leaves for ' + url);
    const key = decodeURIComponent(path.slice('/cache/'.length));
    log.push(`${method} ${key}`);
    await srv.onCall?.(method, key);
    const json = body => ({ok: true, status: 200, headers: new Headers({'content-type': 'application/json'}), json: async () => body});
    if (srv.fail(method, key)) return {ok: false, status: 500, headers: new Headers({'content-type': 'application/json'}), json: async () => { throw new Error('boom'); }};
    if (method === 'PUT') { files.set(key, init.body); return {ok: true, status: 204, headers: new Headers()}; }
    if (method === 'DELETE') { files.delete(key); return {ok: true, status: 204, headers: new Headers()}; }
    return json(files.has(key) ? JSON.parse(files.get(key)) : null);
  };
  return srv;
}
const stored = (srv, key) => srv.files.has(key) ? JSON.parse(srv.files.get(key)) : undefined;
const repo = (id, full) => ({id, full, owner: full.split('/')[0], name: full.split('/')[1], url: 'https://github.com/' + full, topics: [], pushed: 'p1', branch: 'main', stars: 1});
const give = (r, paths) => { const {rec, packed} = toRecord(r, {tree: paths.map(path => ({path, type: 'blob'}))}, '"e"'); setFileList(String(r.id), rec, packed); return rec; };
const pathKey = id => `paths:me:${store.pathShardOf(id)}`;
/** A page (re)load with "Keep cache" on: the server is the store, this tab knows nothing yet. */
async function open(srv, cache = '1') {
  jar.set('starsViewerCache', cache);
  await store.initStore();
  S.user = 'me'; S.visit = ''; S.loading = null; S.files = {}; S.repos = [];
  const g = nextGen();
  store.forgetHistoryDirty();
  releasePaths();
  srv.log.length = 0;
  return g;
}
const a = repo(1, 'o/a'), b = repo(2, 'o/b');

test('the summaries are one small record read at start; the paths are packed in small shards, read only when a search needs them', async () => {
  const srv = fakeServer();
  let g = await open(srv);
  S.repos = [a, b];
  give(a, ['hw/board.kicad_pcb', 'hw/gerber/top.gtl', 'README.md']);
  give(b, ['src/main.rs', 'Cargo.toml']);
  assert.notEqual(pathKey(1), pathKey(2), 'the two test repos live in different shards');
  assert.equal(await store.saveFiles(g), true);
  const puts = srv.log.filter(l => l.startsWith('PUT'));
  assert.deepEqual(puts.slice().sort(), [`PUT filesum:me`, `PUT ${pathKey(1)}`, `PUT ${pathKey(2)}`].sort());
  assert.equal(puts.at(-1), 'PUT filesum:me', 'the summaries are written after the paths they describe');
  const sum = stored(srv, 'filesum:me');
  assert.deepEqual([sum.v, Object.keys(sum.recs), sum.recs['1'].n, sum.recs['1'].s.kinds, 'p' in sum.recs['1'], sum.old], [3, ['1', '2'], 3, {pcb: 1, gerber: 1}, false, undefined]);
  assert.deepEqual(Object.keys(stored(srv, pathKey(1))), ['1']);
  assert.deepEqual(unpackPaths(stored(srv, pathKey(1))['1']).sort(), ['README.md', 'hw/board.kicad_pcb', 'hw/gerber/top.gtl']);
  assert.ok(srv.files.get(pathKey(1)).length < 90, 'a folder is stored once: ' + srv.files.get(pathKey(1)));

  // a reload: one read brings every summary, not a single path shard is touched
  g = await open(srv);
  const got = await store.loadFiles(g);
  assert.deepEqual([Object.keys(got.recs), got.legacy], [['1', '2'], false]);
  assert.deepEqual(srv.log, ['GET filesum:me'], 'the start reads the summaries only');
  S.files = got.recs; S.repos = [a, b];
  assert.deepEqual([filesNeedUpgrade(), pathsReady(), pathHit(a, 'gerber')], [false, false, null]);
  // a search of file names reads them, once
  assert.equal(await loadPaths(), true);
  assert.equal(srv.log.filter(l => l.startsWith('GET paths:me:')).length, store.PATH_SHARDS);
  assert.deepEqual([pathHit(a, 'gerber/top'), pathHit(b, 'cargo'), pathHit(b, 'gerber')], ['hw/gerber/top.gtl', 'Cargo.toml', null]);
  srv.log.length = 0;
  await loadPaths();
  assert.deepEqual(srv.log, [], 'already in memory: nothing is read again');

  // changing one repo rewrites its shard and the summaries, nothing else
  give(a, ['hw/board.kicad_pcb', 'case/lid.stl']);
  assert.equal(pathHit(a, 'lid'), 'case/lid.stl', 'known to the search at once');
  await store.saveFiles(g);
  assert.deepEqual(srv.log, [`GET ${pathKey(1)}`, `PUT ${pathKey(1)}`, 'PUT filesum:me']);
  // an unchanged tree (304) only touches the summaries
  S.files['2'] = {...S.files['2'], at: Date.now()}; store.markFiles();
  srv.log.length = 0;
  await store.saveFiles(g);
  assert.deepEqual(srv.log, ['PUT filesum:me']);
  // a repo that goes takes its paths with it; a shard left empty is deleted
  assert.equal(forgetFileList('2'), true);
  srv.log.length = 0;
  await store.saveFiles(g);
  assert.deepEqual(srv.log, [`GET ${pathKey(2)}`, `DELETE ${pathKey(2)}`, 'PUT filesum:me']);
  assert.deepEqual([srv.files.has(pathKey(2)), Object.keys(stored(srv, 'filesum:me').recs), pathHit(b, 'cargo')], [false, ['1'], null]);
  releasePaths();
  assert.deepEqual(await pathsOf(a), ['hw/board.kicad_pcb', 'case/lid.stl'], 'one repo\'s paths can be read without loading them all');
  // 🗑 Clear file lists: the summaries first, then every shard
  assert.equal(await clearFiles(g), 1);
  assert.deepEqual([stored(srv, 'filesum:me').recs, [...srv.files.keys()].filter(k => k.startsWith('paths:'))], [{}, []]);
});

test('paths that could not be stored hold their summaries back; a shard that could not be read is never rebuilt from nothing', async () => {
  const srv = fakeServer();
  const g = await open(srv);
  S.repos = [a, b];
  give(a, ['a.c']); give(b, ['b.c']);
  srv.fail = (method, key) => method === 'PUT' && key === pathKey(1);
  assert.equal(await store.saveFiles(g), false);
  assert.equal(srv.files.has('filesum:me'), false, 'no summary reaches the store before its paths');
  assert.equal(srv.files.has(pathKey(2)), true, 'what could be written was');
  srv.fail = () => false;
  srv.log.length = 0;
  assert.equal(await store.saveFiles(g), true, 'the next save writes what was kept');
  assert.deepEqual(srv.log, [`GET ${pathKey(1)}`, `PUT ${pathKey(1)}`, 'PUT filesum:me']);
  // the shard of repo 1 can't be read (a locked file, a server hiccup): its stored content is unknown, so it is left alone
  give(a, ['a.c', 'new.c']);
  srv.fail = (method, key) => method === 'GET' && key === pathKey(1);
  srv.log.length = 0;
  assert.equal(await store.saveFiles(g), false);
  assert.deepEqual(srv.log, [`GET ${pathKey(1)}`], 'nothing is written over it');
  assert.deepEqual(unpackPaths(stored(srv, pathKey(1))['1']), ['a.c']);
  assert.equal(stored(srv, 'filesum:me').recs['1'].n, 1, 'and the summaries still describe what is stored');
  srv.fail = () => false;
  assert.equal(await store.saveFiles(g), true);
  assert.deepEqual([unpackPaths(stored(srv, pathKey(1))['1']), stored(srv, 'filesum:me').recs['1'].n], [['a.c', 'new.c'], 2]);
});

/** What an older version stored: 64 shards `files:<user>:<n>` of whole records, paths as plain arrays. */
function legacy(srv) {
  const sOld = {v: 1, n: 1, kinds: {}, ex: {}, build: [], ext: [], boards: 0, top: []};
  srv.files.set('files:me:3', JSON.stringify({
    11: {p: ['hw/board.kicad_pcb', 'hw/gerber/top.gtl', 'docs/cheatsheet.pdf', 'lib/x/datasheet.pdf'], n: 4, fv: 2, s: sOld, branch: 'main', etag: '"e11"', pushed: 'p1', at: 1000, subs: 1, trunc: false, walked: false},
    12: {p: ['web/package.json', 'web/index.js'], n: 2, s: sOld, branch: 'main', etag: '"e12"', pushed: 'p1', at: 1000},   // version 1: node_modules may be missing
    13: {p: [], n: 0, s: sOld, miss: 409, branch: 'main', pushed: 'p1', at: 1000},
  }));
  srv.files.set('files:me:40', JSON.stringify({
    14: {p: ['README.md', 'src/a.c'], n: 2, fv: 2, s: sOld, trunc: true, walked: false, branch: 'main', etag: '"e14"', pushed: 'p1', at: 1000, walk: {ref: 'root', requests: 3, todo: [{sha: 'b1', prefix: 'big/', recursive: false}]}},
    15: {p: ['a\nb.txt', 'İ/Ü.STL'], n: 2, fv: 2, s: sOld, branch: 'main', etag: '"e15"', pushed: 'p1', at: 1000},
  }));
}

test('lists stored by an older version are taken over once, shard by shard, without a request; an old shard goes only when its lists are safely stored', async () => {
  const srv = fakeServer();
  legacy(srv);
  const g = await open(srv);
  const got = await store.loadFiles(g);
  assert.deepEqual([got.recs, got.legacy], [{}, true]);
  assert.deepEqual(srv.log.slice(0, 5), ['GET filesum:me', 'GET files:me:0', 'GET files:me:1', 'GET files:me:2', 'GET files:me:3'], 'looked for up to the first shard that exists');
  S.files = got.recs;
  assert.equal(filesNeedUpgrade(), true);
  srv.log.length = 0;
  assert.match(await upgradeFiles(g), /5 lists \(10 files\) moved to the lighter format/);
  // every list is there, packed, with summaries of today's rules
  assert.deepEqual(Object.keys(S.files).sort(), ['11', '12', '13', '14', '15']);
  for (const [id, paths] of [[11, ['docs/cheatsheet.pdf', 'hw/board.kicad_pcb', 'hw/gerber/top.gtl', 'lib/x/datasheet.pdf']], [12, ['web/index.js', 'web/package.json']], [13, []], [14, ['README.md', 'src/a.c']], [15, ['a\nb.txt', 'İ/Ü.STL']]])
    assert.deepEqual((await pathsOf({id})).sort(), paths, 'paths of ' + id);
  const r11 = S.files['11'];
  assert.deepEqual([r11.n, r11.etag, r11.pushed, r11.at, r11.subs, r11.fv, r11.p, r11.s.v, r11.s.kinds, r11.s.bk, incomplete(r11)],
    [4, '"e11"', 'p1', 1000, 1, 2, undefined, KINDS_VERSION, {pcb: 1, gerber: 1}, {datasheet: 1}, false], 'the record keeps its ETag and dates: nothing is downloaded again');
  assert.deepEqual([S.files['12'].redo, incomplete(S.files['12']), S.files['13'].miss, S.files['15'].s.kinds], [true, true, 409, {mesh: 1}], 'a version-1 list that may lack folders is marked to be fetched again');
  assert.deepEqual([S.files['14'].walk.todo.length, incomplete(S.files['14'])], [1, true], 'a walk in progress is still in progress');
  // the older layout is gone, and the summaries no longer list anything to take over
  assert.deepEqual([...srv.files.keys()].filter(k => k.startsWith('files:')), []);
  assert.deepEqual([stored(srv, 'filesum:me').old, Object.keys(stored(srv, 'filesum:me').recs).length, filesNeedUpgrade()], [undefined, 5, false]);
  // order: an old shard is deleted only after a summaries record holding its lists was written
  const firstDelete = srv.log.indexOf('DELETE files:me:3'), lastSumBefore = srv.log.lastIndexOf('PUT filesum:me', firstDelete);
  assert.ok(firstDelete > 0 && lastSumBefore > 0 && srv.log.slice(0, lastSumBefore).some(l => l === `PUT ${pathKey(11)}`), 'paths, then summaries, then the old shard goes: ' + srv.log.filter(l => !l.startsWith('GET')).join(' | '));
  // the next start reads the summaries and nothing of the older layout
  const g2 = await open(srv), again = await store.loadFiles(g2);
  assert.deepEqual([Object.keys(again.recs).length, again.legacy, srv.log], [5, false, ['GET filesum:me']]);
});

test('an upgrade that is interrupted loses nothing and continues at the next start; a list fetched again meanwhile is not overwritten by its old copy', async () => {
  const srv = fakeServer();
  legacy(srv);
  let g = await open(srv);
  S.files = (await store.loadFiles(g)).recs;
  // Cancel is clicked while the first old shard is being deleted
  srv.onCall = (method, key) => { if (method === 'DELETE' && key === 'files:me:3') S.stop = true; };
  await upgradeFiles(g);
  S.stop = false; srv.onCall = null;
  assert.deepEqual([...srv.files.keys()].filter(k => k.startsWith('files:')), ['files:me:40'], 'the shard not reached yet is untouched');
  assert.deepEqual(Object.keys(stored(srv, 'filesum:me').recs).sort(), ['11', '12', '13']);
  assert.ok(stored(srv, 'filesum:me').old.includes(40), 'and the summaries say it is still to be taken over');
  // next start: repo 14 is fetched again before the upgrade gets to run (say another tab held the lock) …
  g = await open(srv);
  const got = await store.loadFiles(g);
  assert.deepEqual([Object.keys(got.recs).sort(), got.legacy], [['11', '12', '13'], true]);
  S.files = got.recs;
  const fresh = give(repo(14, 'o/r14'), ['README.md', 'src/a.c', 'big/x.stl']);
  await store.saveFiles(g);
  // … then the upgrade continues with what is left
  assert.match(await upgradeFiles(g), /1 lists/);
  assert.deepEqual([S.files['14'].n, S.files['14'].walk, S.files['14'].at === fresh.at], [3, undefined, true], 'the newer list wins over the old copy');
  assert.deepEqual((await pathsOf({id: 14})).sort(), ['README.md', 'big/x.stl', 'src/a.c']);
  assert.deepEqual([Object.keys(S.files).sort(), [...srv.files.keys()].filter(k => k.startsWith('files:')), stored(srv, 'filesum:me').old], [['11', '12', '13', '14', '15'], [], undefined]);

  // a shard whose lists can't be saved is kept, not deleted
  const srv2 = fakeServer();
  legacy(srv2);
  g = await open(srv2);
  S.files = (await store.loadFiles(g)).recs;
  srv2.fail = (method, key) => method === 'PUT' && key === 'filesum:me';
  await upgradeFiles(g);
  assert.deepEqual([...srv2.files.keys()].filter(k => k.startsWith('files:')).sort(), ['files:me:3', 'files:me:40'], 'nothing of the older layout is deleted while its lists are not safely stored');
  // an old shard that can't even be read is left alone, and the rest is still taken over
  const srv3 = fakeServer();
  legacy(srv3);
  g = await open(srv3);
  srv3.fail = (method, key) => method === 'GET' && key === 'files:me:3';
  S.files = (await store.loadFiles(g)).recs;
  await upgradeFiles(g);
  assert.deepEqual([[...srv3.files.keys()].filter(k => k.startsWith('files:')), Object.keys(S.files).sort(), stored(srv3, 'filesum:me').old], [['files:me:3'], ['14', '15'], [3]]);
  // 🗑 Clear file lists also drops what was not taken over yet (or the next start would bring it back)
  srv3.fail = () => false;
  await clearFiles(g);
  assert.deepEqual([[...srv3.files.keys()].filter(k => /^(files|paths):/.test(k)), stored(srv3, 'filesum:me')?.old], [[], undefined]);
});

test('switching the cache off or on, and adopting a visit, takes the file paths along', async () => {
  // Keep cache ON → OFF (local server): this tab goes on from memory, file names included
  let srv = fakeServer(), g = await open(srv);
  S.repos = [a];
  give(a, ['hw/board.kicad_pcb', 'README.md']);
  await store.saveFiles(g);
  srv.log.length = 0;
  await store.setPersist(false);
  assert.ok(!srv.log.some(l => l.startsWith('PUT') || l.startsWith('DELETE')), 'the files in data/ are untouched');
  srv.log.length = 0;
  assert.equal(await loadPaths(), true);
  assert.deepEqual([pathHit(a, 'kicad'), srv.log], ['hw/board.kicad_pcb', []], 'searched from this tab\'s memory, without the server');
  // OFF → ON with nothing stored yet: what this tab has is saved, paths too
  srv = fakeServer();
  await store.setPersist(true);
  await store.saveAll(g);
  assert.deepEqual([unpackPaths(stored(srv, pathKey(1))['1']), stored(srv, 'filesum:me').recs['1'].n], [['hw/board.kicad_pcb', 'README.md'], 2]);

  // a visit keeps its file lists in memory only …
  srv = fakeServer(); g = await open(srv);
  store.setVisit('them');
  S.user = 'them'; S.repos = [b];
  give(b, ['src/main.rs']);
  await store.saveFiles(g);
  assert.equal(srv.log.filter(l => !l.startsWith('GET')).length, 0, 'nothing of a visit is written');
  assert.deepEqual(await pathsOf(b), ['src/main.rs']);
  // … and "★ Make this my profile" stores them with the rest (what main.js adopt() does)
  await store.carryPaths();
  store.setVisit('');
  store.adoptProfile('them');
  await store.saveAll(g);
  assert.deepEqual([unpackPaths(stored(srv, `paths:them:${store.pathShardOf(2)}`)['2']), Object.keys(stored(srv, 'filesum:them').recs)], [['src/main.rs'], ['2']]);
  S.user = 'me';
});
