// Tests for file lists (files.js, filekinds.js): fetching trees with ETags, what file names say about a repo, searching
// them (Files checkbox, has: / ext: / path: / files:), the file-based sort orders, and clearing one category at a time.
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)},
  configurable: true,
});

const {S, nextGen} = await import('../public/js/state.js');
const {describe, hasKind, extOf, summaryOf, KINDS_VERSION} = await import('../public/js/filekinds.js');
const {fetchFiles, needsFiles, toRecord, clearFiles} = await import('../public/js/files.js');
const {parseQuery, match, card} = await import('../public/js/list.js');
const {sortRepos} = await import('../public/js/sort.js');
const {clearPart, indexedParts} = await import('../public/js/history.js');

const el = {value: '', checked: false, textContent: '', innerHTML: '', hidden: false, title: '', classList: {add() {}, remove() {}}};
const withDoc = async fn => {
  globalThis.document = {querySelector: () => el, querySelectorAll: () => []};
  try { return await fn(); } finally { delete globalThis.document; }
};
const repo = (id, full, extra = {}) => ({id, full, owner: full.split('/')[0], name: full.split('/')[1], url: 'https://github.com/' + full,
  topics: [], pushed: 'p1', branch: 'main', stars: 1, ...extra});

test('filekinds: hardware, 3D, firmware and other kinds are told from file names', () => {
  const s = describe(['hw/main.kicad_pcb', 'hw/main.kicad_sch', 'hw/gerbers/top.gtl', 'hw/bom.csv', 'case/lid.step', 'case/lid.stl',
    'docs/BQ27220_datasheet.pdf', 'docs/schematic.pdf', 'fw/platformio.ini', 'fw/src/main.cpp', 'boards/t-deck/pins.h',
    'node_modules/x/index.js', 'Makefile', '.gitignore', 'models/net.onnx', 'nb/a.ipynb', 'laser/panel.dxf']);
  assert.equal(s.v, KINDS_VERSION);
  assert.equal(s.n, 16, 'vendored node_modules are not counted');
  assert.deepEqual(s.kinds, {pcb: 2, gerber: 2, cad: 1, mesh: 1, datasheet: 1, schematic: 1, ml: 1, notebook: 1, mech: 1});
  assert.deepEqual(s.build, ['PlatformIO']);
  assert.equal(s.boards, 1);
  for (const v of ['hardware', 'pcb', '3d', 'cad', 'mesh', 'firmware', 'platformio', 'ml', 'notebook']) assert.equal(hasKind(s, v), true, v);
  for (const v of ['game', 'esp-idf', 'docker']) assert.equal(hasKind(s, v), false, v);
  assert.equal(hasKind(s, 'nonsense'), null, 'an unknown kind is ignored, not false');
  assert.deepEqual([extOf('a/B.STL'), extOf('Makefile'), extOf('.gitignore'), extOf('a.tar.gz')], ['stl', '', '', 'gz']);
  // a stored summary of an older rules version is computed again from the paths
  const rec = {p: ['x.kicad_pcb'], s: {v: KINDS_VERSION - 1, kinds: {}}};
  assert.equal(summaryOf(rec).kinds.pcb, 1);
});

test('file lists: one request per repo, ETag makes an unchanged tree free, empty repos are remembered, only pushed repos are looked at again', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const trees = {
    'o/board': {sha: 't1', truncated: false, tree: [{path: 'hw', type: 'tree'}, {path: 'hw/a.kicad_pcb', type: 'blob'}, {path: 'case.stl', type: 'blob'}, {path: 'lib/sub', type: 'commit'}]},
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url), m = u.match(/repos\/([^/]+\/[^/]+)\/git\/trees\/([^?]+)\?recursive=1/);
    calls.push({u, etag: init?.headers?.['If-None-Match']});
    const h = new Headers({'content-type': 'application/json', etag: '"e1"'});
    if (!m) return {ok: false, status: 404, headers: h, json: async () => ({})};
    if (m[1] === 'o/empty') return {ok: false, status: 409, headers: h, json: async () => ({message: 'Git Repository is empty.'})};
    if (init?.headers?.['If-None-Match'] === '"e1"') return {ok: false, status: 304, headers: h, json: async () => ({})};
    return {ok: true, status: 200, headers: h, json: async () => trees[m[1]]};
  };
  try {
    await withDoc(async () => {
      S.token = 'tok'; S.files = {};
      S.repos = [repo(1, 'o/board'), repo(2, 'o/empty')];
      const g = nextGen();
      const res = await fetchFiles(g, S.repos);
      assert.equal(calls.length, 2);
      assert.match(calls[0].u, /\/repos\/o\/board\/git\/trees\/main\?recursive=1$/, 'the default branch, recursively');
      assert.deepEqual(S.files['1'].p, ['hw/a.kicad_pcb', 'case.stl'], 'files only: folders and submodules are not files');
      assert.deepEqual([S.files['1'].n, S.files['1'].subs, S.files['1'].etag], [2, 1, '"e1"']);
      assert.deepEqual(S.files['1'].s.kinds, {pcb: 1, mesh: 1});
      assert.equal(S.files['2'].miss, 409, 'an empty repository is remembered, not retried every time');
      assert.equal(res.got, 1);
      assert.deepEqual(S.repos.map(r => needsFiles(r)), [false, false]);
      // pushed since: asked again, with the ETag; GitHub answers 304 and the list is kept
      S.repos[0].pushed = 'p2';
      assert.deepEqual(S.repos.map(r => needsFiles(r)), [true, false]);
      calls.length = 0;
      const again = await fetchFiles(g, S.repos.filter(r => needsFiles(r)));
      assert.deepEqual(calls.map(c => c.etag), ['"e1"']);
      assert.deepEqual([again.same, S.files['1'].pushed, S.files['1'].p.length], [1, 'p2', 2]);
      assert.equal(await clearFiles(g), 2);
      assert.deepEqual(S.files, {});
    });
  } finally { globalThis.fetch = realFetch; S.token = ''; S.files = {}; S.repos = []; }
});

test('search: file names with the Files checkbox, has: / ext: / path: / files: / build:, and the cards say what the files are', () => {
  const a = repo(10, 'o/pcb'), b = repo(11, 'o/web'), c = repo(12, 'o/unlisted');
  S.repos = [a, b, c];
  S.files = {
    10: toRecord(a, {tree: [{path: 'hardware/main.kicad_pcb', type: 'blob'}, {path: 'mech/enclosure.step', type: 'blob'}, {path: 'firmware/platformio.ini', type: 'blob'}]}, null),
    11: toRecord(b, {tree: [{path: 'src/index.ts', type: 'blob'}, {path: 'package.json', type: 'blob'}]}, null),
  };
  const ok = (r, q, inFiles = false) => !!match(r, parseQuery(q), false, false, inFiles);
  assert.equal(ok(a, 'enclosure'), false, 'file names are searched only when asked');
  const m = match(a, parseQuery('enclosure'), false, false, true);
  assert.deepEqual(m.snips, [{kind: 'File', id: 'mech/enclosure.step', text: 'mech/enclosure.step'}]);
  assert.match(card(a, {snips: m.snips}), /blob\/main\/mech\/enclosure\.step/, 'the snippet links to the file');
  assert.deepEqual([ok(a, 'has:pcb'), ok(b, 'has:pcb'), ok(c, 'has:pcb')], [true, false, true], 'a repo without a file list: has: is ignored');
  assert.deepEqual([ok(a, 'has:3d'), ok(a, 'has:hardware'), ok(a, 'has:firmware'), ok(a, 'build:platformio'), ok(b, 'build:node')], [true, true, true, true, true]);
  assert.deepEqual([ok(a, 'ext:step'), ok(a, 'ext:.STEP'), ok(b, 'ext:step')], [true, true, false]);
  assert.deepEqual([ok(a, 'path:hardware/'), ok(b, 'path:hardware/'), ok(a, '-has:pcb')], [true, false, false]);
  assert.deepEqual([ok(a, 'files:>2'), ok(b, 'files:>2'), ok(a, 'files:1..3')], [true, false, true]);
  const html = card(a);
  assert.match(html, /📁 3 files/);
  assert.match(html, /data-kind="pcb"/);
  assert.match(html, /PlatformIO/);
  assert.equal(card(c).includes('📁'), false, 'nothing for a repo without a file list');
  // sort orders: repos with hardware first, the rest after (by name)
  assert.deepEqual(sortRepos([b, c, a].map(r => ({r})), 'hardware').map(x => x.r.full), ['o/pcb', 'o/unlisted', 'o/web']);
  assert.deepEqual(sortRepos([b, a].map(r => ({r})), 'files').map(x => x.r.full), ['o/pcb', 'o/web']);
  S.repos = []; S.files = {};
});

test('clearing commits keeps the release notes and the other way round; a record left with neither is deleted', async () => {
  await withDoc(async () => {
    const g = nextGen();
    const both = () => ({c: [['a', 1, 'msg']], head: 'h', tail: 't', done: true, rel: [['v1', '', 1, 'notes', 0]], relN: 1, relTop: 'v1|x|y', relAt: 5, at: 9, pushed: 'p'});
    S.history = {1: both(), 2: {c: [['b', 1, 'only commits']], head: 'h', done: true, rel: [], relN: -1, relAt: 0, at: 9, pushed: 'p'}};
    assert.equal(await clearPart(g, 'commits'), 2);
    assert.equal(S.history[2], undefined, 'nothing left: the record goes');
    assert.deepEqual([S.history[1].c, S.history[1].rel.length, S.history[1].rAt, S.history[1].rPushed], [[], 1, 9, 'p'], 'releases and their check stamp kept');
    assert.deepEqual(indexedParts(), {commits: false, releases: true});
    S.history = {1: both()};
    assert.equal(await clearPart(g, 'releases'), 1);
    assert.deepEqual([S.history[1].rel, S.history[1].relN, S.history[1].c.length, S.history[1].cAt], [[], -1, 1, 9]);
    assert.deepEqual(indexedParts(), {commits: true, releases: false});
    S.history = {};
  });
});

test('file lists are always complete: nothing is left out, a truncated tree is walked folder by folder, old incomplete lists are fetched again', async () => {
  const {walkTree, incomplete, FILES_VERSION} = await import('../public/js/files.js');
  // nothing filtered: vendored folders are part of the list (the kinds still ignore them)
  const rec = toRecord(repo(1, 'o/a'), {tree: [{path: 'node_modules/x/i.js', type: 'blob'}, {path: 'a.kicad_pcb', type: 'blob'}]}, null);
  assert.deepEqual([rec.p, rec.n, rec.fv, rec.s.n], [['node_modules/x/i.js', 'a.kicad_pcb'], 2, FILES_VERSION, 1]);
  // what an older version stored is recognised as incomplete
  assert.equal(incomplete({p: ['a'], cut: true}), true, 'cut by the old cap');
  assert.equal(incomplete({p: ['a'], trunc: true}), true, 'truncated by GitHub, never walked');
  assert.equal(incomplete({p: ['a'], trunc: true, walked: true, fv: FILES_VERSION}), false);
  assert.equal(incomplete({p: ['web/package.json']}), true, 'version 1 may have left node_modules out of this one');
  assert.equal(incomplete({p: ['main.c']}), false, 'nothing could have been left out of this one');
  assert.equal(incomplete({p: ['web/package.json'], fv: FILES_VERSION}), false);

  // a huge repo: the root is walked without recursion, each folder recursively, and a folder still too big one level down
  const realFetch = globalThis.fetch, asked = [];
  const trees = {
    'main?recursive=1': {sha: 'root', truncated: true, tree: [{path: 'README.md', type: 'blob'}]},
    'root': {sha: 'root', tree: [{path: 'README.md', type: 'blob'}, {path: 'src', type: 'tree', sha: 's1'}, {path: 'big', type: 'tree', sha: 'b1'}, {path: 'lib', type: 'commit'}]},
    's1?recursive=1': {sha: 's1', tree: [{path: 'main.c', type: 'blob'}, {path: 'drv', type: 'tree', sha: 'd'}, {path: 'drv/spi.c', type: 'blob'}]},
    'b1?recursive=1': {sha: 'b1', truncated: true, tree: []},
    'b1': {sha: 'b1', tree: [{path: 'x.stl', type: 'blob'}, {path: 'deep', type: 'tree', sha: 'dp'}]},
    'dp?recursive=1': {sha: 'dp', tree: [{path: 'y.step', type: 'blob'}]},
  };
  globalThis.fetch = async url => {
    const key = String(url).split('/git/trees/')[1];
    asked.push(key);
    const body = trees[key];
    return body ? {ok: true, status: 200, headers: new Headers({etag: '"w"'}), json: async () => body} : {ok: false, status: 404, headers: new Headers(), json: async () => ({})};
  };
  try {
    await withDoc(async () => {
      S.token = 'tok'; S.files = {};
      S.repos = [repo(7, 'o/huge')];
      await fetchFiles(nextGen(), S.repos);
      const got = S.files['7'];
      assert.deepEqual(got.p.sort(), ['README.md', 'big/deep/y.step', 'big/x.stl', 'src/drv/spi.c', 'src/main.c']);
      assert.deepEqual([got.trunc, got.walked, got.n], [true, true, 5]);
      assert.deepEqual(asked, ['main?recursive=1', 'root', 's1?recursive=1', 'b1?recursive=1', 'b1', 'dp?recursive=1']);
      assert.equal(incomplete(got), false);
      assert.deepEqual(got.s.kinds, {cad: 1, mesh: 1});
      const rec = {p: [], n: 0, subs: 0, trunc: true, walked: false, fv: FILES_VERSION, branch: 'main', etag: null, pushed: 'p1', at: 0, walk: {ref: 'root', requests: 0}};
      await walkTree(S.repos[0], rec);
      assert.equal(rec.walk.requests, 5, 'root, src, big (cut again), big one level down, deep');
      assert.deepEqual(rec.p.sort(), ['README.md', 'big/deep/y.step', 'big/x.stl', 'src/drv/spi.c', 'src/main.c']);
    });
  } finally { globalThis.fetch = realFetch; S.token = ''; S.files = {}; S.repos = []; }
});

test('a walk the budget (or a reload) interrupts keeps its progress and continues where it stopped, not from the start', async () => {
  const {incomplete, needsFiles, FILES_VERSION} = await import('../public/js/files.js');
  const realFetch = globalThis.fetch;
  const trees = {
    'main?recursive=1': {sha: 'root', truncated: true, tree: [{path: 'README.md', type: 'blob'}]},
    'root': {sha: 'root', tree: [{path: 'README.md', type: 'blob'}, {path: 'src', type: 'tree', sha: 's1'}, {path: 'big', type: 'tree', sha: 'b1'}]},
    's1?recursive=1': {sha: 's1', tree: [{path: 'main.c', type: 'blob'}]},
    'b1?recursive=1': {sha: 'b1', truncated: true, tree: []},
    'b1': {sha: 'b1', tree: [{path: 'x.stl', type: 'blob'}]},
  };
  let b1Fails = true, asked = [];
  globalThis.fetch = async url => {
    const key = String(url).split('/git/trees/')[1];
    asked.push(key);
    if (key === 'b1' && b1Fails) return {ok: false, status: 404, headers: new Headers(), json: async () => ({})};
    const body = trees[key];
    return body ? {ok: true, status: 200, headers: new Headers({etag: '"w"'}), json: async () => body} : {ok: false, status: 404, headers: new Headers(), json: async () => ({})};
  };
  try {
    await withDoc(async () => {
      S.token = 'tok'; S.files = {};
      const huge = repo(7, 'o/huge');
      S.repos = [huge];
      // 1st run: the walk dies on a bad answer for big/ halfway through — what was collected is kept, not thrown away
      const first = await fetchFiles(nextGen(), S.repos);
      assert.equal(first.failed, 1, 'the walk fails, the repo is tried again');
      assert.deepEqual([first.got, first.same], [0, 0]);
      const half = S.files['7'];
      assert.deepEqual(half.p.sort(), ['README.md', 'src/main.c'], 'the files found before the failure are kept');
      assert.deepEqual(half.walk.todo, [{sha: 'b1', prefix: 'big/', recursive: false}], 'the folder that failed is still to do');
      assert.deepEqual([half.trunc, half.walked, half.walk.requests], [true, false, 4], 'the walk is not finished');
      assert.equal(incomplete(half), true, 'a half-done walk is an incomplete list');
      assert.equal(needsFiles(huge), true);
      // 2nd run: it continues where it stopped — no fresh start (no recursive answer, no root, no src again)
      b1Fails = false;
      asked = [];
      const second = await fetchFiles(nextGen(), S.repos);
      assert.deepEqual(asked, ['b1'], 'only the folder that was still queued is asked for: no fresh start (no recursive answer, no root, no src again)');
      assert.deepEqual([second.got, second.same, second.failed], [1, 0, 0], 'the walk completes');
      const done = S.files['7'];
      assert.equal(done.walk, undefined, 'the walk is over');
      assert.deepEqual(done.p.sort(), ['README.md', 'big/x.stl', 'src/main.c']);
      assert.deepEqual([done.trunc, done.walked, done.n, done.fv], [true, true, 3, FILES_VERSION]);
      assert.equal(incomplete(done), false);
      assert.equal(needsFiles(huge), false);
    });
  } finally { globalThis.fetch = realFetch; S.token = ''; S.files = {}; S.repos = []; }
});
