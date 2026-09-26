// The collapsible 🔑 token panel: save/remove the token, show rate limits and whether it can star.
import {S} from './state.js';
import {$} from './util.js';
import {ghFetch, headers, forgetMe} from './github.js';
import {saveConfig} from './store.js';

const PANEL_STATE = 'tokenPanelOpen';   // localStorage: remembered open/closed state (a UI preference only)

/** Checks the token against GitHub: validity, rate limits, and (classic tokens) whether it may star. */
async function checkToken() {
  const summary = $('#tpSummary'), limit = $('#limit');
  try {
    const r = await ghFetch('/rate_limit', {headers: headers()});
    if (r.status === 401) {
      summary.textContent = '· ⚠ token rejected';
      limit.textContent = '⚠ Token rejected: check it was copied fully and hasn\'t expired.';
      return;
    }
    const {resources: {core, graphql}} = await r.json();
    const scopes = r.headers.get('X-OAuth-Scopes');   // classic tokens only; null for fine-grained tokens
    const star = scopes == null ? '' : /\b(public_)?repo\b/.test(scopes) ? ' · ★ can star' : ' · read-only (add "public_repo" to star)';
    summary.textContent = S.token ? '· ✅ set' + star : '· not set (60 requests/hour)';
    limit.textContent = `${S.token ? '✅ Token OK' + star : 'No token'} · REST: ${core.remaining}/${core.limit} left ` +
      `(resets ${new Date(core.reset * 1000).toLocaleTimeString()})` + (graphql ? ` · GraphQL: ${graphql.remaining}/${graphql.limit}` : '');
  } catch (e) { limit.textContent = '⚠ ' + e.message; }
}

/** Opens or closes the panel. `remember` saves the choice; panels opened automatically aren't remembered. */
export function openTokenPanel(open, remember = false) {
  const p = $('#tokenPanel');
  p.classList.toggle('show', open);
  $('#tpToggle').setAttribute('aria-expanded', String(open));
  if (remember) try { localStorage.setItem(PANEL_STATE, open ? '1' : '0'); } catch {}
  if (open) { checkToken(); p.scrollIntoView({block: 'nearest', behavior: 'smooth'}); }
}

function setToken(value) {
  S.token = value.trim();
  $('#token').value = S.token;
  $('#tokenBtn').textContent = S.token ? '🔑 Token' : '🔑 Add token';
  forgetMe();
  saveConfig();
  checkToken();
}

export function initToken(token) {
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
