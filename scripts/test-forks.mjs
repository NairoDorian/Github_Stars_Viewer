// Tests for hidden-fork detection (forks.js): copies GitHub doesn't mark as forks, found by shared commits, README,
// description and name, and the toolbar's Forks choice.
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)},
  configurable: true,
});
const events = [];
globalThis.window = {dispatchEvent: e => events.push(e.type), addEventListener() {}};
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };

const {S} = await import('../public/js/state.js');
const F = await import('../public/js/forks.js');
const {parseQuery, match} = await import('../public/js/list.js');

/** Deterministic prose: `n` words drawn from a seeded generator, so two seeds give unrelated READMEs. */
function prose(seed, n = 400) {
  const vocab = 'the a of to and in is it for on with as this that by from install run build use your project config file api server client data model test docs example usage support command line option feature fast simple library tool plugin module network video audio image text android linux windows mac device screen mirror control record stream'.split(' ');
  let x = seed * 2654435761 >>> 0;
  const out = [];
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out.push(vocab[x % vocab.length]); }
  return out.join(' ');
}
let nextId = 1;
const repo = (full, extra = {}) => {
  const [owner, name] = full.split('/');
  return {id: nextId++, full, owner, name, about: '', topics: [], stars: 10, created: '2020-01-01T00:00:00Z', fork: false, ...extra};
};
const setup = (repos, readmes = {}, history = {}) => {
  S.repos = repos;
  S.readmes = Object.fromEntries(Object.entries(readmes).map(([full, t]) => [String(repos.find(r => r.full === full).id), {t}]));
  S.history = Object.fromEntries(Object.entries(history).map(([full, c]) => [String(repos.find(r => r.full === full).id), {c}]));
};
const found = map => Object.fromEntries([...map].map(([k, v]) => [S.repos.find(r => String(r.id) === k).full, v.of.full]));

test('MinHash: the same text with other links and badges is ~identical, unrelated text is not', () => {
  const text = prose(1);
  const a = F.signature(`# Tool\n[![build](https://img.shields.io/x/orig)](https://ci/orig)\n${text}\nSee https://github.com/orig/tool`);
  const b = F.signature(`# Tool\n[![build](https://img.shields.io/x/copier)](https://ci/copier)\n${text}\nSee https://github.com/copier/tool`);
  const c = F.signature(prose(2));
  assert.ok(F.similarity(a, b) > 0.95, 'links and badges are ignored');
  assert.ok(F.similarity(a, c) < 0.2, 'unrelated READMEs are far apart');
  assert.equal(F.signature('# tiny\nhello world'), null, 'too short to judge');
});

test('a README copied under another name is a hidden fork of the older repo', () => {
  const orig = repo('alice/scrcpy', {created: '2018-03-01T00:00:00Z', stars: 100000});
  const copy = repo('bob/screen-mirror', {created: '2023-05-01T00:00:00Z', stars: 3});
  const other = repo('carol/unrelated');
  setup([copy, orig, other], {'alice/scrcpy': prose(7), 'bob/screen-mirror': prose(7).replace('install', 'setup'), 'carol/unrelated': prose(8)});
  const map = F.detectHiddenForks();
  assert.deepEqual(found(map), {'bob/screen-mirror': 'alice/scrcpy'});
  assert.match(map.get(String(copy.id)).why.join(), /README \d+% identical/);
});

test('the same name and description is enough; a description alone is not', () => {
  const desc = 'Display and control your Android device from a desktop computer';
  setup([repo('alice/scrcpy', {about: desc, created: '2018-01-01T00:00:00Z'}), repo('bob/scrcpy', {about: desc + '!', created: '2022-01-01T00:00:00Z'}),
    repo('carol/other-name', {about: desc, created: '2023-01-01T00:00:00Z'})]);
  assert.deepEqual(found(F.detectHiddenForks()), {'bob/scrcpy': 'alice/scrcpy'});
});

test('shared git history (same commit ids and dates) marks a copy even with a rewritten README', () => {
  const commits = Array.from({length: 120}, (_, i) => ['c' + String(1e9 + i), 1600000000 + i * 1000, 'commit ' + i]).reverse();   // newest first
  const orig = repo('alice/tool', {created: '2019-01-01T00:00:00Z'});
  const copy = repo('bob/my-thing', {created: '2024-01-01T00:00:00Z'});
  const sub = repo('dave/big-app', {created: '2024-02-01T00:00:00Z'});   // imported a few of those commits (subtree): not a copy
  const own = Array.from({length: 400}, (_, i) => ['d' + String(1e9 + i), 1700000000 + i, 'own ' + i]).reverse();
  setup([orig, copy, sub], {'alice/tool': prose(3), 'bob/my-thing': prose(4)},
    {'alice/tool': [['new1', 1700000001, 'later'], ...commits], 'bob/my-thing': commits.slice(20), 'dave/big-app': [...own, ...commits.slice(-5)]});
  const map = F.detectHiddenForks();
  assert.deepEqual(found(map), {'bob/my-thing': 'alice/tool'});
  assert.match(map.get(String(copy.id)).why[0], /shares 100 commits \(100% of its history/);
});

// Regression tests for the false positives seen on a real profile of 6,500 stars.
const history = (prefix, n, t0, step = 1000) => Array.from({length: n}, (_, i) => [prefix + String(1e9 + i), t0 + i * step, 'c' + i]).reverse();   // newest first

test('direction: an original that stopped changing is contained in its continuation, yet it is the original', () => {
  const base = history('s', 300, 1500000000);
  const orig = repo('rikka/shizuku', {created: '2019-01-01T00:00:00Z', stars: 9000});
  const next = repo('someone/shizuku-next', {created: '2024-01-01T00:00:00Z', stars: 300});
  setup([orig, next], {}, {'rikka/shizuku': base, 'someone/shizuku-next': [...history('n', 400, 1700000000), ...base]});
  assert.deepEqual(found(F.detectHiddenForks()), {}, 'the continuation shares 43% of its history: supporting evidence only');
  next.about = orig.about = 'Using system APIs directly with adb/root privileges from normal apps';
  assert.deepEqual(found(F.detectHiddenForks()), {'someone/shizuku-next': 'rikka/shizuku'}, 'never the other way round');
});

test('a copy of a copy, or two copies of one upstream, point at the upstream, not at each other', () => {
  const base = history('x', 400, 1600000000);
  const up = repo('78/xiaozhi', {created: '2024-01-01T00:00:00Z', stars: 20000});
  const c1 = repo('felix/xiaozhi', {created: '2025-01-01T00:00:00Z', stars: 2});
  const c2 = repo('haitao/xiaozhi-copy', {created: '2025-06-01T00:00:00Z', stars: 1});
  const viaFork = repo('jmead/gateway', {created: '2024-06-01T00:00:00Z', fork: true});   // a GitHub fork of the upstream
  setup([c2, viaFork, c1, up], {}, {'78/xiaozhi': base, 'felix/xiaozhi': base.slice(0, 380), 'haitao/xiaozhi-copy': base.slice(0, 370), 'jmead/gateway': base.slice(0, 390)});
  const map = F.detectHiddenForks();
  assert.deepEqual(found(map), {'felix/xiaozhi': '78/xiaozhi', 'haitao/xiaozhi-copy': '78/xiaozhi'});
  for (const v of map.values()) assert.equal(v.root.full, '78/xiaozhi');
});

test('a few shared commits, or a small part of a history, are not a copy', () => {
  const own = history('o', 500, 1650000000), common = history('c', 2, 1600000000);
  setup([repo('a/esp32drop', {created: '2025-01-01T00:00:00Z'}), repo('b/esp32drop', {created: '2025-03-01T00:00:00Z'})], {},
    {'a/esp32drop': [...own, ...common], 'b/esp32drop': [...history('p', 8, 1700000000), ...common]});
  assert.deepEqual(found(F.detectHiddenForks()), {}, '2 shared commits and the same name');
  const big = history('k', 400, 1500000000);
  setup([repo('maniac/rf24', {created: '2011-01-01T00:00:00Z'}), repo('nrf24/rf24', {created: '2014-01-01T00:00:00Z'})], {},
    {'maniac/rf24': big.slice(-200), 'nrf24/rf24': [...history('m', 800, 1700000000), ...big.slice(-200)]});
  assert.deepEqual(found(F.detectHiddenForks()), {}, 'a long continuation (20% shared) with the same name: supporting evidence only');
});

test('histories that keep only their newest commits are compared over the period both cover', () => {
  const all = history('m', 3000, 1600000000);   // the upstream's full history, oldest first in time
  const up = repo('meshcore/meshcore', {created: '2025-01-01T00:00:00Z'}), copy = repo('narcolo/handheld', {created: '2026-01-01T00:00:00Z'});
  setup([up, copy], {}, {'meshcore/meshcore': all.slice(0, 2000), 'narcolo/handheld': all.slice(1500, 3000)});   // the upstream stores its newest 2,000, the copy older ones
  S.history[String(up.id)].capped = true;
  S.history[String(up.id)].done = true;
  const map = F.detectHiddenForks();
  assert.deepEqual(found(map), {'narcolo/handheld': 'meshcore/meshcore'});
  assert.match(map.get(String(copy.id)).why[0], /shares 500 commits \(100% of its history in the period both indexes cover\)/);
  const {shared, total} = F.sharedCommits(all.slice(1500, 3000), all.slice(0, 2000), true);
  assert.deepEqual([shared, total], [500, 500], 'the copy\'s 1,000 older commits are outside the upstream\'s window: not counted');
});

test('vendor examples: repos that each started from one example README did not copy each other', () => {
  const lvgl = '# LVGL Demo v9\n\nThis example demonstrates how to port LVGL v9 and conduct performance testing.\n\n' + prose(41, 500);
  const idf = '| Supported Targets | ESP32 | ESP32-C3 | ESP32-S3 |\n| ----------------- | ----- | -------- | -------- |\n\n# Hello World Example\n\n' + prose(42, 300);
  const esprs = '# box_demo\n\n## Dev Containers\n\nThis repository offers Dev Containers supports for: VS Code Dev Containers, GitHub Codespaces\n\n' + prose(43, 300);
  for (const t of [lvgl, idf, esprs]) assert.equal(F.signature(t), null);
  // A long example README without a known phrase, kept by 4 unrelated repos: more than TEMPLATE look-alikes without shared history.
  const example = prose(44, 900), demos = ['a/jc1060', 'b/jc8012', 'c/waveshare-demo', 'd/koson-hmi'].map((f, i) => repo(f, {created: `202${i}-01-01T00:00:00Z`}));
  setup(demos, Object.fromEntries(demos.map(r => [r.full, example])));
  assert.deepEqual(found(F.detectHiddenForks()), {});
  // …while a popular original whose README many real clones kept is still an original: they share its commits.
  const base = history('q', 200, 1600000000), orig = repo('scott/smartknob', {created: '2020-01-01T00:00:00Z'});
  const clones = ['e/knob1', 'f/knob2', 'g/knob3', 'h/knob4'].map((f, i) => repo(f, {created: `202${i + 2}-01-01T00:00:00Z`}));
  setup([orig, ...clones], Object.fromEntries([orig, ...clones].map(r => [r.full, example])),
    Object.fromEntries([orig, ...clones].map(r => [r.full, base])));
  const map = F.detectHiddenForks();
  assert.equal(map.size, 4);
  for (const v of map.values()) { assert.equal(v.of.full, 'scott/smartknob'); assert.ok(v.why.some(w => w.startsWith('README')), 'the README still counts'); }
});

test('GitHub forks, the same owner, templates and pairs marked "not a copy" are never hidden forks', () => {
  const tpl = prose(5);   // a starter README shared by many unrelated repos
  const repos = ['a/x1', 'b/x2', 'c/x3', 'd/x4', 'e/x5', 'f/x6', 'g/x7'].map((f, i) => repo(f, {created: `202${i}-01-01T00:00:00Z`}));
  const fork = repo('h/real-fork', {fork: true, created: '2025-01-01T00:00:00Z'}), mine1 = repo('me/app'), mine2 = repo('me/app-v2', {created: '2024-01-01T00:00:00Z'});
  const orig = repo('i/lib', {created: '2015-01-01T00:00:00Z'}), notCopy = repo('j/lib', {created: '2016-01-01T00:00:00Z'});
  setup([...repos, fork, mine1, mine2, orig, notCopy], {...Object.fromEntries(repos.map(r => [r.full, tpl])), 'h/real-fork': prose(6), 'a/x1': tpl,
    'me/app': prose(9), 'me/app-v2': prose(9), 'i/lib': prose(10), 'j/lib': prose(10)});
  S.readmes[String(repos[0].id)] = {t: prose(6)};   // a/x1 is the fork's parent
  assert.deepEqual(found(F.detectHiddenForks(S.repos, new Set([F.pairKey(orig, notCopy)]))), {});
});

test('empty, blank and placeholder READMEs or descriptions never link two repos', () => {
  const blankReadmes = ['', '   \n\n  ', '# \n', '[![ci](https://x/b.svg)](https://x) [![npm](https://y/c.svg)](https://y)\n<p align="center"><img src="logo.png"></p>\n<!-- -->'];
  for (const t of blankReadmes) assert.equal(F.signature(t), null, JSON.stringify(t));
  const flutter = (name) => `# ${name}\n\nA new Flutter project.\n\n## Getting Started\n\nThis project is a starting point for a Flutter application.\n\n` +
    'A few resources to get you started if this is your first Flutter project: - Lab: Write your first Flutter app - Cookbook: Useful Flutter samples. ' +
    'For help getting started with Flutter development, view the online documentation, which offers tutorials, samples, guidance on mobile development, and a full API reference.';
  const cra = '# Getting Started with Create React App\n\nThis project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).\n\n## Available Scripts\n\n' +
    'In the project directory, you can run: npm start Runs the app in the development mode. Open http://localhost:3000 to view it in your browser. The page will reload when you make changes. ' +
    'You may also see any lint errors in the console. npm test Launches the test runner in the interactive watch mode. npm run build Builds the app for production to the build folder. ' +
    'It correctly bundles React in production mode and optimizes the build for the best performance. The build is minified and the filenames include the hashes. Your app is ready to be deployed!';
  for (const t of [flutter('x'), cra]) assert.equal(F.signature(t), null, 'a generator\'s untouched README is empty');
  assert.ok(F.signature(prose(30, 800) + ' ' + cra), 'a long README that kept the generator\'s section still counts');
  for (const d of ['', '   ', '🚀🚀', '...', 'No description provided', 'TODO', 'A new Flutter project.', 'my first repository']) assert.equal(F.normDesc(d), '', JSON.stringify(d));
  assert.equal(F.descMatch('', ''), null);
  assert.equal(F.descMatch(null, undefined), null);
  assert.equal(F.descMatch('A new Flutter project.', 'A new Flutter project.'), null);

  // Pairs that share nothing but emptiness, or a placeholder, or a name and topics.
  const t = ['android', 'cli', 'tool'];
  const repos = [
    repo('a/one', {about: '', topics: t, created: '2019-01-01T00:00:00Z'}), repo('b/two', {about: '', topics: t, created: '2020-01-01T00:00:00Z'}),     // nothing at all
    repo('c/app', {about: 'TODO', created: '2019-01-01T00:00:00Z'}), repo('d/app', {about: 'todo', topics: [], created: '2021-01-01T00:00:00Z'}),       // same name, placeholder description
    repo('e/fl1', {about: 'A new Flutter project.'}), repo('f/fl2', {about: 'A new Flutter project.', created: '2022-01-01T00:00:00Z'}),             // generator defaults
    repo('g/web', {about: '', created: '2019-01-01T00:00:00Z'}), repo('h/web', {about: '', created: '2022-01-01T00:00:00Z'}),                        // blank READMEs, same name
    repo('i/same', {about: '', topics: t}), repo('j/same', {about: '', topics: t, created: '2023-01-01T00:00:00Z'}),                                // same name and topics, nothing else
  ];
  setup(repos, {'a/one': '', 'b/two': '   ', 'e/fl1': flutter('fl1'), 'f/fl2': flutter('fl2'), 'g/web': blankReadmes[3], 'h/web': blankReadmes[3], 'c/app': cra, 'd/app': cra});
  S.readmes[String(repos[0].id)] = {t: ''};   // a repo without README is stored with an empty text
  assert.deepEqual(found(F.detectHiddenForks()), {});
  // Suggestions too: an empty or placeholder description is never "the same" as a star's.
  assert.equal(F.copyOfStar({full_name: 'z/web', description: '', created_at: '2024-01-01T00:00:00Z'}), null);
  assert.equal(F.copyOfStar({full_name: 'z/app', description: 'TODO', created_at: '2024-01-01T00:00:00Z'}), null);
});

test('the Forks choice: show, hide or show only each kind', async () => {
  const desc = 'A really fast terminal emulator written in Rust';
  const a = repo('alice/term', {about: desc, created: '2018-01-01T00:00:00Z'}), b = repo('bob/term', {about: desc, created: '2022-01-01T00:00:00Z'});
  const f = repo('carol/term-fork', {fork: true}), n = repo('dave/plain');
  setup([a, b, f, n]);
  F.scheduleForkScan();
  await F.settleForks();
  assert.equal(F.forkKind(b), 'hidden');
  assert.equal(F.forkKind(f), 'fork');
  assert.deepEqual(F.copiesOf(a).map(r => r.full), ['bob/term']);
  assert.ok(events.includes('hidden-forks'), 'the list is told to redraw');
  const shown = mode => S.repos.filter(r => F.forkVisible(r, mode)).map(r => r.owner).join();
  assert.equal(shown('all'), 'alice,bob,carol,dave');
  assert.equal(shown('hide'), 'alice,bob,dave');
  assert.equal(shown('hideHidden'), 'alice,carol,dave');
  assert.equal(shown('hideAll'), 'alice,dave');
  assert.equal(shown('only'), 'carol');
  assert.equal(shown('onlyHidden'), 'bob');
  assert.equal(shown('onlyAll'), 'bob,carol');
  F.setForkMode('hideAll');
  assert.deepEqual([S.hideForks, S.hideCopies], [true, true]);
  F.setForkMode('onlyHidden');
  assert.deepEqual([S.hideForks, S.hideCopies], [false, false], 'Discover is never limited to forks');
  F.setForkMode('nonsense');
  assert.equal(S.forkMode, 'all');
  // Search qualifiers
  const q = s => S.repos.filter(r => match(r, parseQuery(s), false)).map(r => r.owner).join();
  assert.equal(q('is:hiddenfork'), 'bob');
  assert.equal(q('is:copy'), 'bob');
  assert.equal(q('is:anyfork'), 'bob,carol');
  assert.equal(q('is:original'), 'alice');
  assert.equal(q('-is:anyfork'), 'alice,dave');
  // "not a copy" forgets the pair, for good
  F.notACopy(String(b.id));
  assert.equal(F.forkKind(b), null);
  assert.match(storage.get('starsViewer.notCopies'), /\|/);
  F.scheduleForkScan();
  await F.settleForks();
  assert.equal(F.forkKind(b), null, 'a rescan keeps it forgotten');
  F.resetForks();
});

test('copyOfStar: a suggestion with the name and description of an older star of another owner', () => {
  const desc = 'Display and control your Android device from a desktop computer';
  setup([repo('alice/scrcpy', {about: desc, created: '2018-01-01T00:00:00Z'})]);
  assert.equal(F.copyOfStar({full_name: 'bob/scrcpy', description: desc, created_at: '2022-01-01T00:00:00Z'})?.full, 'alice/scrcpy');
  assert.equal(F.copyOfStar({full_name: 'bob/scrcpy', description: 'Something else entirely, really', created_at: '2022-01-01T00:00:00Z'}), null);
  assert.equal(F.copyOfStar({full_name: 'old/scrcpy', description: desc, created_at: '2015-01-01T00:00:00Z'}), null, 'older than your star: the original');
  assert.equal(F.copyOfStar({full_name: 'bob/scrcpy', description: desc, created_at: '2022-01-01T00:00:00Z', fork: true}), null, 'a real fork is a fork');
});

test('detection stays fast: 1,500 repos with READMEs', () => {
  const repos = Array.from({length: 1500}, (_, i) => repo(`u${i}/r${i}`, {about: 'project number ' + i}));
  setup(repos, Object.fromEntries(repos.map((r, i) => [r.full, prose(1000 + i, 300)])));
  const t0 = performance.now();
  assert.equal(F.detectHiddenForks().size, 0);
  const cold = performance.now() - t0, t1 = performance.now();
  F.detectHiddenForks();
  const warm = performance.now() - t1;
  assert.ok(cold < 8000, `first scan took ${Math.round(cold)} ms`);
  assert.ok(warm < 1000, `a scan with cached signatures took ${Math.round(warm)} ms`);
});
