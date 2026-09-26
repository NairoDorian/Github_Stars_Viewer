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

/** Keep saved rules valid after an app update, with no repeated criterion. */
export function normalizeSortKeys(saved, allowed, defaultKey) {
  const keys = Array.isArray(saved) ? saved : [saved];
  const valid = [...new Set(keys.filter(k => allowed.includes(k)))];
  return valid.length ? valid : [defaultKey];
}

export function loadSortKeys(storageKey, allowed, defaultKey, legacyKey = null) {
  try {
    const saved = localStorage.getItem(storageKey);
    return normalizeSortKeys(saved ? JSON.parse(saved) : legacyKey && localStorage.getItem(legacyKey), allowed, defaultKey);
  } catch { return [defaultKey]; }
}

/** The first rule has highest priority; later rules break ties in order. */
export function sortEditorHTML(keys, allowed) {
  const options = SORT_OPTIONS.filter(([k]) => allowed.includes(k));
  return `<span class="sort-caption">Sort</span>${keys.map((selected, i) => `<span class="sort-rule">
    <span class="sort-priority" title="Priority ${i + 1}">${i + 1}</span>
    <select data-sort-index="${i}" aria-label="Sort priority ${i + 1}">${options.filter(([k]) => k === selected || !keys.includes(k))
      .map(([k, label]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${label}</option>`).join('')}</select>
    ${keys.length > 1 ? `<button type="button" data-sort-action="up" data-sort-index="${i}" aria-label="Move sort ${i + 1} up"${i === 0 ? ' disabled' : ''}>↑</button>
      <button type="button" data-sort-action="down" data-sort-index="${i}" aria-label="Move sort ${i + 1} down"${i === keys.length - 1 ? ' disabled' : ''}>↓</button>
      <button type="button" data-sort-action="remove" data-sort-index="${i}" aria-label="Remove sort ${i + 1}">×</button>` : ''}</span>`).join('')}
    ${keys.length < allowed.length ? '<button type="button" data-sort-action="add" aria-label="Add another sort criterion">+ Sort</button>' : ''}`;
}

export function editSortKeys(keys, action, index, selected, allowed) {
  const next = [...keys];
  if (action === 'add') {
    const unused = allowed.find(k => !next.includes(k));
    if (unused) next.push(unused);
  } else if (index >= 0 && index < next.length) {
    if (action === 'change' && allowed.includes(selected) && !next.includes(selected)) next[index] = selected;
    else if (action === 'remove' && next.length > 1) next.splice(index, 1);
    else if (action === 'up' && index > 0) [next[index - 1], next[index]] = [next[index], next[index - 1]];
    else if (action === 'down' && index < next.length - 1) [next[index + 1], next[index]] = [next[index], next[index + 1]];
  }
  return next;
}

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
    case 'owner': return (typeof r.owner === 'string' ? r.owner : r.owner?.login || r.full_name?.split('/')[0] || '').toLowerCase();
  }
  return null;
};

export function sortRepos(items, keys, fallback = 'name') {
  const order = Array.isArray(keys) ? keys : [keys];
  return items.sort((a, b) => {
    for (const key of order) {
      const x = value(a, key), y = value(b, key);
      if (x == null && y != null) return 1;
      if (y == null && x != null) return -1;
      if (x != null && y != null && x !== y) {
        const direction = key === 'name' || key === 'owner' || key === 'starsAsc' ? 1 : -1;
        return (x < y ? -1 : 1) * direction;
      }
    }
    // Equal values retain a predictable order even after new details arrive.
    const ax = value(a, fallback) || '', bx = value(b, fallback) || '';
    if (ax !== bx) return ax < bx ? -1 : 1;
    const af = (a.x || a.r || a).full_name || (a.x || a.r || a).full || '';
    const bf = (b.x || b.r || b).full_name || (b.x || b.r || b).full || '';
    return af < bf ? -1 : af > bf ? 1 : 0;
  });
}
