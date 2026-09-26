# ★ GitHub Stars Viewer

Browse, search and get smart suggestions from **any GitHub user's starred repositories**, all on one fast page.

**▶ Use it online:** https://nairodorian.github.io/Github_Stars_Viewer/
(open a specific profile with `?user=<name>`, e.g. [`?user=NairoDorian`](https://nairodorian.github.io/Github_Stars_Viewer/?user=NairoDorian))

No build step and no dependencies. The same code runs online (GitHub Pages) or locally with a tiny Node server.

## Features

- **All stars at once.** Every page of the star list is fetched in parallel, then cached so reopening is instant.
- **Rich cards everywhere.** Starred repos and Discover suggestions share the same layout: About text, owner, stars, forks, open issues, license, **every language with its share**, topics, homepage, creation date, **🕒 last commit**, latest release and activity charts. Starred cards also show when you starred them; suggestion cards show why they were recommended.
- **Sort** your stars by recently starred, most or fewest stars, last commit, last release, name, owner or newest repo. Every Discover result also has sorting, with **Best match** as its default. Exact release and commit sorting across suggestions needs a token.
- **Search** name, owner, description and topics, with highlighting. Press `/` to focus the search box.
- **Search inside READMEs.** Click *Index READMEs* once, then tick *Search in READMEs*. Matches show a snippet.
- **Filters** by language, topic and owner.
- **Activity charts** on every card:
  - **Commits:** last 12 months per 2 weeks, counted on GitHub, with the total per year.
  - **Stars:** the **whole timeline**, from the first star to today, as a curve (hover for the count at any time). The data is the full star history from [star-history.com](https://www.star-history.com), which keeps its own copy of star data now that GitHub no longer shares star dates. Charts load lazily as cards scroll into view and are cached for a week. If it has no data for a repo, the app's own daily star-count samples are used instead.

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
  - **☆ Star** a suggestion directly on GitHub, or **✕** to never see it again. Either way the next suggestion takes its place.
  - Suggestions never include repos you've starred (checked by name and by GitHub id, so renamed repos can't slip through) or dismissed.
  - When fewer than 12 are left, the next page of every source is fetched automatically, so there's always something to suggest until GitHub runs out of results.
- **Smart updates.** *Check for updates* does as little work as possible:
  - Star-list pages are fetched in parallel. Unchanged pages come back as tiny `304` answers (free with a token) and are rebuilt from the cache.
  - A repo whose `pushed_at` date hasn't changed is skipped: no request at all.
  - Repos that did change get release, last commit and README **git hash** in batched GraphQL calls, several calls in parallel.
  - A README is downloaded again only if its hash changed.

## GitHub token (recommended)

Without a token GitHub allows **60 requests/hour**, enough to list stars but not to index READMEs or fetch releases.
Create a classic token at <https://github.com/settings/tokens/new> and paste it into the **🔑 GitHub token** panel.

| You want to… | Scopes to tick |
|---|---|
| Browse, search, READMEs, releases, suggestions | **none** |
| Also use the **☆ Star** buttons | **`public_repo`** (GitHub has no star-only scope) |

The token is only ever sent to `api.github.com`. Where it's stored depends on how you run the app (see below).

## Two ways to run it: same code, different cache

| | Online (GitHub Pages) | Local |
|---|---|---|
| How | open the link above | double-click `start.bat` (Windows) or run `node server.js --open` |
| Cache (stars, READMEs, suggestions, token) | **💾 Keep cache in this browser** toggle: **on** saves everything in the browser (IndexedDB); **off** keeps it in the open tab only | JSON files in the **`data/`** folder next to the app |
| Needs | a browser | [Node.js](https://nodejs.org) 18+ (nothing to install from npm) |

Turning the 💾 toggle off erases what this app stored in your browser.

### Running locally

```bash
git clone https://github.com/NairoDorian/Github_Stars_Viewer.git
cd Github_Stars_Viewer
node server.js --open        # or: npm start   ·   Windows: double-click start.bat
```

Then use <http://localhost:8787> (set `PORT` to change the port). Keep the server window open while you use the app.
Opening `public/index.html` directly as a file doesn't work, because browsers don't run JavaScript modules from `file://`.

The local server listens on `127.0.0.1` only. It refuses requests from other websites, including DNS-rebinding tricks, so no web page can read your cached token. It writes cache files atomically, so they can't be corrupted.

## Project layout

```
public/            the app (this folder is what GitHub Pages publishes)
  index.html       markup
  app.css          styles (dark/light follows your OS)
  js/
    main.js        boot, loading a user, toolbar wiring
    state.js       shared state
    store.js       cache backends: ./data via server.js · IndexedDB · memory
    github.js      GitHub REST/GraphQL client (retries, rate limits)
    sync.js        keeping the cache in sync with GitHub, cheaply
    list.js        search, filters, sorting, repo cards
    discover.js    themes, suggestions, star buttons
    token.js       the 🔑 token panel
    util.js        helpers
server.js          local server: serves public/ and stores the cache in data/
start.bat          Windows launcher
data/              local cache (git-ignored: contains your token)
.github/workflows/pages.yml   deploys public/ to GitHub Pages on every push to main
```

## License

MIT
