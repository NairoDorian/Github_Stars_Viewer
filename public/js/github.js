// GitHub API access: REST + GraphQL, with retries, rate-limit handling and data mapping.
import {S, genSignal} from './state.js';
import {DAY, sleep, pool, chunks} from './util.js';
import {debug, info, warn, error, names} from './log.js';

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
export async function ghFetch(url, init = {}, tries = 3, what = '') {
  const sig = init.signal === undefined ? genSignal() : init.signal;
  const label = `${init.method || 'GET'} ${String(url).replace(API, '')}${what ? ' (' + what + ')' : ''}`;   // never the headers: they carry the token
  for (let i = 0; ; i++) {
    let r;
    const t0 = Date.now();
    try { r = await fetch(url.startsWith('http') ? url : API + url, sig ? {...init, signal: sig} : init); }
    catch (e) {
      if (sig?.aborted) { debug('http', `${label} cancelled (another profile was loaded, or Cancel)`); throw e; }
      if (i >= tries - 1) { error('http', `${label} failed after ${tries} tries: ${e.message || 'network error'}`); throw new Error('Network error (offline, or GitHub timed out or cut the answer)'); }
      warn('http', `${label}: network error (${e.message || 'no answer'}), try ${i + 2} of ${tries} in ${500 * 2 ** i} ms`);
      await sleep(500 * 2 ** i, sig);
      if (sig?.aborted) throw new DOMException('Aborted', 'AbortError');
      continue;
    }
    const retryAfter = Number(r.headers.get('retry-after')) || 0;
    const transient = r.status >= 500 || ((r.status === 403 || r.status === 429) && retryAfter > 0 && retryAfter <= 60);
    (r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 429 ? warn : debug)('http',
      `${label} → ${r.status}${r.status === 304 ? ' not modified (free)' : ''} in ${Date.now() - t0} ms${i ? ', try ' + (i + 1) : ''}${rateNote(r)}${retryAfter ? ', retry-after ' + retryAfter + ' s' : ''}`);
    if (transient && i < tries - 1) {
      warn('http', `${label}: GitHub answered ${r.status}; waiting ${retryAfter ? retryAfter + ' s' : 500 * 2 ** i + ' ms'}, then trying again (try ${i + 2} of ${tries})`);
      await sleep(retryAfter ? retryAfter * 1000 : 500 * 2 ** i, sig);
      if (sig?.aborted) throw new DOMException('Aborted', 'AbortError');
      continue;
    }
    return r;
  }
}

/** " · core budget 4,870/5,000 left" from GitHub's rate-limit headers (one budget per kind: core, graphql, search). */
const rateNote = r => {
  const left = r.headers?.get?.('x-ratelimit-remaining');
  if (left == null) return '';
  const limit = r.headers.get('x-ratelimit-limit'), kind = r.headers.get('x-ratelimit-resource') || 'api';
  return ` · ${kind} budget ${Number(left).toLocaleString()}${limit ? '/' + Number(limit).toLocaleString() : ''} left`;
};

/** " (resets 14:05)" from a rate-limited response, when GitHub says when. */
const resetNote = r => { const t = r.headers.get('x-ratelimit-reset'); return t ? ` (resets ${new Date(t * 1000).toLocaleTimeString()})` : ''; };

/** REST GET. Throws on auth / rate-limit / unexpected errors; returns the response for 2xx, 304 and 404. */
export async function gh(path, extraHeaders) {
  const r = await ghFetch(path, {headers: headers(extraHeaders)});
  if (r.status === 401) { needToken(); throw Object.assign(new Error('Token rejected by GitHub. Update it in the 🔑 panel.'), {fatal: true}); }
  if (r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')) {
    if (!S.token) needToken();
    throw Object.assign(new Error('Rate limited' + (S.token ? '' : ', add a token') + resetNote(r)), {fatal: true});
  }
  if (!r.ok && r.status !== 404 && r.status !== 304) throw new Error('GitHub ' + r.status);
  return r;
}

/** GraphQL query → data. Partial results (some repos missing/private) come back as null entries, not errors.
 *  Errors that make every further request pointless carry `fatal` (bad token, used-up budget); GitHub's "slow down"
 *  carries `secondary`: callers may wait and retry (see isFatalError). */
export async function gql(query, what = '') {
  const r = await ghFetch('/graphql', {method: 'POST', headers: headers(), body: JSON.stringify({query})}, 3, what);
  if (r.status === 401) { error('graphql', 'GitHub rejected the token (401)'); needToken(); throw Object.assign(new Error('Token rejected by GitHub. Update it in the 🔑 panel.'), {fatal: true}); }
  if (r.status === 403 || r.status === 429) {
    if (r.headers.get('x-ratelimit-remaining') === '0') throw Object.assign(new Error('GraphQL rate limit reached' + resetNote(r)), {fatal: true});   // used up: ends the run
    // Still has budget: GitHub's secondary limit ("slow down", too many requests at once). Callers may wait and retry.
    warn('graphql', 'GitHub asked to slow down (secondary rate limit)');
    throw Object.assign(new Error('GitHub asked to slow down (secondary limit)'), {secondary: true});
  }
  if (!r.ok) throw new Error('GraphQL ' + r.status);
  const body = await r.json();
  if (body.data && body.errors?.length) debug('graphql', `answered with data and ${body.errors.length} error(s), e.g. ${body.errors[0].type || ''} ${body.errors[0].message}`);
  if (!body.data) {   // GitHub can also report limits inside a 200 answer
    const first = body.errors?.[0], msg = first?.message || 'no data';
    if (/secondary rate limit|abuse/i.test(msg)) throw Object.assign(new Error('GitHub asked to slow down (secondary limit)'), {secondary: true});
    if (first?.type === 'RATE_LIMITED') throw Object.assign(new Error('GraphQL rate limit reached' + resetNote(r)), {fatal: true});
    throw new Error('GraphQL: ' + msg);
  }
  return body.data;
}

/** One aliased `repository(...)` block for batched GraphQL queries. */
export const repoQ = (alias, owner, name, fields) =>
  `${alias}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${fields}}`;

/**
 * One GraphQL call about many repositories. Repository j of `items` comes back as `data['r' + j]` (null when GitHub
 * omits it: private, deleted, timed out). `fields` is a selection string, or a function (item, j) → selection;
 * `nameOf(item)` → [owner, name] (default: items are {owner, name} objects).
 */
export async function gqlRepos(items, fields, nameOf = r => [r.owner, r.name], what = '') {
  const data = await gql('query{' + items.map((it, j) => repoQ('r' + j, ...nameOf(it), typeof fields === 'function' ? fields(it, j) : fields)).join(' ') + '}', what || `${items.length} repositories`);
  const empty = items.map((it, j) => data['r' + j] == null ? nameOf(it).join('/') : null).filter(Boolean);
  if (empty.length) debug('graphql', `${empty.length} of ${items.length} repositories came back empty (private, deleted, or GitHub timed out): ${names(empty)}`);
  return data;
}

/** "owner/name" → [owner, name], for gqlRepos over lists of full names. */
export const splitFull = full => full.split('/');

/** An error that makes every further request pointless (bad token, used-up rate limit): jobs stop instead of retrying.
 *  Errors flagged by gh() / gql() are exact; an unflagged one is judged by its message, except "slow down" answers, which
 *  are worth waiting out. */
export const isFatalError = e => e?.fatal === true || (!e?.secondary && /token|rate limit/i.test(e?.message || ''));

/** REST "starred" item (star+json media type) → the compact repo shape stored in the cache. */
export const mapStar = ({starred_at, repo: x}) => ({
  id: x.id, full: x.full_name, name: x.name, owner: x.owner.login, avatar: x.owner.avatar_url, url: x.html_url,
  about: x.description || '', homepage: x.homepage, stars: x.stargazers_count, forks: x.forks_count,
  issues: x.open_issues_count, lang: x.language, topics: x.topics || [], license: x.license?.spdx_id,
  archived: x.archived, fork: x.fork, created: x.created_at, pushed: x.pushed_at, starred: starred_at, branch: x.default_branch,
  ownerType: x.owner.type,   // "User" | "Organization" | "Bot": organizations can't star anything (see users.js)
});

/** Repository search, most-starred first. `page` goes deeper into the results (GitHub serves the first 1000). */
export async function ghSearch(q, perPage = 50, page = 1) {
  if (perPage * (page - 1) >= 1000) return [];   // the page starts beyond result 1000 (a page that ends past it still has some)
  const r = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`);
  const items = r.ok ? (await r.json()).items || [] : [];
  info('search', `"${q}" page ${page}: ${items.length} repositories`);
  return items;
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
    try { data = await gqlRepos(batch, fields, splitFull); }
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

/**
 * How many repos each user has starred, and their followers, 50 users per GraphQL call (3 calls in parallel).
 * `onBatch(Map<lower-cased login, {type, name, stars, followers} | null>)` gets every answered batch as it arrives (null:
 * GitHub knows no such user any more), so callers can show and save progress. `halted()` ends the run between batches.
 * Token and rate-limit errors (isFatalError) are thrown after the batches already delivered; any other failed batch is
 * skipped and counted. Returns {failed}.
 */
export async function ownerStats(logins, onBatch, halted = () => false) {
  let failed = 0;
  await pool(chunks(logins, 50), 3, async batch => {
    if (halted()) return;
    let data;
    try {
      data = await gql('query{' + batch.map((login, j) => `u${j}:repositoryOwner(login:${JSON.stringify(login)}){__typename login ` +
        '...on User{name starredRepositories{totalCount} followers{totalCount}} ...on Organization{name}}').join(' ') + '}');
    } catch (e) {
      if (isFatalError(e)) throw e;
      failed += batch.length;   // timeout, "slow down"...: the user can run it again
      return;
    }
    const out = new Map();
    batch.forEach((login, j) => {
      const d = data['u' + j];
      out.set(login.toLowerCase(), !d ? null : {type: d.__typename, name: d.name || '', stars: d.starredRepositories?.totalCount ?? null, followers: d.followers?.totalCount ?? null});
    });
    onBatch(out);
  });
  return {failed};
}

/** Every repo a user starred, as [{id, full}], with the list's pages fetched in parallel (public data, no token needed). */
export async function starredOf(login) {
  const path = p => `/users/${encodeURIComponent(login)}/starred?per_page=100&page=${p}`;
  const first = await gh(path(1));
  if (!first.ok) throw new Error(first.status === 404 ? `User "${login}" not found` : 'GitHub ' + first.status);
  const last = Number(first.headers.get('Link')?.match(/[?&]page=(\d+)>; rel="last"/)?.[1] || 1), pages = [await first.json()];
  await pool(Array.from({length: last - 1}, (_, i) => i + 2), 6, async p => { pages[p - 1] = await (await gh(path(p))).json(); });
  return pages.flat().map(x => ({id: x.id, full: x.full_name}));
}

/** One user's starred-repo count with a single REST request: the page number of the "last" link when each page holds one
 *  repo. No link means 0 or 1. `remaining`: requests left this hour (60/h without a token). */
export async function starredCount(login) {
  const r = await gh(`/users/${encodeURIComponent(login)}/starred?per_page=1`);
  const left = r.headers.get('x-ratelimit-remaining'), remaining = left == null ? null : Number(left);
  if (r.status === 404) return {missing: true, remaining};
  const last = Number(r.headers.get('Link')?.match(/[?&]page=(\d+)>; rel="last"/)?.[1] || 0);
  return {stars: last || (r.ok ? (await r.json()).length : 0), remaining};
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

/* Star activity fallback when the external whole-life chart is unavailable: every check already downloads each repo's
   current star count, and one sample per day is kept in `r.starHist` = [[dayTimestamp, count], …] (≤ 400 days).
   The fallback shows gains between local samples; it fills in as the app is used. */
const MAX_SAMPLES = 400;
export function recordStars(hist, count, now = Date.now()) {
  const day = Math.floor(now / DAY) * DAY, h = hist ? [...hist] : [];
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
    const [t0, c0] = hist[i - 1], [t1, c1] = hist[i], days = Math.max(1, Math.round((t1 - t0) / DAY)), per = (c1 - c0) / days;
    for (let d = 0; d < days; d++) {
      const t = t0 + (d + 0.5) * DAY, k = Math.floor((t - start) / ACTIVITY_SPAN);
      if (k >= 0 && k < ACTIVITY_BUCKETS) counts[k] = (counts[k] ?? 0) + per;
    }
  }
  return counts.map(v => v == null ? null : Math.round(v));
}

/* "Last commit" and "last release" shown on every tile.
   Commit: the committer date of the default branch's head. Release: the NEWEST release by publish date, pre-releases
   included, drafts skipped (GitHub's `latestRelease` is only its "Latest" badge: it can be an older version, e.g. a
   backport line, and ignores pre-release-only repos). The 5 most recently created releases are compared by publish date.
   `release` is null when the repo has none and undefined while not fetched yet. */
export const LAST_FIELDS = 'lastCommit:defaultBranchRef{target{...on Commit{committedDate}}} ' +
  'releases(first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{tagName publishedAt createdAt isPrerelease isDraft}} latestRelease{tagName}';
export function parseLast(d) {
  let best = null, bestT = -Infinity;
  for (const n of d?.releases?.nodes || []) {
    const t = Date.parse(n.publishedAt || n.createdAt);
    if (!n.isDraft && t > bestT) { bestT = t; best = n; }
  }
  const latest = d?.latestRelease?.tagName || null;
  return {commitAt: d?.lastCommit?.target?.committedDate || null,
    release: best ? best.tagName : null, releaseAt: best ? best.publishedAt || best.createdAt : null, releasePre: !!best?.isPrerelease,
    releaseLatest: best && latest && latest !== best.tagName ? latest : null};   // GitHub's "Latest" when it differs
}

/** Full card details for visible suggestions. Details are saved with the discovery result. Open issues and open pull
 *  requests are added up: that is what REST's open_issues_count (shown on starred cards) means. */
export async function repoCardDetails(fulls) {
  const out = new Map();
  if (!S.token) return out;
  const end = Date.now(), fields = LANG_FIELDS + ' ' + activityFields(end) + ' ' + LAST_FIELDS +
    ' forkCount createdAt pushedAt homepageUrl licenseInfo{spdxId} owner{login avatarUrl} issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}';
  await pool(chunks(fulls, 10), 6, async batch => {
    let data;
    try { data = await gqlRepos(batch, fields, splitFull); }
    catch { return; }
    batch.forEach((f, j) => {
      const d = data['r' + j];
      if (!d) return;
      out.set(f.toLowerCase(), {langs: languageShares(d.languages), activity: parseActivity(d, end), ...parseLast(d),
        forks_count: d.forkCount, created_at: d.createdAt,
        pushed_at: d.pushedAt, homepage: d.homepageUrl, license: d.licenseInfo?.spdxId || null,
        open_issues_count: d.issues && d.pullRequests ? d.issues.totalCount + d.pullRequests.totalCount : d.issues?.totalCount, owner: d.owner ? {login: d.owner.login, avatar_url: d.owner.avatarUrl} : null});
    });
  });
  return out;
}

/** Cheap sort data for every candidate when exact commit/release order is requested. */
export async function repoSortDetails(fulls) {
  const out = new Map();
  if (!S.token) return out;
  const fields = LAST_FIELDS;
  await pool(chunks(fulls, 40), 6, async batch => {
    let data;
    try { data = await gqlRepos(batch, fields, splitFull); }
    catch { return; }
    batch.forEach((f, j) => { const d = data['r' + j]; if (d) out.set(f.toLowerCase(), parseLast(d)); });
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

let me = null, meToken = null;
/** Login of the token's owner. Bind the memoized value to the token, including across in-flight requests. */
export async function whoAmI() {
  const token = S.token;
  if (me && meToken === token) return me;
  const login = (await (await gh('/user')).json()).login;
  if (S.token !== token) throw new Error('Token changed while checking its owner; try again.');
  me = login;
  meToken = token;
  return me;
}
export const forgetMe = () => { me = null; meToken = null; };

/** Stars (on=true) or unstars a repo for the token's owner. Returns the HTTP status (204 = done). */
export async function setStar(full, on) {
  const r = await ghFetch('/user/starred/' + full, {method: on ? 'PUT' : 'DELETE', headers: headers(), signal: null});
  return r.status;
}
