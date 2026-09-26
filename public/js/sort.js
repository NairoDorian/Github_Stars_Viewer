// One set of ordering rules for starred repos and discovery results.
// Missing dates and counts sort after known values, with a stable name tie-breaker.
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
];

const value = (repo, key) => {
  const r = repo.x || repo.r || repo;
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

export function sortRepos(items, key, fallback = 'name') {
  const direction = key === 'name' || key === 'owner' || key === 'starsAsc' ? 1 : -1;
  return items.sort((a, b) => {
    const x = value(a, key), y = value(b, key);
    if (x == null && y != null) return 1;
    if (y == null && x != null) return -1;
    if (x != null && y != null && x !== y) return (x < y ? -1 : 1) * direction;
    // Equal values retain a predictable order even after new details arrive.
    const ax = value(a, fallback) || '', bx = value(b, fallback) || '';
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  });
}
