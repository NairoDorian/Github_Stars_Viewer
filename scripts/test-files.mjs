// Tests for file lists (files.js, filekinds.js): fetching trees with ETags, what file names say about a repo, searching
// them (Files checkbox, has: / ext: / path: / files:), the file-based sort orders, and clearing one category at a time.
// How the lists are stored (summaries apart from the packed paths, the upgrade of older layouts) is in test-filestore.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)},
  configurable: true,
});

const {S, nextGen} = await import('../public/js/state.js');
const {describe, hasKind, hasExt, extOf, summaryOf, staleSummary, KINDS, KINDS_VERSION} = await import('../public/js/filekinds.js');
const {fetchFiles, needsFiles, toRecord, setFileList, clearFiles, pathsOf, loadPaths, releasePaths, pathsReady, upgradeFiles, filesNeedUpgrade} = await import('../public/js/files.js');
const {get, saveFiles} = await import('../public/js/store.js');
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
/** Gives a repo a file list, as a pull would. */
const give = (r, paths) => { const {rec, packed} = toRecord(r, {tree: paths.map(path => ({path, type: 'blob'}))}, null); setFileList(String(r.id), rec, packed); return rec; };
S.user = 'me';

test('filekinds: hardware, 3D, firmware and other kinds are told from file names', () => {
  const s = describe(['hw/main.kicad_pcb', 'hw/main.kicad_sch', 'hw/gerbers/top.gtl', 'hw/bom.csv', 'case/lid.step', 'case/lid.stl',
    'docs/BQ27220_datasheet.pdf', 'docs/schematic.pdf', 'fw/platformio.ini', 'fw/src/main.cpp', 'boards/t-deck/pins.h',
    'node_modules/x/index.js', 'Makefile', '.gitignore', 'models/net.onnx', 'nb/a.ipynb', 'laser/panel.dxf']);
  assert.equal(s.v, KINDS_VERSION);
  assert.deepEqual([s.n, s.bn], [16, 1], 'the dependency in node_modules is not one of the repo\'s own files');
  assert.deepEqual(s.kinds, {pcb: 2, gerber: 2, cad: 1, mesh: 1, datasheet: 1, schematic: 1, ml: 1, notebook: 1, mech: 1});
  assert.deepEqual(Object.keys(s.kinds), KINDS.map(k => k[0]).filter(k => s.kinds[k]), 'listed in the order of the kinds');
  assert.deepEqual(s.ex.pcb, ['hw/main.kicad_pcb', 'hw/main.kicad_sch']);
  assert.deepEqual(s.build, ['PlatformIO']);
  assert.equal(s.boards, 1);
  for (const v of ['hardware', 'pcb', '3d', 'cad', 'mesh', 'firmware', 'platformio', 'ml', 'notebook', 'kicad', 'stl', 'step', 'eda']) assert.equal(hasKind(s, v), true, v);
  for (const v of ['game', 'esp-idf', 'docker', 'uf2', 'prebuilt', 'lib', 'bundled']) assert.equal(hasKind(s, v), false, v);
  assert.equal(hasKind(s, 'nonsense'), null, 'an unknown kind is ignored, not false');
  assert.deepEqual([extOf('a/B.STL'), extOf('Makefile'), extOf('.gitignore'), extOf('a.tar.gz')], ['stl', '', '', 'gz']);
  // every extension is kept (ext: finds a file anywhere, bundled folders too), the most common of its own files are listed
  assert.deepEqual([hasExt(s, 'js'), hasExt(s, 'kicad_pcb'), hasExt(s, 'rs'), hasExt(s, 'constructor')], [true, true, false, false]);
  assert.ok(s.ext.every(([e]) => e !== 'js') && s.ext.some(([e]) => e === 'pdf'), 'the "most common" list is about its own files');
  // a summary written by older rules stays as it is until it is computed again; what it can't know is "unknown"
  const old = {s: {v: KINDS_VERSION - 1, kinds: {pcb: 1}, build: [], ext: [['kicad_pcb', 1]]}};
  assert.deepEqual([summaryOf(old).kinds.pcb, staleSummary(old), staleSummary({s}), staleSummary({miss: 409, s: {v: 0}})], [1, true, false, false]);
  assert.deepEqual([hasExt(old.s, 'kicad_pcb'), hasExt(old.s, 'stl'), hasKind(old.s, 'kicad'), hasKind(old.s, 'stl')], [true, null, true, null]);
});

test('filekinds: a repo\'s own files are told from the code it bundles (libraries, SDKs, copied components)', () => {
  const s = describe(['main/main.c', 'main/idf_component.yml', 'sdkconfig.defaults', 'hardware/board.kicad_pcb',
    'components/lvgl/idf_component.yml', 'components/lvgl/docs/schematic.pdf',          // a component copied into the project
    'components/mine/driver.c', 'components/mine/board_sch.pdf',                        // the project's own component
    'managed_components/espressif__esp_lcd/datasheet.pdf', 'lib/TFT_eSPI/docs/pinout.png',
    'Drivers/STM32H7xx_HAL_Driver/reference_manual.pdf', 'drivers/own/pinout.png', 'third_party/x/model.stl', 'modules/hal/nordic/board.step']);
  assert.deepEqual(s.kinds, {pcb: 1, schematic: 2}, 'only what the repo itself holds: its board, its own schematic and pinout');
  assert.deepEqual(s.ex.schematic, ['components/mine/board_sch.pdf', 'drivers/own/pinout.png']);
  assert.deepEqual(s.bk, {schematic: 2, datasheet: 2, cad: 1, mesh: 1}, 'what the bundled folders hold is counted beside it');
  assert.deepEqual([s.n, s.bn], [7, 7]);
  assert.deepEqual(s.build, ['ESP-IDF']);
  assert.deepEqual([hasKind(s, 'schematic'), hasKind(s, 'datasheet'), hasKind(s, '3d'), hasKind(s, 'bundled'), hasKind(s, 'stl')], [true, false, false, true, true],
    'has:<kind> is about its own files; has:stl (a file type) finds it wherever it is');
  // inside the repo's own docs / hardware folder those folder names mean something else; under a bundled folder, docs are still bundled
  const d = describe(['docs/reference/vendor/schematic/board-schematic.pdf', 'hardware/lib/fp.kicad_mod', 'lib/TFT_eSPI/docs/pinout.png', '.pio/libdeps/x/extras/sch.pdf', 'docs/node_modules/x/pinout.png']);
  assert.deepEqual([d.kinds, d.bk], [{edalib: 1, schematic: 1}, {schematic: 2}]);
  // a repo that IS a collection of components has no "main" beside them: they are its own files
  assert.deepEqual(describe(['components/bme280/idf_component.yml', 'components/bme280/docs/datasheet.pdf']).kinds, {datasheet: 1});
  // a build system inside a bundled library still tells what the repo is built with (as before)
  assert.deepEqual(describe(['libraries/Foo/library.properties', 'libraries/Foo/examples/blink/blink.ino']).build, ['Arduino']);
  assert.deepEqual(describe(['node_modules/x/platformio.ini', 'vendor/bundle/y/Cargo.toml']).build, [], 'never from a dependency folder');
});

test('filekinds: schematic PDFs by name, EDA libraries apart from boards, prebuilt firmware', () => {
  const kinds = paths => describe(paths).kinds;
  // "sch" counts as a word only; "board" and "layout" alone are no sign of a schematic
  for (const p of ['docs/UnityAssertionsCheatSheetSuitableforPrintingandPossiblyFraming.pdf', 'Certification/EU Declaration of Conformity for Espressif Modules and Development Boards.pdf',
    'doc/keyboard-layout.pdf', 'doc/CircuitPython_cheatsheet.pdf', 'doc/user_manual.pdf']) assert.deepEqual(kinds([p]), {}, p);
  for (const p of ['doc/esp32_devkit_SCH.pdf', 'doc/SCH-v2.pdf', 'sch.pdf', 'doc/board_schematic.pdf', 'doc/pcb_layout.pdf', 'doc/Hardware Design.pdf', 'doc/circuit.pdf',
    'doc/board-outline.pdf', 'hw/anything.pdf', 'schematics/rev_b.pdf', 'img/pinout.png', 'img/pin_map.svg']) assert.deepEqual(kinds([p]), {schematic: 1}, p);
  assert.deepEqual(kinds(['datasheets/x.pdf', 'doc/app_note_12.pdf']), {datasheet: 2});
  // libraries of symbols and footprints are not boards
  const lib = describe(['sym/mcu.kicad_sym', 'fp.pretty/R_0402.kicad_mod', 'parts.lbr', 'alt.PcbLib']);
  assert.deepEqual(lib.kinds, {edalib: 4});
  assert.deepEqual([hasKind(lib, 'pcb'), hasKind(lib, 'hardware'), hasKind(lib, 'kicad'), hasKind(lib, 'eda'), hasKind(lib, 'lib'), hasKind(lib, 'edalib')], [false, false, false, true, true, true]);
  assert.deepEqual(kinds(['a.kicad_pcb', 'a.kicad_sym', 'b.SchDoc', 'easyeda/board.json', 'x/librepcb/y.lp', 'gerber/readme.txt', 'out/bom.xlsx', 'out/top-pos.csv']), {pcb: 4, edalib: 1, gerber: 3});
  // ready-to-flash binaries: not from test or build folders; a bare .bin only in a firmware repo or when its path says so
  assert.deepEqual(kinds(['firmware/app.uf2', 'release/v1.bin', 'build/app.elf', 'test/data.hex', 'weights/model.bin', 'bin/tool.bin']), {fwbin: 3});
  const fw = describe(['platformio.ini', 'weights/model.bin', 'out/app.hex', 'build/x.bin']);
  assert.deepEqual([fw.kinds, hasKind(fw, 'prebuilt'), hasKind(fw, 'flashable'), hasKind(fw, 'uf2')], [{fwbin: 2}, true, true, false]);
  assert.deepEqual(fw.ex.fwbin, ['out/app.hex', 'weights/model.bin']);
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
    if (m[1] === 'o/blocked') return {ok: false, status: 403, headers: h, json: async () => ({message: 'Repository access blocked'})};
    if (init?.headers?.['If-None-Match'] === '"e1"') return {ok: false, status: 304, headers: h, json: async () => ({})};
    return {ok: true, status: 200, headers: h, json: async () => trees[m[1]]};
  };
  try {
    await withDoc(async () => {
      S.token = 'tok'; S.files = {};
      S.repos = [repo(1, 'o/board'), repo(2, 'o/empty'), repo(3, 'o/blocked')];
      const g = nextGen();
      const res = await fetchFiles(g, S.repos);
      assert.equal(calls.length, 3);
      assert.match(calls[0].u, /\/repos\/o\/board\/git\/trees\/main\?recursive=1$/, 'the default branch, recursively');
      assert.deepEqual(await pathsOf(S.repos[0]), ['hw/a.kicad_pcb', 'case.stl'], 'files only: folders and submodules are not files');
      assert.deepEqual([S.files['1'].n, S.files['1'].subs, S.files['1'].etag, S.files['1'].p], [2, 1, '"e1"', undefined], 'the record holds no paths: they are stored apart');
      assert.deepEqual(S.files['1'].s.kinds, {pcb: 1, mesh: 1});
      assert.equal(S.files['2'].miss, 409, 'an empty repository is remembered, not retried every time');
      assert.equal(S.files['3'].miss, 403, 'so is a repository GitHub blocks');
      assert.deepEqual([res.got, res.failed], [1, 0]);
      assert.deepEqual(S.repos.map(r => needsFiles(r)), [false, false, false]);
      // what reached the store: one record of summaries, and the paths packed in the shard of their repo
      const sum = await get('filesum:me');
      assert.deepEqual([Object.keys(sum.recs).sort(), sum.recs['1'].n, sum.recs['1'].p], [['1', '2', '3'], 2, undefined]);
      // pushed since: asked again, with the ETag; GitHub answers 304 and the list is kept
      S.repos[0].pushed = 'p2';
      assert.deepEqual(S.repos.map(r => needsFiles(r)), [true, false, false]);
      calls.length = 0;
      const again = await fetchFiles(g, S.repos.filter(r => needsFiles(r)));
      assert.deepEqual(calls.map(c => c.etag), ['"e1"']);
      assert.deepEqual([again.same, S.files['1'].pushed, (await pathsOf(S.repos[0])).length], [1, 'p2', 2]);
      assert.equal(await clearFiles(g), 3);
      assert.deepEqual([S.files, await pathsOf(S.repos[0]), (await get('filesum:me')).recs], [{}, [], {}], 'cleared: the records, the paths and what was stored');
    });
  } finally { globalThis.fetch = realFetch; S.token = ''; S.files = {}; S.repos = []; }
});

test('search: file names with the Files checkbox, has: / ext: / path: / files: / build:, and the cards say what the files are', async () => {
  await withDoc(async () => {
    const g = nextGen();
    const a = repo(10, 'o/pcb'), b = repo(11, 'o/web'), c = repo(12, 'o/unlisted');
    S.repos = [a, b, c];
    S.files = {};
    give(a, ['hardware/main.kicad_pcb', 'mech/enclosure.step', 'firmware/platformio.ini', 'lib/x/docs/datasheet.pdf']);
    give(b, ['src/index.ts', 'package.json']);
    const ok = (r, q, inFiles = false) => !!match(r, parseQuery(q), false, false, inFiles);
    assert.equal(ok(a, 'enclosure'), false, 'file names are searched only when asked');
    // The file names are not in memory until a search needs them: until then they match nothing, and path: is ignored.
    assert.equal(pathsReady(), false);
    assert.deepEqual([ok(a, 'enclosure', true), ok(a, 'path:hardware/'), ok(b, 'path:hardware/')], [false, true, true]);
    assert.equal(await loadPaths(), true);
    assert.equal(pathsReady(), true);
    const m = match(a, parseQuery('enclosure'), false, false, true);
    assert.deepEqual(m.snips, [{kind: 'File', id: 'mech/enclosure.step', text: 'mech/enclosure.step'}]);
    assert.match(card(a, {snips: m.snips}), /blob\/main\/mech\/enclosure\.step/, 'the snippet links to the file');
    assert.deepEqual([ok(a, 'MAIN.kicad', true), ok(a, 'mech/encl', true), ok(a, 'hardware/', true), ok(b, 'hardware/', true), ok(a, '-platformio.ini', true)], [true, true, true, false, false]);
    assert.deepEqual([ok(a, 'has:pcb'), ok(b, 'has:pcb'), ok(c, 'has:pcb')], [true, false, true], 'a repo without a file list: has: is ignored');
    assert.deepEqual([ok(a, 'has:3d'), ok(a, 'has:hardware'), ok(a, 'has:firmware'), ok(a, 'build:platformio'), ok(b, 'build:node'), ok(a, 'has:kicad'), ok(b, 'has:kicad')], [true, true, true, true, true, true, false]);
    assert.deepEqual([ok(a, 'has:datasheet'), ok(a, 'has:bundled'), ok(a, 'ext:pdf')], [false, true, true], 'a datasheet inside a bundled library is not the repo\'s own, but the file is there');
    assert.deepEqual([ok(a, 'ext:step'), ok(a, 'ext:.STEP'), ok(b, 'ext:step'), ok(c, 'ext:step')], [true, true, false, true]);
    assert.deepEqual([ok(a, 'path:hardware/'), ok(b, 'path:hardware/'), ok(c, 'path:hardware/'), ok(a, '-has:pcb'), ok(a, '-path:mech')], [true, false, true, false, false]);
    assert.deepEqual([ok(a, 'files:>2'), ok(b, 'files:>2'), ok(a, 'files:1..4')], [true, false, true]);
    const html = card(a);
    assert.match(html, /📁 4 files/);
    assert.match(html, /data-kind="pcb"/);
    assert.match(html, /📦 \+1 bundled/, 'what the bundled folders hold is said apart');
    assert.match(html, /PlatformIO/);
    assert.equal(card(c).includes('📁'), false, 'nothing for a repo without a file list');
    // a list pulled while the names are in memory is searchable at once; letting them go stops the name search only
    give(c, ['notes/enclosure-ideas.md']);
    assert.equal(ok(c, 'enclosure', true), true);
    releasePaths();
    assert.deepEqual([pathsReady(), ok(a, 'enclosure', true), ok(a, 'has:pcb'), ok(a, 'ext:step')], [false, false, true, true]);
    // sort orders: repos with hardware first, the rest after (by name)
    assert.deepEqual(sortRepos([b, c, a].map(r => ({r})), 'hardware').map(x => x.r.full), ['o/pcb', 'o/unlisted', 'o/web']);
    assert.deepEqual(sortRepos([b, a].map(r => ({r})), 'files').map(x => x.r.full), ['o/pcb', 'o/web']);
    await clearFiles(g);
    S.repos = [];
  });
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
  const {walkTree, incomplete, legacyIncomplete, FILES_VERSION} = await import('../public/js/files.js');
  const {unpackPaths} = await import('../public/js/paths.js');
  // nothing filtered: dependency folders are part of the list (the kinds still ignore them)
  const {rec, packed} = toRecord(repo(1, 'o/a'), {tree: [{path: 'node_modules/x/i.js', type: 'blob'}, {path: 'a.kicad_pcb', type: 'blob'}]}, null);
  assert.deepEqual([unpackPaths(packed), rec.n, rec.fv, rec.s.n], [['node_modules/x/i.js', 'a.kicad_pcb'], 2, FILES_VERSION, 1]);
  // what an older version stored is recognised as incomplete
  assert.equal(incomplete({cut: true}), true, 'cut by the old cap');
  assert.equal(incomplete({trunc: true}), true, 'truncated by GitHub, never walked');
  assert.equal(incomplete({trunc: true, walked: true, fv: FILES_VERSION}), false);
  assert.equal(incomplete({redo: true}), true, 'marked when it was taken over from the older layout');
  assert.equal(incomplete({walk: {todo: []}}), true, 'a walk still in progress');
  assert.equal(incomplete({miss: 409, redo: true}), false, 'a repo without a tree has nothing to complete');
  assert.equal(legacyIncomplete({}, ['web/package.json']), true, 'version 1 may have left node_modules out of this one');
  assert.equal(legacyIncomplete({}, ['main.c']), false, 'nothing could have been left out of this one');
  assert.equal(legacyIncomplete({fv: FILES_VERSION}, ['web/package.json']), false);

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
      const g = nextGen();
      await fetchFiles(g, S.repos);
      const got = S.files['7'];
      assert.deepEqual((await pathsOf(S.repos[0])).sort(), ['README.md', 'big/deep/y.step', 'big/x.stl', 'src/drv/spi.c', 'src/main.c']);
      assert.deepEqual([got.trunc, got.walked, got.n, got.walk], [true, true, 5, undefined]);
      assert.deepEqual(asked, ['main?recursive=1', 'root', 's1?recursive=1', 'b1?recursive=1', 'b1', 'dp?recursive=1']);
      assert.equal(incomplete(got), false);
      assert.deepEqual(got.s.kinds, {cad: 1, mesh: 1});
      const walking = {n: 0, subs: 0, trunc: true, walked: false, fv: FILES_VERSION, branch: 'main', etag: null, pushed: 'p1', at: 0, walk: {ref: 'root', requests: 0}}, paths = [];
      await walkTree(S.repos[0], walking, paths);
      assert.equal(walking.walk.requests, 5, 'root, src, big (cut again), big one level down, deep');
      assert.deepEqual([paths.sort(), walking.n, walking.subs], [['README.md', 'big/deep/y.step', 'big/x.stl', 'src/drv/spi.c', 'src/main.c'], 5, 1]);
      await clearFiles(g);
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
      assert.deepEqual((await pathsOf(huge)).sort(), ['README.md', 'src/main.c'], 'the files found before the failure are kept, in the store');
      assert.deepEqual(half.walk.todo, [{sha: 'b1', prefix: 'big/', recursive: false}], 'the folder that failed is still to do');
      assert.deepEqual([half.trunc, half.walked, half.walk.requests, half.n], [true, false, 4, 2], 'the walk is not finished');
      assert.equal(incomplete(half), true, 'a half-done walk is an incomplete list');
      assert.equal(needsFiles(huge), true);
      assert.deepEqual((await get('filesum:me')).recs['7'].walk.todo.length, 1, 'the walk itself is stored: a reload continues it too');
      // 2nd run: it continues where it stopped — no fresh start (no recursive answer, no root, no src again)
      b1Fails = false;
      asked = [];
      const g = nextGen(), second = await fetchFiles(g, S.repos);
      assert.deepEqual(asked, ['b1'], 'only the folder that was still queued is asked for: no fresh start (no recursive answer, no root, no src again)');
      assert.deepEqual([second.got, second.same, second.failed], [1, 0, 0], 'the walk completes');
      const done = S.files['7'];
      assert.equal(done.walk, undefined, 'the walk is over');
      assert.deepEqual((await pathsOf(huge)).sort(), ['README.md', 'big/x.stl', 'src/main.c']);
      assert.deepEqual([done.trunc, done.walked, done.n, done.fv], [true, true, 3, FILES_VERSION]);
      assert.equal(incomplete(done), false);
      assert.equal(needsFiles(huge), false);
      await clearFiles(g);
    });
  } finally { globalThis.fetch = realFetch; S.token = ''; S.files = {}; S.repos = []; }
});

test('GitHub\'s "slow down" pauses a file pull and continues it; if it keeps saying so the pull stops with its progress, it does not fail every repo', async () => {
  const {SLOW} = await import('../public/js/budget.js');
  const realFetch = globalThis.fetch, was = {...SLOW};
  let slowFor = 0, calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const name = String(url).match(/repos\/o\/(\w+)\//)[1];
    if (slowFor > 0) { slowFor--; return {ok: false, status: 403, headers: new Headers({'x-ratelimit-remaining': '4000'}), json: async () => ({message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'})}; }
    return {ok: true, status: 200, headers: new Headers({etag: '"e"', 'x-ratelimit-remaining': '4000'}), json: async () => ({sha: 's', tree: [{path: name + '.c', type: 'blob'}]})};
  };
  try {
    await withDoc(async () => {
      Object.assign(SLOW, {baseMs: 5, max: 3});
      S.token = 'tok'; S.files = {};
      S.repos = Array.from({length: 6}, (_, i) => repo(40 + i, 'o/r' + i));
      // told to slow down twice, then let through: every list arrives, nothing counts as failed
      slowFor = 2;
      let g = nextGen(), res = await fetchFiles(g, S.repos);
      assert.deepEqual([res.got, res.failed, !!res.fatal, Object.keys(S.files).length], [6, 0, false, 6]);
      // GitHub never lets up: the pull stops (the same repos are not asked over and over), and says why
      await clearFiles(g);
      slowFor = Infinity; calls = 0;
      g = nextGen(); res = await fetchFiles(g, S.repos);
      assert.deepEqual([res.got, res.failed, res.fatal?.secondary], [0, 0, true]);
      assert.match(res.summary, /slow down/);
      assert.ok(calls <= 6 * 4, `the repos are not hammered while GitHub says no (${calls} requests)`);
      await clearFiles(g);
    });
  } finally { globalThis.fetch = realFetch; Object.assign(SLOW, was); S.token = ''; S.files = {}; S.repos = []; }
});

test('summaries written by older rules are computed again from the stored paths, without a request', async () => {
  await withDoc(async () => {
    const g = nextGen();
    const a = repo(20, 'o/a'), b = repo(21, 'o/b'), e = repo(22, 'o/empty');
    S.repos = [a, b, e]; S.files = {};
    give(a, ['hw/x.kicad_pcb', 'lib/y/z.kicad_sym']);
    give(b, ['docs/cheatsheet.pdf']);
    S.files['22'] = {n: 0, miss: 409, s: {v: 1, kinds: {}}, pushed: 'p1', at: 1};
    await saveFiles(g);
    assert.equal(filesNeedUpgrade(), false);
    // what version 1 of the rules had written for them
    S.files['20'] = {...S.files['20'], s: {v: 1, n: 2, kinds: {pcb: 2}, ex: {}, build: [], ext: [['kicad_pcb', 1]], boards: 0, top: []}};
    S.files['21'] = {...S.files['21'], s: {v: 1, n: 1, kinds: {schematic: 1}, ex: {}, build: [], ext: [['pdf', 1]], boards: 0, top: []}};
    S.files['23'] = {n: 3, s: {v: 1, kinds: {mesh: 3}, build: ['CMake']}, pushed: 'p1', at: 1};   // its paths are not in the store
    assert.equal(filesNeedUpgrade(), true);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('no request is made'); };
    try { assert.match(await upgradeFiles(g), /3 read again with the new rules/); } finally { globalThis.fetch = realFetch; }
    assert.deepEqual([S.files['20'].s.v, S.files['20'].s.kinds, S.files['20'].s.bk], [KINDS_VERSION, {pcb: 1}, {edalib: 1}]);
    assert.deepEqual([S.files['21'].s.kinds, S.files['21'].redo], [{}, undefined], '"cheatsheet.pdf" is no schematic any more');
    assert.deepEqual([S.files['23'].redo, S.files['23'].s.kinds, S.files['23'].s.v], [true, {mesh: 3}, KINDS_VERSION], 'a list whose paths are missing keeps what it said and is fetched again');
    assert.equal(S.files['22'].miss, 409, 'a repo without a tree is left alone');
    assert.equal(filesNeedUpgrade(), false);
    assert.equal((await get('filesum:me')).recs['20'].s.v, KINDS_VERSION, 'and saved');
    await clearFiles(g);
    S.repos = [];
  });
});
