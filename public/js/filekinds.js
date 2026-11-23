// What a repo's file names say about it: hardware design files, 3D models, firmware build systems, notebooks… Pure
// functions over a file list (no state, no requests), shared by files.js (which fetches and stores the lists) and list.js
// (cards, the "File kinds" filters, has: / ext: / build: search and the file-based sort orders). The rules follow the
// file-tree analysis of the SLAB github_links tool (slab_stars.py, phase "trees").
//
// OWN files and BUNDLED files are told apart. A firmware repo usually carries other people's code: an SDK, libraries,
// managed components, node_modules. Their datasheets, example schematics and model files say nothing about the repo
// itself, so the kinds count the repo's own files only; what the bundled folders hold is counted beside them (bk).
import {packPaths, eachFolder, realName} from './paths.js';

/** Bump when the rules change: stored summaries of an older version are computed again from their paths (files.js
 *  upgradeSummaries). 2: own / bundled files, EDA libraries and prebuilt firmware as kinds, "sch" only as a word in a
 *  schematic PDF's name, every extension kept (x). */
export const KINDS_VERSION = 2;

/** The kinds a file can be, in the order they are tried (a file counts once, for the first kind that matches).
 *  [key, icon, label, what it covers] */
export const KINDS = [
  ['pcb', '🔌', 'PCB & schematic sources', 'boards, schematics and projects: KiCad, Altium, EasyEDA, Eagle, OrCAD / .sch, Fritzing, LibrePCB, gEDA'],
  ['edalib', '🧩', 'EDA libraries', 'symbol and footprint libraries: KiCad .kicad_sym / .kicad_mod, Altium, Eagle .lbr, EasyEDA, OrCAD, Fritzing parts'],
  ['gerber', '🏭', 'Gerbers & fabrication', 'Gerber and drill files, BOM, pick-and-place'],
  ['schematic', '📐', 'Schematic PDFs & pinouts', 'schematic and PCB PDFs, pinout diagrams'],
  ['datasheet', '📄', 'Datasheets', 'datasheets, reference manuals, application notes (PDF)'],
  ['cad', '🧊', '3D CAD models', 'STEP, IGES, Fusion 360, FreeCAD, OpenSCAD, SolidWorks, Inventor, Onshape exports, VRML'],
  ['mesh', '🖨', '3D meshes & printing', 'STL, 3MF, OBJ, glTF, FBX, Blender, PLY, G-code'],
  ['mech', '📏', '2D drawings & laser cut', 'DXF, DWG'],
  ['ml', '🤖', 'ML model files', 'ONNX, TFLite, safetensors, GGUF, PyTorch, Keras, Core ML'],
  ['notebook', '📓', 'Notebooks', 'Jupyter notebooks'],
  ['game', '🎮', 'Game projects', 'Unity, Godot, Unreal'],
  ['fwbin', '💾', 'Prebuilt firmware', 'ready-to-flash binaries: .uf2, .hex, .elf, and .bin in a firmware project (outside test and build folders)'],
];
const KIND_BY = Object.fromEntries(KINDS.map(k => [k[0], k]));

// ---- the rules ----
// Most kinds are decided by the extension alone (one lookup); a few need the file's name or its folder.
const BY_EXT = new Map();
const exts = (kind, list) => { for (const e of list.split(' ')) BY_EXT.set(e, kind); };
exts('pcb', 'kicad_pcb kicad_sch kicad_pro kicad_wks kicad_dru pcbdoc schdoc prjpcb epro eprj brd sch fzz lppz dsn pcb');
exts('edalib', 'kicad_sym kicad_mod pcblib schlib elibz lbr fzpz fzp olb');
exts('gerber', 'gbr gtl gbl gto gbo gts gbs gko gm1 gtp gbp drl xln g2 g3 g4 g5 g6 g7 g8 g9 g2l g3l g4l g5l g6l g7l g8l g9l');
exts('cad', 'step stp iges igs f3d f3z fcstd scad sldprt sldasm slddrw ipt iam x_t x_b wrl 3dm skp catpart catproduct prt');
exts('mesh', 'stl 3mf obj glb gltf fbx blend dae ply usdz usd 3ds gcode amf');
exts('mech', 'dxf dwg');
exts('ml', 'onnx tflite safetensors gguf ggml pt pth ckpt h5 keras mlmodel mlpackage pb engine');
exts('notebook', 'ipynb');
exts('game', 'unity uproject uasset tscn godot');
const BOM_EXT = new Set(['csv', 'xlsx', 'xls', 'ods', 'html', 'htm', 'tsv']), CPL_EXT = new Set(['csv', 'xlsx', 'xls']);
const IMG_EXT = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp']), FW_EXT = new Set(['uf2', 'hex', 'elf', 'bin']);
// On a file's lower-cased name:
const BOM = /\bbom\b|_bom|bom_|-bom|bom-|bill.?of.?materials/, CPL = /cpl|centroid|pick.?(?:and.?)?place|-pos|_pos/;
/* A schematic PDF by its name. "sch" counts only as a word (sch.pdf, board_sch.pdf, SCH-v2.pdf): as a mere part of one
   it matched "UnityAssertionsCheatSheet.pdf". "board" and "layout" alone are no sign of one either ("Declaration of
   Conformity for … Development Boards.pdf", "keyboard-layout.pdf"). */
const SCH_PDF = /schematic|circuit(?!python)|pcb|(?:^|[-_ .])(?:sch|hardware|hw)(?:[-_ .]|$)|(?:^|[-_ .])board[-_ ]?(?:layout|outline|dimensions?|drawing)/;
const SCH_IMG = /pinout|pin[-_ ]?map|schematic|footprint/;
const DS_PDF = /datasheet|data[-_ ]sheet|reference[-_ ]manual|appnote|app[-_]note/;
/** A .bin is firmware when its path says so; any other .bin counts only in a repo that builds firmware. */
const FW_HINT = /firmware|bootloader|flash|release|ota|factory|merged|prebuilt|binar|(?:^|\/)bin(?:\/|$)/;
// On a folder's lower-cased name:
const SCH_DIRS = new Set(['schematic', 'schematics', 'sch', 'hardware', 'hw', 'pcb']);
const TEST_BUILD = new Set(['test', 'tests', 'testing', 'build']);
/** Folder names whose sub-folders are the boards / variants a firmware supports. */
const BOARD_DIRS = new Set(['boards', 'board', 'variants', 'bsp', 'targets']);
/** Dependency folders: nothing at all is read from them (as before version 2). */
const DEPS = new Set(['node_modules', '.git', 'bower_components']);
/** Folders that hold other people's code: their files are "bundled", not the repo's own. */
const BUNDLED = new Set(['lib', 'libs', 'libraries', 'libdeps', '.pio', '3rdparty', 'third_party', 'third-party', 'thirdparty', 'vendor', 'vendors',
  'external', 'externals', 'extern', 'deps', 'submodules', 'managed_components', '.pack', 'sdk']);
/** STM32Cube's vendor code, by its exact spelling ("drivers" in lower case is too often a repo's own folder). */
const BUNDLED_EXACT = new Set(['Drivers', 'Middlewares']);
/** Inside the repo's own documentation or hardware folder those names mean something else ("docs/reference/vendor/" holds
 *  the board vendor's schematic, "hardware/lib/" the project's own footprints): what is under them stays the repo's own. */
const OWN_UNDER = new Set(['docs', 'doc', 'documentation', 'hardware', 'hw']);

/** Build systems and platforms, from marker files (a repo can have several), in the order they are listed. */
export const BUILDS = ['ESP-IDF', 'PlatformIO', 'Arduino', 'Zephyr', 'Rust embedded', 'MicroPython', 'Device tree', 'STM32Cube', 'Buildroot', 'Rust',
  'CMake', 'Android', 'Xcode', 'Flutter', 'Tauri', 'Node', 'Python', 'Go', 'Docker', 'Nix'];
const BUILD_FILE = new Map(Object.entries({'idf_component.yml': 'ESP-IDF', 'platformio.ini': 'PlatformIO', 'library.properties': 'Arduino',
  'west.yml': 'Zephyr', 'prj.conf': 'Zephyr', 'memory.x': 'Rust embedded', 'mpconfigboard.h': 'MicroPython', 'mpconfigport.h': 'MicroPython',
  'external.desc': 'Buildroot', 'cargo.toml': 'Rust', 'cmakelists.txt': 'CMake', 'androidmanifest.xml': 'Android', 'pubspec.yaml': 'Flutter',
  'tauri.conf.json': 'Tauri', 'package.json': 'Node', 'pyproject.toml': 'Python', 'setup.py': 'Python', 'requirements.txt': 'Python', 'go.mod': 'Go',
  'dockerfile': 'Docker', 'docker-compose.yml': 'Docker', 'docker-compose.yaml': 'Docker', 'compose.yml': 'Docker', 'compose.yaml': 'Docker', 'flake.nix': 'Nix'}));
const BUILD_EXT = new Map(Object.entries({ino: 'Arduino', dts: 'Device tree', dtsi: 'Device tree', ioc: 'STM32Cube'}));
/** The build systems that mean "this is firmware for a microcontroller / board". */
export const EMBEDDED = new Set(['ESP-IDF', 'PlatformIO', 'Arduino', 'Zephyr', 'Rust embedded', 'MicroPython', 'STM32Cube']);

/** An extension longer than this is not kept in a summary (it is a name with a dot in it, not a file type). */
const MAX_EXT = 16;

/** "src/Main.STL" → "stl"; "Makefile" → "" (no extension); ".gitignore" → "" (a dot file, not an extension). */
export function extOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1), dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * ESP-IDF components that were copied into a project: "<project>/components/<name>" with its own idf_component.yml,
 * next to the project's "<project>/main". (A repo that IS a collection of components has no "main" beside them: there
 * the components are its own files.) Returns the Set of those folders.
 */
function copiedComponents(packed) {
  const found = [];
  eachFolder(packed, (dir, names) => {
    const k = dir.lastIndexOf('/'), parent = k < 0 ? '' : dir.slice(0, k);
    if (k >= 0 && (parent === 'components' || parent.endsWith('/components')) && names.includes('idf_component.yml')) found.push(dir);
  });
  if (!found.length) return new Set();
  const folders = new Set(packed.d.split('\n'));
  return new Set(found.filter(dir => { const project = dir.slice(0, dir.lastIndexOf('/') - 'components'.length); return folders.has(project + 'main'); }));
}

/** What a folder's path says about the files in it. */
function folderInfo(dir, copied) {
  const segs = dir ? dir.split('/') : [], low = dir ? dir.toLowerCase().split('/') : [];
  const info = {deps: false, bundled: false, gerber: false, librepcb: false, testBuild: false, xcode: false, board: null, top: segs[0] ?? null,
    easyeda: false, sch: false, datasheet: false, low: low.join('/')};
  let ownHere = false;   // under the repo's own docs / hardware folder: the bundle names don't apply below it
  for (let i = 0; i < low.length; i++) {
    const s = low[i];
    if (DEPS.has(s) || (s === 'vendor' && low[i + 1] === 'bundle')) info.deps = true;
    else if (ownHere) { /* stays the repo's own */ }
    else if (BUNDLED.has(s) || BUNDLED_EXACT.has(segs[i]) || (s === 'modules' && low[i + 1] === 'hal')) info.bundled = true;
    else if (s === 'components' && copied.size && i + 1 < segs.length && copied.has(segs.slice(0, i + 2).join('/'))) info.bundled = true;
    else if (!info.bundled && OWN_UNDER.has(s)) ownHere = true;
    if (s === 'gerber' || s === 'gerbers') info.gerber = true;
    else if (s === 'librepcb') info.librepcb = true;
    else if (TEST_BUILD.has(s)) info.testBuild = true;
    if (s.endsWith('.xcodeproj')) info.xcode = true;
    if (info.board === null && i < low.length - 1 && BOARD_DIRS.has(s)) info.board = segs[i + 1];
  }
  if (info.deps) info.bundled = true;
  const last = low.at(-1) || '';
  info.easyeda = /easyeda|lceda|oshwhub/.test(last);
  info.sch = SCH_DIRS.has(last);
  info.datasheet = last === 'datasheet' || last === 'datasheets';
  return info;
}

/** The kind of one file, from its lower-cased name, its extension and its folder; '' for none; 'bin?' for a .bin that
 *  is firmware only if the repo builds firmware. */
function kindOf(low, ext, info) {
  const byExt = BY_EXT.get(ext);
  if (byExt === 'pcb' || info.librepcb || (ext === 'json' && (info.easyeda || low.includes('easyeda')))) return 'pcb';
  if (byExt === 'edalib') return 'edalib';
  if (byExt === 'gerber' || info.gerber || (ext === 'zip' && low.includes('gerber')) || (BOM_EXT.has(ext) && BOM.test(low)) || (CPL_EXT.has(ext) && CPL.test(low))) return 'gerber';
  if (ext === 'pdf') {
    if (info.sch || SCH_PDF.test(low)) return 'schematic';
    if (info.datasheet || DS_PDF.test(low)) return 'datasheet';
    return '';
  }
  if (IMG_EXT.has(ext)) return SCH_IMG.test(low) ? 'schematic' : '';
  if (byExt) return byExt;
  if (FW_EXT.has(ext) && !info.testBuild) return ext !== 'bin' || FW_HINT.test(info.low + '/' + low) ? 'fwbin' : 'bin?';
  return '';
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const inKindOrder = map => Object.fromEntries(KINDS.map(k => k[0]).filter(k => map.has(k)).map(k => [k, map.get(k)]));

/**
 * Summary of a packed file list (paths.js), read folder by folder:
 *   v        the rules version · n: the repo's own files · bn: bundled files (other people's code, dependency folders)
 *   kinds    {key: count} of its own files · ex: {key: up to 3 example paths} · bk: {key: count} inside bundled folders
 *   build    [names] of the build systems found · boards: how many boards / variants it has folders for
 *   ext      [[extension, count]…], the 12 most common of its own files · top: its 6 biggest top-level folders
 *   x        {extension: count} over EVERY file, bundled ones too: what ext: and has:kicad / has:stl search
 */
export function describePacked(packed) {
  const own = new Map(), bundled = new Map(), ex = {}, extOwn = new Map(), extAll = new Map(), tops = new Map(), builds = new Set(), boards = new Set();
  const maybeBin = [];
  let n = 0, bn = 0, bins = 0;
  const copied = copiedComponents(packed);
  eachFolder(packed, (stored, names) => {
    const dir = realName(stored), info = folderInfo(dir, copied);
    if (info.deps) {   // a dependency folder: its files exist (ext: finds them), nothing else is read from them
      bn += names.length;
      for (const raw of names) { const dot = raw.lastIndexOf('.'); if (dot > 0 && dot < raw.length - 1 && raw.length - dot - 1 <= MAX_EXT) bump(extAll, raw.slice(dot + 1).toLowerCase()); }
      return;
    }
    if (info.xcode) builds.add('Xcode');
    if (info.bundled) bn += names.length;
    else {
      n += names.length;
      if (info.top !== null) bump(tops, info.top, names.length);
      if (info.board !== null) boards.add(info.board);
    }
    for (const raw of names) {
      const low = raw.toLowerCase(), dot = low.lastIndexOf('.'), ext = dot > 0 && dot < low.length - 1 ? low.slice(dot + 1) : '';
      if (ext && ext.length <= MAX_EXT) { bump(extAll, ext); if (!info.bundled) bump(extOwn, ext); }
      const build = BUILD_FILE.get(low) || BUILD_EXT.get(ext) || (low.startsWith('sdkconfig.') && (low.startsWith('sdkconfig.defaults') || low.startsWith('sdkconfig.ci')) ? 'ESP-IDF' : '');
      if (build) builds.add(build);
      const kind = kindOf(low, ext, info);
      if (!kind) continue;
      if (kind === 'bin?') { if (!info.bundled) { bins++; if (maybeBin.length < 3) maybeBin.push((dir ? dir + '/' : '') + realName(raw)); } continue; }
      if (info.bundled) { bump(bundled, kind); continue; }
      bump(own, kind);
      const list = ex[kind] ??= [];
      if (list.length < 3) list.push((dir ? dir + '/' : '') + realName(raw));
    }
  });
  if (bins && [...builds].some(b => EMBEDDED.has(b))) {   // a firmware repo: its other .bin files are firmware too
    bump(own, 'fwbin', bins);
    ex.fwbin = [...(ex.fwbin || []), ...maybeBin].slice(0, 3);
  }
  const byCount = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  return {v: KINDS_VERSION, n, bn, kinds: inKindOrder(own), bk: inKindOrder(bundled), ex, build: BUILDS.filter(b => builds.has(b)),
    ext: [...extOwn].sort(byCount).slice(0, 12), x: Object.fromEntries([...extAll].sort(byCount)),
    boards: boards.size, top: [...tops].sort(byCount).slice(0, 6).map(d => d[0])};
}

/** Summary of a plain list of paths (see describePacked). */
export const describe = paths => describePacked(packPaths(paths));

/** The stored summary of a file-list record, or null. One written by older rules stays as it is (some fields are then
 *  missing: callers treat what they can't know as unknown) until files.js computes it again from the stored paths. */
export const summaryOf = rec => rec?.s ?? null;
/** Was this record's summary written by older rules? (A repo without a tree has nothing to compute again.) */
export const staleSummary = rec => !!rec && !rec.miss && rec.s?.v !== KINDS_VERSION;

/** Hardware design files: PCB sources, fabrication files and schematics together (has:hardware). */
export const HARDWARE = ['pcb', 'gerber', 'schematic'];
/** 3D models of any kind (has:3d). */
export const MODELS_3D = ['cad', 'mesh'];
const sum = (s, keys) => keys.reduce((a, k) => a + (s?.kinds?.[k] || 0), 0);
export const hardwareCount = s => sum(s, HARDWARE);
export const models3dCount = s => sum(s, MODELS_3D);

/** Aliases understood by has:<…> (besides every kind key and every build system, lower-cased, spaces as dashes). */
const HAS_ALIAS = {hardware: HARDWARE, hw: HARDWARE, eda: ['pcb', 'edalib'], lib: ['edalib'], library: ['edalib'], '3d': MODELS_3D, model: MODELS_3D,
  models: MODELS_3D, print: ['mesh'], drawing: ['mech'], dxf: ['mech'], ml: ['ml'], ai: ['ml'], prebuilt: ['fwbin'], flashable: ['fwbin'], binary: ['fwbin']};
/** has:<…> that asks for file types, wherever the files are: has:kicad is a KiCad board, schematic or project. */
const HAS_EXT = {kicad: ['kicad_pcb', 'kicad_sch', 'kicad_pro'], stl: ['stl'], uf2: ['uf2'], step: ['step', 'stp']};
const slug = name => name.toLowerCase().replace(/\s+/g, '-');

/** Does the repo have a file with this extension (bundled files too)? null when the summary can't tell (older rules). */
export function hasExt(s, ext) {
  if (s?.x) return Object.hasOwn(s.x, ext);
  return s?.ext?.some(([e]) => e === ext) ? true : null;   // older summaries kept only the 12 most common
}

/** has:<v> for a summary: true / false, or null when <v> means nothing or the summary can't tell (the qualifier is
 *  then ignored). */
export function hasKind(s, v) {
  v = v.toLowerCase();
  if (v === 'firmware' || v === 'embedded') return s.build.some(b => EMBEDDED.has(b));
  if (v === 'bundled') return s.bk ? Object.keys(s.bk).length > 0 : null;
  if (Object.hasOwn(HAS_EXT, v)) {
    let known = true;
    for (const e of HAS_EXT[v]) { const h = hasExt(s, e); if (h) return true; if (h === null) known = false; }
    return known ? false : null;
  }
  if (Object.hasOwn(HAS_ALIAS, v)) return sum(s, HAS_ALIAS[v]) > 0;
  if (KIND_BY[v]) return (s.kinds[v] || 0) > 0;
  const build = BUILDS.find(name => slug(name) === v);
  if (build) return s.build.includes(build);
  return null;
}

/** The kind label with its icon: "🔌 PCB & schematic sources". */
export const kindLabel = key => KIND_BY[key] ? `${KIND_BY[key][1]} ${KIND_BY[key][2]}` : key;
export const kindIcon = key => KIND_BY[key]?.[1] || '';
export const kindHelp = key => KIND_BY[key]?.[3] || '';
