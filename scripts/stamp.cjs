// Used by the GitHub Pages deploy:  node scripts/stamp.cjs <folder> <version>
// Browsers keep every file of a site for up to 10 minutes (GitHub Pages: max-age=600), each on its own clock, so right after a
// deploy a visitor can get a MIX of old and new files (a new main.js with an old list.js: a broken page until the cache is cleared).
// This stamps one version on every file the page loads (?v=<version>): the files of one deploy always belong together, and a new
// deploy changes every URL. The sources stay plain (`./list.js`), so the local server and the tests are untouched.
const {readdirSync, readFileSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');

function stamp(dir, version) {
  const v = '?v=' + version;
  const jsDir = join(dir, 'js');
  for (const name of readdirSync(jsDir).filter(f => f.endsWith('.js'))) {
    const file = join(jsDir, name);
    const src = readFileSync(file, 'utf8');
    writeFileSync(file, src.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\/[\w-]+\.js)\2/g, `$1$2$3${v}$2`));
  }
  const page = join(dir, 'index.html');
  const html = readFileSync(page, 'utf8')
    .replace(/(<link rel="stylesheet" href=")(app\.css)(")/, `$1$2${v}$3`)
    .replace(/(<script type="module" src=")(js\/main\.js)(")/, `$1$2${v}$3`);
  writeFileSync(page, html);
}

if (require.main === module) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !/^[\w.-]+$/.test(version || '')) { console.error('usage: node scripts/stamp.cjs <folder> <version>'); process.exit(1); }
  stamp(dir, version);
  console.log(`stamped ${dir} with ?v=${version}`);
}
module.exports = {stamp};
