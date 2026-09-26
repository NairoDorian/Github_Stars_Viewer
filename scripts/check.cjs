// Syntax-check both module files and the CommonJS local server on Windows, macOS and Linux.
const {readdirSync, readFileSync} = require('node:fs');
const {join} = require('node:path');
const {spawnSync} = require('node:child_process');

const root = join(__dirname, '..');
const modules = readdirSync(join(root, 'public', 'js')).filter(name => name.endsWith('.js'));
const files = [['server.js', ['--check', join(root, 'server.js')], null],
  ...modules.map(name => {
    const file = join(root, 'public', 'js', name);
    return [`public/js/${name}`, ['--input-type=module', '--check'], readFileSync(file)];
  })];

for (const [label, args, input] of files) {
  const result = spawnSync(process.execPath, args, {input, encoding: 'utf8'});
  if (result.status !== 0) {
    process.stderr.write(`${label}: ${result.stderr || result.error?.message || 'syntax check failed'}\n`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`Syntax OK: ${files.length} files`);
