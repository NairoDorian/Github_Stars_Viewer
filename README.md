# ★ GitHub Stars Viewer

Browse, search and get smart suggestions from **any GitHub user's starred repositories**, all on one fast page.

**▶ Use it online:** https://nairodorian.github.io/Github_Stars_Viewer/
(open a specific profile with `?user=<name>`, e.g. [`?user=NairoDorian`](https://nairodorian.github.io/Github_Stars_Viewer/?user=NairoDorian))

No build step and no dependencies. The same code runs online (GitHub Pages) or locally with a tiny Node server.

## Features

- **All stars at once.** Every page of the star list is fetched in parallel, then cached so reopening is instant.
- **Last commit and last release on every card.** *Last commit* is the head of the default branch; *last release* is the **newest release by publish date, pre-releases included** (flagged, with GitHub's own "Latest" in the tooltip when it differs, as with backport lines). A repo without releases says so; a push date is never shown as a commit. With a token both are refreshed on every update check (40 repos per request), and the Last commit / Last release sorts use the same values.
- **Rich cards everywhere.** Starred repos and Discover suggestions share the same layout: About text, owner, stars, forks, open issues and pull requests (one number, the same on both kinds of card), license, **every language with its share**, topics, homepage, creation date, **🕒 last commit**, **🏷 last release** and activity charts. Starred cards also show when you starred them; suggestion cards show why they were recommended.
- **More ways to view every repo.** Compact links on every card open GitDiagram, DeepWiki, GitIngest, UIthub, github.dev, and GitHistory. GitHistory animates a file rather than a whole repository; its link opens the cached README path when known, otherwise `README.md`.
- **Sort** your stars by recently starred, most or fewest stars, last commit, last release, name, owner or newest repo. Every Discover result also has sorting, with **Best match** as its default. Exact release and commit sorting across suggestions needs a token.
- **Search** name, owner, description and topics, with highlighting, exact phrases (`"screen copy"`), exclusions (`-flutter`), and qualifiers (`lang:rust`, `owner:foo`, `topic:cli`, `is:active`, `is:archived`, `is:fork`, `stars:>1000`). Press `/` to focus the search box.
- **Search inside READMEs.** Click *Index READMEs* once, then tick *Search in READMEs*. Matches show a snippet. READMEs are the first source of information and are **never trimmed**: they are stored whole, however long, and a README is downloaded again only when its git hash changed (older caches that cut READMEs at 100,000 characters are repaired automatically). `README.md`, `readme.md`, `Readme.md`, `.markdown`, `.rst`, `.txt` and extension-less `README` files are found in the same cheap batched calls; any other name costs one extra request.
- **Search inside commit messages and release notes.** Click *Index commits & releases* once (needs a token), then tick *Search in commits & releases*. It downloads **every commit message** (subject and body, each kept up to 400 characters; the newest 10,000 per repo by default, or all) and **every release** (tag, title and notes; up to 5,000 per repo) of every star, but never any code. Matches show the commit or release with a link to it on GitHub, and each term of a query may match in a different place: a README, a commit, a release, or the card itself. Later checks are incremental: a cheap check per 40 repos, then only the new commits and releases are downloaded, and an interrupted run (**■ Cancel**, a rate limit, a closed tab) continues where it stopped, with progress saved batch by batch.
  The **▾** next to the button opens the index options (collapsed by default): strip `@mentions` from release notes (on by default, so a username doesn't match every release credit), strip links (off by default, so links stay searchable), release-notes length and commits per repo, each with a **no limit** choice (entire release notes, ALL commit messages of a repo; very large repos then cost about one request per 100 commits, and Cancel keeps progress). Stripping is applied to the stored notes immediately without any download; keeping what was stripped needs those release notes downloaded again, and the panel says so.
- **Filters & export** by language, topic and owner with live cross-filtered counts, expandable lists, removable active-filter pills, and one-click `.md` / `.json` export of your current matches.
- **Toolbar groups:** *Search in*, *Index*, *View* and *Data*, with how many repos are indexed next to each search option.
- **Live progress for every step.** A panel under the toolbar lists the steps of whatever is running (pull the star list → update repo details → download READMEs → check commits & releases → fetch release notes → fetch commit messages), announced up front as "waiting", each with its own bar, percentage, counts, speed, elapsed time and an estimate of the time left. Commit messages are weighted by how much of each repo is stored, so the bar moves page by page rather than repo by repo. It redraws every 60 ms and ticks twice a second, **■ Cancel** marks the running steps as stopped, and the panel hides itself a few seconds after the job ends.
- **Hide forks** in both your starred repos and Discover suggestions with one persistent toolbar toggle. Existing cached suggestions are filtered immediately; when too few non-forks remain, Discover searches for more and skips fork-specific sources. The toggle uses GitHub's fork designation.
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
| Needs | a browser | [Node.js](https://nodejs.org) 18+ (nothing to install from npm) |

### The cache

- **💾 Keep cache is OFF by default** everywhere: nothing is stored, the data (and your token) live in the open tab only. Switch it on and a **cookie** remembers the choice for next time. Switching it on loads what is already stored for the profile (stored data wins), or saves what this tab has if nothing is stored yet. Switching it off leaves files in `data/` untouched; online it erases the browser copy.
- **🗑 Clear cache** (two clicks) deletes *all* stored data: the `data/` files (through the local server), this browser's IndexedDB, the app's preferences and the token, and empties the open tab.
- **Format.** One JSON file (or IndexedDB record) per kind and profile: `config`, `stars:<user>`, `readmes:<user>`, `discover:<user>`, `starcurves`, and the commit / release index in 256 shards `history:<user>:<0-255>`. The local server gzip-compresses files of 64 KB or more (about 3x smaller; it reads plain files too); IndexedDB keeps uncompressed copies.
- **Never overwrites what it couldn't read.** If a stored file can't be read (server hiccup, damaged file), the app treats it as unreadable instead of "empty" and refuses to save over it until a reload reads it successfully, so a bad moment can't wipe a good cache.
- **Bounded size.** Discover results older than 30 days (and all but the newest 40) and star charts nobody looked at for 60 days are dropped when the cache is saved.
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

The local server listens on `127.0.0.1` only (the data folder can be moved with the `STARS_DATA` environment variable). It refuses requests from other websites, including DNS-rebinding tricks, so no web page can read your cached token. It writes cache files atomically, so they can't be corrupted.

Run `npm run check` to syntax-check and run unit tests for the server and all browser modules on Windows, macOS or Linux. `node scripts/e2e.mjs` runs an optional end-to-end test in your installed Chrome against a fake GitHub and an in-memory cache (needs Playwright: `npm i --no-save playwright`); it never touches your real cache.

## Project layout

```
public/            the app (this folder is what GitHub Pages publishes)
  index.html       markup
  app.css          styles (dark/light follows your OS)
  js/
    main.js        boot, loading a user, toolbar wiring
    state.js       shared state & cancellation generation
    store.js       cache backends: ./data via server.js · IndexedDB · memory
    github.js      GitHub REST/GraphQL client (retries, rate limits, cancellation)
    sync.js        keeping the cache in sync with GitHub, cheaply
    history.js     every commit message and release note of every star, fetched incrementally
    histopts.js    the ▾ options panel of the commit & release index
    progress.js    the live progress panel: one bar per step with counts, speed and time left
    list.js        search, qualifiers, cross-filtered facets, export, repo cards
    sort.js        shared repository sorting comparators
    starhistory.js lazy star-history.com chart loader & SVG curve parser
    discover.js    themes, suggestions, star/unstar buttons
    token.js       the 🔑 token panel
    util.js        helpers
scripts/
  check.cjs        cross-platform syntax + unit test runner
  test.mjs         Node built-in unit test suite
  test-history.mjs commit / release indexing, tiles, options and sharding, tested against a fake GitHub GraphQL endpoint
  test-readme.mjs  README fetching: never trimmed, replaced when changed, legacy cut ones repaired
  test-store.mjs   the 💾 Keep cache toggle (cookie), saving everything, clearing everything
  test-progress.mjs the progress panel
  test-sync.mjs      the star list: conditional pages, unstarred / renamed repos, failed pages
  e2e.mjs          optional browser test (Playwright) against fakes
server.js          local server: serves public/ and stores the cache in data/
start.bat          Windows launcher
data/              local cache (git-ignored: contains your token)
.github/workflows/pages.yml   deploys public/ to GitHub Pages on every push to main
```

## License

MIT
