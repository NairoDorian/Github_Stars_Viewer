// Stars Viewer local server (no dependencies).
//   • serves the app from ./public
//   • stores the cache as JSON files in ./data   (GET/PUT /cache/<key>; big files gzip-compressed, writes are atomic)
//   • only answers this app: Host / Origin / Sec-Fetch-Site checks keep other web pages from reading your cached token
// Run:  node server.js [--open]      then open http://localhost:8787   (PORT env var to change the port, STARS_DATA the data folder)
const http = require('http'), fs = require('fs'), fsp = fs.promises, path = require('path'), zlib = require('zlib'), {exec} = require('child_process');
const {promisify} = require('util'), gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const {MAX_STRING_LENGTH} = require('buffer').constants;

// Windows may briefly lock a file that another program (virus scanner, indexer) or a rename is touching: retry those.
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);
const pause = ms => new Promise(r => setTimeout(r, ms));

// Cache files of 64 KB or more are stored gzip-compressed (JSON text shrinks ~3-4x). The file keeps its .json name; a
// read checks for the gzip signature, so plain files written by older versions still load.
// Only a missing file means "nothing stored yet" (null). Any other failure (a damaged file, a file still locked) throws, so
// the app marks the key unreadable instead of building an empty replacement and saving it over the real data.
const GZIP_MIN = 64 * 1024;
async function readCache(file) {
  for (let i = 0; ; i++) {
    try {
      const d = await fsp.readFile(file);
      return d[0] === 0x1f && d[1] === 0x8b ? await gunzip(d) : d;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (i >= 5 || !LOCKED.has(e.code)) throw e;
      await pause(50 * (i + 1));
    }
  }
}

const PORT = Number(process.env.PORT) || 8787;
const ROOT = __dirname, PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.STARS_DATA ? path.resolve(process.env.STARS_DATA) : path.join(ROOT, 'data');   // STARS_DATA: tests use a temp folder
const URL_ = `http://localhost:${PORT}`;
// Largest cache file accepted: a bigger body could not even be read as one string to check it is JSON. In practice the
// READMEs file is ~10-20 MB and commit messages / release notes are split into 256 shards of a few MB each.
const MAX_BODY = MAX_STRING_LENGTH;
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'};
fs.mkdirSync(DATA, {recursive: true});

// Cache keys look like "stars:nairodorian"; they map to files like data/stars_nairodorian.json.
const KEY = /^[\w.:-]{1,120}$/;
const dataFile = key => path.join(DATA, key.replace(/[^\w.-]/g, '_') + '.json');

// Only this app may talk to the server. The Host check blocks "DNS rebinding" (a web page re-pointing its own domain
// to 127.0.0.1 to read your token); Origin and Sec-Fetch-Site block other sites from reading or writing the cache.
// (Browsers leave the port out of Host and Origin when it is the default one, 80.)
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'].map(h => PORT === 80 ? h : `${h}:${PORT}`));
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map(h => 'http://' + h));
const ALLOWED_SITES = new Set(['same-origin', 'none']);
const trusted = req => ALLOWED_HOSTS.has(req.headers.host) &&
  (!req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin)) &&
  (!req.headers['sec-fetch-site'] || ALLOWED_SITES.has(req.headers['sec-fetch-site']));

// Writes to the same file are queued and coalesced; each goes to a temp file that is then renamed over the old one,
// so a crash or overlapping saves never leave a half-written or corrupted cache file.
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data.length >= GZIP_MIN ? await gzip(data) : data);
  for (let i = 0; ; i++) {   // the target may be locked for a moment (see LOCKED): retry
    try { await fsp.rename(tmp, file); return; }
    catch (e) {
      if (i >= 10) { await fsp.rm(tmp, {force: true}); throw e; }
      await pause(50 * (i + 1));
    }
  }
}

// One queued write per file at a time: `waiting` holds the write that hasn't started yet. A request that arrives meanwhile
// replaces its data (only the newest state is worth writing) and joins its waiters. Every write settles exactly the requests
// whose data it carried, so a failed write is never reported as saved, and a failure never reaches an earlier request.
const queues = new Map(), waiting = new Map();
function save(file, buf) {
  try { JSON.parse(buf); }   // refuse to store invalid JSON
  catch { throw Object.assign(new Error('body is not valid JSON'), {code: 400}); }
  return new Promise((resolve, reject) => {
    const job = waiting.get(file);
    if (job) { job.buf = buf; job.waiters.push({resolve, reject}); return; }
    const mine = {buf, waiters: [{resolve, reject}]};
    waiting.set(file, mine);
    const next = (queues.get(file) || Promise.resolve()).then(async () => {
      waiting.delete(file);
      try { await writeAtomic(file, mine.buf); mine.waiters.forEach(w => w.resolve()); }
      catch (e) { mine.waiters.forEach(w => w.reject(e)); }
    });
    queues.set(file, next);
    next.then(() => { if (queues.get(file) === next) queues.delete(file); });
  });
}

/** Resolves when every queued cache write has finished, so a delete can't be undone by a write still in flight. */
const settled = () => Promise.all([...queues.values()].map(p => p.catch(() => {})));

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    if ((size += c.length) > MAX_BODY) throw Object.assign(new Error('body too large'), {code: 413});
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// X-Frame-Options: no other site may show the app in a frame and trick clicks into it (Clear cache, ☆ Star).
function send(res, code, body = '', type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', ...extra});
  res.end(body);
}

async function handle(req, res) {
  if (!trusted(req)) return send(res, 403, 'Forbidden');
  const url = new URL(req.url, URL_);

  // DELETE /cache: forget everything (every cache file in ./data), for the app's "Clear cache" button.
  if (url.pathname === '/cache' || url.pathname === '/cache/') {
    if (req.method !== 'DELETE') return send(res, 405, 'method not allowed', undefined, {Allow: 'DELETE'});
    await settled();
    let deleted = 0;
    for (const f of await fsp.readdir(DATA)) {
      if (/\.json(\.\d+\.\d+\.tmp)?$/.test(f)) { await fsp.rm(path.join(DATA, f), {force: true}); deleted++; }
    }
    return send(res, 200, JSON.stringify({deleted}), 'application/json');
  }

  if (url.pathname.startsWith('/cache/')) {
    let key;
    try { key = decodeURIComponent(url.pathname.slice(7)); } catch { return send(res, 400, 'bad key'); }
    if (!KEY.test(key)) return send(res, 400, 'bad key');
    const file = dataFile(key);
    if (req.method === 'GET') {
      await queues.get(file)?.catch(() => {});   // never read while a write is pending
      const d = await readCache(file);   // a failed read is a 500 (see readCache)
      return send(res, 200, d || 'null', 'application/json');   // a missing key is "no data yet", not an error (a cold load reads ~260 keys)
    }
    if (req.method === 'PUT') { await save(file, await readBody(req)); return send(res, 204); }
    if (req.method === 'DELETE') { await settled(); await fsp.rm(file, {force: true}); return send(res, 204); }
    return send(res, 405, 'method not allowed', undefined, {Allow: 'GET, PUT, DELETE'});
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  // Static files from ./public (path traversal outside it is impossible: resolved path must stay inside PUBLIC).
  let rel;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return send(res, 400, 'bad path'); }
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found');
  const d = await fsp.readFile(file).catch(() => null);
  if (!d) return send(res, 404, 'not found');
  send(res, 200, req.method === 'HEAD' ? '' : d, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

const openBrowser = () => exec(process.platform === 'win32' ? `start "" "${URL_}"` : process.platform === 'darwin' ? `open ${URL_}` : `xdg-open ${URL_}`);

http.createServer((req, res) => handle(req, res).catch(e => {
  console.error(req.method, req.url, e.message);
  if (!res.headersSent) send(res, e.code === 413 || e.code === 400 ? e.code : 500, e.message);
  else res.end();
})).on('error', e => {
  if (e.code === 'EADDRINUSE') {   // most likely the app is already running: just open it
    console.log(`Port ${PORT} is already in use: Stars Viewer is probably already running at ${URL_}`);
    if (process.argv.includes('--open')) openBrowser();
    process.exit(0);
  }
  throw e;
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Stars Viewer running at ${URL_}  (cache: ${DATA})\nKeep this window open while using the app; close it to stop.`);
  if (process.argv.includes('--open')) openBrowser();
});
