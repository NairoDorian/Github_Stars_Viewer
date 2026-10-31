// The deploy stamps a version on every file URL, so a browser never mixes files of two deploys. Stamp a copy of public/ and
// check that every import and the page's own links carry it, and that each stamped import still names a file that exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const {stamp} = createRequire(import.meta.url)('./stamp.cjs');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('stamping gives every import and the page links the deploy version, and leaves nothing unstamped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  try {
    cpSync(join(root, 'public'), dir, {recursive: true});
    stamp(dir, 'abc1234');
    let imports = 0;
    for (const name of readdirSync(join(dir, 'js')).filter(f => f.endsWith('.js'))) {
      const src = readFileSync(join(dir, 'js', name), 'utf8');
      for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\/[^'"]+)\1/g)) {
        imports++;
        assert.match(m[2], /^\.\/[\w-]+\.js\?v=abc1234$/, `${name}: ${m[2]}`);
        assert.ok(existsSync(join(dir, 'js', m[2].split('?')[0])), `${name} imports a missing file: ${m[2]}`);
      }
    }
    assert.ok(imports > 30, 'the modules do import each other: ' + imports);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(html, /href="app\.css\?v=abc1234"/);
    assert.match(html, /src="js\/main\.js\?v=abc1234"/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
