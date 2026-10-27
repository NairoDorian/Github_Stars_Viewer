// Stars Viewer local server (no dependencies).
//   • serves the app from ./public
//   • stores the cache as JSON files in ./data   (GET/PUT /cache/<key>; big files gzip-compressed, writes are atomic)
//   • only answers this app: Host / Origin / Sec-Fetch-Site checks keep other web pages from reading your cached token
// Run:  node server.js [--open]      then open http://localhost:8787   (PORT env var to change the port, STARS_DATA the data folder)
const http = require('http'), fs = require('fs'), fsp = fs.promises, path = require('path'), zlib = require('zlib'), {exec} = require('child_process');
const {promisify} = require('util'), gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);

// Cache files of 64 KB or more are stored gzip-compressed (JSON text shrinks ~3-4x). The file keeps its .json name; a
// read checks for the gzip signature, so plain files written by older versions still load.
const GZIP_MIN = 64 * 1024;
const readCache = async file => {
  const d = await fsp.readFile(file);
  return d[0] === 0x1f && d[1] === 0x8b ? gunzip(d) : d;
};

const PORT = Number(process.env.PORT) || 8787;
const ROOT = __dirname, PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.STARS_DATA ? path.resolve(process.env.STARS_DATA) : path.join(ROOT, 'data');   // STARS_DATA: tests use a temp folder
const URL_ = `http://localhost:${PORT}`;
const MAX_BODY = 1024 * 1024 * 1024;   // largest cache file accepted (READMEs ~10-20 MB; commit messages and release notes can reach a few hundred MB)
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'};
fs.mkdirSync(DATA, {recursive: true});

// Cache keys look like "stars:nairodorian"; they map to files like data/stars_nairodorian.json.
const KEY = /^[\w.:-]{1,120}$/;
const dataFile = key => path.join(DATA, key.replace(/[^\w.-]/g, '_') + '.json');

// Only this app may talk to the server. The Host check blocks "DNS rebinding" (a web page re-pointing its own domain
// to 127.0.0.1 to read your token); Origin and Sec-Fetch-Site block other sites from reading or writing the cache.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map(h => 'http://' + h));
const ALLOWED_SITES = new Set(['same-origin', 'none']);
const trusted = req => ALLOWED_HOSTS.has(req.headers.host) &&
  (!req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin)) &&
  (!req.headers['sec-fetch-site'] || ALLOWED_SITES.has(req.headers['sec-fetch-site']));

// Writes to the same file are queued and coalesced; each goes to a temp file that is then renamed over the old one,
// so a crash or overlapping saves never leave a half-written or corrupted cache file.
const queues = new Map(), pendingBuf = new Map();
function save(file, buf) {
  JSON.parse(buf);   // refuse to store invalid JSON
  const hadPending = pendingBuf.has(file);
  pendingBuf.set(file, buf);
  if (hadPending) return queues.get(file);
  const next = (queues.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    while (pendingBuf.has(file)) {
      const data = pendingBuf.get(file);
      pendingBuf.delete(file);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, data.length >= GZIP_MIN ? await gzip(data) : data);
      for (let i = 0; ; i++) {   // Windows may briefly lock a file that's being read (EPERM/EBUSY): retry
        try { await fsp.rename(tmp, file); break; }
        catch (e) {
          if (i >= 10) { await fsp.rm(tmp, {force: true}); throw e; }
          await new Promise(r => setTimeout(r, 50 * (i + 1)));
        }
      }
    }
  });
  queues.set(file, next);
  next.finally(() => { if (queues.get(file) === next && !pendingBuf.has(file)) queues.delete(file); }).catch(() => {});
  return next;
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

function send(res, code, body = '', type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra});
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
      const d = await readCache(file).catch(() => null);
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
  if (!res.headersSent) send(res, e.code === 413 ? 413 : 500, e.message);
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
