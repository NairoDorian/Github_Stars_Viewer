// Shared app state: one object so every module reads and writes the same live values.

export const S = {
  user: '',          // GitHub login whose stars are shown
  token: '',         // GitHub token (saved in data/config.json)
  repos: [],         // starred repos, shape built by mapStar() in github.js
  starPages: [],     // [{etag, ids}] per star-list page, for conditional (304) re-fetches
  readmes: {},       // {<repo id>: {t: text, sha, path, etag, at, pushed}}
  disc: {dismissed: [], results: {}},   // discovery cache (see discover.js)
  gen: 0,            // bumped when the user changes: running jobs compare it and stop without saving
};

export const ukey = () => S.user.toLowerCase();

/** Cache key of a repo: GitHub's numeric id (survives renames/transfers). Old caches without id fall back to "owner/name". */
export const rkey = r => String(r.id ?? r.full);

export const readmeEntry = r => S.readmes[rkey(r)];
export const readmeText = r => readmeEntry(r)?.t || '';

// Lower-cased README text, computed once per README version (entries are replaced when a README changes),
// so searching doesn't lowercase ~10 MB of text on every keystroke.
const lowerCache = new WeakMap();
export function readmeLower(r) {
  const e = readmeEntry(r);
  if (!e?.t) return '';
  let low = lowerCache.get(e);
  if (low === undefined) lowerCache.set(e, low = e.t.toLowerCase());
  return low;
}

export const starredSet = () => new Set(S.repos.map(r => r.full.toLowerCase()));
