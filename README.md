# ★ GitHub Stars Viewer

Browse, search and get smart suggestions from **any GitHub user's starred repositories**, all on one fast page.

**▶ Use it online:** https://nairodorian.github.io/Github_Stars_Viewer/
(open a specific profile with `?user=<name>`, e.g. [`?user=NairoDorian`](https://nairodorian.github.io/Github_Stars_Viewer/?user=NairoDorian); without one, the online version starts with an empty username box, while the local version opens NairoDorian's stars unless you saved your own profile)

No build step and no dependencies. The same code runs online (GitHub Pages) or locally with a tiny Node server.

## Features

- **All stars at once.** Every page of the star list is fetched in parallel, then cached so reopening is instant.
- **Last commit and last release on every card.** *Last commit* is the head of the default branch; *last release* is the **newest release by publish date, pre-releases included** (flagged, with GitHub's own "Latest" in the tooltip when it differs, as with backport lines). A repo without releases says so; a push date is never shown as a commit. With a token both are kept current: every update check refreshes the repos pushed since the last one (and every repo at least every two weeks), and once commits & releases are indexed, their cheap check (40 repos per request) refreshes them too. The Last commit / Last release sorts use the same values.
- **Rich cards everywhere.** Starred repos and Discover suggestions share the same layout: About text, owner, stars, forks, open issues and pull requests (one number, the same on both kinds of card), license, **every language with its share**, topics, homepage, creation date, **🕒 last commit**, **🏷 last release** and activity charts. Starred cards also show when you starred them; suggestion cards show why they were recommended.
- **More ways to view every repo.** Compact links on every card open GitDiagram, DeepWiki, GitIngest, UIthub, github.dev, and GitHistory. GitHistory animates a file rather than a whole repository; its link opens the cached README path when known, otherwise `README.md`.
- **Sort** your stars by recently starred, most or fewest stars, last commit, last release, name, owner or newest repo. Every Discover result also has sorting, with **Best match** as its default. Exact release and commit sorting across suggestions needs a token.
- **Search** name, owner, description and topics, with highlighting, exact phrases (`"screen copy"`), exclusions (`-flutter`), and qualifiers (`lang:rust`, `owner:foo`, `topic:cli`, `is:active`, `is:archived`, `is:fork`, `is:hiddenfork`, `is:anyfork`, `is:original`, `stars:>1000`, `stars:>=1.5k`, `stars:10..500`). A qualifier the app doesn't understand (`is:foo`) is ignored rather than hiding everything. Press `/` to focus the search box.
- **Four things to pull for search, each with its own button** (toolbar group *Pull for search*), **its own ▾ menu and its own checkbox** (*Also search in*, next to the search box): **📄 READMEs**, **📝 Commits**, **🏷 Releases** and **📁 Files**, or **⬇ Pull all** for the four in one job (commits and releases share one check; without a token they are skipped and the rest goes over REST). Pulling one never downloads the others, *Check for updates* tops up only what you pulled, and each ▾ menu has a **🗑 Clear** for that category alone (two clicks; clearing commits keeps the release notes and the other way round). The repo itself (name, description, topics, language, stars, last commit and release) is always pulled with the star list.
- **Search inside READMEs.** Click *📄 READMEs* once, then tick *Also search in: READMEs*. Matches show a snippet. READMEs are the first source of information and are **never trimmed**: they are stored whole, however long, and a README is downloaded again only when its git hash changed (older caches that cut READMEs at 100,000 characters are repaired automatically). `README.md`, `readme.md`, `Readme.md`, `.markdown`, `.rst`, `.txt` and extension-less `README` files are found in the same cheap batched calls; any other name costs one extra request.
- **Search inside commit messages and release notes.** Click *📝 Commits* and/or *🏷 Releases* once (needs a token); searching what was pulled is turned on (*Also search in: Commits / Releases*, each on its own). *Commits* downloads **every commit message** (subject and body, each kept up to 400 characters; the newest 1,000 per repo by default, up to 100,000 or all); *Releases* downloads **every release** (tag, title and whole notes; up to 5,000 per repo) of every star. Never any code. Matches show the commit or release with a link to it on GitHub, and each term of a query may match in a different place: a README, a commit, a release, or the card itself. Later checks are incremental: a cheap check per 40 repos, then only the new commits and releases are downloaded, and an interrupted run (**■ Cancel**, a rate limit, a closed tab) continues where it stopped, with progress saved batch by batch.
  The **▾** next to *📝 Commits* holds the commits-per-repo limit; the one next to *🏷 Releases*: strip `@mentions` from release notes (on by default, so a username doesn't match every release credit), strip links (off by default, so links stay searchable), and commits per repo: from 100 to 100,000 newest (**1,000** by default), or **ALL commits** of every repo (very large repos then cost about one request per 100 commits, and Cancel keeps progress). Release notes are always stored whole. An index built before 1,000 became the default keeps its old 10,000 limit, so upgrading never cuts commits already downloaded. Stripping is applied to the stored notes immediately without any download; keeping what was stripped needs those release notes downloaded again, and the panel says so.
- **📁 Files: what is inside each repo, by its file names.** One request per repo (`GET /repos/{repo}/git/trees/{branch}?recursive=1`) lists every file path; **no file is downloaded**, an unchanged tree answers 304 (free) and only repos pushed since are asked again. **The lists are always complete**: nothing is capped or left out, and a huge repo whose answer GitHub truncates (100,000 entries or 7 MB) is walked folder by folder until every file is listed. The names tell what a repo holds: **🔌 PCB & schematic sources** (KiCad, Altium, EasyEDA, Eagle, Fritzing…), **🏭 Gerbers & fabrication** (Gerber/drill files, BOM, pick-and-place), **📐 schematic PDFs & pinouts**, **📄 datasheets**, **🔧 embedded firmware** (ESP-IDF, PlatformIO, Arduino, Zephyr, Rust embedded, MicroPython, STM32Cube), **🧊 3D CAD models** (STEP, IGES, Fusion 360, FreeCAD, OpenSCAD, SolidWorks…), **🖨 3D meshes & printing** (STL, 3MF, OBJ, glTF, G-code), **📏 2D drawings** (DXF, DWG), **🤖 ML model files**, **📓 notebooks**, **🎮 game projects** (rules adapted from the SLAB github_links file-tree analysis). They show as a **File kinds** block in the sidebar (click to keep only those repos), as clickable chips on each card with the file count, the most common extensions and the build systems, as sort orders (**Most hardware files**, **Most 3D model files**, **Most files**) and in the search: tick *Also search in: Files* to match file names and paths (a match links to the file on GitHub), or use `has:pcb`, `has:hardware`, `has:3d`, `has:cad`, `has:mesh`, `has:firmware`, `has:kicad`, `has:stl`, `has:ml`, `build:platformio`, `build:esp-idf`, `ext:stl`, `path:gerber`, `files:>1000` (with `-` to exclude).
- **Filters & export** by language, topic and owner with live cross-filtered counts, expandable lists, removable active-filter pills, and one-click `.md` / `.json` export of your current matches.
- **Toolbar groups:** *Search in*, *Index*, *View* and *Data*, with how many repos are indexed next to each search option.
- **Live progress for every step.** A panel under the toolbar lists the steps of whatever is running (pull the star list → update repo details → download READMEs → check commits & releases → fetch release notes → fetch commit messages), announced up front as "waiting", each with its own bar, percentage, counts, speed, elapsed time and an estimate of the time left. Commit messages are weighted by how much of each repo is stored, so the bar moves page by page rather than repo by repo. It redraws every 60 ms and ticks twice a second, **■ Cancel** marks the running steps as stopped, and the panel hides itself a few seconds after the job ends.
- **👥 Users: everyone behind your stars.** One big list of every user (and organization) that owns a repo in your stars, with how many of your stars they own, **how many repos they starred themselves**, their followers, and two links per row: **★ Stars on GitHub ↗** (their star list on github.com) and **👁 Visit** (their stars in this app, see below). Sort any column, filter by name, show people or organizations only. Clicking the number of your stars filters the main list to that user. With a token one GraphQL call counts 50 users (about 22 calls for 1,100 users), fetched when you open the panel and refreshed weekly; without a token each user costs one request of the 60 per hour, so counting is manual (up to 25 shown users per click, or one with its *count* link). Organizations can't star anything and are never asked.
- **👁 Visit: explore anyone's stars without saving them.** Click *Visit* on a user, type another name and click **Load stars**, or open `?user=<you>&visit=<them>` (`?visit=<them>` alone works too; naming yourself lets the page compare). Their stars load with the usual cards, search, filters, sorting and Discover, but **nothing of them is saved**: no file in `data/`, nothing in IndexedDB, not in the config. The 💾 box shows *Not saved while visiting* and is locked, a banner says so, and leaving (**← Back**, the browser's Back button, 🗑 Clear cache, closing the tab) throws it all away. A visit downloads only the star list plus last commit / last release (one cheap call per 10 repos); READMEs and the commit index still work during a visit, kept in memory only. **Practical for finding new repos:** every tile of a visit says **★ starred by you** or offers a **☆ Star** button that stars it on your own account (token with starring rights needed); the banner counts how many of their repos you haven't starred yet, **Only repos I haven't starred** hides the rest, and the search understands `is:new` (not starred by you) and `is:mine`. Your stars come from the profile you visited from, your stored copy, or GitHub. Your own profile (and the token) are untouched; **★ Make this my profile** in the banner turns a visit into your profile.
- **Removed, private or hidden repos are kept, unstarred ones are forgotten.** When a repo of your cache is missing from the star list, the app asks GitHub whether it still exists, by its numeric id (so renames, transfers and a name taken over by another repo can't mislead it; GraphQL clears 40 repos per call when it plainly finds them, REST is always the judge, without a token up to 50 requests). It exists: you unstarred it, so it disappears from the list and the cache. GitHub answers *not found*, *unavailable for legal reasons* or *access blocked* (deleted, made private or hidden, taken down): its **local copy is kept**, shown dashed with *🚫 Removed, private or hidden on GitHub*, no longer refreshed or indexed, searchable with `is:removed`; it is checked again at most once a day and becomes a normal repo again if it returns to your list. A repo that can't be verified (rate limit, network) is kept and asked about again at the next check.
- **📜 Activity log, to the right of the progress bars.** A running, millisecond-timestamped account of everything the app does, each line with the **gap since the previous one** (`+71ms`, `+1.4s`) so slow steps stand out. **Every request is logged twice, with the same number**: when it is *sent* (`#12 → GET https://api.github.com/users/you/starred?per_page=100&page=2 · conditional: If-None-Match … (a 304 answer is free) · token attached (never logged)`; a GraphQL call says what it asks, e.g. `asks 10 repositories [a/b, c/d, e/f and 7 more] for: last commit, languages, 12-month commit activity`) and when it is *answered* (`#12 ← … → 200 in 134 ms · core budget 4,971/5,000 left · budget resets 17:22 · the list has 24 pages · ETag … · GitHub request id …`), so parallel requests can be matched. The star-history.com requests and the local server's cache calls (`GET /cache/…`, `PUT /cache/…`) are there too. A check runs in **7 numbered phases** and the progress bars as **numbered steps** (`▶ step 2 of 6`). It also records **what you click and which links you follow**: `🔗 opened in a new tab: https://gitdiagram.com/o/r · “Diagram” · in the repo viewer links`, `🖱 clicked “📝 Commits”`, `⚙ “Hide forks” → ON`, every address-bar change, and the links of the repos it looks at (their GitHub page, README, commits and releases). And what each check decided about each repo (new, renamed, pushed, unstarred, removed or private, kept for a second look), README downloads and skips, the commit and release walks (parallel or one page at a time, slow-downs, retries, what was stored), cache reads and writes (during a visit: kept in memory only), Discover searches, star / unstar calls and the token's health. Controls: **detail** (hide the fine print), **follow** (stops when you scroll up), **Copy**, **Save** a `.txt`, **Clear**. It keeps the last 20,000 lines and is mirrored to the browser's DevTools console. **The token is never written to it.**
- **🚫 Removed or hidden repos are easy to find.** A **🚫 N removed or hidden** chip next to the result count, a *Status* entry in the sidebar, and a tag on each such card all filter the list to the repos that were deleted, made private or hidden (search: `is:removed`). Each such card has a **🗑 Remove** button (two clicks) that deletes its local copy for good — the card, its README, its commit / release index and its file list — so it stops showing anywhere; it only comes back if you star the repo again (only these cards have the button, since a repo that is still on GitHub would just come back at the next check).
- **⧉ Hidden forks: copies GitHub doesn't know about.** Some people copy a repo without forking it (clone and push to a new repo, or upload a downloaded zip), so GitHub never marks it as a fork. The app finds such copies **among your stars, locally and for free** (no request), by comparing every pair of repos of different owners:
  - **shared git history**: a clone pushed elsewhere keeps the original's commits with the same id and date (needs *📝 Commits*; the strongest signal). It counts as a copy only when at least half of the copy's history is the other repo's (at least 10 commits, or 90% of a tiny repo); a smaller overlap (siblings of one upstream, a long-diverged continuation) is only supporting evidence, and a handful of shared commits is none. When an index keeps only the newest commits of a repo, the histories are compared over the period both cover,
  - **README**: near-identical text (MinHash of 4-word shingles over the first 1,500 words; links and badges are left out because a copy rewrites them; needs *📄 READMEs*). Alone it must be at least 90% identical and long enough to mean something; anything weaker needs a second signal. A README that more than two other repos share *without sharing any history* is a template or a vendor example (an ESP-IDF example, an esp-rs or framework starter): repos that each started from it didn't copy each other, so it doesn't count. The clones of a popular original share its commits, so they don't turn its README into a template,
  - **description** (the same About text, or nearly), **name** (ignoring case, `-`, `_`, `.`) and **topics**.

  **Having nothing to say is never a match:** an empty README (or one of only badges, links and markup), an empty description, a placeholder (*TODO*, *No description provided*, *test*…) and a project generator's untouched README or description (Create React App, Flutter, Vite, Next.js, Angular CLI…) count as empty, and a pair needs at least one real content signal (commits, README or description): a name and topics alone never make a copy.

  The evidence adds up; the newer repo of a convincing pair (by creation date: an original that stopped changing is contained in every continuation of it, yet it came first) is the hidden fork of the older one. A copy points at an original that is no fork itself when it can: a copy of a copy, or two copies of one upstream, name the upstream (on equal evidence the older repo), and the tag's tooltip says when the original it matched is itself a copy. Repos of the same owner are never compared, and a repo GitHub already calls a fork stays a normal fork. A copy says **⧉ hidden fork of owner/name** (hover for the evidence, e.g. *shares 949 commits (100% of its history in the period both indexes cover), README 95% identical*); the original says **⧉ N hidden forks**; clicking either shows the original with all its copies. **not a copy?** next to the tag forgets that pair for good. The scan runs in the background, in short slices so the page never freezes, whenever your stars, READMEs or commit index change (6,500 stars: about 4 s the first time, under half a second after; results are logged). It only sees copies of repos you also starred; Discover additionally flags a suggestion with the name and description of an older star as *⧉ looks like a copy of …*.
- **Forks menu** in the toolbar, one persistent choice for both kinds: *Show all repos*, *Hide forks*, *Hide hidden forks*, *Hide forks & hidden forks*, *Only forks*, *Only hidden forks*, *Only forks & hidden forks*, each with its count. The sidebar's *Status* block has **⑂ Forks** and **⧉ Hidden forks** rows that switch to the matching *Only…* choice. Search understands `is:fork` (GitHub's forks), `is:hiddenfork` (or `is:copy`), `is:anyfork` and `is:original`, with `-` to exclude. The hiding choices also apply to Discover: GitHub forks are searched away (`fork:false`) as before, and suggestions that look like copies of your stars are left out. The Users panel counts what the list shows. Exports mark forks and hidden forks (`hiddenForkOf` in JSON).
- **Activity charts** on every card:
  - **Commits:** last 12 months per 2 weeks, counted on GitHub, with the total per year.
  - **Stars:** the **whole timeline**, from the first star to today, as a curve (hover for the count at any time). The data comes from [star-history.com](https://www.star-history.com) in one chart request per repo, avoiding many pages of GitHub history requests. Charts load lazily as cards scroll into view and are cached for a week. If it has no data for a repo, the app's own daily star-count samples are used instead.

  Each bar has a tooltip with its dates and count.
- **✨ Show suggestions** on any starred repo: related repos you haven't starred yet, based on that repo's name and topics, repos whose README mentions it, its most-starred forks and the links in its README.
- **🧭 Discover & suggestions:**
  - **Your themes.** Clusters detected automatically in your stars, for example *scrcpy*, *ReVanced*, *Kokoro TTS*. Pick one to find related repos you haven't starred yet. Suggestions come from:
    - keyword and topic search
    - repos whose README mentions your theme's projects
    - the most-starred forks of those projects
    - links found in your starred READMEs

    Each suggestion shows **why** it was suggested.
  - **Explore any keyword**, e.g. `adb`.
  - **Linked from your READMEs:** repos that several of your stars point to.
  - **Owners you like:** top repos from people you star often.
  - **Patterns:** top topics, what you starred recently, languages, stars per year. Click a topic or language to find related repos and sort them.
  - **☆ Star** a suggestion directly on GitHub (with a one-click **↩ Unstar** undo), or **✕** to never see it again. Either way the next suggestion takes its place.
  - Suggestions never include repos you've starred (checked by name and by GitHub id, so renamed repos can't slip through) or dismissed.
  - When fewer than 12 are left, the next page of every source is fetched automatically, so there's always something to suggest until GitHub runs out of results.
- **Smart updates.** *Check for updates* does as little work as possible:
  - Star-list pages are fetched in parallel. Unchanged pages come back as tiny `304` answers (free with a token) and are rebuilt from the cache.
  - A repo whose `pushed_at` date hasn't changed usually needs no detail request; a periodic max-age check also catches release-only changes.
  - Repos that did change get release, last commit and README **git hash** in batched GraphQL calls, several calls in parallel.
  - A README is downloaded again only if its hash changed; a changed one replaces the cached entry.
  - Commit messages and release notes (once indexed) are topped up the same way: only commits newer than the ones stored, and releases only when their count or newest tag changed.

## GitHub token (recommended)

Without a token GitHub allows **60 requests/hour**, enough to list stars but not to index READMEs, commits or releases.

**GitHub's budgets (rate limits), shown live by the ⛽ indicator next to the status line.** They are **per hour, not per day**, and each kind has its own:

| Budget | With a token | Without | Used by |
|---|---|---|---|
| REST (`core`) | 5,000 requests / hour | 60 / hour (per IP address) | star list, 📁 file lists, READMEs without a token |
| GraphQL | 5,000 points / hour | none | details, READMEs, 📝 commits, 🏷 releases, Users |
| Search | 30 / minute | 10 / minute | Discover |

A window opens with the first request after the previous one ended and lasts one hour; GitHub gives the exact second it refills (`x-ratelimit-reset`). The budget belongs to the **token** (or your IP address), so other tabs, scripts such as `slab_stars.py` or the `gh` CLI, and earlier visits of this page use the same budget: the app reads the real numbers from `GET /rate_limit` (free, it counts against nothing) when the page opens and before every pull, then follows every answer's `x-ratelimit-*` headers. Hover ⛽ for each budget and its refill time; click it to read them again. **A long pull that runs out does not stop**: it waits for the refill with a countdown in the status line (**■ Cancel** stops the wait; progress is kept) and continues by itself. Example: 6,594 file lists need 6,594 REST requests, so with 5,000 an hour the pull pauses once, for whatever is left of that hour.
Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) or [classic token](https://github.com/settings/tokens/new) and paste it into the **🔑 GitHub token** panel.

| You want to… | Fine-grained token (recommended) | Classic token |
|---|---|---|
| Browse, search, READMEs, commits, releases, suggestions | **Public Repositories (read-only)** | **none** |
| Also use the **☆ Star** buttons | Account permissions → **Starring: Read and write** | **`public_repo`** |

The token is only ever sent to `api.github.com`. Where it's stored depends on how you run the app (see below).

## Two ways to run it: same code, different cache

| | Online (GitHub Pages) | Local |
|---|---|---|
| How | open the link above | double-click `start.bat` (Windows) or run `node server.js --open` |
| **💾 Keep cache** ON stores stars, READMEs, commits & releases, suggestions and your token in… | this browser (IndexedDB) | JSON files in the **`data/`** folder next to the app |
| Needs | a browser | [Node.js](https://nodejs.org) 20+ (nothing to install from npm) |

### The cache

- **💾 Keep cache is OFF by default** everywhere: nothing is stored, the data (and your token) live in the open tab only. Switch it on and a **cookie** remembers the choice for next time. Switching it on loads what is already stored for the profile (stored data wins), or saves what this tab has if nothing is stored yet. Switching it off leaves files in `data/` untouched; online it erases the browser copy. Either way the open tab keeps everything it has, so loading the profile again doesn't start from nothing.
- **🗑 Clear cache** (two clicks) deletes *all* stored data: the `data/` files (through the local server), this browser's IndexedDB, the app's preferences and the token, and empties the open tab.
- **Format.** One JSON file (or IndexedDB record) per kind and profile: `config`, `stars:<user>`, `readmes:<user>`, `discover:<user>`, `users:<user>`, `starcurves`, the commit / release index in 256 shards `history:<user>:<0-255>`, and the file lists in 64 shards `files:<user>:<0-63>`. The local server gzip-compresses files of 64 KB or more (about 3x smaller; it reads plain files too); IndexedDB keeps uncompressed copies.
- **Visits are never stored.** While you visit someone, every cache key except the config lives in a memory map that is emptied when the visit ends (`store.js`: one rule in `get()` / `put()`, the only door to storage). A visit doesn't even read a copy of that profile saved earlier. The config keeps *your* login, so a visited profile never becomes the next start's profile. As a second guard, keys of a visited profile are refused for the rest of the session unless you adopt it. Nothing is saved either while a profile is still being read, so a click during loading can't write the old profile's data under the new name.
- **Never overwrites what it couldn't read.** If a stored file can't be read (server hiccup, damaged file, a file another program keeps locked), the app treats it as unreadable instead of "empty" and refuses to save over it until a reload reads it successfully, so a bad moment can't wipe a good cache. Likewise, toolbar jobs only start once a profile's cache has been read completely, so a click while it loads can't save half-loaded data.
- **Bounded size.** Discover results older than 30 days (and all but the newest 40) and star charts nobody looked at for 60 days are dropped when the cache is saved.
- **Unstarred repos are forgotten carefully.** A repo missing from one star-list check leaves your list at once, but its README and commit index are dropped only when a second check in a row agrees: the pages are fetched in parallel, and one glitch must not delete an index that cost many requests.
- **Updates replace, never duplicate.** The star list is rebuilt from fresh pages; a README entry is replaced when its hash changed; commit messages never change, so only new ones are added (a walk from the new head down to the first stored commit; a rewritten history replaces them); a repo's releases are replaced as a whole when their count, newest release (tag, created, updated) changed or after 30 days. Every walk can stop at any point and continue later from what is stored.

### Running locally

```bash
git clone https://github.com/NairoDorian/Github_Stars_Viewer.git
cd Github_Stars_Viewer
node server.js --open        # or: npm start   ·   Windows: double-click start.bat
```

Then use <http://localhost:8787> (set `PORT` to change the port). Keep the server window open while you use the app.
Opening `public/index.html` directly as a file doesn't work, because browsers don't run JavaScript modules from `file://`.

Cache files of 64 KB or more are stored gzip-compressed (about 3x smaller), and the commit / release index is split into 256 small shards so a save only rewrites what changed. Only one tab or window may sync a profile at a time (a Web Lock), so two tabs can't overwrite each other's progress.

**Indexing speed.** Commit messages and release notes are fetched from continuous work queues (no waiting for slow repos), releases and commits at the same time, and the pages of one big repo in parallel by offset cursor. That trick is verified for every repo and falls back to one page at a time if GitHub's cursors ever behave differently; if GitHub asks to slow down, the run waits and continues with fewer parallel requests.

The local server listens on `127.0.0.1` only (the data folder can be moved with the `STARS_DATA` environment variable). It refuses requests from other websites, including DNS-rebinding tricks, so no web page can read your cached token, and no site can show the app inside a frame to trick clicks into it. It writes cache files atomically, so they can't be corrupted.

The local server also removes temp files that a crash left behind in `data/`.

Run `npm run check` to syntax-check and run unit tests for the server and all browser modules on Windows, macOS or Linux. `npm run e2e` (`node scripts/e2e.mjs`) runs an optional end-to-end test in your installed Chrome against a fake GitHub and an in-memory cache (needs Playwright: `npm i --no-save playwright`); it never touches your real cache.

## Project layout

```
public/            the app (this folder is what GitHub Pages publishes)
  index.html       markup
  app.css          styles (dark/light follows your OS)
  js/
    main.js        boot, loading a profile (yours or a visit), toolbar wiring
    state.js       shared state & cancellation generation
    store.js       cache backends: ./data via server.js · IndexedDB · memory · visit memory
    github.js      GitHub REST/GraphQL client (retries, rate limits, cancellation)
    budget.js      GitHub's budgets: learned from every answer and /rate_limit, refill times, waiting for a refill
    sync.js        keeping the cache in sync with GitHub, cheaply
    history.js     every commit message and release note of every star, fetched incrementally
    pullmenus.js   the ▾ menus of the four Pull buttons: options and 🗑 clear per category
    files.js       the file list (names only) of every star, fetched with ETags
    filekinds.js   what file names say about a repo: PCB sources, 3D models, firmware…
    progress.js    the live progress panel: one bar per step with counts, speed and time left
    list.js        search, qualifiers, cross-filtered facets, export, repo cards
    sort.js        shared repository sorting comparators
    starhistory.js lazy star-history.com chart loader & SVG curve parser
    discover.js    themes, suggestions, star/unstar buttons
    forks.js       hidden forks (copies GitHub doesn't mark as forks) and the Forks menu
    log.js         the activity log: ring buffer, panel, copy / save
    users.js       the 👥 Users panel: owners of your stars, their own star counts, Visit links
    token.js       the 🔑 token panel
    util.js        helpers
scripts/
  check.cjs        cross-platform syntax + unit test runner
  test.mjs         Node built-in unit test suite
  test-history.mjs commit / release indexing, tiles, options and sharding, tested against a fake GitHub GraphQL endpoint
  test-readme.mjs  README fetching: never trimmed, replaced when changed, legacy cut ones repaired
  test-store.mjs   the 💾 Keep cache toggle (cookie), saving everything, clearing everything
  test-progress.mjs the progress panel
  test-sync.mjs      the star list: conditional pages, unstarred / renamed repos, failed pages, the light check of a visit
  test-log.mjs       the activity log: format, ring buffer, escaping, request lines, no token
  test-stamp.mjs     the deploy's version stamp on every file URL (no mix of old and new files in a browser's cache)
  test-users.mjs     the Users list: owners, sorting, filtering, GraphQL / REST star counts
  test-visit.mjs     Visit mode: nothing but the config is ever written, leaving forgets everything
  test-forks.mjs     hidden forks: shared commits, README, description and name; templates, the Forks menu, search qualifiers
  e2e.mjs          optional browser test (Playwright) against fakes
server.js          local server: serves public/ and stores the cache in data/
start.bat          Windows launcher
data/              local cache (git-ignored: contains your token)
.github/workflows/pages.yml   tests, then deploys public/ to GitHub Pages on every push to main (scripts/stamp.cjs puts the commit on every file URL first,
                               so a browser's 10-minute cache can never mix files of two deploys)
```

## License

MIT
