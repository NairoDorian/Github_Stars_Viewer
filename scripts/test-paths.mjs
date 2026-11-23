// Tests for the packed form of file lists (paths.js): nothing is lost, and searching the packed texts finds exactly what
// searching the plain list of paths finds (checked against that plain search on thousands of random trees and terms).
import test from 'node:test';
import assert from 'node:assert/strict';

const {packPaths, unpackPaths, countPaths, eachFolder, findPath, lowerPack, pathAt, searchPaths, EMPTY} = await import('../public/js/paths.js');

/** A small deterministic random generator (mulberry32), so a failure can be reproduced. */
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

test('packing loses nothing: every path comes back, whatever its name', () => {
  const paths = ['README.md', 'Makefile', 'src/main.c', 'src/drv/spi.c', 'src/drv/i2c.c', 'src/util.c', 'docs/Schéma élec.pdf', 'a b/c d.txt',
    'weird/line\nbreak.txt', 'dir\nwith break/x', '.gitignore', 'deep/a/b/c/d/e/f.g', 'İstanbul/Büyük.TXT', 'src/main.c.bak', '日本語/ファイル.md', 'x/.hidden/.env'];
  const packed = packPaths(paths);
  assert.deepEqual(Object.keys(packed), ['d', 'f']);
  assert.deepEqual([...unpackPaths(packed)].sort(), [...paths].sort());
  assert.equal(countPaths(packed), paths.length);
  assert.equal(JSON.stringify(unpackPaths(JSON.parse(JSON.stringify(packed)))), JSON.stringify(unpackPaths(packed)), 'the packed form survives being stored as JSON');
  // files of one folder stay together and in order, folders in order of first appearance
  assert.deepEqual(unpackPaths(packPaths(['b/2', 'a/1', 'b/1', 'root', 'a/2'])), ['b/2', 'b/1', 'a/1', 'a/2', 'root']);
  // nothing, and one file
  assert.deepEqual(packPaths([]), {d: '', f: ''});
  assert.deepEqual([unpackPaths(packPaths([])), unpackPaths(EMPTY), unpackPaths(null), countPaths(EMPTY), countPaths(null)], [[], [], [], 0, 0]);
  assert.deepEqual([unpackPaths(packPaths(['only'])), countPaths(packPaths(['only'])), countPaths(packPaths(['a/b']))], [['only'], 1, 1]);
  // the same text, far fewer characters once folders repeat
  const tree = Array.from({length: 400}, (_, i) => `components/display/drivers/st7789/src/file_${i}.c`);
  const p = packPaths(tree);
  assert.ok(p.d.length + p.f.length < tree.join('\n').length / 3, 'a folder is stored once, not once per file');
  const seen = [];
  eachFolder(packPaths(['a/x', 'a/y', 'z']), (dir, names) => seen.push([dir, names]));
  assert.deepEqual(seen, [['a', ['x', 'y']], ['', ['z']]]);
});

test('searching a packed list: in a name, in a folder, across the slash between them, any case', () => {
  const paths = ['README.md', 'hardware/Main.kicad_pcb', 'hardware/gerber/top.GTL', 'firmware/src/drv/SPI.c', 'firmware/platformio.ini', 'docs/img/pinout.png'];
  const packed = packPaths(paths), find = t => searchPaths(packed, t);
  assert.equal(find('kicad_pcb'), 'hardware/Main.kicad_pcb', 'inside a name; the path comes back as git has it');
  assert.equal(find('MAIN.KICAD'), 'hardware/Main.kicad_pcb', 'any case');
  assert.equal(find('gerber'), 'hardware/gerber/top.GTL', 'a folder name: its first file stands for it');
  assert.match(find('hardware/'), /^hardware\//, 'a folder with its slash: some file under it');
  assert.equal(find('gerber/'), 'hardware/gerber/top.GTL');
  assert.equal(find('drv/spi'), 'firmware/src/drv/SPI.c', 'across the last slash');
  assert.equal(find('src/drv/spi.c'), 'firmware/src/drv/SPI.c');
  assert.equal(find('firmware/src'), 'firmware/src/drv/SPI.c', 'inside a folder path that holds no file itself');
  assert.equal(find('ware/plat'), 'firmware/platformio.ini');
  assert.equal(find('/pinout'), 'docs/img/pinout.png', 'a leading slash: a file inside some folder');
  assert.equal(find('/readme'), null, 'README.md is at the root: nothing comes before it');
  assert.equal(find('readme'), 'README.md');
  assert.equal(find('img/pinout.png'), 'docs/img/pinout.png');
  for (const miss of ['gerber/main', 'spi/', 'nothing', 'hardware/top', 'drv/src', 'pcb/']) assert.equal(find(miss), null, miss);
  assert.equal(searchPaths(EMPTY, 'a'), null);
  assert.deepEqual(findPath(lowerPack(packed), 'top.gtl'), {di: 2, ni: 0});
  assert.equal(pathAt(packed, {di: 3, ni: 0}), 'firmware/src/drv/SPI.c');
});

test('the packed search finds exactly what a plain search of the paths finds (random trees, random terms)', () => {
  const rand = rng(20261123), pick = list => list[Math.floor(rand() * list.length)];
  const parts = ['a', 'b', 'ab', 'src', 'Src', 'lib', 'x.c', 'x.h', 'main', 'Main.C', 'ger', 'gerber', 'B_a', 'a-b', 'é', 'İ', 'q q', '.d', 'a.b.c'];
  let checked = 0, found = 0;
  for (let round = 0; round < 300; round++) {
    const paths = new Set();
    for (let n = 1 + Math.floor(rand() * 30); n > 0; n--) paths.add(Array.from({length: 1 + Math.floor(rand() * 4)}, () => pick(parts)).join('/'));
    const list = [...paths], packed = packPaths(list), lows = list.map(p => p.toLowerCase());
    assert.deepEqual([...unpackPaths(packed)].sort(), [...list].sort());
    for (let t = 0; t < 40; t++) {
      // a piece of a real path most of the time (so slashes fall everywhere), random text otherwise
      const base = rand() < 0.8 ? pick(list) : Array.from({length: 1 + Math.floor(rand() * 3)}, () => pick(parts)).join(rand() < 0.5 ? '/' : '');
      const a = Math.floor(rand() * base.length), term = (rand() < 0.15 ? '/' : '') + base.slice(a, a + 1 + Math.floor(rand() * (base.length - a))) + (rand() < 0.1 ? '/' : '');
      const low = term.toLowerCase(), expected = lows.some(p => p.includes(low)), got = searchPaths(packed, term);
      assert.equal(got !== null, expected, `term ${JSON.stringify(term)} in ${JSON.stringify(list)} → ${JSON.stringify(got)}`);
      if (got !== null) { assert.ok(list.includes(got), `${got} is one of the paths`); assert.ok(got.toLowerCase().includes(low), `${got} contains ${term}`); found++; }
      checked++;
    }
  }
  assert.ok(checked === 12000 && found > 3000 && found < 11500, `both outcomes are exercised (${found} of ${checked} found)`);
});
