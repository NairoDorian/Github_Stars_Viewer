// Stars Viewer local server (no dependencies).
//   • serves the app from ./public
//   • stores the cache as JSON files in ./data   (GET/PUT /cache/<key>)
// Run:  node server.js [--open]      then open http://localhost:8787   (PORT env var to change the port)
const http = require('http'), fs = require('fs'), fsp = fs.promises, path = require('path'), {exec} = require('child_process');

const PORT = Number(process.env.PORT) || 8787;
const ROOT = __dirname, PUBLIC = path.join(ROOT, 'public'), DATA = path.join(ROOT, 'data');
const URL_ = `http://localhost:${PORT}`;
const MAX_BODY = 200 * 1024 * 1024;   // largest cache file accepted (the README cache is ~10-20 MB)
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'};
fs.mkdirSync(DATA, {recursive: true});

// Cache keys look like "stars:nairodorian"; they map to files like data/stars_nairodorian.json.
const KEY = /^[\w.:-]{1,120}$/;
const dataFile = key => path.join(DATA, key.replace(/[^\w.-]/g, '_') + '.json');

// Only this app may talk to the server. The Host check blocks "DNS rebinding" (a web page re-pointing its own domain
// to 127.0.0.1 to read your token); the Origin check blocks other sites from writing to the cache.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map(h => 'http://' + h));
const trusted = req => ALLOWED_HOSTS.has(req.headers.host) && (!req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin));

// Writes to the same file are queued; each goes to a temp file that is then renamed over the old one,
// so a crash or overlapping saves never leave a half-written or corrupted cache file.
const queues = new Map();
function save(file, buf) {
  const next = (queues.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    JSON.parse(buf);   // refuse to store invalid JSON
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, buf);
    for (let i = 0; ; i++) {   // Windows may briefly lock a file that's being read (EPERM/EBUSY): retry
      try { return await fsp.rename(tmp, file); }
      catch (e) {
        if (i >= 10) { await fsp.rm(tmp, {force: true}); throw e; }
        await new Promise(r => setTimeout(r, 50 * (i + 1)));
      }
    }
  });
  queues.set(file, next);
  next.finally(() => { if (queues.get(file) === next) queues.delete(file); }).catch(() => {});
  return next;
}

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

  if (url.pathname.startsWith('/cache/')) {
    const key = decodeURIComponent(url.pathname.slice(7));
    if (!KEY.test(key)) return send(res, 400, 'bad key');
    const file = dataFile(key);
    if (req.method === 'GET') {
      await queues.get(file)?.catch(() => {});   // never read while a write is pending
      const d = await fsp.readFile(file).catch(() => null);
      return d ? send(res, 200, d, 'application/json') : send(res, 404, 'null', 'application/json');
    }
    if (req.method === 'PUT') { await save(file, await readBody(req)); return send(res, 204); }
    return send(res, 405, 'method not allowed', undefined, {Allow: 'GET, PUT'});
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  // Static files from ./public (path traversal outside it is impossible: resolved path must stay inside PUBLIC).
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found');
  const d = await fsp.readFile(file).catch(() => null);
  if (!d) return send(res, 404, 'not found');
  send(res, 200, d, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
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
