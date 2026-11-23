# Stars Viewer: where to take it next

Written 9 Nov 2026, after the file-lists / budgets release (commit `44cb242`). Every number below comes from the real
cache in `data/` (profile *NairoDorian*): **6,594 stars**, 6,431 READMEs (68 M characters), 6,329 file lists
(9.0 M stored paths, 9.3 M files), plus the commit & release index. On disk: 58 MB of file lists, 25 MB of READMEs,
1.5 MB of star list (all gzip-compressed by `server.js`).

What the data says about this star list, and why it shapes the suggestions:

| Fact | Count | So… |
|---|---|---|
| Starred in 2026 | 6,180 of 6,594 | most stars were never looked at twice: **triage tools** matter more than more data |
| C / C++ / Python / no language | 2,037 / 1,430 / 927 / 729 | an embedded and hardware collection |
| ESP-IDF / Arduino / PlatformIO / Zephyr projects | 1,623 / 1,501 / 998 / 110 | knowing **which chip and board** each repo targets is the most valuable missing field |
| Repos with KiCad boards / any PCB source / Gerbers | 501 / 820 / 549 | hardware is a first-class category, worth a dedicated view |
| Ship `.bin` / `.elf` / `.hex` / `.uf2` files | 1,131 (81 with `.uf2`) | "ready to flash" is detectable |
| No description / no topics | 711 / 3,717 | search on name + description misses a lot: summaries and inferred tags help |
| No licence / NOASSERTION | 1,911 / 791 | licence matters if anything gets reused in the SLAB |
| Not pushed for 2 years / archived | 804 / 82 | "is it alive?" needs to be visible |

---

## 0. Done in the audit round of 23 Nov 2026

Measured in headless Chrome on a copy of the real cache (6,682 stars, 13.9 M file paths, 339,916 commit messages,
128,999 releases), GitHub faked, before and after:

| | Before | After |
|---|---|---|
| Whole cache read at start | 9.1 s | 3.0 s |
| First check finished | 10.3 s | 4.1 s |
| JS heap after load | 1,764 MB | 716 MB |
| Drawing the list (search on card fields) | 150–190 ms | 60–75 ms |
| `ext:stl` / `has:kicad` | 918 / 538 ms | 81 / 84 ms |
| `path:gerber` (first use) / file-name search | 1,721 / ~480 ms | 374 / ~175 ms |
| JS heap with file-name search | 3,131 MB | 1,791 MB |
| JS heap with everything searched | 3,704 MB | 2,421 MB |
| File lists on disk | 95.5 MB | 85.8 MB |

**Bugs found and fixed**
- **Opening the cache from another browser destroyed most of the commit index.** The commit limit is a browser
  preference; a browser without one applied the default (1,000) to an index built with 100 per repo, which reset every
  repo cut at 100: 2,394 repos, 239,400 commit messages, on both benchmark copies. Options are now kept with the index
  (`histopts:<user>`) and fitted to it on load; only a change in a ▾ menu is applied to stored records.
- After the cache finished loading nothing redrew the cards unless a search box was ticked: when the first check
  could not run (offline, rate limit, another tab holding the lock) cards stayed without badges, file kinds or counts.
- "★ Make this my profile" with 💾 off threw away what the visit had downloaded.
- Switching 💾 on could erase a stored token (the tab's empty config was saved over it).
- GitHub's "slow down" on REST: a 429 was read as a used-up hourly budget (up to an hour of waiting), a 403 made a
  file pull mark every remaining repo as failed while still sending requests. Now: pause, halve the parallel requests,
  continue; stop with progress saved if it persists.
- Toolbar jobs with no profile loaded asked GitHub about an empty user name; a failed page while reading your own
  stars during a visit crashed the comparison; a repo GitHub blocks (403) was asked for its tree at every pull.

**Done from this note:** 1.1 (kinds precision, own vs bundled), 1.2 (packed storage, lazy loading), 1.3 (prebuilt
firmware kind, CI on `@v5`, browser test in CI), 2.2 (README summary), most of 3.6 (health and licence), 4.3 (storage
protection and usage). Details are marked ✅ in the sections below.

**Also done:** sorting reads each value once; the activity log adds new lines instead of rebuilding itself and draws
nothing while collapsed or in a background tab; chart tooltips are created on hover (two fifths of a card's DOM
nodes); 100 cards per step instead of 200; star-count samples keep only the two ends of a flat stretch (41,000 of
66,000 samples were redundant); the local server hands gzip files to the browser as they are; Discover's copy check
uses an index of names.

**What the numbers say comes next**
- **Release notes are now the heaviest thing in memory.** 294 M characters, read at every start (391 MB of JSON for
  the whole commit / release index) and copied once more when *Releases* is searched (+560 MB). The same split as for
  file lists would work (what the cards and the fork scan need at start, the notes on demand), but `slab_stars.py`
  reads the `history_<user>_<n>.json` shards, so the format has to change on both sides together.
- **File-name search keeps two copies of the packed paths** (as stored, and lower-cased): about 950 MB while it is in
  use. Keeping only the lower-cased copy and reading the original spelling for the ~100 hits on screen would halve it.
- **REST pulls run 10 requests at a time**, more than GitHub's documented secondary limit of 900 a minute when answers
  are fast. It is now handled when GitHub objects; a pacer that never gets there would be gentler (see 4.2).
- `list.js` is past 850 lines (see 4.4).

---

## 1. Fix first (precision and weight of what was just added)

### 1.1 The "schematic" kind over-matches ✅ done
Result on the real lists: schematic 1,019 → 918 repos of their own (+77 with one only in bundled code), PCB sources
836 → 757 boards + 354 library repos, and `KINDS_VERSION` is 2. Two things differ from the plan below, after looking
at what it did to real repos: a `components/<name>` with its own `idf_component.yml` counts as bundled only next to a
`main/` folder (a repo that *is* a collection of components keeps them as its own), and inside the repo's own `docs/`
or `hardware/` folder the bundle names are ignored (`docs/reference/vendor/schematic/…` is the board's schematic).
Summaries are no longer recomputed on read: `files.js upgradeFiles` does it once, in the background, and saves them.

1,004 repos are tagged 📐 *Schematic PDFs & pinouts*, but **528 of them have no PCB source and no Gerber**, and the
examples show why:
- `…/unity/docs/UnityAssertionsCheatSheetSuitableforPrintingandPossiblyFraming.pdf`: "assertion**sch**eat" contains `sch`;
- `Certification/EU Declaration of Conformity for Espressif Modules and Development Boards.pdf`: matched on `board`;
- `amazon-freertos/libraries/3rdparty/…`, `modules/hal/cmsis_6/…`, `.pack/Keil/…`: files of **vendored SDKs**, not of the repo.

Fixes:
- `sch` only as a word (`(^|[-_ ./])sch([-_ .]|$)`, `_sch`, `schematic`), and drop `board` as a lone trigger.
- **Own files vs vendored files**, the biggest lever for every kind: ignore paths under `lib/`, `libs/`, `libraries/`,
  `3rdparty/`, `third_party/`, `vendor/`, `external/`, `managed_components/`, `components/<name>/` when that
  component has its own `idf_component.yml`, `modules/hal/`, `.pack/`, `sdk/`, `Drivers/` (STM32Cube) and submodules.
  Count them separately ("📦 bundled: KiCad ×12") instead of mixing them in.
- Separate **KiCad libraries** (only `.kicad_sym` / `.kicad_mod`: 55 repos) from **KiCad boards** (`.kicad_pcb` /
  `.kicad_sch`: 501 repos).
- Bump `KINDS_VERSION`: summaries are recomputed from the stored paths, no download needed.

### 1.2 File lists stay complete: make them light without dropping anything ✅ storage and loading done
Done: prefix-compressed storage (`paths.js`: 871 M → 380 M characters, 44 %), lazy loading (summaries in
`filesum:<user>`, paths in 1,024 shards read only for a file-name search and released after two minutes), and the
one-time upgrade of the 64 old shards (36–46 s for 13.9 M paths, checked path by path against the original). Search
stayed on the main thread: on the packed form a file-name search over everything takes 150–200 ms. Left: the tree view.

**Rule: a file list is always the whole tree, never capped or filtered, however big the repo.** Done since this note was
first written: the 50,000-path cap is gone, vendored folders (node_modules…) are kept, and trees that GitHub truncates
(100,000 entries or 7 MB per answer) are walked folder by folder until every file is listed. Lists stored by the older
version that were cut (32 repos), truncated (46) or possibly filtered (963 repos with a `package.json`, `bower.json` or
`Gemfile`) are fetched again, whole, at the next 📁 Files pull: about 1,040 REST requests once.

The cost is size: the median repo has 96 files, the 90th percentile 2,428, but the 109 repos above 20,000 files hold
4.4 M files, and all ~9.3 M+ paths live as JS strings in the tab (several hundred MB). Lossless ways to make that light:
- **Prefix-compressed storage**: one table of folders per repo, then `folderIndex/name` per file. File trees repeat their
  folders endlessly, so this typically divides the size by 3 or more, on disk and in memory, with every path kept.
- **Lazy loading**: keep the summaries (kinds, extensions, build systems) in memory, and load a repo's full path list
  only when it is searched, shown or compared (the shards are already per 64 groups).
- **Search off the main thread**: path search in a Web Worker with an index (see 4.1), so 9 M paths never freeze the page.
- **A tree view** of any repo's stored list in the app (expand folders, filter by kind), now that the lists are complete.

### 1.3 Small but visible
- ✅ A **"Prebuilt firmware"** kind (`.bin`, `.elf`, `.hex`, `.uf2`, outside `test/` and `build/`): 986 repos. A bare
  `.bin` counts only in a repo that builds firmware or when its path says so (`firmware/`, `release/`, `bin/`…), so
  model weights and game data are not firmware.
- **Release assets** (see 2.3) are a better "ready to flash / ready to print" signal than files in the tree.
- ✅ GitHub Actions: `actions/checkout@v5` and `actions/setup-node@v5`.
- ✅ The e2e browser test runs in CI (job `e2e`, Playwright with its own Chromium; checked locally with that Chromium
  on Windows, the Ubuntu runner is untested until the first push). It does not gate the deploy: `deploy` needs `test`.

---

## 2. New data worth pulling (ranked by value for this collection ÷ cost)

### 2.1 Target chips and boards, from the build files (high value, cheap)
The file lists already say *which* manifest files each repo has. Read only those small files, in GraphQL batches like
READMEs (`object(expression:"HEAD:platformio.ini"){...on Blob{text}}`), and parse:
- `platformio.ini`: `board = esp32-s3-devkitc-1`, `platform = espressif32`, `framework = espidf, arduino`;
- `idf_component.yml`: dependencies (LVGL, esp_lcd drivers, esp-sr…) and `targets: [esp32p4, esp32c5]`;
- `sdkconfig.defaults*`: `CONFIG_IDF_TARGET="esp32s3"`, PSRAM, flash size;
- `west.yml` / `boards/` (Zephyr), `CMakeLists.txt` (`set(IDF_TARGET …)`), `library.properties` (`architectures=`),
  `Cargo.toml` (`esp-hal`, `embassy-*`, `rp2040-hal`), `memory.x`, `.ioc` (STM32 MCU name).

That gives every repo a **Chips** field (ESP32-S3, ESP32-P4, ESP32-C5, RP2040, nRF52840, STM32U5…) and a **Boards**
field, as sidebar facets and `chip:esp32-s3` / `board:t-deck` qualifiers. For 1,600+ ESP-IDF repos it is the single most
useful filter missing today. Cost: about one GraphQL point per 10 to 20 repos.

### 2.2 A summary when the description is empty (free) ✅ done
644 of the 716 repos without a description now show (and are found by) the first real paragraph of their README.

711 repos have no description. Take the first real paragraph of the README (skip badges, titles, tables of contents),
like the SLAB tool's `README summary`, and show it in grey on the card; also search it. No request.

### 2.3 Release assets (cheap: the releases query already runs)
Add `releaseAssets(first:30){nodes{name size downloadCount contentType}}` to the release pages: then **"ready to flash"**
(`.bin`, `.uf2`, `.hex` attached), **"ready to print"** (STL / 3MF zips), **"has a desktop app"** (`.exe`, `.dmg`,
`.AppImage`, `.apk`), plus total downloads as a popularity signal that stars miss.

### 2.4 More repo fields, free in the details query already sent
GraphQL `Repository` has, at no extra request:
- `openGraphImageUrl` + `usesCustomOpenGraphImage`: the repo's **social preview image**, often a photo of the board or
  the device. A **gallery view** of hardware repos would be far faster to scan than text cards. (The page's
  Content-Security-Policy must then allow `repository-images.githubusercontent.com` and `opengraph.githubassets.com`.)
- `diskUsage` (KB): spot huge repos before pulling their trees;
- `fundingLinks`, `hasDiscussionsEnabled`, `isTemplate`, `mirrorUrl`, `watchers{totalCount}`,
  `pullRequests(states:OPEN){totalCount}`, `issues(states:CLOSED){totalCount}`.

### 2.5 Dependencies of each repo (medium cost, high value for "who uses what")
- REST `GET /repos/{owner}/{repo}/dependency-graph/sbom`: one request per repo, an SPDX list of packages;
- or derive them from 2.1 (`idf_component.yml`, `Cargo.toml`, `package.json`, `requirements.txt`, `library.properties`).

Then: "which of my stars use LVGL 9", "everything built on esp-hal", "reverse dependencies inside my stars".

### 2.6 Contributors (medium cost)
`GET /repos/{o}/{r}/contributors?per_page=1&anon=1` returns the count in its `Link` header: one request per repo. It
gives a **bus factor** (1 contributor or 200?) and, with the top contributors' logins, a people graph across stars (the
same few makers behind many hardware repos: LilyGO, Waveshare, Espressif, Seeed).

### 2.7 Things to look at but probably skip
- **GitHub star lists** ("Lists" on the stars page): no public API as far as I know; verify before planning anything.
- **Code search** for part numbers (what the SLAB `parts.md` does): 10 searches a minute, so on demand only, from a
  "Find code using …" box, never in bulk.
- Commit **authors** per repo: large and of little use beyond 2.6.

---

## 3. Features that turn the data into decisions

### 3.1 Triage: a review queue for the 6,180 stars of 2026
- Per-repo **verdict** (Use / Study / Compare / Watch / Skip, the same scale as the SLAB `curated.csv`), **notes** and
  **your own tags**, stored with the profile and exported in CSV.
- **Import `SLAB/github_links/curated.csv`** (417 verdicts already written by hand) so the two tools agree.
- A **Review** mode: one repo at a time (card, README summary, file kinds, chips), keyboard shortcuts for the verdict,
  and *☆ Unstar* for the ones not worth keeping. 6,180 stars at ~5 seconds each is about 9 hours; with filters such as
  "hardware first" it becomes a few short sessions.

### 3.2 Hardware view
For repos with design files: a table with boards, chips (2.1), EDA tool (KiCad / Altium / EasyEDA / Eagle), the
design folders (the SLAB tool already lists them as `samples`), Gerbers yes/no, 3D enclosure yes/no, licence, last push,
and the social preview image (2.4). Sortable, exportable. It is what `hardware.md` does in the SLAB, live.

### 3.3 Keyword families and scores inside the viewer
`SLAB/github_links/tools/families.toml` defines 102 weighted keyword families (chips, parts, subsystems). Reading it
(or an equivalent in the app) gives every repo a **relevance score and tier** for a project, with the evidence ("ESP32-P4
in title, LR2021 in README ×3"). Several profiles could exist ("SLAB", "audio", "LoRa"), each a saved family set.

### 3.4 Saved searches and smart collections
Name and keep a query plus its filters ("ESP32-S3 + KiCad + MIT"), show its count in the sidebar, and flag what is
**new since you last opened it**.

### 3.5 "What changed" digest
After *Check for updates*: new releases of your stars (with their notes), repos archived or deleted since, the biggest
star gains of the week (star-history data is already there), repos that became active again. One panel, newest first.

### 3.6 Health and licence at a glance ✅ done, except `is:template`
`is:alive` / `is:quiet` / `is:stale`, `license:none|other|copyleft|permissive|<spdx>`, the dot on each card, and
*Status* rows for "No push for 2 years" (811) and "No licence" (1,909). `is:template` needs the field of 2.4.

Qualifiers and sidebar rows for `is:stale` (no push for 2 years: 804 repos), `license:none` (1,911), `license:copyleft`,
`is:template`; a small "alive / quiet / archived" dot on each card.

### 3.7 Better hidden-fork detection from file trees
`forks.js` compares commits, READMEs and names. Two repos with the **same file tree** (same paths, or a Jaccard
similarity above 0.9 of their path sets) are almost surely copies, even when their histories were squashed. Cheap: the
paths are already stored.

### 3.8 One cache for both tools
`slab_stars.py` already reads this app's cache for READMEs and release notes, but fetches its own trees (7,355 REST
calls). It could read `data/files_<user>_<n>.json` instead: same paths, no download. Document the cache format
(it is in `store.js` / `files.js` comments today) so the two stay compatible.

---

## 4. Engine and performance

### 4.1 Search in a Web Worker, with an index
68 M characters of READMEs, millions of commit messages and 9 M paths are scanned with `indexOf` on every keystroke.
Move the search to a Web Worker (the page never freezes) and build a **trigram index** once per data version:
substring queries then touch only candidate repos. The debounce can then go back to ~50 ms everywhere.

### 4.2 One budget scheduler for every job
Budgets are now known exactly (`budget.js`). Next step: plan a pull against them before it starts (cost estimate per
category: 1 REST call per file list, ~1 GraphQL point per 10 repos of details, ~1 point per commit page…), show "needs
about 6,600 REST requests: 1 h 20 min with the budget left", and let **Pull all** order its work so that cheap, high
value parts finish first.

### 4.3 Online storage limits ✅ done
`navigator.storage.persist()` is asked for when 💾 is on online, the 💾 tooltip says how much is used and allowed, and
a warning shows above 80 %. The packed file lists make the online copy much smaller as well.

The online version keeps everything in IndexedDB. 85 MB and more is fine in Chrome but can hit quotas elsewhere: ask
for `navigator.storage.persist()` and show the space used; the prefix-compressed storage of 1.2 is the real answer
(file lists stay complete online too).

### 4.4 Code health
`list.js` (~850 lines after the November round) now holds search, qualifiers, cards, facets and export: split it into `search.js`, `cards.js` and
`facets.js` before adding chips, boards and verdicts. Keep the rule "imports only point downwards".

---

## 5. Suggested order

1. ✅ **1.1 + 1.2 + 1.3**: precision of file kinds, lighter (still complete) file lists, CI fixes — done 23 Nov 2026.
2. **2.4 + 2.3** (2.2 is done): free repo fields and release assets (no or almost no new requests).
   Before or with it: **release notes read on demand** (section 0), since 2.3 makes the release records bigger.
3. **2.1**: chips and boards from build files, then **3.2** the hardware view.
4. **3.1**: verdicts, notes, tags and the review queue, with the `curated.csv` import.
5. **3.3 / 3.4 / 3.5**: families and scores, saved searches, the digest.
6. **4.1 / 4.2**: worker search and the budget scheduler, once the data has grown again.
