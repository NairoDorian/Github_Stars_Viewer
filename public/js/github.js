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
  const fields = 'databaseId nameWithOwner description stargazerCount pushedAt isArchived isFork url primaryLanguage{name} repositoryTopics(first:8){nodes{topic{name}}}';
  await pool(chunks(fulls, 40), 4, async batch => {
    let data;
    try { data = await gql('query{' + batch.map((f, j) => { const [o, n] = f.split('/'); return repoQ('r' + j, o, n, fields); }).join(' ') + '}'); }
    catch { return; }   // best effort: suggestions just have fewer candidates
    batch.forEach((f, j) => {
      const d = data['r' + j]; if (!d) return;
      out.set(f.toLowerCase(), {id: d.databaseId, full_name: d.nameWithOwner, description: d.description, stargazers_count: d.stargazerCount,
        pushed_at: d.pushedAt, archived: d.isArchived, fork: d.isFork, html_url: d.url, language: d.primaryLanguage?.name,
        topics: d.repositoryTopics.nodes.map(x => x.topic.name)});
    });
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
