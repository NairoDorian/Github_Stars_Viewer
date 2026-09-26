# ★ GitHub Stars Viewer

Browse, search and get smart suggestions from **any GitHub user's starred repositories**, all on one fast page.

**▶ Use it online:** https://nairodorian.github.io/Github_Stars_Viewer/
(open a specific profile with `?user=<name>`, e.g. [`?user=NairoDorian`](https://nairodorian.github.io/Github_Stars_Viewer/?user=NairoDorian))

No build step and no dependencies. The same code runs online (GitHub Pages) or locally with a tiny Node server.

## Features

- **All stars at once.** Every page of the star list is fetched in parallel, then cached so reopening is instant.
- **Rich cards.** About text, owner, stars, forks, license, **every language with its share** (GitHub-style colored bar), topics, homepage, last commit, latest release and when you starred it.
- **Sort** by recently starred, most stars, last commit, last release, name or newest repo.
- **Search** name, owner, description and topics, with highlighting. Press `/` to focus the search box.
- **Search inside READMEs.** Click *Index READMEs* once, then tick *Search in READMEs*. Matches show a snippet.
- **Filters** by language, topic and owner.
- **Activity charts** on every card (last 12 months, per 2 weeks):
  - **Commits:** counted on GitHub, with the total per year.
  - **Stars:** growth recorded by the app. GitHub no longer shares when people starred a repo, so each check saves every repo's star count once a day, and the chart fills in over time.

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
  - **Patterns:** top topics, what you starred recently, languages, stars per year.
  - **☆ Star** a suggestion directly on GitHub, or **✕** to never see it again. Either way the next suggestion takes its place.
  - Suggestions never include repos you've starred (checked by name and by GitHub id, so renamed repos can't slip through) or dismissed.
  - When fewer than 12 are left, the next page of every source is fetched automatically, so there's always something to suggest until GitHub runs out of results.
- **Smart updates.** *Check for updates* does as little work as possible:
  - Star-list pages are fetched in parallel. Unchanged pages come back as tiny `304` answers (free with a token) and are rebuilt from the cache.
  - A repo whose `pushed_at` date hasn't changed is skipped: no request at all.
  - Repos that did change get release, last commit and README **git hash** in one batched GraphQL call, 20 repos per call, several calls in parallel.
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
