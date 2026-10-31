/* The activity log: a running, timestamped account of everything the app does (every request with the exact link it visits and
   what it asks for, the answer and the rate-limit budget left, cache reads and writes, what a sync decided about each repo,
   what you clicked and which links you followed), shown beside the progress bars.

   Every module calls debug / info / warn / error(area, text). Entries live in a ring buffer (the last LOG.capacity), so a
   long index run can't eat memory. Each line has its time to the millisecond and the gap since the previous line, so slow
   steps stand out. The panel (index.html #console) is redrawn at most every 100 ms, shows the last 600 lines that pass the
   "detail" switch, follows the end unless you scroll up, and can copy or save the whole buffer as text.
   Tokens are never logged: callers describe requests by method, link and answer only.

   No imports on purpose: every module may use this one, and it must work without a page (the unit tests). */
const LEVELS = {debug: 0, info: 1, warn: 2, error: 3};
/** capacity: lines kept. devtools: also write to the browser's DevTools console (main.js turns it on). */
export const LOG = {capacity: 20000, devtools: false, visible: 600};

const buf = [];
let trimmed = 0, timer = null, seq = 0;
const ui = {debug: true, follow: true, collapsed: false};

/** A number for each request, so the line that sends it and the line that gets its answer can be matched when many run at once. */
export const reqId = () => ++seq;

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** 14:05:09.042 */
export const stamp = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
/** The gap since the previous line: +12ms, +1.4s, +2m05s. */
export const gap = ms => ms == null ? '' : ms < 1000 ? `+${ms}ms` : ms < 60_000 ? `+${(ms / 1000).toFixed(1)}s` : `+${Math.floor(ms / 60_000)}m${pad(Math.floor(ms / 1000) % 60)}s`;
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** 12 345 678 → "11.8 MB" */
export const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
/** Several names → "a, b, c and 7 more". */
export const names = (list, max = 6) => list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`;

export function log(area, text, level = 'info') {
  const t = Date.now();
  buf.push({t, gap: buf.length ? t - buf.at(-1).t : null, level, area, text: String(text)});
  if (buf.length > LOG.capacity + 1000) { buf.splice(0, 1000); trimmed += 1000; }   // trimmed in chunks: cheaper than one splice per line
  if (LOG.devtools) console[level === 'debug' ? 'debug' : level](`[stars ${area}] ${text}`);
  if (!timer) { timer = setTimeout(() => { timer = null; render(); }, 100); timer.unref?.(); }
}
export const debug = (area, text) => log(area, text, 'debug');
export const info = (area, text) => log(area, text, 'info');
export const warn = (area, text) => log(area, text, 'warn');
export const error = (area, text) => log(area, text, 'error');

/** The kept entries, oldest first. */
export const entries = () => buf.slice();
/** The whole log as plain text, one line per entry (what Copy and Save give): time, gap, level, area, text. */
export const text = () => buf.map(e => `${stamp(e.t)} ${gap(e.gap).padStart(7)} ${e.level.toUpperCase().padEnd(5)} [${e.area}] ${e.text}`).join('\n') + '\n';
export function clearLog() { buf.length = 0; trimmed = 0; render(); }

// ---------- what you do: clicks, links, switches ----------
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
/** What a clicked thing says: its text, else its label. */
const labelOf = n => clean(n.textContent || n.getAttribute?.('aria-label') || n.title || n.id).slice(0, 70);
/** Which part of the page an element is in, in words. */
const areaOf = n => n.closest?.('.repo-viewers') ? 'repo viewer links' : n.closest?.('#usersPanel') ? 'Users panel' : n.closest?.('.card') ? 'repo card'
  : n.closest?.('#visitBanner') ? 'visit banner' : n.closest?.('#tokenPanel') ? 'token panel' : n.closest?.('#insights') ? 'Discover panel'
  : n.closest?.('#facets') ? 'filters' : n.closest?.('header') ? 'top bar' : n.closest?.('.bar') ? 'toolbar' : 'page';

/** [area, text] describing a click on a link or a button, or null for anything else. Links say exactly where they lead. */
export function clickLine(e) {
  const t = e?.target;
  if (!t?.closest || t.closest('#console')) return null;
  const a = t.closest('a[href]');
  if (a) {
    const newTab = e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey || a.target === '_blank';
    const how = e.defaultPrevented ? 'followed inside the app (the page is not reloaded)' : newTab ? 'opened in a new tab' : 'opened in this tab';
    return ['link', `🔗 ${how}: ${a.href} · “${labelOf(a)}” · in the ${areaOf(a)}`];
  }
  const b = t.closest('button, [role="button"], summary');
  return b ? ['ui', `🖱 clicked “${labelOf(b)}”${b.id ? ' (#' + b.id + ')' : ''} · in the ${areaOf(b)}`] : null;
}
/** [area, text] describing a changed checkbox or drop-down, or null (typing in a box is not logged). */
export function changeLine(e) {
  const t = e?.target;
  if (!t?.closest || t.closest('#console') || !(t.type === 'checkbox' || t.tagName === 'SELECT')) return null;
  const name = clean(t.closest('label')?.textContent || t.getAttribute?.('aria-label') || t.id);
  const value = t.type === 'checkbox' ? (t.checked ? 'ON' : 'OFF') : clean(t.selectedOptions?.[0]?.textContent ?? t.value);
  return ['ui', `⚙ “${name.slice(0, 70)}” → ${value} · in the ${areaOf(t)}`];
}

// ---------- the panel ----------
const el = sel => globalThis.document?.querySelector?.(sel) ?? null;
const PREF = 'starsViewer.console';   // localStorage: {debug, collapsed}

function render() {
  const body = el('#conBody');
  if (!body) return;
  const min = ui.debug ? 0 : 1, shown = [];
  for (let i = buf.length - 1; i >= 0 && shown.length < LOG.visible; i--) if (LEVELS[buf[i].level] >= min) shown.push(buf[i]);
  shown.reverse();
  body.innerHTML = shown.map(e => `<div class="ln ${e.level}"><time>${stamp(e.t)}</time> <i>${gap(e.gap)}</i> <b>${escape(e.area)}</b> ${escape(e.text)}</div>`).join('');
  const count = el('#conCount');
  if (count) count.textContent = `${buf.length.toLocaleString()} lines${trimmed ? ` (${trimmed.toLocaleString()} older ones dropped)` : ''}`;
  if (ui.follow) body.scrollTop = body.scrollHeight;
}

function savePrefs() { try { localStorage.setItem(PREF, JSON.stringify({debug: ui.debug, collapsed: ui.collapsed})); } catch {} }

/** Wires the buttons of the panel and starts logging what you click. Call once at boot. */
export function initLog() {
  try { Object.assign(ui, JSON.parse(localStorage.getItem(PREF) || '{}')); } catch {}
  const doc = globalThis.document;
  const note = f => e => { const line = f(e); if (line) log(line[0], line[1]); };
  doc?.addEventListener?.('click', note(clickLine));      // after the app's own handlers: e.defaultPrevented tells a link the app handled itself
  doc?.addEventListener?.('auxclick', note(clickLine));   // middle click: open in a new tab
  doc?.addEventListener?.('change', note(changeLine));
  const panel = el('#console');
  if (!panel) return;
  const apply = () => {
    panel.classList.toggle('collapsed', ui.collapsed);
    el('#conToggle').setAttribute('aria-expanded', String(!ui.collapsed));
    el('#conToggle').textContent = ui.collapsed ? '▸' : '▾';
    el('#conDebug').checked = ui.debug;
    el('#conFollow').checked = ui.follow;
  };
  apply();
  el('#conToggle').onclick = () => { ui.collapsed = !ui.collapsed; apply(); savePrefs(); };
  el('#conDebug').onchange = e => { ui.debug = e.target.checked; savePrefs(); render(); };
  el('#conFollow').onchange = e => { ui.follow = e.target.checked; render(); };
  el('#conClear').onclick = clearLog;
  el('#conCopy').onclick = async () => {
    const b = el('#conCopy');
    try { await navigator.clipboard.writeText(text()); b.textContent = 'Copied ✓'; } catch { b.textContent = 'Copy failed'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  };
  el('#conSave').onclick = () => {
    const url = URL.createObjectURL(new Blob([text()], {type: 'text/plain;charset=utf-8'}));
    const a = Object.assign(document.createElement('a'), {href: url, download: `stars-viewer-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`});
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  // Scrolling up to read stops the following; scrolling back to the end resumes it.
  el('#conBody').addEventListener('scroll', e => {
    const b = e.target, atEnd = b.scrollHeight - b.scrollTop - b.clientHeight < 8;
    if (atEnd !== ui.follow) { ui.follow = atEnd; el('#conFollow').checked = atEnd; }
  });
  render();
}
