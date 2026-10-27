// The collapsible 🔑 token panel: save/remove the token, show rate limits and whether it can star.
import {S} from './state.js';
import {$} from './util.js';
import {ghFetch, headers, forgetMe} from './github.js';
import {saveConfig} from './store.js';

const PANEL_STATE = 'tokenPanelOpen';   // localStorage: remembered open/closed state (a UI preference only)

/** Can a classic token with these scopes (GitHub's X-OAuth-Scopes header, "repo, read:org") star repos? Only "repo" and
 *  "public_repo" can; sub-scopes such as "repo:status" or "repo:invite" can't. */
export const canStar = scopes => String(scopes ?? '').split(',').some(s => ['repo', 'public_repo'].includes(s.trim()));

/** Checks the token against GitHub: validity, rate limits, and (classic tokens) whether it may star. */
async function checkToken() {
  const summary = $('#tpSummary'), limit = $('#limit');
  const token = S.token;
  try {
    const r = await ghFetch('/rate_limit', {headers: headers(), signal: null});
    if (token !== S.token) return;   // a slower check for the previous token must not overwrite the new status
    if (r.status === 401) {
      summary.textContent = '· ⚠ token rejected';
      limit.textContent = '⚠ Token rejected: check it was copied fully and hasn\'t expired.';
      return;
    }
    if (!r.ok) throw new Error(`GitHub answered ${r.status} while checking the token; try again in a moment.`);
    const {resources: {core, graphql}} = await r.json();
    if (token !== S.token) return;
    const scopes = r.headers.get('X-OAuth-Scopes');   // classic tokens only; null for fine-grained tokens
    const star = !S.token ? '' : scopes == null ? ' · fine-grained' : canStar(scopes) ? ' · ★ can star' : ' · read-only (add "public_repo" to star)';
    summary.textContent = S.token ? '· ✅ set' + star : '· not set (60 requests/hour)';
    limit.textContent = `${S.token ? '✅ Token OK' + star : 'No token'} · REST: ${core.remaining}/${core.limit} left ` +
      `(resets ${new Date(core.reset * 1000).toLocaleTimeString()})` + (graphql ? ` · GraphQL: ${graphql.remaining}/${graphql.limit}` : '');
  } catch (e) { if (token === S.token) limit.textContent = '⚠ ' + e.message; }
}

/** Opens or closes the panel. `remember` saves the choice; panels opened automatically aren't remembered. */
function openTokenPanel(open, remember = false) {
  const p = $('#tokenPanel');
  p.classList.toggle('show', open);
  $('#tpToggle').setAttribute('aria-expanded', String(open));
  if (remember) try { localStorage.setItem(PANEL_STATE, open ? '1' : '0'); } catch {}
  if (open) { checkToken(); p.scrollIntoView({block: 'nearest', behavior: 'smooth'}); }
}

/** A token as pasted: line breaks and spaces picked up while copying are dropped. GitHub tokens are plain ASCII; anything
 *  else (the "…" of a placeholder, an invisible character) can't even be sent in a request header, which would show up
 *  as a confusing network error on every request. Returns {token} or {token: '', error}. */
export function cleanToken(value) {
  const token = String(value ?? '').replace(/\s+/g, '');
  return /^[\x21-\x7e]*$/.test(token) ? {token}
    : {token: '', error: '⚠ This token has characters a GitHub token never has (copied with “…” or an invisible character?). Paste it again.'};
}

/** Sets (or, with '', removes) the token everywhere: state, input, button, saved config (unless `save` is false, as when
 *  everything was just erased), rate-limit summary. An unusable token is refused and the current one kept. */
export function setToken(value, {save = true} = {}) {
  const {token, error} = cleanToken(value);
  if (error) {
    $('#tpSummary').textContent = '· ⚠ invalid token';
    $('#limit').textContent = error;
    return;
  }
  S.token = token;
  $('#token').value = S.token;
  $('#tokenBtn').textContent = S.token ? '🔑 Token' : '🔑 Add token';
  forgetMe();
  if (save) saveConfig();
  checkToken();
}

export function initToken(token) {
  token = cleanToken(token).token;   // a token stored by an older version is checked the same way
  S.token = token;
  $('#token').value = token;
  $('#tokenBtn').textContent = token ? '🔑 Token' : '🔑 Add token';
  const toggle = () => openTokenPanel(!$('#tokenPanel').classList.contains('show'), true);
  $('#tpToggle').onclick = toggle;
  $('#tpToggle').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  $('#tokenBtn').onclick = toggle;
  $('#saveToken').onclick = () => setToken($('#token').value);
  $('#token').onkeydown = e => { if (e.key === 'Enter') setToken($('#token').value); };
  $('#clearToken').onclick = () => setToken('');
  window.addEventListener('need-token', () => openTokenPanel(true));   // fired by github.js on 401 / rate limit

  // Open at start if there's no token yet, otherwise as the user left it.
  let saved = null;
  try { saved = localStorage.getItem(PANEL_STATE); } catch {}
  const open = !token || saved === '1';
  $('#tokenPanel').classList.toggle('show', open);
  $('#tpToggle').setAttribute('aria-expanded', String(open));
  checkToken();   // fills the one-line summary shown in the collapsed bar
}
