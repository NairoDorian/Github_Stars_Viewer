// Tests for the 🗑 Remove button on removed or hidden repos (list.js): only those cards have it (a repo that is still on
// GitHub would just come back at the next star-list check), the first click only arms it, and the second deletes the
// repo's local copy — the card, its README, its commit / release index and its file list — from the open tab and from
// every store it belonged to (here: memory, the default backend without a local server).
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)},
  configurable: true,
});
globalThis.CustomEvent = class {};                                  // forks.js reports a scan result through window.dispatchEvent
globalThis.window = {dispatchEvent() {}, addEventListener() {}};

const {S, nextGen} = await import('../public/js/state.js');
const {get, shardOf} = await import('../public/js/store.js');
const {card, removeRepo} = await import('../public/js/list.js');

const el = () => ({value: '', checked: false, textContent: '', innerHTML: '', hidden: false, title: '', classList: {add() {}, remove() {}}, options: []});
const els = new Map();
const withDoc = async fn => {
  globalThis.document = {querySelector: sel => (els.has(sel) ? els.get(sel) : els.set(sel, el()).get(sel)), querySelectorAll: () => []};
  try { return await fn(); } finally { delete globalThis.document; }
};
const repo = (id, full, extra = {}) => ({id, full, owner: full.split('/')[0], name: full.split('/')[1], url: 'https://github.com/' + full,
  topics: [], langs: [], pushed: 'p1', branch: 'main', stars: 1, ...extra});
/** A stand-in for the card's button: only what removeRepo touches. */
const btn = remove => ({dataset: {remove}, textContent: '', classList: {add() {}, remove() {}}, isConnected: false});

test('🗑 remove: only removed or hidden repos have the button, and the first click only arms it', async () => {
  await withDoc(async () => {
    S.user = 'me'; S.visit = '';
    S.repos = [repo(1, 'a/gone', {gone: {at: 1}}), repo(2, 'b/live')];
    S.readmes = {1: {t: 'one'}, 2: {t: 'two'}}; S.history = {}; S.files = {};
    assert.match(card(S.repos[0]), /data-remove="1"/, 'a removed or hidden repo offers the button');
    assert.doesNotMatch(card(S.repos[1]), /data-remove/, 'a repo GitHub still shows does not: it would come back at the next check anyway');
    assert.equal(await get('stars:me'), null, 'nothing stored before the button is used');
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => 0;   // the disarm timer would keep the test process alive for 6 s
    try {
      const b = btn('1');
      await removeRepo(b);
      assert.equal(b.textContent, '🗑 Remove for sure?', 'the first click asks again instead of deleting');
      assert.equal(S.repos.length, 2, 'nothing is deleted yet');
      assert.equal(await get('stars:me'), null, 'and nothing is saved yet');
      b.isConnected = true;
      globalThis.setTimeout = realSetTimeout;
      await removeRepo(btn('9'));   // an unknown repo (its card was re-rendered away): ignored
      assert.equal(S.repos.length, 2);
    } finally { globalThis.setTimeout = realSetTimeout; }
  });
});

test('🗑 remove: the second click deletes the local copy from the tab and from every store', async () => {
  await withDoc(async () => {
    S.user = 'me'; S.visit = '';
    S.repos = [repo(1, 'a/gone', {gone: {at: 1}}), repo(2, 'b/gone', {gone: {at: 1}}), repo(3, 'c/live')];
    S.readmes = {1: {t: 'one'}, 2: {t: 'two'}, 3: {t: 'three'}};
    S.history = {1: {c: [['o', 1, 'm']]}, 2: {c: [['o2', 1, 'm']]}};
    S.files = {1: {p: ['x.kicad_pcb'], n: 1}, 3: {p: ['y.stl'], n: 1}};
    nextGen();
    const b = btn('1');
    await removeRepo(b);   // arms it…
    assert.equal(b.textContent, '🗑 Remove for sure?');
    await removeRepo(b);   // …and the second click removes
    assert.deepEqual(S.repos.map(r => r.full), ['b/gone', 'c/live'], 'the card is gone from the list');
    assert.deepEqual(Object.keys(S.readmes), ['2', '3'], 'its README entry is dropped, the others kept');
    assert.deepEqual(Object.keys(S.history), ['2']);
    assert.deepEqual(Object.keys(S.files), ['3'], 'its file list is dropped too');
    const stars = await get('stars:me');
    assert.equal(stars.repos.length, 2, 'the stored star list no longer has it');
    assert.equal(stars.repos.some(r => r.gone && r.full === 'a/gone'), false);
    assert.deepEqual(Object.keys(await get('readmes:me')), ['2', '3'], 'the stored READMEs no longer have it');
    const shard = await get(`history:me:${shardOf('1')}`);
    assert.notEqual(shard, null, 'the shard that held its commit index is rewritten');
    assert.equal(shard['1'], undefined, 'the stored shard no longer has it');
  });
});