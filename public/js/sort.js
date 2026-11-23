// One set of ordering rules for starred repos and discovery results.
// Missing dates and counts sort after known values, with a stable name tie-breaker. "Last commit" uses the commit date
// and falls back to the last push only while that date isn't fetched (the card then says "last push"); "Last release"
// is the newest release by date, pre-releases included, like the card's tile.
export const SORT_OPTIONS = [
  ['relevance', 'Best match'],
  ['starred', 'Recently starred'],
  ['stars', 'Most stars'],
  ['starsAsc', 'Fewest stars'],
  ['commit', 'Last commit'],
  ['release', 'Last release'],
  ['name', 'Name A–Z'],
  ['owner', 'Owner A–Z'],
  ['created', 'Newest repo'],
  ['hardware', 'Most hardware files'],
  ['models3d', 'Most 3D model files'],
  ['files', 'Most files'],
];
/** Sort orders that only make sense for your own stars (they need the file lists): Discover leaves them out. */
export const STARS_ONLY = new Set(['starred', 'hardware', 'models3d', 'files']);
/** Values computed elsewhere, by key: list.js registers the file-based ones (sort.js imports nothing). */
export const EXTRA_VALUES = {};

const value = (repo, key) => {
  const r = repo.x || repo.r || repo;
  if (EXTRA_VALUES[key]) return EXTRA_VALUES[key](r);
  switch (key) {
    case 'relevance': return repo.score;
    case 'starred': return Date.parse(r.starred || '') || null;
    case 'stars': case 'starsAsc': return r.stars ?? r.stargazers_count ?? null;
    case 'commit': return Date.parse(r.commitAt || r.pushed || r.pushed_at || '') || null;
    case 'release': return Date.parse(r.releaseAt || '') || null;
    case 'created': return Date.parse(r.created || r.created_at || '') || null;
    case 'name': return (r.name || r.full_name?.split('/')[1] || '').toLowerCase();
    // Starred cards store an owner login; discovery candidates store the REST/GraphQL owner object.
    case 'owner': return (typeof r.owner === 'string' ? r.owner : r.owner?.login || r.full_name?.split('/')[0] || '').toLowerCase();
  }
  return null;
};

/** Sorts `items` in place (and returns them). Every item's value is read once, not at every comparison: a list of
 *  thousands is compared tens of thousands of times, and a value can be a date to parse or a count to add up. */
export function sortRepos(items, key, fallback = 'name') {
  const direction = key === 'name' || key === 'owner' || key === 'starsAsc' ? 1 : -1;
  const rows = items.map(item => ({item, v: value(item, key), f: value(item, fallback) || ''}));
  rows.sort((a, b) => {
    const x = a.v, y = b.v;
    if (x == null && y != null) return 1;
    if (y == null && x != null) return -1;
    if (x != null && y != null && x !== y) return (x < y ? -1 : 1) * direction;
    // Equal values retain a predictable order even after new details arrive.
    return a.f < b.f ? -1 : a.f > b.f ? 1 : 0;
  });
  for (let i = 0; i < rows.length; i++) items[i] = rows[i].item;
  return items;
}
