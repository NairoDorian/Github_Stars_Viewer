// File paths, packed. A repo's file list is every path of its tree; kept as one JS string per path, the lists of a big
// star collection (millions of paths) take over a gigabyte in the tab. File trees repeat their folders endlessly, so a
// list is stored as two texts instead, losing nothing:
//   d   every folder that holds files, one per line ('' is the root), in the order the folders first appear
//   f   one line per folder (the same order): the names of its files, separated by '/' (a name never contains one)
// {d: "\nsrc\nsrc/drv", f: "README.md/Makefile\nmain.c\nspi.c/i2c.c"} is README.md, Makefile, src/main.c, src/drv/spi.c
// and src/drv/i2c.c. That is about 40 % of the characters, two strings per repo instead of thousands, and JSON that
// parses in a fraction of the time. Git allows a line break inside a file name; it is stored as NUL (which git forbids
// in names), so a line break in the texts is always a separator.
//
// Pure functions: no state, no requests. files.js stores and loads the packed lists; list.js searches them.

const NL = '\n', NUL = '\0';
const enc = s => s.includes(NL) ? s.replaceAll(NL, NUL) : s;
const dec = s => s.includes(NUL) ? s.replaceAll(NUL, NL) : s;

/** An empty list. */
export const EMPTY = Object.freeze({d: '', f: ''});

/** Paths (any order) → {d, f}. Files keep their order within a folder; folders are in order of first appearance. */
export function packPaths(paths) {
  const groups = new Map();
  let lastDir = null, lastList = null;
  for (const p of paths) {
    const k = p.lastIndexOf('/'), dir = k < 0 ? '' : p.slice(0, k);
    if (dir !== lastDir) {   // a tree lists a folder's files together: the common case is the same folder again
      lastList = groups.get(dir);
      if (!lastList) groups.set(dir, lastList = []);
      lastDir = dir;
    }
    lastList.push(k < 0 ? p : p.slice(k + 1));
  }
  const d = [], f = [];
  for (const [dir, names] of groups) { d.push(enc(dir)); f.push(enc(names.join('/'))); }
  return {d: d.join(NL), f: f.join(NL)};
}

/** {d, f} → every path, folder by folder. */
export function unpackPaths(packed) {
  if (!packed?.f) return [];
  const dirs = packed.d.split(NL), lines = packed.f.split(NL), out = [];
  for (let i = 0; i < lines.length; i++) {
    const dir = dec(dirs[i] ?? ''), pre = dir ? dir + '/' : '';
    for (const name of lines[i].split('/')) out.push(pre + dec(name));
  }
  return out;
}

/** How many paths a packed list holds, without unpacking it. */
export function countPaths(packed) {
  const f = packed?.f;
  if (!f) return 0;
  let n = 1;
  for (let i = 0; i < f.length; i++) { const c = f.charCodeAt(i); if (c === 47 || c === 10) n++; }
  return n;
}

/** Calls fn(folder, names[]) for every folder of a packed list, in stored order (names and folder as stored: use
 *  `realName` for one that may hold a line break). */
export function eachFolder(packed, fn) {
  if (!packed?.f) return;
  const dirs = packed.d.split(NL), lines = packed.f.split(NL);
  for (let i = 0; i < lines.length; i++) fn(dirs[i] ?? '', lines[i].split('/'));
}
/** A stored folder or file name as git has it (a line break back in place). */
export const realName = dec;

// ---- searching ----
// A search is case-insensitive: it runs on a lower-cased copy of the two texts, built once per list. Lower-casing never
// adds or removes a line break or a slash, so "line 12, name 3" means the same file in the copy and in the original
// (character positions may differ: a few letters change length when lower-cased).
const lowered = new WeakMap();
/** The lower-cased copy of a packed list (kept as long as the list itself). */
export function lowerPack(packed) {
  let low = lowered.get(packed);
  if (!low) lowered.set(packed, low = {d: packed.d.toLowerCase(), f: packed.f.toLowerCase()});
  return low;
}

/** Which line of `text` holds position `pos`: counts the line breaks before it, a jump per line (not per character). */
function lineOf(text, pos) {
  let n = 0;
  for (let i = text.indexOf(NL); i >= 0 && i < pos; i = text.indexOf(NL, i + 1)) n++;
  return n;
}
/** [start, end) of line `n` of `text`. */
function lineSpan(text, n) {
  let start = 0;
  for (let k = 0; k < n; k++) { start = text.indexOf(NL, start) + 1; if (!start) return [text.length, text.length]; }
  const end = text.indexOf(NL, start);
  return [start, end < 0 ? text.length : end];
}

/**
 * The first file whose path contains `term`, as {di, ni}: folder number and the file's number in that folder; null when
 * none does. `low` is a lower-cased list (lowerPack) and `term` lower-cased text without a line break. A path is
 * "folder/name", so a term is found in one of three places:
 *   · inside a name (a term without a slash);
 *   · inside a folder's path: every file of that folder then matches, the first one stands for them;
 *   · across the last slash of a path: the folder ends with what the term has before its last slash, and a name starts
 *     with what comes after it ("drv/spi" in "src/drv" + "spi.c"; "gerber/" is any file of a folder ending in "gerber").
 */
export function findPath(low, term) {
  if (!low?.f || !term) return null;
  const cut = term.lastIndexOf('/');
  if (cut < 0) {
    const i = low.f.indexOf(term);
    if (i >= 0) {
      const di = lineOf(low.f, i), start = di ? low.f.lastIndexOf(NL, i) + 1 : 0;
      let ni = 0;
      for (let k = low.f.indexOf('/', start); k >= 0 && k < i; k = low.f.indexOf('/', k + 1)) ni++;
      return {di, ni};
    }
    const j = low.d.indexOf(term);
    return j < 0 ? null : {di: lineOf(low.d, j), ni: 0};
  }
  const d = low.d, f = low.f, j = d.indexOf(term);
  if (j >= 0) return {di: lineOf(d, j), ni: 0};   // wholly inside a folder's path ("src/drv" in "app/src/drv/old")
  // Across the last slash: a folder that ends with `head`, holding a name that starts with `tail`.
  const head = term.slice(0, cut), tail = term.slice(cut + 1);
  /** The number of the first name that starts with `tail` in the names line f[a, b), or -1. */
  const nameIn = (a, b) => {
    if (!tail || f.startsWith(tail, a)) return 0;
    const k = f.indexOf('/' + tail, a);
    if (k < 0 || k >= b) return -1;
    let ni = 1;
    for (let x = f.indexOf('/', a); x >= 0 && x < k; x = f.indexOf('/', x + 1)) ni++;
    return ni;
  };
  if (!head) {   // "/name": a file that is not at the root. The two texts are walked line by line, side by side.
    for (let di = 0, ds = 0, fs = 0; ; di++) {
      const de = d.indexOf(NL, ds), fe = f.indexOf(NL, fs);
      if ((de < 0 ? d.length : de) > ds) { const ni = nameIn(fs, fe < 0 ? f.length : fe); if (ni >= 0) return {di, ni}; }
      if (de < 0 || fe < 0) return null;
      ds = de + 1; fs = fe + 1;
    }
  }
  for (let i = d.indexOf(head); i >= 0; i = d.indexOf(head, i + 1)) {
    const after = i + head.length;
    if (after !== d.length && d.charCodeAt(after) !== 10) continue;   // the folder must END with it
    const di = lineOf(d, i), [a, b] = lineSpan(f, di), ni = nameIn(a, b);
    if (ni >= 0) return {di, ni};
  }
  return null;
}

/** The path of file {di, ni} of a packed list, as git has it. */
export function pathAt(packed, {di, ni}) {
  const [da, db] = lineSpan(packed.d, di), [fa, fb] = lineSpan(packed.f, di);
  let a = fa;
  for (let k = 0; k < ni; k++) { const x = packed.f.indexOf('/', a); if (x < 0 || x >= fb) return null; a = x + 1; }
  const x = packed.f.indexOf('/', a), b = x < 0 || x > fb ? fb : x, dir = dec(packed.d.slice(da, db));
  return (dir ? dir + '/' : '') + dec(packed.f.slice(a, b));
}

/** The first path of a packed list containing `term` (any case), as git has it, or null. */
export function searchPaths(packed, term) {
  const hit = findPath(lowerPack(packed), term.toLowerCase());
  return hit ? pathAt(packed, hit) : null;
}
