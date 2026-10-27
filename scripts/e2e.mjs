// End-to-end browser test (optional: Playwright is not a dependency of the project).
//   npm i --no-save playwright   (or set PLAYWRIGHT_DIR to a folder where it is installed)
//   node scripts/e2e.mjs         uses your installed Chrome; set E2E_CHANNEL=msedge, or E2E_CHANNEL= for Playwright's Chromium
// It starts its own server on a random port with a throwaway data folder, and replaces GitHub and the cache with in-memory
// fakes: nothing real is read, written, deleted or sent, and your ./data folder and running server are untouched.
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {chromium} = createRequire(process.env.PLAYWRIGHT_DIR ? join(process.env.PLAYWRIGHT_DIR, 'x.js') : import.meta.url)('playwright');
const port = 19000 + Math.floor(Math.random() * 900), base = `http://localhost:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'stars-viewer-e2e-'));
const server = spawn(process.execPath, ['server.js'], {cwd: root, env: {...process.env, PORT: String(port), STARS_DATA: dataDir}, stdio: 'ignore'});
await new Promise(r => setTimeout(r, 900));

const channel = process.env.E2E_CHANNEL === undefined ? 'chrome' : process.env.E2E_CHANNEL || undefined;
const browser = await chromium.launch({channel});
const context = await browser.newContext({viewport: {width: 1280, height: 900}});
await context.addCookies([{name: 'starsViewerCache', value: '1', url: base}]);   // "Keep cache" is off unless the cookie says so
// Every progress step the page showed, as "<step>:<state>", recorded as it appears: the panel hides itself a few seconds
// after a job, which a slow test machine could miss. (Init scripts are injected by the browser, not limited by the CSP.)
await context.addInitScript(() => {
  const seen = window.__lanes = new Set();
  new MutationObserver(() => { for (const el of document.querySelectorAll('#lanes .lane')) seen.add(`${el.dataset.lane}:${el.classList[1]}`); })
    .observe(document, {subtree: true, childList: true});
});
const lanesSeen = () => page.evaluate(() => [...window.__lanes]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/404|403|Failed to load resource/.test(m.text())) errors.push('console.error ' + m.text()); });

// ---- the cache lives in memory; we also record which keys were written ----
const store = {config: JSON.stringify({token: 'ghp_fake', user: 'e2etest'})};
let puts = [], wiped = 0;
await page.route(/\/cache(\/.*)?$/, async r => {
  const req = r.request(), path = decodeURIComponent(new URL(req.url()).pathname), key = path.slice(7);
  if (req.method() === 'DELETE' && (path === '/cache' || path === '/cache/')) {
    const deleted = Object.keys(store).length;
    for (const k of Object.keys(store)) delete store[k];
    wiped++;
    return r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({deleted})});
  }
  if (req.method() === 'PUT') { store[key] = req.postData(); puts.push(key); return r.fulfill({status: 204}); }
  return r.fulfill({status: 200, contentType: 'application/json', body: store[key] || 'null'});
});

// ---- a fake GitHub with 3 starred repos ----
const names = ['alpha', 'beta', 'gamma'], N = 5000, TOTAL = 3 * N, DELAY = 600;
const star = (n, i) => ({starred_at: '2026-01-0' + (i + 1) + 'T00:00:00Z', repo: {id: 100 + i, full_name: 'acme/' + n, name: n, owner: {login: 'acme', avatar_url: ''},
  html_url: 'https://github.com/acme/' + n, description: 'The ' + n + ' project', topics: ['demo'], stargazers_count: 10 + i, forks_count: 1, open_issues_count: 0,
  language: 'Go', license: null, archived: false, fork: false, created_at: '2025-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z', default_branch: 'main', homepage: null}});
// Commit number i (0 = oldest, N-1 = newest) has the id "<i in hex, 8 digits>bbbb…"; a repo's history is listed newest first.
const oid = i => i.toString(16).padStart(8, '0') + 'b'.repeat(32), numberOf = id => parseInt(id.slice(0, 8), 16);
const commit = (i, full) => ({oid: oid(i), committedDate: new Date(Date.UTC(2023, 0, 1) + i * 36e5).toISOString(),
  message: `commit ${i} of ${full}: ${full.endsWith('beta') && i === 7 ? 'fix zebra crash' : 'tidy'}`});
// alpha: stable release only. beta: a newer PRE-release than the stable one. gamma: no releases.
const releasesOf = full => full.endsWith('alpha') ? [{tagName: 'v1.0', createdAt: '2024-02-01T00:00:00Z', publishedAt: '2024-02-01T00:00:00Z', isPrerelease: false}]
  : full.endsWith('beta') ? [{tagName: 'v2.0-rc1', createdAt: '2024-03-01T00:00:00Z', publishedAt: '2024-03-01T00:00:00Z', isPrerelease: true},
    {tagName: 'v1.9', createdAt: '2024-01-01T00:00:00Z', publishedAt: '2024-01-01T00:00:00Z', isPrerelease: false}] : [];
const calls = {first: 0, after: 0, seq: 0, rel: 0};
await page.route('https://api.github.com/**', async r => {
  const u = new URL(r.request().url()), json = (o, s = 200) => r.fulfill({status: s, contentType: 'application/json', body: JSON.stringify(o)});
  if (u.pathname.endsWith('/starred')) return json(names.map(star));
  if (u.pathname === '/rate_limit') return json({resources: {core: {remaining: 5000, limit: 5000, reset: 0}, graphql: {remaining: 4999, limit: 5000, reset: 0}}});
  if (u.pathname !== '/graphql') return json({}, 404);
  const q = JSON.parse(r.request().postData()).query, data = {};
  const starts = [...q.matchAll(/(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)\{/g)];
  let slow = false;
  starts.forEach((m, i) => {
    const body = q.slice(m.index + m[0].length, starts[i + 1]?.index ?? q.length), full = m[2] + '/' + m[3], rels = releasesOf(full);
    const latest = rels.find(x => !x.isPrerelease);
    const lastBits = {lastCommit: {target: {committedDate: commit(N - 1, full).committedDate}}, latestRelease: latest ? {tagName: latest.tagName} : null};
    if (body.includes('releases(first:5,') && body.includes('oid committedDate')) {   // the cheap check of history.js
      data[m[1]] = {defaultBranchRef: {target: {oid: oid(N - 1), committedDate: lastBits.lastCommit.target.committedDate}}, latestRelease: lastBits.latestRelease,
        releases: {totalCount: rels.length, nodes: rels.map(x => ({...x, isDraft: false}))}};
    } else if (body.includes('releases(first:5,')) {   // the tile / detail refresh of sync.js
      data[m[1]] = {...lastBits, releases: {nodes: rels.map(x => ({...x, isDraft: false}))}, languages: {totalSize: 0, edges: []}, defaultBranchRef: null};
    } else if (body.includes('releases(first:25')) {
      calls.rel++;
      data[m[1]] = {releases: {pageInfo: {hasNextPage: false, endCursor: 'x'}, nodes: rels.map(x => ({...x, name: '', isDraft: false,
        description: `Notes for ${full}: Quokka mode, thanks @zed-the-author! See https://github.com/acme/${full.slice(5)}/pull/9 and [docs](https://docs.test/a).`}))}};
    } else if (body.includes('object(expression:')) {   // a page of commit history, from a commit, optionally after a cursor "<commit> <index>"
      slow = true;
      const start = body.match(/expression:"([0-9a-f]{40})"/)[1], after = body.match(/after:"([0-9a-f]{40}) (\d+)"/);
      if (after) calls.after++; else if (body.includes('totalCount')) calls.first++; else calls.seq++;
      const skip = after ? Number(after[2]) + 1 : 0, startPos = N - 1 - numberOf(start), from = startPos + skip;   // positions in the newest-first list
      const nodes = Array.from({length: Math.max(0, Math.min(100, N - from))}, (_, k) => commit(N - 1 - (from + k), full));
      data[m[1]] = {object: {history: {...(body.includes('totalCount') ? {totalCount: N - startPos} : {}),
        pageInfo: {hasNextPage: from + 100 < N, endCursor: `${start} ${skip + nodes.length - 1}`}, nodes}}};
    } else data[m[1]] = null;
  });
  if (slow) await new Promise(res => setTimeout(res, DELAY));   // slow enough for the Cancel button to be clicked
  json({data});
});

// ---- helpers ----
const status = () => page.textContent('#status');
/** Waits until fn(arg), run in the page, returns something truthy. Not page.waitForFunction: it needs eval in the page,
 *  which the page's Content-Security-Policy forbids, and this test runs under the real policy (a violation fails it). */
async function until(fn, arg = null, timeout = 30000) {
  for (const t0 = Date.now(); ;) {
    if (await page.evaluate(fn, arg).catch(() => false)) return;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout} ms waiting for ${String(fn).slice(0, 140)}`);
    await new Promise(r => setTimeout(r, 50));
  }
}
const waitStatus = (re, timeout = 30000) => until(s => new RegExp(s).test(document.querySelector('#status').textContent), re.source, timeout);
const count = async () => (await page.textContent('#count')).replace(/⬇.*/, '').trim();
const search = async q => { await page.fill('#q', q); await page.waitForTimeout(500); return count(); };
const cookie = async () => (await context.cookies(base)).find(c => c.name === 'starsViewerCache')?.value;
const step = (name, detail = '') => console.log(`✔ ${name}${detail ? ' · ' + detail : ''}`);

try {
  await page.goto(base + '/');
  await waitStatus(/all checked/);
  step('loads a profile with 3 stars', await status());
  const firstLanes = await lanesSeen();
  for (const lane of ['stars:done', 'details:done']) assert.ok(firstLanes.includes(lane), `the first load shows its steps (${lane}): ${firstLanes}`);
  step('first load: the star-list pull and the details update are shown as steps, then done');

  // ---- tiles ----
  const tiles = async name => (await page.locator('.card', {hasText: name}).first().locator('.meta').innerText()).replace(/\s+/g, ' ');
  const alpha = await tiles('alpha'), beta = await tiles('beta'), gamma = await tiles('gamma');
  assert.match(alpha, /last commit .*ago/); assert.match(alpha, /last release v1\.0/);
  assert.match(beta, /last release v2\.0-rc1 pre-release/, 'newest by date is the pre-release, flagged');
  assert.match(gamma, /no releases/);
  step('tiles show last commit and last release', 'beta → ' + beta.match(/last release \S+( pre-release)?/)[0]);

  // ---- toolbar groups and the collapsible options panel ----
  assert.deepEqual(await page.locator('.grp-label').allInnerTexts(), ['SEARCH IN', 'INDEX', 'VIEW', 'DATA']);
  assert.equal(await page.isHidden('#histOpts'), true, 'options panel starts collapsed');
  assert.match(await page.textContent('#histOptsSummary'), /@mentions stripped · links kept/);
  await page.click('#histOptsToggle');
  assert.equal(await page.isVisible('#histOpts'), true);
  assert.equal(await page.getAttribute('#histOptsToggle', 'aria-expanded'), 'true');
  assert.equal(await page.isChecked('#optMentions'), true); assert.equal(await page.isChecked('#optLinks'), false);
  step('toolbar is grouped; ▾ opens the options panel (mentions stripped, links kept by default)');
  await page.screenshot({path: process.env.E2E_SHOT || 'e2e-toolbar.png'});

  // ---- index with Cancel in the middle ----
  await page.click('#indexHistory');
  await page.waitForSelector('#cancelTask', {state: 'visible', timeout: 10000});
  await page.waitForSelector('#lanes .lane[data-lane="commits"]', {timeout: 10000});   // (the lanes of the first sync may still be fading out)
  const lanesText = await page.locator('#lanes').innerText();
  for (const label of ['Check commits & releases', 'Fetch release notes', 'Fetch commit messages']) assert.match(lanesText, new RegExp(label), 'step shown: ' + label);
  await waitStatus(/Indexing commit messages/, 20000);
  await until(() => (document.querySelector('.lane[data-lane="commits"] progress')?.value ?? 0) > 0, null, 5000);   // the commit bar has moved
  if (process.env.E2E_LANES) await page.screenshot({path: process.env.E2E_LANES});   // optional: what the panel looks like mid-run
  assert.match(await page.locator('.lane[data-lane="commits"] .lane-text').innerText(), /\d+% · .*repos · .*commits · .*\/s · elapsed/, 'with its numbers');
  await page.click('#cancelTask');
  await waitStatus(/stopped, progress saved/, 40000);
  await page.waitForSelector('.lane.stopped[data-lane="commits"]', {timeout: 10000});
  const partial = Number((await status()).match(/([\d,]+) commit messages/)[1].replace(/,/g, ''));
  assert.ok(partial > 0 && partial < TOTAL, `stopped part-way: ${partial} of ${TOTAL}`);
  assert.equal(await page.isHidden('#cancelTask'), true);
  assert.ok(puts.some(k => /^history:e2etest:\d+$/.test(k)), 'progress was saved as history shards');
  assert.ok(!puts.includes('history:e2etest'), 'never as one big record');
  step('Cancel stops after the current batch and keeps progress', `${partial.toLocaleString()} of ${TOTAL.toLocaleString()} commits saved`);

  // ---- continue: nothing is fetched twice, the rest is fetched by cursor ----
  Object.assign(calls, {first: 0, after: 0, seq: 0, rel: 0});
  await page.click('#indexHistory');
  await waitStatus(new RegExp(`🔎 ${TOTAL.toLocaleString()} commit messages and 3 releases indexed`), 60000);
  assert.equal(calls.seq, 0, 'resuming never restarts a repo from its head');
  assert.ok(calls.after > 0, 'the remaining pages were fetched by cursor');
  step('second click continues and completes', await status());
  await page.waitForSelector('#lanes', {state: 'hidden', timeout: 10000});
  step('the progress panel shows every step, moves, marks Cancel as stopped, and hides itself after the run');

  // ---- search ----
  assert.match(await search('zebra crash'), /^1 of 3/);
  assert.match(await page.locator('.snip').first().innerText(), /Commit .*fix zebra crash/);
  assert.match(await search('quokka'), /^2 of 3/, 'release notes of alpha and beta (gamma has none)');
  assert.match(await search('zed'), /^0 of 3/, 'the author @mention was stripped, so a name does not match release credits');
  assert.match(await search('pull/9'), /^2 of 3/, 'links are kept by default and searchable');
  step('search: commits, release notes, stripped mentions, kept links');

  // ---- options change stored text without any request ----
  Object.assign(calls, {first: 0, after: 0, seq: 0, rel: 0});
  await page.check('#optLinks');
  await until(() => /Applied to the stored release notes of 2 repos/.test(document.querySelector('#optNote').textContent), null, 10000);
  assert.match(await search('pull/9'), /^0 of 3/, 'links stripped from stored notes');
  assert.match(await search('docs'), /^2 of 3/, 'markdown link text survives');
  assert.equal(calls.rel + calls.first + calls.after + calls.seq, 0, 'stripping needs no download');
  await page.uncheck('#optLinks');
  await until(() => /downloaded again/.test(document.querySelector('#optNote').textContent), null, 10000);
  assert.match(await search('pull/9'), /^0 of 3/, 'the stripped text can not come back until it is downloaded again');
  await page.click('#indexHistory');   // the status still shows the previous run's "🔎 … indexed": wait for this job to end
  await page.waitForSelector('#cancelTask', {state: 'hidden', timeout: 60000});
  await waitStatus(/🔎 .*indexed/);
  assert.equal(calls.rel, 2, 'only the release notes of repos that have releases are fetched again');
  assert.equal(calls.first + calls.after + calls.seq, 0, 'and no commits');
  assert.match(await search('pull/9'), /^2 of 3/);
  step('toggling links: stripped locally, restored by re-fetching releases only');

  // ---- "no limit" values ----
  await page.selectOption('#optCommits', '0');
  await until(() => /ALL commits/.test(document.querySelector('#optNote').textContent), null, 10000);
  await page.selectOption('#optNotes', '0');
  await until(() => /Applied|Saved/.test(document.querySelector('#optNote').textContent), null, 10000);
  assert.match(await page.textContent('#histOptsSummary'), /@mentions stripped/);
  assert.match(await search('zebra crash'), /^1 of 3/, 'changing a cap never loses what is stored');
  step('dropdowns offer ALL commits and entire release notes');

  // ---- reload: state comes back from the shards, panel state is remembered ----
  await page.fill('#q', '');
  await page.reload();
  // "N stars" shows as soon as the star list is read, before the commit index is; the check that follows the load means
  // everything was read.
  await waitStatus(/all checked/);
  assert.equal(await page.isVisible('#histOpts'), true, 'panel stays open');
  assert.deepEqual([await page.inputValue('#optCommits'), await page.inputValue('#optNotes')], ['0', '0'], 'the "no limit" choices are remembered');
  await page.check('#inHistory');
  assert.match(await search('zebra crash'), /^1 of 3/);
  assert.match(await page.textContent('#cntHistory'), /3/);
  step('after a reload everything comes back from the cache', (await page.textContent('#cntHistory')).trim());

  // ---- "Keep cache": on (cookie) → clear everything → off → default off ----
  assert.equal(await page.isChecked('#browserCache'), true, 'the cookie said on');
  assert.match(await page.textContent('#cacheLabel'), /on disk/);
  await page.click('#clearCache');   // first click only arms the button
  assert.match(await page.textContent('#clearCache'), /Click again/);
  assert.equal(wiped, 0, 'nothing is deleted by one click');
  await page.click('#clearCache');
  await waitStatus(/Cleared everything/);
  assert.equal(wiped, 1);
  assert.equal(Object.keys(store).length, 0, 'the server side cache is empty');
  assert.match(await count(), /^0 of 0/, 'and so is the list');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('starsViewer.')).length), 0, 'preferences are gone');
  assert.equal(await page.inputValue('#token'), '', 'and the token');
  assert.equal(await cookie(), '1', 'the toggle itself stays as it was');
  step('Clear cache erases the stored data, the list, the preferences and the token (after two clicks)');

  await page.uncheck('#browserCache');
  await waitStatus(/Cache off/);
  assert.equal(await cookie(), '0', 'off is remembered too');
  puts = [];
  await page.reload();
  await waitStatus(/\d+ stars/);
  assert.equal(await page.isChecked('#browserCache'), false);
  assert.equal(puts.length, 0, 'with the cache off nothing is written');
  step('off: remembered across a reload, and nothing is stored');

  await page.check('#browserCache');   // nothing stored for this profile: this tab's data is saved
  await waitStatus(/Cache on: everything fetched so far was saved/);
  assert.ok(puts.includes('stars:e2etest'));
  assert.equal(await cookie(), '1');
  await context.clearCookies();
  await page.reload();
  await waitStatus(/\d+ stars|No cache/);
  assert.equal(await page.isChecked('#browserCache'), false, 'without a cookie it is off by default');
  step('on again saves the tab; without a cookie it is off by default');

  assert.deepEqual(errors, [], 'no page errors');
  step('no console or page errors');
  console.log('\nE2E passed');
} catch (e) {
  console.error('\nE2E FAILED:', e.message, '\nlast status:', await status().catch(() => '?'));
  await page.screenshot({path: 'e2e-failure.png'}).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  rmSync(dataDir, {recursive: true, force: true});
}
