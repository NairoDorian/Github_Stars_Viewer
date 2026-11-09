// What a repo's file names say about it: hardware design files, 3D models, firmware build systems, notebooks… Pure
// functions over a list of paths (no state, no requests), shared by files.js (which fetches the lists) and list.js (cards,
// the "File kinds" filters, has: / ext: / path: search and the file-based sort orders). The rules follow the file-tree
// analysis of the SLAB github_links tool (slab_stars.py, phase "trees").

/** Bump when the rules change: stored summaries of an older version are computed again from their paths. */
export const KINDS_VERSION = 1;

/** The kinds a file can be, in the order they are tried (a file counts once, for the first kind that matches).
 *  [key, icon, label, what it covers, regex on the lower-cased path] */
export const KINDS = [
  ['pcb', '🔌', 'PCB & schematic sources', 'KiCad, Altium, EasyEDA, Eagle, OrCAD / .sch, Fritzing, LibrePCB, gEDA',
    /\.kicad_(?:pcb|sch|pro|sym|mod|wks|dru)$|\.(?:pcbdoc|schdoc|prjpcb|pcblib|schlib|epro|eprj|elibz|brd|lbr|sch|fzz|fzpz|fzp|lppz|dsn|olb|pcb)$|easyeda[^/]*\.json$|(?:easyeda|lceda|oshwhub)[^/]*\/[^/]+\.json$|(?:^|\/)librepcb\//],
  ['gerber', '🏭', 'Gerbers & fabrication', 'Gerber and drill files, BOM, pick-and-place',
    /\.(?:gbr|gtl|gbl|gto|gbo|gts|gbs|gko|gm1|gtp|gbp|g[2-9]l?|drl|xln)$|gerbers?[^/]*\.zip$|(?:^|\/)gerbers?\/|(?:^|\/)[^/]*(?:\bbom\b|_bom|bom_|-bom|bom-|bill.?of.?materials)[^/]*\.(?:csv|xlsx?|ods|html?|tsv)$|(?:^|\/)[^/]*(?:cpl|centroid|pick.?(?:and.?)?place|-pos|_pos)[^/]*\.(?:csv|xlsx?)$/],
  ['schematic', '📐', 'Schematic PDFs & pinouts', 'schematic / board PDFs, pinout and board diagrams',
    /(?:sch|schematic|circuit|pcb|board|hardware|layout)[^/]*\.pdf$|(?:^|\/)(?:schematics?|hardware|hw|pcb)\/[^/]*\.pdf$|(?:pinout|pin[-_ ]?map|schematic|footprint)[^/]*\.(?:svg|png|jpe?g|webp)$/],
  ['datasheet', '📄', 'Datasheets', 'datasheets, reference manuals, application notes (PDF)',
    /(?:datasheet|data[-_ ]sheet|reference[-_ ]manual|appnote|app[-_]note)[^/]*\.pdf$|(?:^|\/)datasheets?\/[^/]*\.pdf$/],
  ['cad', '🧊', '3D CAD models', 'STEP, IGES, Fusion 360, FreeCAD, OpenSCAD, SolidWorks, Inventor, Onshape exports, VRML',
    /\.(?:step|stp|iges|igs|f3d|f3z|fcstd|scad|sldprt|sldasm|slddrw|ipt|iam|x_t|x_b|wrl|3dm|skp|catpart|catproduct|prt)$/],
  ['mesh', '🖨', '3D meshes & printing', 'STL, 3MF, OBJ, glTF, FBX, Blender, PLY, G-code',
    /\.(?:stl|3mf|obj|glb|gltf|fbx|blend|dae|ply|usdz|usd|3ds|gcode|amf)$/],
  ['mech', '📏', '2D drawings & laser cut', 'DXF, DWG',
    /\.(?:dxf|dwg)$/],
  ['ml', '🤖', 'ML model files', 'ONNX, TFLite, safetensors, GGUF, PyTorch, Keras, Core ML',
    /\.(?:onnx|tflite|safetensors|gguf|ggml|pt|pth|ckpt|h5|keras|mlmodel|mlpackage|pb|engine)$/],
  ['notebook', '📓', 'Notebooks', 'Jupyter notebooks',
    /\.ipynb$/],
  ['game', '🎮', 'Game projects', 'Unity, Godot, Unreal',
    /\.(?:unity|uproject|uasset|tscn|godot)$|(?:^|\/)project\.godot$/],
];
const KIND_BY = Object.fromEntries(KINDS.map(k => [k[0], k]));

/** Build systems and platforms, from marker files (a repo can have several). [name, regex] */
export const BUILDS = [
  ['ESP-IDF', /(?:^|\/)(?:idf_component\.yml|sdkconfig\.defaults[^/]*|sdkconfig\.ci[^/]*)$/],
  ['PlatformIO', /(?:^|\/)platformio\.ini$/],
  ['Arduino', /\.ino$|(?:^|\/)library\.properties$/],
  ['Zephyr', /(?:^|\/)(?:west\.yml|prj\.conf)$/],
  ['Rust embedded', /(?:^|\/)memory\.x$/],
  ['MicroPython', /(?:^|\/)(?:mpconfigboard\.h|mpconfigport\.h)$/],
  ['Device tree', /\.dtsi?$/],
  ['STM32Cube', /\.ioc$/],
  ['Buildroot', /(?:^|\/)external\.desc$/],
  ['Rust', /(?:^|\/)cargo\.toml$/],
  ['CMake', /(?:^|\/)cmakelists\.txt$/],
  ['Android', /(?:^|\/)androidmanifest\.xml$/],
  ['Xcode', /\.xcodeproj\//],
  ['Flutter', /(?:^|\/)pubspec\.yaml$/],
  ['Tauri', /(?:^|\/)tauri\.conf\.json$/],
  ['Node', /(?:^|\/)package\.json$/],
  ['Python', /(?:^|\/)(?:pyproject\.toml|setup\.py|requirements\.txt)$/],
  ['Go', /(?:^|\/)go\.mod$/],
  ['Docker', /(?:^|\/)(?:dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/],
  ['Nix', /(?:^|\/)flake\.nix$/],
];
/** The build systems that mean "this is firmware for a microcontroller / board". */
export const EMBEDDED = new Set(['ESP-IDF', 'PlatformIO', 'Arduino', 'Zephyr', 'Rust embedded', 'MicroPython', 'STM32Cube']);

/** Folders whose files say nothing about the repo itself (vendored dependencies, build output). */
const SKIP = /(?:^|\/)(?:node_modules|\.git|vendor\/bundle|bower_components)\//;
/** Folder names whose sub-folders are the boards / variants a firmware supports. */
const BOARD_DIRS = new Set(['boards', 'board', 'variants', 'bsp', 'targets']);

/** "src/Main.STL" → "stl"; "Makefile" → "" (no extension); ".gitignore" → "" (a dot file, not an extension). */
export function extOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1), dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Summary of a repo's file list: {v, n (files looked at), kinds {key: count}, ex {key: up to 3 example paths},
 * build [names], ext [[ext, count]… the 12 most common], boards (count), top [the 6 biggest top-level folders]}.
 */
export function describe(paths) {
  const kinds = {}, ex = {}, ext = {}, dirs = {}, builds = new Set(), boards = new Set();
  let n = 0;
  for (const p of paths) {
    if (SKIP.test(p)) continue;
    n++;
    const low = p.toLowerCase(), segs = p.split('/');
    if (segs.length > 1) dirs[segs[0]] = (dirs[segs[0]] || 0) + 1;
    const e = extOf(p);
    if (e) ext[e] = (ext[e] || 0) + 1;
    for (const [key, , , , rx] of KINDS) {
      if (!rx.test(low)) continue;
      kinds[key] = (kinds[key] || 0) + 1;
      const list = ex[key] ??= [];
      if (list.length < 3) list.push(p);
      break;
    }
    for (const [name, rx] of BUILDS) if (!builds.has(name) && rx.test(low)) builds.add(name);
    for (let i = 0; i < segs.length - 2; i++) if (BOARD_DIRS.has(segs[i].toLowerCase())) { boards.add(segs[i + 1]); break; }
  }
  return {v: KINDS_VERSION, n, kinds, ex, build: BUILDS.map(b => b[0]).filter(b => builds.has(b)),
    ext: Object.entries(ext).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12),
    boards: boards.size, top: Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(d => d[0])};
}

// Summaries are stored with the record when it is fetched; one of an older rules version is computed again, once.
const cache = new WeakMap();
/** The summary of a stored file-list record ({p: paths, s: stored summary}), or null. */
export function summaryOf(rec) {
  if (!rec?.p) return null;
  if (rec.s?.v === KINDS_VERSION) return rec.s;
  let s = cache.get(rec);
  if (!s) cache.set(rec, s = describe(rec.p));
  return s;
}

/** Hardware design files: PCB sources, fabrication files and schematics together (has:hardware). */
export const HARDWARE = ['pcb', 'gerber', 'schematic'];
/** 3D models of any kind (has:3d). */
export const MODELS_3D = ['cad', 'mesh'];
const sum = (s, keys) => keys.reduce((a, k) => a + (s?.kinds[k] || 0), 0);
export const hardwareCount = s => sum(s, HARDWARE);
export const models3dCount = s => sum(s, MODELS_3D);

/** Aliases understood by has:<…> (besides every kind key and every build system, lower-cased, spaces as dashes). */
const HAS_ALIAS = {hardware: HARDWARE, hw: HARDWARE, eda: ['pcb'], kicad: null, '3d': MODELS_3D, model: MODELS_3D, models: MODELS_3D,
  stl: null, print: ['mesh'], drawing: ['mech'], dxf: ['mech'], ml: ['ml'], ai: ['ml']};
const slug = name => name.toLowerCase().replace(/\s+/g, '-');

/** has:<v> for a summary: true / false, or null when <v> means nothing (the qualifier is then ignored). */
export function hasKind(s, v, paths = []) {
  v = v.toLowerCase();
  if (v === 'firmware' || v === 'embedded') return s.build.some(b => EMBEDDED.has(b));
  if (v === 'kicad') return paths.some(p => /\.kicad_(?:pcb|sch|pro)$/i.test(p));
  if (v === 'stl') return paths.some(p => /\.stl$/i.test(p));
  if (v in HAS_ALIAS) return sum(s, HAS_ALIAS[v]) > 0;
  if (KIND_BY[v]) return (s.kinds[v] || 0) > 0;
  const build = BUILDS.find(([name]) => slug(name) === v);
  if (build) return s.build.includes(build[0]);
  return null;
}

/** The kind label with its icon: "🔌 PCB & schematic sources". */
export const kindLabel = key => KIND_BY[key] ? `${KIND_BY[key][1]} ${KIND_BY[key][2]}` : key;
export const kindIcon = key => KIND_BY[key]?.[1] || '';
export const kindHelp = key => KIND_BY[key]?.[3] || '';
