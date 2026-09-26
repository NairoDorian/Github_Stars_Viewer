// GitHub API access: REST + GraphQL, with retries, rate-limit handling and data mapping.
import {S} from './state.js';
import {sleep, pool, chunks} from './util.js';

const API = 'https://api.github.com';

export const headers = extra => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',   // pin the REST API version so future GitHub changes don't break parsing
  ...(S.token ? {Authorization: 'Bearer ' + S.token} : {}),
  ...extra,
});

/** Asks the UI to show the token panel (token.js listens), without importing UI code here. */
export const needToken = () => window.dispatchEvent(new CustomEvent('need-token'));

/**
 * fetch() with retries for transient failures: network errors, 5xx, and GitHub's secondary rate limit
 * (403/429 with Retry-After ≤ 60s). Returns the Response; callers decide what other statuses mean.
 */
export async function ghFetch(url, init = {}, tries = 3) {
  for (let i = 0; ; i++) {
    let r;
    try { r = await fetch(url.startsWith('http') ? url : API + url, init); }
    catch (e) {
      if (i >= tries - 1) throw new Error('Network error: are you online?');
      await sleep(500 * 2 ** i); continue;
    }
    const retryAfter = Number(r.headers.get('retry-after')) || 0;
    const transient = r.status >= 500 || ((r.status === 403 || r.status === 429) && retryAfter > 0 && retryAfter <= 60);
    if (transient && i < tries - 1) { await sleep(retryAfter ? retryAfter * 1000 : 500 * 2 ** i); continue; }
    return r;
  }
}

/** REST GET. Throws on auth / rate-limit / unexpected errors; returns the response for 2xx, 304 and 404. */
export async function gh(path, extraHeaders) {
  const r = await ghFetch(path, {headers: headers(extraHeaders)});
  if (r.status === 401) { needToken(); throw new Error('Token rejected by GitHub. Update it in the 🔑 panel.'); }
  if (r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')) {
    if (!S.token) needToken();
    const reset = r.headers.get('x-ratelimit-reset');
    throw new Error('Rate limited' + (S.token ? '' : ', add a token') + (reset ? ` (resets ${new Date(reset * 1000).toLocaleTimeString()})` : ''));
  }
  if (!r.ok && r.status !== 404 && r.status !== 304) throw new Error('GitHub ' + r.status);
  return r;
}

/** GraphQL query → data. Partial results (some repos missing/private) come back as null entries, not errors. */
export async function gql(query) {
  const r = await ghFetch('/graphql', {method: 'POST', headers: headers(), body: JSON.stringify({query})});
  if (r.status === 401) { needToken(); throw new Error('Token rejected by GitHub. Update it in the 🔑 panel.'); }
  if (!r.ok) throw new Error('GraphQL ' + r.status + (r.status === 403 ? ' (rate limited)' : ''));
  const body = await r.json();
  if (!body.data) throw new Error('GraphQL: ' + (body.errors?.[0]?.message || 'no data'));
  return body.data;
}

/** One aliased `repository(...)` block for batched GraphQL queries. */
export const repoQ = (alias, owner, name, fields) =>
  `${alias}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${fields}}`;

/** REST "starred" item (star+json media type) → the compact repo shape stored in the cache. */
export const mapStar = ({starred_at, repo: x}) => ({
  id: x.id, full: x.full_name, name: x.name, owner: x.owner.login, avatar: x.owner.avatar_url, url: x.html_url,
  about: x.description || '', homepage: x.homepage, stars: x.stargazers_count, forks: x.forks_count,
  issues: x.open_issues_count, lang: x.language, topics: x.topics || [], license: x.license?.spdx_id,
  archived: x.archived, fork: x.fork, created: x.created_at, pushed: x.pushed_at, starred: starred_at, branch: x.default_branch,
});

/** Repository search, most-starred first. `page` goes deeper into the results (GitHub serves up to 1000). */
export async function ghSearch(q, perPage = 50, page = 1) {
  if (perPage * page > 1000) return [];
  const r = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`);
  return r.ok ? (await r.json()).items || [] : [];
}

/**
 * Metadata for many "owner/name" at once, as REST-like objects keyed by lower-cased full name.
 * With a token: GraphQL, 40 repos per call, 4 calls in parallel. Without: a few REST calls (rate limit is 60/h).
 */
export async function repoMeta(fulls) {
  const out = new Map();
  if (!S.token) {
    for (const f of fulls.slice(0, 12)) {
      try { const r = await gh('/repos/' + f); if (r.ok) out.set(f.toLowerCase(), await r.json()); } catch { break; }
    }
    return out;
  }
  const fields = 'databaseId nameWithOwner description stargazerCount forkCount createdAt pushedAt isArchived isFork url homepageUrl owner{login avatarUrl} licenseInfo{spdxId} primaryLanguage{name} repositoryTopics(first:12){nodes{topic{name}}}';
  await pool(chunks(fulls, 40), 4, async batch => {
    let data;
    try { data = await gql('query{' + batch.map((f, j) => { const [o, n] = f.split('/'); return repoQ('r' + j, o, n, fields); }).join(' ') + '}'); }
    catch { return; }   // best effort: suggestions just have fewer candidates
    batch.forEach((f, j) => {
      const d = data['r' + j]; if (!d) return;
      out.set(f.toLowerCase(), {id: d.databaseId, full_name: d.nameWithOwner, description: d.description, stargazers_count: d.stargazerCount,
        forks_count: d.forkCount, created_at: d.createdAt, pushed_at: d.pushedAt, archived: d.isArchived, fork: d.isFork,
        html_url: d.url, homepage: d.homepageUrl, owner: {login: d.owner.login, avatar_url: d.owner.avatarUrl},
        license: d.licenseInfo ? {spdx_id: d.licenseInfo.spdxId} : null, language: d.primaryLanguage?.name,
        topics: d.repositoryTopics.nodes.map(x => x.topic.name)});
    });
  });
  return out;
}

/** GraphQL fields for a repo's full language breakdown (every language, largest first). */
export const LANG_FIELDS = 'languages(first:100,orderBy:{field:SIZE,direction:DESC}){totalSize edges{size node{name color}}}';

/** GraphQL languages → [[name, percent, color], …], like GitHub's "Languages" sidebar. */
export function languageShares(l) {
  if (!l?.totalSize) return [];
  return l.edges.map(e => [e.node.name, Math.round(e.size / l.totalSize * 1000) / 10, e.node.color || null]);
}

/* Commit activity: commits on the default branch per 2-week bucket over the last 12 months (26 buckets, oldest
   first), counted by GraphQL `history(since, until)`. Unlike REST /stats/commit_activity it never answers
   "202, still computing", and it batches with the other details. Stored as {end, counts}: `end` = when it was
   counted, so a cached graph can be shifted forward later (see activityNow). */
export const ACTIVITY_BUCKETS = 26, ACTIVITY_SPAN = 14 * 864e5;
export function activityFields(end = Date.now()) {
  const iso = t => new Date(t).toISOString();
  return 'defaultBranchRef{target{...on Commit{' + Array.from({length: ACTIVITY_BUCKETS}, (_, k) =>
    `a${k}:history(since:"${iso(end - (ACTIVITY_BUCKETS - k) * ACTIVITY_SPAN)}",until:"${iso(end - (ACTIVITY_BUCKETS - k - 1) * ACTIVITY_SPAN)}"){totalCount}`).join(' ') + '}}}';
}
export function parseActivity(repoData, end) {
  const t = repoData?.defaultBranchRef?.target;
  return t ? {end, counts: Array.from({length: ACTIVITY_BUCKETS}, (_, k) => t['a' + k]?.totalCount ?? 0)} : null;
}
/** The 26 buckets ending now. Buckets after `end` are 0: the repo wasn't pushed since (otherwise it's re-counted). */
export function activityNow(a) {
  if (!a?.counts) return null;
  const shift = Math.min(ACTIVITY_BUCKETS, Math.max(0, Math.floor((Date.now() - a.end) / ACTIVITY_SPAN)));
  return [...a.counts.slice(shift), ...Array(shift).fill(0)];
}

/* Star activity. GitHub no longer lists who starred a repo or when (REST /stargazers answers 404, GraphQL
   `stargazers` returns no edges), so star growth is recorded here instead: every check already downloads each repo's
   current star count, and one sample per day is kept in `r.starHist` = [[dayTimestamp, count], …] (≤ 400 days).
   The chart shows real gains between samples; it starts empty and fills in as the app is used. */
const DAY_MS = 864e5, MAX_SAMPLES = 400;
export function recordStars(hist, count, now = Date.now()) {
  const day = Math.floor(now / DAY_MS) * DAY_MS, h = hist ? [...hist] : [];
  if (h.length && h.at(-1)[0] === day) h[h.length - 1] = [day, count]; else h.push([day, count]);
  return h.length > MAX_SAMPLES ? h.slice(-MAX_SAMPLES) : h;
}
/** Stars gained per 2-week bucket over the last 12 months from the samples. Buckets before the first sample are
 *  null ("not tracked yet"). Returns null until there are 2 samples on different days. */
export function starGains(hist, now = Date.now()) {
  if (!hist || hist.length < 2) return null;
  const start = now - ACTIVITY_BUCKETS * ACTIVITY_SPAN, counts = Array(ACTIVITY_BUCKETS).fill(null);
  const first = hist[0][0];
  for (let i = 0; i < ACTIVITY_BUCKETS; i++) if (start + (i + 1) * ACTIVITY_SPAN > first) counts[i] = 0;
  for (let i = 1; i < hist.length; i++) {   // spread each gain over its days, then add to buckets
    const [t0, c0] = hist[i - 1], [t1, c1] = hist[i], days = Math.max(1, Math.round((t1 - t0) / DAY_MS)), per = (c1 - c0) / days;
    for (let d = 0; d < days; d++) {
      const t = t0 + (d + 1) * DAY_MS, k = Math.floor((t - start) / ACTIVITY_SPAN);
      if (k >= 0 && k < ACTIVITY_BUCKETS) counts[k] = (counts[k] ?? 0) + per;
    }
  }
  return counts.map(v => v == null ? null : Math.round(v));
}

/** Full card details for visible suggestions. Details are saved with the discovery result. */
export async function repoCardDetails(fulls) {
  const out = new Map();
  if (!S.token) return out;
  const end = Date.now(), fields = LANG_FIELDS + ' ' + activityFields(end) +
    ' lastCommit:defaultBranchRef{target{...on Commit{committedDate}}} latestRelease{tagName publishedAt}' +
    ' forkCount createdAt pushedAt homepageUrl licenseInfo{spdxId} owner{login avatarUrl} issues(states:OPEN){totalCount}';
  await pool(chunks(fulls, 10), 6, async batch => {
    let data;
    try { data = await gql('query{' + batch.map((f, j) => { const [o, n] = f.split('/'); return repoQ('r' + j, o, n, fields); }).join(' ') + '}'); }
    catch { return; }
    batch.forEach((f, j) => {
      const d = data['r' + j];
      if (!d) return;
      out.set(f.toLowerCase(), {langs: languageShares(d.languages), activity: parseActivity(d, end),
        commitAt: d.lastCommit?.target?.committedDate || null, release: d.latestRelease?.tagName || null,
        releaseAt: d.latestRelease?.publishedAt || null, forks_count: d.forkCount, created_at: d.createdAt,
        pushed_at: d.pushedAt, homepage: d.homepageUrl, license: d.licenseInfo?.spdxId || null,
        open_issues_count: d.issues?.totalCount, owner: d.owner ? {login: d.owner.login, avatar_url: d.owner.avatarUrl} : null});
    });
  });
  return out;
}

/** Cheap sort data for every candidate when exact commit/release order is requested. */
export async function repoSortDetails(fulls) {
  const out = new Map();
  if (!S.token) return out;
  const fields = 'lastCommit:defaultBranchRef{target{...on Commit{committedDate}}} latestRelease{tagName publishedAt}';
  await pool(chunks(fulls, 40), 6, async batch => {
    let data;
    try { data = await gql('query{' + batch.map((f, j) => { const [o, n] = f.split('/'); return repoQ('r' + j, o, n, fields); }).join(' ') + '}'); }
    catch { return; }
    batch.forEach((f, j) => { const d = data['r' + j]; if (d) out.set(f.toLowerCase(), {
      commitAt: d.lastCommit?.target?.committedDate || null,
      release: d.latestRelease?.tagName || null, releaseAt: d.latestRelease?.publishedAt || null,
    }); });
  });
  return out;
}

/** Git's blob hash, sha1("blob <bytes>\0" + content): verifies a cached README against GitHub without downloading it. */
export async function gitSha(text) {
  if (!globalThis.crypto?.subtle) return null;
  const body = new TextEncoder().encode(text), head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map(x => x.toString(16).padStart(2, '0')).join('');
}

let me = null;
/** Login of the token's owner (cached for the session). */
export async function whoAmI() {
  if (!me) me = (await (await gh('/user')).json()).login;
  return me;
}
export const forgetMe = () => { me = null; };

/** Stars (on=true) or unstars a repo for the token's owner. Returns the HTTP status (204 = done). */
export async function setStar(full, on) {
  const r = await ghFetch('/user/starred/' + full, {method: on ? 'PUT' : 'DELETE', headers: headers()});
  return r.status;
}
