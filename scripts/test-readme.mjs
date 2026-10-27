// Tests for README fetching and updating (sync.js) against a fake GitHub: READMEs are never trimmed, an unchanged README is
// not downloaded again, a changed one replaces the cached entry, and entries cut short by older versions are repaired.
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)},
  configurable: true,
});

const {S, nextGen} = await import('../public/js/state.js');
const {indexReadmes, needsReadme} = await import('../public/js/sync.js');
const {gitSha} = await import('../public/js/github.js');
/** Sets each file's `oid` to the real git blob hash of its text, as GitHub reports it. */
const hashed = async files => { for (const f of Object.values(files)) f.oid = await gitSha(f.text); return files; };

/** Fake GitHub: `files` maps "owner/name" → {text, oid, cut} where `cut` makes GraphQL report the blob as truncated. */
function fakeGitHub(files) {
  const calls = {details: 0, download: 0, rest: 0, light: 0};
  globalThis.fetch = async (url, init) => {
    const json = data => ({ok: true, status: 200, headers: new Headers(), json: async () => ({data})});
    if (String(url).endsWith('/graphql')) {
      const query = JSON.parse(init.body).query, data = {};
      const starts = [...query.matchAll(/(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)\{/g)];
      starts.forEach((m, i) => {
        const body = query.slice(m.index + m[0].length, starts[i + 1]?.index ?? query.length), f = files[`${m[2]}/${m[3]}`];
        if (body.includes('...on Blob{text')) {   // the download
          calls.download++;
          data[m[1]] = {object: {text: f.cut ? f.text.slice(0, 1000) : f.text, isTruncated: !!f.cut}};
        } else {   // the details check, with the README's hash
          calls.details++;
          if (!body.includes('languages(')) calls.light++;   // the light query: only the README hash
          data[m[1]] = {lastCommit: {target: {committedDate: '2024-01-01T00:00:00Z'}}, releases: {nodes: []}, latestRelease: null,
            languages: {totalSize: 0, edges: []}, defaultBranchRef: null, m0: {oid: f.oid}, m1: null};
        }
      });
      return json(data);
    }
    const full = String(url).match(/repos\/([^/]+\/[^/]+)\/readme/)?.[1];
    if (full) {   // REST: the whole file
      calls.rest++;
      return {ok: true, status: 200, headers: new Headers({ETag: '"e1"'}), text: async () => files[full].text};
    }
    return {ok: false, status: 404, headers: new Headers(), json: async () => ({})};
  };
  return calls;
}

const repo = (id, full) => ({id, full, owner: full.split('/')[0], name: full.split('/')[1], url: 'https://github.com/' + full, about: '', topics: [], lang: null, stars: 1, pushed: 'p1'});

test('READMEs are stored whole, never trimmed; a GraphQL-truncated one is fetched whole over REST', async () => {
  const el = {value: '', checked: false, textContent: '', innerHTML: '', hidden: false};
  globalThis.document = {querySelector: () => el};
  const realFetch = globalThis.fetch;
  try {
    const files = await hashed({
      'o/big': {text: 'long '.repeat(50_000)},                 // 250,000 characters
      'o/small': {text: '# small'},
      'o/cut': {text: 'x'.repeat(300_000), cut: true},        // GraphQL only returns a piece of it
    });
    const calls = fakeGitHub(files);
    S.token = 'tok'; S.readmes = {}; S.history = {};
    S.repos = [repo(1, 'o/big'), repo(2, 'o/small'), repo(3, 'o/cut')];
    const g = nextGen();

    await indexReadmes(g);
    assert.equal(S.readmes['1'].t.length, 250_000, 'not cut at 100,000 characters');
    assert.equal(S.readmes['1'].whole, true);
    assert.equal(S.readmes['3'].t.length, 300_000, 'the truncated blob was replaced by the whole file from REST');
    assert.deepEqual([calls.download, calls.rest], [3, 1], 'GraphQL tried all three, REST fetched the one it cut');
    assert.equal(S.readmes['1'].sha, files['o/big'].oid);

    assert.equal(calls.light, 0, 'a first look at repos asks for everything');

    // Unchanged (same hash): checked, but nothing is downloaded again. Their tiles and charts are fresh, so only the
    // README hash is asked for (the light query).
    for (const r of S.repos) { r.pushed = 'p2'; r.enrichedPushed = 'p2'; }
    Object.assign(calls, {details: 0, download: 0, rest: 0, light: 0});
    const before = S.readmes['1'];
    await indexReadmes(g);
    assert.equal(calls.details, 3);
    assert.equal(calls.light, 3, 'only the README hash was asked for, not languages and activity');
    assert.deepEqual([calls.download, calls.rest], [0, 0], 'the README hash is the same: no download');
    assert.equal(S.readmes['1'].t, before.t);
    assert.equal(S.readmes['1'].pushed, 'p2', 'but the entry is stamped as checked');

    // Changed upstream: the cached entry is replaced by the new text.
    files['o/big'] = (await hashed({x: {text: 'brand new README'}})).x;
    for (const r of S.repos) r.pushed = 'p3';   // now their details are stale too: the full query again
    Object.assign(calls, {details: 0, download: 0, rest: 0, light: 0});
    await indexReadmes(g);
    assert.equal(calls.download, 1, 'only the changed README is downloaded');
    assert.equal(S.readmes['1'].t, 'brand new README');
    assert.equal(S.readmes['1'].sha, files['o/big'].oid);
    assert.equal(S.readmes['2'].t, '# small', 'the others are untouched');
  } finally { globalThis.fetch = realFetch; delete globalThis.document; S.token = ''; S.readmes = {}; S.repos = []; }
});

test('a README an older version cut at 100,000 characters is recognised and downloaded again in full, even if its hash matches', async () => {
  const el = {value: '', checked: false, textContent: '', innerHTML: '', hidden: false};
  globalThis.document = {querySelector: () => el};
  const realFetch = globalThis.fetch;
  try {
    const whole = 'y'.repeat(180_000);
    const files = await hashed({'o/old': {text: whole}});
    const calls = fakeGitHub(files);
    S.token = 'tok';
    S.repos = [repo(7, 'o/old')];
    // what the old code stored: the first 100,000 characters, the right hash, a fresh check date, no `whole` flag
    S.readmes = {'7': {t: whole.slice(0, 100_000), sha: files['o/old'].oid, path: 'README.md', at: Date.now(), pushed: 'p1'}};
    assert.equal(needsReadme(S.repos[0]), true, 'recognised as cut');
    const g = nextGen();
    await indexReadmes(g);
    assert.equal(calls.download, 1);
    assert.equal(S.readmes['7'].t.length, 180_000);
    assert.equal(S.readmes['7'].whole, true);
    assert.equal(needsReadme(S.repos[0]), false, 'and no longer needs fixing');

    // A short README an old version stored is complete: it is simply kept.
    S.readmes = {'7': {t: 'short', sha: files['o/old'].oid, at: Date.now(), pushed: 'p1'}};
    assert.equal(needsReadme(S.repos[0]), false);
  } finally { globalThis.fetch = realFetch; delete globalThis.document; S.token = ''; S.readmes = {}; S.repos = []; }
});
