// Tests for the progress panel (progress.js): the steps shown as lanes, percentages, time left and the final states.
import test from 'node:test';
import assert from 'node:assert/strict';

const el = {hidden: true, innerHTML: ''};
Object.defineProperty(globalThis, 'document', {value: {querySelector: sel => sel === '#lanes' ? el : {textContent: '', innerHTML: '', hidden: false}}, configurable: true});   // other elements (status line, activity log) are not the lanes
const {plan, start, report, finish, stopAll, reset, settle, duration, eta} = await import('../public/js/progress.js');
const later = () => new Promise(r => setTimeout(r, 120));   // the panel redraws at most every 60 ms
const rows = () => [...el.innerHTML.matchAll(/<div class="lane (\w+)" data-lane="(\w+)">(.*?)<\/div>/g)].map(m => ({state: m[1], id: m[2], html: m[3]}));
const text = html => html.match(/<span class="lane-text">(.*?)<\/span>/)[1];

test('duration() and eta() read well and only guess when there is something to base a guess on', () => {
  assert.equal(duration(4), '4s');
  assert.equal(duration(75), '1m 15s');
  assert.equal(duration(605), '10m 05s');
  assert.equal(duration(4020), '1h 07m');
  const lane = (done, total, t0 = 0, state = 'running') => ({state, done, total, t0});
  assert.equal(eta(lane(25, 100), 50_000), '~2m 30s left', '25% in 50 s: 150 s to go');
  assert.equal(eta(lane(0, 100), 50_000), '', 'nothing done yet: no guess');
  assert.equal(eta(lane(25, 100), 1_000), '', 'too early to tell');
  assert.equal(eta(lane(100, 100), 50_000), '', 'nothing left');
  assert.equal(eta(lane(25, 0), 50_000), '', 'unknown total');
  assert.equal(eta(lane(25, 100, 0, 'done'), 50_000), '', 'only running steps have a time left');
  assert.equal(eta(lane(12.5, 100), 25_000), '~2m 55s left', 'fractional progress (weighted by commits) works');
});

test('the steps are announced as waiting, then run, report progress and finish', async () => {
  plan([['stars'], ['details'], ['commits', 'My own label']]);
  await later();
  assert.equal(el.hidden, false);
  assert.deepEqual(rows().map(r => [r.id, r.state]), [['stars', 'waiting'], ['details', 'waiting'], ['commits', 'waiting']]);
  assert.match(rows()[0].html, /Pull the star list/, 'a default name');
  assert.match(rows()[2].html, /My own label/, 'or the caller\'s');
  assert.equal(text(rows()[0].html), 'waiting');

  start('stars');   // no total yet: an animated bar without a value
  await later();
  assert.equal(rows()[0].state, 'running');
  assert.doesNotMatch(rows()[0].html, /<progress value=/);

  report('stars', 3, 12, 'page 3 of 12');
  await later();
  assert.match(text(rows()[0].html), /^25% · page 3 of 12 · elapsed \d+s/);
  assert.match(rows()[0].html, /<progress value="3" max="12"/);
  assert.equal(rows()[1].state, 'waiting', 'the later steps still wait');

  finish('stars', '12 pages');
  report('details', 1, 4, '1 of 4 repos');   // reporting wakes a waiting step up
  await later();
  assert.equal(rows()[0].state, 'done');
  assert.match(text(rows()[0].html), /^100% · 12 pages/);
  assert.equal(rows()[1].state, 'running');
});

test('when the job ends, running steps are done (or stopped by Cancel) and steps that never ran disappear; reset hides the panel', async () => {
  plan([['stars'], ['details'], ['commits']]);
  start('stars', 2); report('stars', 2, 2); finish('stars');
  start('details', 10); report('details', 4, 10, '4 of 10 repos');
  stopAll(true);   // Cancel was clicked
  await later();
  assert.deepEqual(rows().map(r => [r.id, r.state]), [['stars', 'done'], ['details', 'stopped']], 'the waiting step is gone');
  assert.match(text(rows()[1].html), /stopped, progress saved/);

  stopAll(false);
  reset();
  await later();
  assert.equal(el.hidden, true);
  assert.equal(rows().length, 0);

  settle(10);   // hides itself after a moment
  start('stars', 1);
  await later();
  assert.equal(el.hidden, false);
  settle(30);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(el.hidden, true);
});

test('texts are escaped', async () => {
  plan([['x', '<b>label</b>']]);
  start('x', 1, '<i>label</i>');
  report('x', 0, 1, '<script>alert(1)</script>');
  await later();
  assert.doesNotMatch(el.innerHTML, /<script>|<i>label|<b>label<\/b>/);
  reset();
});
